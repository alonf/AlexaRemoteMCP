import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import './support/no-network.js';
import { APPROVAL_TTL_MS } from '../src/approval.js';
import { createHttpServer } from '../src/http-server.js';
import { SqliteJournal } from '../src/sqlite-journal.js';
import { FakeAlexa } from './support/fake-alexa.js';

const T0 = new Date('2026-01-01T10:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const ctx = (principal: string) => ({ principal, client: 'chatgpt' });

test('pending approvals show kind and timings for the caller only', () => {
  const journal = new SqliteJournal(':memory:');
  journal.requestApproval('n-1', ctx('owner'), 'device-power', 'dev-1', T0);
  journal.requestApproval('n-2', ctx('owner'), 'device-position', 'dev-2', at(-200));
  journal.requestApproval('n-3', ctx('owner'), 'speech', 'speech:x', T0);
  journal.decideApproval('n-3', 'granted', at(5));
  journal.requestApproval('n-4', ctx('other'), 'device-power', 'dev-3', T0);

  assert.deepEqual(journal.pendingApprovals('owner', at(60), APPROVAL_TTL_MS), [
    { operation: 'device-power', requestedSecondsAgo: 60, expiresInSeconds: 60 },
  ]);
});

test('get_status needs the read scope and returns nothing to approve with', async () => {
  const journal = new SqliteJournal(':memory:');
  journal.requestApproval('secret-nonce', ctx('owner'), 'device-power', 'private-device-id', new Date());
  const server = createHttpServer({
    adapter: new FakeAlexa({ devices: { smarthomeDevices: [] } }),
    sessionHealth: () => 'usable',
    authenticate: async (request) => {
      const token = request.headers.authorization?.replace('Bearer ', '');
      return token ? { token, clientId: 'c', scopes: token === 'noread' ? [] : ['read'], extra: { principal: 'owner' } } : undefined;
    },
    allowedOrigins: [],
    resourceMetadataUrl: 'https://mcp.example/.well-known/oauth-protected-resource',
    pendingApprovals: (principal, now) => journal.pendingApprovals(principal, now, APPROVAL_TTL_MS),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const call = async (token: string) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_status', arguments: {} } }),
    });
    return await response.json() as { result?: { isError?: boolean; content: Array<{ text: string }> } };
  };
  try {
    const ok = await call('owner');
    const body = JSON.parse(ok.result?.content[0]?.text ?? '{}') as { session: string; pendingApprovals: Array<{ operation: string }> };
    assert.equal(body.session, 'usable');
    assert.deepEqual(body.pendingApprovals.map((p) => p.operation), ['device-power']);
    assert.doesNotMatch(JSON.stringify(body), /secret-nonce|private-device-id/);
    assert.equal((await call('noread')).result?.isError, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

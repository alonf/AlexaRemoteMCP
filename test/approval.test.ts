import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import './support/no-network.js';
import { parseActionPolicy } from '../src/action-policy.js';
import { ApprovalSigner } from '../src/approval.js';
import { createHttpServer } from '../src/http-server.js';
import { MutationService } from '../src/mutation-service.js';
import { SqliteJournal } from '../src/sqlite-journal.js';
import { FakeAlexa } from './support/fake-alexa.js';

const cap = (interfaceName: string, extra: Record<string, unknown> = {}) => ({ interfaceName, ...extra });
const devices = {
  smarthomeDevices: [
    { applianceId: 'light-1', friendlyName: 'Hall light', applianceTypes: ['LIGHT'], capabilities: [cap('Alexa.PowerController')] },
    {
      applianceId: 'blind-1', friendlyName: 'Terrace blind', applianceTypes: ['EXTERIOR_BLIND'],
      capabilities: [cap('Alexa.ModeController', { instance: 'Blind.Position', configuration: { supportedModes: [{ value: 'Position.Up' }, { value: 'Position.Down' }] } })],
    },
    { applianceId: 'heater-1', friendlyName: 'Floor heating', applianceTypes: ['HEATER'], capabilities: [cap('Alexa.PowerController')] },
    { applianceId: 'lock-1', friendlyName: 'Front lock', applianceTypes: ['SMARTLOCK'], capabilities: [cap('Alexa.PowerController')] },
  ],
};

const MRTR = {
  _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
  },
};

async function start(policy = 'light=allow,cover=approve,heater=approve') {
  const adapter = new FakeAlexa({ devices });
  const journal = new SqliteJournal(':memory:');
  const clock = { at: new Date('2026-01-01T10:00:00Z') };
  const mutations = new MutationService(
    adapter, journal, { allowedTargets: new Set(['*']), modes: parseActionPolicy(policy) },
    () => clock.at, [], async () => undefined, undefined, new ApprovalSigner(Buffer.alloc(32, 7)),
  );
  const server = createHttpServer({
    adapter,
    sessionHealth: () => 'usable',
    authenticate: async (request) => {
      const token = request.headers.authorization?.replace('Bearer ', '');
      return token ? { token, clientId: 'c', scopes: ['read', 'mutate'], extra: { principal: token } } : undefined;
    },
    allowedOrigins: [],
    resourceMetadataUrl: 'https://mcp.example/.well-known/oauth-protected-resource',
    mutations,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  let id = 0;
  const call = async (args: Record<string, unknown>, extra: Record<string, unknown> = MRTR, token = 'owner') => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'set_device_state', arguments: args, ...extra } }),
    });
    const result = ((await response.json()) as { result: Record<string, unknown> }).result;
    const text = (result.content as Array<{ text: string }> | undefined)?.[0]?.text;
    return { result, body: text ? JSON.parse(text) as Record<string, unknown> : undefined };
  };
  return { adapter, journal, clock, call, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

const accept = (state: unknown, approve = true) => ({
  ...MRTR, requestState: state, inputResponses: { approval: { action: 'accept', content: { approve } } },
});
const asked = (result: Record<string, unknown>) => result as { resultType: string; requestState: string; inputRequests: { approval: { method: string; params: { message: string } } } };

test('an approve-mode call returns an MRTR input request first and dispatches nothing', async () => {
  const s = await start();
  try {
    const { result } = await s.call({ id: 'blind-1', action: 'open' });
    const r = asked(result);
    assert.equal(r.resultType, 'input_required');
    assert.equal(r.inputRequests.approval.method, 'elicitation/create');
    assert.match(r.inputRequests.approval.params.message, /open "Terrace blind"/);
    assert.equal(typeof r.requestState, 'string');
    assert.equal(s.adapter.writes.length, 0);
  } finally { await s.stop(); }
});

test('an accepted retry dispatches once with the device-derived parameters, and the state cannot be reused', async () => {
  const s = await start();
  try {
    const { requestState } = asked((await s.call({ id: 'blind-1', action: 'open' })).result);
    const done = await s.call({ id: 'blind-1', action: 'open' }, accept(requestState));
    assert.equal(done.body?.status, 'accepted');
    assert.equal(s.adapter.writes.length, 1);
    assert.deepEqual(s.adapter.writes[0]?.args, ['blind-1', { action: 'setModeValue', instance: 'Blind.Position', mode: 'Position.Up' }]);
    const replay = await s.call({ id: 'blind-1', action: 'open' }, accept(requestState));
    assert.deepEqual([replay.body?.status, replay.body?.reason], ['rejected', 'approval_invalid']);
    assert.equal(s.adapter.writes.length, 1);
  } finally { await s.stop(); }
});

test('a decline, a cancel and an unticked accept are refusals', async () => {
  const s = await start();
  try {
    for (const response of [
      { action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { approve: false } }, { action: 'accept' },
    ]) {
      const { requestState } = asked((await s.call({ id: 'heater-1', action: 'on' })).result);
      const out = await s.call({ id: 'heater-1', action: 'on' }, { ...MRTR, requestState, inputResponses: { approval: response } });
      assert.deepEqual([out.body?.status, out.body?.reason], ['rejected', 'owner_declined'], JSON.stringify(response));
    }
    assert.equal(s.adapter.writes.length, 0);
  } finally { await s.stop(); }
});

test('state for a different action, device, user, or past its expiry is rejected', async () => {
  const s = await start();
  try {
    const { requestState } = asked((await s.call({ id: 'blind-1', action: 'open' })).result);
    const otherAction = await s.call({ id: 'blind-1', action: 'close' }, accept(requestState));
    assert.equal(otherAction.body?.reason, 'approval_invalid');
    const otherDevice = await s.call({ id: 'heater-1', action: 'on' }, accept(requestState));
    assert.equal(otherDevice.body?.reason, 'approval_invalid');
    const otherUser = await s.call({ id: 'blind-1', action: 'open' }, accept(requestState), 'intruder');
    assert.equal(otherUser.body?.reason, 'approval_invalid');
    const tampered = await s.call({ id: 'blind-1', action: 'open' }, accept(`${requestState.slice(0, -2)}xx`));
    assert.equal(tampered.body?.reason, 'approval_invalid');
    const forged = await s.call({ id: 'blind-1', action: 'open' }, accept('garbage'));
    assert.equal(forged.body?.reason, 'approval_invalid');
    s.clock.at = new Date('2026-01-01T10:03:00Z');
    const late = await s.call({ id: 'blind-1', action: 'open' }, accept(requestState));
    assert.equal(late.body?.reason, 'approval_expired');
    assert.equal(s.adapter.writes.length, 0);
  } finally { await s.stop(); }
});

test('a model-supplied confirmation is not approval; the input request is issued again', async () => {
  const s = await start();
  try {
    const { result } = await s.call({ id: 'blind-1', action: 'open', confirmed: true });
    assert.equal(asked(result).resultType, 'input_required');
    const { requestState } = asked(result);
    const again = await s.call({ id: 'blind-1', action: 'open' }, { ...MRTR, requestState });
    assert.equal(asked(again.result).resultType, 'input_required');
    assert.notEqual(asked(again.result).requestState, requestState);
    assert.equal(s.adapter.writes.length, 0);
  } finally { await s.stop(); }
});

test('a client that cannot elicit gets a chat confirmation for approve mode and is unaffected for allow mode', async () => {
  const s = await start();
  try {
    for (const extra of [{}, { _meta: { ...MRTR._meta, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } }, {
      _meta: { ...MRTR._meta, 'io.modelcontextprotocol/clientCapabilities': {} },
    }]) {
      const refused = await s.call({ id: 'blind-1', action: 'open' }, extra);
      assert.deepEqual([refused.body?.status, typeof refused.body?.approvalId], ['confirmation_required', 'string']);
    }
    assert.equal(s.adapter.writes.length, 0);
    const light = await s.call({ id: 'light-1', action: 'on' }, {});
    assert.equal(light.body?.status, 'accepted');
    assert.equal(s.adapter.writes.length, 1);
  } finally { await s.stop(); }
});

test('denied categories are refused, and the journal records approval decisions without the state', async () => {
  const s = await start();
  try {
    const lock = await s.call({ id: 'lock-1', action: 'on' });
    assert.deepEqual([lock.body?.status, lock.body?.reason], ['rejected', 'safety_class']);
    const { requestState } = asked((await s.call({ id: 'heater-1', action: 'on' })).result);
    await s.call({ id: 'heater-1', action: 'on' }, accept(requestState));
    const rows = (s.journal as unknown as { db: { prepare: (sql: string) => { all: () => Array<Record<string, unknown>> } } })
      .db.prepare('SELECT decision, operation_id, target_id FROM approvals').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.decision, 'granted');
    assert.equal(typeof rows[0]?.operation_id, 'string');
    assert.ok(!JSON.stringify(rows).includes(requestState));
  } finally { await s.stop(); }
});

test('allow mode needs no approval at all', async () => {
  const s = await start('light=allow,cover=allow');
  try {
    const out = await s.call({ id: 'blind-1', action: 'close' }, {});
    assert.equal(out.body?.status, 'accepted');
    assert.deepEqual(s.adapter.writes[0]?.args, ['blind-1', { action: 'setModeValue', instance: 'Blind.Position', mode: 'Position.Down' }]);
  } finally { await s.stop(); }
});

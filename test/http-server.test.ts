import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import './support/no-network.js';
import { createHttpServer } from '../src/http-server.js';
import type { SessionHealth } from '../src/session-manager.js';
import { FakeAlexa } from './support/fake-alexa.js';

const NOW = new Date('2026-01-01T00:10:00Z');

async function start(opts: { health?: SessionHealth; adapter?: FakeAlexa; maxBodyBytes?: number } = {}) {
  const adapter = opts.adapter ?? new FakeAlexa();
  const server = createHttpServer({
    adapter,
    sessionHealth: () => opts.health ?? 'usable',
    authenticate: async (request) => {
      const header = request.headers.authorization;
      if (header === 'Bearer read') return { token: 't', clientId: 'c', scopes: ['read'] };
      if (header === 'Bearer none') return { token: 't', clientId: 'c', scopes: [] };
      return undefined;
    },
    allowedOrigins: ['https://allowed.example'],
    resourceMetadataUrl: 'https://mcp.example/.well-known/oauth-protected-resource',
    ...(opts.maxBodyBytes ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    now: () => NOW,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { server, url, adapter, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

async function client(url: string, token = 'read') {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await c.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
  return { isError: result.isError, body: JSON.parse(text) as Record<string, unknown> };
};

test('authorized client lists only the slice tools with schemas', async () => {
  const s = await start();
  try {
    const c = await client(s.url);
    const tools = await c.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['get_device_state', 'list_devices']);
    assert.ok(tools.tools.every((t) => t.inputSchema));
    await c.close();
  } finally { await s.stop(); }
});

test('unauthenticated request gets a challenge and runs nothing', async () => {
  const s = await start();
  try {
    const response = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /resource_metadata="https:\/\/mcp\.example/);
    assert.equal(s.adapter.calls.length, 0);
  } finally { await s.stop(); }
});

test('invalid origin, oversized and malformed requests are rejected before dispatch', async () => {
  const s = await start({ maxBodyBytes: 200 });
  try {
    const headers = { 'content-type': 'application/json', authorization: 'Bearer read' };
    const origin = await fetch(s.url, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' });
    assert.equal(origin.status, 403);
    const big = await fetch(s.url, { method: 'POST', headers, body: JSON.stringify({ pad: 'x'.repeat(500) }) });
    assert.equal(big.status, 413);
    const bad = await fetch(s.url, { method: 'POST', headers, body: '{not json' });
    assert.equal(bad.status, 400);
    const get = await fetch(s.url, { method: 'GET', headers });
    assert.equal(get.status, 405);
    assert.equal(s.adapter.calls.length, 0);
  } finally { await s.stop(); }
});

test('malformed tool input is rejected without any Amazon call', async () => {
  const s = await start();
  try {
    const c = await client(s.url);
    for (const ids of [[], 'x', [1], Array.from({ length: 26 }, (_, i) => `d${i}`)]) {
      const outcome = await c.callTool({ name: 'get_device_state', arguments: { ids } }).then((r) => r.isError === true, () => true);
      assert.equal(outcome, true);
    }
    assert.equal(s.adapter.calls.length, 0);
    await c.close();
  } finally { await s.stop(); }
});

test('token without read scope is refused by tools', async () => {
  const s = await start();
  try {
    const c = await client(s.url, 'none');
    const result = await call(c, 'list_devices');
    assert.equal(result.isError, true);
    assert.equal(result.body.reason, 'missing_scope');
    assert.equal(s.adapter.calls.length, 0);
    await c.close();
  } finally { await s.stop(); }
});

test('reauthentication_required is reported without any Amazon call', async () => {
  const s = await start({ health: 'reauthentication_required' });
  try {
    const c = await client(s.url);
    const result = await call(c, 'list_devices');
    assert.equal(result.body.status, 'session_unavailable');
    assert.equal(result.body.health, 'reauthentication_required');
    assert.equal(s.adapter.calls.length, 0);
    await c.close();
  } finally { await s.stop(); }
});

test('inventory lists devices with ids and capabilities and counts unusable entries', async () => {
  const adapter = new FakeAlexa({ devices: { smarthomeDevices: [
    { applianceId: 'a1', friendlyName: 'Lamp', applianceTypes: ['LIGHT'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
    { friendlyName: 'No id' },
  ] } });
  const s = await start({ adapter });
  try {
    const c = await client(s.url);
    const result = await call(c, 'list_devices');
    assert.equal(result.body.status, 'ok');
    assert.deepEqual(result.body.devices, [{ id: 'a1', name: 'Lamp', kind: 'LIGHT', capabilities: ['Alexa.PowerController'] }]);
    assert.equal(result.body.skipped, 1);
    await c.close();
  } finally { await s.stop(); }
});

test('state batch reports per-device errors and marks stale or missing values', async () => {
  const cap = (time: string | undefined) => JSON.stringify({ namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON', ...(time ? { timeOfSample: time } : {}) });
  const adapter = new FakeAlexa({ state: {
    fresh: { deviceStates: [{ capabilityStates: [cap('2026-01-01T00:09:30Z')] }] },
    old: { deviceStates: [{ capabilityStates: [cap('2025-12-31T00:00:00Z')] }] },
    nostamp: { deviceStates: [{ capabilityStates: [cap(undefined)] }] },
    broken: { unexpected: true },
  } });
  const s = await start({ adapter });
  try {
    const c = await client(s.url);
    const result = await call(c, 'get_device_state', { ids: ['fresh', 'old', 'nostamp', 'broken'] });
    assert.equal(result.body.status, 'partial');
    const by = Object.fromEntries((result.body.devices as Array<{ id: string; status: string; error?: string; items: Array<{ freshness: string }> }>).map((d) => [d.id, d]));
    assert.equal(by.fresh?.status, 'ok');
    assert.equal(by.old?.status, 'stale');
    assert.equal(by.nostamp?.items[0]?.freshness, 'unknown');
    assert.equal(by.broken?.status, 'error');
    assert.equal(by.broken?.error, 'compatibility_error');
    await c.close();
  } finally { await s.stop(); }
});

test('anonymous health endpoints are coarse and never touch Amazon', async () => {
  for (const [health, ready] of [['usable', 200], ['reauthentication_required', 503]] as const) {
    const s = await start({ health });
    try {
      const base = s.url.replace('/mcp', '');
      const live = await fetch(`${base}/healthz`);
      assert.deepEqual([live.status, await live.json()], [200, { status: 'ok' }]);
      const readiness = await fetch(`${base}/readyz`);
      assert.equal(readiness.status, ready);
      assert.deepEqual(Object.keys((await readiness.json()) as object), ['status']);
      assert.equal(s.adapter.calls.length, 0);
    } finally { await s.stop(); }
  }
});

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import './support/no-network.js';
import { createHttpServer } from '../src/http-server.js';
import { MutationService } from '../src/mutation-service.js';
import { SqliteJournal } from '../src/sqlite-journal.js';
import { FakeAlexa, type FakeAlexaOptions } from './support/fake-alexa.js';

const LIGHT = 'light-1';
const devices = {
  smarthomeDevices: [
    { applianceId: LIGHT, applianceTypes: ['LIGHT'], capabilities: [{ interfaceName: 'Alexa.PowerController' }, { interfaceName: 'Alexa.BrightnessController' }] },
    { applianceId: 'shutter-1', applianceTypes: ['INTERIOR_BLIND'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
    { applianceId: 'light-2', applianceTypes: ['LIGHT'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
  ],
};
const stateOf = (items: Array<[string, string, unknown]>) => ({
  deviceStates: [{ capabilityStates: items.map(([namespace, name, value]) => JSON.stringify({ namespace, name, value, timeOfSample: '2026-01-01T00:00:00Z' })) }],
});

async function start(options: FakeAlexaOptions = {}, retryDelaysMs: readonly number[] = []) {
  const adapter = new FakeAlexa({ devices, ...options });
  const journal = new SqliteJournal(':memory:');
  const mutations = new MutationService(adapter, journal, { allowedTargets: new Set([LIGHT, 'shutter-1']) }, () => new Date(), retryDelaysMs, async () => undefined);
  const server = createHttpServer({
    adapter,
    sessionHealth: () => 'usable',
    authenticate: async (request) => {
      const header = request.headers.authorization;
      const extra = { principal: 'owner' };
      if (header === 'Bearer mutate') return { token: 't', clientId: 'c', scopes: ['read', 'mutate'], extra };
      if (header === 'Bearer read') return { token: 't', clientId: 'c', scopes: ['read'], extra };
      return undefined;
    },
    allowedOrigins: [],
    resourceMetadataUrl: 'https://mcp.example/.well-known/oauth-protected-resource',
    mutations,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, adapter, journal, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

async function client(url: string, token = 'mutate') {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const result = await c.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
  return { isError: result.isError, body: JSON.parse(text) as Record<string, unknown> };
};

test('a mutate token can turn the allow-listed light on and the result is verified by a state read', async () => {
  const s = await start({ state: { [LIGHT]: stateOf([['Alexa.PowerController', 'powerState', 'ON']]) } });
  try {
    const c = await client(s.url);
    const { body, isError } = await call(c, 'light_turn_on', { id: LIGHT });
    assert.equal(isError, undefined);
    assert.equal(body.status, 'verified');
    assert.equal(s.adapter.writes.length, 1);
    assert.deepEqual(s.adapter.writes[0]?.args, [LIGHT, { action: 'turnOn' }]);
    assert.equal((await s.journal.read())[0]?.outcome?.status, 'verified');
    await c.close();
  } finally { await s.stop(); }
});

test('accepted without a matching state read stays accepted, never verified', async () => {
  const s = await start({ state: { [LIGHT]: stateOf([['Alexa.PowerController', 'powerState', 'OFF']]) } });
  try {
    const c = await client(s.url);
    assert.equal((await call(c, 'light_turn_on', { id: LIGHT })).body.status, 'accepted');
    await c.close();
  } finally { await s.stop(); }
});

test('brightness is range-checked and verified', async () => {
  const s = await start({ state: { [LIGHT]: stateOf([['Alexa.BrightnessController', 'brightness', 40]]) } });
  try {
    const c = await client(s.url);
    assert.equal((await call(c, 'light_set_brightness', { id: LIGHT, brightness: 40 })).body.status, 'verified');
    const tooHigh = await c.callTool({ name: 'light_set_brightness', arguments: { id: LIGHT, brightness: 101 } });
    assert.equal(tooHigh.isError, true);
    assert.equal(s.adapter.writes.length, 1);
    await c.close();
  } finally { await s.stop(); }
});

test('a read-only token cannot mutate and nothing is dispatched', async () => {
  const s = await start();
  try {
    const c = await client(s.url, 'read');
    const { body, isError } = await call(c, 'light_turn_on', { id: LIGHT });
    assert.equal(isError, true);
    assert.equal(body.reason, 'missing_scope');
    assert.equal(s.adapter.calls.length, 0);
    await c.close();
  } finally { await s.stop(); }
});

test('a model-supplied confirmed argument grants nothing', async () => {
  const s = await start();
  try {
    const c = await client(s.url, 'read');
    const { isError } = await call(c, 'light_turn_on', { id: LIGHT, confirmed: true });
    assert.equal(isError, true);
    assert.equal(s.adapter.calls.length, 0);
    await c.close();
  } finally { await s.stop(); }
});

test('targets outside the allow-list or in a refused class are rejected without a write', async () => {
  const s = await start();
  try {
    const c = await client(s.url);
    const other = await call(c, 'light_turn_on', { id: 'light-2' });
    assert.deepEqual([other.isError, other.body.status, other.body.reason], [true, 'rejected', 'target_not_allowed']);
    const shutter = await call(c, 'light_turn_on', { id: 'shutter-1' });
    assert.equal(shutter.body.reason, 'safety_class');
    assert.equal(s.adapter.writes.length, 0);
    assert.equal((await s.journal.read()).length, 0);
    await c.close();
  } finally { await s.stop(); }
});

test('an Amazon failure is reported as failed and an ambiguous response as unknown', async () => {
  const failing = await start({ write: (call) => ({ status: 'response_received', body: { controlResponses: [{ entityId: String(call.args[0]), code: 'ERROR' }] } }) });
  try {
    const c = await client(failing.url);
    assert.equal((await call(c, 'light_turn_off', { id: LIGHT })).body.status, 'failed');
    await c.close();
  } finally { await failing.stop(); }

  const ambiguous = await start({ write: () => ({ status: 'unknown' }) });
  try {
    const c = await client(ambiguous.url);
    assert.equal((await call(c, 'light_turn_off', { id: LIGHT })).body.status, 'unknown');
    await c.close();
  } finally { await ambiguous.stop(); }
});

test('a repeated operation key returns the original result and writes once; a changed request conflicts', async () => {
  const s = await start();
  try {
    const c = await client(s.url);
    const first = await call(c, 'light_turn_on', { id: LIGHT, operationKey: 'op-repeat-one' });
    const again = await call(c, 'light_turn_on', { id: LIGHT, operationKey: 'op-repeat-one' });
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.operationId, first.body.operationId);
    const conflict = await call(c, 'light_turn_off', { id: LIGHT, operationKey: 'op-repeat-one' });
    assert.equal(conflict.body.status, 'key_conflict');
    assert.equal(s.adapter.writes.length, 1);
    await c.close();
  } finally { await s.stop(); }
});

test('while one command is in flight, a queued older command is superseded by a newer one and never dispatched', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const s = await start({
    write: async () => {
      await gate;
      return { status: 'response_received', body: { controlResponses: [{ entityId: LIGHT, code: 'SUCCESS' }] } };
    },
  });
  try {
    const c = await client(s.url);
    const first = call(c, 'light_turn_on', { id: LIGHT });
    while (s.adapter.writes.length < 1) await new Promise((r) => setTimeout(r, 5));
    const queued = call(c, 'light_turn_off', { id: LIGHT });
    while ((await s.journal.read()).length < 2) await new Promise((r) => setTimeout(r, 5));
    const newest = call(c, 'light_set_brightness', { id: LIGHT, brightness: 10 });
    while ((await s.journal.read()).length < 3) await new Promise((r) => setTimeout(r, 5));
    release();
    const results = await Promise.all([first, queued, newest]);
    assert.equal(results[1].body.status, 'superseded');
    assert.notEqual(results[2].body.status, 'superseded');
    assert.deepEqual(s.adapter.writes.map((w) => (w.args[1] as { action: string }).action), ['turnOn', 'setBrightness']);
    await c.close();
  } finally { await s.stop(); }
});

test('a 429 from Amazon is retried and then succeeds, and persistent 429 is reported as not_dispatched', async () => {
  let refusals = 2;
  const flaky = await start({
    state: { [LIGHT]: stateOf([['Alexa.PowerController', 'powerState', 'ON']]) },
    write: (c) => (refusals-- > 0
      ? { status: 'rate_limited' }
      : { status: 'response_received', body: { controlResponses: [{ entityId: String(c.args[0]), code: 'SUCCESS' }] } }),
  }, [0, 0, 0]);
  const blocked = await start({ write: () => ({ status: 'rate_limited' }) }, [0, 0]);
  try {
    const c1 = await client(flaky.url);
    assert.equal((await call(c1, 'light_turn_on', { id: LIGHT })).body.status, 'verified');
    assert.equal(flaky.adapter.writes.length, 3);
    await c1.close();
    const c2 = await client(blocked.url);
    assert.equal((await call(c2, 'light_turn_on', { id: LIGHT })).body.status, 'not_dispatched');
    assert.equal(blocked.adapter.writes.length, 3);
    await c2.close();
  } finally { await flaky.stop(); await blocked.stop(); }
});

test('consecutive writes reuse the cached inventory for the policy check', async () => {
  const s = await start({ state: { [LIGHT]: stateOf([['Alexa.PowerController', 'powerState', 'ON']]) } });
  try {
    const c = await client(s.url);
    await call(c, 'light_turn_on', { id: LIGHT });
    await call(c, 'light_turn_off', { id: LIGHT });
    assert.equal(s.adapter.writes.length, 2);
    assert.equal(s.adapter.calls.filter((x) => x.method === 'smartHomeDevices').length, 1);
    await c.close();
  } finally { await s.stop(); }
});

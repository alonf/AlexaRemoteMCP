import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import './support/no-network.js';
import { FakeAlexa, type FakeAlexaOptions } from './support/fake-alexa.js';
import { exchange, fullFlow, startAuthServer } from './support/oauth-flow.js';

const LIGHT = 'light-1';
const devices = {
  smarthomeDevices: [
    { applianceId: LIGHT, applianceTypes: ['LIGHT'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
    { applianceId: 'shutter-1', applianceTypes: ['INTERIOR_BLIND'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
  ],
};
const powerState = (value: string) => ({
  deviceStates: [{ capabilityStates: [JSON.stringify({ namespace: 'Alexa.PowerController', name: 'powerState', value, timeOfSample: '2026-01-01T00:00:00Z' })] }],
});

async function setup(scope: string, options: FakeAlexaOptions = {}) {
  const adapter = new FakeAlexa({ devices, ...options });
  const s = await startAuthServer({ adapter, allowedTargets: [LIGHT, 'shutter-1'] });
  const flow = await fullFlow(s, scope);
  const token = (await exchange(s, flow)).body.access_token ?? '';
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.resource), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    return { isError: result.isError, body: JSON.parse(text) as Record<string, unknown> };
  };
  return { s, adapter, call, token, stop: async () => { await client.close(); await s.stop(); } };
}

test('owner flow to verified mutation: issuer, MCP, policy, journal and fake adapter agree', async () => {
  const t = await setup('read mutate', { state: { [LIGHT]: powerState('ON') } });
  try {
    const listed = await t.call('list_devices', {});
    assert.equal(listed.isError, undefined);
    const result = await t.call('light_turn_on', { id: LIGHT, operationKey: 'e2e-operation-1' });
    assert.equal(result.body.status, 'verified');
    const record = (await t.s.journal.read())[0];
    assert.equal(record?.operation, 'device-power');
    assert.equal(record?.outcome?.status, 'verified');
    assert.equal(t.adapter.writes.length, 1);
  } finally { await t.stop(); }
});

test('a read-only grant reads but cannot mutate, and nothing reaches the adapter', async () => {
  const t = await setup('read');
  try {
    assert.equal((await t.call('list_devices', {})).isError, undefined);
    const denied = await t.call('light_turn_on', { id: LIGHT });
    assert.deepEqual([denied.isError, denied.body.reason], [true, 'missing_scope']);
    assert.equal(t.adapter.writes.length, 0);
  } finally { await t.stop(); }
});

test('policy refusals, Amazon failure and uncertainty are reported honestly end to end', async () => {
  const t = await setup('read mutate', {
    write: (call) => (call.args[0] === LIGHT
      ? { status: 'unknown' }
      : { status: 'response_received', body: { controlResponses: [{ entityId: String(call.args[0]), code: 'ERROR' }] } }),
  });
  try {
    assert.equal((await t.call('light_turn_on', { id: 'shutter-1' })).body.reason, 'safety_class');
    assert.equal((await t.call('light_turn_on', { id: 'not-listed' })).body.reason, 'target_not_allowed');
    assert.equal(t.adapter.writes.length, 0);
    assert.equal((await t.call('light_turn_on', { id: LIGHT })).body.status, 'unknown');
  } finally { await t.stop(); }
});

test('requests without a valid token are challenged and dispatch nothing', async () => {
  const t = await setup('read mutate');
  try {
    const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const none = await fetch(t.s.resource, { method: 'POST', headers: base, body: '{}' });
    const bogus = await fetch(t.s.resource, { method: 'POST', headers: { ...base, authorization: 'Bearer nope' }, body: '{}' });
    assert.deepEqual([none.status, bogus.status], [401, 401]);
    assert.equal(t.adapter.writes.length, 0);
  } finally { await t.stop(); }
});

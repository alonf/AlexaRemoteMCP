/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON-RPC payloads in tests */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './support/no-network.js';
import { parseActionPolicy } from '../src/action-policy.js';
import { ApprovalSigner } from '../src/approval.js';
import { CatalogService } from '../src/catalog-service.js';
import { CatalogError, CatalogStore, loadCatalogFile, parseCatalog } from '../src/catalog.js';
import { createHttpServer } from '../src/http-server.js';
import { MutationService } from '../src/mutation-service.js';
import { SqliteJournal } from '../src/sqlite-journal.js';
import { FakeAlexa } from './support/fake-alexa.js';

const power = [{ interfaceName: 'Alexa.PowerController' }];
const devices = {
  smarthomeDevices: [
    { applianceId: 'sw-heater', friendlyName: 'Bathroom switch', applianceTypes: ['SWITCH'], capabilities: power },
    { applianceId: 'sw-plug', friendlyName: 'Plug', applianceTypes: ['SWITCH'], capabilities: power },
    { applianceId: 'cam-1', friendlyName: 'Camera', applianceTypes: ['CAMERA'], capabilities: power },
    { applianceId: 'lamp', friendlyName: 'Lamp', applianceTypes: ['LIGHT'], capabilities: power },
  ],
};
const doc = (entries: Record<string, unknown>) => JSON.stringify({ version: 1, devices: entries });

test('a catalog parses strictly and names the offending device and field', () => {
  assert.equal(parseCatalog(doc({ a: { category: 'heater', group: 'requires-approval', description: 'x\u0000y' } })).get('a')?.description, 'x y');
  for (const [text, fragment] of [
    ['nope', 'valid JSON'],
    [JSON.stringify({ version: 2, devices: {} }), 'version'],
    [doc({ a: { category: 'toaster' } }), 'category'],
    [doc({ a: { category: 'light', group: 'free-for-all' } }), 'group'],
    [doc({ a: { category: 'light', extra: 1 } }), 'unknown field'],
    [doc({ a: { category: 'group', members: [] } }), 'category'],
    [doc({ a: { category: 'light', members: ['ghost'] } }), 'member'],
    [doc({ a: { category: 'query' } }), 'category'],
  ] as const) {
    assert.throws(() => parseCatalog(text), (error: Error) => error instanceof CatalogError && error.message.includes(fragment), text);
  }
});

test('a missing file is an empty catalog and a corrupt one is an error; saves keep a backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
  const path = join(dir, 'device-catalog.json');
  assert.equal(loadCatalogFile(path).size, 0);
  const store = new CatalogStore(loadCatalogFile(path), path);
  store.replace(parseCatalog(doc({ a: { category: 'light' } })));
  store.replace(parseCatalog(doc({ a: { category: 'heater' } })));
  assert.equal(loadCatalogFile(path).get('a')?.category, 'heater');
  assert.equal(parseCatalog(readFileSync(`${path}.bak`, 'utf8')).get('a')?.category, 'light');
  writeFileSync(path, '{broken');
  assert.throws(() => loadCatalogFile(path), CatalogError);
});

const MRTR = {
  _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
  },
};

async function start(initial: Record<string, unknown> = {}, policy = 'light=allow') {
  const adapter = new FakeAlexa({ devices });
  const journal = new SqliteJournal(':memory:');
  const catalog = new CatalogStore(parseCatalog(doc(initial)));
  const signer = new ApprovalSigner(Buffer.alloc(32, 9));
  const mutations = new MutationService(
    adapter, journal, { allowedTargets: new Set(['*']), catalog, modes: parseActionPolicy(policy) },
    () => new Date('2026-01-01T10:00:00Z'), [], async () => undefined, undefined, signer,
  );
  const service = new CatalogService(catalog, journal, signer, () => new Date('2026-01-01T10:00:00Z'));
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
    catalog: service,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  let id = 0;
  const call = async (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = MRTR) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args, ...extra } }),
    });
    const result = ((await response.json()) as { result: Record<string, unknown> }).result;
    const text = (result.content as Array<{ text: string }> | undefined)?.[0]?.text;
    return { result, body: text ? JSON.parse(text) as Record<string, any> : undefined };
  };
  return { adapter, catalog, call, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

const accept = (requestState: unknown) => ({ ...MRTR, requestState, inputResponses: { approval: { action: 'accept', content: { approve: true } } } });

test('a catalog category and group make a generic switch a heater that needs approval', async () => {
  const s = await start({ 'sw-heater': { category: 'heater', group: 'requires-approval' }, 'sw-plug': { category: 'outlet', group: 'read-only' } });
  try {
    const plain = await s.call('set_device_state', { id: 'sw-plug', action: 'on' }, {});
    assert.deepEqual([plain.body?.status, plain.body?.reason], ['rejected', 'category_denied']);
    const noMrtr = await s.call('set_device_state', { id: 'sw-heater', action: 'on' }, {});
    assert.equal(noMrtr.body?.status, 'confirmation_required');
    const asked = await s.call('set_device_state', { id: 'sw-heater', action: 'on' });
    assert.equal(asked.result.resultType, 'input_required');
    const done = await s.call('set_device_state', { id: 'sw-heater', action: 'on' }, accept(asked.result.requestState));
    assert.equal(done.body?.status, 'accepted');
    assert.equal(s.adapter.writes.length, 1);
  } finally { await s.stop(); }
});

test('a low-risk group allows without asking, and the catalog cannot unlock a blocked class', async () => {
  const s = await start({ 'sw-heater': { category: 'ac', group: 'low-risk' }, 'cam-1': { category: 'light', group: 'low-risk' } });
  try {
    assert.equal((await s.call('set_device_state', { id: 'sw-heater', action: 'on' }, {})).body?.status, 'accepted');
    assert.equal((await s.call('set_device_state', { id: 'cam-1', action: 'on' }, {})).body?.reason, 'safety_class');
    assert.equal((await s.call('set_device_state', { id: 'sw-plug', action: 'on' }, {})).body?.reason, 'unknown_class');
  } finally { await s.stop(); }
});

test('list_devices and get_device_catalog show the owner\'s notes to the agent', async () => {
  const s = await start({ lamp: { category: 'light', description: 'Hall lamp' } });
  try {
    const list = await s.call('list_devices', {});
    const lamp = (list.body?.devices as Array<Record<string, any>>).find((d) => d.id === 'lamp');
    assert.deepEqual(lamp?.catalog, { category: 'light', description: 'Hall lamp' });
    const read = await s.call('get_device_catalog', {});
    assert.equal(read.body?.devices.lamp.description, 'Hall lamp');
    assert.equal(read.body?.groups['low-risk'], 'allow');
  } finally { await s.stop(); }
});

test('find_device ranks by several hints and returns only the best matches', async () => {
  const s = await start({ lamp: { category: 'light', description: 'Hall lamp' } });
  try {
    const hit = await s.call('find_device', { terms: ['hall', 'lamp', 'light'] });
    assert.equal(hit.body?.status, 'ok');
    assert.equal(hit.body?.matches[0].id, 'lamp');
    assert.equal(hit.body?.matchedAllTerms, true);
    const none = await s.call('find_device', { terms: ['zzzz'] });
    assert.deepEqual(none.body?.matches, []);
  } finally { await s.stop(); }
});

test('a catalog edit saves only after the owner approves the exact change set', async () => {
  const s = await start({ lamp: { category: 'light' } });
  try {
    const change = { set: { 'sw-heater': { category: 'heater', group: 'low-risk' } } };
    const asked = await s.call('update_device_catalog', change);
    assert.equal(asked.result.resultType, 'input_required');
    assert.match(String((asked.result.inputRequests as any).approval.params.message), /sw-heater as heater \(low-risk\)/);
    assert.equal(s.catalog.get().has('sw-heater'), false);

    const other = await s.call('update_device_catalog', { set: { 'sw-heater': { category: 'heater', group: 'requires-approval' } } }, accept(asked.result.requestState));
    assert.equal(other.body?.reason, 'approval_invalid');
    const unsupported = await s.call('update_device_catalog', change, {});
    assert.equal(unsupported.body?.reason, 'approval_unsupported');

    const asked2 = await s.call('update_device_catalog', change);
    const declined = await s.call('update_device_catalog', change, { ...MRTR, requestState: asked2.result.requestState, inputResponses: { approval: { action: 'decline' } } });
    assert.equal(declined.body?.reason, 'owner_declined');
    assert.equal(s.catalog.get().has('sw-heater'), false);

    const asked3 = await s.call('update_device_catalog', change);
    const saved = await s.call('update_device_catalog', change, accept(asked3.result.requestState));
    assert.deepEqual([saved.body?.status, saved.body?.count], ['saved', 1]);
    assert.equal(s.catalog.get().get('sw-heater')?.group, 'low-risk');
    const replay = await s.call('update_device_catalog', change, accept(asked3.result.requestState));
    assert.equal(replay.body?.reason, 'approval_invalid');
  } finally { await s.stop(); }
});

test('an invalid or oversized edit is refused before any approval is requested', async () => {
  const s = await start();
  try {
    const bad = await s.call('update_device_catalog', { set: { x: { category: 'toaster' } } });
    assert.deepEqual([bad.body?.status, bad.body?.reason], ['rejected', 'invalid_change']);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`d${i}`, { category: 'light' }]));
    assert.equal((await s.call('update_device_catalog', { set: many })).body?.reason, 'too_many_changes');
    assert.equal((await s.call('update_device_catalog', {})).body?.reason, 'no_change');
  } finally { await s.stop(); }
});

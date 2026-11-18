import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './support/no-network.js';
import { CatalogService } from '../src/catalog-service.js';
import { CatalogStore, loadCatalogFile, parseCatalog } from '../src/catalog.js';
import { throttleBackup } from '../src/catalog-backup.js';
import { SqliteJournal } from '../src/sqlite-journal.js';
import { exchange, fullFlow, startAuthServer } from './support/oauth-flow.js';
import { FakeAlexa } from './support/fake-alexa.js';

const doc = (entries: Record<string, unknown>) => JSON.stringify({ version: 1, devices: entries });

function setup(backup?: (text: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'admin-'));
  const path = join(dir, 'device-catalog.json');
  const store = new CatalogStore(parseCatalog(doc({ lamp: { category: 'light', group: 'low-risk' } })), path);
  const service = new CatalogService(store, new SqliteJournal(':memory:'), undefined, undefined, backup);
  return { path, store, service };
}

async function adminToken(s: Awaited<ReturnType<typeof startAuthServer>>) {
  const flow = await fullFlow(s, 'admin');
  assert.ok(flow.code, `expected a code, got ${flow.final}`);
  const token = await exchange(s, flow);
  assert.equal(token.status, 200, JSON.stringify(token.body));
  return token.body.access_token as string;
}

test('the admin page needs no token but its API does, and the page is locked down', async () => {
  const { service } = setup();
  const s = await startAuthServer({ adminCatalog: service });
  try {
    const page = await fetch(`${s.base}/admin/catalog`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'nonce-[^']+'/);
    assert.equal(((await page.text()).match(/lamp/g) ?? []).length, 0);
    assert.equal((await fetch(`${s.base}/admin/api/devices`)).status, 401);
    assert.equal((await fetch(`${s.base}/admin/api/catalog`, { method: 'PATCH', body: '{}' })).status, 401);
  } finally { await s.stop(); }
});

test('an admin token lists devices, edits one entry and persists it, backing up the earlier state first', async () => {
  const snapshots: string[] = [];
  const { service, path } = setup(async (text) => { snapshots.push(text); });
  const adapter = new FakeAlexa({ devices: { smarthomeDevices: [{ applianceId: 'lamp', friendlyName: 'Lamp' }, { applianceId: 'new', friendlyName: 'New' }] } });
  const s = await startAuthServer({ adminCatalog: service, adapter });
  try {
    const bearer = { authorization: `Bearer ${await adminToken(s)}`, 'content-type': 'application/json' };
    const list = (await (await fetch(`${s.base}/admin/api/devices`, { headers: bearer })).json()) as { devices: Array<{ id: string; catalog?: unknown }> };
    assert.deepEqual(list.devices.map((d) => [d.id, d.catalog !== undefined]), [['lamp', true], ['new', false]]);

    const edit = await fetch(`${s.base}/admin/api/catalog`, { method: 'PATCH', headers: bearer, body: JSON.stringify({ set: { new: { category: 'heater', group: 'requires-approval' } } }) });
    assert.equal(edit.status, 200);
    assert.equal(snapshots.length, 1);
    assert.equal(parseCatalog(snapshots[0] ?? '').has('new'), false);
    assert.equal(loadCatalogFile(path).get('new')?.category, 'heater');

    const bad = await fetch(`${s.base}/admin/api/catalog`, { method: 'PATCH', headers: bearer, body: JSON.stringify({ set: { x: { category: 'toaster' } } }) });
    assert.equal(bad.status, 400);
    const badShape = await fetch(`${s.base}/admin/api/catalog`, { method: 'PATCH', headers: bearer, body: JSON.stringify({ remove: 'lamp' }) });
    assert.equal(badShape.status, 400);

    const replaced = await fetch(`${s.base}/admin/api/catalog`, { method: 'PUT', headers: bearer, body: doc({ only: { category: 'ac' } }) });
    assert.equal(replaced.status, 200);
    assert.deepEqual([...loadCatalogFile(path).keys()], ['only']);
    assert.equal(snapshots.length, 2);
  } finally { await s.stop(); }
});

test('if the pre-edit backup fails, nothing is changed', async () => {
  const { service, store, path } = setup(async () => { throw new Error('storage down'); });
  const s = await startAuthServer({ adminCatalog: service });
  try {
    const bearer = { authorization: `Bearer ${await adminToken(s)}`, 'content-type': 'application/json' };
    const edit = await fetch(`${s.base}/admin/api/catalog`, { method: 'PATCH', headers: bearer, body: JSON.stringify({ set: { lamp: { category: 'heater' } } }) });
    assert.equal(edit.status, 503);
    assert.equal(((await edit.json()) as { reason: string }).reason, 'backup_failed');
    assert.equal(store.get().get('lamp')?.category, 'light');
    assert.throws(() => readFileSync(path), /ENOENT/);
  } finally { await s.stop(); }
});

test('an MCP token without the admin scope, or an admin request from another client, is refused', async () => {
  const { service } = setup();
  const s = await startAuthServer({ adminCatalog: service });
  try {
    const flow = await fullFlow(s, 'read');
    const token = await exchange(s, flow);
    const read = await fetch(`${s.base}/admin/api/devices`, { headers: { authorization: `Bearer ${token.body.access_token}` } });
    assert.equal(read.status, 401);
  } finally { await s.stop(); }

  const plain = await startAuthServer();
  try {
    const flow = await fullFlow(plain, 'admin');
    assert.equal(flow.code, null, 'a server without an admin page never grants the admin scope');
  } finally { await plain.stop(); }
});

test('a burst of edits shares one snapshot', async () => {
  let taken = 0;
  let clock = 0;
  const backup = throttleBackup(async () => { taken++; }, 1000, () => clock);
  await backup('a'); clock = 500; await backup('b'); clock = 1500; await backup('c');
  assert.equal(taken, 2);
});

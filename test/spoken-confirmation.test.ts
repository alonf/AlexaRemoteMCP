import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/no-network.js';
import { ApprovalSigner } from '../src/approval.js';
import { parseCatalog } from '../src/catalog.js';
import { MutationService } from '../src/mutation-service.js';
import { SqliteJournal } from '../src/sqlite-journal.js';
import { FakeAlexa } from './support/fake-alexa.js';

const cap = (interfaceName: string, extra: Record<string, unknown> = {}) => ({ interfaceName, ...extra });
const blindCaps = [cap('Alexa.ModeController', { instance: 'Blind.Position', configuration: { supportedModes: [{ value: 'Position.Up' }, { value: 'Position.Down' }] } })];
const devices = {
  smarthomeDevices: [
    { applianceId: 'blind-1', friendlyName: 'Terrace blind', applianceTypes: ['EXTERIOR_BLIND'], capabilities: blindCaps },
    { applianceId: 'blind-2', friendlyName: 'Other blind', applianceTypes: ['EXTERIOR_BLIND'], capabilities: blindCaps },
    { applianceId: 'heater-1', friendlyName: 'Floor heating', applianceTypes: ['HEATER'], capabilities: [cap('Alexa.PowerController')] },
  ],
};
const catalog = parseCatalog(JSON.stringify({
  version: 1,
  devices: {
    'blind-1': { category: 'cover', group: 'requires-approval' },
    'blind-2': { category: 'cover', group: 'requires-approval' },
    'heater-1': { category: 'heater', group: 'requires-approval' },
  },
}));

function start() {
  const adapter = new FakeAlexa({ devices });
  const clock = { at: new Date('2026-01-01T10:00:00Z') };
  const service = new MutationService(
    adapter, new SqliteJournal(':memory:'), { allowedTargets: new Set(['*']), catalog: { get: () => catalog } },
    () => clock.at, [], async () => undefined, undefined, new ApprovalSigner(Buffer.alloc(32, 7)),
  );
  const ctx = { principal: 'owner', client: 'chatgpt' };
  const open = (id: string, confirmation?: { approvalId?: string; confirmed?: boolean }) =>
    service.execute(ctx, id, { kind: 'position', direction: 'open' }, { canElicit: false, ...(confirmation ? { confirmation } : {}) });
  return { adapter, clock, open, service, ctx };
}

test('a spoken-confirmation device asks first and dispatches nothing', async () => {
  const s = start();
  const reply = await s.open('blind-1');
  assert.equal(reply.status, 'confirmation_required');
  assert.match(reply.question ?? '', /Open "Terrace blind"/);
  assert.equal(typeof reply.approvalId, 'string');
  assert.equal(s.adapter.writes.length, 0);
});

test('a confirmation needs a pause, works once, and only for the same action', async () => {
  const s = start();
  const { approvalId } = await s.open('blind-1');
  assert.deepEqual(await s.open('blind-1', { approvalId: approvalId as string, confirmed: true }), { status: 'rejected', reason: 'confirmation_too_soon' });
  assert.equal(s.adapter.writes.length, 0);

  const other = await s.open('blind-1');
  s.clock.at = new Date(s.clock.at.getTime() + 5000);
  assert.deepEqual(await s.open('blind-2', { approvalId: other.approvalId as string, confirmed: true }), { status: 'rejected', reason: 'approval_invalid' });
  assert.equal(s.adapter.writes.length, 0);

  s.clock.at = new Date(s.clock.at.getTime() + 5000);
  const second = await s.open('blind-1');
  s.clock.at = new Date(s.clock.at.getTime() + 5000);
  const first = await s.open('blind-1', { approvalId: second.approvalId as string, confirmed: true });
  assert.notEqual(first.status, 'rejected', JSON.stringify(first));
  assert.equal(s.adapter.writes.length, 1);
  assert.deepEqual(await s.open('blind-1', { approvalId: second.approvalId as string, confirmed: true }), { status: 'rejected', reason: 'approval_invalid' });
  assert.equal(s.adapter.writes.length, 1);
});

test('declining, expiry and a missing confirmation never dispatch', async () => {
  const s = start();
  const { approvalId } = await s.open('blind-1');
  s.clock.at = new Date(s.clock.at.getTime() + 5000);
  assert.deepEqual(await s.open('blind-1', { approvalId: approvalId as string, confirmed: false }), { status: 'rejected', reason: 'owner_declined' });

  const second = await s.open('blind-1');
  s.clock.at = new Date(s.clock.at.getTime() + 3 * 60_000);
  assert.deepEqual(await s.open('blind-1', { approvalId: second.approvalId as string, confirmed: true }), { status: 'rejected', reason: 'approval_expired' });
  assert.equal(s.adapter.writes.length, 0);
});

test('CHAT_CONFIRMATION=off restores approval_unsupported for clients that cannot elicit', async () => {
  process.env.CHAT_CONFIRMATION = 'off';
  try {
    const s = start();
    const reply = await s.service.execute(s.ctx, 'heater-1', { kind: 'power', on: true }, { canElicit: false, confirmation: { approvalId: 'x', confirmed: true } });
    assert.deepEqual(reply, { status: 'rejected', reason: 'approval_unsupported' });
    assert.equal(s.adapter.writes.length, 0);
  } finally {
    delete process.env.CHAT_CONFIRMATION;
  }
});

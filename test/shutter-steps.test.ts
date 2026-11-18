import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/no-network.js';
import { ApprovalSigner } from '../src/approval.js';
import { parseCatalog } from '../src/catalog.js';
import { MutationService } from '../src/mutation-service.js';
import { SqliteJournal } from '../src/sqlite-journal.js';
import { FakeAlexa } from './support/fake-alexa.js';

const modes = ['Position.Up', 'Position.Down', 'Position.Stop', 'Position.StepUp', 'Position.StepDown'].map((value) => ({ value }));
const devices = {
  smarthomeDevices: [{
    applianceId: 'blind-1', friendlyName: 'Terrace blind', applianceTypes: ['EXTERIOR_BLIND'],
    capabilities: [{ interfaceName: 'Alexa.ModeController', instance: 'Blind.Position', configuration: { supportedModes: modes } }],
  }],
};

function start(entry: Record<string, unknown>) {
  const adapter = new FakeAlexa({ devices });
  const catalog = parseCatalog(JSON.stringify({ version: 1, devices: { 'blind-1': { category: 'cover', ...entry } } }));
  const service = new MutationService(
    adapter, new SqliteJournal(':memory:'), { allowedTargets: new Set(['*']), catalog: { get: () => catalog } },
    () => new Date('2026-01-01T10:00:00Z'), [], async () => undefined, undefined, new ApprovalSigner(Buffer.alloc(32, 7)),
  );
  const run = (direction: 'open' | 'close' | 'stop_up' | 'stop_down' | 'step_up' | 'step_down') =>
    service.execute({ principal: 'owner', client: 'test' }, 'blind-1', { kind: 'position', direction }, { canElicit: false });
  return { adapter, run };
}

test('a stop steps in the direction of travel and never sends Position.Stop', async () => {
  const s = start({ group: 'low-risk' });
  await s.run('stop_up');
  await s.run('stop_down');
  await s.run('step_up');
  await s.run('step_down');
  const sent = s.adapter.writes.map((w) => (w.args[1] as { mode: string }).mode);
  assert.deepEqual(sent, ['Position.StepUp', 'Position.StepDown', 'Position.StepUp', 'Position.StepDown']);
});

test('stop and step have their own per-operation modes', async () => {
  const s = start({ group: 'requires-approval', operations: { stop: 'allow', step: 'deny' } });
  assert.notEqual((await s.run('stop_up')).status, 'confirmation_required');
  assert.equal(s.adapter.writes.length, 1);
  assert.deepEqual(await s.run('step_up'), { status: 'rejected', reason: 'category_denied' });
  assert.equal((await s.run('open')).status, 'confirmation_required');
  assert.equal(s.adapter.writes.length, 1);
});

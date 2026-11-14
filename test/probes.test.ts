import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DndProbe, FileSnapshotStore, type DndBackend, type DndSnapshot, type DndValue } from '../src/dnd-probe.js';
import { hashArguments, Journal } from '../src/journal.js';
import { mutationArgs, runMutationProbe } from '../src/mutation-probe.js';
import type { Outcome } from '../src/outcomes.js';
import { interpretState, readDeviceState, readInventory } from '../src/read-probes.js';
import { routineDefinitionHash, runRoutineProbe } from '../src/routine-probe.js';

const reader = (overrides: Record<string, () => Promise<unknown>> = {}) => ({
  echoDevices: async () => ({ devices: [{ deviceType: 'ECHO_A' }, { deviceType: 'ECHO_A' }, { deviceType: 'ECHO_B' }] }),
  smartHomeDevices: async () => [{ applianceTypes: ['LIGHT'] }],
  smartHomeGroups: async () => [],
  routines: async () => [{ automationId: 'r1', sequence: { sequenceId: 's1' } }],
  deviceState: async () => ({ deviceStates: [] }),
  ...overrides,
}) as never;

test('inventory reports each family independently with counts, kinds and failures', async () => {
  const result = await readInventory(reader({
    smartHomeGroups: async () => { throw new Error('boom with private detail'); },
    routines: async () => ({ unexpected: true }),
  }), new Date('2026-01-01T00:00:00Z'));
  assert.deepEqual(result.families.echo, { status: 'ok', count: 3, kinds: { ECHO_A: 2, ECHO_B: 1 } });
  assert.deepEqual(result.families.smartHome, { status: 'ok', count: 1, kinds: { LIGHT: 1 } });
  assert.deepEqual(result.families.groups, { status: 'failed', reason: 'read_failed' });
  assert.deepEqual(result.families.routines, { status: 'failed', reason: 'unexpected_shape' });
  assert.ok(!JSON.stringify(result).includes('private'));
  const empty = await readInventory(reader({ echoDevices: async () => ({ devices: [] }) }));
  assert.deepEqual(empty.families.echo, { status: 'empty' });
});

test('state read reports value, source time, age, and unknown for missing fields', () => {
  const now = new Date('2026-01-01T00:01:00Z');
  const body = {
    deviceStates: [{ capabilityStates: [
      JSON.stringify({ namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON', timeOfSample: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ namespace: 'Alexa.BrightnessController', name: 'brightness' }),
    ] }],
    errors: [{ code: 'ENDPOINT_UNREACHABLE' }],
  };
  const result = interpretState(body, now);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.deepEqual(result.items[0], { namespace: 'Alexa.PowerController', property: 'powerState', value: 'ON', timeOfSample: '2026-01-01T00:00:00Z', ageSeconds: 60 });
  assert.equal(result.items[1]?.value, 'unknown');
  assert.equal(result.items[1]?.timeOfSample, 'unknown');
  assert.deepEqual(result.errors, ['ENDPOINT_UNREACHABLE']);
  assert.equal(result.cache, 'live');
});

test('state read treats unexpected shapes and bare device records as no proof of state', async () => {
  const now = new Date();
  assert.equal(interpretState('<html>', now).status, 'compatibility_error');
  assert.equal(interpretState({ deviceStates: ['x'] }, now).status, 'compatibility_error');
  assert.equal(interpretState({ deviceStates: [{ capabilityStates: ['not json'] }] }, now).status, 'compatibility_error');
  assert.equal(interpretState({ deviceStates: [] }, now).status, 'no_state');
  const bare = interpretState({ deviceStates: [{ entity: { entityId: 'x' } }] }, now);
  assert.equal(bare.status === 'ok' && bare.items[0]?.value, 'unknown');
  assert.equal((await readDeviceState(reader({ deviceState: async () => { throw new Error('x'); } }), 'id')).status, 'failed');
});

function fakeDnd(initial: Record<string, DndValue>, options: { failWrites?: string[]; revisions?: boolean } = {}) {
  const state = { ...initial };
  const writes: Array<[string, boolean]> = [];
  const backend: DndBackend = {
    hasRevisionHistory: options.revisions ?? false,
    async read() { return { ...state }; },
    async write(device, enabled): Promise<Outcome> {
      writes.push([device, enabled]);
      if (options.failWrites?.includes(device)) return { status: 'unknown' };
      state[device] = enabled;
      return { status: 'accepted' };
    },
  };
  let saved: DndSnapshot | null = null;
  const store = {
    saves: 0,
    failing: false,
    async load() { return saved ? structuredClone(saved) : null; },
    async save(snapshot: DndSnapshot) {
      if (store.failing) throw new Error('disk full');
      store.saves++;
      saved = structuredClone(snapshot);
    },
  };
  return { backend, store, state, writes };
}

test('DND: device that started enabled is never switched off', async () => {
  const f = fakeDnd({ a: true, b: false });
  const probe = new DndProbe(f.backend, f.store);
  const applied = await probe.apply(['a', 'b'], true);
  assert.equal(applied.outcome.status, 'accepted');
  assert.deepEqual(f.writes, [['b', true]]);
  const restored = await probe.restore({ ownerDirected: true });
  assert.equal(restored.outcome.status, 'accepted');
  assert.equal(f.state.a, true);
  assert.equal(f.state.b, false);
  assert.deepEqual(f.writes.filter(([d, e]) => d === 'a' && !e), []);
});

test('DND: snapshot write failure dispatches nothing; unknown initial value blocks the write', async () => {
  const f = fakeDnd({ a: false, b: 'unknown' });
  f.store.failing = true;
  const probe = new DndProbe(f.backend, f.store);
  assert.equal((await probe.apply(['a'], true)).outcome.status, 'not_dispatched');
  assert.deepEqual(f.writes, []);
  f.store.failing = false;
  const blocked = await probe.apply(['b'], true);
  assert.equal(blocked.outcome.status, 'rejected');
  assert.deepEqual(f.writes, []);
});

test('DND: manual change after the probe is a conflict and is never overwritten', async () => {
  const f = fakeDnd({ a: false });
  const probe = new DndProbe(f.backend, f.store);
  await probe.apply(['a'], true);
  f.state.a = false;
  const restored = await probe.restore({ ownerDirected: true });
  assert.equal(restored.snapshot?.devices[0]?.state, 'conflict');
  assert.equal(restored.outcome.status, 'failed');
  assert.equal(f.writes.length, 1);
});

test('DND: equal current and desired value without revision history defers restoration', async () => {
  const f = fakeDnd({ a: false });
  const probe = new DndProbe(f.backend, f.store);
  await probe.apply(['a'], true);
  const first = await probe.restore();
  assert.equal(first.snapshot?.devices[0]?.state, 'attribution_uncertain');
  assert.equal(first.outcome.status, 'unknown');
  assert.equal(f.state.a, true);
  const directed = await probe.restore({ ownerDirected: true });
  assert.equal(directed.outcome.status, 'accepted');
  assert.equal(f.state.a, false);
});

test('DND: with revision history restoration proceeds automatically', async () => {
  const f = fakeDnd({ a: false }, { revisions: true });
  const probe = new DndProbe(f.backend, f.store);
  await probe.apply(['a'], true);
  assert.equal((await probe.restore()).outcome.status, 'accepted');
  assert.equal(f.state.a, false);
});

test('DND: partial failure is reported per device without rolling back successes', async () => {
  const f = fakeDnd({ a: false, b: false }, { failWrites: ['b'] });
  const probe = new DndProbe(f.backend, f.store);
  const applied = await probe.apply(['a', 'b'], true);
  assert.equal(applied.outcome.status, 'partially_applied');
  assert.deepEqual(applied.outcome.targets, [{ target: 'a', status: 'accepted' }, { target: 'b', status: 'unknown' }]);
  assert.equal(f.state.a, true);
  const none = fakeDnd({ a: false }, { failWrites: ['a'] });
  assert.equal((await new DndProbe(none.backend, none.store).apply(['a'], true)).outcome.status, 'unknown');
});

test('DND: restart reconciles from the persisted snapshot without fabricating success', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dnd-test-'));
  const file = path.join(dir, 'snapshot.json');
  const f = fakeDnd({ a: false, b: false });
  const first = new DndProbe(f.backend, new FileSnapshotStore(file));
  await first.apply(['a', 'b'], true);
  // Crash model: a restarted process sees only the file and the live values.
  f.state.b = false;
  const restarted = new DndProbe(f.backend, new FileSnapshotStore(file));
  const result = await restarted.restore({ ownerDirected: true });
  const states = Object.fromEntries((result.snapshot?.devices ?? []).map((d) => [d.serial, d.state]));
  assert.deepEqual(states, { a: 'restored', b: 'conflict' });
  assert.equal(f.state.a, false);
  assert.equal(result.outcome.status, 'partially_applied');
  assert.equal((await new FileSnapshotStore(path.join(dir, 'none.json')).load()), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('routine probe runs only an approved, readable definition and records its hash', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routine-test-'));
  const approvals = path.join(dir, 'approvals.json');
  const journal = new Journal(path.join(dir, 'journal.jsonl'));
  const routine = { automationId: 'r1', sequence: { sequenceId: 's1', nodes: [{ type: 'Alexa.Sound' }] } };
  const calls: unknown[] = [];
  const adapter = {
    routines: async () => [routine],
    runRoutine: async (device: string, definition: object) => { calls.push([device, definition]); return { status: 'response_received' as const, body: { success: true } }; },
  } as never;
  const base = { routineId: 'r1', device: 'dev', approvalFile: approvals, journal, now: new Date('2026-01-01T12:00:00Z') };

  assert.deepEqual(await runRoutineProbe(adapter, base), { ran: false, outcome: { status: 'not_dispatched' }, reason: 'not_approved' });

  const definitionHash = routineDefinitionHash(routine);
  const approval = (hash: string) => [{
    probe: 'routine-run', targets: ['r1'], argumentsHash: hashArguments({ routineId: 'r1', definitionHash: hash }),
    notBefore: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z',
  }];
  await fs.writeFile(approvals, JSON.stringify(approval('stale-hash')));
  const changed = await runRoutineProbe(adapter, base);
  assert.equal(changed.ran, false);
  assert.equal(calls.length, 0);

  await fs.writeFile(approvals, JSON.stringify(approval(definitionHash)));
  const ran = await runRoutineProbe(adapter, base);
  assert.equal(ran.ran, true);
  assert.equal(ran.outcome.status, 'accepted');
  assert.equal(ran.ran && ran.definitionHash, definitionHash);
  assert.equal(calls.length, 1);
  assert.equal((await journal.read()).length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('routine probe does not run when the definition cannot be read or is unknown', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routine-test-'));
  const journal = new Journal(path.join(dir, 'journal.jsonl'));
  const request = { routineId: 'r1', device: 'dev', approvalFile: path.join(dir, 'a.json'), journal };
  let ran = false;
  const make = (routines: () => Promise<unknown>) => ({ routines, runRoutine: async () => { ran = true; return { status: 'unknown' as const }; } }) as never;
  assert.equal((await runRoutineProbe(make(async () => { throw new Error('x'); }), request)).ran, false);
  assert.equal((await runRoutineProbe(make(async () => []), request)).ran, false);
  assert.equal((await runRoutineProbe(make(async () => [{ automationId: 'r1' }]), request)).ran, false);
  const lockRoutine = [{ automationId: 'r1', sequence: { sequenceId: 's', nodes: [{ type: 'Alexa.LockController' }] } }];
  const excluded = await runRoutineProbe(make(async () => lockRoutine), request);
  assert.equal(!excluded.ran && excluded.reason, 'excluded_class');
  assert.equal(ran, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('mutation probe enforces device class and approval, then verifies by readback', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mutation-test-'));
  const approvalFile = path.join(dir, 'approvals.json');
  const journal = new Journal(path.join(dir, 'journal.jsonl'));
  const parameters = [{ action: 'turnOn' }];
  const sent: unknown[] = [];
  const adapter = {
    controlDevice: async (id: string) => { sent.push(id); return { status: 'response_received' as const, body: { controlResponses: [{ entityId: id, code: 'SUCCESS' }] } }; },
    deviceState: async () => ({ deviceStates: [{ capabilityStates: [JSON.stringify({ namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON' })] }] }),
  } as never;
  const base = { entityId: 'e1', parameters, approvalFile, journal, now: new Date('2026-01-01T12:00:00Z'), expect: { namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON' } };

  assert.equal((await runMutationProbe(adapter, { ...base, descriptor: undefined })).ran, false);
  const lock = await runMutationProbe(adapter, { ...base, descriptor: { applianceTypes: ['SMARTLOCK'] } });
  assert.deepEqual(lock.outcome, { status: 'rejected' });
  const unapproved = await runMutationProbe(adapter, { ...base, descriptor: { applianceTypes: ['LIGHT'] } });
  assert.equal(!unapproved.ran && unapproved.reason, 'not_approved');
  assert.equal(sent.length, 0);

  await fs.writeFile(approvalFile, JSON.stringify([{
    probe: 'device-mutation', targets: ['e1'], argumentsHash: hashArguments(mutationArgs('e1', parameters)),
    notBefore: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z',
  }]));
  const result = await runMutationProbe(adapter, { ...base, descriptor: { applianceTypes: ['LIGHT'] } });
  assert.equal(result.ran && result.outcome.status, 'verified');
  assert.equal(result.ran && result.outcome.verification?.source, 'state_read');
  assert.equal(sent.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

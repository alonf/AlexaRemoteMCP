import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCli, type CliDeps } from '../src/cli.js';
import { hashArguments, Journal } from '../src/journal.js';
import { SessionManager } from '../src/session-manager.js';

const NOW = new Date('2026-01-01T12:00:00Z');

async function setup(approvals: Array<{ probe: string; targets: string[]; args: unknown }>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-test-'));
  const approvalFile = path.join(dir, 'approvals.json');
  await fs.writeFile(approvalFile, JSON.stringify(approvals.map((a) => ({
    probe: a.probe, targets: a.targets, argumentsHash: hashArguments(a.args),
    notBefore: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z',
  }))));
  const out: string[] = [];
  let connects = 0;
  let started = 0;
  const calls: string[] = [];
  const deps: CliDeps = {
    approvalFile,
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    snapshots: { load: async () => null, save: async () => undefined },
    manager: new SessionManager({ load: async () => null, save: async () => undefined, remove: async () => undefined }, {
      initialize: async () => ({}), refresh: async () => ({}),
    }),
    loginSetup: { start: async () => { started++; throw new Error('x'); } } as never,
    connect: async () => {
      connects++;
      return {
        adapter: {
          echoDevices: async () => { calls.push('echo'); return { devices: [{ deviceType: 'ECHO', serialNumber: 'REAL-SERIAL' }] }; },
          smartHomeDevices: async () => [],
          smartHomeGroups: async () => [],
          routines: async () => [],
        } as never,
        descriptorFor: async () => undefined,
      };
    },
    print: (text) => out.push(text),
    saveMapping: async () => undefined,
    now: () => NOW,
  };
  return { deps, out, calls, counts: () => ({ connects, started }), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('live commands without approvals dispatch nothing and never connect', async () => {
  const h = await setup([]);
  for (const argv of [['inventory'], ['state', 'x'], ['dnd-read'], ['dnd-apply', 'true', 'a'], ['dnd-restore'], ['routine', 'r', 'd'], ['mutate', 'e', '[]'], ['refresh']]) {
    assert.equal(await runCli(argv, h.deps), 2, argv.join(' '));
  }
  assert.equal(await runCli(['login', 'amazon.example'], h.deps), 2);
  assert.deepEqual(h.counts(), { connects: 0, started: 0 });
  assert.ok(h.out.every((line) => line.includes('not_dispatched')));
  await h.cleanup();
});

test('a probe approval alone is not enough without the session approval', async () => {
  const h = await setup([{ probe: 'inventory-read', targets: ['inventory'], args: {} }]);
  assert.equal(await runCli(['inventory'], h.deps), 2);
  assert.equal(h.counts().connects, 0);
  await h.cleanup();
});

test('approved inventory runs and the printed evidence contains no identifiers', async () => {
  const h = await setup([
    { probe: 'session-init', targets: ['session'], args: {} },
    { probe: 'inventory-read', targets: ['inventory'], args: {} },
  ]);
  assert.equal(await runCli(['inventory'], h.deps), 0);
  assert.equal(h.counts().connects, 1);
  assert.deepEqual(h.calls, ['echo']);
  assert.ok(!h.out.join('').includes('REAL-SERIAL'));
  await h.cleanup();
});

test('approval for different targets does not authorize a state read', async () => {
  const h = await setup([
    { probe: 'session-init', targets: ['session'], args: {} },
    { probe: 'state-read', targets: ['other'], args: { id: 'other' } },
  ]);
  assert.equal(await runCli(['state', 'wanted'], h.deps), 2);
  assert.equal(h.counts().connects, 0);
  await h.cleanup();
});

test('approval-template prints a hash for the owner to complete; login needs approval to start', async () => {
  const h = await setup([]);
  assert.equal(await runCli(['approval-template', 'state-read', 'abc', '{"id":"abc"}'], h.deps), 0);
  const [entry] = JSON.parse(h.out[0] ?? '[]') as Array<{ argumentsHash: string; probe: string }>;
  assert.equal(entry?.argumentsHash, hashArguments({ id: 'abc' }));
  assert.equal(entry?.probe, 'state-read');
  assert.equal(await runCli(['unknown-command'], h.deps), 2);
  await h.cleanup();
});

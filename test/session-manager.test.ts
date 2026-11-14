import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReauthenticationRequiredError, SessionManager } from '../src/session-manager.js';

test('concurrent initialization and refresh share one operation and persist once', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let loads = 0;
  let initializations = 0;
  let refreshes = 0;
  const saved: unknown[] = [];
  const manager = new SessionManager({
    async load() { loads++; return { version: 1 }; },
    async save(session) { saved.push(session); },
    async remove() {},
  }, {
    async initialize() { initializations++; await gate; return { version: 2 }; },
    async refresh() { refreshes++; return { version: 3 }; },
  });

  const callers = [manager.initialize(), manager.initialize(), manager.refresh()];
  release();
  await Promise.all(callers);
  assert.equal(loads, 1);
  assert.equal(initializations, 1);
  assert.equal(refreshes, 0);
  assert.deepEqual(saved, [{ version: 2 }]);

  await manager.refresh();
  assert.equal(refreshes, 1);
  assert.deepEqual(saved, [{ version: 2 }, { version: 3 }]);
});

test('concurrent refreshes join and upstream errors are not exposed', async () => {
  let refreshes = 0;
  const manager = new SessionManager({
    async load() { return { version: 1 }; },
    async save() { assert.fail('failure must not be persisted'); },
    async remove() {},
  }, {
    async initialize() { assert.fail('unexpected initialization'); },
    async refresh() { refreshes++; throw new Error('private upstream content'); },
  });
  const results = await Promise.allSettled([manager.refresh(), manager.refresh()]);
  assert.equal(refreshes, 1);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal((result.reason as Error).message, 'Session operation failed');
  }
});

test('revocation requires reauthentication and stops further automatic attempts', async () => {
  let calls = 0;
  let stored: unknown | null = { version: 1 };
  const manager = new SessionManager({
    async load() { return stored; },
    async save(session) { stored = session; },
    async remove() { stored = null; },
  }, {
    async initialize() { calls++; throw new ReauthenticationRequiredError(); },
    async refresh() { calls++; throw new ReauthenticationRequiredError(); },
  });
  await assert.rejects(manager.initialize());
  assert.equal(manager.health, 'reauthentication_required');
  await assert.rejects(manager.refresh());
  assert.equal(calls, 1);
  await manager.logout();
  assert.equal(manager.health, 'unauthenticated');
  assert.equal(stored, null);
});

test('failed persistence is not reported healthy and logout waits for refresh', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let removed = false;
  const manager = new SessionManager({
    async load() { return { version: 1 }; },
    async save() { throw new Error('private storage error'); },
    async remove() { removed = true; },
  }, {
    async initialize(session) { return session; },
    async refresh(session) { await gate; return session; },
  });
  const refresh = manager.refresh();
  release();
  await assert.rejects(refresh);
  assert.equal(manager.health, 'persistence_failed');

  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const second = new SessionManager({
    async load() { return { version: 1 }; },
    async save() { assert.equal(removed, false); },
    async remove() { removed = true; },
  }, {
    async initialize(session) { return session; },
    async refresh(session) { await secondGate; return session; },
  });
  const inFlight = second.refresh();
  const logout = second.logout();
  await assert.rejects(second.refresh(), { message: 'Session operation unavailable' });
  releaseSecond();
  await Promise.all([inFlight, logout]);
  assert.equal(second.health, 'unauthenticated');
  assert.equal(removed, true);
});

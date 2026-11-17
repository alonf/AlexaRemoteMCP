import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Outcome } from '../src/outcomes.js';
import { TargetOrdering } from '../src/target-ordering.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
const accepted: Outcome = { status: 'accepted' };

test('a newer command submitted while an older one is dispatching runs after it, in both orders', async () => {
  for (const [first, second] of [['on', 'off'], ['off', 'on']] as const) {
    const ordering = new TargetOrdering();
    const sent: string[] = [];
    const gate = deferred();
    const started = deferred();
    const a = ordering.run(['t'], (c) => c.step(async () => { sent.push(first); started.resolve(); await gate.promise; return accepted; }));
    await started.promise;
    const b = ordering.run(['t'], (c) => c.step(async () => { sent.push(second); return accepted; }));
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(sent, [first, second]);
    assert.equal(ra.status, 'accepted');
    assert.equal(rb.status, 'accepted');
  }
});

test('back-to-back commands: only the newest dispatches', async () => {
  const ordering = new TargetOrdering();
  const sent: string[] = [];
  const a = ordering.run(['t'], (c) => c.step(async () => { sent.push('a'); return accepted; }));
  const b = ordering.run(['t'], (c) => c.step(async () => { sent.push('b'); return accepted; }));
  const results = await Promise.all([a, b]);
  assert.deepEqual(sent, ['b']);
  assert.deepEqual(results.map((r) => r.status), ['superseded', 'accepted']);
});

test('an operation queued behind an in-flight one but overtaken never dispatches', async () => {
  const ordering = new TargetOrdering();
  const sent: string[] = [];
  const gate = deferred();
  const started = deferred();
  const a = ordering.run(['t'], (c) => c.step(async () => { sent.push('a'); started.resolve(); await gate.promise; return accepted; }));
  await started.promise;
  const b = ordering.run(['t'], (c) => c.step(async () => { sent.push('b'); return accepted; }));
  const c3 = ordering.run(['t'], (c) => c.step(async () => { sent.push('c'); return accepted; }));
  gate.resolve();
  const results = await Promise.all([a, b, c3]);
  assert.deepEqual(sent, ['a', 'c']);
  assert.deepEqual(results.map((r) => r.status), ['accepted', 'superseded', 'accepted']);
});

test('a verification or retry step after a newer command is skipped', async () => {
  const ordering = new TargetOrdering();
  const calls: string[] = [];
  const dispatched = deferred();
  const proceed = deferred();
  const a = ordering.run(['t'], async (c) => {
    await c.step(async () => { calls.push('dispatch'); return accepted; });
    dispatched.resolve();
    await proceed.promise;
    const verify = await c.step(async () => { calls.push('verify'); return { status: 'verified' }; });
    return verify;
  });
  await dispatched.promise;
  const b = ordering.run(['t'], (c) => c.step(async () => { calls.push('newer'); return accepted; }));
  proceed.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 'superseded');
  assert.equal(rb.status, 'accepted');
  assert.deepEqual(calls, ['dispatch', 'newer']);
});

test('a command arriving after the older one finished does not supersede it', async () => {
  const ordering = new TargetOrdering();
  const a = await ordering.run(['t'], (c) => c.step(async () => accepted));
  const b = await ordering.run(['t'], (c) => c.step(async () => accepted));
  assert.equal(a.status, 'accepted');
  assert.equal(b.status, 'accepted');
});

test('different targets do not order against each other', async () => {
  const ordering = new TargetOrdering();
  const gate = deferred();
  const sent: string[] = [];
  const a = ordering.run(['t1'], (c) => c.step(async () => { sent.push('t1'); await gate.promise; return accepted; }));
  const b = await ordering.run(['t2'], (c) => c.step(async () => { sent.push('t2'); return accepted; }));
  assert.equal(b.status, 'accepted');
  gate.resolve();
  assert.equal((await a).status, 'accepted');
  assert.deepEqual(sent, ['t1', 't2']);
});

test('a failing operation releases the target for the next one', async () => {
  const ordering = new TargetOrdering();
  await assert.rejects(ordering.run(['t'], async () => { throw new Error('boom'); }));
  assert.equal((await ordering.run(['t'], (c) => c.step(async () => accepted))).status, 'accepted');
});

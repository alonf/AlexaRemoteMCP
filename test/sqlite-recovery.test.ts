import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteJournal } from '../src/sqlite-journal.js';
import { FakeAlexa } from './support/fake-alexa.js';

const ctx = { principal: 'p1', client: 'c1' };

test('restart after dispatch makes the record unknown, visible to its principal, with no Amazon call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-'));
  const path = join(dir, 'j.db');
  try {
    const alexa = new FakeAlexa();
    const before = new SqliteJournal(path);
    const opened = await before.open(ctx, 'control', { v: 1 }, ['t1']);
    assert.equal(opened.kind, 'created');
    const finished = await before.open(ctx, 'control', { v: 2 }, ['t2']);
    if (finished.kind === 'created') await before.end(finished.record.operationId, { status: 'accepted' });
    before.close(); // crash window: the first record never got an outcome

    const after = new SqliteJournal(path);
    assert.equal(after.recoverOnStart(), 1);
    assert.equal(after.recoverOnStart(), 0);
    if (opened.kind !== 'created') throw new Error('unreachable');
    assert.deepEqual((await after.get('p1', opened.record.operationId))?.outcome, { status: 'unknown' });
    if (finished.kind === 'created') {
      assert.deepEqual((await after.get('p1', finished.record.operationId))?.outcome, { status: 'accepted' });
    }
    assert.equal(alexa.calls.length, 0);
    after.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a repeated operation key returns the original record and does not create another', async () => {
  const j = new SqliteJournal(':memory:');
  const first = await j.open({ ...ctx, operationKey: 'k1' }, 'control', { v: 1 }, ['t1']);
  assert.equal(first.kind, 'created');
  const again = await j.open({ ...ctx, operationKey: 'k1' }, 'control', { v: 1 }, ['t1']);
  assert.equal(again.kind, 'replayed');
  if (first.kind === 'created' && again.kind === 'replayed') {
    assert.equal(again.record.operationId, first.record.operationId);
  }
  assert.equal((await j.read()).length, 1);
  j.close();
});

test('the same key with different arguments is a conflict, and keys are per principal', async () => {
  const j = new SqliteJournal(':memory:');
  await j.open({ ...ctx, operationKey: 'k1' }, 'control', { v: 1 }, ['t1']);
  assert.equal((await j.open({ ...ctx, operationKey: 'k1' }, 'control', { v: 2 }, ['t1'])).kind, 'key_conflict');
  const other = await j.open({ principal: 'p2', client: 'c1', operationKey: 'k1' }, 'control', { v: 1 }, ['t1']);
  assert.equal(other.kind, 'created');
  j.close();
});

test('another principal cannot see the operation, and records hold no payload', async () => {
  const j = new SqliteJournal(':memory:');
  const created = await j.open(ctx, 'control', { secretArgument: 'x-payload' }, ['t1']);
  if (created.kind !== 'created') throw new Error('unreachable');
  const id = created.record.operationId;
  assert.equal(await j.get('p2', id), undefined);
  assert.equal(await j.get('p2', 'does-not-exist'), undefined);
  assert.equal((await j.get('p1', id))?.operationId, id);
  assert.ok(!JSON.stringify(await j.read()).includes('x-payload'));
  j.close();
});

test('keys survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keys-'));
  const path = join(dir, 'j.db');
  try {
    const a = new SqliteJournal(path);
    await a.open({ ...ctx, operationKey: 'k1' }, 'control', { v: 1 }, ['t1']);
    a.close();
    const b = new SqliteJournal(path);
    b.recoverOnStart();
    const again = await b.open({ ...ctx, operationKey: 'k1' }, 'control', { v: 1 }, ['t1']);
    assert.equal(again.kind, 'replayed');
    if (again.kind === 'replayed') assert.deepEqual(again.record.outcome, { status: 'unknown' });
    b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { journaledDispatch } from '../src/journal.js';
import { SqliteJournal } from '../src/sqlite-journal.js';

const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-'));
  return { path: join(dir, 'j.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test('the record exists before dispatch and is completed after', async () => {
  const j = new SqliteJournal(':memory:');
  let seenDuringDispatch: unknown;
  const result = await journaledDispatch(j, 'control', { v: 1 }, ['t1'], async () => {
    seenDuringDispatch = (await j.read())[0];
    return { status: 'accepted' };
  });
  assert.equal((seenDuringDispatch as { outcome?: unknown }).outcome, undefined);
  const [record] = await j.read();
  assert.equal(record?.operationId, result.operationId);
  assert.deepEqual(record?.outcome, { status: 'accepted' });
  assert.deepEqual(record?.targets, ['t1']);
  j.close();
});

test('a failed journal write means nothing is dispatched', async () => {
  const j = new SqliteJournal(':memory:');
  j.close();
  let dispatched = false;
  const result = await journaledDispatch(j, 'control', {}, ['t1'], async () => {
    dispatched = true;
    return { status: 'accepted' };
  });
  assert.equal(dispatched, false);
  assert.deepEqual(result.outcome, { status: 'not_dispatched' });
});

test('a dispatch that throws is recorded unknown', async () => {
  const j = new SqliteJournal(':memory:');
  const result = await journaledDispatch(j, 'control', {}, ['t1'], async () => { throw new Error('boom'); });
  assert.deepEqual(result.outcome, { status: 'unknown' });
  assert.deepEqual((await j.read())[0]?.outcome, { status: 'unknown' });
  j.close();
});

test('records survive reopen and an outcome is written only once', async () => {
  const { path, cleanup } = tempDb();
  try {
    const a = new SqliteJournal(path);
    const done = await a.begin('control', {}, ['t1']);
    await a.end(done.operationId, { status: 'verified' });
    await a.end(done.operationId, { status: 'failed' } as never);
    await a.begin('control', {}, ['t2']);
    a.close();
    const b = new SqliteJournal(path);
    const records = await b.recover();
    assert.equal(records.length, 2);
    assert.deepEqual(records[0]?.outcome, { status: 'verified' });
    assert.deepEqual(records[1]?.outcome, { status: 'unknown' });
    b.close();
  } finally { cleanup(); }
});

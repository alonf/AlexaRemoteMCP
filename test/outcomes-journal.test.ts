import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkApproval } from '../src/approvals.js';
import { excludedClass } from '../src/excluded-devices.js';
import { Journal, hashArguments, journaledDispatch } from '../src/journal.js';
import { normalizeDeviceControlBody, normalizeSimpleBody, normalizeWrite } from '../src/outcomes.js';
import { Labeler, sanitizeEvidence } from '../src/sanitizer.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'proof-test-'));
}

test('device control normalizer reports per-device success, failure and mixed results', () => {
  const ok = { controlResponses: [{ entityId: 'a', code: 'SUCCESS' }, { entityId: 'b', code: 'SUCCESS' }] };
  assert.equal(normalizeDeviceControlBody(ok, ['a', 'b']).status, 'accepted');
  const mixed = { controlResponses: [{ entityId: 'a', code: 'SUCCESS' }], errors: [{ entity: { entityId: 'b' }, code: 'ENDPOINT_UNREACHABLE' }] };
  const outcome = normalizeDeviceControlBody(mixed, ['a', 'b']);
  assert.equal(outcome.status, 'partially_applied');
  assert.deepEqual(outcome.targets, [{ target: 'a', status: 'accepted' }, { target: 'b', status: 'failed' }]);
  const none = { errors: [{ entity: { entityId: 'a' } }, { entity: { entityId: 'b' } }] };
  assert.equal(normalizeDeviceControlBody(none, ['a', 'b']).status, 'failed');
  assert.equal(normalizeDeviceControlBody({ controlResponses: [{ entityId: 'a', code: 'SUCCESS' }] }, ['a', 'b']).status, 'partially_applied');
});

test('normalizers treat empty, malformed and non-object bodies as unknown, never accepted', () => {
  for (const body of [undefined, null, '', '<html>', 7, [], { controlResponses: 'x' }, { controlResponses: [null] }]) {
    assert.equal(normalizeDeviceControlBody(body, ['a']).status, 'unknown', JSON.stringify(body));
  }
  for (const body of [undefined, null, '', 'ok', 7]) assert.equal(normalizeSimpleBody(body, 't').status, 'unknown');
  assert.equal(normalizeSimpleBody({ success: false }, 't').status, 'failed');
  assert.equal(normalizeSimpleBody({ success: true }, 't').status, 'accepted');
});

test('write responses map transport outcomes without upgrading certainty', () => {
  const interpret = () => ({ status: 'accepted' as const });
  assert.deepEqual(normalizeWrite({ status: 'unknown' }, interpret), { status: 'unknown' });
  assert.deepEqual(normalizeWrite({ status: 'not_dispatched' }, interpret), { status: 'not_dispatched' });
  assert.equal(normalizeWrite({ status: 'response_received', body: {} }, interpret).status, 'accepted');
});

test('journal persists before dispatch; a crash leaves the record unknown and nothing is replayed', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'journal.jsonl');
  const journal = new Journal(file);
  let seenBeforeDispatch = 0;
  const done = await journaledDispatch(journal, 'op', { a: 1 }, ['t'], async () => {
    seenBeforeDispatch = (await journal.read()).length;
    return { status: 'accepted' };
  });
  assert.equal(seenBeforeDispatch, 1);
  assert.equal(done.outcome.status, 'accepted');

  // Simulated crash: the record was written but no outcome ever followed.
  const crashed = await journal.begin('op', { a: 2 }, ['t']);
  await fs.appendFile(file, '{"type":"end","operationId":"torn"');
  const records = await new Journal(file).recover();
  const orphan = records.find((r) => r.operationId === crashed.operationId);
  assert.equal(orphan?.outcome?.status, 'unknown');
  assert.equal(orphan?.argumentsHash, hashArguments({ a: 2 }));
  assert.equal(records.find((r) => r.operationId === done.operationId)?.outcome?.status, 'accepted');
  await fs.rm(dir, { recursive: true, force: true });
});
test('a failed journal write prevents dispatch', async () => {
  const dir = await tempDir();
  const journal = new Journal(path.join(dir, 'missing-directory', 'journal.jsonl'));
  let dispatched = false;
  const result = await journaledDispatch(journal, 'op', {}, ['t'], async () => { dispatched = true; return { status: 'accepted' }; });
  assert.equal(dispatched, false);
  assert.deepEqual(result.outcome, { status: 'not_dispatched' });
  await fs.rm(dir, { recursive: true, force: true });
});

test('approvals must exist, match exactly and be current', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'approvals.json');
  const request = { probe: 'dnd-write', targets: ['t1', 't2'], args: { enabled: true } };
  assert.deepEqual(await checkApproval(file, request), { approved: false, reason: 'missing' });

  const approval = {
    probe: 'dnd-write', targets: ['t2', 't1'], argumentsHash: hashArguments(request.args),
    notBefore: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z',
  };
  await fs.writeFile(file, JSON.stringify([approval]));
  const inside = new Date('2026-01-01T12:00:00Z');
  assert.deepEqual(await checkApproval(file, request, inside), { approved: true });
  assert.deepEqual(await checkApproval(file, request, new Date('2026-01-02T00:00:00Z')), { approved: false, reason: 'expired' });
  assert.deepEqual(await checkApproval(file, request, new Date('2025-12-31T00:00:00Z')), { approved: false, reason: 'expired' });
  assert.deepEqual(await checkApproval(file, { ...request, targets: ['t1'] }, inside), { approved: false, reason: 'mismatched' });
  assert.deepEqual(await checkApproval(file, { ...request, args: { enabled: false } }, inside), { approved: false, reason: 'mismatched' });
  assert.deepEqual(await checkApproval(file, { ...request, probe: 'other' }, inside), { approved: false, reason: 'missing' });
  await fs.writeFile(file, '{not json');
  assert.deepEqual(await checkApproval(file, request, inside), { approved: false, reason: 'unreadable' });
  await fs.rm(dir, { recursive: true, force: true });
});

test('excluded device classes are detected from structural type fields', () => {
  assert.ok(excludedClass({ applianceTypes: ['SMARTLOCK'] }));
  assert.ok(excludedClass({ entityType: 'THERMOSTAT' }));
  assert.ok(excludedClass({ capabilities: [{ interface: 'Alexa.LockController' }] }));
  assert.ok(excludedClass({ applianceTypes: ['GARAGE_DOOR'] }));
  assert.equal(excludedClass({ applianceTypes: ['LIGHT'], capabilities: [{ interface: 'Alexa.PowerController' }] }), undefined);
});

test('evidence sanitizer replaces names and identifiers and keeps structure', () => {
  const labeler = new Labeler();
  const input = {
    friendlyName: 'Real Kitchen Lamp',
    entityId: 'AAA_Real_00:11:22',
    deviceType: 'ECHO_TYPE',
    count: 3,
    notes: 'free text with private household detail',
    'SERIAL123': { name: 'Real Kitchen Lamp', status: 'ok' },
    items: [{ serialNumber: 'SER-1' }, { serialNumber: 'SER-1' }, { serialNumber: 'SER-2' }],
  };
  const output = JSON.stringify(sanitizeEvidence(input, labeler));
  for (const secret of ['Real Kitchen', 'AAA_Real', 'SERIAL123', 'SER-1', 'SER-2', 'private household']) {
    assert.ok(!output.includes(secret), secret);
  }
  const parsed = sanitizeEvidence(input, labeler) as { items: Array<{ serialNumber: string }>; deviceType: string; count: number };
  assert.equal(parsed.items[0]?.serialNumber, parsed.items[1]?.serialNumber);
  assert.notEqual(parsed.items[0]?.serialNumber, parsed.items[2]?.serialNumber);
  assert.equal(parsed.deviceType, 'ECHO_TYPE');
  assert.equal(parsed.count, 3);
  assert.equal(labeler.mapping()['SER-1'], parsed.items[0]?.serialNumber);
});

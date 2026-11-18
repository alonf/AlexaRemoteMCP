import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/no-network.js';
import { ApprovalSigner } from '../src/approval.js';
import { SpeechService, type SpeakPolicy } from '../src/speech-service.js';
import { SqliteJournal } from '../src/sqlite-journal.js';
import type { WriteResponse } from '../src/write-outcome.js';
import { FakeAlexa } from './support/fake-alexa.js';

const echo = {
  devices: [
    { accountName: 'Kitchen Echo', serialNumber: 'SER-KITCHEN-1', online: true },
    { accountName: 'Bedroom Echo', serialNumber: 'SER-BED-2', online: false },
    { accountName: 'Hall Echo', serialNumber: 'SER-HALL-3', online: true },
  ],
};

function start(policy: SpeakPolicy, write?: () => WriteResponse, urgent: { urgentReasons?: string[]; urgentLimit?: number } = {}) {
  const adapter = new FakeAlexa({ echo, ...(write ? { write } : {}) } as never);
  const clock = { at: new Date('2026-01-01T10:00:00Z') };
  const journal = new SqliteJournal(':memory:');
  const service = new SpeechService(adapter, journal, { policy, targets: ['Kitchen Echo', 'Bedroom Echo'], ...urgent }, new ApprovalSigner(Buffer.alloc(32, 7)), () => clock.at);
  const ctx = { principal: 'owner', client: 'chatgpt' };
  const say = (text: unknown, devices: string[], mode: 'speak' | 'announce' = 'speak', confirmation?: { approvalId?: string; confirmed?: boolean }, reason?: string) =>
    service.say(ctx, { text, mode, devices, ...(reason ? { reason } : {}) }, { canElicit: false, ...(confirmation ? { confirmation } : {}) });
  return { adapter, clock, service, journal, say };
}

test('speakers lists only allowed devices, without serial numbers', async () => {
  const s = start('allow');
  const speakers = await s.service.speakers();
  assert.deepEqual(speakers, [{ name: 'Kitchen Echo', online: true }, { name: 'Bedroom Echo', online: false }]);
  assert.doesNotMatch(JSON.stringify(speakers), /SER-/);
  assert.deepEqual(await start('off').service.speakers(), []);
});

test('unknown and disallowed targets are refused identically', async () => {
  const s = start('allow');
  const missing = await s.say('hello', ['Nowhere Echo']);
  const forbidden = await s.say('hello', ['Hall Echo']);
  assert.deepEqual(missing, { status: 'rejected', reason: 'target_not_allowed' });
  assert.deepEqual(forbidden, missing);
  assert.equal(s.adapter.writes.length, 0);
});

test('markup, empty and over-long text are refused; offline devices too', async () => {
  const s = start('allow');
  for (const bad of ['<speak>hi</speak>', '   ', 'x'.repeat(251), 42]) {
    assert.deepEqual(await s.say(bad, ['Kitchen Echo']), { status: 'rejected', reason: 'invalid_text' });
  }
  assert.deepEqual(await s.say('hi', ['Bedroom Echo']), { status: 'rejected', reason: 'device_offline' });
  assert.equal(s.adapter.writes.length, 0);
});

test('with policy off nothing is spoken', async () => {
  const s = start('off');
  assert.deepEqual(await s.say('hi', ['Kitchen Echo']), { status: 'rejected', reason: 'speech_off' });
});

test('allow speaks once and reports accepted, with a record free of text and names', async () => {
  const s = start('allow', () => ({ status: 'response_received', body: '' }));
  const reply = await s.say('secret phrase', ['Kitchen Echo']);
  assert.equal(reply.status, 'accepted');
  assert.deepEqual(s.adapter.writes.map((w) => w.method), ['speak']);
  const rows = JSON.stringify((s.journal as unknown as { db: { prepare(q: string): { all(): unknown[] } } }).db.prepare('SELECT * FROM operations').all());
  assert.doesNotMatch(rows, /secret phrase|Kitchen|SER-KITCHEN/);
});

test('an upstream refusal is a failure, a missing response is unknown', async () => {
  const refused = start('allow', () => ({ status: 'response_received', body: { errors: [{}] } }));
  assert.equal((await refused.say('hi', ['Kitchen Echo'])).status, 'failed');
  const unknown = start('allow', () => ({ status: 'unknown' }));
  assert.equal((await unknown.say('hi', ['Kitchen Echo'])).status, 'unknown');
});

test('approve asks first; approval is bound to the text and works once', async () => {
  const s = start('approve', () => ({ status: 'response_received', body: '' }));
  const ask = await s.say('hello there', ['Kitchen Echo']);
  assert.equal(ask.status, 'confirmation_required');
  assert.match(ask.question ?? '', /say "hello there" on Kitchen Echo/i);
  assert.equal(s.adapter.writes.length, 0);

  s.clock.at = new Date(s.clock.at.getTime() + 5000);
  assert.deepEqual(await s.say('different text', ['Kitchen Echo'], 'speak', { approvalId: ask.approvalId as string, confirmed: true }), { status: 'rejected', reason: 'approval_invalid' });
  assert.equal(s.adapter.writes.length, 0);

  const second = await s.say('hello there', ['Kitchen Echo']);
  s.clock.at = new Date(s.clock.at.getTime() + 5000);
  const done = await s.say('hello there', ['Kitchen Echo'], 'speak', { approvalId: second.approvalId as string, confirmed: true });
  assert.equal(done.status, 'accepted');
  assert.deepEqual(await s.say('hello there', ['Kitchen Echo'], 'speak', { approvalId: second.approvalId as string, confirmed: true }), { status: 'rejected', reason: 'approval_invalid' });
  assert.equal(s.adapter.writes.length, 1);
});

test('the sixth text within ten minutes is refused, and the window reopens', async () => {
  const s = start('allow', () => ({ status: 'response_received', body: '' }));
  for (let i = 0; i < 5; i += 1) assert.equal((await s.say(`hi ${i}`, ['Kitchen Echo'])).status, 'accepted');
  assert.deepEqual(await s.say('hi 6', ['Kitchen Echo']), { status: 'rejected', reason: 'rate_limited' });
  s.clock.at = new Date(s.clock.at.getTime() + 11 * 60_000);
  assert.equal((await s.say('hi 7', ['Kitchen Echo'])).status, 'accepted');
});

const ok = () => ({ status: 'response_received', body: '' }) as WriteResponse;

test('a listed urgent reason skips approval, rings the doorbell and records no text', async () => {
  const s = start('approve', ok, { urgentReasons: ['emergency', 'family'] });
  const rung: string[] = [];
  s.service.onUrgent = (reason) => rung.push(reason);
  const reply = await s.say('urgent secret text', ['Kitchen Echo'], 'speak', undefined, 'Emergency');
  assert.equal(reply.status, 'accepted');
  assert.deepEqual(rung, ['emergency']);
  const rows = JSON.stringify((s.journal as unknown as { db: { prepare(q: string): { all(): unknown[] } } }).db.prepare('SELECT * FROM operations').all());
  assert.match(rows, /speech-urgent:emergency/);
  assert.doesNotMatch(rows, /urgent secret text|Kitchen|SER-KITCHEN/);
});

test('an unlisted reason or an empty list still asks for approval', async () => {
  const listed = start('approve', ok, { urgentReasons: ['emergency'] });
  assert.equal((await listed.say('hi', ['Kitchen Echo'], 'speak', undefined, 'because')).status, 'confirmation_required');
  const none = start('approve', ok);
  assert.equal((await none.say('hi', ['Kitchen Echo'], 'speak', undefined, 'emergency')).status, 'confirmation_required');
  assert.equal(listed.adapter.writes.length + none.adapter.writes.length, 0);
});

test('urgent calls still obey target, text and offline checks', async () => {
  const s = start('approve', ok, { urgentReasons: ['emergency'] });
  assert.deepEqual(await s.say('hi', ['Hall Echo'], 'speak', undefined, 'emergency'), { status: 'rejected', reason: 'target_not_allowed' });
  assert.deepEqual(await s.say('<b>', ['Kitchen Echo'], 'speak', undefined, 'emergency'), { status: 'rejected', reason: 'invalid_text' });
  assert.deepEqual(await s.say('hi', ['Bedroom Echo'], 'speak', undefined, 'emergency'), { status: 'rejected', reason: 'device_offline' });
  assert.equal(s.adapter.writes.length, 0);
});

test('the urgent limit is separate and never falls back to speaking', async () => {
  const s = start('allow', ok, { urgentReasons: ['emergency'], urgentLimit: 2 });
  assert.equal((await s.say('a', ['Kitchen Echo'], 'speak', undefined, 'emergency')).status, 'accepted');
  assert.equal((await s.say('b', ['Kitchen Echo'], 'speak', undefined, 'emergency')).status, 'accepted');
  assert.deepEqual(await s.say('c', ['Kitchen Echo'], 'speak', undefined, 'emergency'), { status: 'rejected', reason: 'rate_limited' });
  assert.equal((await s.say('plain', ['Kitchen Echo'])).status, 'accepted');
  assert.equal(s.adapter.writes.length, 3);
});

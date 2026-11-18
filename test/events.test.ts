import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import './support/no-network.js';
import { Delivery } from '../src/events/delivery.js';
import { SubscriptionStore } from '../src/events/subscriptions.js';
import type { CallbackTransport } from '../src/events/callback-transport.js';
import { createHttpServer } from '../src/http-server.js';
import { FakeAlexa } from './support/fake-alexa.js';

const SECRET = `whsec_${Buffer.alloc(32, 5).toString('base64')}`;
const URL_OK = 'https://connectors.api.openai.com/hook';

interface Sent { url: string; headers: Record<string, string>; body: string }

function setup(answer?: (sent: Sent) => { status: number; body: string }) {
  const sent: Sent[] = [];
  const transport: CallbackTransport = async (request) => {
    const item = { url: request.url.href, headers: request.headers, body: request.body };
    sent.push(item);
    return answer ? answer(item) : { status: 200, body: JSON.stringify({ challenge: (JSON.parse(request.body) as { challenge?: string }).challenge }) };
  };
  const store = new SubscriptionStore(':memory:', Buffer.alloc(32, 9));
  const delivery = new Delivery({ store, transport, allowedHosts: ['connectors.api.openai.com'], sleep: async () => undefined, log: () => undefined });
  return { sent, store, delivery };
}

async function serve(delivery: Delivery) {
  const server = createHttpServer({
    adapter: new FakeAlexa({ devices: { smarthomeDevices: [] } }),
    sessionHealth: () => 'usable',
    authenticate: async (request) => {
      const token = request.headers.authorization?.replace('Bearer ', '');
      return token ? { token, clientId: token, scopes: token === 'noread' ? [] : ['read'], extra: { principal: token } } : undefined;
    },
    allowedOrigins: [],
    resourceMetadataUrl: 'https://mcp.example/.well-known/oauth-protected-resource',
    events: delivery,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>, token = 'chatgpt') => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    return await response.json() as { result?: Record<string, unknown>; error?: { code: number; data?: { reason?: string } } };
  };
  return { rpc, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

const subscribe = (url = URL_OK, name = 'approval.requested') => ({ name, delivery: { mode: 'webhook', url, secret: SECRET } });

test('events/list names the doorbell events', async () => {
  const { delivery } = setup();
  const s = await serve(delivery);
  try {
    const out = await s.rpc('events/list', {});
    assert.deepEqual((out.result?.events as Array<{ name: string }>).map((e) => e.name), ['approval.requested', 'session.attention', 'action.completed', 'speech.urgent']);
  } finally { await s.stop(); }
});

test('subscribe verifies the callback, delivers a signed content-free event, and only the owner can unsubscribe', async () => {
  const { delivery, sent } = setup();
  const s = await serve(delivery);
  try {
    const out = await s.rpc('events/subscribe', subscribe());
    assert.equal(typeof out.result?.id, 'string', JSON.stringify(out));
    assert.match(sent[0]?.headers['webhook-signature'] ?? '', /^v1,/);

    delivery.publish('approval.requested', { summary: 'turn on "Boiler"' });
    await delivery.idle();
    const event = sent[1];
    assert.ok(event);
    assert.match(event.headers['webhook-signature'] ?? '', /^v1,/);
    const body = JSON.parse(event.body) as { name: string; data: Record<string, unknown> };
    assert.equal(body.name, 'approval.requested');
    assert.deepEqual(Object.keys(body.data), ['summary']);

    await s.rpc('events/unsubscribe', { id: out.result?.id }, 'someone-else');
    assert.equal(delivery['options'].store.active('approval.requested', Date.now()).length, 1);
    await s.rpc('events/unsubscribe', { id: out.result?.id });
    assert.equal(delivery['options'].store.active('approval.requested', Date.now()).length, 0);
  } finally { await s.stop(); }
});

test('subscribe refuses other hosts, plain http, bad secrets and clients without the read scope', async () => {
  const { delivery, sent } = setup();
  const s = await serve(delivery);
  try {
    for (const url of ['https://evil.example/hook', 'http://connectors.api.openai.com/hook', 'https://user:pw@connectors.api.openai.com/hook']) {
      const out = await s.rpc('events/subscribe', subscribe(url));
      assert.ok(out.error, url);
    }
    const badSecret = await s.rpc('events/subscribe', { ...subscribe(), delivery: { mode: 'webhook', url: URL_OK, secret: 'nope' } });
    assert.ok(badSecret.error);
    assert.ok((await s.rpc('events/subscribe', subscribe(), 'noread')).error);
    assert.equal(sent.length, 0);
  } finally { await s.stop(); }
});

test('a callback that does not echo the challenge is refused with -32015', async () => {
  const { delivery } = setup(() => ({ status: 200, body: '{}' }));
  const s = await serve(delivery);
  try {
    const out = await s.rpc('events/subscribe', subscribe());
    assert.equal(out.error?.code, -32015);
    assert.equal(out.error?.data?.reason, 'challenge_failed');
  } finally { await s.stop(); }
});

test('a failing callback is retried with the same event id; 410 ends the subscription', async () => {
  let failures = 2;
  const { delivery, sent, store } = setup((item) => {
    const body = JSON.parse(item.body) as { type?: string; challenge?: string };
    if (body.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
    return failures-- > 0 ? { status: 503, body: '' } : { status: 200, body: '' };
  });
  const s = await serve(delivery);
  try {
    await s.rpc('events/subscribe', subscribe());
    delivery.publish('approval.requested', { summary: 'x' });
    await delivery.idle();
    const ids = sent.slice(1).map((item) => item.headers['webhook-id']);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 1);

    const gone = setup((item) => (JSON.parse(item.body).type === 'verification' ? { status: 200, body: item.body.replace(/.*"challenge":"([^"]+)".*/, '{"challenge":"$1"}') } : { status: 410, body: '' }));
    const g = await serve(gone.delivery);
    try {
      await g.rpc('events/subscribe', subscribe());
      gone.delivery.publish('approval.requested', {});
      await gone.delivery.idle();
      assert.equal(gone.store.active('approval.requested', Date.now()).length, 0);
    } finally { await g.stop(); }
  } finally { await s.stop(); store.close(); }
});


test('an approval request rings the doorbell once with only the human summary', async () => {
  const { parseActionPolicy } = await import('../src/action-policy.js');
  const { ApprovalSigner } = await import('../src/approval.js');
  const { MutationService } = await import('../src/mutation-service.js');
  const { SqliteJournal } = await import('../src/sqlite-journal.js');
  const adapter = new FakeAlexa({ devices: { smarthomeDevices: [{ applianceId: 'h-1', friendlyName: 'Floor heating', applianceTypes: ['HEATER'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] }] } });
  const mutations = new MutationService(
    adapter, new SqliteJournal(':memory:'), { allowedTargets: new Set(['*']), modes: parseActionPolicy('heater=approve') },
    undefined, [], async () => undefined, undefined, new ApprovalSigner(Buffer.alloc(32, 7)),
  );
  const rung: string[] = [];
  mutations.onApprovalRequested = (summary) => rung.push(summary);
  const context = { principal: 'p', client: 'c' };
  const reply = await mutations.execute(context, 'h-1', { kind: 'power', on: true } as never, { canElicit: true });
  assert.equal(rung.length, 1, JSON.stringify(reply));
  assert.match(rung[0] ?? '', /Floor heating/);
  assert.doesNotMatch(rung[0] ?? '', /approvalId|requestState/);
});



test('signatures are HMAC-SHA256 over id.timestamp.body, and callback addresses must be public', async () => {
  const { createHmac } = await import('node:crypto');
  const { signedHeaders, signingKeyOf } = await import('../src/events/webhook-signature.js');
  const { isPublicAddress } = await import('../src/events/callback-transport.js');
  const key = signingKeyOf(SECRET);
  assert.ok(key);
  const headers = signedHeaders(key, 'msg_1', 1_700_000_000_000, '{"a":1}', 'sub_1');
  assert.equal(headers['webhook-timestamp'], '1700000000');
  assert.equal(headers['webhook-signature'], `v1,${createHmac('sha256', key).update('msg_1.1700000000.{"a":1}').digest('base64')}`);
  assert.equal(signingKeyOf('whsec_short'), undefined);
  for (const bad of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(isPublicAddress(bad), false, bad);
  assert.equal(isPublicAddress('8.8.8.8'), true);
});

test('session attention fires once per transition into a needs-action state', async () => {
  const { healthWatcher } = await import('../src/events/health-watch.js');
  const seen: string[] = [];
  const watch = healthWatcher('usable', (health) => seen.push(health));
  for (const health of ['usable', 'reauthentication_required', 'reauthentication_required', 'usable', 'persistence_failed', 'temporarily_unavailable', 'temporarily_unavailable'] as const) watch(health);
  assert.deepEqual(seen, ['reauthentication_required', 'temporarily_unavailable']);
});

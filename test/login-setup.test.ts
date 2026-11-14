import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlexaSessionBackend, type RemoteSessionClient } from '../src/alexa-session-backend.js';
import { LoginSetup, type LoginHelper } from '../src/login-setup.js';
import { ReauthenticationRequiredError } from '../src/session-manager.js';

type Callback = (error: Error | null, result?: unknown) => void;

function fakeRemote(behavior: { initError?: Error; cookieData?: unknown }) {
  const seen: { options?: Record<string, unknown>; stops: number } = { stops: 0 };
  class FakeRemote implements RemoteSessionClient {
    static connectivityProofAuthGuardVersion = 1;
    cookieData = behavior.cookieData;
    init(options: object, callback: Callback) {
      seen.options = options as Record<string, unknown>;
      callback(behavior.initError ?? null);
    }
    stop() { seen.stops++; }
  }
  return { FakeRemote, seen };
}

test('backend initializes with the guard enabled and maps rejection versus outage', async () => {
  const ok = fakeRemote({ cookieData: { csrf: 'new' } });
  const backend = new AlexaSessionBackend({
    remoteConstructor: ok.FakeRemote,
    cookieHelper: { refreshAlexaCookie: () => undefined },
  });
  const session = await backend.initialize({ csrf: 'old', amazonPage: 'example.test' });
  assert.deepEqual(session, { csrf: 'new', amazonPage: 'example.test' });
  assert.equal(ok.seen.options?.proofNoImplicitAuth, true);
  assert.equal(ok.seen.options?.cookieRefreshInterval, 0);

  for (const [message, rejected] of [['Authentication rejected', true], ['socket hang up', false]] as const) {
    const failing = fakeRemote({ initError: new Error(message) });
    const failed = new AlexaSessionBackend({
      remoteConstructor: failing.FakeRemote,
      cookieHelper: { refreshAlexaCookie: () => undefined },
    });
    await assert.rejects(failed.initialize({}), (error: Error) =>
      (error instanceof ReauthenticationRequiredError) === rejected && !error.message.includes(message));
    assert.equal(failing.seen.stops, 1);
  }
});

test('backend refresh merges the new session and never falls back to login', async () => {
  const { FakeRemote } = fakeRemote({});
  let received: Record<string, unknown> | undefined;
  const backend = new AlexaSessionBackend({
    remoteConstructor: FakeRemote,
    cookieHelper: {
      refreshAlexaCookie(options, callback) {
        received = options as Record<string, unknown>;
        callback(null, { localCookie: 'fresh' });
      },
    },
  });
  assert.deepEqual(await backend.refresh({ amazonPage: 'example.test', refreshToken: 'r' }),
    { amazonPage: 'example.test', refreshToken: 'r', localCookie: 'fresh' });
  assert.equal(received?.proofNoImplicitAuth, true);

  const rejecting = new AlexaSessionBackend({
    remoteConstructor: FakeRemote,
    cookieHelper: { refreshAlexaCookie: (_o, cb) => cb(new Error('No new access token in Refresh Token response')) },
  });
  await assert.rejects(rejecting.refresh({}), ReauthenticationRequiredError);
  const offline = new AlexaSessionBackend({
    remoteConstructor: FakeRemote,
    cookieHelper: { refreshAlexaCookie: (_o, cb) => cb(new Error('ENOTFOUND')) },
  });
  await assert.rejects(offline.refresh({}), (e: Error) => !(e instanceof ReauthenticationRequiredError));
});

function harness() {
  const saved: unknown[] = [];
  const stops = { count: 0 };
  let captured: Record<string, unknown> | undefined;
  let callback!: Callback;
  const helper: LoginHelper = {
    generateAlexaCookie(options, cb) { captured = options; callback = cb; },
    stopProxyServer() { stops.count++; },
  };
  const setup = new LoginSetup(helper, {
    async load() { return null; },
    async save(data) { saved.push(data); },
    async remove() {},
  });
  return { setup, saved, stops, options: () => captured, emit: (e: Error | null, r?: unknown) => callback(e, r) };
}
const announce = (h: ReturnType<typeof harness>) => h.emit(new Error('Please open http://127.0.0.1:1/ to sign in'));

test('login setup requires approval and refuses non-loopback binding', async () => {
  const h = harness();
  await assert.rejects(h.setup.start({ amazonPage: 'example.test', ttlMs: 1000, ownerApproved: false }));
  for (const host of ['0.0.0.0', '192.168.1.5', 'example.test', '::']) {
    await assert.rejects(h.setup.start({ amazonPage: 'example.test', ttlMs: 1000, ownerApproved: true, host }));
  }
  assert.equal(h.options(), undefined);
  assert.equal(h.setup.state, 'idle');
});

test('login setup listens on loopback, persists only on success and then stops', async () => {
  const h = harness();
  const pending = h.setup.start({ amazonPage: 'example.test', ttlMs: 5000, ownerApproved: true, port: 4321 });
  assert.equal(h.options()?.proxyListenBind, '127.0.0.1');
  assert.equal(h.options()?.logger, undefined);
  assert.equal(h.options()?.acceptLanguage, 'en-US');
  assert.equal(h.options()?.amazonPageProxyLanguage, 'en_US');
  announce(h);
  const { url, done } = await pending;
  assert.equal(url, 'http://127.0.0.1:4321/');
  h.emit(null, { localCookie: 'synthetic' });
  assert.equal(await done, 'completed');
  assert.deepEqual(h.saved, [{ localCookie: 'synthetic' }]);
  assert.equal(h.stops.count, 1);
});

test('login setup expires and ignores a delayed callback without persisting', async () => {
  const h = harness();
  const pending = h.setup.start({ amazonPage: 'example.test', ttlMs: 20, ownerApproved: true });
  announce(h);
  const { done } = await pending;
  assert.equal(await done, 'expired');
  h.emit(null, { localCookie: 'late' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(h.saved, []);
  assert.equal(h.stops.count, 1);
});

test('login setup cancellation stops the listener and drops later results', async () => {
  const h = harness();
  const pending = h.setup.start({ amazonPage: 'example.test', ttlMs: 5000, ownerApproved: true });
  announce(h);
  const { done } = await pending;
  h.setup.cancel();
  assert.equal(await done, 'cancelled');
  h.emit(null, { localCookie: 'late' });
  assert.deepEqual(h.saved, []);
});

test('login setup reports delayed startup failure without exposing details', async () => {
  const h = harness();
  const pending = h.setup.start({ amazonPage: 'example.test', ttlMs: 5000, ownerApproved: true });
  h.emit(new Error('Proxy could not be initialized with secret-detail'));
  await assert.rejects(pending, (e: Error) => !e.message.includes('secret-detail'));
  assert.equal(h.setup.state, 'failed');
  assert.deepEqual(h.saved, []);
});

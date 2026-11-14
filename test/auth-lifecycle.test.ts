import assert from 'node:assert/strict';
import { test } from 'node:test';
import AlexaRemoteImport from 'alexa-remote2';
import { assertAuthGuard, guardedOptions } from '../src/auth-guard.js';

type Callback = (error: Error | null, body?: unknown) => void;
type Remote = {
  _options: Record<string, unknown>;
  cookie: string | null;
  csrf: string | null;
  macDms: unknown;
  lastAuthCheck: number;
  cookieRefreshTimeout: unknown;
  setCookie(cookie: unknown): void;
  generateCookie(...args: unknown[]): void;
  refreshCookie(callback: Callback): void;
  checkAuthentication(callback: (authenticated: boolean | null, error?: Error) => void): void;
  getEndpoints(callback: Callback): void;
  prepare(callback: () => void): void;
  init(options: object, callback: Callback): void;
  httpsGet(path: string, callback: Callback, flags?: object): void;
  httpsGetCall(...args: unknown[]): void;
};
const AlexaRemote = AlexaRemoteImport as unknown as {
  new (): Remote;
  connectivityProofAuthGuardVersion?: number;
};

function build(authenticated: boolean | null, overrides: Partial<Record<'cookie' | 'macDms', unknown>> = {}) {
  const calls = { generate: 0, refresh: 0, check: 0, call: 0 };
  const remote = new AlexaRemote();
  remote.setCookie = () => undefined;
  remote.cookie = 'cookie' in overrides ? overrides.cookie as string | null : 'synthetic-cookie';
  remote.csrf = 'synthetic-csrf';
  remote.macDms = 'macDms' in overrides ? overrides.macDms : { synthetic: true };
  remote.generateCookie = () => { calls.generate++; };
  remote.refreshCookie = (callback) => { calls.refresh++; callback(new Error('refresh rejected')); };
  remote.checkAuthentication = (callback) => {
    calls.check++;
    if (authenticated === null) callback(null, new Error('network'));
    else callback(authenticated);
  };
  remote.getEndpoints = (callback) => callback(new Error('offline'));
  remote.prepare = (callback) => callback();
  remote.httpsGetCall = () => { calls.call++; };
  return { remote, calls };
}
const options = (extra: object = {}) => guardedOptions(AlexaRemote, { amazonPage: 'invalid.test', ...extra });

test('guard fails closed when the upstream authentication patch is absent', () => {
  assert.doesNotThrow(() => assertAuthGuard(AlexaRemote));
  assert.throws(() => assertAuthGuard({ connectivityProofAuthGuardVersion: 0 }));
  assert.throws(() => guardedOptions({}, {}));
});

test('initialization without a stored cookie never starts a login', async () => {
  const { remote, calls } = build(true, { cookie: null });
  const error = await new Promise<Error | null>((resolve) => remote.init(options(), (e) => resolve(e)));
  assert.ok(error);
  assert.equal(calls.generate, 0);
});

test('rejected authentication fails once without re-login or re-initialization', async () => {
  const { remote, calls } = build(false);
  const error = await new Promise<Error | null>((resolve) => remote.init(options(), (e) => resolve(e)));
  assert.ok(error);
  assert.equal(calls.check, 1);
  assert.equal(calls.generate, 0);
  assert.equal(calls.refresh, 0);
});

test('refresh failure does not fall back to a new login', async () => {
  const { remote, calls } = build(true);
  const error = await new Promise<Error | null>((resolve) =>
    remote.init(options({ formerRegistrationData: { tokenDate: 0, dataVersion: 2 } }), (e) => resolve(e)));
  assert.ok(error);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.generate, 0);
});

test('network error during the check does not trigger authentication', async () => {
  const { remote, calls } = build(null);
  await new Promise<Error | null>((resolve) => remote.init(options(), (e) => resolve(e)));
  assert.equal(calls.generate, 0);
  assert.equal(calls.refresh, 0);
});

test('a successful initialization schedules no upstream refresh timer', async () => {
  const { remote, calls } = build(true);
  await new Promise<Error | null>((resolve) => remote.init(options(), (e) => resolve(e)));
  assert.equal(remote.cookieRefreshTimeout ?? null, null);
  assert.equal(calls.generate, 0);
});

test('a timer is not scheduled even when an interval is requested', async () => {
  const { remote } = build(true);
  await new Promise<Error | null>((resolve) =>
    remote.init({ ...options(), cookieRefreshInterval: 1000 }, (e) => resolve(e)));
  assert.equal(remote.cookieRefreshTimeout ?? null, null);
});

test('request-time authentication rejection does not re-initialize', async () => {
  const { remote, calls } = build(false);
  remote.lastAuthCheck = 0;
  remote._options = options();
  let inits = 0;
  remote.init = () => { inits++; };
  const error = await new Promise<Error | null>((resolve) => remote.httpsGet('/api/x', (e) => resolve(e)));
  assert.ok(error);
  assert.equal(inits, 0);
  assert.equal(calls.call, 0);
  assert.equal(calls.generate, 0);
});

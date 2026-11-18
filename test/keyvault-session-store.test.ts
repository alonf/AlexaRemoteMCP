import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyVaultSessionStore, StaleSessionError, type VaultClient, type VaultSecret } from '../src/keyvault-session-store.js';

class FakeVault implements VaultClient {
  secrets = new Map<string, VaultSecret>();
  failWith: Error | undefined;
  private counter = 0;

  async get(name: string) {
    if (this.failWith) throw this.failWith;
    return this.secrets.get(name);
  }
  async set(name: string, value: string) {
    if (this.failWith) throw this.failWith;
    const secret = { value, version: `v${++this.counter}` };
    this.secrets.set(name, secret);
    return secret;
  }
  async remove(name: string) {
    if (this.failWith) throw this.failWith;
    this.secrets.delete(name);
  }
}

test('round trips a session and returns null when none is stored', async () => {
  const store = new KeyVaultSessionStore(new FakeVault());
  assert.equal(await store.load(), null);
  await store.save({ cookie: 'a' });
  assert.deepEqual(await store.load(), { cookie: 'a' });
});

test('a stale writer is rejected and cannot overwrite a newer session', async () => {
  const vault = new FakeVault();
  const first = new KeyVaultSessionStore(vault);
  const second = new KeyVaultSessionStore(vault);
  await first.save({ n: 0 });
  await first.load();
  await second.load();
  await second.save({ n: 2 });
  await assert.rejects(first.save({ n: 1 }), StaleSessionError);
  assert.deepEqual(await first.load(), { n: 2 });
  await first.save({ n: 3 });
  assert.deepEqual(await second.load(), { n: 3 });
});

test('an instance that loaded an absent secret cannot overwrite one created meanwhile', async () => {
  const vault = new FakeVault();
  const a = new KeyVaultSessionStore(vault);
  const b = new KeyVaultSessionStore(vault);
  await a.load();
  await b.save({ from: 'b' });
  await assert.rejects(a.save({ from: 'a' }), StaleSessionError);
});

test('remove clears the secret, and vault failures do not expose upstream messages', async () => {
  const vault = new FakeVault();
  const store = new KeyVaultSessionStore(vault);
  await store.save({ x: 1 });
  await store.remove();
  assert.equal(await store.load(), null);

  vault.failWith = new Error('https://vault.example/secrets/alexa-session token=abc');
  for (const op of [() => store.load(), () => store.save({ x: 2 }), () => store.remove()]) {
    await assert.rejects(op(), (error: Error) => !/vault\.example|token=abc/.test(error.message));
  }
});

test('concurrent saves from one instance are serialized without false stale errors', async () => {
  const store = new KeyVaultSessionStore(new FakeVault());
  await store.load();
  await Promise.all([store.save({ n: 1 }), store.save({ n: 2 }), store.save({ n: 3 })]);
  assert.deepEqual(await store.load(), { n: 3 });
});

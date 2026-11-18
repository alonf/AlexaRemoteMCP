import assert from 'node:assert/strict';
import test from 'node:test';
import { cachedInventory } from '../src/inventory-cache.js';

test('serves the cached inventory, shares one in-flight read and refetches after expiry', async () => {
  let calls = 0;
  let clock = 0;
  const cache = cachedInventory(async () => ({ n: ++calls }), 1000, () => clock);
  const [a, b] = await Promise.all([cache.read(), cache.read()]);
  assert.deepEqual(a, { n: 1 });
  assert.deepEqual(b, { n: 1 });
  clock = 500;
  assert.deepEqual(await cache.read(), { n: 1 });
  clock = 1500;
  assert.deepEqual(await cache.read(), { n: 2 });
});

test('a failed refresh keeps the previous copy and is not cached', async () => {
  let fail = false;
  let clock = 0;
  const cache = cachedInventory(async () => { if (fail) throw new Error('down'); return { ok: true }; }, 1000, () => clock);
  await cache.read();
  fail = true;
  await cache.refresh();
  clock = 500;
  assert.deepEqual(await cache.read(), { ok: true });
  clock = 2000;
  await assert.rejects(cache.read());
});

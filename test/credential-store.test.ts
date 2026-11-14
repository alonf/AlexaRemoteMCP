import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CredentialStore } from '../src/credential-store.js';

const execFileAsync = promisify(execFile);

async function setupStore(): Promise<{ base: string; store: CredentialStore }> {
  for (const root of [os.tmpdir(), path.dirname(process.cwd())]) {
    let base: string | undefined;
    try {
      base = await fs.mkdtemp(path.join(root, 'alexa-proof-test-'));
      const store = await CredentialStore.open(path.join(base, 'protected'));
      return { base, store };
    } catch {
      if (base) await fs.rm(base, { recursive: true, force: true });
    }
  }
  throw new Error('No writable temporary directory outside a repository');
}

test('protected atomic replacement preserves the previous session on failure', async (t) => {
  const { base, store } = await setupStore();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  assert.equal(await store.load(), null);
  await store.save({ session: 'synthetic-old' });
  assert.deepEqual(await store.load(), { session: 'synthetic-old' });
  await store.save({ session: 'synthetic-replacement' });
  assert.deepEqual(await store.load(), { session: 'synthetic-replacement' });

  const rename = t.mock.method(fs, 'rename', async () => { throw new Error('injected'); });
  await assert.rejects(store.save({ session: 'synthetic-new' }), { message: 'Cannot persist protected credentials' });
  rename.mock.restore();
  assert.deepEqual(await store.load(), { session: 'synthetic-replacement' });
  assert.deepEqual(await fs.readdir(path.join(base, 'protected')), ['session.json']);
  await store.remove();
  assert.equal(await store.load(), null);
});

test('rejects insecure storage and repository locations', async (t) => {
  const { base } = await setupStore();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'protected');
  if (process.platform === 'win32') {
    await execFileAsync('icacls.exe', [directory, '/grant', '*S-1-1-0:(OI)(CI)F']);
  } else {
    await fs.chmod(directory, 0o755);
  }
  await assert.rejects(CredentialStore.open(directory), { message: 'Cannot open protected credential store' });

  const repository = path.join(base, 'repository');
  await fs.mkdir(path.join(repository, '.git'), { recursive: true });
  await assert.rejects(CredentialStore.open(path.join(repository, 'protected')), {
    message: 'Cannot open protected credential store',
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './support/no-network.js';
import type { VaultClient, VaultSecret } from '../src/keyvault-session-store.js';
import { buildService, ConfigError, loadConfig } from '../src/service.js';
import { FakeAlexa } from './support/fake-alexa.js';

const ENV = {
  PUBLIC_BASE_URL: 'http://127.0.0.1:9',
  ENTRA_TENANT_ID: 'tenant-x',
  ENTRA_CLIENT_ID: 'client-x',
  OWNER_ACCOUNT_ID: 'owner-x',
  APPROVED_REDIRECT_URIS: 'https://client.example/cb',
};

class MemoryVault implements VaultClient {
  readonly secrets = new Map<string, VaultSecret>();
  private n = 0;
  async get(name: string) { return this.secrets.get(name); }
  async set(name: string, value: string) {
    const secret = { value, version: `v${++this.n}` };
    this.secrets.set(name, secret);
    return secret;
  }
  async remove(name: string) { this.secrets.delete(name); }
}

test('missing required settings fail fast and name only the settings, never values', () => {
  assert.throws(() => loadConfig({ ...ENV, OWNER_ACCOUNT_ID: '', ENTRA_CLIENT_ID: undefined }), (error: Error) =>
    error instanceof ConfigError && /ENTRA_CLIENT_ID, OWNER_ACCOUNT_ID/.test(error.message) && !error.message.includes('tenant-x'));
  assert.throws(() => loadConfig({ ...ENV, PUBLIC_BASE_URL: 'http://public.example' }), ConfigError);
});

test('the assembled service serves health and metadata, challenges anonymous MCP calls, and persists issuer keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svc-'));
  const vault = new MemoryVault();
  const config = loadConfig({ ...ENV, HOME_DATA_DIR: dir, MUTATION_ALLOWED_TARGETS: 'light-1' });
  const alexa = new FakeAlexa();
  const runtime = { port: alexa, health: () => 'usable' as const, stop: () => undefined };
  const service = await buildService(config, { vault, alexa: runtime });
  await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(mcp.status, 401);
    assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource`)).status, 200);
    assert.equal(alexa.calls.length, 0);
    assert.ok(vault.secrets.has('issuer-keys'));
  } finally {
    await new Promise<void>((resolve) => service.server.close(() => resolve()));
    service.close();
  }

  const before = vault.secrets.get('issuer-keys')?.version;
  const again = await buildService(config, { vault, alexa: runtime });
  assert.equal(vault.secrets.get('issuer-keys')?.version, before);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

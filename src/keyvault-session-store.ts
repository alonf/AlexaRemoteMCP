import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import type { SessionStore } from './session-manager.js';

export interface VaultSecret {
  value: string;
  version: string;
}

// The small slice of Key Vault this service needs, so tests can use an in-memory fake.
export interface VaultClient {
  get(name: string): Promise<VaultSecret | undefined>;
  set(name: string, value: string): Promise<VaultSecret>;
  remove(name: string): Promise<void>;
}

export class StaleSessionError extends Error {
  constructor() {
    super('Credential store changed since it was loaded');
  }
}

const isStatus = (error: unknown, status: number) => (error as { statusCode?: number } | null)?.statusCode === status;

export function createAzureVault(vaultUrl: string, credential: TokenCredential = new DefaultAzureCredential()): VaultClient {
  const client = new SecretClient(vaultUrl, credential);
  return {
    async get(name) {
      try {
        const secret = await client.getSecret(name);
        const version = secret.properties.version;
        return secret.value !== undefined && version ? { value: secret.value, version } : undefined;
      } catch (error) {
        if (isStatus(error, 404)) return undefined;
        throw error;
      }
    },
    async set(name, value) {
      const secret = await client.setSecret(name, value);
      const version = secret.properties.version;
      if (!version) throw new Error('Vault returned no version');
      return { value, version };
    },
    async remove(name) {
      try {
        await (await client.beginDeleteSecret(name)).pollUntilDone();
      } catch (error) {
        if (!isStatus(error, 404)) throw error;
      }
    },
  };
}

// Stores the Alexa session as one Key Vault secret. Key Vault has no conditional write, so a save
// first re-reads the latest version and refuses to overwrite one this instance never saw. That
// narrows, but cannot fully close, a race; the service therefore runs as a single instance.
export class KeyVaultSessionStore implements SessionStore {
  // undefined: never loaded or saved here (a deliberate seed may overwrite); null: known absent.
  private known: string | null | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly vault: VaultClient,
    private readonly secretName = 'alexa-session',
  ) {}

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  load(): Promise<unknown | null> {
    return this.serialized(async () => {
      let secret: VaultSecret | undefined;
      try {
        secret = await this.vault.get(this.secretName);
      } catch {
        throw new Error('Cannot read protected credential store');
      }
      this.known = secret?.version ?? null;
      if (!secret) return null;
      try {
        return JSON.parse(secret.value) as unknown;
      } catch {
        throw new Error('Cannot read protected credential store');
      }
    });
  }

  save(data: unknown): Promise<void> {
    return this.serialized(async () => {
      const contents = JSON.stringify(data);
      if (contents === undefined) throw new Error('Cannot persist protected credentials');
      try {
        if (this.known !== undefined) {
          const current = (await this.vault.get(this.secretName))?.version ?? null;
          if (current !== this.known) throw new StaleSessionError();
        }
        this.known = (await this.vault.set(this.secretName, contents)).version;
      } catch (error) {
        if (error instanceof StaleSessionError) throw error;
        throw new Error('Cannot persist protected credentials', { cause: error });
      }
    });
  }

  remove(): Promise<void> {
    return this.serialized(async () => {
      try {
        await this.vault.remove(this.secretName);
        this.known = null;
      } catch {
        throw new Error('Cannot remove protected credentials');
      }
    });
  }
}

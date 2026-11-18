import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Subscription {
  id: string;
  clientId: string;
  eventName: string;
  callback: URL;
  signingKey: Buffer;
  expiresAt: number;
}

// The id is derived, so a client that subscribes again to the same event and callback renews instead of duplicating.
export function subscriptionId(clientId: string, eventName: string, callback: URL): string {
  return `sub_${createHash('sha256').update(`${clientId}\n${eventName}\n${callback.href}`).digest('hex').slice(0, 32)}`;
}

// Subscriptions hold a signing key that must be recoverable, so it is sealed with AES-256-GCM under a key derived from
// a Key Vault secret: reading the database file alone never yields a usable key.
export class SubscriptionStore {
  private readonly db: DatabaseSync;
  private readonly sealingKey: Buffer;

  constructor(path: string, secret: Buffer) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS event_subscriptions (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      callback TEXT NOT NULL,
      sealed_key TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    this.sealingKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'alexa-mcp events sealing', 32));
  }

  private seal(id: string, key: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.sealingKey, iv);
    cipher.setAAD(Buffer.from(id));
    const body = Buffer.concat([cipher.update(key), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  private unseal(id: string, sealed: string): Buffer | undefined {
    try {
      const raw = Buffer.from(sealed, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.sealingKey, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    } catch {
      return undefined;
    }
  }

  save(subscription: Omit<Subscription, 'id'>): string {
    const id = subscriptionId(subscription.clientId, subscription.eventName, subscription.callback);
    this.db.prepare(
      `INSERT INTO event_subscriptions (id, client_id, event_name, callback, sealed_key, expires_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET sealed_key = excluded.sealed_key, expires_at = excluded.expires_at`,
    ).run(id, subscription.clientId, subscription.eventName, subscription.callback.href, this.seal(id, subscription.signingKey), subscription.expiresAt);
    return id;
  }

  active(eventName: string, nowMs: number): Subscription[] {
    this.db.prepare('DELETE FROM event_subscriptions WHERE expires_at <= ?').run(nowMs);
    const rows = this.db.prepare('SELECT id, client_id, callback, sealed_key, expires_at FROM event_subscriptions WHERE event_name = ?').all(eventName) as
      { id: string; client_id: string; callback: string; sealed_key: string; expires_at: number }[];
    return rows.flatMap((row) => {
      const signingKey = this.unseal(row.id, row.sealed_key);
      return signingKey ? [{ id: row.id, clientId: row.client_id, eventName, callback: new URL(row.callback), signingKey, expiresAt: row.expires_at }] : [];
    });
  }

  // Only the owner of a subscription can end it; anything else is a silent no-op.
  remove(id: string, clientId: string): void {
    this.db.prepare('DELETE FROM event_subscriptions WHERE id = ? AND client_id = ?').run(id, clientId);
  }

  forget(id: string): void {
    this.db.prepare('DELETE FROM event_subscriptions WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}

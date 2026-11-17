import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Adapter, AdapterPayload } from 'oidc-provider';

const digest = (model: string, value: string) =>
  createHash('sha256').update(model).update('\0').update(value).digest('hex');

interface StoredRow {
  payload: string;
  expires_at: number | null;
  consumed_at: number | null;
}

// Stores issuer state in SQLite. Lookup keys (token values, codes, uids) are kept only as
// SHA-256 digests and the token value is removed from the stored payload, so reading the
// database never yields a usable credential.
export class OidcStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS oidc (
      model TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      grant_id TEXT,
      uid_hash TEXT,
      user_code_hash TEXT,
      expires_at INTEGER,
      consumed_at INTEGER,
      PRIMARY KEY (model, key_hash)
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS oidc_grant ON oidc(grant_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS oidc_uid ON oidc(uid_hash)');
  }

  // The constructor shape oidc-provider expects for its `adapter` option.
  get adapter(): new (name: string) => Adapter {
    const db = this.db;
    return class implements Adapter {
      constructor(private readonly name: string) {}

      async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
        const rest = { ...payload } as AdapterPayload & { jti?: string };
        delete rest.jti;
        db
          .prepare('INSERT OR REPLACE INTO oidc(model, key_hash, payload, grant_id, uid_hash, user_code_hash, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            this.name,
            digest(this.name, id),
            JSON.stringify(rest),
            payload.grantId ?? null,
            payload.uid ? digest(this.name, payload.uid) : null,
            payload.userCode ? digest(this.name, payload.userCode) : null,
            expiresIn ? Date.now() + expiresIn * 1000 : null,
            payload.consumed ? payload.consumed * 1000 : null,
          );
      }

      private load(where: string, value: string, id?: string): AdapterPayload | undefined {
        const row = db
          .prepare(`SELECT payload, expires_at, consumed_at FROM oidc WHERE model = ? AND ${where} = ?`)
          .get(this.name, value) as unknown as StoredRow | undefined;
        if (!row) return undefined;
        if (row.expires_at !== null && row.expires_at <= Date.now()) return undefined;
        const payload = JSON.parse(row.payload) as AdapterPayload;
        if (id !== undefined) (payload as { jti?: string }).jti = id;
        if (row.consumed_at !== null) payload.consumed = Math.floor(row.consumed_at / 1000);
        return payload;
      }

      async find(id: string) { return this.load('key_hash', digest(this.name, id), id); }
      async findByUid(uid: string) { return this.load('uid_hash', digest(this.name, uid)); }
      async findByUserCode(userCode: string) { return this.load('user_code_hash', digest(this.name, userCode)); }

      async destroy(id: string): Promise<void> {
        db.prepare('DELETE FROM oidc WHERE model = ? AND key_hash = ?').run(this.name, digest(this.name, id));
      }

      async revokeByGrantId(grantId: string): Promise<void> {
        db.prepare('DELETE FROM oidc WHERE grant_id = ?').run(grantId);
      }

      async consume(id: string): Promise<void> {
        db
          .prepare('UPDATE oidc SET consumed_at = ? WHERE model = ? AND key_hash = ?')
          .run(Date.now(), this.name, digest(this.name, id));
      }
    };
  }

  purgeExpired(now = Date.now()): void {
    this.db.prepare('DELETE FROM oidc WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
  }

  dumpForInspection(): string {
    const rows = this.db.prepare('SELECT * FROM oidc').all();
    return JSON.stringify(rows);
  }

  close(): void {
    this.db.close();
  }
}

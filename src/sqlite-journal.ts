import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashArguments, type JournalBegin, type JournalRecord } from './journal.js';
import type { Outcome } from './outcomes.js';
import type { OperationStore } from './ports.js';

interface Row {
  operation_id: string;
  operation: string;
  arguments_hash: string;
  targets: string;
  dispatched_at: string;
  outcome: string | null;
  principal: string | null;
  client: string | null;
  operation_key: string | null;
}

export interface OperationContext {
  principal: string;
  client: string;
  operationKey?: string;
}

export type OpenResult =
  | { kind: 'created'; record: JournalBegin }
  | { kind: 'replayed'; record: JournalRecord }
  | { kind: 'key_conflict' };

const COLUMNS = 'operation_id, operation, arguments_hash, targets, dispatched_at, outcome, principal, client, operation_key';

function toRecord(row: Row): JournalRecord {
  return {
    operationId: row.operation_id,
    operation: row.operation,
    argumentsHash: row.arguments_hash,
    targets: JSON.parse(row.targets) as string[],
    dispatchedAt: row.dispatched_at,
    ...(row.outcome ? { outcome: JSON.parse(row.outcome) as Outcome } : {}),
    ...(row.principal ? { principal: row.principal } : {}),
    ...(row.client ? { client: row.client } : {}),
    ...(row.operation_key ? { operationKey: row.operation_key } : {}),
  };
}

// Rollback-journal mode with full sync and a single writer process (see design D4).
export class SqliteJournal implements OperationStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS operations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL UNIQUE,
      operation TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      targets TEXT NOT NULL,
      dispatched_at TEXT NOT NULL,
      outcome TEXT,
      ended_at TEXT,
      principal TEXT,
      client TEXT,
      operation_key TEXT
    )`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS operations_key
      ON operations(principal, operation_key) WHERE operation_key IS NOT NULL`);
  }

  async begin(operation: string, args: unknown, targets: string[], now: Date = new Date()): Promise<JournalBegin> {
    const record = this.newRecord(operation, args, targets, now);
    this.insert(record);
    return record;
  }

  // Records a keyed mutation. A repeated key from the same principal returns the original
  // record instead of creating a second one, so the caller must not dispatch again.
  async open(context: OperationContext, operation: string, args: unknown, targets: string[], now: Date = new Date()): Promise<OpenResult> {
    const record = this.newRecord(operation, args, targets, now);
    if (context.operationKey) {
      const existing = this.db
        .prepare(`SELECT ${COLUMNS} FROM operations WHERE principal = ? AND operation_key = ?`)
        .get(context.principal, context.operationKey) as unknown as Row | undefined;
      if (existing) {
        return existing.arguments_hash === record.argumentsHash
          ? { kind: 'replayed', record: toRecord(existing) }
          : { kind: 'key_conflict' };
      }
    }
    this.insert(record, context);
    return { kind: 'created', record };
  }

  // Returns the record only to the principal that created it.
  async get(principal: string, operationId: string): Promise<JournalRecord | undefined> {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM operations WHERE operation_id = ? AND principal = ?`)
      .get(operationId, principal) as unknown as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  // Marks every incomplete record unknown. Nothing is sent to Amazon for them.
  recoverOnStart(now: Date = new Date()): number {
    const result = this.db
      .prepare('UPDATE operations SET outcome = ?, ended_at = ? WHERE outcome IS NULL')
      .run(JSON.stringify({ status: 'unknown' }), now.toISOString());
    return Number(result.changes);
  }

  private newRecord(operation: string, args: unknown, targets: string[], now: Date): JournalBegin {
    return {
      operationId: randomUUID(),
      operation,
      argumentsHash: hashArguments(args),
      targets,
      dispatchedAt: now.toISOString(),
    };
  }

  private insert(record: JournalBegin, context?: OperationContext): void {
    this.db
      .prepare('INSERT INTO operations(operation_id, operation, arguments_hash, targets, dispatched_at, principal, client, operation_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        record.operationId, record.operation, record.argumentsHash, JSON.stringify(record.targets), record.dispatchedAt,
        context?.principal ?? null, context?.client ?? null, context?.operationKey ?? null,
      );
  }

  async end(operationId: string, outcome: Outcome, now: Date = new Date()): Promise<void> {
    this.db
      .prepare('UPDATE operations SET outcome = ?, ended_at = ? WHERE operation_id = ? AND outcome IS NULL')
      .run(JSON.stringify(outcome), now.toISOString(), operationId);
  }

  async read(): Promise<JournalRecord[]> {
    const rows = this.db.prepare('SELECT operation_id, operation, arguments_hash, targets, dispatched_at, outcome FROM operations ORDER BY seq').all() as unknown as Row[];
    return rows.map((row) => ({
      operationId: row.operation_id,
      operation: row.operation,
      argumentsHash: row.arguments_hash,
      targets: JSON.parse(row.targets) as string[],
      dispatchedAt: row.dispatched_at,
      ...(row.outcome ? { outcome: JSON.parse(row.outcome) as Outcome } : {}),
    }));
  }

  // A record without an outcome may or may not have been dispatched; report it unknown and never replay.
  async recover(): Promise<JournalRecord[]> {
    const records = await this.read();
    return records.map((r) => (r.outcome ? r : { ...r, outcome: { status: 'unknown' } }));
  }

  close(): void {
    this.db.close();
  }
}

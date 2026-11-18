import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { Outcome } from './outcomes.js';
import type { OperationStore } from './ports.js';

export interface JournalBegin {
  operationId: string;
  operation: string;
  argumentsHash: string;
  targets: string[];
  dispatchedAt: string;
}

type Entry =
  | { type: 'begin'; record: JournalBegin }
  | { type: 'end'; operationId: string; outcome: Outcome; at: string };

export interface JournalRecord extends JournalBegin {
  outcome?: Outcome;
  principal?: string;
  client?: string;
  operationKey?: string;
}

export function hashArguments(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args) ?? 'undefined').digest('hex');
}

export class Journal implements OperationStore {
  constructor(private readonly path: string) {}

  private async append(entry: Entry): Promise<void> {
    const handle = await fs.open(this.path, 'a', 0o600);
    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  begin(operation: string, args: unknown, targets: string[], now: Date = new Date()): Promise<JournalBegin> {
    const record: JournalBegin = {
      operationId: randomUUID(),
      operation,
      argumentsHash: hashArguments(args),
      targets,
      dispatchedAt: now.toISOString(),
    };
    return this.append({ type: 'begin', record }).then(() => record);
  }

  end(operationId: string, outcome: Outcome, now: Date = new Date()): Promise<void> {
    return this.append({ type: 'end', operationId, outcome, at: now.toISOString() });
  }

  async read(): Promise<JournalRecord[]> {
    let text: string;
    try {
      text = await fs.readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = new Map<string, JournalRecord>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: Entry;
      try {
        entry = JSON.parse(line) as Entry;
      } catch {
        continue; // a torn final line from a crash is not a completed record
      }
      if (entry.type === 'begin') {
        records.set(entry.record.operationId, { ...entry.record });
      } else {
        const existing = records.get(entry.operationId);
        if (existing) existing.outcome = entry.outcome;
      }
    }
    return [...records.values()];
  }

  // A record without an outcome may or may not have been dispatched; report it unknown and never replay.
  async recover(): Promise<JournalRecord[]> {
    const records = await this.read();
    return records.map((r) => (r.outcome ? r : { ...r, outcome: { status: 'unknown' } }));
  }
}

// The journal write precedes dispatch, so a failed write means nothing was sent.
export async function journaledDispatch(
  journal: OperationStore,
  operation: string,
  args: unknown,
  targets: string[],
  dispatch: () => Promise<Outcome>,
): Promise<{ operationId?: string; outcome: Outcome }> {
  let record: JournalBegin;
  try {
    record = await journal.begin(operation, args, targets);
  } catch {
    return { outcome: { status: 'not_dispatched' } };
  }
  let outcome: Outcome;
  try {
    outcome = await dispatch();
  } catch {
    outcome = { status: 'unknown' };
  }
  try {
    await journal.end(record.operationId, outcome);
  } catch {
    // Recovery reports the incomplete record as unknown.
  }
  return { operationId: record.operationId, outcome };
}

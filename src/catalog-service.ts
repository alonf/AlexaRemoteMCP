import { type ApprovalInput, type ApprovalRefusal, gateApproval, type GateReply } from './approval-gate.js';
import type { ApprovalSigner } from './approval.js';
import { type Catalog, type CatalogStore, parseCatalog, serializeCatalog } from './catalog.js';
import type { BackupFn } from './catalog-backup.js';
import type { OperationContext, SqliteJournal } from './sqlite-journal.js';

export const MAX_CHANGES = 20;

export interface CatalogChange {
  set?: Record<string, unknown>;
  remove?: string[];
}

export interface CatalogReply {
  status: 'saved' | 'rejected' | 'not_dispatched' | 'approval_required';
  reason?: ApprovalRefusal | 'invalid_change' | 'too_many_changes' | 'no_change' | 'backup_failed';
  detail?: string;
  approval?: { inputRequests: Record<string, unknown>; requestState: string };
  count?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Sorted so the same change always has the same digest, whatever order the client listed it in.
function normalize(change: CatalogChange): { set: Array<[string, unknown]>; remove: string[] } {
  return {
    set: Object.entries(change.set ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    remove: [...new Set(change.remove ?? [])].sort(),
  };
}

const clip = (value: string) => value.replace(/\s+/g, ' ').slice(0, 40);

function summarize(normalized: ReturnType<typeof normalize>): string {
  const sets = normalized.set.map(([id, entry]) => {
    const e = isRecord(entry) ? entry : {};
    return `${clip(id)} as ${clip(String(e.category))}${typeof e.group === 'string' ? ` (${clip(e.group)})` : ''}`;
  });
  const removes = normalized.remove.map(clip);
  return `change the device catalog: ${[sets.length ? `set ${sets.join(', ')}` : '', removes.length ? `remove ${removes.join(', ')}` : ''].filter(Boolean).join('; ')}`;
}

// Catalog edits can widen what an agent may do, so they are never auto-allowed: each one needs the owner's approval.
export class CatalogService {
  constructor(
    private readonly store: CatalogStore,
    private readonly journal: SqliteJournal,
    private readonly signer: ApprovalSigner | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly backup?: BackupFn,
  ) {}

  onApprovalRequested?: (summary: string) => void;

  read(): Catalog {
    return this.store.get();
  }

  private build(change: CatalogChange):
    | { next: Catalog; normalized: ReturnType<typeof normalize>; total: number }
    | { reply: CatalogReply } {
    const normalized = normalize(change);
    const total = normalized.set.length + normalized.remove.length;
    if (total === 0) return { reply: { status: 'rejected', reason: 'no_change' } };
    if (total > MAX_CHANGES) return { reply: { status: 'rejected', reason: 'too_many_changes' } };

    const devices: Record<string, unknown> = Object.fromEntries(this.store.get());
    for (const id of normalized.remove) delete devices[id];
    for (const [id, entry] of normalized.set) devices[id] = entry;
    try {
      return { next: parseCatalog(JSON.stringify({ version: 1, devices })), normalized, total };
    } catch (error) {
      return { reply: { status: 'rejected', reason: 'invalid_change', detail: error instanceof Error ? error.message : 'invalid' } };
    }
  }

  // The pre-edit state must be safely backed up first; if it cannot be, the edit does not happen.
  private async save(next: Catalog): Promise<'saved' | 'backup_failed' | 'not_dispatched'> {
    try {
      await this.backup?.(serializeCatalog(this.store.get()));
    } catch {
      return 'backup_failed';
    }
    try {
      this.store.replace(next);
    } catch {
      return 'not_dispatched';
    }
    return 'saved';
  }

  async update(context: OperationContext, change: CatalogChange, approval: ApprovalInput): Promise<CatalogReply> {
    // Visibility is the owner's decision: an agent can neither see, edit nor toggle a disabled device.
    const current = this.store.get();
    const touched = [...Object.keys(change.set ?? {}), ...(change.remove ?? [])];
    const flagged = Object.values(change.set ?? {}).some((entry) => isRecord(entry) && entry.disabled !== undefined);
    if (flagged || touched.some((id) => current.get(id)?.disabled)) {
      return { status: 'rejected', reason: 'invalid_change', detail: 'not editable through MCP' };
    }
    const built = this.build(change);
    if ('reply' in built) return built.reply;
    const gate = await gateApproval(
      { signer: this.signer, journal: this.journal, now: this.now, onApprovalRequested: this.onApprovalRequested },
      context, 'catalog', 'catalog-edit', built.normalized, summarize(built.normalized), approval,
    );
    if ('status' in gate) return gate as GateReply as CatalogReply;
    const outcome = await this.save(built.next);
    if (outcome === 'backup_failed') return { status: 'rejected', reason: 'backup_failed' };
    return outcome === 'saved' ? { status: 'saved', count: built.total } : { status: 'not_dispatched' };
  }

  // For the owner's signed-in admin page, where being signed in is the approval.
  async adminEdit(change: CatalogChange): Promise<CatalogReply> {
    const built = this.build(change);
    if ('reply' in built) return built.reply;
    const outcome = await this.save(built.next);
    if (outcome === 'backup_failed') return { status: 'rejected', reason: 'backup_failed' };
    return outcome === 'saved' ? { status: 'saved', count: built.total } : { status: 'not_dispatched' };
  }

  async adminReplace(text: string): Promise<CatalogReply> {
    let next: Catalog;
    try {
      next = parseCatalog(text);
    } catch (error) {
      return { status: 'rejected', reason: 'invalid_change', detail: error instanceof Error ? error.message : 'invalid' };
    }
    const outcome = await this.save(next);
    if (outcome === 'backup_failed') return { status: 'rejected', reason: 'backup_failed' };
    return outcome === 'saved' ? { status: 'saved', count: next.size } : { status: 'not_dispatched' };
  }
}


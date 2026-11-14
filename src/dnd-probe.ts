import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Outcome, TargetOutcome } from './outcomes.js';

export type DndValue = boolean | 'unknown';

export interface DndBackend {
  read(): Promise<Record<string, DndValue>>;
  write(device: string, enabled: boolean): Promise<Outcome>;
  // Real Alexa DND exposes no revision history; a backend that does can enable safe attribution.
  readonly hasRevisionHistory: boolean;
}

export type DeviceState =
  | 'pending'
  | 'unchanged'
  | 'blocked_unknown_initial'
  | 'set'
  | 'set_failed'
  | 'set_unknown'
  | 'restored'
  | 'restore_failed'
  | 'conflict'
  | 'attribution_uncertain'
  | 'not_changed';

export interface DndDevice {
  serial: string;
  original: DndValue;
  state: DeviceState;
}

export interface DndSnapshot {
  operationId: string;
  desired: boolean;
  devices: DndDevice[];
}

export interface SnapshotStore {
  load(): Promise<DndSnapshot | null>;
  save(snapshot: DndSnapshot): Promise<void>;
}

export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly file: string) {}

  async load(): Promise<DndSnapshot | null> {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8')) as DndSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(snapshot: DndSnapshot): Promise<void> {
    const temp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${randomUUID()}.tmp`);
    const handle = await fs.open(temp, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(snapshot));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, this.file);
  }
}

function summarize(targets: TargetOutcome[]): Outcome['status'] {
  const ok = targets.filter((t) => t.status === 'accepted').length;
  if (targets.length === 0 || ok === 0) return targets.some((t) => t.status === 'unknown') ? 'unknown' : 'failed';
  return ok === targets.length ? 'accepted' : 'partially_applied';
}

export class DndProbe {
  constructor(
    private readonly backend: DndBackend,
    private readonly store: SnapshotStore,
  ) {}

  // The snapshot reaches disk before any write; if it cannot be saved nothing is dispatched.
  async apply(devices: string[], desired: boolean, options: { allowUnknownInitial?: boolean } = {}) {
    let current: Record<string, DndValue>;
    try {
      current = await this.backend.read();
    } catch {
      return { outcome: { status: 'not_dispatched' } as Outcome, snapshot: null };
    }
    const snapshot: DndSnapshot = {
      operationId: randomUUID(),
      desired,
      devices: devices.map((serial) => {
        const original = current[serial] ?? 'unknown';
        const state: DeviceState = original === 'unknown' && !options.allowUnknownInitial
          ? 'blocked_unknown_initial'
          : original === desired ? 'unchanged' : 'pending';
        return { serial, original, state };
      }),
    };
    try {
      await this.store.save(snapshot);
    } catch {
      return { outcome: { status: 'not_dispatched' } as Outcome, snapshot: null };
    }

    const targets: TargetOutcome[] = [];
    for (const device of snapshot.devices) {
      if (device.state !== 'pending') continue;
      let outcome: Outcome;
      try {
        outcome = await this.backend.write(device.serial, desired);
      } catch {
        outcome = { status: 'unknown' };
      }
      const accepted = outcome.status === 'accepted' || outcome.status === 'verified';
      device.state = accepted ? 'set' : outcome.status === 'unknown' ? 'set_unknown' : 'set_failed';
      targets.push({ target: device.serial, status: accepted ? 'accepted' : outcome.status === 'unknown' ? 'unknown' : 'failed' });
      await this.store.save(snapshot).catch(() => undefined);
    }
    const blocked = snapshot.devices.filter((d) => d.state === 'blocked_unknown_initial');
    const status = targets.length === 0 ? (blocked.length > 0 ? 'rejected' : 'accepted') : summarize(targets);
    return { outcome: { status, targets } as Outcome, snapshot };
  }

  // Restores each recorded original value; never overwrites a value this probe did not set.
  async restore(options: { ownerDirected?: boolean } = {}) {
    const snapshot = await this.store.load();
    if (!snapshot) return { outcome: { status: 'not_dispatched' } as Outcome, snapshot: null };
    let current: Record<string, DndValue>;
    try {
      current = await this.backend.read();
    } catch {
      return { outcome: { status: 'unknown' } as Outcome, snapshot };
    }

    const targets: TargetOutcome[] = [];
    for (const device of snapshot.devices) {
      if (!['pending', 'set', 'set_unknown', 'restore_failed', 'attribution_uncertain'].includes(device.state)) continue;
      const now = current[device.serial] ?? 'unknown';
      if (now === 'unknown') {
        targets.push({ target: device.serial, status: 'unknown' });
        continue;
      }
      if (now === device.original && device.state !== 'attribution_uncertain' && device.state !== 'set') {
        device.state = 'not_changed'; // a restart before the write took effect: nothing to undo
        continue;
      }
      if (now !== snapshot.desired) {
        device.state = 'conflict'; // changed by someone else since this probe set it
        targets.push({ target: device.serial, status: 'failed' });
        continue;
      }
      if (!this.backend.hasRevisionHistory && !options.ownerDirected) {
        device.state = 'attribution_uncertain';
        targets.push({ target: device.serial, status: 'unknown' });
        continue;
      }
      if (device.original === 'unknown') {
        targets.push({ target: device.serial, status: 'unknown' });
        continue;
      }
      let outcome: Outcome;
      try {
        outcome = await this.backend.write(device.serial, device.original);
      } catch {
        outcome = { status: 'unknown' };
      }
      const accepted = outcome.status === 'accepted' || outcome.status === 'verified';
      device.state = accepted ? 'restored' : 'restore_failed';
      targets.push({ target: device.serial, status: accepted ? 'accepted' : outcome.status === 'unknown' ? 'unknown' : 'failed' });
    }
    await this.store.save(snapshot).catch(() => undefined);
    const status = targets.length === 0 ? 'accepted' : summarize(targets);
    return { outcome: { status, targets } as Outcome, snapshot };
  }
}

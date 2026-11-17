import type { AlexaPort } from './ports.js';
import { readDeviceState, type StateItem } from './read-probes.js';
import type { SessionHealth } from './session-manager.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const MAX_STATE_IDS = 25;
export const DEFAULT_FRESHNESS_SECONDS = 600;

export interface DeviceSummary {
  id: string;
  name: string | 'unknown';
  kind: string | 'unknown';
  capabilities: string[];
}

export type ListDevicesResult =
  | { status: 'ok'; fetchedAt: string; devices: DeviceSummary[]; skipped: number }
  | { status: 'session_unavailable'; health: SessionHealth }
  | { status: 'failed'; fetchedAt: string; reason: 'read_failed' | 'unexpected_shape' };

export interface DeviceStateEntry {
  id: string;
  status: 'ok' | 'stale' | 'error';
  items: Array<StateItem & { freshness: 'current' | 'stale' | 'unknown' }>;
  error?: 'read_failed' | 'compatibility_error' | 'no_state';
}

export type DeviceStatesResult =
  | { status: 'ok' | 'partial'; fetchedAt: string; devices: DeviceStateEntry[] }
  | { status: 'session_unavailable'; health: SessionHealth }
  | { status: 'rejected'; reason: 'too_many_ids' | 'no_ids' };

const usable = (health: SessionHealth) => health === 'usable';

export function deviceList(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return undefined;
  for (const key of ['smarthomeDevices', 'devices']) {
    const value = body[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function firstString(item: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof item[key] === 'string') return item[key];
  return undefined;
}

function summarize(item: unknown): DeviceSummary | undefined {
  if (!isRecord(item)) return undefined;
  const id = firstString(item, ['applianceId', 'entityId', 'id']);
  if (!id) return undefined;
  const types = item.applianceTypes;
  const kind = firstString(item, ['deviceType', 'entityType', 'type'])
    ?? (Array.isArray(types) && typeof types[0] === 'string' ? types[0] : undefined);
  const capabilities = Array.isArray(item.capabilities)
    ? item.capabilities.flatMap((c) => (isRecord(c) && typeof c.interfaceName === 'string' ? [c.interfaceName] : []))
    : [];
  return {
    id,
    name: firstString(item, ['friendlyName', 'name']) ?? 'unknown',
    kind: kind ?? 'unknown',
    capabilities,
  };
}

export async function listDevices(adapter: AlexaPort, health: SessionHealth, now: Date = new Date()): Promise<ListDevicesResult> {
  if (!usable(health)) return { status: 'session_unavailable', health };
  const fetchedAt = now.toISOString();
  let body: unknown;
  try {
    body = await adapter.smartHomeDevices();
  } catch {
    return { status: 'failed', fetchedAt, reason: 'read_failed' };
  }
  const list = deviceList(body);
  if (!list) return { status: 'failed', fetchedAt, reason: 'unexpected_shape' };
  const devices = list.flatMap((item) => summarize(item) ?? []);
  return { status: 'ok', fetchedAt, devices, skipped: list.length - devices.length };
}

export async function readStates(
  adapter: AlexaPort,
  health: SessionHealth,
  ids: string[],
  now: Date = new Date(),
  freshnessSeconds: number = DEFAULT_FRESHNESS_SECONDS,
): Promise<DeviceStatesResult> {
  if (!usable(health)) return { status: 'session_unavailable', health };
  if (ids.length === 0) return { status: 'rejected', reason: 'no_ids' };
  if (ids.length > MAX_STATE_IDS) return { status: 'rejected', reason: 'too_many_ids' };

  const devices: DeviceStateEntry[] = [];
  for (const id of ids) {
    const result = await readDeviceState(adapter, id, now);
    if (result.status !== 'ok') {
      devices.push({
        id,
        status: 'error',
        items: [],
        error: result.status === 'failed' ? 'read_failed' : result.status,
      });
      continue;
    }
    const items = result.items.map((item) => ({
      ...item,
      freshness: item.ageSeconds === 'unknown'
        ? 'unknown' as const
        : item.ageSeconds > freshnessSeconds ? 'stale' as const : 'current' as const,
    }));
    const allCurrent = items.length > 0 && items.every((i) => i.freshness === 'current');
    devices.push({ id, status: allCurrent ? 'ok' : 'stale', items });
  }
  const failed = devices.some((d) => d.status === 'error' || d.status === 'stale');
  return { status: failed ? 'partial' : 'ok', fetchedAt: now.toISOString(), devices };
}

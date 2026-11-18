import type { Catalog } from './catalog.js';
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
  // Present (false) only for devices no MCP tool supports yet; the owner's page shows them locked.
  supported?: false;
  // Present (false) for devices that can only be read, so the page offers no write setting.
  writable?: false;
}

export type ListDevicesResult =
  | { status: 'ok'; fetchedAt: string; devices: DeviceSummary[]; skipped: number }
  | { status: 'session_unavailable'; health: SessionHealth }
  | { status: 'failed'; fetchedAt: string; reason: 'read_failed' | 'unexpected_shape' };

export const MAX_FIND_TERMS = 8;

export type FindDevicesResult =
  | { status: 'ok'; fetchedAt: string; matches: Array<DeviceSummary & { catalog?: unknown; matched: number }>; matchedAllTerms: boolean; total: number }
  | Exclude<ListDevicesResult, { status: 'ok' }>;

// Ranks devices by how many of the terms appear in the name, kind, category or the owner's note. Returns only devices that
// match every term when any do, otherwise the best partial matches, so the agent gets a short list instead of the whole home.
export async function findDevices(
  adapter: AlexaPort,
  health: SessionHealth,
  terms: string[],
  limit: number,
  now: Date = new Date(),
  catalog?: Catalog,
): Promise<FindDevicesResult> {
  const listed = await listDevices(adapter, health, now, catalog);
  if (listed.status !== 'ok') return listed;
  const needles = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
  const scored = listed.devices.map((device) => {
    const entry = (device as { catalog?: { category?: string; description?: string } }).catalog;
    const haystack = [device.name, device.kind, entry?.category, entry?.description].join(' ').toLowerCase();
    return { ...device, matched: needles.filter((n) => haystack.includes(n)).length };
  }).filter((d) => d.matched > 0).sort((a, b) => b.matched - a.matched);
  const full = scored.filter((d) => d.matched === needles.length);
  const matches = (full.length > 0 ? full : scored).slice(0, limit);
  return { status: 'ok', fetchedAt: listed.fetchedAt, matches, matchedAllTerms: full.length > 0, total: scored.length };
}

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

// Alexa types the bridge has a tool for (control or state reads). Anything else stays locked out until support is added.
export const SUPPORTED_KINDS: ReadonlySet<string> = new Set([
  'LIGHT', 'SWITCH', 'SMARTPLUG', 'EXTERIOR_BLIND', 'INTERIOR_BLIND', 'THERMOSTAT', 'AIR_CONDITIONER', 'HEATER', 'WATER_HEATER', 'FAN',
  'CONTACT_SENSOR', 'MOTION_SENSOR', 'TEMPERATURE_SENSOR',
]);

function typesOf(item: Record<string, unknown>): string[] {
  const legacy = isRecord(item.legacyAppliance) ? item.legacyAppliance : {};
  const primary = isRecord(item.displayCategories) && isRecord(item.displayCategories.primary)
    ? item.displayCategories.primary.value
    : undefined;
  return [item.applianceTypes, legacy.applianceTypes, primary, item.deviceType, item.entityType, item.type].flat()
    .filter((t): t is string => typeof t === 'string');
}

export const isSupportedDevice = (item: unknown): boolean =>
  isRecord(item) && typesOf(item).some((t) => SUPPORTED_KINDS.has(t));

// Only these types have a write tool; the rest of the supported types are read-only (sensors).
const WRITABLE_KINDS: ReadonlySet<string> = new Set([
  'LIGHT', 'SWITCH', 'SMARTPLUG', 'EXTERIOR_BLIND', 'INTERIOR_BLIND', 'THERMOSTAT', 'AIR_CONDITIONER', 'HEATER', 'WATER_HEATER', 'FAN',
]);

export const isWritableDevice = (item: unknown): boolean =>
  isRecord(item) && typesOf(item).some((t) => WRITABLE_KINDS.has(t));

function summarize(item: unknown): DeviceSummary | undefined {
  if (!isRecord(item)) return undefined;
  const id = firstString(item, ['applianceId', 'entityId', 'id']);
  if (!id) return undefined;
  const legacy = isRecord(item.legacyAppliance) ? item.legacyAppliance : {};
  const types = typesOf(item);
  const kind = firstString(item, ['deviceType', 'entityType', 'type']) ?? types[0];
  const rawCapabilities = Array.isArray(item.capabilities) ? item.capabilities : legacy.capabilities;
  const capabilities = Array.isArray(rawCapabilities)
    ? rawCapabilities.flatMap((c) => (isRecord(c) && typeof c.interfaceName === 'string' ? [c.interfaceName] : []))
    : [];
  return {
    id,
    name: firstString(item, ['friendlyName', 'name']) ?? 'unknown',
    kind: kind ?? 'unknown',
    capabilities,
    ...(isSupportedDevice(item) ? {} : { supported: false }),
    ...(isWritableDevice(item) ? {} : { writable: false }),
  };
}

export async function listDevices(
  adapter: AlexaPort,
  health: SessionHealth,
  now: Date = new Date(),
  catalog?: Catalog,
  includeDisabled = false,
): Promise<ListDevicesResult> {
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
  const devices = list.flatMap((item) => {
    const summary = summarize(item);
    const entry = summary ? catalog?.get(summary.id) : undefined;
    if (!summary) return [];
    if (!includeDisabled && (entry?.disabled || summary.supported === false)) return [];
    return [entry ? { ...summary, catalog: entry } : summary];
  });
  const hidden = includeDisabled ? 0 : list.filter((item) => {
    const summary = summarize(item);
    return summary !== undefined && (catalog?.get(summary.id)?.disabled || summary.supported === false);
  }).length;
  return { status: 'ok', fetchedAt, devices, skipped: list.length - devices.length - hidden };
}

export async function readStates(
  adapter: AlexaPort,
  health: SessionHealth,
  ids: string[],
  now: Date = new Date(),
  freshnessSeconds: number = DEFAULT_FRESHNESS_SECONDS,
  catalog?: Catalog,
): Promise<DeviceStatesResult> {
  if (!usable(health)) return { status: 'session_unavailable', health };
  if (ids.length === 0) return { status: 'rejected', reason: 'no_ids' };
  if (ids.length > MAX_STATE_IDS) return { status: 'rejected', reason: 'too_many_ids' };

  const devices: DeviceStateEntry[] = [];
  // Devices no tool supports are unreadable too; if the inventory cannot be read, nothing is read (fail closed).
  const unsupported = new Set<string>();
  // The state API only understands legacy appliance IDs, whichever ID the client used.
  const legacyIds = new Map<string, string>();
  try {
    for (const item of deviceList(await adapter.smartHomeDevices()) ?? []) {
      if (!isRecord(item)) continue;
      const legacy = isRecord(item.legacyAppliance) ? item.legacyAppliance : {};
      const keys = [item.applianceId, item.entityId, item.id, legacy.applianceId, legacy.entityId];
      const legacyId = legacy.applianceId ?? item.applianceId;
      for (const key of keys) {
        if (typeof key !== 'string') continue;
        if (!isSupportedDevice(item)) unsupported.add(key);
        else if (typeof legacyId === 'string' && legacyId !== '') legacyIds.set(key, legacyId);
      }
    }
  } catch {
    return { status: 'partial', fetchedAt: now.toISOString(), devices: ids.map((id) => ({ id, status: 'error' as const, items: [], error: 'read_failed' as const })) };
  }
  for (const id of ids) {
    if (catalog?.get(id)?.disabled || unsupported.has(id)) {
      devices.push({ id, status: 'error', items: [], error: 'no_state' });
      continue;
    }
    const result = await readDeviceState(adapter, legacyIds.get(id) ?? id, now);
    if (result.status !== 'ok') {
      devices.push({
        id,
        status: 'error',
        items: [],
        error: result.status === 'failed' ? 'read_failed' : result.status,
      });
      continue;
    }
    if (result.items.length === 0) {
      devices.push({ id, status: 'error', items: [], error: 'no_state' });
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

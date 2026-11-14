import type { AlexaAdapter } from './alexa-adapter.js';

export type FamilyName = 'echo' | 'smartHome' | 'groups' | 'routines';
export type FamilyResult =
  | { status: 'ok'; count: number; kinds: Record<string, number> }
  | { status: 'empty' }
  | { status: 'failed'; reason: 'read_failed' | 'unexpected_shape' };

type ReadAdapter = Pick<AlexaAdapter, 'echoDevices' | 'smartHomeDevices' | 'smartHomeGroups' | 'routines' | 'deviceState'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const LIST_KEYS: Record<FamilyName, string[]> = {
  echo: ['devices'],
  smartHome: ['smarthomeDevices', 'devices'],
  groups: ['groups', 'smarthomeGroups'],
  routines: ['automations', 'routines'],
};

function extractList(body: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return undefined;
  for (const key of keys) {
    const value = body[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function kindOf(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  for (const key of ['deviceType', 'entityType', 'type']) {
    if (typeof item[key] === 'string') return item[key];
  }
  const types = item.applianceTypes;
  if (Array.isArray(types) && typeof types[0] === 'string') return types[0];
  const categories = item.displayCategories;
  if (isRecord(categories) && isRecord(categories.primary) && typeof categories.primary.value === 'string') return categories.primary.value;
  return undefined;
}

export function summarizeFamily(family: FamilyName, body: unknown): FamilyResult {
  const list = extractList(body, LIST_KEYS[family]);
  if (!list) return { status: 'failed', reason: 'unexpected_shape' };
  if (list.length === 0) return { status: 'empty' };
  const kinds: Record<string, number> = {};
  for (const item of list) {
    const kind = kindOf(item) ?? 'unknown';
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return { status: 'ok', count: list.length, kinds };
}

// Each family is read independently so one failure never hides the others.
export async function readInventory(adapter: ReadAdapter, now: Date = new Date()) {
  const readers: Record<FamilyName, () => Promise<unknown>> = {
    echo: () => adapter.echoDevices(),
    smartHome: () => adapter.smartHomeDevices(),
    groups: () => adapter.smartHomeGroups(),
    routines: () => adapter.routines(2000),
  };
  const families = {} as Record<FamilyName, FamilyResult>;
  for (const family of Object.keys(readers) as FamilyName[]) {
    try {
      families[family] = summarizeFamily(family, await readers[family]());
    } catch {
      families[family] = { status: 'failed', reason: 'read_failed' };
    }
  }
  return { fetchedAt: now.toISOString(), families };
}

export interface StateItem {
  namespace: string | 'unknown';
  property: string | 'unknown';
  value: unknown;
  timeOfSample: string | 'unknown';
  ageSeconds: number | 'unknown';
}

export type StateReadResult =
  | { status: 'ok'; fetchedAt: string; cache: 'live'; items: StateItem[]; errors: string[] }
  | { status: 'compatibility_error'; fetchedAt: string }
  | { status: 'no_state'; fetchedAt: string }
  | { status: 'failed'; fetchedAt: string };

function parseCapability(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(raw) ? raw : undefined;
}

export function interpretState(body: unknown, now: Date): StateReadResult {
  const fetchedAt = now.toISOString();
  if (!isRecord(body) || !Array.isArray(body.deviceStates) || (body.errors !== undefined && !Array.isArray(body.errors))) {
    return { status: 'compatibility_error', fetchedAt };
  }
  const errors = (body.errors ?? []).map((e: unknown) =>
    isRecord(e) && typeof e.code === 'string' ? e.code : 'UNKNOWN');
  const items: StateItem[] = [];
  for (const device of body.deviceStates) {
    if (!isRecord(device)) return { status: 'compatibility_error', fetchedAt };
    const states: unknown = device.capabilityStates;
    if (!Array.isArray(states)) {
      items.push({ namespace: 'unknown', property: 'unknown', value: 'unknown', timeOfSample: 'unknown', ageSeconds: 'unknown' });
      continue;
    }
    for (const raw of states) {
      const state = parseCapability(raw);
      if (!state) return { status: 'compatibility_error', fetchedAt };
      const stamp = typeof state.timeOfSample === 'string' ? state.timeOfSample : undefined;
      const parsed = stamp ? Date.parse(stamp) : Number.NaN;
      items.push({
        namespace: typeof state.namespace === 'string' ? state.namespace : 'unknown',
        property: typeof state.name === 'string' ? state.name : 'unknown',
        value: 'value' in state ? state.value : 'unknown',
        timeOfSample: Number.isFinite(parsed) ? (stamp as string) : 'unknown',
        ageSeconds: Number.isFinite(parsed) ? Math.max(0, Math.round((now.getTime() - parsed) / 1000)) : 'unknown',
      });
    }
  }
  if (items.length === 0 && errors.length === 0) return { status: 'no_state', fetchedAt };
  return { status: 'ok', fetchedAt, cache: 'live', items, errors };
}

export async function readDeviceState(adapter: ReadAdapter, id: string, now: Date = new Date(), entityType?: string): Promise<StateReadResult> {
  try {
    return interpretState(await adapter.deviceState(id, entityType), now);
  } catch {
    return { status: 'failed', fetchedAt: now.toISOString() };
  }
}

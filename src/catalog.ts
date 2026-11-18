import { mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { CATEGORIES, type Category, type Mode } from './action-policy.js';

export class CatalogError extends Error {}

export type CatalogCategory = Exclude<Category, 'query'>;
export const PERMISSION_GROUPS = { 'low-risk': 'allow', 'requires-approval': 'approve', 'read-only': 'deny' } as const satisfies Record<string, Mode>;
export type PermissionGroup = keyof typeof PERMISSION_GROUPS;
export const GROUP_KINDS = ['room', 'level', 'house', 'aggregate'] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];
// "off" is an operation like any other: it has no built-in exemption from approval.
export const OPERATIONS = ['power_on', 'power_off', 'brightness', 'open', 'close', 'stop', 'step'] as const;
export type Operation = (typeof OPERATIONS)[number];
export type OperationModes = Partial<Record<Operation, Mode>>;
const OVERRIDE_MODES: readonly string[] = ['allow', 'approve', 'deny'];

export interface CatalogEntry {
  // Per-operation mode overriding the device's group or category mode.
  operations?: OperationModes;
  category: CatalogCategory;
  group?: PermissionGroup;
  groupKind?: GroupKind;
  members?: string[];
  description?: string;
  // A disabled device is invisible to MCP clients: not listed, not readable, not controllable.
  disabled?: boolean;
}

export type Catalog = ReadonlyMap<string, CatalogEntry>;
export const EMPTY_CATALOG: Catalog = new Map();

const MAX_ENTRIES = 2000;
const MAX_DESCRIPTION = 300;
const KEYS = new Set(['category', 'group', 'groupKind', 'members', 'description', 'disabled', 'operations']);
const CATALOG_CATEGORIES = CATEGORIES.filter((c): c is CatalogCategory => c !== 'query');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Descriptions reach the agent, so treat them as untrusted text: no control characters, bounded length.
// eslint-disable-next-line no-control-regex
const cleanText = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_DESCRIPTION);

function parseEntry(id: string, raw: unknown): CatalogEntry {
  const where = `device ${id.slice(0, 40)}`;
  if (!isRecord(raw)) throw new CatalogError(`catalog ${where}: entry must be an object`);
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) throw new CatalogError(`catalog ${where}: unknown field ${key.slice(0, 40)}`);
  const { category, group, groupKind, members, description, disabled, operations } = raw;
  if (typeof category !== 'string' || !(CATALOG_CATEGORIES as readonly string[]).includes(category)) {
    throw new CatalogError(`catalog ${where}: unknown category`);
  }
  const entry: CatalogEntry = { category: category as CatalogCategory };
  if (group !== undefined) {
    if (typeof group !== 'string' || !Object.hasOwn(PERMISSION_GROUPS, group)) throw new CatalogError(`catalog ${where}: unknown group`);
    entry.group = group as PermissionGroup;
  }
  if (disabled !== undefined) {
    if (typeof disabled !== 'boolean') throw new CatalogError(`catalog ${where}: disabled must be true or false`);
    if (disabled) entry.disabled = true;
  }
  if (operations !== undefined) {
    if (!isRecord(operations)) throw new CatalogError(`catalog ${where}: operations must be an object`);
    const parsed: OperationModes = {};
    for (const [name, mode] of Object.entries(operations)) {
      if (!(OPERATIONS as readonly string[]).includes(name)) throw new CatalogError(`catalog ${where}: unknown operation`);
      if (typeof mode !== 'string' || !OVERRIDE_MODES.includes(mode)) throw new CatalogError(`catalog ${where}: operation mode must be allow, approve or deny`);
      parsed[name as Operation] = mode as Mode;
    }
    if (Object.keys(parsed).length > 0) entry.operations = parsed;
  }
  if (groupKind !== undefined) {
    if (typeof groupKind !== 'string' || !(GROUP_KINDS as readonly string[]).includes(groupKind)) throw new CatalogError(`catalog ${where}: unknown groupKind`);
    entry.groupKind = groupKind as GroupKind;
  }
  if (members !== undefined) {
    if (!Array.isArray(members) || members.some((m) => typeof m !== 'string' || m === '')) throw new CatalogError(`catalog ${where}: members must be device IDs`);
    entry.members = [...members] as string[];
  }
  if (description !== undefined) {
    if (typeof description !== 'string') throw new CatalogError(`catalog ${where}: description must be text`);
    entry.description = cleanText(description);
  }
  return entry;
}

export function parseCatalog(text: string): Catalog {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CatalogError('catalog is not valid JSON');
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.devices)) throw new CatalogError('catalog must be {"version":1,"devices":{...}}');
  const ids = Object.keys(raw.devices);
  if (ids.length > MAX_ENTRIES) throw new CatalogError('catalog has too many devices');
  const entries = new Map<string, CatalogEntry>();
  for (const id of ids) entries.set(id, parseEntry(id, raw.devices[id]));
  for (const [id, entry] of entries) {
    for (const member of entry.members ?? []) {
      if (!entries.has(member)) throw new CatalogError(`catalog device ${id.slice(0, 40)}: member is not a catalog device`);
    }
  }
  return entries;
}

export const serializeCatalog = (catalog: Catalog): string =>
  `${JSON.stringify({ version: 1, devices: Object.fromEntries(catalog) }, null, 2)}\n`;

// A missing file is an empty catalog; an unreadable or invalid one stops startup rather than loosening policy.
export function loadCatalogFile(path: string): Catalog {
  if (!existsSync(path)) return EMPTY_CATALOG;
  return parseCatalog(readFileSync(path, 'utf8'));
}

// Writes a temp file, flushes it, keeps one previous copy and renames into place.
export function saveCatalogFile(path: string, catalog: Catalog): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, serializeCatalog(catalog));
  const handle = openSync(temp, 'r+');
  try { fsyncSync(handle); } finally { closeSync(handle); }
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(temp, path);
}

// Holds the live catalog so an approved edit takes effect on the next call; persists to the file when one is configured.
export class CatalogStore {
  constructor(private catalog: Catalog = EMPTY_CATALOG, private readonly path?: string) {}

  get(): Catalog {
    return this.catalog;
  }

  replace(next: Catalog): void {
    if (this.path) saveCatalogFile(this.path, next);
    this.catalog = next;
  }
}

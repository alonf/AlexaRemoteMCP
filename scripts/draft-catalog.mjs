/* global console, process */
// Drafts a private device catalog from the Alexa inventory and a KNX gateway device list.
// Usage: node scripts/draft-catalog.mjs <alexa-session.json> <knx-devices.json> [outDir=private]
// Output stays in a git-ignored directory; nothing household-specific is committed.
import fs from 'node:fs';
import path from 'node:path';
import AlexaRemote from 'alexa-remote2';
import { AlexaAdapter } from '../dist/src/alexa-adapter.js';
import { AlexaSessionBackend } from '../dist/src/alexa-session-backend.js';
import { deviceList } from '../dist/src/inventory.js';

const [sessionPath, knxPath, outDir = 'private'] = process.argv.slice(2);
if (!sessionPath || !knxPath) {
  console.error('usage: node scripts/draft-catalog.mjs <alexa-session.json> <knx-devices.json> [outDir]');
  process.exit(2);
}
if (!path.resolve(outDir).split(path.sep).some((part) => ['private', 'local', 'tmp', 'temp', 'data'].includes(part))) {
  console.error('refusing to write outside a git-ignored directory (private, local, tmp, temp, data)');
  process.exit(2);
}

const isRec = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const KNX_CATEGORY = { 1: 'light', 2: 'heater', 3: 'outlet', 4: 'ac', 5: 'cover' };
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\u0590-\u05ff]+/g, ' ').trim();

const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
const backend = new AlexaSessionBackend({ remoteConstructor: AlexaRemote, cookieHelper: {} });
await backend.initialize(session);
const adapter = new AlexaAdapter(backend.client);
const groups = await adapter.smartHomeGroups();
const alexa = deviceList(await adapter.smartHomeDevices()).map((d) => {
  const legacy = isRec(d.legacyAppliance) ? d.legacyAppliance : {};
  const rawCaps = Array.isArray(d.capabilities) ? d.capabilities : legacy.capabilities;
  const caps = (Array.isArray(rawCaps) ? rawCaps : []).map((c) => (isRec(c) ? c.interfaceName : undefined)).filter(Boolean);
  const types = [d.applianceTypes, legacy.applianceTypes, isRec(d.displayCategories) && isRec(d.displayCategories.primary) ? d.displayCategories.primary.value : undefined]
    .flat().filter((x) => typeof x === 'string');
  return { id: d.applianceId ?? d.entityId ?? d.id, ids: [d.applianceId, d.entityId, d.id, legacy.applianceId, legacy.entityId].filter(Boolean), name: d.friendlyName ?? d.name ?? '', types: [...new Set(types)], caps: [...new Set(caps)] };
}).filter((d) => d.id);
backend.stop();

const groupsOf = new Map();
for (const g of Array.isArray(groups?.applianceGroups) ? groups.applianceGroups : []) {
  const members = [...(g.applianceIds ?? []), ...(g.chrEndpoints ?? []).map((e) => e?.entityId)].filter((x) => typeof x === 'string');
  if (typeof g.name === 'string') for (const m of members) groupsOf.set(m, [...(groupsOf.get(m) ?? []), g.name]);
}

const knx = JSON.parse(fs.readFileSync(knxPath, 'utf8'));
const knxByName = new Map();
for (const k of knx) for (const n of [k.EName, k.Name]) if (n) knxByName.set(norm(n), k);

const catalog = {};
const review = [];
for (const d of alexa) {
  const k = knxByName.get(norm(d.name));
  let entry;
  if (k && KNX_CATEGORY[k.DeviceClass]) {
    entry = { category: KNX_CATEGORY[k.DeviceClass] };
  } else if (d.types.some((t) => /LIGHT/.test(t))) {
    entry = { category: 'light' };
  } else if (d.types.some((t) => /AIR_CONDITIONER|THERMOSTAT/.test(t))) entry = { category: 'ac' };
  else if (d.types.some((t) => /BLIND|SHUTTER|CURTAIN|GARAGE|DOOR/.test(t))) entry = { category: 'cover' };
  else if (d.types.includes('SMARTPLUG') || (d.types.includes('SWITCH') && /outlet|plug/i.test(d.name))) entry = { category: 'outlet' };
  else if (d.types.includes('SWITCH') && /air.?condition|\bac\b/i.test(d.name)) entry = { category: 'ac' };
  else if (d.types.includes('SWITCH') && /heater|boiler/i.test(d.name)) entry = { category: 'heater' };
  else entry = { category: 'other' };
  const group = { light: 'low-risk', ac: 'low-risk', cover: 'requires-approval', heater: 'requires-approval', outlet: 'requires-approval' }[entry.category];
  entry.group = group ?? 'read-only';
  const note = [
    k?.RoomName && `Room: ${k.RoomName}`,
    k?.LevelName && `Level: ${k.LevelName}`,
    k && `KNX #${k.Id}`,
    [...new Set(d.ids.flatMap((i) => groupsOf.get(i) ?? []))].length && `Alexa groups: ${[...new Set(d.ids.flatMap((i) => groupsOf.get(i) ?? []))].join(', ')}`,
  ].filter(Boolean).join('. ');
  if (note) entry.description = note.slice(0, 300);
  catalog[d.id] = entry;
  review.push({ id: d.id, name: d.name, types: d.types, room: k?.RoomName ?? '', level: k?.LevelName ?? '', matchedKnx: k ? { id: k.Id, name: k.EName || k.Name, class: k.DeviceClass } : null, ...entry });
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'device-catalog.json'), JSON.stringify({ version: 1, devices: catalog }, null, 2));
fs.writeFileSync(path.join(outDir, 'catalog-review.json'), JSON.stringify(review, null, 2));
const counts = {};
for (const e of Object.values(catalog)) counts[`${e.category}/${e.group}`] = (counts[`${e.category}/${e.group}`] ?? 0) + 1;
console.log(`alexa=${alexa.length} knx=${knx.length} matched=${review.filter((r) => r.matchedKnx).length}`);
console.log(counts);
process.exit(0);

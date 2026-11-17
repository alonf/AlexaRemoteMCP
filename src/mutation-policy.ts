import { excludedClass, type DeviceDescriptor } from './excluded-devices.js';
import { deviceList } from './inventory.js';
import type { AlexaPort } from './ports.js';

export type MutationAction = 'power' | 'brightness';

const REQUIRED_CAPABILITY: Record<MutationAction, string> = {
  power: 'Alexa.PowerController',
  brightness: 'Alexa.BrightnessController',
};

// Classes that must never be mutated through this service, on top of the shared excluded list.
const REFUSED_CLASSES = [
  'SHUTTER', 'BLIND', 'SHADE', 'CURTAIN', 'AWNING', 'HEATER', 'AIR_CONDITIONER', 'THERMOSTAT', 'FAN', 'LOCK', 'GATE', 'DOOR', 'GARAGE',
];

export type PolicyRefusal =
  | 'target_not_allowed'
  | 'device_not_found'
  | 'inventory_unavailable'
  | 'safety_class'
  | 'unknown_class'
  | 'unsupported_capability';

export type PolicyDecision = { allowed: true; controlId: string } | { allowed: false; reason: PolicyRefusal };

export interface MutationPolicy {
  // Device IDs the owner has allow-listed. Anything else is refused, whatever the client sends.
  allowedTargets: ReadonlySet<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const legacyOf = (device: Record<string, unknown>): Record<string, unknown> =>
  (isRecord(device.legacyAppliance) ? device.legacyAppliance : {});

function classTokens(device: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string') out.push(value.toUpperCase());
    else if (Array.isArray(value)) value.forEach(add);
  };
  const legacy = legacyOf(device);
  add(device.applianceTypes);
  add(device.deviceType);
  add(device.entityType);
  add(legacy.applianceTypes);
  add(isRecord(device.displayCategories) && isRecord(device.displayCategories.primary) ? device.displayCategories.primary.value : undefined);
  return out;
}

function capabilityNames(device: Record<string, unknown>): string[] {
  const raw = Array.isArray(device.capabilities) ? device.capabilities : legacyOf(device).capabilities;
  return Array.isArray(raw)
    ? raw.flatMap((c) => (isRecord(c) && typeof c.interfaceName === 'string' ? [c.interfaceName] : []))
    : [];
}

export function judgeDevice(device: Record<string, unknown>, action: MutationAction): { allowed: true } | { allowed: false; reason: PolicyRefusal } {
  const tokens = classTokens(device);
  if (excludedClass(device as DeviceDescriptor) || tokens.some((t) => REFUSED_CLASSES.some((c) => t.includes(c)))) {
    return { allowed: false, reason: 'safety_class' };
  }
  if (!tokens.includes('LIGHT')) return { allowed: false, reason: 'unknown_class' };
  if (!capabilityNames(device).includes(REQUIRED_CAPABILITY[action])) return { allowed: false, reason: 'unsupported_capability' };
  return { allowed: true };
}

// Reads the inventory (no write) and decides whether this target and action may be dispatched.
export async function evaluateMutationPolicy(
  adapter: Pick<AlexaPort, 'smartHomeDevices'>,
  policy: MutationPolicy,
  targetId: string,
  action: MutationAction,
): Promise<PolicyDecision> {
  if (!policy.allowedTargets.has(targetId)) return { allowed: false, reason: 'target_not_allowed' };
  let body: unknown;
  try {
    body = await adapter.smartHomeDevices();
  } catch {
    return { allowed: false, reason: 'inventory_unavailable' };
  }
  const list = deviceList(body);
  if (!list) return { allowed: false, reason: 'inventory_unavailable' };
  const device = list.find((item): item is Record<string, unknown> =>
    isRecord(item) && [item.applianceId, item.entityId, item.id, legacyOf(item).applianceId, legacyOf(item).entityId].includes(targetId));
  if (!device) return { allowed: false, reason: 'device_not_found' };
  const judged = judgeDevice(device, action);
  if (!judged.allowed) return judged;
  // The write and state APIs only accept the legacy appliance ID, whichever ID the client used.
  const legacyId = legacyOf(device).applianceId ?? device.applianceId;
  return { allowed: true, controlId: typeof legacyId === 'string' && legacyId !== '' ? legacyId : targetId };
}

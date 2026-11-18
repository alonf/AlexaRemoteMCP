import { type ActionModes, categorize, LEGACY_MODES, type Category } from './action-policy.js';
import { type CatalogEntry, type CatalogStore, type Operation, PERMISSION_GROUPS } from './catalog.js';
import { deviceList, isSupportedDevice, isWritableDevice } from './inventory.js';
import type { AlexaPort } from './ports.js';

export type MutationAction = 'power' | 'brightness' | 'position';
export type PositionDirection = 'open' | 'close' | 'stop_up' | 'stop_down' | 'step_up' | 'step_down';

// A stop is a step in the direction of travel: the skill's own Position.Stop is a step down, which would reverse a rising shutter.
const POSITION_MODE: Record<PositionDirection, string> = {
  open: 'Position.Up',
  close: 'Position.Down',
  stop_up: 'Position.StepUp',
  stop_down: 'Position.StepDown',
  step_up: 'Position.StepUp',
  step_down: 'Position.StepDown',
};

const REQUIRED_CAPABILITY: Record<MutationAction, string> = {
  power: 'Alexa.PowerController',
  brightness: 'Alexa.BrightnessController',
  position: 'Alexa.ModeController',
};

export type PolicyRefusal =
  | 'target_not_allowed'
  | 'device_not_found'
  | 'inventory_unavailable'
  | 'safety_class'
  | 'unknown_class'
  | 'category_denied'
  | 'unsupported_capability';

export type PolicyDecision =
  | {
    allowed: true;
    controlId: string;
    mode: 'allow' | 'approve';
    category: Exclude<Category, 'query'>;
    label: string;
    // Set when the device needs action-specific parameters (position); otherwise the caller's defaults apply.
    parameters?: unknown;
  }
  | { allowed: false; reason: PolicyRefusal };

export interface MutationPolicy {
  // Device IDs the owner has allow-listed; `*` means every device in an allowed category. It only narrows the modes.
  allowedTargets: ReadonlySet<string>;
  // Mode per category. Unset means the Milestone B behaviour (lights only).
  modes?: ActionModes;
  // Private per-device categories and permission groups; absent means class-based categories only.
  catalog?: Pick<CatalogStore, 'get'>;
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

function capabilities(device: Record<string, unknown>): Record<string, unknown>[] {
  const raw = Array.isArray(device.capabilities) ? device.capabilities : legacyOf(device).capabilities;
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

const capabilityNames = (device: Record<string, unknown>): string[] =>
  capabilities(device).flatMap((c) => (typeof c.interfaceName === 'string' ? [c.interfaceName] : []));

// Shown to the owner when approving, so strip control characters and bound the length.
function labelOf(device: Record<string, unknown>, fallback: string): string {
  const legacy = legacyOf(device);
  const name = [device.friendlyName, device.displayName, device.name, legacy.friendlyName, legacy.friendlyDescription]
    .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  // eslint-disable-next-line no-control-regex
  return (name ?? fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
}

// Cover open/close is a ModeController instance with Position.Up / Position.Down. The write payload built from it
// uses the setModeValue action (a plain setMode is refused by the live API with InvalidParameters).
function positionParameters(device: Record<string, unknown>, direction: PositionDirection): unknown {
  const mode = capabilities(device).find((c) => c.interfaceName === 'Alexa.ModeController');
  const supported = isRecord(mode?.configuration) && Array.isArray(mode.configuration.supportedModes)
    ? mode.configuration.supportedModes.flatMap((m) => (isRecord(m) && typeof m.value === 'string' ? [m.value] : []))
    : [];
  const wanted = POSITION_MODE[direction];
  if (typeof mode?.instance !== 'string' || !supported.includes(wanted)) return undefined;
  return { action: 'setModeValue', instance: mode.instance, mode: wanted };
}

const REFUSAL_FOR_DENIED: Record<Exclude<Category, 'query' | 'light'>, PolicyRefusal> = {
  cover: 'safety_class', heater: 'safety_class', ac: 'safety_class', outlet: 'unknown_class', access: 'safety_class', other: 'unknown_class',
};

export function judgeDevice(
  device: Record<string, unknown>,
  action: MutationAction,
  modes: ActionModes,
  entry?: CatalogEntry,
  operation?: Operation,
): { allowed: false; reason: PolicyRefusal } | { allowed: true; mode: 'allow' | 'approve'; category: Exclude<Category, 'query'> } {
  const guessed = categorize(classTokens(device));
  if (guessed === 'blocked') return { allowed: false, reason: 'safety_class' };
  const category = entry?.category ?? guessed;
  const override = operation ? entry?.operations?.[operation] : undefined;
  const mode = override ?? (entry?.group ? PERMISSION_GROUPS[entry.group] : modes[category]);
  if (mode === 'deny') return { allowed: false, reason: category === 'light' || entry?.group || override ? 'category_denied' : REFUSAL_FOR_DENIED[category] };
  if (!capabilityNames(device).includes(REQUIRED_CAPABILITY[action])) return { allowed: false, reason: 'unsupported_capability' };
  return { allowed: true, mode, category };
}

// Reads the inventory (no write) and decides whether this target and action may be dispatched.
export async function evaluateMutationPolicy(
  adapter: Pick<AlexaPort, 'smartHomeDevices'>,
  policy: MutationPolicy,
  targetId: string,
  action: MutationAction,
  direction?: PositionDirection,
  operation?: Operation,
): Promise<PolicyDecision> {
  if (!policy.allowedTargets.has('*') && !policy.allowedTargets.has(targetId)) return { allowed: false, reason: 'target_not_allowed' };
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
  const ids = [device.applianceId, device.entityId, device.id, legacyOf(device).applianceId, legacyOf(device).entityId];
  const entry = ids.flatMap((id) => (typeof id === 'string' && policy.catalog?.get().get(id) ? [policy.catalog.get().get(id)] : []))[0];
  if (entry?.disabled) return { allowed: false, reason: 'device_not_found' };
  const judged = judgeDevice(device, action, policy.modes ?? LEGACY_MODES, entry, operation);
  if (!judged.allowed) return judged;
  if (!isSupportedDevice(device)) return { allowed: false, reason: 'device_not_found' };
  if (!isWritableDevice(device)) return { allowed: false, reason: 'unsupported_capability' };
  const parameters = action === 'position' && direction ? positionParameters(device, direction) : undefined;
  if (action === 'position' && parameters === undefined) return { allowed: false, reason: 'unsupported_capability' };
  // The write and state APIs only accept the legacy appliance ID, whichever ID the client used.
  const legacyId = legacyOf(device).applianceId ?? device.applianceId;
  return {
    allowed: true,
    controlId: typeof legacyId === 'string' && legacyId !== '' ? legacyId : targetId,
    mode: judged.mode,
    category: judged.category,
    label: labelOf(device, targetId),
    ...(parameters !== undefined ? { parameters } : {}),
  };
}

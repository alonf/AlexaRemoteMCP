const EXCLUDED = [
  'LOCK', 'THERMOSTAT', 'DOOR', 'GARAGE', 'GATE', 'SECURITY', 'ALARM', 'SMOKE', 'CO_DETECTOR', 'CAMERA', 'VALVE',
];

export interface DeviceDescriptor {
  applianceTypes?: unknown;
  entityType?: unknown;
  deviceType?: unknown;
  capabilities?: unknown;
}

function tokens(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  if (typeof value === 'string') out.push(value.toUpperCase());
  else if (Array.isArray(value)) value.forEach((item) => tokens(item, out, depth + 1));
  else if (value !== null && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => tokens(item, out, depth + 1));
  }
  return out;
}

// Class comes from structural type fields only, never device names; a missing class is not proof of safety.
export function excludedClass(device: DeviceDescriptor): string | undefined {
  const found = tokens([device.applianceTypes, device.entityType, device.deviceType, device.capabilities]);
  return EXCLUDED.find((word) => found.some((token) => token.includes(word)));
}

export function assertNotExcluded(device: DeviceDescriptor): { allowed: true } | { allowed: false; status: 'rejected'; reason: string } {
  const hit = excludedClass(device);
  return hit ? { allowed: false, status: 'rejected', reason: `excluded device class: ${hit.toLowerCase()}` } : { allowed: true };
}

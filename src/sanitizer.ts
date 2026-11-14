// Allowlist sanitizer: only structural keys keep their string values; everything else becomes a synthetic label.
const KEEP_STRING_KEYS = new Set([
  'status', 'code', 'namespace', 'name_kind', 'interface', 'deviceType', 'entityType', 'type',
  'applianceTypes', 'capabilityKind', 'cache', 'fetchedAt', 'timeOfSample', 'timeOfObservation',
  'verifiedAt', 'source', 'reason', 'family', 'health', 'dndSnapshot', 'operation', 'state', 'property', 'definitionHash',
]);
// Enumerated state tokens such as ON, OFF or OK; anything free-form stays redacted.
const ENUM_VALUE_KEYS = new Set(['value']);
const ENUM_TOKEN = /^[A-Z][A-Z_]{1,24}$/;
const IDENTIFIER_KEYS = new Set([
  'name', 'friendlyName', 'accountName', 'serialNumber', 'deviceSerialNumber', 'entityId', 'applianceId',
  'id', 'automationId', 'sequenceId', 'roomName', 'groupName', 'target', 'email', 'address', 'location',
]);

export class Labeler {
  private readonly labels = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  label(kind: string, real: string): string {
    const key = `${kind}\u0000${real}`;
    let label = this.labels.get(key);
    if (!label) {
      const next = (this.counters.get(kind) ?? 0) + 1;
      this.counters.set(kind, next);
      label = `${kind}-${next}`;
      this.labels.set(key, label);
    }
    return label;
  }

  // The real-to-synthetic mapping belongs only in an ignored local file, never in evidence.
  mapping(): Record<string, string> {
    return Object.fromEntries([...this.labels].map(([key, label]) => [key.split('\u0000')[1] ?? '', label]));
  }
}

export function sanitizeEvidence(value: unknown, labeler: Labeler, key = '', depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'string') {
    if (IDENTIFIER_KEYS.has(key)) return labeler.label(key === 'name' || key === 'friendlyName' ? 'name' : 'id', value);
    if (ENUM_VALUE_KEYS.has(key) && ENUM_TOKEN.test(value)) return value;
    return KEEP_STRING_KEYS.has(key) ? value : '[redacted]';
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item, labeler, key, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        /^[A-Za-z_]+$/.test(k) ? k : labeler.label('key', k),
        sanitizeEvidence(v, labeler, k, depth + 1),
      ]),
    );
  }
  return '[redacted]';
}

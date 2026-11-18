export const CATEGORIES = ['query', 'light', 'cover', 'heater', 'ac', 'outlet', 'access', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
export const MODES = ['allow', 'approve', 'deny'] as const;
export type Mode = (typeof MODES)[number];
export type ActionModes = Readonly<Record<Category, Mode>>;

export class ActionPolicyError extends Error {}

const DENY_ALL: ActionModes = { query: 'deny', light: 'deny', cover: 'deny', heater: 'deny', ac: 'deny', outlet: 'deny', access: 'deny', other: 'deny' };

// Milestone B behaviour: reads and lights only. Used when ACTION_POLICY is unset.
export const LEGACY_MODES: ActionModes = { ...DENY_ALL, query: 'allow', light: 'allow' };

// Presets never enable `access` without approval, and never allow it silently.
const PRESETS: Readonly<Record<string, Partial<ActionModes>>> = {
  'read-only': { query: 'allow' },
  'lights-only': { query: 'allow', light: 'allow' },
  'lights-allow-rest-approve': {
    query: 'allow', light: 'allow', cover: 'approve',     heater: 'approve', ac: 'approve', outlet: 'approve', access: 'approve', other: 'approve',
  },
};

const isCategory = (value: string): value is Category => (CATEGORIES as readonly string[]).includes(value);
const isMode = (value: string): value is Mode => (MODES as readonly string[]).includes(value);

// Strict on purpose: an unknown token must stop startup rather than quietly widen or narrow access.
export function parseActionPolicy(value: string): ActionModes {
  const text = value.trim();
  if (text === '') throw new ActionPolicyError('ACTION_POLICY is empty');
  const preset = PRESETS[text];
  if (preset) return { ...DENY_ALL, ...preset };
  if (!text.includes('=')) throw new ActionPolicyError(`ACTION_POLICY has unknown preset: ${text}`);
  const modes: Record<Category, Mode> = { ...DENY_ALL };
  const seen = new Set<string>();
  for (const pair of text.split(',').map((item) => item.trim())) {
    const [category, mode, ...rest] = pair.split('=').map((item) => item.trim());
    if (!category || !mode || rest.length > 0) throw new ActionPolicyError(`ACTION_POLICY has a malformed pair: ${pair}`);
    if (!isCategory(category)) throw new ActionPolicyError(`ACTION_POLICY has unknown category: ${category}`);
    if (!isMode(mode)) throw new ActionPolicyError(`ACTION_POLICY has unknown mode: ${mode}`);
    if (seen.has(category)) throw new ActionPolicyError(`ACTION_POLICY repeats category: ${category}`);
    if (category === 'query' && mode === 'approve') throw new ActionPolicyError('ACTION_POLICY query cannot be approve; use allow or deny');
    seen.add(category);
    modes[category] = mode;
  }
  return modes;
}

// Classes that are never actioned here, whatever the policy says.
const BLOCKED = ['SECURITY', 'ALARM', 'SMOKE', 'CO_DETECTOR', 'CAMERA', 'VALVE'];
const RULES: ReadonlyArray<readonly [Exclude<Category, 'query' | 'other' | 'light'>, readonly string[]]> = [
  ['access', ['LOCK', 'GATE', 'DOOR', 'GARAGE']],
  ['cover', ['SHUTTER', 'BLIND', 'SHADE', 'CURTAIN', 'AWNING']],
  ['ac', ['AIR_CONDITIONER', 'THERMOSTAT']],
  ['heater', ['HEATER', 'FAN']],
  ['outlet', ['SMARTPLUG', 'OUTLET']],
];

// An unrecognised or missing class is `other`, which is never treated as safe by default.
export function categorize(tokens: readonly string[]): Exclude<Category, 'query'> | 'blocked' {
  if (BLOCKED.some((word) => tokens.some((token) => token.includes(word)))) return 'blocked';
  for (const [category, words] of RULES) {
    if (words.some((word) => tokens.some((token) => token.includes(word)))) return category;
  }
  return tokens.includes('LIGHT') ? 'light' : 'other';
}

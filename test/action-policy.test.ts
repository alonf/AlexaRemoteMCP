import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categorize, LEGACY_MODES, parseActionPolicy } from '../src/action-policy.js';
import { evaluateMutationPolicy, type MutationPolicy } from '../src/mutation-policy.js';
import { FakeAlexa } from './support/fake-alexa.js';

test('pairs and presets parse, and unlisted categories are denied', () => {
  assert.deepEqual(parseActionPolicy('query=allow,light=allow,cover=approve,heater=approve'), {
    query: 'allow', light: 'allow', cover: 'approve', heater: 'approve', ac: 'deny', outlet: 'deny', access: 'deny', other: 'deny',
  });
  assert.deepEqual(parseActionPolicy('lights-only'), LEGACY_MODES);
  assert.equal(parseActionPolicy('lights-allow-rest-approve').access, 'approve');
  assert.deepEqual(parseActionPolicy('read-only'), { ...LEGACY_MODES, light: 'deny' });
});

test('an invalid setting fails with the offending token and never falls back', () => {
  for (const [value, token] of [
    ['light=maybe', 'maybe'], ['lights=allow', 'lights'], ['nopreset', 'nopreset'], ['light=allow,light=deny', 'light'],
    ['light', 'light'], ['query=approve', 'query'], ['light=allow=deny', 'light=allow=deny'],
  ] as const) {
    assert.throws(() => parseActionPolicy(value), (error: Error) => error.message.includes(token), value);
  }
});

test('categories come from class tokens, and security-type classes are blocked', () => {
  assert.equal(categorize(['EXTERIOR_BLIND']), 'cover');
  assert.equal(categorize(['THERMOSTAT']), 'ac');
  assert.equal(categorize(['HEATER']), 'heater');
  assert.equal(categorize(['SMARTLOCK']), 'access');
  assert.equal(categorize(['LIGHT']), 'light');
  assert.equal(categorize([]), 'other');
  assert.equal(categorize(['SECURITY_PANEL', 'LIGHT']), 'blocked');
});

const mode = (types: string[], caps: unknown[] = [{ interfaceName: 'Alexa.PowerController' }]) => ({
  applianceId: 'd-1', friendlyName: 'Device', applianceTypes: types, capabilities: caps,
});
const run = async (device: unknown, policy: MutationPolicy, action: 'power' | 'position' = 'power', direction?: 'open' | 'close') =>
  evaluateMutationPolicy(new FakeAlexa({ devices: { smarthomeDevices: [device] } }), policy, 'd-1', action, direction);
const all = new Set(['*']);

test('allow, approve and deny apply per category, and the allow-list only narrows', async () => {
  const modes = parseActionPolicy('light=allow,heater=approve');
  const light = await run(mode(['LIGHT']), { allowedTargets: all, modes });
  assert.equal(light.allowed && light.mode, 'allow');
  const heater = await run(mode(['HEATER']), { allowedTargets: all, modes });
  assert.equal(heater.allowed && heater.mode, 'approve');
  assert.deepEqual(await run(mode(['EXTERIOR_BLIND']), { allowedTargets: all, modes }), { allowed: false, reason: 'safety_class' });
  assert.deepEqual(await run(mode(['TV']), { allowedTargets: all, modes }), { allowed: false, reason: 'unknown_class' });
  assert.deepEqual(await run(mode(['SECURITY_PANEL']), { allowedTargets: all, modes: parseActionPolicy('other=allow') }), { allowed: false, reason: 'safety_class' });
  assert.deepEqual(await run(mode(['LIGHT']), { allowedTargets: new Set(['someone-else']), modes }), { allowed: false, reason: 'target_not_allowed' });
  assert.deepEqual(await run(mode(['LIGHT']), { allowedTargets: all, modes: parseActionPolicy('cover=allow') }), { allowed: false, reason: 'category_denied' });
});

test('a cover opens and closes through its own ModeController instance and modes', async () => {
  const blind = mode(['EXTERIOR_BLIND'], [{
    interfaceName: 'Alexa.ModeController', instance: 'Blind.Position',
    configuration: { supportedModes: [{ value: 'Position.Up' }, { value: 'Position.Down' }] },
  }]);
  const policy = { allowedTargets: all, modes: parseActionPolicy('cover=approve') };
  const open = await run(blind, policy, 'position', 'open');
  assert.deepEqual(open.allowed && open.parameters, { action: 'setModeValue', instance: 'Blind.Position', mode: 'Position.Up' });
  const close = await run(blind, policy, 'position', 'close');
  assert.deepEqual(close.allowed && close.parameters, { action: 'setModeValue', instance: 'Blind.Position', mode: 'Position.Down' });
  assert.deepEqual(await run(blind, policy, 'power'), { allowed: false, reason: 'unsupported_capability' });
  assert.deepEqual(await run(mode(['EXTERIOR_BLIND']), policy, 'position', 'open'), { allowed: false, reason: 'unsupported_capability' });
});

test('the legacy default refuses everything but lights', async () => {
  assert.equal((await run(mode(['LIGHT']), { allowedTargets: all })).allowed, true);
  assert.deepEqual(await run(mode(['EXTERIOR_BLIND']), { allowedTargets: all }), { allowed: false, reason: 'safety_class' });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateMutationPolicy, type PolicyDecision } from '../src/mutation-policy.js';
import { FakeAlexa } from './support/fake-alexa.js';

// Compares the decision without the approval-related details, which have their own tests.
const slim = (decision: PolicyDecision) => (decision.allowed ? { allowed: true, controlId: decision.controlId } : decision);

const device = (id: string, types: string[], caps: string[] = ['Alexa.PowerController', 'Alexa.BrightnessController']) => ({
  applianceId: id,
  friendlyName: 'Name',
  applianceTypes: types,
  capabilities: caps.map((interfaceName) => ({ interfaceName })),
});

const setup = (...devices: unknown[]) => {
  const adapter = new FakeAlexa({ devices: { smarthomeDevices: devices } });
  const policy = { allowedTargets: new Set(['light-1', 'shutter-1', 'unknown-1', 'ac-1', 'lock-1', 'heater-1', 'dumb-1']) };
  return { adapter, policy };
};

test('an allow-listed light with the capability is allowed for power and brightness', async () => {
  const { adapter, policy } = setup(device('light-1', ['LIGHT']));
  assert.deepEqual(slim(await evaluateMutationPolicy(adapter, policy, 'light-1', 'power')), { allowed: true, controlId: 'light-1' });
  assert.deepEqual(slim(await evaluateMutationPolicy(adapter, policy, 'light-1', 'brightness')), { allowed: true, controlId: 'light-1' });
});

test('a target that is not on the allow-list is refused without reading the inventory', async () => {
  const { adapter, policy } = setup(device('other-light', ['LIGHT']));
  const decision = await evaluateMutationPolicy(adapter, policy, 'other-light', 'power');
  assert.deepEqual(decision, { allowed: false, reason: 'target_not_allowed' });
  assert.equal(adapter.calls.length, 0);
});

test('shutters, air conditioning, locks and heaters are refused even when allow-listed', async () => {
  const { adapter, policy } = setup(
    device('shutter-1', ['INTERIOR_BLIND']),
    device('ac-1', ['AIR_CONDITIONER']),
    device('lock-1', ['SMARTLOCK']),
    device('heater-1', ['HEATER']),
  );
  for (const id of ['shutter-1', 'ac-1', 'lock-1', 'heater-1']) {
    assert.deepEqual(await evaluateMutationPolicy(adapter, policy, id, 'power'), { allowed: false, reason: 'safety_class' }, id);
  }
  assert.equal(adapter.writes.length, 0);
});

test('an unknown or missing device class is refused', async () => {
  const { adapter, policy } = setup(device('unknown-1', []), { applianceId: 'dumb-1', capabilities: [{ interfaceName: 'Alexa.PowerController' }] });
  assert.deepEqual(await evaluateMutationPolicy(adapter, policy, 'unknown-1', 'power'), { allowed: false, reason: 'unknown_class' });
  assert.deepEqual(await evaluateMutationPolicy(adapter, policy, 'dumb-1', 'power'), { allowed: false, reason: 'unknown_class' });
});

test('a light without the needed capability, a missing device and an unavailable inventory are refused', async () => {
  const { adapter, policy } = setup(device('light-1', ['LIGHT'], ['Alexa.PowerController']));
  assert.deepEqual(await evaluateMutationPolicy(adapter, policy, 'light-1', 'brightness'), { allowed: false, reason: 'unsupported_capability' });
  assert.deepEqual(await evaluateMutationPolicy(adapter, policy, 'ac-1', 'power'), { allowed: false, reason: 'device_not_found' });
  const broken = new FakeAlexa({ devices: 'garbage' });
  assert.deepEqual(await evaluateMutationPolicy(broken, policy, 'light-1', 'power'), { allowed: false, reason: 'inventory_unavailable' });
});

test('endpoint-shaped records keep class and capabilities under legacyAppliance and resolve to the legacy appliance ID', async () => {
  const record = {
    entityId: 'light-1',
    displayCategories: { primary: { value: 'LIGHT' } },
    legacyAppliance: { applianceId: 'SKILL_light-1', applianceTypes: ['LIGHT'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
  };
  const { adapter, policy } = setup(record);
  assert.deepEqual(slim(await evaluateMutationPolicy(adapter, policy, 'light-1', 'power')), { allowed: true, controlId: 'SKILL_light-1' });
  assert.deepEqual(await evaluateMutationPolicy(adapter, policy, 'light-1', 'brightness'), { allowed: false, reason: 'unsupported_capability' });
});

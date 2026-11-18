import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/no-network.js';
import { parseCatalog, CatalogError } from '../src/catalog.js';
import { evaluateMutationPolicy } from '../src/mutation-policy.js';

const adapter = {
  smartHomeDevices: async () => ({
    smarthomeDevices: [
      { applianceId: 'lamp', friendlyName: 'Lamp', applianceTypes: ['LIGHT'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
      { applianceId: 'ac', friendlyName: 'AC breaker', applianceTypes: ['AIR_CONDITIONER'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
      { applianceId: 'cam', friendlyName: 'Cam', applianceTypes: ['CAMERA'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
    ],
  }),
};
const withEntries = (devices: Record<string, unknown>) => {
  const catalog = parseCatalog(JSON.stringify({ version: 1, devices }));
  return { allowedTargets: new Set(['*']), catalog: { get: () => catalog } } as never;
};
const modeOf = async (policy: never, id: string, op: 'power_on' | 'power_off') => {
  const d = await evaluateMutationPolicy(adapter as never, policy, id, 'power', undefined, op);
  return d.allowed ? d.mode : d.reason;
};

test('on and off follow separate modes, and off has no built-in exemption', async () => {
  const policy = withEntries({
    lamp: { category: 'light', group: 'low-risk', operations: { power_on: 'approve' } },
    ac: { category: 'ac', group: 'low-risk', operations: { power_off: 'approve', power_on: 'deny' } },
  });
  assert.equal(await modeOf(policy, 'lamp', 'power_on'), 'approve');
  assert.equal(await modeOf(policy, 'lamp', 'power_off'), 'allow');
  assert.equal(await modeOf(policy, 'ac', 'power_off'), 'approve');
  assert.equal(await modeOf(policy, 'ac', 'power_on'), 'category_denied');
});

test('an override can never unblock a hard-blocked class', async () => {
  const policy = withEntries({ cam: { category: 'access', group: 'low-risk', operations: { power_on: 'allow', power_off: 'allow' } } });
  assert.equal(await modeOf(policy, 'cam', 'power_off'), 'safety_class');
});

test('unknown operations and modes are rejected', () => {
  assert.throws(() => parseCatalog(JSON.stringify({ version: 1, devices: { a: { category: 'light', operations: { reboot: 'allow' } } } })), CatalogError);
  assert.throws(() => parseCatalog(JSON.stringify({ version: 1, devices: { a: { category: 'light', operations: { power_on: 'yes' } } } })), CatalogError);
});

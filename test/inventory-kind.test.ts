import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/no-network.js';
import { listDevices, readStates } from '../src/inventory.js';
import { parseCatalog } from '../src/catalog.js';
import { evaluateMutationPolicy } from '../src/mutation-policy.js';

const lamps = {
  smartHomeDevices: async () => ({
    smarthomeDevices: [
      { applianceId: 'on', friendlyName: 'Visible', applianceTypes: ['LIGHT'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
      { applianceId: 'off', friendlyName: 'Hidden', applianceTypes: ['LIGHT'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
    ],
  }),
};
const catalog = parseCatalog(JSON.stringify({ version: 1, devices: { off: { category: 'light', disabled: true } } }));

test('a disabled device is hidden from listing and reading, but shown to the admin page', async () => {
  const listed = await listDevices(lamps as never, 'usable', new Date(), catalog);
  assert.deepEqual(listed.status === 'ok' ? listed.devices.map((d) => d.id) : [], ['on']);
  const admin = await listDevices(lamps as never, 'usable', new Date(), catalog, true);
  assert.deepEqual(admin.status === 'ok' ? admin.devices.map((d) => d.id) : [], ['on', 'off']);
  const state = await readStates(lamps as never, 'usable', ['off'], new Date(), undefined, catalog);
  assert.equal(state.status === 'ok' || state.status === 'partial' ? state.devices[0]?.error : 'x', 'no_state');
});

test('a disabled device cannot be controlled', async () => {
  const policy = { allowedTargets: new Set(['*']), catalog: { get: () => catalog } } as never;
  const decision = await evaluateMutationPolicy(lamps as never, policy, 'off', 'power');
  assert.deepEqual(decision, { allowed: false, reason: 'device_not_found' });
});

test('a state read by endpoint ID queries Alexa with the legacy appliance ID', async () => {
  const asked: string[] = [];
  const adapter = {
    smartHomeDevices: async () => ({
      smarthomeDevices: [{ entityId: 'ent-1', friendlyName: 'Lamp', legacyAppliance: { applianceId: 'app-1', applianceTypes: ['LIGHT'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] } }],
    }),
    deviceState: async (id: string) => {
      asked.push(id);
      return { deviceStates: [{ capabilityStates: [JSON.stringify({ namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON', timeOfSample: new Date().toISOString() })] }] };
    },
  };
  const result = await readStates(adapter as never, 'usable', ['ent-1'], new Date());
  assert.deepEqual(asked, ['app-1']);
  assert.equal(result.status, 'ok');
});

test('device type and capabilities are read from nested endpoint fields', async () => {
  const adapter = {
    smartHomeDevices: async () => ({
      smarthomeDevices: [
        { entityId: 'a', friendlyName: 'Lamp', legacyAppliance: { applianceTypes: ['LIGHT'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] } },
        { entityId: 'b', friendlyName: 'Blind', displayCategories: { primary: { value: 'EXTERIOR_BLIND' } } },
      ],
    }),
  };
  const result = await listDevices(adapter as never, 'usable');
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.deepEqual(result.devices.map((d) => d.kind), ['LIGHT', 'EXTERIOR_BLIND']);
  assert.deepEqual(result.devices[0]?.capabilities, ['Alexa.PowerController']);
});

const mixed = {
  smartHomeDevices: async () => ({
    smarthomeDevices: [
      { applianceId: 'lamp', friendlyName: 'Lamp', applianceTypes: ['LIGHT'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
      { applianceId: 'door', friendlyName: 'Door', applianceTypes: ['CONTACT_SENSOR'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
      { applianceId: 'echo', friendlyName: 'Echo', applianceTypes: ['ALEXA_VOICE_ENABLED'] },
    ],
  }),
};
const everything = parseCatalog(JSON.stringify({ version: 1, devices: { door: { category: 'light', group: 'low-risk' }, echo: { category: 'light', group: 'low-risk' } } }));

test('unsupported types are hidden from agents and read-only types cannot be written, whatever the catalog says', async () => {
  const listed = await listDevices(mixed as never, 'usable', new Date(), everything);
  assert.deepEqual(listed.status === 'ok' ? listed.devices.map((d) => d.id) : [], ['lamp', 'door']);
  const admin = await listDevices(mixed as never, 'usable', new Date(), everything, true);
  const flags = admin.status === 'ok' ? admin.devices.map((d) => [d.id, d.supported, d.writable]) : [];
  assert.deepEqual(flags, [['lamp', undefined, undefined], ['door', undefined, false], ['echo', false, false]]);
  const policy = { allowedTargets: new Set(['*']), catalog: { get: () => everything } } as never;
  assert.deepEqual(await evaluateMutationPolicy(mixed as never, policy, 'door', 'power'), { allowed: false, reason: 'unsupported_capability' });
  assert.equal((await evaluateMutationPolicy(mixed as never, policy, 'echo', 'power')).allowed, false);
  const state = await readStates(mixed as never, 'usable', ['echo'], new Date());
  assert.equal(state.status === 'ok' || state.status === 'partial' ? state.devices[0]?.error : 'x', 'no_state');
});

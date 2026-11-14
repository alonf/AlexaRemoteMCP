import assert from 'node:assert/strict';
import { test } from 'node:test';
import AlexaRemote from 'alexa-remote2';
import { AlexaAdapter, type AlexaProbeClient } from '../src/alexa-adapter.js';

type Captured = { path: string; flags: { method?: string; data?: string } };
type HttpCallback = (error: Error | null, result: unknown) => void;
type TestRemote = {
  _options: object;
  serialNumbers: Record<string, object>;
  httpsGet(path: string, callback: HttpCallback, flags?: Captured['flags']): void;
};

test('adapter invokes the pinned library with its actual probe signatures', async () => {
  const remote = new AlexaRemote() as unknown as TestRemote;
  remote._options = {};
  remote.serialNumbers['echo-test'] = {
    serialNumber: 'echo-test', deviceType: 'test-type', deviceOwnerCustomerId: 'owner-test',
  };
  const calls: Captured[] = [];
  remote.httpsGet = (path, callback, flags = {}) => {
    calls.push({ path, flags });
    callback(null, path === '/nexus/v1/graphql'
      ? { data: { endpoints: { items: [] } } }
      : { success: true });
  };
  const adapter = new AlexaAdapter(remote as unknown as AlexaProbeClient);
  await adapter.echoDevices();
  await adapter.smartHomeDevices();
  await adapter.smartHomeGroups();
  await adapter.routines(12);
  await adapter.deviceState('light-test');
  await adapter.dnd();
  const parameters = [{ name: 'powerState', value: 'ON' }];
  await adapter.controlDevice('light-test', parameters);
  await adapter.runRoutine('echo-test', {
    automationId: 'routine-test',
    sequence: { sequenceId: 'sequence-test' },
  });
  await adapter.setDnd('echo-test', true);

  assert.equal(calls.length, 9);
  assert.match(calls[0]!.path, /^\/api\/devices-v2\/device/);
  assert.equal(calls[1]!.path, '/nexus/v1/graphql');
  assert.match(calls[2]!.path, /^\/api\/phoenix\/group/);
  assert.equal(calls[3]!.path, '/api/behaviors/v2/automations?limit=12');
  assert.deepEqual(JSON.parse(calls[4]!.flags.data!), {
    stateRequests: [{ entityId: 'light-test', entityType: 'APPLIANCE' }],
  });
  assert.match(calls[5]!.path, /^\/api\/dnd\/device-status-list/);
  assert.deepEqual(JSON.parse(calls[6]!.flags.data!), {
    controlRequests: [{ entityId: 'light-test', entityType: 'APPLIANCE', parameters }],
  });
  assert.equal(calls[7]!.path, '/api/behaviors/preview');
  assert.equal(JSON.parse(calls[7]!.flags.data!).behaviorId, 'routine-test');
  assert.deepEqual(JSON.parse(calls[8]!.flags.data!), {
    deviceSerialNumber: 'echo-test', deviceType: 'test-type', enabled: true,
  });
});

test('read errors do not expose upstream messages', async () => {
  const adapter = new AlexaAdapter({
    getDevices() { throw new Error('private upstream content'); },
  } as unknown as AlexaProbeClient);
  await assert.rejects(adapter.echoDevices(), { message: 'Alexa read failed' });
});

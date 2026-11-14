import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import AlexaRemoteImport from 'alexa-remote2';
import { awaitWriteResponse } from '../src/write-outcome.js';

type Callback = (error: Error | null, body?: unknown) => void;
type Remote = {
  _options: { amazonPage: string; apiUserAgentPostfix: string };
  lastAuthCheck: number;
  executeSmarthomeDeviceAction(ids: string[], parameters: object, type: string, callback: Callback): void;
  executeAutomationRoutine(device: object, routine: object, callback: Callback): void;
  setDoNotDisturb(device: object, enabled: boolean, callback: Callback): void;
};
const AlexaRemote = AlexaRemoteImport as unknown as {
  new (): Remote;
  connectivityProofPatchVersion?: number;
};
const device = { serialNumber: 'test-device', deviceType: 'test-type' };
const writes = {
  smartHome: (remote: Remote, callback: Callback) =>
    remote.executeSmarthomeDeviceAction(['test-device'], {}, 'APPLIANCE', callback),
  routine: (remote: Remote, callback: Callback) =>
    remote.executeAutomationRoutine(device, { automationId: 'test-routine', sequence: { sequenceId: 'test-sequence' } }, callback),
  dnd: (remote: Remote, callback: Callback) => remote.setDoNotDisturb(device, true, callback),
};
type Fault = 'timeout' | 'reset' | 'server-error' | 'unauthorized' | 'throttled';

test('write wrapper refuses dispatch without the upstream safety patch', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AlexaRemote, 'connectivityProofPatchVersion');
  assert.ok(descriptor);
  let called = false;
  try {
    Object.defineProperty(AlexaRemote, 'connectivityProofPatchVersion', { value: 0, configurable: true });
    const outcome = await awaitWriteResponse(() => { called = true; });
    assert.deepEqual(outcome, { status: 'not_dispatched' });
    assert.equal(called, false);
  } finally {
    Object.defineProperty(AlexaRemote, 'connectivityProofPatchVersion', descriptor);
  }
});

test('patched write methods dispatch at most once and report uncertain failures', async () => {
  assert.equal(AlexaRemote.connectivityProofPatchVersion, 1, 'required upstream safety patch is missing');
  for (const [name, invoke] of Object.entries(writes)) {
    for (const fault of ['timeout', 'reset', 'server-error', 'unauthorized', 'throttled'] as Fault[]) {
      let dispatches = 0;
      const server = http.createServer((request, response) => {
        request.resume();
        request.on('end', () => {
          dispatches++;
          if (fault === 'timeout') return;
          if (fault === 'reset') return request.socket.destroy();
          const status = fault === 'server-error' ? 503 : fault === 'unauthorized' ? 401 : 200;
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(fault === 'throttled' ? '{"error":"ThrottlingException"}' : '{}');
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const originalRequest = https.request;
      https.request = ((options: RequestOptions, callback: (response: IncomingMessage) => void) =>
        http.request({ ...options, hostname: '127.0.0.1', host: '127.0.0.1', port: address.port, timeout: 100 }, callback)
      ) as typeof https.request;
      try {
        const remote = new AlexaRemote();
        remote._options = { amazonPage: 'invalid.test', apiUserAgentPostfix: 'test' };
        remote.lastAuthCheck = Date.now();
        const outcome = await awaitWriteResponse((callback) => invoke(remote, callback));
        assert.equal(dispatches, 1, `${name}: ${fault}`);
        assert.deepEqual(outcome, { status: 'unknown' }, `${name}: ${fault}`);
      } finally {
        https.request = originalRequest;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      }
    }
  }
});

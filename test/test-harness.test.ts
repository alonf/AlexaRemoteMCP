import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import './support/no-network.js';
import { FakeAlexa } from './support/fake-alexa.js';

test('network guard blocks non-loopback connections', () => {
  assert.throws(() => net.connect({ host: 'example.com', port: 443 }), /Network access blocked/);
  assert.throws(() => net.connect(443, '203.0.113.5'), /Network access blocked/);
});

test('network guard allows loopback', async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.end());
    socket.on('close', () => resolve());
    socket.on('error', reject);
  });
  server.close();
});

test('fake Alexa records writes and reports accepted by default', async () => {
  const fake = new FakeAlexa();
  const response = await fake.controlDevice('d1', [{ action: 'turnOn' }]);
  assert.equal(response.status, 'response_received');
  assert.equal(fake.writes.length, 1);
});

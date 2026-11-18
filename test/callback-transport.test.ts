import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, LookupFunction } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import './support/no-network.js';
import { CallbackError, httpsCallbackTransport } from '../src/events/callback-transport.js';

const run = promisify(execFile);
const never = new AbortController().signal;
const GIT_OPENSSL = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
const openssl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0 ? 'openssl' : existsSync(GIT_OPENSSL) ? GIT_OPENSSL : undefined;

// A throwaway certificate made when the test runs, so no key material is committed. Tests skip without openssl.
async function throwawayCertificate(command: string) {
  const parent = existsSync(tmpdir()) ? tmpdir() : process.cwd();
  const folder = await mkdtemp(join(parent, 'throwaway-tls-'));
  try {
    await run(command, [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(folder, 'key.pem'), '-out', join(folder, 'cert.pem'),
    ]);
    return { cert: await readFile(join(folder, 'cert.pem'), 'utf8'), key: await readFile(join(folder, 'key.pem'), 'utf8') };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const toLoopback: LookupFunction = (_host, options, callback) => {
  if (options.all === true) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
};

describe('the callback transport over HTTPS', { skip: openssl === undefined ? 'openssl is not available' : false }, () => {
  let server: Server;
  let host: string;
  let certificate: string;
  const received: string[] = [];

  before(async () => {
    const material = await throwawayCertificate(openssl as string);
    certificate = material.cert;
    server = createServer({ cert: material.cert, key: material.key }, (request, response) => {
      received.push(request.url ?? '');
      if (request.url === '/redirect') { response.writeHead(302, { location: 'https://localhost/elsewhere' }); response.end(); return; }
      if (request.url === '/silent') return;
      if (request.url === '/big') { response.writeHead(200); response.end('x'.repeat(1000)); return; }
      response.writeHead(200); response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `localhost:${(server.address() as AddressInfo).port}`;
  });
  after(() => { server.closeAllConnections(); server.close(); });

  const options = () => ({ allowedHosts: [host], timeoutMs: 300, maxResponseBytes: 64, trustedCertificates: certificate, lookup: toLoopback });
  const post = (transport: ReturnType<typeof httpsCallbackTransport>, path: string) =>
    transport({ url: new URL(`https://${host}${path}`), headers: { 'content-type': 'application/json' }, body: '{}' }, never);
  const kindOf = async (promise: Promise<unknown>) => {
    try { await promise; return 'resolved'; } catch (error) { return error instanceof CallbackError ? error.kind : 'other'; }
  };

  test('an allowed host gets the body and the answer comes back', async () => {
    const answer = await post(httpsCallbackTransport({ ...options(), addressAllowed: () => true }), '/ok');
    assert.deepEqual(answer, { status: 200, body: 'ok' });
  });

  test('a host that is not on the list is refused before anything is sent', async () => {
    const count = received.length;
    const transport = httpsCallbackTransport({ ...options(), allowedHosts: ['connectors.api.openai.com'] });
    assert.equal(await kindOf(post(transport, '/ok')), 'host_not_allowed');
    assert.equal(received.length, count);
  });

  test('a name that resolves to a private address is refused', async () => {
    const count = received.length;
    assert.equal(await kindOf(post(httpsCallbackTransport(options()), '/ok')), 'address_not_allowed');
    assert.equal(received.length, count);
  });

  test('a redirect is not followed', async () => {
    const answer = await post(httpsCallbackTransport({ ...options(), addressAllowed: () => true }), '/redirect');
    assert.equal(answer.status, 302);
    assert.ok(!received.includes('/elsewhere'));
  });

  test('the answer is cut at the size limit', async () => {
    const answer = await post(httpsCallbackTransport({ ...options(), addressAllowed: () => true }), '/big');
    assert.equal(answer.body.length, 64);
  });

  test('a receiver that does not answer in time is a timeout', async () => {
    assert.equal(await kindOf(post(httpsCallbackTransport({ ...options(), addressAllowed: () => true }), '/silent')), 'timeout');
  });
});

// Runs the MCP HTTP service locally against a fake adapter and calls it with a static test token.
// No Amazon account, network access or real devices are involved.
// Usage: npm run build && node examples/local-client.mjs
/* global URL, console */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../dist/src/http-server.js';
import { FakeAlexa } from '../dist/test/support/fake-alexa.js';

const TEST_TOKEN = 'local-test-token';

const server = createHttpServer({
  adapter: new FakeAlexa({
    devices: {
      smarthomeDevices: [
        { applianceId: 'example-1', friendlyName: 'Example Lamp', applianceTypes: ['LIGHT'], capabilities: [{ interfaceName: 'Alexa.PowerController' }] },
      ],
    },
  }),
  sessionHealth: () => 'usable',
  authenticate: async (request) =>
    request.headers.authorization === `Bearer ${TEST_TOKEN}`
      ? { token: TEST_TOKEN, clientId: 'local-example', scopes: ['read'] }
      : undefined,
  allowedOrigins: [],
  resourceMetadataUrl: 'http://127.0.0.1/.well-known/oauth-protected-resource',
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);

const client = new Client({ name: 'local-example', version: '0' });
await client.connect(
  new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } } }),
);
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
const devices = await client.callTool({ name: 'list_devices', arguments: {} });
console.log('list_devices:', devices.content[0].text);

await client.close();
await new Promise((resolve) => server.close(resolve));

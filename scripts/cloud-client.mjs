// Minimal OAuth + MCP client for exercising a deployed service from the owner's machine.
// Usage: node scripts/cloud-client.mjs <baseUrl> <toolName> [jsonArguments]
// Env: CLOUD_CLIENT_STATE = file that caches the registration and tokens (keep it outside the repo).
// The loopback redirect URI below must be listed in the service's APPROVED_REDIRECT_URIS.
/* global URL, console, process */
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

const [baseUrl, tool, rawArgs] = process.argv.slice(2);
if (!baseUrl || !tool) {
  console.error('Usage: node scripts/cloud-client.mjs <baseUrl> <toolName> [jsonArguments]');
  process.exit(2);
}
const PORT = 8976;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const stateFile = process.env.CLOUD_CLIENT_STATE;
if (!stateFile) {
  console.error('Set CLOUD_CLIENT_STATE to a file path outside the repository.');
  process.exit(2);
}
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });

const provider = {
  get redirectUrl() { return REDIRECT; },
  get clientMetadata() {
    return {
      client_name: 'alexa-remote-mcp cloud client',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: process.env.CLOUD_CLIENT_SCOPE ?? 'read offline_access',
    };
  },
  clientInformation: () => state.client,
  saveClientInformation: (value) => { state.client = value; save(); },
  tokens: () => state.tokens,
  saveTokens: (value) => { state.tokens = value; save(); },
  saveCodeVerifier: (value) => { state.verifier = value; save(); },
  codeVerifier: () => state.verifier,
  redirectToAuthorization: (url) => { state.pendingAuthUrl = url.toString(); },
};

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT);
      const code = url.searchParams.get('code');
      res.end(code ? 'Signed in. You can close this tab.' : 'Sign-in failed.');
      server.close();
      if (code) resolve(code);
      else reject(new Error('No authorization code returned'));
    });
    server.listen(PORT, '127.0.0.1');
  });
}

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), { authProvider: provider });
  const client = new Client({ name: 'cloud-client', version: '0.0.0' });
  try {
    await client.connect(transport);
  } catch (error) {
    if (!(error instanceof UnauthorizedError) || !state.pendingAuthUrl) throw error;
    const pending = waitForCode();
    spawn('cmd', ['/c', 'start', '', state.pendingAuthUrl.replace(/&/g, '^&')], { stdio: 'ignore' });
    console.error('Waiting for sign-in in the browser...');
    const code = await pending;
    delete state.pendingAuthUrl;
    await transport.finishAuth(code);
    return connect();
  }
  return client;
}

const client = await connect();
const result = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
console.log(JSON.stringify(result, null, 2));
await client.close();
process.exit(result.isError ? 1 : 0);

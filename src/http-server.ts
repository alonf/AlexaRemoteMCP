import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { listDevices, MAX_STATE_IDS, readStates } from './inventory.js';
import type { LightCommand, MutationService } from './mutation-service.js';
import type { AlexaPort } from './ports.js';
import type { SessionHealth } from './session-manager.js';

export const MCP_PATH = '/mcp';
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export interface HttpServerOptions {
  adapter: AlexaPort;
  sessionHealth: () => SessionHealth;
  authenticate: (request: IncomingMessage) => Promise<AuthInfo | undefined>;
  allowedOrigins: readonly string[];
  resourceMetadataUrl: string;
  maxBodyBytes?: number;
  // Handles every path other than the MCP endpoint (authorization server, metadata, sign-in).
  fallback?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  now?: () => Date;
  // Enables the light mutation tools. Omitted means the server is read-only.
  mutations?: MutationService;
}

class BodyTooLarge extends Error {}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge());
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => reject(new Error('Request read failed')));
  });
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

const hasScope = (auth: AuthInfo | undefined, scope: string) => auth?.scopes.includes(scope) === true;

function buildMcpServer(options: HttpServerOptions): McpServer {
  const server = new McpServer({ name: 'alexa-remote-mcp', version: '0.0.0' });
  const now = () => (options.now ? options.now() : new Date());
  const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const denied = () => ({
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ status: 'rejected', reason: 'missing_scope' }) }],
  });

  server.registerTool(
    'list_devices',
    { description: 'List smart-home devices with stable IDs and declared capabilities. Read-only.' },
    async (extra) => {
      if (!hasScope(extra.authInfo, 'read')) return denied();
      return asText(await listDevices(options.adapter, options.sessionHealth(), now()));
    },
  );

  server.registerTool(
    'get_device_state',
    {
      description: 'Read current state for up to 25 devices. Stale or missing values are marked, never presented as current.',
      inputSchema: { ids: z.array(z.string().min(1).max(256)).min(1).max(MAX_STATE_IDS) },
    },
    async ({ ids }, extra) => {
      if (!hasScope(extra.authInfo, 'read')) return denied();
      return asText(await readStates(options.adapter, options.sessionHealth(), ids, now()));
    },
  );

  const mutations = options.mutations;
  if (mutations) {
    const idSchema = z.string().min(1).max(256);
    const keySchema = z.string().min(8).max(128).optional();
    // Confirmation is the owner's per-tool enablement in the client; model-supplied arguments never authorize anything.
    const register = (
      name: string,
      description: string,
      shape: z.ZodRawShape,
      toCommand: (input: Record<string, unknown>) => LightCommand,
    ) => server.registerTool(name, { description, inputSchema: shape }, async (input: Record<string, unknown>, extra) => {
      if (!hasScope(extra.authInfo, 'mutate')) return denied();
      const principal = extra.authInfo?.extra?.principal;
      if (typeof principal !== 'string') return denied();
      const operationKey = typeof input.operationKey === 'string' ? input.operationKey : undefined;
      const reply = await mutations.execute(
        { principal, client: extra.authInfo?.clientId ?? 'unknown', ...(operationKey ? { operationKey } : {}) },
        String(input.id),
        toCommand(input),
      );
      const failed = reply.status === 'rejected' || reply.status === 'key_conflict' || reply.status === 'not_dispatched';
      return { ...(failed ? { isError: true } : {}), ...asText(reply) };
    });

    register(
      'light_turn_on',
      'Turn on one allow-listed light. Reports accepted, verified or unknown honestly.',
      { id: idSchema, operationKey: keySchema },
      () => ({ kind: 'power', on: true }),
    );
    register(
      'light_turn_off',
      'Turn off one allow-listed light. Reports accepted, verified or unknown honestly.',
      { id: idSchema, operationKey: keySchema },
      () => ({ kind: 'power', on: false }),
    );
    register(
      'light_set_brightness',
      'Set brightness (0-100) of one allow-listed dimmable light.',
      { id: idSchema, brightness: z.number().int().min(0).max(100), operationKey: keySchema },
      (input) => ({ kind: 'brightness', level: Number(input.brightness) }),
    );
  }

  return server;
}

export function createHttpServer(options: HttpServerOptions): Server {
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/readyz')) {
      // Anonymous and deliberately coarse: no account, device or session detail.
      if (url.pathname === '/healthz') return send(response, 200, { status: 'ok' });
      const ready = options.sessionHealth() === 'usable';
      return send(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
    }
    if (url.pathname !== MCP_PATH) {
      if (options.fallback) return options.fallback(request, response);
      return send(response, 404, { error: 'not_found' });
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !options.allowedOrigins.includes(origin)) {
      return send(response, 403, { error: 'origin_not_allowed' });
    }

    if (request.method !== 'POST') {
      return send(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    }

    const auth = await options.authenticate(request).catch(() => undefined);
    if (!auth) {
      return send(response, 401, { error: 'unauthorized' }, {
        'www-authenticate': `Bearer resource_metadata="${options.resourceMetadataUrl}"`,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(request, limit));
    } catch (error) {
      if (error instanceof BodyTooLarge) return send(response, 413, { error: 'payload_too_large' });
      return send(response, 400, { error: 'invalid_json' });
    }

    const server = buildMcpServer(options);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const authed = request as IncomingMessage & { auth?: AuthInfo };
    authed.auth = auth;
    await transport.handleRequest(authed, response, parsed);
  }

  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, { error: 'internal_error' });
      else response.end();
    });
  });
}

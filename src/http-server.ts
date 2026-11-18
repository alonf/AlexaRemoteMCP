import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { type CatalogService, MAX_CHANGES } from './catalog-service.js';
import { PERMISSION_GROUPS } from './catalog.js';
import { findDevices, listDevices, MAX_FIND_TERMS, MAX_STATE_IDS, readStates } from './inventory.js';
import type { ApprovalInput } from './approval-gate.js';
import type { DeviceCommand, MutationService } from './mutation-service.js';
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
  // Enables the device mutation tools. Omitted means the server is read-only.
  mutations?: MutationService;
  // Reads and, with owner approval, edits the private device catalog.
  catalog?: CatalogService;
  // False hides the read tools (ACTION_POLICY query=deny). Defaults to true.
  readsAllowed?: boolean;
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

const MRTR_VERSION = '2026-07-28';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// MRTR fields travel in the tools/call params; elicitation support is declared in the request `_meta`. A client on an
// older protocol revision cannot answer an MRTR input request, so it is treated as unable to elicit.
function approvalInputOf(body: unknown): ApprovalInput {
  const params = isRecord(body) && body.method === 'tools/call' && isRecord(body.params) ? body.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const version = meta['io.modelcontextprotocol/protocolVersion'];
  const capabilities = meta['io.modelcontextprotocol/clientCapabilities'];
  const elicitation = isRecord(capabilities) ? capabilities.elicitation : undefined;
  const canElicit = typeof version === 'string' && version >= MRTR_VERSION
    && isRecord(elicitation) && (Object.keys(elicitation).length === 0 || elicitation.form !== undefined);
  return { canElicit, requestState: params.requestState, inputResponses: params.inputResponses };
}

// Diagnostic for approval negotiation: key names and version strings only (never argument values or credentials),
// logged once per distinct shape so it cannot flood the log.
const seenShapes = new Set<string>();
const keysOf = (value: unknown): string => (isRecord(value) ? Object.keys(value).slice(0, 12).map((k) => k.slice(0, 48)).join('|') : '-');
const shortText = (value: unknown): string => (typeof value === 'string' ? value.replace(/[^\w.:/-]/g, '?').slice(0, 24) : '-');

function logClientShape(body: unknown, header: string | string[] | undefined, canElicit: boolean): void {
  if (!isRecord(body) || (body.method !== 'initialize' && body.method !== 'tools/call')) return;
  const params = isRecord(body.params) ? body.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const caps = body.method === 'initialize' ? params.capabilities : meta['io.modelcontextprotocol/clientCapabilities'];
  const elicitation = isRecord(caps) ? caps.elicitation : undefined;
  const shape = [
    `method=${body.method}`,
    `header=${shortText(Array.isArray(header) ? header[0] : header)}`,
    `version=${shortText(body.method === 'initialize' ? params.protocolVersion : meta['io.modelcontextprotocol/protocolVersion'])}`,
    `meta=${keysOf(meta)}`,
    `capabilities=${keysOf(caps)}`,
    `elicitation=${keysOf(elicitation)}`,
    `extensions=${keysOf(isRecord(caps) ? caps.extensions : undefined)}`,
    `params=${keysOf(params)}`,
    `canElicit=${canElicit}`,
  ].join(' ');
  if (seenShapes.has(shape) || seenShapes.size > 50) return;
  seenShapes.add(shape);
  console.log(`client-shape ${shape}`);
}

function buildMcpServer(options: HttpServerOptions, approval: ApprovalInput): McpServer {
  const server = new McpServer({ name: 'alexa-remote-mcp', version: '0.0.0' });
  const now = () => (options.now ? options.now() : new Date());
  const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const denied = () => ({
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ status: 'rejected', reason: 'missing_scope' }) }],
  });

  if (options.readsAllowed !== false) {
    server.registerTool(
      'list_devices',
      { description: 'List every smart-home device with stable IDs and declared capabilities. Large and slow: to act on one device, use find_device with several hints instead. Read-only.' },
      async (extra) => {
        if (!hasScope(extra.authInfo, 'read')) return denied();
        return asText(await listDevices(options.adapter, options.sessionHealth(), now(), options.catalog?.read()));
      },
    );

    server.registerTool(
      'find_device',
      {
        description: 'Find devices by name, room, kind or the owner\'s notes, and get only the best matches with their IDs. Much faster than list_devices; prefer it. Give several hints at once (for example ["boiler", "water", "heater"] or ["office", "west", "shutter"]): the more hints, the better the match. Read-only.',
        inputSchema: {
          terms: z.array(z.string().min(1).max(64)).min(1).max(MAX_FIND_TERMS),
          limit: z.number().int().min(1).max(20).optional(),
        },
      },
      async ({ terms, limit }, extra) => {
        if (!hasScope(extra.authInfo, 'read')) return denied();
        return asText(await findDevices(options.adapter, options.sessionHealth(), terms, limit ?? 8, now(), options.catalog?.read()));
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
        return asText(await readStates(options.adapter, options.sessionHealth(), ids, now(), undefined, options.catalog?.read()));
      },
    );
  }

  const catalog = options.catalog;
  if (catalog) {
    if (options.readsAllowed !== false) {
      server.registerTool(
        'get_device_catalog',
        { description: 'Read the owner\'s device catalog: per-device category, permission group, traits and notes. Read-only.' },
        async (extra) => {
          if (!hasScope(extra.authInfo, 'read')) return denied();
          return asText({ version: 1, groups: PERMISSION_GROUPS, devices: Object.fromEntries([...catalog.read()].filter(([, entry]) => !entry.disabled)) });
        },
      );
    }
    server.registerTool(
      'update_device_catalog',
      {
        description: `Add, change or remove device catalog entries (at most ${MAX_CHANGES} per call). Every edit needs the owner's approval before it is saved. Entry: {category, group?, operations?, disabled?, groupKind?, members?, description?}. operations overrides the mode per operation (power_on, power_off, brightness, open, close, stop, step) with allow, approve or deny.`,
        inputSchema: {
          set: z.record(z.string().min(1).max(256), z.unknown()).optional(),
          remove: z.array(z.string().min(1).max(256)).max(MAX_CHANGES).optional(),
        },
      },
      async (input: { set?: Record<string, unknown> | undefined; remove?: string[] | undefined }, extra) => {
        if (!hasScope(extra.authInfo, 'mutate')) return denied();
        const principal = extra.authInfo?.extra?.principal;
        if (typeof principal !== 'string') return denied();
        const reply = await catalog.update(
          { principal, client: extra.authInfo?.clientId ?? 'unknown' },
          { ...(input.set ? { set: input.set } : {}), ...(input.remove ? { remove: input.remove } : {}) },
          approval,
        );
        if (reply.status === 'approval_required' && reply.approval) {
          return { resultType: 'input_required', ...reply.approval } as never;
        }
        return { ...(reply.status === 'saved' ? {} : { isError: true }), ...asText(reply) };
      },
    );
  }

  const mutations = options.mutations;
  if (mutations) {
    const idSchema = z.string().min(1).max(256);
    const keySchema = z.string().min(8).max(128).optional();
    // Approval normally goes through an MRTR elicitation. Only for devices the owner opted in, a client that cannot elicit
    // relays the user's answer with approvalId and confirmed; the server still checks the signed, single-use, expiring id.
    const confirmationShape = {
      approvalId: z.string().max(2048).optional().describe('From a confirmation_required reply. Only repeat the call with it after the user has said yes themselves.'),
      confirmed: z.boolean().optional().describe('true only if the user explicitly said yes; false if they said no.'),
    };
    const register = (
      name: string,
      description: string,
      shape: z.ZodRawShape,
      toCommand: (input: Record<string, unknown>) => DeviceCommand | undefined,
    ) => server.registerTool(name, { description, inputSchema: { ...shape, ...confirmationShape } }, async (input: Record<string, unknown>, extra) => {
      if (!hasScope(extra.authInfo, 'mutate')) return denied();
      const principal = extra.authInfo?.extra?.principal;
      if (typeof principal !== 'string') return denied();
      const command = toCommand(input);
      if (!command) return { isError: true, ...asText({ status: 'rejected', reason: 'invalid_arguments' }) };
      const operationKey = typeof input.operationKey === 'string' ? input.operationKey : undefined;
      const reply = await mutations.execute(
        { principal, client: extra.authInfo?.clientId ?? 'unknown', ...(operationKey ? { operationKey } : {}) },
        String(input.id),
        command,
        { ...approval, confirmation: { approvalId: input.approvalId, confirmed: input.confirmed } },
      );
      if (reply.status === 'approval_required' && reply.approval) {
        return { resultType: 'input_required', ...reply.approval } as never;
      }
      const failed = reply.status === 'rejected' || reply.status === 'key_conflict' || reply.status === 'not_dispatched';
      return { ...(failed ? { isError: true } : {}), ...asText(reply) };
    });

    register(
      'light_turn_on',
      'Turn on one light. Reports accepted, verified or unknown honestly.',
      { id: idSchema, operationKey: keySchema },
      () => ({ kind: 'power', on: true }),
    );
    register(
      'light_turn_off',
      'Turn off one light. Reports accepted, verified or unknown honestly.',
      { id: idSchema, operationKey: keySchema },
      () => ({ kind: 'power', on: false }),
    );
    register(
      'light_set_brightness',
      'Set brightness (0-100) of one dimmable light.',
      { id: idSchema, brightness: z.number().int().min(0).max(100), operationKey: keySchema },
      (input) => ({ kind: 'brightness', level: Number(input.brightness) }),
    );
    register(
      'set_device_state',
      'Act on one device: on, off, open or close (shutters), or set_brightness. For a shutter that is moving, stop it with action=stop and moving=up or down (the direction it is travelling now; this steps in that direction, so the motor is never reversed). step_up and step_down move a shutter a short step. The owner configures per device kind whether this is allowed, needs the owner\'s approval, or is refused.',
      {
        id: idSchema,
        action: z.enum(['on', 'off', 'open', 'close', 'stop', 'step_up', 'step_down', 'set_brightness']),
        moving: z.enum(['up', 'down']).optional().describe('Required for stop: the direction the shutter is moving right now.'),
        brightness: z.number().int().min(0).max(100).optional(),
        operationKey: keySchema,
      },
      (input) => {
        switch (input.action) {
          case 'on': return { kind: 'power', on: true };
          case 'off': return { kind: 'power', on: false };
          case 'open': return { kind: 'position', direction: 'open' };
          case 'close': return { kind: 'position', direction: 'close' };
          case 'step_up': return { kind: 'position', direction: 'step_up' };
          case 'step_down': return { kind: 'position', direction: 'step_down' };
          case 'stop':
            return input.moving === 'up' || input.moving === 'down' ? { kind: 'position', direction: input.moving === 'up' ? 'stop_up' : 'stop_down' } : undefined;
          default: return typeof input.brightness === 'number' ? { kind: 'brightness', level: input.brightness } : undefined;
        }
      },
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

    const approval = approvalInputOf(parsed);
    logClientShape(parsed, request.headers['mcp-protocol-version'], approval.canElicit);
    const server = buildMcpServer(options, approval);
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

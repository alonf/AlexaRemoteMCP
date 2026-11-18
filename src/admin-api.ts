import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { CatalogService } from './catalog-service.js';
import { adminPage } from './admin-page.js';
import { listDevices } from './inventory.js';
import { echoesOf } from './speech-service.js';
import type { AlexaPort } from './ports.js';
import type { SessionHealth } from './session-manager.js';

export const ADMIN_PAGE_PATH = '/admin/catalog';
const MAX_BODY = 512 * 1024;

export interface AdminOptions {
  baseUrl: string;
  authenticate: (request: IncomingMessage) => Promise<AuthInfo | undefined>;
  catalog: CatalogService;
  adapter: AlexaPort;
  sessionHealth: () => SessionHealth;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const statusOf = (reply: { status: string; reason?: string }) =>
  reply.status === 'saved' ? 200 : reply.reason === 'backup_failed' ? 503 : reply.status === 'not_dispatched' ? 500 : 400;

// The page is a static shell with no data; every /admin/api call needs the owner's admin-scoped token.
export function createAdminHandler(options: AdminOptions): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const origin = new URL(options.baseUrl).origin;

  return async (request, response) => {
    const url = new URL(request.url ?? '/', options.baseUrl);
    if (url.pathname === ADMIN_PAGE_PATH && request.method === 'GET') {
      const nonce = randomBytes(16).toString('base64');
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      response.end(adminPage(nonce));
      return true;
    }
    if (!url.pathname.startsWith('/admin/api/')) return false;

    const auth = await options.authenticate(request).catch(() => undefined);
    if (!auth) { send(response, 401, { error: 'unauthorized' }); return true; }
    const sentOrigin = request.headers.origin;
    if (sentOrigin !== undefined && sentOrigin !== origin) { send(response, 403, { error: 'origin_not_allowed' }); return true; }

    if (url.pathname === '/admin/api/devices' && request.method === 'GET') {
      const catalog = options.catalog.read();
      const result = await listDevices(options.adapter, options.sessionHealth(), new Date(), catalog, true);
      const seen = new Set(result.status === 'ok' ? result.devices.map((d) => d.id) : []);
      const catalogOnly = [...catalog].filter(([id, entry]) => !seen.has(id) && !entry.speaker).map(([id, entry]) => ({ id, catalog: entry }));
      let echoes: Array<{ id: string; name: string; online: boolean }> = [];
      try { echoes = echoesOf(await options.adapter.echoDevices()).map((e) => ({ id: e.serial, name: e.name, online: e.online })); } catch { /* the speaker section is simply empty */ }
      const speakers = echoes.map((e) => ({ ...e, flags: catalog.get(e.id)?.speaker ?? {} }));
      send(response, 200, result.status === 'ok' ? { ...result, catalogOnly, speakers } : { ...result, devices: [], catalogOnly, speakers });
      return true;
    }

    if (url.pathname === '/admin/api/catalog' && (request.method === 'PATCH' || request.method === 'PUT')) {
      const text = await readBody(request);
      if (text === undefined) { send(response, 413, { error: 'payload_too_large' }); return true; }
      let reply;
      if (request.method === 'PUT') {
        reply = await options.catalog.adminReplace(text);
      } else {
        let change: unknown;
        try { change = JSON.parse(text); } catch { send(response, 400, { error: 'invalid_json' }); return true; }
        if (change === null || typeof change !== 'object' || Array.isArray(change)) { send(response, 400, { error: 'invalid_json' }); return true; }
        const c = change as { set?: unknown; remove?: unknown };
        const okSet = c.set === undefined || (c.set !== null && typeof c.set === 'object' && !Array.isArray(c.set));
        const okRemove = c.remove === undefined || (Array.isArray(c.remove) && c.remove.every((id) => typeof id === 'string'));
        if (!okSet || !okRemove) { send(response, 400, { error: 'invalid_json' }); return true; }
        reply = await options.catalog.adminEdit(c as { set?: Record<string, unknown>; remove?: string[] });
      }
      send(response, statusOf(reply), reply);
      return true;
    }
    send(response, 404, { error: 'not_found' });
    return true;
  };
}

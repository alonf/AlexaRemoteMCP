import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Provider, { errors, type Configuration, type JWK } from 'oidc-provider';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OidcStore } from './oidc-store.js';

export const SCOPES = ['read', 'mutate'] as const;
// Only the owner's catalog page may hold this scope; it is never advertised to MCP clients.
export const ADMIN_SCOPE = 'admin';
const REGISTRATION_BODY_LIMIT = 16 * 1024;
const TICKET_TTL_MS = 5 * 60 * 1000;

// Starts and completes the owner's sign-in at an external identity provider.
export interface SignInProvider {
  // Returns the URL the browser is sent to for the interaction with this uid.
  begin(uid: string): Promise<string>;
  // Verifies the identity provider's callback and returns the signed-in account.
  complete(query: URLSearchParams): Promise<{ uid: string; accountId: string }>;
}

export interface IssuerOptions {
  baseUrl: string;
  resource: string;
  approvedRedirectUris: readonly string[];
  // Redirect URI of the server's own admin page; the only client allowed the admin scope.
  adminRedirectUri?: string;
  ownerAccountId: string;
  store: OidcStore;
  signingKey: JWK;
  cookieKeys: string[];
  signIn: SignInProvider;
  trustProxy?: boolean;
}

export interface Issuer {
  provider: Provider;
  // Serves every issuer, metadata and sign-in route.
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  authenticate: (request: IncomingMessage) => Promise<AuthInfo | undefined>;
  // Like authenticate, but only for the admin page's own client holding the admin scope.
  authenticateAdmin: (request: IncomingMessage) => Promise<AuthInfo | undefined>;
  protectedResourceMetadata: () => Record<string, unknown>;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function sendText(response: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

function readLimited(request: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { resolve(undefined); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(undefined));
  });
}

const sameSecret = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createIssuer(options: IssuerOptions): Issuer {
  const { resource, ownerAccountId, signIn } = options;
  const issuerOrigin = new URL(options.baseUrl).origin;
  const approved = new Set([...options.approvedRedirectUris, ...(options.adminRedirectUri ? [options.adminRedirectUri] : [])]);

  const configuration: Configuration = {
    adapter: options.store.adapter,
    jwks: { keys: [options.signingKey] },
    cookies: { keys: options.cookieKeys },
    scopes: ['openid', 'offline_access', ...SCOPES, ADMIN_SCOPE],
    claims: { openid: ['sub'] },
    pkce: { required: () => true },
    clientDefaults: {
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true, initialAccessToken: false },
      registrationManagement: { enabled: false },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo: async (_ctx, indicator) => {
          if (indicator !== resource) throw new errors.InvalidTarget();
          return { scope: [...SCOPES, ADMIN_SCOPE].join(' '), audience: resource, accessTokenFormat: 'opaque', accessTokenTTL: 3600 };
        },
      },
    },
    ttl: {
      AccessToken: 3600,
      AuthorizationCode: 60,
      RefreshToken: 30 * 24 * 3600,
      Grant: 60 * 24 * 3600,
      Session: 14 * 24 * 3600,
      Interaction: 600,
    },
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken: () => true,
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    findAccount: async (_ctx, id) => ({ accountId: id, claims: async () => ({ sub: id }) }),
  };

  const provider = new Provider(options.baseUrl, configuration);
  if (options.trustProxy) provider.proxy = true;
  const providerCallback = provider.callback();

  // One-time tickets carry a verified sign-in from the identity provider callback to the
  // interaction route, where the browser's interaction cookie is available.
  const tickets = new Map<string, { uid: string; accountId: string; expires: number }>();
  const issueTicket = (uid: string, accountId: string) => {
    const ticket = randomBytes(24).toString('base64url');
    tickets.set(ticket, { uid, accountId, expires: Date.now() + TICKET_TTL_MS });
    return ticket;
  };
  const redeemTicket = (ticket: string | null, uid: string) => {
    if (!ticket) return undefined;
    const found = tickets.get(ticket);
    tickets.delete(ticket);
    if (!found || found.expires < Date.now() || !sameSecret(found.uid, uid)) return undefined;
    return found;
  };

  async function registration(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const text = await readLimited(request, REGISTRATION_BODY_LIMIT);
    let body: unknown;
    try { body = text === undefined ? undefined : JSON.parse(text); } catch { body = undefined; }
    const uris = (body as { redirect_uris?: unknown } | undefined)?.redirect_uris;
    const valid = Array.isArray(uris) && uris.length > 0 && uris.every((u) => typeof u === 'string' && approved.has(u));
    if (!valid) {
      sendText(response, 400, JSON.stringify({ error: 'invalid_redirect_uri', error_description: 'redirect URI is not approved' }), 'application/json');
      return true;
    }
    (request as IncomingMessage & { body?: unknown }).body = body;
    return false;
  }

  function consentPage(uid: string, clientName: string, scopes: string[]): string {
    const boxes = scopes
      .map((s) => `<label><input type="checkbox" name="scope" value="${escapeHtml(s)}" ${s === 'read' || s === ADMIN_SCOPE ? 'checked' : ''}> ${escapeHtml(s)}</label><br>`)
      .join('');
    return `<!doctype html><meta charset="utf-8"><title>Approve client</title>
<h1>Approve ${escapeHtml(clientName)}?</h1>
<p>This client asks for access to your Alexa devices. Choose the permissions to grant:</p>
<form method="post" action="/interaction/${escapeHtml(uid)}/confirm">${boxes}<button type="submit">Approve</button></form>
<form method="post" action="/interaction/${escapeHtml(uid)}/abort"><button type="submit">Deny</button></form>`;
  }

  async function interaction(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const match = /^\/interaction\/([A-Za-z0-9_-]+)(?:\/(finish|confirm|abort))?$/.exec(url.pathname);
    if (!match) return false;
    const uid = match[1] ?? '';
    const action = match[2];

    if (request.method === 'POST') {
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== issuerOrigin) { sendText(response, 403, 'forbidden', 'text/plain'); return true; }
    }

    let details;
    try {
      details = await provider.interactionDetails(request, response);
    } catch {
      sendText(response, 400, 'This sign-in session has expired. Start again from the client.', 'text/plain');
      return true;
    }
    if (details.uid !== uid) { sendText(response, 400, 'invalid interaction', 'text/plain'); return true; }

    if (action === 'abort' && request.method === 'POST') {
      await provider.interactionFinished(request, response, { error: 'access_denied', error_description: 'denied by the owner' }, { mergeWithLastSubmission: false });
      return true;
    }

    if (action === 'finish' && request.method === 'GET') {
      const verified = redeemTicket(url.searchParams.get('ticket'), uid);
      if (!verified || verified.accountId !== ownerAccountId) {
        await provider.interactionFinished(request, response, { error: 'access_denied', error_description: 'this account is not authorized' }, { mergeWithLastSubmission: false });
        return true;
      }
      await provider.interactionFinished(request, response, { login: { accountId: verified.accountId } }, { mergeWithLastSubmission: false });
      return true;
    }

    if (action === 'confirm' && request.method === 'POST') {
      if (details.prompt.name !== 'consent' || details.session?.accountId !== ownerAccountId) {
        sendText(response, 403, 'forbidden', 'text/plain');
        return true;
      }
      const grant = details.grantId
        ? await provider.Grant.find(details.grantId)
        : new provider.Grant({ accountId: ownerAccountId, clientId: String(details.params.client_id) });
      if (!grant) { sendText(response, 400, 'invalid interaction', 'text/plain'); return true; }
      const missing = details.prompt.details as { missingOIDCScope?: string[]; missingOIDCClaims?: string[]; missingResourceScopes?: Record<string, string[]> };
      const form = new URLSearchParams((await readLimited(request, 4096)) ?? '');
      const chosen = new Set(form.getAll('scope'));
      if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
      if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims);
      let granted = 0;
      for (const [indicator, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
        const allowed = scopes.filter((s) => chosen.has(s));
        const refused = scopes.filter((s) => !chosen.has(s));
        granted += allowed.length;
        if (allowed.length) grant.addResourceScope(indicator, allowed.join(' '));
        if (refused.length) grant.rejectResourceScope(indicator, refused.join(' '));
      }
      if (granted === 0) {
        await provider.interactionFinished(request, response, { error: 'access_denied', error_description: 'no permission was granted' }, { mergeWithLastSubmission: false });
        return true;
      }
      const grantId = await grant.save();
      await provider.interactionFinished(request, response, { consent: { grantId } }, { mergeWithLastSubmission: true });
      return true;
    }

    if (!action && request.method === 'GET') {
      if (details.prompt.name === 'login') {
        response.writeHead(302, { location: await signIn.begin(uid), 'cache-control': 'no-store' });
        response.end();
        return true;
      }
      if (details.prompt.name === 'consent') {
        const client = await provider.Client.find(String(details.params.client_id));
        const isAdminClient = options.adminRedirectUri !== undefined && client?.redirectUris?.length === 1
          && client.redirectUris[0] === options.adminRedirectUri;
        const allowed: readonly string[] = isAdminClient ? [ADMIN_SCOPE] : SCOPES;
        const requested = String(details.params.scope ?? '').split(' ').filter((s) => allowed.includes(s));
        sendText(response, 200, consentPage(uid, client?.clientName ?? 'an MCP client', requested));
        return true;
      }
    }
    sendText(response, 405, 'method not allowed', 'text/plain');
    return true;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', options.baseUrl);
    if (request.method === 'POST' && url.pathname === '/reg' && (await registration(request, response))) return;
    if (await interaction(request, response, url)) return;

    if (url.pathname === '/signin/callback' && request.method === 'GET') {
      try {
        const { uid, accountId } = await signIn.complete(url.searchParams);
        response.writeHead(302, { location: `/interaction/${uid}/finish?ticket=${issueTicket(uid, accountId)}`, 'cache-control': 'no-store' });
        response.end();
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const reason = typeof code === 'string' ? code : error instanceof Error ? error.message : 'unknown';
        console.log(`Sign-in failed: ${/^[A-Za-z0-9_:.\- ]{1,60}$/.test(reason) ? reason : 'unclassified'}`);
        sendText(response, 400, 'Sign-in could not be completed.', 'text/plain');
      }
      return;
    }
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      sendText(response, 200, JSON.stringify(protectedResourceMetadata()), 'application/json');
      return;
    }
    providerCallback(request, response);
  }

  function protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource,
      authorization_servers: [options.baseUrl],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ['header'],
    };
  }

  async function authenticate(request: IncomingMessage): Promise<AuthInfo | undefined> {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) return undefined;
    const stored = await provider.AccessToken.find(token);
    if (!stored || stored.isExpired || stored.aud !== resource || !stored.accountId || !stored.clientId) return undefined;
    return {
      token: '',
      clientId: stored.clientId,
      scopes: (stored.scope ?? '').split(' ').filter(Boolean),
      extra: { principal: stored.accountId },
    };
  }

  async function authenticateAdmin(request: IncomingMessage): Promise<AuthInfo | undefined> {
    const auth = await authenticate(request);
    if (!auth || !auth.scopes.includes(ADMIN_SCOPE) || options.adminRedirectUri === undefined) return undefined;
    const client = await provider.Client.find(auth.clientId);
    const ok = client?.redirectUris?.length === 1 && client.redirectUris[0] === options.adminRedirectUri;
    return ok ? auth : undefined;
  }

  return { provider, handle, authenticate, authenticateAdmin, protectedResourceMetadata };
}

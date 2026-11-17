import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair } from 'jose';
import { createHttpServer } from '../../src/http-server.js';
import { createIssuer, type Issuer, type SignInProvider } from '../../src/issuer.js';
import { MutationService } from '../../src/mutation-service.js';
import { OidcStore } from '../../src/oidc-store.js';
import { SqliteJournal } from '../../src/sqlite-journal.js';
import { FakeAlexa } from './fake-alexa.js';

export const APPROVED_REDIRECT = 'https://client.example/callback';
export const OWNER = 'owner-object-id';

// Sign-in stub: the "identity provider" is a link back to our own callback naming the account.
export const stubSignIn = (base: () => string, who: () => string): SignInProvider => ({
  begin: async (uid) => `${base()}/signin/callback?uid=${uid}&who=${who()}`,
  complete: async (query) => ({ uid: query.get('uid') ?? '', accountId: query.get('who') ?? '' }),
});

export async function startAuthServer(opts: {
  signIn?: (base: () => string) => SignInProvider;
  resource?: string;
  adapter?: FakeAlexa;
  allowedTargets?: string[];
} = {}) {
  const store = new OidcStore(':memory:');
  const adapter = opts.adapter ?? new FakeAlexa();
  const journal = new SqliteJournal(':memory:');
  const mutations = opts.allowedTargets
    ? new MutationService(adapter, journal, { allowedTargets: new Set(opts.allowedTargets) })
    : undefined;
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const signingKey = { ...(await exportJWK(privateKey)), alg: 'RS256', use: 'sig', kid: 'test-key' };
  let who = OWNER;
  const holder: { issuer?: Issuer } = {};
  let base = '';
  const server = createHttpServer({
    adapter,
    sessionHealth: () => 'usable',
    authenticate: (request) => holder.issuer?.authenticate(request) ?? Promise.resolve(undefined),
    allowedOrigins: [],
    resourceMetadataUrl: 'placeholder',
    fallback: (request, response) => holder.issuer?.handle(request, response),
    ...(mutations ? { mutations } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const resource = opts.resource ?? `${base}/mcp`;
  const issuer = createIssuer({
    baseUrl: base,
    resource,
    approvedRedirectUris: [APPROVED_REDIRECT],
    ownerAccountId: OWNER,
    store,
    signingKey: signingKey as never,
    cookieKeys: [randomBytes(32).toString('hex')],
    signIn: (opts.signIn ?? ((b) => stubSignIn(b, () => who)))(() => base),
  });
  holder.issuer = issuer;
  return {
    base, resource, issuer, store, adapter, journal,
    signInAs: (account: string) => { who = account; },
    stop: () => new Promise<void>((resolve) => { server.close(() => { store.close(); journal.close(); resolve(); }); }),
  };
}

export type AuthServer = Awaited<ReturnType<typeof startAuthServer>>;

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

class CookieJar {
  private readonly cookies = new Map<string, string>();
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (pair && index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
}

async function hop(jar: CookieJar, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), cookie: jar.header() } });
  jar.store(response);
  return response;
}

export async function registerClient(s: AuthServer, redirectUris: string[] = [APPROVED_REDIRECT]) {
  const response = await fetch(`${s.base}/reg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Client', redirect_uris: redirectUris, token_endpoint_auth_method: 'none' }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

// Drives the browser side of the authorization code flow and returns the final redirect URL.
export async function authorize(s: AuthServer, params: Record<string, string>, approve: boolean | string[] = true): Promise<URL> {
  const jar = new CookieJar();
  const url = new URL(`${s.base}/auth`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let next = url.toString();
  for (let i = 0; i < 12; i++) {
    const response = await hop(jar, next);
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const target = new URL(location, s.base);
      if (target.toString().startsWith(APPROVED_REDIRECT)) return target;
      next = target.toString();
      continue;
    }
    const html = await response.text();
    const match = /action="(\/interaction\/[^"]+\/(confirm|abort))"/.exec(html);
    if (response.status === 200 && match?.[1]) {
      const offered = [...html.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1] ?? '');
      const chosen = Array.isArray(approve) ? approve : offered;
      const action = approve === false ? match[1].replace('/confirm', '/abort') : match[1];
      const post = await hop(jar, `${s.base}${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(chosen.map((scope) => ['scope', scope])).toString(),
      });
      const to = post.headers.get('location');
      if (!to) throw new Error(`consent did not redirect: ${post.status}`);
      next = new URL(to, s.base).toString();
      continue;
    }
    throw new Error(`flow stopped at ${response.status}: ${html.slice(0, 200)}`);
  }
  throw new Error('too many redirects');
}

export async function fullFlow(s: AuthServer, scope = 'read', extra: Record<string, string> = {}, approve: boolean | string[] = true) {
  const client = await registerClient(s);
  const { verifier, challenge } = pkce();
  const final = await authorize(s, {
    client_id: client.body.client_id ?? '',
    redirect_uri: APPROVED_REDIRECT,
    response_type: 'code',
    scope,
    state: 'st',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: s.resource,
    ...extra,
  }, approve);
  return { clientId: client.body.client_id ?? '', verifier, final, code: final.searchParams.get('code') };
}

export async function tokenRequest(s: AuthServer, form: Record<string, string>) {
  const response = await fetch(`${s.base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

export async function exchange(s: AuthServer, flow: { clientId: string; verifier: string; code: string | null }) {
  return tokenRequest(s, {
    grant_type: 'authorization_code',
    code: flow.code ?? '',
    redirect_uri: APPROVED_REDIRECT,
    client_id: flow.clientId,
    code_verifier: flow.verifier,
    resource: s.resource,
  });
}

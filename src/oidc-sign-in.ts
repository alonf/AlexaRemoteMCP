import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { SignInProvider } from './issuer.js';

export interface OidcSignInOptions {
  // Discovery base of the owner's identity provider, e.g. the tenant's v2.0 issuer URL.
  issuerUrl: string;
  clientId: string;
  clientSecret?: () => Promise<string>;
  redirectUri: string;
  // The claim carrying the stable account identifier. For Entra this is the object ID.
  accountClaim?: string;
  fetchImpl?: typeof fetch;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Pending {
  uid: string;
  nonce: string;
  verifier: string;
  expires: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

// Delegates the owner's sign-in to an external OIDC provider (authorization code with PKCE)
// and returns the account identifier from the verified ID token.
export class OidcSignIn implements SignInProvider {
  private readonly pending = new Map<string, Pending>();
  private discovery: Promise<Discovery> | undefined;
  private jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  constructor(private readonly options: OidcSignInOptions) {}

  private get http(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private load(): Promise<Discovery> {
    this.discovery ??= this.http(`${this.options.issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).then(async (response) => {
      if (!response.ok) throw new Error('discovery_failed');
      return (await response.json()) as Discovery;
    }).catch((error) => { this.discovery = undefined; throw error; });
    return this.discovery;
  }

  async begin(uid: string): Promise<string> {
    const meta = await this.load();
    this.sweep();
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    this.pending.set(state, { uid, nonce, verifier, expires: Date.now() + PENDING_TTL_MS });
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      scope: 'openid profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async complete(query: URLSearchParams): Promise<{ uid: string; accountId: string }> {
    const state = query.get('state') ?? '';
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expires < Date.now()) throw new Error('unknown_state');
    const code = query.get('code');
    if (query.get('error') || !code) throw new Error('sign_in_refused');

    const meta = await this.load();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.redirectUri,
      client_id: this.options.clientId,
      code_verifier: pending.verifier,
    });
    if (this.options.clientSecret) form.set('client_secret', await this.options.clientSecret());
    const response = await this.http(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`token_exchange_failed_${response.status}`);
    const idToken = ((await response.json()) as { id_token?: unknown }).id_token;
    if (typeof idToken !== 'string') throw new Error('missing_id_token');

    this.jwks ??= createRemoteJWKSet(new URL(meta.jwks_uri), { timeoutDuration: REQUEST_TIMEOUT_MS });
    const { payload } = await jwtVerify(idToken, this.jwks, {
      issuer: meta.issuer,
      audience: this.options.clientId,
      algorithms: ['RS256', 'ES256', 'PS256'],
    });
    if (payload.nonce !== pending.nonce) throw new Error('nonce_mismatch');
    const accountId = payload[this.options.accountClaim ?? 'oid'];
    if (typeof accountId !== 'string' || accountId === '') throw new Error('missing_account_claim');
    return { uid: pending.uid, accountId };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [state, entry] of this.pending) if (entry.expires < now) this.pending.delete(state);
  }
}

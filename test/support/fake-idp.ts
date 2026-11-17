import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface FakeIdpBehavior {
  account: string | undefined;
  audience?: string;
  nonce?: string;
  omitIdToken?: boolean;
}

// A minimal stand-in for the owner's identity provider (Entra): discovery, authorize,
// token and keys. It signs in whichever account the test selects, without any UI.
export async function startFakeIdp(clientId: string) {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig', kid: 'idp-key' };
  const behavior: FakeIdpBehavior = { account: undefined };
  const codes = new Map<string, { nonce: string; challenge: string }>();
  let base = '';

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', base);
      const json = (body: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` });
      }
      if (url.pathname === '/jwks') return json({ keys: [jwk] });
      if (url.pathname === '/authorize') {
        const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
        const code = randomBytes(16).toString('hex');
        codes.set(code, { nonce: url.searchParams.get('nonce') ?? '', challenge: url.searchParams.get('code_challenge') ?? '' });
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
        response.writeHead(302, { location: redirect.toString() });
        return void response.end();
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const entry = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifierHash = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (!entry || verifierHash !== entry.challenge || form.get('client_id') !== clientId) {
          response.writeHead(400, { 'content-type': 'application/json' });
          return void response.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        if (behavior.omitIdToken) return json({ access_token: 'unused' });
        const claims: Record<string, unknown> = { nonce: behavior.nonce ?? entry.nonce };
        if (behavior.account !== undefined) claims.oid = behavior.account;
        const idToken = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'RS256', kid: 'idp-key' })
          .setIssuer(base).setAudience(behavior.audience ?? clientId).setSubject('app-scoped-sub')
          .setIssuedAt().setExpirationTime('5m').sign(privateKey);
        return json({ id_token: idToken, token_type: 'Bearer' });
      }
      response.writeHead(404);
      response.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    behavior,
    stop: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

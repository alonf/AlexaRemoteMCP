import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/no-network.js';
import { APPROVED_REDIRECT, authorize, exchange, fullFlow, pkce, registerClient, startAuthServer } from './support/oauth-flow.js';

test('metadata advertises S256, registration and the protected resource', async () => {
  const s = await startAuthServer();
  try {
    const meta = (await (await fetch(`${s.base}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
    assert.ok(typeof meta.registration_endpoint === 'string');
    const resource = (await (await fetch(`${s.base}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    assert.equal(resource.resource, s.resource);
    assert.deepEqual(resource.authorization_servers, [s.base]);
  } finally { await s.stop(); }
});

test('the full flow issues a token that reaches the MCP endpoint', async () => {
  const s = await startAuthServer();
  try {
    const flow = await fullFlow(s);
    assert.ok(flow.code, `expected a code, got ${flow.final}`);
    const token = await exchange(s, flow);
    assert.equal(token.status, 200, JSON.stringify(token.body));
    assert.ok(token.body.access_token);
    assert.ok(token.body.refresh_token);
    const init = await fetch(`${s.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.body.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(init.status, 200);
    const unauth = await fetch(`${s.base}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(unauth.status, 401);
  } finally { await s.stop(); }
});

test('an authorization request without PKCE is rejected and no code is issued', async () => {
  const s = await startAuthServer();
  try {
    const client = await registerClient(s);
    const final = await authorize(s, {
      client_id: client.body.client_id ?? '', redirect_uri: APPROVED_REDIRECT, response_type: 'code',
      scope: 'read', state: 'st', resource: s.resource,
    });
    assert.equal(final.searchParams.get('code'), null);
    assert.equal(final.searchParams.get('error'), 'invalid_request');
    const plain = pkce();
    const weak = await authorize(s, {
      client_id: client.body.client_id ?? '', redirect_uri: APPROVED_REDIRECT, response_type: 'code',
      scope: 'read', state: 'st', resource: s.resource, code_challenge: plain.verifier, code_challenge_method: 'plain',
    });
    assert.equal(weak.searchParams.get('code'), null);
  } finally { await s.stop(); }
});

test('an unapproved redirect URI is rejected at registration and nothing is stored', async () => {
  const s = await startAuthServer();
  try {
    const before = s.store.dumpForInspection();
    const result = await registerClient(s, ['https://evil.example/callback']);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_redirect_uri');
    const mixed = await registerClient(s, [APPROVED_REDIRECT, 'https://evil.example/callback']);
    assert.equal(mixed.status, 400);
    assert.equal(s.store.dumpForInspection(), before);
    const approvedOk = await registerClient(s);
    assert.equal(approvedOk.status, 201);
  } finally { await s.stop(); }
});

test('a resource other than the MCP resource is refused', async () => {
  const s = await startAuthServer();
  try {
    const flow = await fullFlow(s, 'read', { resource: 'https://other.example/mcp' });
    assert.equal(flow.code, null);
    assert.equal(flow.final.searchParams.get('error'), 'invalid_target');
  } finally { await s.stop(); }
});

test('a token minted for another audience is not accepted', async () => {
  const s = await startAuthServer();
  try {
    const { provider } = s.issuer;
    const registered = await registerClient(s);
    const client = await provider.Client.find(registered.body.client_id ?? '');
    assert.ok(client);
    const mint = (aud: string) => new provider.AccessToken({ accountId: 'owner-object-id', client, aud, scope: 'read' } as never).save();
    const value = await mint('https://other.example/mcp');
    const okValue = await mint(s.resource);
    const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as never;
    assert.equal(await s.issuer.authenticate(request(value)), undefined);
    assert.deepEqual((await s.issuer.authenticate(request(okValue)))?.scopes, ['read']);
  } finally { await s.stop(); }
});

test('the token store holds no usable token, code or refresh value', async () => {
  const s = await startAuthServer();
  try {
    const flow = await fullFlow(s);
    const token = await exchange(s, flow);
    const dump = s.store.dumpForInspection();
    for (const secret of [flow.code, token.body.access_token, token.body.refresh_token, flow.verifier]) {
      assert.ok(secret);
      assert.ok(!dump.includes(secret), 'a secret value appears in the store');
    }
  } finally { await s.stop(); }
});

test('an authorization code cannot be reused or redeemed with a wrong verifier', async () => {
  const s = await startAuthServer();
  try {
    const flow = await fullFlow(s);
    const wrong = await exchange(s, { ...flow, verifier: pkce().verifier });
    assert.equal(wrong.status, 400);
    const flow2 = await fullFlow(s);
    assert.equal((await exchange(s, flow2)).status, 200);
    assert.equal((await exchange(s, flow2)).status, 400);
  } finally { await s.stop(); }
});

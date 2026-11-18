import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/no-network.js';
import { exchange, fullFlow, startAuthServer, tokenRequest, type AuthServer } from './support/oauth-flow.js';

const refresh = (s: AuthServer, clientId: string, token: string) =>
  tokenRequest(s, { grant_type: 'refresh_token', refresh_token: token, client_id: clientId, resource: s.resource });

const authenticated = (s: AuthServer, token: string | undefined) =>
  s.issuer.authenticate({ headers: { authorization: `Bearer ${token ?? ''}` } } as never);

test('refresh issues a new pair and the old refresh token stops working', async () => {
  const s = await startServer();
  try {
    const flow = await fullFlow(s);
    const first = await exchange(s, flow);
    const second = await refresh(s, flow.clientId, first.body.refresh_token ?? '');
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(second.body.refresh_token, first.body.refresh_token);
    assert.notEqual(second.body.access_token, first.body.access_token);
    assert.ok(await authenticated(s, second.body.access_token));
    const again = await refresh(s, flow.clientId, first.body.refresh_token ?? '');
    assert.equal(again.status, 400);
  } finally { await s.stop(); }
});

test('replaying a rotated refresh token revokes the whole grant', async () => {
  const s = await startServer();
  try {
    const flow = await fullFlow(s);
    const first = await exchange(s, flow);
    const second = await refresh(s, flow.clientId, first.body.refresh_token ?? '');
    assert.equal((await refresh(s, flow.clientId, first.body.refresh_token ?? '')).status, 400);
    assert.equal((await refresh(s, flow.clientId, second.body.refresh_token ?? '')).status, 400);
    assert.equal(await authenticated(s, second.body.access_token), undefined);
  } finally { await s.stop(); }
});

test('a refresh cannot ask for a different resource', async () => {
  const s = await startServer();
  try {
    const flow = await fullFlow(s);
    const first = await exchange(s, flow);
    const response = await tokenRequest(s, {
      grant_type: 'refresh_token', refresh_token: first.body.refresh_token ?? '', client_id: flow.clientId,
      resource: 'https://other.example/mcp',
    });
    assert.equal(response.status, 400);
  } finally { await s.stop(); }
});

const startServer = () => startAuthServer();

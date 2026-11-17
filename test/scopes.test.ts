import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/no-network.js';
import { exchange, fullFlow, startAuthServer } from './support/oauth-flow.js';

const scopesOf = async (s: Awaited<ReturnType<typeof startAuthServer>>, token: string | undefined) =>
  (await s.issuer.authenticate({ headers: { authorization: `Bearer ${token ?? ''}` } } as never))?.scopes;

test('the owner can grant fewer scopes than the client asked for', async () => {
  const s = await startAuthServer();
  try {
    const flow = await fullFlow(s, 'read mutate', {}, ['read']);
    assert.ok(flow.code, `expected a code, got ${flow.final}`);
    const token = await exchange(s, flow);
    assert.equal(token.status, 200, JSON.stringify(token.body));
    assert.deepEqual(await scopesOf(s, token.body.access_token), ['read']);
  } finally { await s.stop(); }
});

test('the owner granting everything yields both scopes', async () => {
  const s = await startAuthServer();
  try {
    const flow = await fullFlow(s, 'read mutate');
    const token = await exchange(s, flow);
    assert.deepEqual((await scopesOf(s, token.body.access_token))?.sort(), ['mutate', 'read']);
  } finally { await s.stop(); }
});

test('granting nothing, or denying, issues no code', async () => {
  const s = await startAuthServer();
  try {
    const none = await fullFlow(s, 'read mutate', {}, []);
    assert.equal(none.code, null);
    assert.equal(none.final.searchParams.get('error'), 'access_denied');
    const denied = await fullFlow(s, 'read', {}, false);
    assert.equal(denied.code, null);
    assert.equal(denied.final.searchParams.get('error'), 'access_denied');
  } finally { await s.stop(); }
});

test('a client cannot obtain a scope the owner did not grant by asking again', async () => {
  const s = await startAuthServer();
  try {
    const flow = await fullFlow(s, 'read mutate', {}, ['read']);
    const first = await exchange(s, flow);
    const upgrade = await fetch(`${s.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: first.body.refresh_token ?? '', client_id: flow.clientId,
        scope: 'read mutate', resource: s.resource,
      }),
    });
    const body = (await upgrade.json()) as Record<string, string>;
    const scopes = upgrade.status === 200 ? await scopesOf(s, body.access_token) : [];
    assert.ok(!(scopes ?? []).includes('mutate'), 'the token must not carry the refused scope');
  } finally { await s.stop(); }
});

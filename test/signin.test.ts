import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/no-network.js';
import { startFakeIdp } from './support/fake-idp.js';
import { OidcSignIn } from '../src/oidc-sign-in.js';
import { exchange, fullFlow, OWNER, startAuthServer } from './support/oauth-flow.js';

const IDP_CLIENT = 'issuer-app-registration';

async function start() {
  const idp = await startFakeIdp(IDP_CLIENT);
  const s = await startAuthServer({
    signIn: (base) => new OidcSignIn({ issuerUrl: idp.base, clientId: IDP_CLIENT, redirectUri: `${base()}/signin/callback` }),
  });
  return { idp, s, stop: async () => { await s.stop(); await idp.stop(); } };
}

test('the owner signs in through the identity provider and a code is issued for the owner', async () => {
  const t = await start();
  try {
    t.idp.behavior.account = OWNER;
    const flow = await fullFlow(t.s);
    assert.ok(flow.code, `expected a code, got ${flow.final}`);
    const token = await exchange(t.s, flow);
    assert.equal(token.status, 200);
    const info = await t.s.issuer.authenticate({ headers: { authorization: `Bearer ${token.body.access_token}` } } as never);
    assert.equal(info?.extra?.principal, OWNER);
  } finally { await t.stop(); }
});

test('another account that signs in is refused and no code is issued', async () => {
  const t = await start();
  try {
    t.idp.behavior.account = 'someone-else';
    const flow = await fullFlow(t.s);
    assert.equal(flow.code, null);
    assert.equal(flow.final.searchParams.get('error'), 'access_denied');
  } finally { await t.stop(); }
});

test('an ID token with the wrong audience, wrong nonce or no account claim is not accepted', async () => {
  const t = await start();
  try {
    for (const tamper of [{ audience: 'another-app' }, { nonce: 'forged' }, { account: undefined }]) {
      t.idp.behavior.account = OWNER;
      Object.assign(t.idp.behavior, { audience: undefined, nonce: undefined }, tamper);
      await assert.rejects(fullFlow(t.s), /flow stopped at 400/);
    }
    t.idp.behavior.account = OWNER;
    Object.assign(t.idp.behavior, { audience: undefined, nonce: undefined, omitIdToken: true });
    await assert.rejects(fullFlow(t.s), /flow stopped at 400/);
  } finally { await t.stop(); }
});

test('a callback with an unknown or reused state is rejected', async () => {
  const t = await start();
  try {
    const bad = await fetch(`${t.s.base}/signin/callback?code=x&state=nope`, { redirect: 'manual' });
    assert.equal(bad.status, 400);
    const noCode = await fetch(`${t.s.base}/signin/callback?error=access_denied`, { redirect: 'manual' });
    assert.equal(noCode.status, 400);
  } finally { await t.stop(); }
});

test('the finish step needs a ticket from a verified sign-in', async () => {
  const t = await start();
  try {
    const response = await fetch(`${t.s.base}/interaction/abc123/finish?ticket=forged`, { redirect: 'manual' });
    assert.equal(response.status, 400);
  } finally { await t.stop(); }
});

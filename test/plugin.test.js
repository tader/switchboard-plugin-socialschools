import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import setup, { API, LOGIN, WEB_CALLBACK, WEB_CLIENT } from '../index.js';
import openapi from '../openapi.js';

const account = { userProfileId: 42, displayName: 'Example parent', roles: [{ type: 1, school: { id: 7, displayName: 'Example school' } }] };
const service = (settings = {}) => setup({ settings }).services[0];
const oauth = settings => service(settings).authMethods[0];
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const conn = (extra = {}) => ({ config: { allowWrites: false }, credentials: { accessToken: 'example-token', schoolId: 7, roleType: 1 }, ...extra });
const request = (method = 'GET', url = `${API}events`) => ({ method, url: new URL(url), headers: new Headers() });

test('web sign-in uses registered silent callback and S256 PKCE', () => {
  const auth = oauth();
  assert.throws(() => auth.connect({ config: {}, callbackUrl: 'https://example.test/oauth/callback', state: 'flow' }), /Redirect URI/);
  const step = auth.connect({ config: {}, callbackUrl: WEB_CALLBACK, state: 'flow' });
  const url = new URL(step.redirect);
  assert.equal(url.origin, LOGIN);
  assert.equal(url.searchParams.get('client_id'), WEB_CLIENT);
  assert.equal(url.searchParams.get('redirect_uri'), WEB_CALLBACK);
  assert.equal(url.searchParams.get('state'), 'flow');
  assert.equal(url.searchParams.get('scope'), 'openid SocsWebApi');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(step.pending.verifier).digest('base64url'));
});

test('callback validates state before exchanging code, identifies school role and drops secrets from config', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    return response(url.endsWith('/connect/token') ? { access_token: 'access', expires_in: 3600 } : account);
  });
  const auth = oauth();
  const args = { config: { roleType: '1', allowWrites: true, accessToken: 'must-not-persist' }, callbackUrl: WEB_CALLBACK, state: 'flow' };
  const step = auth.connect(args);
  await assert.rejects(auth.callback({ ...args, pending: step.pending, params: { code: 'code', state: 'wrong' } }), /Invalid/);
  assert.equal(calls.length, 0);
  const result = await auth.callback({ ...args, pending: step.pending, params: { code: 'code', state: 'flow' } });
  assert.deepEqual(result.config, { schoolId: 7, roleType: 1, allowWrites: true });
  assert.equal(result.account.id, '42:7:1');
  assert.equal(result.credentials.schoolId, 7);
  assert.equal(result.credentials.roleType, 1);
  assert.ok(result.credentials.expiresAt > Date.now());
  const body = calls[0].opts.body;
  assert.equal(body.get('code_verifier'), step.pending.verifier);
  assert.equal(body.get('redirect_uri'), WEB_CALLBACK);
  assert.equal(body.get('client_secret'), null);
  assert.ok(calls.every(c => c.opts.redirect === 'error'));
});

test('custom clients use their callback, secret, and optional offline_access', async t => {
  let tokenBody;
  t.mock.method(globalThis, 'fetch', async (url, opts) => { if (url.endsWith('/connect/token')) { tokenBody = opts.body; return response({ access_token: 'token', refresh_token: 'refresh', expires_in: 1000 }); } return response(account); });
  const auth = oauth({ clientId: 'registered', clientSecret: 'secret-example', offlineAccess: true });
  const args = { config: {}, callbackUrl: 'https://example.test/oauth/callback', state: 'flow' };
  const step = auth.connect(args);
  assert.equal(new URL(step.redirect).searchParams.get('scope'), 'openid SocsWebApi offline_access');
  const result = await auth.callback({ ...args, pending: step.pending, params: { code: 'code', state: 'flow' } });
  assert.equal(tokenBody.get('client_secret'), 'secret-example');
  assert.equal(result.credentials.refreshToken, 'refresh');
});

test('multiple schools require explicit selection; account identity includes school and role', async t => {
  t.mock.method(globalThis, 'fetch', async () => response({ ...account, roles: [...account.roles, { type: 1, school: { id: 8, name: 'Other school' } }] }));
  const auth = service().authMethods[1];
  await assert.rejects(auth.connect({ config: { accessToken: 'token' } }), /several school roles/);
  const result = await auth.connect({ config: { accessToken: 'token', schoolId: '8' } });
  assert.equal(result.account.id, '42:8:1');
  assert.deepEqual(result.config, { schoolId: 8, roleType: 1, allowWrites: false });
  assert.equal(result.config.accessToken, undefined);
  await assert.rejects(auth.connect({ config: { accessToken: 'token', schoolId: '8wrong' } }), /positive integer/);
});

test('authorize adds bearer and exact school context; no writes by default', async () => {
  const auth = oauth();
  const r = request();
  await auth.authorize(r, conn());
  assert.equal(r.headers.get('authorization'), 'Bearer example-token');
  assert.equal(r.headers.get('schoolid'), '7');
  assert.equal(r.headers.get('roletypeid'), '1');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await assert.rejects(auth.authorize(request(method), conn()), /read-only/);
  await assert.rejects(auth.authorize(request('POST'), conn({ config: { allowWrites: 'true' } })), /read-only/);
  await auth.authorize(request('POST'), conn({ config: { allowWrites: true } }));
});

test('rejects wrong destinations and malformed credentials before making requests', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  for (const url of ['https://example.test/api/v1/events', 'http://api.socialschools.eu/api/v1/events', 'https://api.socialschools.eu/elsewhere', 'https://user:pass@api.socialschools.eu/api/v1/events']) {
    const r = request('GET', url);
    await assert.rejects(oauth().authorize(r, conn()), /only be used/);
    assert.equal(r.headers.get('authorization'), null);
  }
  await assert.rejects(oauth().authorize(request(), conn({ credentials: { accessToken: 'bad\r\ntoken' } })), /Reconnect/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('refresh rotation preserves school context and returns credentials for encrypted persistence', async t => {
  let body;
  t.mock.method(globalThis, 'fetch', async (url, opts) => { assert.equal(url, `${LOGIN}/connect/token`); body = opts.body; return response({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }); });
  const old = conn(); old.credentials.refreshToken = 'old-refresh'; old.credentials.expiresAt = Date.now() - 1000;
  const req = request();
  const result = await oauth().authorize(req, old);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'old-refresh');
  assert.equal(result.credentials.refreshToken, 'rotated');
  assert.equal(result.credentials.schoolId, 7);
  assert.equal(req.headers.get('authorization'), 'Bearer fresh');
});

test('expired tokens without refresh require reconnection, including a forced 401 retry', async () => {
  const auth = oauth();
  const c = conn(); c.credentials.expiresAt = Date.now() - 1;
  await assert.rejects(auth.authorize(request(), c), /Reconnect/);
  await assert.rejects(auth.authorize(request(), conn(), { force: true }), /Reconnect/);
});

test('upstream errors and network exceptions never expose response bodies or credentials', async t => {
  const auth = service().authMethods[1];
  t.mock.method(globalThis, 'fetch', async () => response({ secret: 'sensitive-upstream-data' }, 403));
  await assert.rejects(auth.connect({ config: { accessToken: 'token' } }), e => /HTTP 403/.test(e.message) && !e.message.includes('sensitive'));
  globalThis.fetch = async () => { throw new Error('sensitive-network-data'); };
  await assert.rejects(auth.connect({ config: { accessToken: 'token' } }), e => !e.message.includes('sensitive'));
});

test('API reference has unique operation IDs, valid path parameters, and usable write schemas', () => {
  const ids = new Set();
  for (const [url, methods] of Object.entries(openapi.paths)) for (const [verb, op] of Object.entries(methods)) {
    assert.ok(!ids.has(op.operationId), op.operationId); ids.add(op.operationId);
    for (const [, name] of url.matchAll(/\{(\w+)\}/g)) assert.ok(op.parameters.some(p => p.in === 'path' && p.name === name && p.required));
    if (verb !== 'get') assert.ok(op.requestBody.required);
  }
  assert.ok(ids.has('listParentMeetings'));
  assert.ok(ids.has('sendMessage'));
  assert.equal(openapi.paths['/inboxes/{inboxId}/topics'].post.requestBody.content['application/json'].schema.properties.status.default, 30);
});

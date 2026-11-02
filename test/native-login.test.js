import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import setup, { API, LOGIN, IOS_CLIENT, IOS_CALLBACK, WEB_CLIENT } from '../index.js';

const account = { userProfileId: 42, displayName: 'Example parent', roles: [{ type: 1, school: { id: 7, displayName: 'Example school' } }] };
const config = () => ({ username: 'private-username', password: 'private-password', roleType: '1', allowWrites: false });
const method = (settings = {}) => setup({ settings }).services[0].authMethods.find(m => m.id === 'ios');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const redirect = location => new Response(null, { status: 303, headers: { location } });
const html = (body, values = {}) => {
  const headers = new Headers(values);
  headers.set('content-type', 'text/html');
  return new Response(body, { headers });
};
const tokens = () => ({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 });
const request = () => ({ method: 'GET', url: new URL(`${API}events`), headers: new Headers() });
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

function installFlow(t, options = {}) {
  const calls = [];
  let authorization, returnUrl, callback;
  t.mock.method(globalThis, 'fetch', async (value, init) => {
    const url = new URL(value), i = calls.length;
    calls.push({ url, init });
    if (i === 0) {
      authorization = url;
      returnUrl = `/connect/authorize/callback?${authorization.searchParams}`;
      callback = new URL(IOS_CALLBACK);
      callback.search = new URLSearchParams({ code: 'private-code', state: authorization.searchParams.get('state'), iss: LOGIN }).toString();
      options.callback?.(callback);
      assert.equal(url.origin, LOGIN);
      assert.equal(url.pathname, '/connect/authorize');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.get('cookie'), null);
      return options.authorize?.(authorization) ?? redirect(`${LOGIN}/Account/Login?${new URLSearchParams({ ReturnUrl: returnUrl })}`);
    }
    if (url.pathname === '/Account/Login' && init.method === 'GET') {
      const form = `<form method="post" action=""><input name="ReturnUrl" type="hidden" value="${escape(returnUrl)}"><input name="Username"><input name="Password" type="password"><input value="private-csrf&amp;value" name="__RequestVerificationToken" type="hidden"><button name="button" value="login">Login</button></form>`;
      const headers = new Headers();
      headers.append('set-cookie', 'csrf=private-cookie; Path=/; Secure; HttpOnly');
      headers.append('set-cookie', 'outside=must-not-send; Domain=example.test; Path=/');
      headers.append('set-cookie', 'scoped=must-not-send; Path=/elsewhere');
      headers.append('set-cookie', 'removed=must-not-send; Path=/; Max-Age=0');
      headers.append('set-cookie', 'expired=must-not-send; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
      return options.form?.(form, authorization) ?? html(form, headers);
    }
    if (url.pathname === '/Account/Login' && init.method === 'POST') {
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.get('cookie'), 'csrf=private-cookie');
      assert.equal(init.headers.get('origin'), LOGIN);
      assert.equal(init.body.get('Username'), 'private-username');
      assert.equal(init.body.get('Password'), 'private-password');
      assert.equal(init.body.get('ReturnUrl'), returnUrl);
      assert.equal(init.body.get('__RequestVerificationToken'), 'private-csrf&value');
      assert.equal(init.body.get('button'), 'login');
      return options.login?.(returnUrl) ?? html(`<html><meta content="0;url=${escape(returnUrl)}" http-equiv="refresh"></html>`, { 'set-cookie': 'auth=private-auth; Path=/; Secure; HttpOnly' });
    }
    if (url.pathname === '/connect/authorize/callback') {
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.equal(init.headers.get('cookie'), 'csrf=private-cookie; auth=private-auth');
      return redirect(callback.href);
    }
    if (url.pathname === '/connect/token') {
      assert.equal(url.origin, LOGIN);
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.cookie, undefined);
      assert.equal(init.body.get('client_id'), IOS_CLIENT);
      assert.equal(init.body.get('client_secret'), null);
      if (init.body.get('grant_type') === 'authorization_code') {
        assert.equal(init.body.get('code'), 'private-code');
        assert.equal(init.body.get('redirect_uri'), IOS_CALLBACK);
        assert.equal(createHash('sha256').update(init.body.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
        return options.tokens?.() ?? json(tokens());
      }
      assert.equal(init.body.get('grant_type'), 'refresh_token');
      assert.equal(init.body.get('refresh_token'), 'private-refresh');
      return options.refresh?.() ?? json({ ...tokens(), access_token: 'new-access', refresh_token: 'rotated-refresh' });
    }
    if (url.href === `${API}useraccounts/current`) {
      assert.equal(init.headers.authorization, 'Bearer private-access');
      return json(account);
    }
    throw new Error('Unexpected synthetic request');
  });
  return { calls, get authorization() { return authorization; } };
}

async function assertPrivateFailure(action, pattern) {
  await assert.rejects(action, error => {
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /private-|must-not-send|upstream-/);
    return true;
  });
}

test('persistent sign-in is default and completes native PKCE with transient cookies and credentials', async t => {
  const flow = installFlow(t);
  const service = setup({ settings: { clientId: 'custom', clientSecret: 'must-not-send', offlineAccess: false } }).services[0];
  assert.equal(service.authMethods[0].id, 'ios');
  const auth = method({ clientId: 'custom', clientSecret: 'must-not-send' });
  assert.equal(auth.fields.find(f => f.key === 'password').type, 'secret');
  const result = await auth.connect({ config: config() });
  assert.equal(flow.calls.length, 6);
  assert.equal(flow.authorization.searchParams.get('client_id'), IOS_CLIENT);
  assert.equal(flow.authorization.searchParams.get('redirect_uri'), IOS_CALLBACK);
  assert.equal(flow.authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(flow.authorization.searchParams.get('scope'), 'openid profile SocsWebApi email offline_access SocsNotificationApi');
  assert.ok(flow.authorization.searchParams.get('state'));
  assert.ok(flow.authorization.searchParams.get('nonce'));
  assert.deepEqual(result.config, { schoolId: 7, roleType: 1, allowWrites: false });
  assert.deepEqual(Object.keys(result.credentials).sort(), ['accessToken', 'expiresAt', 'oauthClientId', 'refreshToken', 'roleType', 'schoolId']);
  assert.equal(result.credentials.oauthClientId, IOS_CLIENT);
  assert.equal(result.credentials.refreshToken, 'private-refresh');
  assert.ok(result.credentials.expiresAt > Date.now());
  assert.doesNotMatch(JSON.stringify(result), /private-username|private-password|private-cookie|private-csrf|private-code/);
});

test('native sign-ins generate independent PKCE, state and nonce', async t => {
  const first = installFlow(t);
  await method().connect({ config: config() });
  const a = first.authorization;
  const second = installFlow(t);
  await method().connect({ config: config() });
  for (const key of ['state', 'nonce', 'code_challenge']) assert.notEqual(a.searchParams.get(key), second.authorization.searchParams.get(key));
});

test('headless login also handles an HTTP redirect after posting the form', async t => {
  installFlow(t, { login: target => new Response(null, { status: 302, headers: { location: target, 'set-cookie': 'auth=private-auth; Path=/' } }) });
  await method().connect({ config: config() });
});

test('native refresh is pinned to the issuing client and persists rotated tokens and school context', async t => {
  installFlow(t);
  const result = await method().connect({ config: config() });
  const conn = { ...result, credentials: { ...result.credentials, expiresAt: Date.now() - 1 } };
  const req = request();
  const updated = await method({ clientId: 'changed-client', clientSecret: 'must-not-send' }).authorize(req, conn);
  assert.equal(updated.credentials.refreshToken, 'rotated-refresh');
  assert.equal(updated.credentials.oauthClientId, IOS_CLIENT);
  assert.equal(updated.credentials.schoolId, 7);
  assert.equal(updated.credentials.roleType, 1);
  assert.equal(req.headers.get('authorization'), 'Bearer new-access');
  assert.equal(req.headers.get('schoolid'), '7');
  assert.equal(req.headers.get('roletypeid'), '1');
});

test('forced 401 renewal works before expiry and retains a refresh token when the response omits it', async t => {
  const flow = installFlow(t, { refresh: () => json({ access_token: 'new-access', expires_in: 3600 }) });
  const auth = method(), conn = await auth.connect({ config: config() });
  assert.equal(await auth.authorize(request(), conn), undefined);
  assert.equal(flow.calls.length, 6);
  const updated = await auth.authorize(request(), conn, { force: true });
  assert.equal(flow.calls.length, 7);
  assert.equal(updated.credentials.refreshToken, 'private-refresh');
});

test('invalid credentials produce a sanitized failure without retrying the password', async t => {
  const flow = installFlow(t, { login: () => html('<form>private-password private-username upstream-error</form>') });
  await assertPrivateFailure(method().connect({ config: config() }), /Check your username and password/);
  assert.equal(flow.calls.filter(c => c.init.method === 'POST').length, 1);
});

test('login form parsing supports quoted/reordered attributes and HTML entities', async t => {
  installFlow(t, { form: form => html(form.replace('method="post"', "METHOD='POST'").replace('name="Username"', "name='Username'").replace('private-csrf&amp;value', 'private-csrf&#38;value'), { 'set-cookie': 'csrf=private-cookie; Path=/' }) });
  await method().connect({ config: config() });
});

test('missing input is rejected before network access', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  for (const cfg of [{}, { username: 'private-username' }, { username: '', password: 'private-password' }]) {
    await assertPrivateFailure(method().connect({ config: cfg }), /Enter your Social Schools username and password/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

for (const [name, mutate] of [
  ['missing CSRF', form => form.replace('name="__RequestVerificationToken"', 'name="unused"')],
  ['wrong ReturnUrl state', form => form.replace(/state=[^&]+/, 'state=private-wrong-state')],
  ['external form action', form => form.replace('action=""', 'action="https://example.test/private-password"')],
  ['wrong form endpoint', form => form.replace('action=""', `action="${LOGIN}/somewhere"`)],
  ['duplicate hidden input', form => form.replace('</form>', '<input name="ReturnUrl" value="private-wrong"></form>')],
]) test(`rejects ${name} before submitting credentials`, async t => {
  const flow = installFlow(t, { form: form => html(mutate(form)) });
  await assertPrivateFailure(method().connect({ config: config() }), /unsupported sign-in/);
  assert.equal(flow.calls.length, 2);
});

for (const [name, mutate] of [
  ['wrong state', u => u.searchParams.set('state', 'private-wrong')],
  ['missing state', u => u.searchParams.delete('state')],
  ['wrong issuer', u => u.searchParams.set('iss', 'https://example.test')],
  ['missing issuer', u => u.searchParams.delete('iss')],
  ['duplicate code', u => u.searchParams.append('code', 'private-extra')],
  ['provider error', u => u.searchParams.set('error', 'private-upstream-error')],
  ['wrong callback path', u => { u.pathname = '/other'; }],
  ['callback fragment', u => { u.hash = 'private-secret'; }],
]) test(`rejects native callback with ${name} before exchanging the code`, async t => {
  const flow = installFlow(t, { callback: mutate });
  await assertPrivateFailure(method().connect({ config: config() }), /unsupported sign-in/);
  assert.equal(flow.calls.some(c => c.url.pathname === '/connect/token'), false);
});

for (const target of ['https://example.test/private-password', 'http://login.socialschools.eu/Account/Login', `${LOGIN}/Account/Login#private-secret`, 'https://user:private-password@login.socialschools.eu/Account/Login']) {
  test('rejects unsafe authorization redirect without forwarding credentials', async t => {
    const flow = installFlow(t, { authorize: () => redirect(target) });
    await assertPrivateFailure(method().connect({ config: config() }), /unsupported sign-in/);
    assert.equal(flow.calls.length, 1);
  });
}

test('redirect limit stops a login loop', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return redirect(`${LOGIN}/Account/Login`); });
  await assertPrivateFailure(method().connect({ config: config() }), /unsupported sign-in/);
  assert.equal(calls, 10);
});

test('does not replay a password on a 307 redirect', async t => {
  const flow = installFlow(t, { login: () => new Response(null, { status: 307, headers: { location: `${LOGIN}/Account/Login` } }) });
  await assertPrivateFailure(method().connect({ config: config() }), /unsupported sign-in/);
  assert.equal(flow.calls.length, 3);
});

test('rejects unsafe meta-refresh without forwarding cookies', async t => {
  const flow = installFlow(t, { login: () => html('<meta http-equiv="refresh" content="0;url=https://example.test/private-password">') });
  await assertPrivateFailure(method().connect({ config: config() }), /unsupported sign-in/);
  assert.equal(flow.calls.length, 3);
});

for (const [name, data, pattern] of [
  ['missing refresh token', { access_token: 'private-access', expires_in: 3600 }, /did not issue a refresh token/],
  ['invalid refresh token', { ...tokens(), refresh_token: 'private-refresh\r\n' }, /valid refresh token/],
  ['invalid access token', { ...tokens(), access_token: 'private-access\r\n' }, /valid access token/],
  ['invalid lifetime', { ...tokens(), expires_in: 'not-a-number' }, /valid token lifetime/],
  ['infinite lifetime', { ...tokens(), expires_in: 'Infinity' }, /valid token lifetime/],
  ['null response', null, /valid access token/],
]) test(`rejects ${name} without revealing upstream data`, async t => {
  installFlow(t, { tokens: () => json(data) });
  await assertPrivateFailure(method().connect({ config: config() }), pattern);
});

test('revoked refresh grant asks for reconnection without leaking the upstream response', async t => {
  installFlow(t, { refresh: () => json({ error: 'invalid_grant', error_description: 'private-refresh upstream-error' }, 400) });
  const auth = method(), conn = await auth.connect({ config: config() });
  await assertPrivateFailure(auth.authorize(request(), conn, { force: true }), /Reconnect your account/);
});

test('network exceptions and response-read errors are redacted', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private-password upstream-network-error'); });
  await assertPrivateFailure(method().connect({ config: config() }), /Could not reach/);
  globalThis.fetch = async () => ({ status: 200, headers: new Headers(), text() { throw new Error('private-password upstream-read-error'); } });
  await assertPrivateFailure(method().connect({ config: config() }), /Could not reach/);
});

test('native credentials retain API-host and read-only request restrictions', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const conn = { config: { allowWrites: false }, credentials: { accessToken: 'old-access', refreshToken: 'private-refresh', expiresAt: 0, schoolId: 7, roleType: 1, oauthClientId: IOS_CLIENT } };
  await assert.rejects(method().authorize({ ...request(), method: 'POST' }, conn), /read-only/);
  await assert.rejects(method().authorize({ ...request(), url: new URL('https://example.test/api/v1/events') }, conn), /only be used/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('stored web client binding is respected when plugin settings change', async t => {
  let body;
  t.mock.method(globalThis, 'fetch', async (url, init) => { body = init.body; return json(tokens()); });
  const auth = setup({ settings: { clientId: 'changed-client', clientSecret: 'must-not-send' } }).services[0].authMethods.find(m => m.id === 'oauth');
  await auth.authorize(request(), { config: {}, credentials: { oauthClientId: WEB_CLIENT, accessToken: 'old-access', refreshToken: 'private-refresh', expiresAt: 0, schoolId: 7, roleType: 1 } });
  assert.equal(body.get('client_id'), WEB_CLIENT);
  assert.equal(body.get('client_secret'), null);
});

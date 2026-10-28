import { randomBytes, createHash } from 'node:crypto';
import openapi from './openapi.js';

export const API = 'https://api.socialschools.eu/api/v1/';
export const LOGIN = 'https://login.socialschools.eu';
export const WEB_CLIENT = 'eu.socialschools.webapp';
export const WEB_CALLBACK = 'https://app.socialschools.eu/silent.html';
const timeout = () => AbortSignal.timeout(30_000);

async function jsonRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: options.signal ?? timeout() });
  } catch {
    throw new Error('Could not reach Social Schools. Try again.');
  }
  if (!response.ok) {
    // Never surface upstream error bodies: they may contain credentials or account data.
    if (response.status === 401) throw new Error('Social Schools sign-in expired. Reconnect your account.');
    throw new Error(`Social Schools returned HTTP ${response.status}.`);
  }
  try { return await response.json(); }
  catch { throw new Error('Social Schools returned an invalid response.'); }
}

function positiveId(value, label) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

async function identify(credentials, config) {
  const profile = await jsonRequest(`${API}useraccounts/current`, {
    headers: { authorization: `Bearer ${credentials.accessToken}` },
  });
  if (!Number.isSafeInteger(profile.userProfileId) || !Array.isArray(profile.roles)) {
    throw new Error('Social Schools did not return a valid account profile.');
  }
  const school = config.schoolId ? positiveId(config.schoolId, 'School ID') : undefined;
  const type = positiveId(config.roleType ?? '1', 'Role type');
  const roles = profile.roles.filter(r => r.type === type && (!school || r.school?.id === school));
  if (roles.length !== 1) {
    throw new Error(roles.length ? 'This account has several school roles. Enter a School ID in Advanced.' : 'No matching school role. Check School ID and Role type in Advanced.');
  }
  const role = roles[0];
  const schoolId = positiveId(role.school?.id, 'School ID');
  return {
    credentials: { ...credentials, schoolId, roleType: type },
    // Stable account + school + role prevents two school connections overwriting each other.
    account: { id: `${profile.userProfileId}:${schoolId}:${type}`, label: `${profile.displayName || 'Social Schools'} · ${role.school.displayName || role.school.name || schoolId}` },
    config: { schoolId, roleType: type, allowWrites: config.allowWrites === true },
  };
}

function checkRequest(req, conn) {
  if (req.url.origin !== new URL(API).origin || !req.url.pathname.startsWith('/api/v1/') || req.url.username || req.url.password) {
    throw new Error('Social Schools credentials can only be used with its API.');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase()) && conn.config.allowWrites !== true) {
    throw new Error('This Social Schools connection is read-only. Reconnect with Allow messages and changes enabled to make changes.');
  }
}

export default function setup(ctx) {
  const settings = ctx.settings ?? {};
  const clientId = settings.clientId?.trim() || WEB_CLIENT;
  const customClient = clientId !== WEB_CLIENT;
  const fields = [
    { key: 'schoolId', label: 'School ID', description: 'Only needed if your account has roles at several schools. Find the ID in /useraccounts/current.', advanced: true },
    { key: 'roleType', label: 'Role type', type: 'select', default: '1', options: [{ value: '1', label: 'Parent/guardian' }, { value: '2', label: 'Employee' }, { value: '3', label: 'Student' }], advanced: true },
    { key: 'allowWrites', label: 'Allow messages and changes', type: 'boolean', default: false, description: 'Allows sending messages and changing meeting reservations. Reads may update read receipts at Social Schools.' },
  ];
  async function exchange(params, previous = {}) {
    const body = new URLSearchParams({ client_id: clientId, ...params });
    if (customClient && settings.clientSecret) body.set('client_secret', settings.clientSecret);
    const data = await jsonRequest(`${LOGIN}/connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (typeof data.access_token !== 'string' || !data.access_token || /[\r\n]/.test(data.access_token)) {
      throw new Error('Social Schools did not return a valid access token.');
    }
    return {
      ...previous,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? previous.refreshToken,
      expiresAt: Number(data.expires_in) > 0 ? Date.now() + Number(data.expires_in) * 1000 : undefined,
    };
  }
  async function fresh(conn, force) {
    const c = conn.credentials;
    if (typeof c?.accessToken !== 'string' || !c.accessToken || /[\r\n]/.test(c.accessToken)) throw new Error('Reconnect your Social Schools account.');
    if (!force && !(c.expiresAt !== undefined && c.expiresAt < Date.now() + 60_000)) return { credentials: c, refreshed: false };
    if (!c.refreshToken) throw new Error('Social Schools sign-in expired. Reconnect your account.');
    return { credentials: await exchange({ grant_type: 'refresh_token', refresh_token: c.refreshToken }, c), refreshed: true };
  }
  const common = {
    async authorize(req, conn, opts = {}) {
      checkRequest(req, conn);
      const { credentials, refreshed } = await fresh(conn, opts.force);
      req.headers.set('authorization', `Bearer ${credentials.accessToken}`);
      req.headers.set('schoolid', String(positiveId(credentials.schoolId, 'School ID')));
      req.headers.set('roletypeid', String(positiveId(credentials.roleType, 'Role type')));
      return refreshed ? { credentials } : undefined;
    },
  };
  return { services: [{
    id: 'socialschools', name: 'Social Schools', icon: 'icon.svg',
    description: 'Announcements, calendar events, conversations, and parent meetings.',
    baseUrl: API, allowedHosts: ['api.socialschools.eu'], openapi,
    authMethods: [{
      ...common, id: 'oauth', name: 'Sign in with Social Schools',
      description: customClient ? 'Sign in with your registered Social Schools client.' : `In Advanced, set Redirect URI to ${WEB_CALLBACK}. After sign-in, copy the full address of the blank page and paste it back into Switchboard.`,
      fields,
      connect({ config, callbackUrl, state }) {
        if (!customClient && callbackUrl !== WEB_CALLBACK) throw new Error(`In Advanced, set Redirect URI to ${WEB_CALLBACK}, then try again.`);
        const verifier = randomBytes(32).toString('base64url');
        const url = new URL(`${LOGIN}/connect/authorize`);
        url.search = new URLSearchParams({
          client_id: clientId, redirect_uri: callbackUrl, response_type: 'code', response_mode: 'query',
          scope: `openid SocsWebApi${customClient && settings.offlineAccess === true ? ' offline_access' : ''}`,
          state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        }).toString();
        return { redirect: url.href, pending: { verifier, callbackUrl, clientId } };
      },
      async callback({ config, callbackUrl, pending, params, state }) {
        if (params.error) throw new Error('Social Schools sign-in was declined or expired. Try again.');
        if (!params.code || !state || params.state !== state || (params.iss && params.iss !== LOGIN) || !pending?.verifier || pending.callbackUrl !== callbackUrl || pending.clientId !== clientId) {
          throw new Error('Invalid Social Schools sign-in response. Start sign-in again.');
        }
        const credentials = await exchange({ grant_type: 'authorization_code', code: params.code, code_verifier: pending.verifier, redirect_uri: callbackUrl });
        return identify(credentials, config);
      },
    }, {
      ...common, id: 'token', name: 'Access token',
      description: 'Use an existing Social Schools access token. Reconnect when it expires.',
      fields: [{ key: 'accessToken', label: 'Access token', type: 'secret', required: true }, ...fields],
      async connect({ config }) {
        const accessToken = String(config.accessToken ?? '').trim();
        if (!accessToken || /[\r\n]/.test(accessToken)) throw new Error('Enter a valid Social Schools access token.');
        return identify({ accessToken }, config);
      },
    }],
  }] };
}

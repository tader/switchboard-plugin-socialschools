import { createHash, randomBytes } from 'node:crypto';

export const LOGIN = 'https://login.socialschools.eu';
export const IOS_CLIENT = 'eu.socialschools.ios';
export const IOS_CALLBACK = 'eu.socialschools.ios:/oauthredirect';
const SCOPES = 'openid profile SocsWebApi email offline_access SocsNotificationApi';
const failed = () => new Error('Social Schools sign-in failed. Check your username and password. If an additional sign-in step is required, use browser sign-in.');
const invalid = () => new Error('Social Schools returned an unsupported sign-in page or redirect. Try browser sign-in.');

function loginUrl(value, base = LOGIN) {
  let url;
  try { url = new URL(value, base); } catch { throw invalid(); }
  if (url.origin !== LOGIN || url.username || url.password || url.hash) throw invalid();
  return url;
}

// This jar is private to one sign-in and is never returned or persisted.
class LoginCookies {
  cookies = new Map();
  receive(response, url) {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...parts] = header.split(';');
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim(), value = pair.slice(at + 1).trim();
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\x00-\x20\x7f;,]/.test(value)) continue;
      const attrs = new Map(parts.map(part => {
        const at = part.indexOf('=');
        return [part.slice(0, at < 0 ? undefined : at).trim().toLowerCase(), at < 0 ? '' : part.slice(at + 1).trim()];
      }));
      const domain = attrs.get('domain')?.toLowerCase().replace(/^\./, '');
      if (domain && domain !== url.hostname && !url.hostname.endsWith(`.${domain}`)) continue;
      const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1).replace(/\/$/, '') || '/';
      const path = attrs.get('path')?.startsWith('/') ? attrs.get('path') : defaultPath;
      let expires = attrs.has('expires') ? Date.parse(attrs.get('expires')) : Infinity;
      if (attrs.has('max-age') && /^-?\d+$/.test(attrs.get('max-age'))) expires = Date.now() + Number(attrs.get('max-age')) * 1000;
      const key = `${path}\n${name}`;
      if (expires <= Date.now()) this.cookies.delete(key);
      else this.cookies.set(key, { name, value, path, expires });
    }
  }
  header(url) {
    return [...this.cookies.values()]
      .filter(c => !(c.expires <= Date.now()) && (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)
      .map(c => `${c.name}=${c.value}`).join('; ');
  }
}

function decode(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, key) => {
    if (!key.startsWith('#')) return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[key.toLowerCase()];
    const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
  });
}

function attributes(tag) {
  const attrs = new Map();
  for (const m of tag.matchAll(/([^\s=<>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const key = m[1].toLowerCase();
    if (attrs.has(key)) throw invalid();
    attrs.set(key, decode(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

// Read only the captured form and meta-refresh shapes, never execute page scripts.
function pageStep(html, url, authorization, config, submitted) {
  html = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const tag = '(?:[^<>"\']|"[^"\\r\\n]*"|\'[^\'\\r\\n]*\')*';
  for (const m of html.matchAll(new RegExp(`<meta\\b${tag}>`, 'gi'))) {
    const a = attributes(m[0]);
    if (a.get('http-equiv')?.toLowerCase() !== 'refresh') continue;
    const redirect = a.get('content')?.match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*([\s\S]+)$/i);
    if (!redirect) throw invalid();
    return { url: loginUrl(redirect[1].replace(/^(['"])([\s\S]*)\1$/, '$2'), url), method: 'GET' };
  }
  if (submitted) throw failed();
  if (url.pathname !== '/Account/Login') throw invalid();
  for (const m of html.matchAll(new RegExp(`(<form\\b${tag}>)([\\s\\S]*?)<\\/form\\s*>`, 'gi'))) {
    const form = attributes(m[1]);
    if (form.get('method')?.toLowerCase() !== 'post') continue;
    const action = loginUrl(form.get('action') || url.href, url);
    if (action.pathname !== '/Account/Login') throw invalid();
    const inputs = new Map();
    for (const input of m[2].matchAll(new RegExp(`<input\\b${tag}>`, 'gi'))) {
      const a = attributes(input[0]), name = a.get('name');
      if (!name) continue;
      if (inputs.has(name)) throw invalid();
      inputs.set(name, a.get('value') ?? '');
    }
    if (!inputs.has('Username') || !inputs.has('Password') || !inputs.get('__RequestVerificationToken') || !inputs.get('ReturnUrl')) continue;
    const target = loginUrl(inputs.get('ReturnUrl'), url);
    if (target.pathname !== '/connect/authorize/callback') throw invalid();
    for (const [name, value] of authorization.searchParams) {
      if (target.searchParams.getAll(name).length !== 1 || target.searchParams.get(name) !== value) throw invalid();
    }
    return { url: action, method: 'POST', body: new URLSearchParams({
      Username: config.username, Password: config.password, ReturnUrl: inputs.get('ReturnUrl'),
      __RequestVerificationToken: inputs.get('__RequestVerificationToken'), button: 'login',
    }) };
  }
  throw invalid();
}

export async function nativeAuthorization(config) {
  if (typeof config.username !== 'string' || !config.username.trim() || typeof config.password !== 'string' || !config.password) {
    throw new Error('Enter your Social Schools username and password.');
  }
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  const authorization = new URL(`${LOGIN}/connect/authorize`);
  authorization.search = new URLSearchParams({ client_id: IOS_CLIENT, redirect_uri: IOS_CALLBACK, response_type: 'code',
    scope: SCOPES, state, nonce: randomBytes(32).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString();
  const cookies = new LoginCookies(), signal = AbortSignal.timeout(30_000);
  let step = { url: authorization, method: 'GET' }, submitted = false;
  for (let i = 0; i < 10; i++) {
    if (step.url.protocol === 'eu.socialschools.ios:') {
      const callback = step.url, p = callback.searchParams;
      if (`${callback.protocol}${callback.pathname}` !== IOS_CALLBACK || callback.host || callback.username || callback.password || callback.hash ||
          p.has('error') || !p.get('code') || ['code', 'state', 'iss'].some(k => p.getAll(k).length !== 1) || p.get('state') !== state || p.get('iss') !== LOGIN) throw invalid();
      return { code: p.get('code'), verifier };
    }
    const url = loginUrl(step.url);
    const headers = new Headers({ accept: 'text/html' });
    const cookie = cookies.header(url);
    if (cookie) headers.set('cookie', cookie);
    if (step.method === 'POST') {
      headers.set('content-type', 'application/x-www-form-urlencoded');
      headers.set('origin', LOGIN);
      submitted = true;
    }
    let response, html;
    try {
      response = await fetch(url.href, { method: step.method, body: step.body, headers, redirect: 'manual', signal });
      cookies.receive(response, url);
      if (response.status === 200) html = await response.text();
      else await response.body?.cancel();
    } catch { throw new Error('Could not reach Social Schools. Try again.'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (step.method === 'POST' && [307, 308].includes(response.status)) throw invalid();
      const location = response.headers.get('location');
      if (!location) throw invalid();
      let next;
      try { next = new URL(location, url); } catch { throw invalid(); }
      step = { url: next, method: 'GET' };
    } else if (response.status === 200) {
      step = pageStep(html, url, authorization, config, submitted);
    } else if ([400, 401, 403].includes(response.status)) throw failed();
    else throw new Error('Social Schools sign-in is unavailable. Try again.');
  }
  throw invalid();
}

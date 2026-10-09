// Player accounts: Google and GitHub sign-in run by this Worker (no auth
// vendor), with users and sessions in D1 (env.DB, schema in migrations/).
//   GET  /auth/start/:provider?return=<page>   302 to the provider (google | github | dev)
//   GET  /auth/callback/:provider?code&state   302 back to <page>#tpt3d_session=<token>,
//                                              or <page>#tpt3d_auth_error=<message>
//   GET  /auth/me       { user: { id, name, email, avatar, plan } }, or 401
//   POST /auth/logout   ends this session; 204
//   POST /auth/delete   deletes the account and all its sessions; 204
// Sign-in is the OAuth authorization code flow with PKCE (S256) and a random
// state, kept in oauth_states until the callback consumes it. The session is an
// opaque bearer token: the page keeps it in localStorage and sends
// `Authorization: Bearer <token>`; D1 only holds its SHA-256. It reaches the page
// in the URL fragment, which browsers never send to a server. No cookies.
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET.
// AUTH_DEV=1 (local only, relay/.dev.vars) adds the 'dev' provider, which signs in
// a fake player at once, and lets sign-in return to plain-http dev and LAN pages.
export const AUTH = {
  SESSION_DAYS: 60,                // a session lasts this long from sign-in
  STATE_MINUTES: 10,               // time allowed at the provider's sign-in page
  TOKEN_BYTES: 32,                 // session token randomness
  STATE_BYTES: 32,                 // OAuth state randomness
  VERIFIER_BYTES: 32,              // PKCE verifier randomness (43 chars, RFC 7636's minimum)
  PROVIDER_TIMEOUT_MS: 10_000,     // per request to Google or GitHub
  MAX_RETURN_CHARS: 2048,          // longest return URL accepted
  MAX_CODE_CHARS: 2048,            // longest authorization code accepted
  MAX_PROVIDER_ID_CHARS: 255,      // longer provider account ids are refused, not cut
  MAX_NAME_CHARS: 100,
  MAX_EMAIL_CHARS: 254,            // RFC 5321's limit
  MAX_AVATAR_CHARS: 2048,
  CORS_MAX_AGE_S: 86400,           // browsers may cache a preflight this long
  SESSION_PARAM: 'tpt3d_session',  // URL fragment keys the page reads on return
  ERROR_PARAM: 'tpt3d_auth_error',
};

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const BITS_PER_BYTE = 8;
const BITS_PER_BASE64_CHAR = 6;
const base64Chars = (bytes) => Math.ceil((bytes * BITS_PER_BYTE) / BITS_PER_BASE64_CHAR);

const FLOW_PATH = /^\/auth\/(start|callback)\/([a-z]+)$/;
const STATE_FORMAT = new RegExp(`^[A-Za-z0-9_-]{${base64Chars(AUTH.STATE_BYTES)}}$`);
const BEARER = new RegExp(`^Bearer ([A-Za-z0-9_-]{${base64Chars(AUTH.TOKEN_BYTES)}})$`, 'i');
const USER_AGENT = 'tpt3d-relay'; // GitHub's API refuses requests without one
const DEFAULT_NAME = 'Player';    // when a provider gives neither a name nor an email
const DEV_CODE = 'dev';           // the dev provider's stand-in authorization code
const DEV_PROFILE = { id: 'dev', name: 'Dev Player', email: 'dev@example.com', avatar: null };

const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const GITHUB_USER = 'https://api.github.com/user';
const GITHUB_EMAILS = 'https://api.github.com/user/emails';

const PROVIDERS = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    params: { response_type: 'code', scope: 'openid email profile' },
    clientId: 'GOOGLE_CLIENT_ID',
    clientSecret: 'GOOGLE_CLIENT_SECRET',
    profile: googleProfile,
  },
  github: {
    label: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    params: { scope: 'read:user user:email' },
    clientId: 'GITHUB_CLIENT_ID',
    clientSecret: 'GITHUB_CLIENT_SECRET',
    profile: githubProfile,
  },
  dev: { label: 'Dev', dev: true },
};

const devMode = (env) => env.AUTH_DEV === '1';

// ---- responses

const noStore = { 'Cache-Control': 'no-store' };
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...noStore, ...headers } });
const fail = (status, message, headers) => json(status, { error: { message } }, headers);
const text = (status, body) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noStore } });
const redirect = (location) => new Response(null, { status: 302, headers: { Location: location, ...noStore } });
const failTo = (page, message) => redirect(`${page}#${AUTH.ERROR_PARAM}=${encodeURIComponent(message)}`);

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': String(AUTH.CORS_MAX_AGE_S),
    Vary: 'Origin',
  };
}

// ---- crypto

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const randomToken = (bytes) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const sha256Hex = async (s) => [...(await sha256(s))].map((b) => b.toString(16).padStart(2, '0')).join('');
const pkceChallenge = async (verifier) => base64url(await sha256(verifier));

// ---- sessions

const bearer = (request) => request.headers.get('Authorization')?.match(BEARER)?.[1] ?? null;

// The signed-in player for this request, or null. Never throws.
export async function getUser(request, env) {
  const token = bearer(request);
  if (!token || !env.DB) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.avatar, u.plan FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    ).bind(await sha256Hex(token), Date.now()).first();
    return row ? { id: row.id, name: row.name, email: row.email, avatar: row.avatar, plan: row.plan } : null;
  } catch (err) {
    console.warn(`auth: session lookup failed: ${err.message}`);
    return null;
  }
}

// Creates or refreshes the user and opens a session for them, in one transaction.
async function createSession(env, provider, profile, token) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, provider, provider_id, email, name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, provider_id) DO UPDATE SET email = excluded.email, name = excluded.name, avatar = excluded.avatar`,
    ).bind(crypto.randomUUID(), provider, profile.id, profile.email, profile.name, profile.avatar, now),
    env.DB.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
       SELECT ?, id, ?, ? FROM users WHERE provider = ? AND provider_id = ?`,
    ).bind(await sha256Hex(token), now, now + AUTH.SESSION_DAYS * MS_PER_DAY, provider, profile.id),
  ]);
}

// Drops abandoned sign-ins and expired sessions; cheap enough to run on every sign-in.
function sweep(env) {
  const now = Date.now();
  return env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
  ]).catch((err) => console.warn(`auth: sweep failed: ${err.message}`));
}

// ---- routes

export async function handleAuth(request, env, ctx, allowedOrigin) {
  const url = new URL(request.url);
  const [, step, name] = url.pathname.match(FLOW_PATH) ?? [];
  if (!step) return handleJSON(url.pathname, request, env, allowedOrigin);
  if (!Object.hasOwn(PROVIDERS, name)) return text(404, 'Unknown sign-in provider');
  if (request.method !== 'GET') return text(405, 'Method not allowed');
  try {
    return step === 'start' ? await startSignIn(name, url, env, ctx, allowedOrigin) : await finishSignIn(name, url, env);
  } catch (err) {
    console.warn(`auth: ${step} ${name} failed: ${err.message}`);
    return text(500, 'Sign-in is unavailable right now');
  }
}

// The page to come back to: an allowed site page, without its fragment. Plain-http
// pages (dev servers, LAN) only on a dev relay, or anyone on a shared network
// could host a page that collects a passer-by's session token.
function returnPage(raw, env, allowedOrigin) {
  if (!raw || raw.length > AUTH.MAX_RETURN_CHARS) return null;
  let page;
  try { page = new URL(raw); } catch { return null; }
  if (!allowedOrigin(page.origin) || page.username || page.password) return null;
  if (page.protocol !== 'https:' && !devMode(env)) return null;
  page.hash = '';
  return page.href;
}

// Providers a player can sign in with on this server: their secrets are set (dev: AUTH_DEV=1).
export const signInProviders = (env) => Object.keys(PROVIDERS).filter((name) => credentials(PROVIDERS[name], env));

function credentials(provider, env) {
  if (provider.dev) return devMode(env) ? {} : null;
  const id = env[provider.clientId];
  const secret = env[provider.clientSecret];
  return id && secret ? { id, secret } : null;
}

const notSetUp = (provider) => `${provider.label} sign-in isn't set up on this server yet.`;
const callbackURL = (url, name) => `${url.origin}/auth/callback/${name}`;

async function startSignIn(name, url, env, ctx, allowedOrigin) {
  const page = returnPage(url.searchParams.get('return'), env, allowedOrigin);
  if (!page) return text(400, 'Bad return URL: it must be a page of the game (plain http only on a dev relay, AUTH_DEV=1)');
  const provider = PROVIDERS[name];
  const creds = credentials(provider, env);
  if (!creds) return failTo(page, notSetUp(provider));

  ctx.waitUntil(sweep(env));
  const state = randomToken(AUTH.STATE_BYTES);
  const verifier = randomToken(AUTH.VERIFIER_BYTES);
  try {
    await env.DB.prepare('INSERT INTO oauth_states (state, provider, verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(state, name, verifier, page, Date.now() + AUTH.STATE_MINUTES * MS_PER_MINUTE).run();
  } catch (err) {
    console.warn(`auth: saving sign-in state failed: ${err.message}`);
    return failTo(page, 'Sign-in is unavailable right now. Please try again later.');
  }

  const redirectURI = callbackURL(url, name);
  if (provider.dev) return redirect(`${redirectURI}?${new URLSearchParams({ code: DEV_CODE, state })}`);
  const params = new URLSearchParams({
    client_id: creds.id,
    redirect_uri: redirectURI,
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    ...provider.params,
  });
  return redirect(`${provider.authorize}?${params}`);
}

async function finishSignIn(name, url, env) {
  const state = url.searchParams.get('state') ?? '';
  if (!STATE_FORMAT.test(state)) return text(400, 'Bad sign-in state');
  // Deleting it first makes each state single-use, even if the code exchange fails.
  const pending = await env.DB.prepare('DELETE FROM oauth_states WHERE state = ? RETURNING provider, verifier, return_to, expires_at')
    .bind(state).first();
  if (!pending) return text(400, 'This sign-in has expired or was already used. Go back to the game and sign in again.');
  const page = pending.return_to;
  const provider = PROVIDERS[name];
  if (pending.expires_at < Date.now()) return failTo(page, 'Sign-in took too long. Please try again.');
  if (pending.provider !== name) return failTo(page, 'Sign-in failed. Please try again.');
  // The provider's own error codes aren't echoed back: only fixed messages reach the page.
  const denied = url.searchParams.get('error');
  if (denied) return failTo(page, denied === 'access_denied' ? 'Sign-in was cancelled.' : `${provider.label} sign-in failed. Please try again.`);
  const code = url.searchParams.get('code') ?? '';
  if (!code || code.length > AUTH.MAX_CODE_CHARS) return failTo(page, `${provider.label} sign-in failed. Please try again.`);
  const creds = credentials(provider, env);
  if (!creds) return failTo(page, notSetUp(provider));

  let profile;
  try {
    profile = cleanProfile(provider.dev
      ? DEV_PROFILE
      : await provider.profile(await exchangeCode(provider, creds, code, pending.verifier, callbackURL(url, name))));
  } catch (err) {
    console.warn(`auth: ${name} sign-in failed: ${err.message}`);
  }
  if (!profile) return failTo(page, `Couldn't sign in with ${provider.label}. Please try again.`);

  const token = randomToken(AUTH.TOKEN_BYTES);
  try {
    await createSession(env, name, profile, token);
  } catch (err) {
    console.warn(`auth: saving the session failed: ${err.message}`);
    return failTo(page, 'Sign-in is unavailable right now. Please try again later.');
  }
  return redirect(`${page}#${AUTH.SESSION_PARAM}=${token}`);
}

// JSON routes, called with fetch from the site.
const JSON_ROUTES = {
  '/auth/me': { method: 'GET', run: me },
  '/auth/logout': { method: 'POST', run: logout },
  '/auth/delete': { method: 'POST', run: deleteAccount },
};

async function handleJSON(path, request, env, allowedOrigin) {
  const origin = request.headers.get('Origin');
  const allowed = allowedOrigin(origin);
  const cors = allowed ? corsHeaders(origin) : {};
  const route = Object.hasOwn(JSON_ROUTES, path) ? JSON_ROUTES[path] : null;
  if (!route) return fail(404, 'Not found', cors);
  if (!allowed) return fail(403, 'Origin not allowed');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== route.method) return fail(405, 'Method not allowed', { ...cors, Allow: `${route.method}, OPTIONS` });
  try {
    return await route.run(request, env, cors);
  } catch (err) {
    console.warn(`auth: ${path} failed: ${err.message}`);
    return fail(500, 'Accounts are unavailable right now', cors);
  }
}

async function me(request, env, cors) {
  const user = await getUser(request, env);
  return user ? json(200, { user }, cors) : fail(401, 'Not signed in', cors);
}

async function logout(request, env, cors) {
  const token = bearer(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return new Response(null, { status: 204, headers: cors });
}

async function deleteAccount(request, env, cors) {
  const user = await getUser(request, env);
  if (!user) return fail(401, 'Not signed in', cors);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return new Response(null, { status: 204, headers: cors });
}

// ---- providers

async function exchangeCode(provider, creds, code, verifier, redirectURI) {
  const res = await fetch(provider.token, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: creds.id,
      client_secret: creds.secret,
      code,
      code_verifier: verifier,
      redirect_uri: redirectURI,
    }),
    signal: AbortSignal.timeout(AUTH.PROVIDER_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  // GitHub answers a bad code with 200 and { error }, so check for the token itself.
  if (!res.ok || typeof body?.access_token !== 'string') {
    throw new Error(`token exchange: HTTP ${res.status}${typeof body?.error === 'string' ? ` ${body.error}` : ''}`);
  }
  return body.access_token;
}

async function getJSON(url, accessToken) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(AUTH.PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).pathname}: HTTP ${res.status}`);
  return res.json();
}

async function googleProfile(accessToken) {
  const me = await getJSON(GOOGLE_USERINFO, accessToken);
  return { id: me.sub, name: me.name, email: me.email_verified === false ? null : me.email, avatar: me.picture };
}

async function githubProfile(accessToken) {
  const me = await getJSON(GITHUB_USER, accessToken);
  let email = me.email; // the public email, if they set one
  if (!email) {
    const emails = await getJSON(GITHUB_EMAILS, accessToken).catch(() => null);
    email = Array.isArray(emails) ? emails.find((e) => e?.primary && e?.verified)?.email : null;
  }
  return { id: typeof me.id === 'number' ? String(me.id) : null, name: me.name || me.login, email, avatar: me.avatar_url };
}

// Provider data is untrusted: keep only well-formed, bounded fields. Null when
// there's no usable account id.
function cleanProfile(p) {
  const str = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
  const id = str(p?.id, AUTH.MAX_PROVIDER_ID_CHARS);
  if (!id) return null;
  let email = str(p.email, AUTH.MAX_EMAIL_CHARS);
  if (!email?.includes('@')) email = null;
  let avatar = str(p.avatar, AUTH.MAX_AVATAR_CHARS);
  try { if (avatar && new URL(avatar).protocol !== 'https:') avatar = null; } catch { avatar = null; }
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, AUTH.MAX_NAME_CHARS) : null;
  return { id, email, name: name ?? email?.split('@')[0] ?? DEFAULT_NAME, avatar };
}

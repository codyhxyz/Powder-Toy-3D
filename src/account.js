import { RELAY_HTTP, LOCAL_RELAY } from './net/relay-url.js';

// Player accounts. Signing in (Google, through the relay's auth.js)
// raises the free AI's daily limit; everything else works the same signed out.
//
// The relay runs the OAuth flow and sends the page back with a session token in
// the URL fragment (#tpt3d_session=…, or #tpt3d_auth_error=… when it failed).
// The token lives in localStorage, never in a cookie, and goes to the relay as
// `Authorization: Bearer <token>`: on /auth/* and with the free provider's AI
// requests (ai/providers.js). Nothing here throws when the relay is down: the
// account reads as signed out until it answers again.
//
// A token only counts when this tab started the sign-in: signIn() puts a random
// nonce in the return URL and in sessionStorage, and finishSignIn() wants both to
// match. Without that, a link carrying someone else's token could sign a player
// into the sender's account.
//
// Relay routes (base RELAY_HTTP):
//   GET  /auth/start/:provider?return=<url>   full-page sign-in
//   GET  /auth/me       → { user: { id, name, email, avatar, plan } } or 401
//   POST /auth/logout   POST /auth/delete    (both 204)
//   GET  /ai/quota      → { tier: 'anon'|'free'|'paid', limit, used, remaining, providers, freeLimit }
//                         providers: the sign-ins this relay has set up; freeLimit: generations a day signed in

const TOKEN_STORE = 'powder-toy-3d:session';
const NONCE_STORE = 'powder-toy-3d:signin-nonce'; // sessionStorage: the sign-in this tab started
const SESSION_PARAM = 'tpt3d_session';    // fragment the relay returns a session in
const ERROR_PARAM = 'tpt3d_auth_error';   // ... or why signing in failed
const NONCE_PARAM = 'tpt3d_nonce';        // query parameter of the return URL
const NONCE_BYTES = 16;
const REQUEST_TIMEOUT_MS = 8000;
const RETRY_AFTER_MS = 30_000;            // after the relay didn't answer, wait this long before asking again
const MAX_ERROR_CHARS = 160;              // the error comes from the URL: show a sane amount of it
const NOT_THIS_TAB = 'Sign-in didn\'t start in this tab. Try again.';

// The deployed relay only returns sign-ins to https pages; a local one (AUTH_DEV=1) also to http dev pages.
export const accountsEnabled = !!RELAY_HTTP && (location.protocol === 'https:' || LOCAL_RELAY);
export const PRIVACY_URL = '/privacy.html';
// Sign-in buttons, in order. Only the ones the relay says are set up show (signInOptions).
const SIGN_IN_PROVIDERS = [
  { id: 'google', label: 'Continue with Google' },
  ...(LOCAL_RELAY ? [{ id: 'dev', label: 'Dev sign-in' }] : []),
];

let token = loadToken();
let user = null;       // /auth/me's user once it answered for this token
let quota = null;      // { tier, limit, used, remaining }: /ai/quota, kept current by AI replies
let lastError = null;  // why the last sign-in failed, until the next one
let offline = false;   // the relay didn't answer the last request
const pending = { me: null, quota: null };              // requests in flight
const failedAt = { me: -Infinity, quota: -Infinity };  // when the relay last didn't answer them
const listeners = new Set();

function loadToken() {
  try { return localStorage.getItem(TOKEN_STORE) || null; } catch { return null; }
}

function setToken(t) {
  token = t || null;
  try {
    if (token) localStorage.setItem(TOKEN_STORE, token);
    else localStorage.removeItem(TOKEN_STORE);
  } catch { /* storage unavailable: this page keeps it in memory */ }
  forget();
}

// a different session (or none): what we knew belonged to the old one
function forget() {
  user = null;
  quota = null;
  pending.me = pending.quota = null; // answers still in flight are for the old session
  failedAt.me = failedAt.quota = -Infinity;
  notify();
}

// signing in or out in another tab
addEventListener('storage', (e) => {
  if (e.key !== TOKEN_STORE || (e.newValue || null) === token) return;
  token = e.newValue || null;
  forget();
});

function notify() { for (const fn of listeners) fn(); }

// Call fn whenever the account or the quota changes. Returns an unsubscribe function.
export function onAccountChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// What the UI shows right now. signedIn: a session token is stored (user stays
// null until /auth/me confirms it, and while the relay can't be reached).
// offline: the relay didn't answer, so there's nothing to sign in to.
export function accountState() {
  return { enabled: accountsEnabled, signedIn: !!token, checking: !!pending.me, offline, user, quota, error: lastError };
}

// The raw session token (multiplayer sends it as a WebSocket subprotocol), or null.
export const sessionToken = () => token;

export function authHeaders() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function call(path, { method = 'GET', session = token } = {}) {
  try {
    const res = await fetch(`${RELAY_HTTP}${path}`, {
      method,
      headers: session ? { Authorization: `Bearer ${session}` } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    offline = false;
    return res;
  } catch (err) {
    offline = true;
    throw err;
  }
}

// Run one request of a kind at a time, and not again soon after the relay didn't answer.
function once(kind, run) {
  if (pending[kind]) return pending[kind];
  if (performance.now() - failedAt[kind] < RETRY_AFTER_MS) return Promise.resolve(null);
  const p = run().catch(() => { failedAt[kind] = performance.now(); return null; });
  pending[kind] = p;
  p.finally(() => { if (pending[kind] === p) pending[kind] = null; notify(); });
  return p;
}

// ---------------------------------------------------------------- sign-in

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function decode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function failed(message) {
  lastError = message.slice(0, MAX_ERROR_CHARS);
  notify();
  return { signedIn: false, error: lastError };
}

// Call once on load: take a session (or an error) the relay put in the URL
// fragment, and drop it and the nonce from the address bar. signedIn: this
// load finished a sign-in; error: why one didn't.
export function finishSignIn() {
  let expected = null;
  try {
    expected = sessionStorage.getItem(NONCE_STORE);
    sessionStorage.removeItem(NONCE_STORE); // one use, whatever happens next
  } catch { /* storage unavailable: no sign-in can match */ }
  const url = new URL(location.href);
  const nonce = url.searchParams.get(NONCE_PARAM);
  // parsed by hand: URLSearchParams would turn a '+' into a space
  const parts = url.hash.slice(1).split('&').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
  });
  const get = (k) => parts.find(([key]) => key === k)?.[1];
  const session = get(SESSION_PARAM), error = get(ERROR_PARAM);
  const returned = session !== undefined || error !== undefined;
  if (!returned && nonce === null) return { signedIn: false, error: null };

  url.searchParams.delete(NONCE_PARAM);
  url.hash = parts.filter(([k]) => k !== SESSION_PARAM && k !== ERROR_PARAM).map((p) => p.join('=')).join('&');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  if (!returned) return { signedIn: false, error: null };
  if (!nonce || nonce !== expected) return failed(NOT_THIS_TAB);
  if (session) {
    lastError = null;
    setToken(decode(session));
    return { signedIn: true, error: null };
  }
  return failed(decode((error ?? '').replace(/\+/g, ' ')) || 'The sign-in didn\'t finish.');
}

// Leave the page to sign in with a provider; the relay brings the player back here.
export function signIn(provider) {
  if (!accountsEnabled) return;
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
  try { sessionStorage.setItem(NONCE_STORE, nonce); } catch { /* the return can't match: it says so */ }
  const back = new URL(location.href);
  back.hash = '';
  back.searchParams.set(NONCE_PARAM, nonce);
  location.assign(`${RELAY_HTTP}/auth/start/${encodeURIComponent(provider)}?return=${encodeURIComponent(back.href)}`);
}

// Signs out here right away; tells the relay to end the session when it can.
export async function signOut() {
  const session = token;
  if (!session) return;
  setToken(null);
  try { await call('/auth/logout', { method: 'POST', session }); } catch { /* the session expires on its own */ }
}

// Delete the account on the relay, then sign out here. Throws a player-facing message.
export async function deleteAccount() {
  if (!token) throw new Error('You\'re not signed in.');
  let res;
  try {
    res = await call('/auth/delete', { method: 'POST' });
  } catch {
    notify();
    throw new Error('Couldn\'t reach the server, so your account is still there. Try again later.');
  }
  if (res.status === 401) {
    setToken(null);
    throw new Error('Your sign-in expired. Sign in again, then delete the account.');
  }
  if (!res.ok) throw new Error(`Deleting failed (${res.status}). Try again later.`);
  setToken(null);
}

// ---------------------------------------------------------------- who and how many

// The signed-in user ({ id, name, email, avatar, plan }), or null. Asks the
// relay once per session; a 401 means the session ended, so the token goes.
export function account() {
  if (!token) return Promise.resolve(null);
  if (user) return Promise.resolve(user);
  const session = token;
  return once('me', async () => {
    const res = await call('/auth/me');
    if (session !== token) return user; // signed out or in again meanwhile
    if (res.status === 401) { setToken(null); return null; }
    if (!res.ok) throw new Error(`/auth/me ${res.status}`);
    const u = (await res.json())?.user;
    user = u && typeof u === 'object' ? { ...u, name: String(u.name || u.email || 'Player') } : null;
    return user;
  });
}

// Today's free AI generations for this player or browser: { tier, limit, used, remaining }, or null.
export function aiQuota({ refresh = false } = {}) {
  if (!RELAY_HTTP) return Promise.resolve(null);
  if (quota && !refresh) return Promise.resolve(quota);
  const session = token;
  return once('quota', async () => {
    const res = await call('/ai/quota');
    if (session !== token) return quota;
    if (res.status === 401 && session) { setToken(null); return null; }
    if (!res.ok) throw new Error(`/ai/quota ${res.status}`);
    const q = await res.json();
    quota = {
      tier: q.tier, limit: num(q.limit), used: num(q.used), remaining: num(q.remaining),
      providers: Array.isArray(q.providers) ? q.providers : [], freeLimit: num(q.freeLimit),
    };
    return quota;
  });
}

// The sign-in buttons to show: the providers the relay has set up (none until it has said).
export function signInOptions() {
  const ready = new Set(quota?.providers ?? []);
  return SIGN_IN_PROVIDERS.filter((p) => ready.has(p.id));
}

// Generations a day once signed in, as the relay last said (null until it has).
export const freeDaily = () => quota?.freeLimit ?? null;

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// The free provider reports each relay reply here: x-ai-remaining and x-ai-tier
// keep the quota current, a 401 ends the session, and a 429 without a count
// asks /ai/quota what's left.
export function noteAIReply(status, headers) {
  offline = false;
  if (status === 401 && token) { setToken(null); return; }
  const left = num(headers.get('x-ai-remaining'));
  const tier = headers.get('x-ai-tier');
  if (left !== null) {
    quota = { ...quota, remaining: left, ...(tier && { tier }) };
    if (quota.limit != null) quota.used = Math.max(0, quota.limit - left);
    notify();
  } else if (status === 429) {
    aiQuota({ refresh: true });
  }
}

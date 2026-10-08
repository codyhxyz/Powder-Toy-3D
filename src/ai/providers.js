// Bring-your-own-key model providers, all through the Vercel AI SDK. Each entry
// lazy-loads its official provider package, so none of it is in the main bundle
// until the player connects a model.
//
// Keys live only in this browser's localStorage (STORE). They go straight to
// the chosen provider and nowhere else: not in construction exports, URLs or the
// multiplayer stream. Subscriptions (Claude, ChatGPT, Gemini) can't be used by a
// third-party web app; use them through the MCP server instead
// (docs/constructions.md).

const STORE = 'powder-toy-3d:ai';
const PKCE_STORE = 'powder-toy-3d:openrouter-pkce';
const APP_NAME = 'Powder Toy 3D';
const PKCE_VERIFIER_BYTES = 32;   // 43 base64url characters, inside the RFC 7636 range
const PKCE_STATE_BYTES = 16;
const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/auth/keys';
const MODEL_LIST_TIMEOUT_MS = 8000;
// Ollama's default context is a few thousand tokens and it truncates silently;
// the system prompt alone is about 7k, plus the code and reports of each step.
const OLLAMA_CONTEXT_TOKENS = 16384;

const browserKeyNote = 'Your key stays in this browser and goes only to the provider. Use one with a spending limit.';

// auth: 'oauth' (sign in, or paste a key), 'key', 'none' (local), 'optional' (local, key if the server wants one)
export const PROVIDERS = [
  {
    id: 'openrouter', label: 'OpenRouter', auth: 'oauth', note: browserKeyNote,
    create: async ({ apiKey }) => (await import('@openrouter/ai-sdk-provider'))
      .createOpenRouter({ apiKey, appName: APP_NAME, appUrl: location.origin }),
    list: async () => (await getJSON('https://openrouter.ai/api/v1/models')).data.map((m) => m.id),
  },
  {
    id: 'anthropic', label: 'Anthropic', auth: 'key', defaultModel: 'claude-opus-5-5', note: browserKeyNote,
    create: async ({ apiKey }) => (await import('@ai-sdk/anthropic'))
      .createAnthropic({ apiKey, headers: { 'anthropic-dangerous-direct-browser-access': 'true' } }),
  },
  {
    id: 'openai', label: 'OpenAI', auth: 'key', note: browserKeyNote,
    create: async ({ apiKey }) => (await import('@ai-sdk/openai')).createOpenAI({ apiKey }),
    list: async ({ apiKey }) => (await getJSON('https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` })).data.map((m) => m.id),
  },
  {
    id: 'google', label: 'Google', auth: 'key', note: browserKeyNote,
    create: async ({ apiKey }) => (await import('@ai-sdk/google')).createGoogleGenerativeAI({ apiKey }),
    list: async ({ apiKey }) => (await getJSON('https://generativelanguage.googleapis.com/v1beta/models', { 'x-goog-api-key': apiKey }))
      .models.map((m) => m.name.replace(/^models\//, '')),
  },
  {
    id: 'ollama', label: 'Ollama (local)', auth: 'none', baseURL: 'http://localhost:11434',
    note: 'Runs on your machine. From a deployed site, start Ollama with OLLAMA_ORIGINS set to this page\'s origin.',
    create: async ({ baseURL }) => {
      const p = (await import('ai-sdk-ollama')).createOllama({ baseURL: trim(baseURL) });
      return (id) => p(id, { options: { num_ctx: OLLAMA_CONTEXT_TOKENS } });
    },
    list: async ({ baseURL }) => (await getJSON(`${trim(baseURL)}/api/tags`)).models.map((m) => m.name),
  },
  {
    id: 'compatible', label: 'Local server (OpenAI-compatible)', auth: 'optional', baseURL: 'http://localhost:1234/v1',
    note: 'LM Studio, llama.cpp, vLLM or any OpenAI-compatible endpoint. Turn on CORS in the server.',
    create: async ({ baseURL, apiKey }) => {
      const p = (await import('@ai-sdk/openai-compatible')).createOpenAICompatible({ name: 'local', baseURL: trim(baseURL), apiKey: apiKey || undefined });
      return (id) => p.chatModel(id);
    },
    list: async ({ baseURL, apiKey }) => (await getJSON(`${trim(baseURL)}/models`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {})).data.map((m) => m.id),
  },
];

const trim = (url) => String(url ?? '').replace(/\/+$/, '');
const byId = (id) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------- settings

// { provider, providers: { [id]: { apiKey?, baseURL?, model? } } }
export function loadSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { s = null; }
  return { provider: byId(s?.provider).id, providers: s?.providers ?? {} };
}

export function saveSettings(s) {
  try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

// The chosen provider and its fields, with defaults filled in.
export function current(s) {
  const p = byId(s.provider);
  const f = s.providers[p.id] ?? {};
  return { provider: p, apiKey: f.apiKey ?? '', baseURL: f.baseURL || p.baseURL || '', model: f.model || p.defaultModel || '' };
}

// Ready to generate: a model is chosen and the credentials the provider needs are there.
export function isConfigured(s) {
  const c = current(s);
  if (!c.model) return false;
  return c.provider.auth === 'none' || c.provider.auth === 'optional' ? !!c.baseURL : !!c.apiKey;
}

// An AI SDK language model for the current settings.
export async function createModel(s) {
  const c = current(s);
  const provider = await c.provider.create(c);
  return provider(c.model);
}

// Model ids the provider offers, or [] when it can't list them.
export async function listModels(s) {
  const c = current(s);
  if (!c.provider.list || (c.provider.auth === 'key' && !c.apiKey)) return [];
  try { return (await c.provider.list(c)).sort(); } catch { return []; }
}

// ---------------------------------------------------------------- OpenRouter sign-in (OAuth PKCE)
// https://openrouter.ai/docs/use-cases/oauth-pkce: the player approves on
// openrouter.ai, comes back here with ?code=, and we swap it for a key of their own.

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (n) => base64url(crypto.getRandomValues(new Uint8Array(n)));
const callbackURL = () => `${location.origin}${location.pathname}`;

export async function startOpenRouterSignIn() {
  const verifier = randomToken(PKCE_VERIFIER_BYTES);
  const state = randomToken(PKCE_STATE_BYTES);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  sessionStorage.setItem(PKCE_STORE, JSON.stringify({ verifier, state }));
  const url = new URL(OPENROUTER_AUTH_URL);
  url.searchParams.set('callback_url', callbackURL());
  url.searchParams.set('code_challenge', base64url(new Uint8Array(digest)));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  location.assign(url.toString());
}

// On page load: finish a sign-in in progress. Resolves to true when a key was saved.
export async function finishOpenRouterSignIn() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code'), state = params.get('state');
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(PKCE_STORE) || 'null'); } catch { /* ignore */ }
  if (!code || !saved) return false;
  sessionStorage.removeItem(PKCE_STORE);
  // drop the one-time code from the address bar right away
  params.delete('code'); params.delete('state');
  const rest = params.toString();
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  if (state && state !== saved.state) throw new Error('OpenRouter sign-in state did not match');
  const res = await fetch(OPENROUTER_KEY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: saved.verifier, code_challenge_method: 'S256' }),
  });
  if (!res.ok) throw new Error(`OpenRouter sign-in failed (${res.status})`);
  const { key } = await res.json();
  const s = loadSettings();
  s.provider = 'openrouter';
  s.providers.openrouter = { ...s.providers.openrouter, apiKey: key };
  saveSettings(s);
  return true;
}

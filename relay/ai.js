import { DurableObject } from 'cloudflare:workers';
import { getUser } from './auth.js';

// Free AI for constructions: a small OpenAI proxy that holds the keys (Worker
// secrets), so players can generate with no setup. Each tier has its own OpenAI
// key (KEY_FOR), so OpenAI's dashboard shows each tier's usage and spend apart.
//   POST /ai/v1/responses   the OpenAI Responses API, as the AI SDK's openai provider sends it
//   GET  /ai/quota          { tier, limit, used, remaining } for the caller; counts nothing
// Tiers, from the session token the site sends (Authorization: Bearer, auth.js):
//   anon   not signed in: ANON_GENERATIONS a day per IP
//   free   signed in: FREE_GENERATIONS a day per account
//   paid   signed in on the pro plan: PAID_GENERATIONS a day per account
// Guards, so it can't become a free general-purpose model or an open tab:
//   - the model is pinned, output tokens and request size are capped (responses stay
//     stored at OpenAI, its default: the AI SDK refers back to earlier reasoning by id)
//   - the request must carry the construction system prompt (PROMPT_MARKER)
//   - the tier's generations a day (UTC); one generation (the x-gen-id header, one
//     per Generate press) gets at most MAX_CALLS model calls
//   - a daily budget in USD per tier, from the usage OpenAI reports
// IPs and account ids are only kept as salted hashes, and counts only for the day.
export const AI = {
  PATH: '/ai/v1/responses',
  QUOTA_PATH: '/ai/quota',
  UPSTREAM: 'https://api.openai.com/v1/responses',
  MODEL: 'gpt-6-luna',
  ANON_GENERATIONS: 1,            // a day per IP: a taste, then sign in
  FREE_GENERATIONS: 10,           // a day per signed-in account
  PAID_GENERATIONS: 100,          // a day per pro account (a placeholder until payments)
  MAX_CALLS: 8,                   // the agent takes at most 6 steps (src/ai/agent.js MAX_STEPS)
  MAX_OUTPUT_TOKENS: 8000,
  MAX_BODY_BYTES: 2_000_000,      // the agent sends a few preview PNGs per step
  DAILY_BUDGET_USD: { anon: 3, free: 10, paid: 50 }, // per tier, all its players together
  PRICE_PER_M: { input: 0.10, cached: 0.01, output: 0.50 }, // USD per million tokens, GPT-6 Luna
  // a sentence from the construction system prompt (src/ai/prompt.js, API)
  PROMPT_MARKER: 'Your code is the body of a JavaScript function',
  GEN_ID: /^[A-Za-z0-9_-]{8,64}$/,
};

// tier → the Worker secret holding its OpenAI key (1Password: "oai tpt3d-anon-free",
// "oai tpt3d-logged-in-free", "oai tpt3d paid")
export const KEY_FOR = { anon: 'OPENAI_KEY_ANON', free: 'OPENAI_KEY_FREE', paid: 'OPENAI_KEY_PAID' };

// account plan (auth.js) → tier; a plan this file doesn't know yet counts as free
const TIER_FOR_PLAN = { free: 'free', pro: 'paid' };
const GENERATIONS = { anon: AI.ANON_GENERATIONS, free: AI.FREE_GENERATIONS, paid: AI.PAID_GENERATIONS };

// What the panel shows when a request is refused.
const OUT_OF_GENERATIONS = {
  anon: `Sign in to keep generating: ${AI.FREE_GENERATIONS} free a day.`,
  free: `You've used today's ${AI.FREE_GENERATIONS} free generations. Come back tomorrow, or use your own key below.`,
  paid: `You've used today's ${AI.PAID_GENERATIONS} generations. Come back tomorrow.`,
};
const OUT_OF_BUDGET = 'Free AI has run out for today. Add your own key below, or try again tomorrow.';
const OUT_OF_STEPS = 'This generation used all its steps.';
const NOT_SET_UP = 'Free AI isn\'t set up on this server yet. Use your own key below.';
const NO_ACCOUNTS = 'Couldn\'t check your account. Try again in a moment.';

const MILLION = 1e6;
const HASH_CHARS = 32;

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const fail = (status, message, headers) => json(status, { error: { message } }, headers);

function corsHeaders(origin, request) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') ?? 'content-type, authorization, x-gen-id',
    'Access-Control-Expose-Headers': 'x-ai-remaining, x-ai-tier',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function saltedHash(...parts) {
  const bytes = new TextEncoder().encode(parts.join('|'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, HASH_CHARS);
}

const today = () => new Date().toISOString().slice(0, 10);

// Who's asking: their tier, the key their generations count under (ip:… or user:…,
// so the two can't collide) and the safety_identifier that lets OpenAI attribute
// abuse to one player without knowing who. Never the IP, account id or email.
async function identify(request, env) {
  const salt = env.AI_SALT ?? AI.MODEL;
  const user = await getUser(request, env);
  if (user) {
    const id = await saltedHash(salt, 'user', user.id);
    return { tier: TIER_FOR_PLAN[user.plan] ?? 'free', who: `user:${id}`, safety: id };
  }
  const ip = await saltedHash(salt, today(), request.headers.get('CF-Connecting-IP') ?? 'unknown');
  return { tier: 'anon', who: `ip:${ip}`, safety: ip };
}

function costUSD(usage) {
  const p = AI.PRICE_PER_M;
  const input = usage?.input_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  return ((input - cached) * p.input + cached * p.cached + output * p.output) / MILLION;
}

export async function handleAI(request, env, ctx, allowedOrigin) {
  const origin = request.headers.get('Origin');
  if (!allowedOrigin(origin)) return fail(403, 'Origin not allowed');
  const cors = corsHeaders(origin, request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const path = new URL(request.url).pathname;
  const isGenerate = request.method === 'POST' && path === AI.PATH;
  const isQuota = request.method === 'GET' && path === AI.QUOTA_PATH;
  if (!isGenerate && !isQuota) return fail(404, 'Not found', cors);

  let caller;
  try { caller = await identify(request, env); } catch { return fail(503, NO_ACCOUNTS, cors); }
  const headers = { ...cors, 'x-ai-tier': caller.tier };
  const quota = env.AI_QUOTA.get(env.AI_QUOTA.idFromName('global'));
  if (isQuota) {
    const limit = GENERATIONS[caller.tier];
    const used = await quota.peek(caller.who);
    return json(200, { tier: caller.tier, limit, used, remaining: Math.max(0, limit - used) }, { ...headers, 'Cache-Control': 'no-store' });
  }
  return generate(request, ctx, caller, env[KEY_FOR[caller.tier]], quota, headers);
}

async function generate(request, ctx, caller, apiKey, quota, headers) {
  if (!apiKey) return fail(503, NOT_SET_UP, headers);
  const gen = request.headers.get('x-gen-id') ?? '';
  if (!AI.GEN_ID.test(gen)) return fail(400, 'Missing generation id', headers);
  const text = await request.text();
  if (text.length > AI.MAX_BODY_BYTES) return fail(413, 'Request too large', headers);
  if (!text.includes(AI.PROMPT_MARKER)) return fail(403, 'Free AI only writes constructions', headers);
  let body;
  try { body = JSON.parse(text); } catch { return fail(400, 'Bad JSON', headers); }
  if (body.stream) return fail(400, 'Streaming isn\'t supported', headers);

  const verdict = await quota.begin(caller.tier, caller.who, gen);
  if (!verdict.ok) return fail(429, verdict.reason, { ...headers, 'x-ai-remaining': String(verdict.remaining) });

  body.model = AI.MODEL;
  body.max_output_tokens = Math.min(body.max_output_tokens ?? AI.MAX_OUTPUT_TOKENS, AI.MAX_OUTPUT_TOKENS);
  body.safety_identifier = caller.safety;
  const res = await fetch(AI.UPSTREAM, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.text();
  let remaining = verdict.remaining;
  if (res.ok) {
    let usage = null;
    try { usage = JSON.parse(out).usage; } catch { /* leave it unbilled */ }
    ctx.waitUntil(quota.spend(caller.tier, costUSD(usage)));
  } else if (verdict.first) {
    // OpenAI failed before this generation got anywhere: don't charge the player for it
    ctx.waitUntil(quota.refund(caller.who, gen));
    remaining += 1;
  }
  return new Response(out, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...headers, 'x-ai-remaining': String(remaining) },
  });
}

// One instance keeps the day's counts, each under its own small storage key, so a
// write touches only what changed:
//   ip:<hash> / user:<hash>   generations used     gen:<id>    model calls of one generation
//   usd:<tier>                spend                day         the UTC day they're for
// The first call of a new day clears the rest.
export class AiQuota extends DurableObject {
  async count(key) { return (await this.ctx.storage.get(key)) ?? 0; }

  async rollover() {
    const day = today();
    if (this.day === day) return;
    if ((await this.ctx.storage.get('day')) !== day) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put('day', day);
    }
    this.day = day;
  }

  async begin(tier, who, gen) {
    await this.rollover();
    const limit = GENERATIONS[tier];
    const [spent, used, calls] = await Promise.all([this.count(`usd:${tier}`), this.count(who), this.count(`gen:${gen}`)]);
    const refuse = (reason) => ({ ok: false, reason, remaining: Math.max(0, limit - used) });
    if (spent >= AI.DAILY_BUDGET_USD[tier]) return refuse(OUT_OF_BUDGET);
    const first = calls === 0;
    if (first && used >= limit) return refuse(OUT_OF_GENERATIONS[tier]);
    if (calls >= AI.MAX_CALLS) return refuse(OUT_OF_STEPS);
    const nowUsed = first ? used + 1 : used;
    await this.ctx.storage.put({ [who]: nowUsed, [`gen:${gen}`]: calls + 1 });
    return { ok: true, first, remaining: Math.max(0, limit - nowUsed) };
  }

  // Read-only, for GET /ai/quota: a count from an earlier day is no count at all.
  async peek(who) {
    if ((await this.ctx.storage.get('day')) !== today()) return 0;
    return this.count(who);
  }

  async refund(who, gen) {
    await this.rollover();
    const used = await this.count(who);
    if ((await this.count(`gen:${gen}`)) !== 1 || !used) return;
    await this.ctx.storage.put(who, used - 1);
    await this.ctx.storage.delete(`gen:${gen}`);
  }

  async spend(tier, usd) {
    await this.rollover();
    const key = `usd:${tier}`;
    await this.ctx.storage.put(key, (await this.count(key)) + usd);
  }
}

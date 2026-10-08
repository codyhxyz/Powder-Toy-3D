import { DurableObject } from 'cloudflare:workers';

// Free AI for constructions: a small OpenAI proxy that holds the key (the
// OPENAI_API_KEY secret), so players can generate with no setup.
//   POST /ai/v1/responses   the OpenAI Responses API, as the AI SDK's openai provider sends it
// Guards, so it can't become a free general-purpose model or an open tab:
//   - the model is pinned, output tokens and request size are capped (responses stay
//     stored at OpenAI, its default: the AI SDK refers back to earlier reasoning by id)
//   - the request must carry the construction system prompt (PROMPT_MARKER)
//   - per IP: FREE_GENERATIONS generations a day (UTC); one generation (the
//     x-gen-id header, one per Generate press) gets at most MAX_CALLS model calls
//   - a global daily budget in USD, from the usage OpenAI reports
// IPs are only kept as salted hashes, and only for the day.
export const AI = {
  PATH: '/ai/v1/responses',
  UPSTREAM: 'https://api.openai.com/v1/responses',
  MODEL: 'gpt-6-luna',
  FREE_GENERATIONS: 5,
  MAX_CALLS: 8,                   // the agent takes at most 6 steps (src/ai/agent.js MAX_STEPS)
  MAX_OUTPUT_TOKENS: 8000,
  MAX_BODY_BYTES: 2_000_000,      // the agent sends a few preview PNGs per step
  DAILY_BUDGET_USD: 5,
  PRICE_PER_M: { input: 0.10, cached: 0.01, output: 0.50 }, // USD per million tokens, GPT-6 Luna
  // a sentence from the construction system prompt (src/ai/prompt.js, API)
  PROMPT_MARKER: 'Your code is the body of a JavaScript function',
  GEN_ID: /^[A-Za-z0-9_-]{8,64}$/,
};

const MILLION = 1e6;
const HASH_CHARS = 32;

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const fail = (status, message, headers) => json(status, { error: { message } }, headers);

function corsHeaders(origin, request) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') ?? 'content-type, authorization, x-gen-id',
    'Access-Control-Expose-Headers': 'x-ai-remaining',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function hashIP(ip, day, salt) {
  const bytes = new TextEncoder().encode(`${salt}|${day}|${ip}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, HASH_CHARS);
}

const today = () => new Date().toISOString().slice(0, 10);

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
  if (request.method !== 'POST' || new URL(request.url).pathname !== AI.PATH) return fail(404, 'Not found', cors);
  if (!env.OPENAI_API_KEY) return fail(503, 'Free AI isn\'t set up on this server yet. Use your own key below.', cors);

  const gen = request.headers.get('x-gen-id') ?? '';
  if (!AI.GEN_ID.test(gen)) return fail(400, 'Missing generation id', cors);
  const text = await request.text();
  if (text.length > AI.MAX_BODY_BYTES) return fail(413, 'Request too large', cors);
  if (!text.includes(AI.PROMPT_MARKER)) return fail(403, 'Free AI only writes constructions', cors);
  let body;
  try { body = JSON.parse(text); } catch { return fail(400, 'Bad JSON', cors); }
  if (body.stream) return fail(400, 'Streaming isn\'t supported', cors);

  const day = today();
  const quota = env.AI_QUOTA.get(env.AI_QUOTA.idFromName('global'));
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const ipHash = await hashIP(ip, day, env.AI_SALT ?? AI.MODEL);
  const verdict = await quota.begin(ipHash, gen, day);
  if (!verdict.ok) return fail(429, verdict.reason, cors);

  body.model = AI.MODEL;
  body.max_output_tokens = Math.min(body.max_output_tokens ?? AI.MAX_OUTPUT_TOKENS, AI.MAX_OUTPUT_TOKENS);
  const res = await fetch(AI.UPSTREAM, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.text();
  if (res.ok) {
    let usage = null;
    try { usage = JSON.parse(out).usage; } catch { /* leave it unbilled */ }
    ctx.waitUntil(quota.spend(costUSD(usage), day));
  } else if (verdict.first) {
    // OpenAI failed before this generation got anywhere: don't charge the player for it
    ctx.waitUntil(quota.refund(ipHash, gen, day));
  }
  return new Response(out, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', 'x-ai-remaining': String(verdict.remaining), ...cors },
  });
}

// One instance keeps the day's counts: generations per IP hash, calls per
// generation, and spend. It resets when the UTC day changes.
export class AiQuota extends DurableObject {
  async load(day) {
    if (!this.state) this.state = (await this.ctx.storage.get('state')) ?? null;
    if (!this.state || this.state.day !== day) this.state = { day, ips: {}, calls: {}, spent: 0 };
    return this.state;
  }

  async begin(ipHash, gen, day) {
    const s = await this.load(day);
    if (s.spent >= AI.DAILY_BUDGET_USD) {
      return { ok: false, reason: 'Free AI has run out for today. Add your own key below, or try again tomorrow.' };
    }
    const calls = s.calls[gen] ?? 0;
    if (calls === 0) {
      const used = s.ips[ipHash] ?? 0;
      if (used >= AI.FREE_GENERATIONS) {
        return { ok: false, reason: `You've used today's ${AI.FREE_GENERATIONS} free generations. Add your own key below, or come back tomorrow.` };
      }
      s.ips[ipHash] = used + 1;
    } else if (calls >= AI.MAX_CALLS) {
      return { ok: false, reason: 'This generation used all its steps.' };
    }
    s.calls[gen] = calls + 1;
    await this.ctx.storage.put('state', s);
    return { ok: true, first: calls === 0, remaining: AI.FREE_GENERATIONS - s.ips[ipHash] };
  }

  async refund(ipHash, gen, day) {
    const s = await this.load(day);
    if (s.calls[gen] !== 1 || !s.ips[ipHash]) return;
    s.ips[ipHash] -= 1;
    delete s.calls[gen];
    await this.ctx.storage.put('state', s);
  }

  async spend(usd, day) {
    const s = await this.load(day);
    s.spent += usd;
    await this.ctx.storage.put('state', s);
  }
}

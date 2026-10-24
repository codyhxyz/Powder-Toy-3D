// CPU check of the world's light (src/shaders/world/light.js, lightWriters.js, src/gfx/worldLightBook.js):
//   1. naga on every module (the readers, every writer), over stand-ins for W's group 1 and F's fields
//      (the real ones live in their owners' files), and WGSL's operator-mixing rule Tint enforces
//   2. a JS twin of the shadow texel trace and the readers' shadow test, on a small synthetic world
//      (cell words from shaders/world/cellWord.js): shadows where the sun is blocked, light where it
//      isn't, colour through glass and water, agreement with a brute-force ray per point
//   3. the bookkeeping: a change re-traces every tile its shadow reaches; a camera move traces only what
//      scrolled in, under the per-frame budget; a physics move costs nothing; a sun turn retraces one
//      cascade at a time into the spare and swaps it in whole; the probe and glow clips the same way
// usage: node tools/world-light-cpu-check.mjs
import { prelude } from '../src/shaders/common.js';
import { frameBindings } from '../src/shaders/bindings.js';
import { glslMod } from '../src/gpu/wgsl.js';
import { materialsGLSL, LOOK } from '../src/gfx/materials.js';
import { noiseGLSL } from '../src/shaders/gfx/noise.js';
import { cellWordWGSL, wcWord, wcUnword, WC_BRICK } from '../src/shaders/world/cellWord.js';
import { worldLightWGSL, lightDeclsWGSL, SHADOW, PROBE, GLOW, TAGS, lcTag } from '../src/shaders/world/light.js';
import {
  shadowTraceFrag, probeUpdateFrag, probePublishFrag, glowSeedFrag, glowBlurFrag, glowFinalFrag, GLOW_W9,
} from '../src/shaders/world/lightWriters.js';
import { ShadowCascades, probeLevels, glowLevels, clipJobs, sunBasis } from '../src/gfx/worldLightBook.js';
import { ELEMENTS, E, R } from '../src/elements.js';
import { nagaSpawn } from './naga.mjs';

let bad = 0;
const fail = (m) => { bad++; console.error('FAIL', m); };
const ok = (cond, m) => { if (!cond) fail(m); };

// ---------------------------------------------------------------- 1. naga
// W's readers over one storage buffer of words (the stand-in: no bricks), F's over one texture.
const W_STUB = /* wgsl */ `
${cellWordWGSL}
struct WorldCopyUniforms { size: vec3i, air: u32, bricks: vec3i, capacity: u32 }
@group(1) @binding(0) var<uniform> WC: WorldCopyUniforms;
@group(1) @binding(1) var<storage, read> wcStub: array<u32>;
fn wcCell(c: vec3i) -> u32 {
  if (any(c < vec3i(0)) || any(c >= WC.size)) { return WC.air; }
  return wcStub[u32(c.x + WC.size.x * (c.y + WC.size.y * c.z))];
}
fn wcA(c: vec3i) -> vec4f { let w = wcCell(c); return vec4f(f32(wcId(w)), wcTemp(w), wcAux(w), f32(wcCtype(w))); }
fn wcInfo(b: vec3i) -> u32 { return wcStub[0] & 0xffffu; }
fn wcOccupied(level: u32, c: vec3i) -> bool { return wcId(wcCell(c)) != 0 || level > 0u; }`;
const F_STUB = /* wgsl */ `
@group(2) @binding(0) var tFS: texture_3d<f32>;
@group(2) @binding(1) var tFM: texture_3d<f32>;
@group(2) @binding(6) var wrapLinear: sampler;
fn surfField(p: vec3f) -> vec4f { return textureSampleLevel(tFS, wrapLinear, p / 64.0, 0.0); }
fn surfSample(p: vec3f) -> vec4f { return surfField(p); }
fn mediaField(p: vec3f) -> vec4f { return textureSampleLevel(tFM, wrapLinear, p / 64.0, 0.0); }`;
const head = (fields) => [prelude({ nx: 16, ny: 8, nz: 8 }, { state: false }), frameBindings(), glslMod, materialsGLSL(), noiseGLSL,
  W_STUB, fields ? F_STUB : F_STUB.replace(/@group\(2\) @binding\(\d\) /g, '@group(2) @binding(30) ').replace(/var tFM/, 'var tFM_unused') .replace(/30\) var wrapLinear/, '31) var wrapLinear').replace(/30\) var tFS/, '30) var tFS'),
  'var<private> gFragCoord: vec2f;'].join('\n');
// every reader the march calls, from one probe kernel
const CALLS = /* wgsl */ `
@group(3) @binding(0) var<storage, read_write> probeOut: array<vec4f>;
@compute @workgroup_size(1) fn main() {
  let p = vec3f(10.5, 3.2, 7.7);
  let n = vec3f(0.0, 1.0, 0.0);
  var vis: f32;
  var hc: vec3i;
  var hn: vec3f;
  var hid: i32;
  var ha: vec4f;
  let g = surfProbe(p, n);
  let view = LampSpecIn(vec3f(0.0, 0.0, 1.0), 0.5, vec3f(0.04), vec3f(1.0, 0.0, 0.0), 0.0, true);
  let ll = lampShade(p, n, n, true, view);
  var s = sunShadow(p, n) + sunShadowAt(p) + sunMapShadow(p, n) + sunMapShadowAt(p) + giIrradiance(g, n) + giRadiance(probeAt(p), n, 0.5)
        + sampleLight(p) + nearField(p, n, n, vec3f(0.1), &vis) + lampLight(p, n, n) + lampSpecSeen(p, n, view) + ll.diff + ll.spec
        + ggxSpec(n, n, n, 0.5, vec3f(0.04)) + hitLight(p, n, vec3f(0.5), vec3f(0.0)) + beaconDiffuse(p, n, n) + skyAmbient(n) + wandLight(p);
  let f = giSkyVis(g, n) + giAirSkyVis(p) + giAirSkyHeld(p).x + faceAO(vec3i(1), vec3i(0, 1, 0), p) + fieldAO(p, n) + solidity(p)
        + glowLightScale(p, n, n) + f32(glowWorthIt(s, s)) + sunRayClear(p, 10.0) + traceNear(p, n, 8.0, false, 0.5, &hc, &hn)
        + nearSolid(p, &hid, &ha) + causticGain(p, 2.0) + f32(occluder(vec3i(2))) + smoothOpaque(p) + hgPhase2(0.5, 0.2, 0.8, 0.5);
  probeOut[0] = vec4f(s, f);
}`;
// the march's own bindings the readers use (shaders/world/bindings.js M_BINDINGS)
const M_DECLS = '@group(2) @binding(16) var tMediaNoise: texture_3d<f32>;\n@group(2) @binding(17) var linearClamp: sampler;';
const MODULES = [
  ['readers', () => `${head(true)}\n${worldLightWGSL()}\n${lightDeclsWGSL()}\n${M_DECLS}\n${CALLS}`],
  ['readers (no fields in the writers\' model)', () => `${head(true)}\n${worldLightWGSL({ fields: false })}\n${lightDeclsWGSL()}\n${M_DECLS}\n${CALLS}`],
  ['shadowTrace (fields)', () => `${head(true)}\n${shadowTraceFrag({ fields: true })}`],
  ['shadowTrace (cells)', () => `${head(true)}\n${shadowTraceFrag({ fields: false })}`],
  ['probeUpdate', () => `${head(true)}\n${probeUpdateFrag({ fields: true })}`],
  ['probePublish', () => probePublishFrag()],
  ['glowSeed', () => `${head(true)}\n${glowSeedFrag()}`],
  ['glowBlurX', () => glowBlurFrag(0)],
  ['glowBlurY', () => glowBlurFrag(1)],
  ['glowFinal', () => glowFinalFrag()],
];
// WGSL's operator precedence (tools/check-wgsl-operators.mjs's rules, which Chrome's Tint enforces and
// naga doesn't): a bitwise operator alone in its run, no two relational operators, no shift beside arithmetic
const PUNCT = ['<<=', '>>=', '&&', '||', '<<', '>>', '<=', '>=', '==', '!=', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '++', '--'];
const TEMPLATED = /^(var|vec[234]|mat[234]x[234]|array|ptr|atomic|bitcast|binding_array|texture_\w+)$/;   // (tools/check-wgsl-operators.mjs's)
function operatorProblems(code) {
  const src = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const toks = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    const word = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 64)) ?? /^(0[xX][0-9a-fA-F]+|\d*\.?\d+([eE][+-]?\d+)?)[a-z]*/.exec(src.slice(i, i + 64));
    if (word) { toks.push({ t: word[0], line, word: true }); i += word[0].length; continue; }
    const p = PUNCT.find((s) => src.startsWith(s, i));
    toks.push({ t: p ?? c, line });
    i += (p ?? c).length;
  }
  const kept = [];
  for (let k = 0; k < toks.length; k++) {
    kept.push(toks[k]);
    if (!(toks[k].word && TEMPLATED.test(toks[k].t) && toks[k + 1]?.t === '<')) continue;
    let depth = 0;
    for (k++; k < toks.length; k++) {
      const t = toks[k].t;
      if (t === '<') depth++; else if (t === '>') depth--; else if (t === '>>') depth -= 2;
      if (depth <= 0) break;
    }
  }
  const BIT = new Set(['&', '|', '^']), SHIFT = new Set(['<<', '>>']), REL = new Set(['<', '>', '<=', '>=', '==', '!=']);
  const LOGIC = new Set(['&&', '||']), BINARY = new Set([...BIT, ...SHIFT, ...REL, ...LOGIC, '+', '-', '*', '/', '%']);
  const UNARY = new Set(['-', '!', '~', '*', '&']), OPEN = new Set(['(', '[', '{']), CLOSE = new Set([')', ']', '}']);
  const BOUNDARY = new Set([',', ';', ':', '=', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '++', '--', '@',
    'return', 'let', 'var', 'const', 'if', 'else', 'loop', 'while', 'for', 'switch', 'case', 'default', 'break', 'continue', 'fn', 'struct']);
  const run = (ops) => {
    if (!ops.length) return null;
    const kinds = new Set(ops.map((o) => o.t));
    if (ops.some((o) => BIT.has(o.t))) return kinds.size > 1 ? ops : null;
    if ([...kinds].filter((k) => LOGIC.has(k)).length > 1) return ops;
    let seg = [];
    for (const o of [...ops, { t: '&&' }]) {
      if (!LOGIC.has(o.t)) { seg.push(o); continue; }
      const rel = seg.filter((s) => REL.has(s.t));
      if (rel.length > 1) return seg;
      const sides = rel.length ? [seg.slice(0, seg.indexOf(rel[0])), seg.slice(seg.indexOf(rel[0]) + 1)] : [seg];
      for (const side of sides) if (side.some((s) => SHIFT.has(s.t)) && side.length > 1) return seg;
      seg = [];
    }
    return null;
  };
  const out = [], stack = [[]];
  const flush = () => { const b = run(stack.at(-1)); if (b) out.push(`line ${b[0].line}: ${b.map((o) => o.t).join(' ')}`); stack[stack.length - 1] = []; };
  for (let k = 0; k < kept.length; k++) {
    const { t } = kept[k], prev = kept[k - 1];
    if (OPEN.has(t)) { stack.push([]); continue; }
    if (CLOSE.has(t)) { flush(); if (stack.length > 1) stack.pop(); continue; }
    if (BOUNDARY.has(t)) { flush(); continue; }
    if (!BINARY.has(t)) continue;
    if (UNARY.has(t) && !(prev && (prev.word || CLOSE.has(prev.t)))) continue;
    stack.at(-1).push(kept[k]);
  }
  flush();
  return out;
}
for (const [name, make] of MODULES) {
  let code;
  try { code = make(); } catch (e) { fail(`${name}: generating: ${e.message}`); continue; }
  const r = nagaSpawn(code, `world-light-${name.replace(/\W+/g, '-')}.wgsl`);
  if (r.status !== 0) fail(`naga ${name}:\n${(r.stderr || r.stdout || r.error?.message || '').slice(0, 3000)}`);
  const ops = operatorProblems(code);
  if (ops.length) fail(`${name}: operators mixed without parentheses (Tint rejects): ${ops.slice(0, 5).join('; ')}`);
}

// ---------------------------------------------------------------- 2. the shadow twin
// A synthetic world: a stone floor, a floating stone slab, a glass pane, a water pool, a sand pile.
const SIZE = [64, 32, 48];
const cells = new Uint32Array(SIZE[0] * SIZE[1] * SIZE[2]);
const at = (x, y, z) => x + SIZE[0] * (y + SIZE[1] * z);
const put = (x0, x1, y0, y1, z0, z1, id, aux = 1) => {
  for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cells[at(x, y, z)] = wcWord(id, 0, 20, aux);
};
put(0, 64, 0, 4, 0, 48, E.STONE);
put(8, 18, 16, 18, 8, 18, E.STONE);        // the slab
put(30, 40, 14, 15, 8, 18, E.GLASS);       // a glass pane, one cell thick
put(44, 56, 4, 8, 28, 40, E.WATER);        // a pool on the floor
put(10, 14, 4, 10, 30, 34, E.SAND);        // a sand pile (smooth, opaque: blocks as its cells here)
const word = (c) => (c[0] < 0 || c[1] < 0 || c[2] < 0 || c[0] >= SIZE[0] || c[1] >= SIZE[1] || c[2] >= SIZE[2] ? 0 : cells[at(...c)]);
const idOf = (c) => word(c) & 255;
// the occupancy levels: a brick (4³), a 16³ and a 64³ node hold anything
const occ = [4, 16, 64].map((S) => {
  const m = new Set();
  for (let z = 0; z < SIZE[2]; z++) for (let y = 0; y < SIZE[1]; y++) for (let x = 0; x < SIZE[0]; x++) {
    if (cells[at(x, y, z)] & 255) m.add(`${x >> Math.log2(S)},${y >> Math.log2(S)},${z >> Math.log2(S)}`);
  }
  return m;
});
const occupied = (lvl, c) => c.every((v, i) => v >= 0 && v < SIZE[i]) && occ[lvl].has(c.map((v) => v >> [2, 4, 6][lvl]).join(','));
const SIGMA = (id) => ELEMENTS[id].sigma;
const RCLASS = (id) => ELEMENTS[id].render;
const meanSigma = (id) => (SIGMA(id)[0] + SIGMA(id)[1] + SIGMA(id)[2]) / 3;
const isCrisp = (id) => id !== 0 && LOOK[id].ch < 0 && LOOK[id].media < 0;
const isGasLike = (id) => id === 0 || RCLASS(id) === R.GAS || RCLASS(id) === R.FIRE;
const LC_EPS = 1e-3, LC_DIR_MIN = 1e-6, TINT = 256, NO_HIT = 1e5;
const safeDir = (d) => d.map((v) => (Math.abs(v) < LC_DIR_MIN ? (v >= 0 ? 1 : -1) * LC_DIR_MIN : v));
function worldHit(ro, inv) {
  let lo = -Infinity, hi = Infinity;
  for (let i = 0; i < 3; i++) {
    const a = (0 - ro[i]) * inv[i], b = (SIZE[i] - ro[i]) * inv[i];
    lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
  }
  return [lo, hi];
}
function exitOf(ro, inv, c, S) {
  let best = Infinity, ax = 0;
  for (let i = 0; i < 3; i++) {
    const lo = c[i] & ~(S - 1);
    const t = Math.max((lo - ro[i]) * inv[i], (lo + S - ro[i]) * inv[i]);
    if (t < best) { best = t; ax = i; }
  }
  return [best, ax];
}
// lcNext's twin (shaders/world/light.js marchWGSL)
function next(ro, rd, inv, t0, tLim, state) {
  let t = t0, lastB = null, bOcc = false;
  while (state.steps > 0 && t <= tLim) {
    state.steps--;
    const c = ro.map((v, i) => Math.floor(v + rd[i] * (t + LC_EPS)));
    if (!c.every((v, i) => v >= 0 && v < SIZE[i])) break;
    const b = c.map((v) => v >> 2).join(',');
    if (b !== lastB) {
      lastB = b;
      if (!occupied(2, c)) { t = exitOf(ro, inv, c, 64)[0]; lastB = null; continue; }
      if (!occupied(1, c)) { t = exitOf(ro, inv, c, 16)[0]; lastB = null; continue; }
      bOcc = occupied(0, c);
    }
    const e1 = exitOf(ro, inv, c, 1);
    if (!bOcc) { t = exitOf(ro, inv, c, 4)[0]; continue; }
    const w = word(c);
    if (w & 255) return { c, t, tOut: Math.min(e1[0], tLim), w, ok: true };
    t = e1[0];
  }
  return { ok: false };
}
// shadowTexelWorld's twin, the cell model (lightWriters.js shadowTraceFrag({ fields: false }))
function shadowTexel(ro, rd) {
  const o = [NO_HIT, NO_HIT, NO_HIT, 0];
  const inv = rd.map((v) => 1 / v);
  const [a, b] = worldHit(ro, inv);
  let t = Math.max(a, 0), tid = 0, tau = 0, hit = false;
  const state = { steps: SHADOW.MAX_STEPS };
  if (b > t) {
    for (;;) {
      const h = next(ro, rd, inv, t, b, state);
      if (!h.ok) break;
      const id = h.w & 255;
      t = h.tOut;
      if (isCrisp(id)) {
        if (RCLASS(id) !== R.GLASS && id !== E.CRYSTAL) { o[0] = h.t; hit = true; break; }
        if (tid === 0 || RCLASS(tid) === R.GAS) { if (tid === 0) o[1] = h.t; tid = id; }
        tau += meanSigma(id) * (h.tOut - h.t); o[2] = h.tOut;
        continue;
      }
      if (RCLASS(id) === R.LIQUID) {
        if (tid === 0 || RCLASS(tid) === R.GAS) { if (tid === 0) o[1] = h.t; tid = id; }
        tau += meanSigma(id) * (h.tOut - h.t) * wcUnword(h.w).aux; o[2] = h.tOut;
      } else if (RCLASS(id) !== R.GAS && !isGasLike(id)) { o[0] = h.t; hit = true; break; }
    }
  }
  if (!hit && rd[1] < 0) o[0] = ro[1] / -rd[1];
  o[3] = tid * TINT + Math.min(tau, TINT - 1);
  return o;
}
// The cascades, traced frame by frame through the bookkeeping, into JS slots.
const sun0 = [0.45, 0.8, 0.3];
const casc = new ShadowCascades(SIZE);
const slots = Array.from({ length: SHADOW.SLOTS }, () => new Map());   // wrapped texel index → texel
const tags = new Map();   // `${slot},${wrapped tile}` → tag
const R2 = SHADOW.RES, TL = SHADOW.TILE, TILES = R2 / TL;
const wrap = (a, n) => ((a % n) + n) % n;
const targets = () => [...casc.cascades, casc.spare];
function traceJobs(jobs) {
  const ts = targets();
  for (const j of jobs) {
    const tg = ts[j.target];
    const { u, v, s } = tg.basis, f = casc.frame;
    for (let ly = 0; ly < TL; ly++) for (let lx = 0; lx < TL; lx++) {
      const i = j.tile[0] * TL + lx, jj = j.tile[1] * TL + ly;
      const a = (i + 0.5) * tg.texel, b = (jj + 0.5) * tg.texel;
      const ro = [0, 1, 2].map((k) => f.centre[k] + s[k] * f.Rw + u[k] * a + v[k] * b);
      slots[j.slot].set(wrap(i, R2) + R2 * wrap(jj, R2), shadowTexel(ro, safeDir(s.map((x) => -x))));
    }
    tags.set(`${j.slot},${wrap(j.tile[0], TILES) + TILES * wrap(j.tile[1], TILES)}`, lcTag(j.tile[0], j.tile[1], tg.epoch));
  }
}
function frame(cam, sun, changes = []) {
  casc.update(cam, sun, changes);
  const jobs = casc.jobs();
  ok(jobs.length <= SHADOW.TILES_PER_FRAME, `a frame traced ${jobs.length} tiles, past the budget ${SHADOW.TILES_PER_FRAME}`);
  traceJobs(jobs);
  return jobs;
}
const place = (k, p) => {
  const c = casc.cascades[k], f = casc.frame, q = p.map((x, i) => x - f.centre[i]);
  const d = f.Rw - (q[0] * c.basis.s[0] + q[1] * c.basis.s[1] + q[2] * c.basis.s[2]);
  return { f: [(q[0] * c.basis.u[0] + q[1] * c.basis.u[1] + q[2] * c.basis.u[2]) / c.texel, (q[0] * c.basis.v[0] + q[1] * c.basis.v[1] + q[2] * c.basis.v[2]) / c.texel], d };
};
// shCascadeFor + sunMapShadowAt's twin (the hard 2×2 test inside volumes, no clouds or caustics)
function cascadeFor(p) {
  for (let k = 0; k < SHADOW.CASCADES; k++) {
    const c = casc.cascades[k];
    if (!c.origin) continue;
    const { f } = place(k, p);
    const i0 = f.map((x) => Math.floor(x - 0.5));
    const m = k + 1 === SHADOW.CASCADES ? 0 : SHADOW.MARGIN;
    if (i0.some((x, a) => x < c.origin[a] + m || x + 1 > c.origin[a] + R2 - 1 - m)) continue;
    const tg = (t) => tags.get(`${c.slot},${wrap(t[0], TILES) + TILES * wrap(t[1], TILES)}`) === lcTag(t[0], t[1], c.epoch);
    if (!tg(i0.map((x) => Math.floor(x / TL))) || !tg(i0.map((x) => Math.floor((x + 1) / TL)))) continue;
    return k;
  }
  return SHADOW.CASCADES;
}
function shadowAt(p, kForce = -1) {
  const k = kForce >= 0 ? kForce : cascadeFor(p);
  if (k >= SHADOW.CASCADES) return [1, 1, 1];
  const c = casc.cascades[k];
  const { f, d } = place(k, p);
  const g = f.map((x) => x - 0.5), i0 = g.map(Math.floor), w = g.map((x, i) => x - i0[i]);
  const acc = [0, 0, 0];
  for (let j = 0; j < 4; j++) {
    const o = [j & 1, j >> 1];
    const ij = [i0[0] + o[0], i0[1] + o[1]].map((x, a) => Math.min(Math.max(x, c.origin[a]), c.origin[a] + R2 - 1));
    const sm = slots[c.slot].get(wrap(ij[0], R2) + R2 * wrap(ij[1], R2));
    const wk = (o[0] ? w[0] : 1 - w[0]) * (o[1] ? w[1] : 1 - w[1]);
    const lit = d < sm[0] + 0.6 ? 1 : 0;
    const tid = Math.floor(sm[3] / TINT);
    let att = [1, 1, 1];
    if (tid > 0 && d > sm[1]) {
      const tau = sm[3] - tid * TINT, frac = Math.min(Math.max((d - sm[1]) / Math.max(sm[2] - sm[1], 1e-3), 0), 1);
      att = SIGMA(tid).map((x) => Math.exp(-x / Math.max(meanSigma(tid), 1e-4) * tau * frac));
    }
    for (let i = 0; i < 3; i++) acc[i] += lit * att[i] * wk;
  }
  return acc;
}
// a brute-force sun ray from p, cell by cell (no hierarchy): [visibility of opaque, transmittance rgb]
function bruteSun(p, sun) {
  const s = sunBasis(sun).s, tr = [1, 1, 1];
  for (let t = 0.05; t < 200; t += 0.05) {
    const c = p.map((v, i) => Math.floor(v + s[i] * t));
    if (c[1] >= SIZE[1] || c.some((v, i) => v < 0 || v >= SIZE[i])) break;
    const id = idOf(c);
    if (!id) continue;
    if (RCLASS(id) === R.GLASS || RCLASS(id) === R.LIQUID) { for (let i = 0; i < 3; i++) tr[i] *= Math.exp(-SIGMA(id)[i] * 0.05 * (RCLASS(id) === R.LIQUID ? wcUnword(word(c)).aux : 1)); continue; }
    if (!isGasLike(id)) return [0, tr];
  }
  return [1, tr];
}
// trace until nothing is pending (the first frames after load)
let cam = [32, 10, 24];
let frames = 0;
while (frame(cam, sun0).length && frames < 2000) frames++;
ok(frames > 0 && frames < 2000, `the cascades never finished tracing (${frames} frames)`);
ok(casc.cascades.every((c) => c.complete()), 'a cascade is incomplete after tracing settled');
// what a few points see
const sunS = sunBasis(sun0).s;
const under = (x, z, y) => [x - sunS[0] / sunS[1] * (y - 4) + 0, 4.3, z - sunS[2] / sunS[1] * (y - 4)];   // the floor point the sun reaches past (x, y, z)
{
  const pSlab = under(13, 13, 16.5), pOpen = [60, 4.3, 4], pGlass = under(35, 13, 14.5), pPool = [50, 5.5, 34];
  const sSlab = shadowAt(pSlab), sOpen = shadowAt(pOpen), sGlass = shadowAt(pGlass), sPool = shadowAt(pPool);
  ok(cascadeFor(pSlab) === 0, `the camera's neighbourhood isn't read from cascade 0 (${cascadeFor(pSlab)})`);
  ok(Math.max(...sSlab) < 0.05, `the floor under the slab is lit: ${sSlab.map((x) => x.toFixed(3))}`);
  ok(Math.min(...sOpen) > 0.95, `the open floor is shadowed: ${sOpen.map((x) => x.toFixed(3))}`);
  const [, trG] = bruteSun(pGlass, sun0);
  ok(sGlass.every((x, i) => Math.abs(x - trG[i]) < 0.03) && sGlass[0] < sGlass[1], `the glass's colour: ${sGlass.map((x) => x.toFixed(3))} vs ${trG.map((x) => x.toFixed(3))}`);
  const [, trP] = bruteSun(pPool, sun0);
  ok(sPool.every((x, i) => Math.abs(x - trP[i]) < 0.05) && sPool[0] < sPool[2], `the pool's colour: ${sPool.map((x) => x.toFixed(3))} vs ${trP.map((x) => x.toFixed(3))}`);
}
// agreement with the brute-force ray over random air points, away from edges (where the 2×2 filter blends)
function agreement(kForce = -1, n = 3000, seed = 7) {
  let rnd = seed, agree = 0, total = 0;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < n; i++) {
    const p = [rand() * SIZE[0], 4 + rand() * 24, rand() * SIZE[2]];
    if (idOf(p.map(Math.floor))) continue;
    const near = [[0.6, 0, 0], [-0.6, 0, 0], [0, 0, 0.6], [0, 0, -0.6]].map((o) => bruteSun(p.map((v, k) => v + o[k]), sun0)[0]);
    const b = bruteSun(p, sun0)[0];
    if (near.some((x) => x !== b)) continue;   // an edge
    total++;
    if ((Math.min(...shadowAt(p, kForce)) > 0.5 ? 1 : 0) === b) agree++;
  }
  return { agree, total };
}
for (const k of [0, 1, 2]) {
  const { agree, total } = agreement(k);
  const need = [0.99, 0.97, 0.9][k];
  ok(total > 500 && agree / total >= need, `cascade ${k} agrees with brute-force rays on ${agree}/${total} points (need ${need})`);
  console.log(`  cascade ${k}: texel ${casc.cascades[k].texel.toFixed(3)} cells, agrees with brute-force sun rays at ${(100 * agree / total).toFixed(1)} % of ${total} points`);
}

// ---------------------------------------------------------------- 3. the bookkeeping
// a physics move (nothing changes in the world, the camera stays): no work
ok(frame(cam, sun0).length === 0, 'a still frame traced shadow tiles');
// a change: a new block; the tiles marked are every tile whose texel rays cross it, and after the frame it casts
{
  const lo = [40, 20, 30], hi = [44, 22, 34];
  put(lo[0], hi[0], lo[1], hi[1], lo[2], hi[2], E.STONE);
  for (const [l, S] of [[0, 4], [1, 16], [2, 64]]) for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) occ[l].add(`${x >> Math.log2(S)},${y >> Math.log2(S)},${z >> Math.log2(S)}`);
  // which tiles a brute-force test says the box shadows (any texel ray of the tile passing through it)
  const want = casc.cascades.map((c, k) => {
    const set = new Set(), f = casc.frame, { u, v, s } = c.basis;
    for (let ti = 0; ti < TILES; ti++) for (let tj = 0; tj < TILES; tj++) {
      const tile = [c.origin[0] / TL + ti, c.origin[1] / TL + tj];
      let crosses = false;
      for (let ly = 0; ly < TL && !crosses; ly++) for (let lx = 0; lx < TL && !crosses; lx++) {
        const a = (tile[0] * TL + lx + 0.5) * c.texel, b = (tile[1] * TL + ly + 0.5) * c.texel;
        const ro = [0, 1, 2].map((q) => f.centre[q] + s[q] * f.Rw + u[q] * a + v[q] * b), rd = safeDir(s.map((x) => -x));
        let t0 = -Infinity, t1 = Infinity;
        for (let q = 0; q < 3; q++) { const A = (lo[q] - ro[q]) / rd[q], B = (hi[q] - ro[q]) / rd[q]; t0 = Math.max(t0, Math.min(A, B)); t1 = Math.min(t1, Math.max(A, B)); }
        crosses = t1 > t0;
      }
      if (crosses) set.add(tile.join(','));
    }
    return set;
  });
  casc.update(cam, sun0, [{ lo, hi }]);
  casc.cascades.forEach((c, k) => {
    const missing = [...want[k]].filter((t) => !c.dirty.has(t));
    ok(missing.length === 0, `cascade ${k}: a change missed ${missing.length} of the ${want[k].size} tiles it shadows`);
    ok(c.dirty.size <= want[k].size * 4 + 8, `cascade ${k}: a change marked ${c.dirty.size} tiles for ${want[k].size} it shadows`);
  });
  const jobs = casc.jobs();
  ok(jobs.length <= SHADOW.TILES_PER_FRAME, 'the change\'s retrace went past the budget');
  traceJobs(jobs);
  const pUnder = under(42, 32, 20.5);
  ok(Math.max(...shadowAt(pUnder)) < 0.05, `the new block casts no shadow: ${shadowAt(pUnder).map((x) => x.toFixed(3))}`);
}
// a camera move: only the tiles that scrolled in are traced, nearest first, under the budget; the rest stay
{
  const before = casc.cascades.map((c) => new Set(c.traced));
  const cam2 = [cam[0] + 9, cam[1], cam[2] + 5];
  casc.update(cam2, sun0, []);
  casc.cascades.forEach((c, k) => {
    const kept = [...before[k]].filter((t) => c.traced.has(t)).length;
    const total = TILES * TILES;
    if (k === SHADOW.CASCADES - 1) ok(c.traced.size === total, 'the world cascade lost tiles on a camera move');
    else ok(kept >= total * 0.8 && c.traced.size === kept, `cascade ${k} kept ${kept} of ${total} tiles on a 10-cell move`);
  });
  let n = 0, f = 0;
  for (let j; (j = casc.jobs()).length; f++) { ok(j.length <= SHADOW.TILES_PER_FRAME, 'a scroll frame went past the budget'); n += j.length; traceJobs(j); }
  const expect = casc.cascades.reduce((s, c, k) => s + (TILES * TILES - [...before[k]].filter((t) => c.traced.has(t)).length), 0);
  ok(n <= expect + 1, `a camera move traced ${n} tiles, ${expect} came into range`);
  cam = cam2;
}
// a sun turn below the threshold does nothing; past it, the spare retraces one cascade at a time and swaps in whole
{
  const turn = (a) => { const c = Math.cos(a), s = Math.sin(a); return [sun0[0] * c - sun0[2] * s, sun0[1], sun0[0] * s + sun0[2] * c]; };
  casc.update(cam, turn(SHADOW.TURN_RAD * 0.5), []);
  ok(casc.retracing === -1, 'a sun turn below the threshold started a retrace');
  const epochs = casc.cascades.map((c) => c.epoch);
  const sun1 = turn(SHADOW.TURN_RAD * 3);
  let f = 0, swaps = 0, last = casc.cascades.map((c) => c.epoch);
  for (; f < 5000; f++) {
    casc.update(cam, sun1, []);
    const now = casc.cascades.map((c) => c.epoch);
    now.forEach((e, k) => { if (e !== last[k]) { swaps++; ok(casc.cascades[k].complete(), `cascade ${k} swapped in incomplete`); } });
    last = now;
    const j = casc.jobs();
    ok(j.length <= SHADOW.TILES_PER_FRAME, 'a retrace frame went past the budget');
    traceJobs(j);
    if (casc.retracing === -1 && casc.cascades.every((c) => Math.acos(Math.min(1, c.basis.s[0] * sunBasis(sun1).s[0] + c.basis.s[1] * sunBasis(sun1).s[1] + c.basis.s[2] * sunBasis(sun1).s[2])) < 1e-6)) break;
  }
  ok(swaps === SHADOW.CASCADES, `a sun turn swapped ${swaps} cascades, not ${SHADOW.CASCADES}`);
  ok(casc.cascades.every((c, k) => c.epoch !== epochs[k]), 'a cascade kept the old sun');
  ok(new Set(casc.cascades.map((c) => c.slot).concat(casc.spare.slot)).size === SHADOW.SLOTS, 'two targets share a slot');
  console.log(`  sun turn: ${SHADOW.CASCADES} cascades retraced and swapped in ${f} frames`);
  // the new shadows are the new sun's
  const s1 = sunBasis(sun1).s;
  const p = [13 - s1[0] / s1[1] * 12.5, 4.3, 13 - s1[2] / s1[1] * 12.5];
  ok(Math.max(...shadowAt(p)) < 0.05, 'after the turn the slab\'s shadow isn\'t where the new sun puts it');
}
// the probe and glow clips: the first frames trace nearest first under the budget, a still frame only
// rotates, a move traces only what came in, a change marks the chunks it reaches
for (const [name, levels, budget] of [['probe', probeLevels(), { newMax: PROBE.NEW_CHUNKS_MAX, rotate: PROBE.ROTATE_CHUNKS }],
  ['glow', glowLevels(), { newMax: GLOW.JOBS_PER_FRAME, rotate: 0 }]]) {
  const c0 = [512, 64, 512];
  for (const L of levels) L.centre(c0);
  const total = levels.reduce((s, L) => s + L.side ** 3, 0);
  let f = 0;
  const firstJobs = clipJobs(levels, budget);
  ok(firstJobs.length <= budget.newMax + budget.rotate, `${name}: the first frame took ${firstJobs.length} chunks`);
  ok(firstJobs.every((j) => j.first), `${name}: the first frame's chunks aren't fresh`);
  const d0 = Math.min(...firstJobs.map((j) => { const L = levels[j.level]; return Math.hypot(...j.c.map((v, i) => ((v + 0.5) * L.chunk * L.spacing) - c0[i])); }));
  ok(d0 < levels[0].chunk * levels[0].spacing * 2, `${name}: the first chunk traced is ${d0.toFixed(0)} cells from the camera`);
  for (; f < 10000; f++) { const j = clipJobs(levels, budget); if (!j.some((x) => x.first)) break; ok(j.length <= budget.newMax + budget.rotate, `${name}: over budget`); }
  ok(levels.every((L) => L.traced.size === L.side ** 3), `${name}: not every chunk traced after ${f} frames`);
  console.log(`  ${name}: ${total} chunks traced in ${f + 1} frames from a cold start`);
  const still = clipJobs(levels, budget);
  ok(still.every((j) => !j.first) && still.length <= budget.rotate, `${name}: a still frame took ${still.length} chunks (${still.filter((j) => j.first).length} fresh)`);
  // a move of one chunk of level 0 along x: exactly one slab of level 0 comes in
  const L0 = levels[0], step = L0.chunk * L0.spacing;
  for (const L of levels) L.centre([c0[0] + step, c0[1], c0[2]]);
  const fresh = levels.map((L) => L.side ** 3 - L.traced.size);
  ok(fresh[0] === L0.side ** 2, `${name}: a one-chunk move brought ${fresh[0]} level-0 chunks in, not ${L0.side ** 2}`);
  let traced = 0;
  for (let k = 0; k < 1000; k++) { const j = clipJobs(levels, budget); const n = j.filter((x) => x.first).length; if (!n) break; traced += n; }
  ok(traced === fresh.reduce((a, b) => a + b, 0), `${name}: a move traced ${traced} chunks, ${fresh.reduce((a, b) => a + b, 0)} came in`);
  // a change marks the chunks within reach, and only traced ones
  const lo = [c0[0] + step + 3, 60, c0[2] + 1], hi = [lo[0] + 2, 62, lo[2] + 2];
  for (const L of levels) L.touch(lo, hi, 1);
  ok(levels[0].dirty.size >= 1 && levels[0].dirty.size <= 8, `${name}: a 2-cell change marked ${levels[0].dirty.size} level-0 chunks`);
  const marked = levels.reduce((a, L) => a + L.dirty.size, 0);
  const dj = clipJobs(levels, budget);
  ok(dj.some((j) => j.level === 0 && !j.first), `${name}: the change's chunks weren't updated next frame`);
  ok(dj.length <= budget.newMax + budget.rotate, `${name}: a change's frame went past the budget`);
  let k = 1;
  for (; k < 8 && levels.some((L) => L.dirty.size); k++) clipJobs(levels, budget);
  ok(levels.every((L) => L.dirty.size === 0) && k <= Math.ceil(marked / budget.newMax) + 1, `${name}: ${marked} changed chunks took ${k} frames`);
}
// tags: the JS and WGSL encodings agree on a few values (lcTag in light.js's WGSL is the same formula)
ok(lcTag(-1, 2, 3) === ((0x80000000 | 1023 | (2 << 10) | (3 << 20)) >>> 0), 'lcTag encodes negative coordinates wrongly');
// the glow kernel's weights: two passes of the old 5-tap blur, with both passes' gain
ok(Math.abs(GLOW_W9.reduce((a, b) => a + b, 0) - 1.15 ** 2) < 1e-9 && GLOW_W9.length === 9, 'the glow\'s 9-tap weights');
ok(TAGS.WORDS === SHADOW.SLOTS * (SHADOW.RES / SHADOW.TILE) ** 2 + PROBE.LEVELS * (PROBE.N / PROBE.CHUNK) ** 3 + GLOW.LEVELS * (GLOW.N / GLOW.CHUNK) ** 3, 'the tags\' layout');
ok(WC_BRICK === 4, 'the brick');

console.log(bad ? `world-light-cpu-check: ${bad} failures` : 'world-light-cpu-check: ok');
process.exit(bad ? 1 : 0);

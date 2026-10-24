// The world light's JS twin, for tools/world-light-cpu-check.mjs and tools/world-light-gpu-check.mjs:
// a small synthetic world in world-copy cell words (shaders/world/cellWord.js) with its occupancy levels,
// lcNext's march, the shadow writer's texel (the cell model: shadowTraceFrag({ fields: false })), the
// cascades traced through the bookkeeping (src/gfx/worldLightBook.js), the readers' cascade choice and
// hard shadow test (shCascadeFor, sunMapShadowAt), and a brute-force sun ray to judge them by.
import { wcWord, wcUnword } from '../src/shaders/world/cellWord.js';
import { SHADOW, lcTag } from '../src/shaders/world/light.js';
import { ShadowCascades, sunBasis } from '../src/gfx/worldLightBook.js';
import { LOOK } from '../src/gfx/materials.js';
import { ELEMENTS, E, R } from '../src/elements.js';

// A synthetic world: a stone floor, a floating stone slab, a glass pane, a water pool, a sand pile.
export const SIZE = [64, 32, 48];
export const cells = new Uint32Array(SIZE[0] * SIZE[1] * SIZE[2]);
export const at = (x, y, z) => x + SIZE[0] * (y + SIZE[1] * z);
const occ = [new Set(), new Set(), new Set()];   // the occupancy levels: a brick (4³), a 16³ and a 64³ node hold anything
export const put = (x0, x1, y0, y1, z0, z1, id, aux = 1) => {
  for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    cells[at(x, y, z)] = wcWord(id, 0, 20, aux);
    [2, 4, 6].forEach((s, l) => occ[l].add(`${x >> s},${y >> s},${z >> s}`));
  }
};
put(0, 64, 0, 4, 0, 48, E.STONE);
put(8, 18, 16, 18, 8, 18, E.STONE);        // the slab
put(30, 40, 14, 15, 8, 18, E.GLASS);       // a glass pane, one cell thick
put(44, 56, 4, 8, 28, 40, E.WATER);        // a pool on the floor
put(10, 14, 4, 10, 30, 34, E.SAND);        // a sand pile (smooth, opaque: blocks as its cells here)
export const word = (c) => (c[0] < 0 || c[1] < 0 || c[2] < 0 || c[0] >= SIZE[0] || c[1] >= SIZE[1] || c[2] >= SIZE[2] ? 0 : cells[at(...c)]);
export const idOf = (c) => word(c) & 255;
export const occupied = (lvl, c) => c.every((v, i) => v >= 0 && v < SIZE[i]) && occ[lvl].has(c.map((v) => v >> [2, 4, 6][lvl]).join(','));
export const SIGMA = (id) => ELEMENTS[id].sigma;
export const RCLASS = (id) => ELEMENTS[id].render;
export const meanSigma = (id) => (SIGMA(id)[0] + SIGMA(id)[1] + SIGMA(id)[2]) / 3;
const isCrisp = (id) => id !== 0 && LOOK[id].ch < 0 && LOOK[id].media < 0;
const isGasLike = (id) => id === 0 || RCLASS(id) === R.GAS || RCLASS(id) === R.FIRE;
const LC_EPS = 1e-3, LC_DIR_MIN = 1e-6, TINT = 256, NO_HIT = 1e5;
export const safeDir = (d) => d.map((v) => (Math.abs(v) < LC_DIR_MIN ? (v >= 0 ? 1 : -1) * LC_DIR_MIN : v));
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
export function shadowTexel(ro, rd) {
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
export const sun0 = [0.45, 0.8, 0.3];
export const casc = new ShadowCascades(SIZE);
export const slots = Array.from({ length: SHADOW.SLOTS }, () => new Map());   // wrapped texel index → texel
export const tags = new Map();   // `${slot},${wrapped tile}` → tag
export const R2 = SHADOW.RES, TL = SHADOW.TILE, TILES = R2 / TL;
export const wrap = (a, n) => ((a % n) + n) % n;
const targets = () => [...casc.cascades, casc.spare];
export function traceJobs(jobs) {
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
const place = (k, p) => {
  const c = casc.cascades[k], f = casc.frame, q = p.map((x, i) => x - f.centre[i]);
  const d = f.Rw - (q[0] * c.basis.s[0] + q[1] * c.basis.s[1] + q[2] * c.basis.s[2]);
  return { f: [(q[0] * c.basis.u[0] + q[1] * c.basis.u[1] + q[2] * c.basis.u[2]) / c.texel, (q[0] * c.basis.v[0] + q[1] * c.basis.v[1] + q[2] * c.basis.v[2]) / c.texel], d };
};
// shCascadeFor + sunMapShadowAt's twin (the hard 2×2 test inside volumes, no clouds or caustics)
export function cascadeFor(p) {
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
export function shadowAt(p, kForce = -1) {
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
export function bruteSun(p, sun) {
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
/** The occupancy as W's wcOccupied reads it, for the GPU stand-in: a u32 per brick, 16³ node and 64³ node. */
export function occupancyArrays() {
  const n = [2, 4, 6].map((s) => SIZE.map((v) => Math.ceil(v / (1 << s))));
  return n.map((d, l) => {
    const a = new Uint32Array(d[0] * d[1] * d[2]);
    for (const k of occ[l]) { const [x, y, z] = k.split(',').map(Number); a[x + d[0] * (y + d[1] * z)] = 1; }
    return { dims: d, bits: a };
  });
}

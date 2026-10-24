// The world light's bookkeeping (src/gfx/worldLight.js runs it; tools/world-light-cpu-check.mjs
// checks it): which shadow tiles, probe chunks and glow chunks a frame updates, under the fixed
// budgets of shaders/world/light.js, and the uniform the readers place them by. Pure JS, no GPU.
//
// Every structure is a window of a world-anchored lattice centred on the camera, addressed
// toroidally on the GPU (DDGI's "infinite scrolling volumes", Majercik et al. 2019; clipmaps,
// Losasso & Hoppe 2004). A window here only remembers which of its units are traced (a set of
// lattice keys); a camera move changes the window, drops the keys that left it, and the units that
// came in are simply the untraced ones, nearest first. A physics move changes nothing here. A
// world change (the world copy's changed boxes) marks the units it reaches dirty.
import { SHADOW, PROBE, GLOW } from '../shaders/world/light.js';

const key3 = (x, y, z) => `${x},${y},${z}`;
const floorDiv = (a, b) => Math.floor(a / b);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Offsets of an n^d window's units, nearest its centre first (the order units are taken in). */
function nearestOrder(n, d) {
  const out = [];
  const c = (n - 1) / 2;
  for (let z = 0; z < (d === 3 ? n : 1); z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    out.push({ o: d === 3 ? [x, y, z] : [x, y], r: (x - c) ** 2 + (y - c) ** 2 + (d === 3 ? (z - c) ** 2 : 0) });
  }
  return out.sort((a, b) => a.r - b.r).map((e) => e.o);
}

// ---------------------------------------------------------------- 3D clips (probes, glow)
/** One level: n units a side (chunks of `chunk` texels, texels `spacing` cells apart). */
export class ClipLevel {
  constructor({ level, n, chunk, spacing }) {
    Object.assign(this, { level, n, chunk, spacing, side: n / chunk });
    this.origin = null;           // lattice texel of the window's low corner (a multiple of chunk)
    this.traced = new Set();      // chunk keys traced and still in the window
    this.dirty = new Map();       // chunk key → chunk, traced but stale
    this.order = nearestOrder(this.side, 3);
    this.cursor = 0;              // the round robin's place in order
  }
  /** Centres the window on world cell cam; returns whether it moved. */
  centre(cam) {
    const o = cam.map((v) => floorDiv(floorDiv(v, this.spacing) - this.n / 2, this.chunk) * this.chunk);
    if (this.origin && o.every((v, i) => v === this.origin[i])) return false;
    this.origin = o;
    const lo = o.map((v) => v / this.chunk);
    const inside = (c) => c.every((v, i) => v >= lo[i] && v < lo[i] + this.side);
    for (const k of this.traced) if (!inside(k.split(',').map(Number))) this.traced.delete(k);
    for (const [k, c] of this.dirty) if (!inside(c)) this.dirty.delete(k);
    return true;
  }
  /** The chunk (lattice) at window offset o. */
  chunkAt(o) { const lo = this.origin.map((v) => v / this.chunk); return [lo[0] + o[0], lo[1] + o[1], lo[2] + o[2]]; }
  /** Marks dirty every traced chunk whose texels lie within `reach` texels of world-cell box [lo, hi). */
  touch(lo, hi, reach) {
    if (!this.origin) return;
    const a = lo.map((v) => floorDiv(floorDiv(v, this.spacing) - reach, this.chunk));
    const b = hi.map((v) => floorDiv(floorDiv(v - 1, this.spacing) + reach, this.chunk));
    const wlo = this.origin.map((v) => v / this.chunk);
    for (let z = Math.max(a[2], wlo[2]); z <= Math.min(b[2], wlo[2] + this.side - 1); z++)
      for (let y = Math.max(a[1], wlo[1]); y <= Math.min(b[1], wlo[1] + this.side - 1); y++)
        for (let x = Math.max(a[0], wlo[0]); x <= Math.min(b[0], wlo[0] + this.side - 1); x++) {
          const k = key3(x, y, z);
          if (this.traced.has(k)) this.dirty.set(k, [x, y, z]);
        }
  }
  /** Untraced chunks, nearest first, as { c, first: true, r } (r: distance in cells), at most max. */
  untraced(max) {
    const out = [];
    for (const o of this.order) {
      if (out.length >= max) break;
      const c = this.chunkAt(o);
      if (!this.traced.has(key3(...c))) out.push({ c, first: true, r: this.distOf(o) });
    }
    return out;
  }
  distOf(o) { const h = (this.side - 1) / 2; return Math.hypot(o[0] - h, o[1] - h, o[2] - h) * this.chunk * this.spacing; }
  /** The next max chunks of the round robin (traced ones: a refresh). */
  rotate(max) {
    const out = [];
    for (let i = 0; i < this.order.length && out.length < max; i++) {
      const c = this.chunkAt(this.order[this.cursor]);
      this.cursor = (this.cursor + 1) % this.order.length;
      if (this.traced.has(key3(...c))) out.push({ c, first: false });
    }
    return out;
  }
  done(job) { const k = key3(...job.c); this.traced.add(k); this.dirty.delete(k); }
}

/**
 * The frame's jobs over a set of levels: untraced chunks (nearest in cells first, any level) up to
 * newMax, then dirty ones up to newMax in all, then rotate round-robin refreshes. Each job is
 * { level, c: chunk lattice coords, first }. Marks them traced (the frame records them).
 */
export function clipJobs(levels, { newMax, rotate }) {
  const fresh = levels.flatMap((L) => L.untraced(newMax).map((j) => ({ ...j, level: L.level })))
    .sort((a, b) => a.r - b.r).slice(0, newMax);
  const jobs = fresh.map(({ c, level }) => ({ c, level, first: true }));
  for (const L of levels) {
    for (const [, c] of L.dirty) {
      if (jobs.length >= newMax) break;
      jobs.push({ c, level: L.level, first: false });
    }
  }
  // the refreshes: one chunk at a time, the levels in turn
  for (let i = 0; i < rotate; i++) {
    const L = levels[(levels.rotLevel = ((levels.rotLevel ?? -1) + 1) % levels.length)];
    for (const j of L.rotate(1)) jobs.push({ ...j, level: L.level });
  }
  for (const j of jobs) levels[j.level].done(j);
  return jobs;
}

export const probeLevels = () => PROBE.SPACING.map((spacing, level) => new ClipLevel({ level, n: PROBE.N, chunk: PROBE.CHUNK, spacing }));
export const glowLevels = () => GLOW.SPACING.map((spacing, level) => new ClipLevel({ level, n: GLOW.N, chunk: GLOW.CHUNK, spacing }));

// ---------------------------------------------------------------- shadow cascades
/** The sun basis: u, v across it (u level, as gfx/lighting.js sunBasis's), s toward it. */
export function sunBasis(sun) {
  const s = norm(sun);
  let u = cross([0, 1, 0], s);
  if (Math.hypot(...u) < 1e-6) u = [1, 0, 0];
  u = norm(u);
  return { u, v: cross(s, u), s };
}
/** The world's frame: its centre and the depth reference Rw (the bounding sphere plus SHADOW.PAD). */
export const worldFrame = (size) => ({ centre: size.map((n) => n / 2), Rw: 0.5 * Math.hypot(...size) + SHADOW.PAD });

/** A cascade (or the spare): its basis, texel, slot, epoch, window origin (texels) and traced tiles. */
export class ShadowTarget {
  constructor({ index, texel, fixed, slot }) {
    Object.assign(this, { index, texel, fixed, slot, epoch: 0, basis: null, origin: null });
    this.traced = new Set();
    this.dirty = new Map();
  }
  aim(basis, epoch) { this.basis = basis; this.epoch = epoch; this.traced.clear(); this.dirty.clear(); this.origin = null; }
  /** Sun-plane lattice coordinates (texels) of world point p. */
  place(p, frame) {
    const q = p.map((v, i) => v - frame.centre[i]);
    return [dot(q, this.basis.u) / this.texel, dot(q, this.basis.v) / this.texel];
  }
  centre(cam, frame) {
    const R = SHADOW.RES, T = SHADOW.TILE * SHADOW.SNAP_TILES;
    const o = this.fixed ? [-R / 2, -R / 2] : this.place(cam, frame).map((v) => Math.floor(v / T) * T - R / 2);
    if (this.origin && o[0] === this.origin[0] && o[1] === this.origin[1]) return false;
    this.origin = o;
    const lo = o.map((v) => v / SHADOW.TILE), side = R / SHADOW.TILE;
    const inside = (t) => t[0] >= lo[0] && t[0] < lo[0] + side && t[1] >= lo[1] && t[1] < lo[1] + side;
    for (const k of this.traced) if (!inside(k.split(',').map(Number))) this.traced.delete(k);
    for (const [k, t] of this.dirty) if (!inside(t)) this.dirty.delete(k);
    return true;
  }
  /** Marks dirty the traced tiles whose texels' rays may cross world-cell box [lo, hi). */
  touch(lo, hi, frame) {
    if (!this.origin || !this.basis) return;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let c = 0; c < 8; c++) {
      const p = [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]];
      const [a, b] = this.place(p, frame);
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    // a texel's ray runs through (i + 0.5, j + 0.5): the texels whose centres lie in the shadow of the box
    const t = SHADOW.TILE, side = SHADOW.RES / t, wlo = this.origin.map((v) => v / t);
    const ti0 = Math.max(Math.floor((Math.ceil(a0 - 0.5)) / t), wlo[0]), ti1 = Math.min(Math.floor(Math.floor(a1 - 0.5) / t), wlo[0] + side - 1);
    const tj0 = Math.max(Math.floor((Math.ceil(b0 - 0.5)) / t), wlo[1]), tj1 = Math.min(Math.floor(Math.floor(b1 - 0.5) / t), wlo[1] + side - 1);
    for (let j = tj0; j <= tj1; j++) for (let i = ti0; i <= ti1; i++) {
      const k = `${i},${j}`;
      if (this.traced.has(k)) this.dirty.set(k, [i, j]);
    }
  }
  /** Untraced tiles nearest the window's centre first, then dirty ones: at most max, as [i, j]. */
  pending(max, order) {
    const out = [];
    const lo = this.origin.map((v) => v / SHADOW.TILE);
    for (const o of order) {
      if (out.length >= max) return out;
      const t = [lo[0] + o[0], lo[1] + o[1]];
      if (!this.traced.has(`${t[0]},${t[1]}`)) out.push(t);
    }
    for (const [, t] of this.dirty) { if (out.length >= max) break; out.push(t); }
    return out;
  }
  complete() { return this.traced.size === (SHADOW.RES / SHADOW.TILE) ** 2 && this.dirty.size === 0; }
  done(t) { const k = `${t[0]},${t[1]}`; this.traced.add(k); this.dirty.delete(k); }
}

/**
 * The cascades and the spare. update(cam, sun, changes) re-centres them, marks what changes
 * reach, starts a retrace when the sun turned past SHADOW.TURN_RAD and swaps the spare in when it
 * is complete; jobs(max) hands out the frame's tiles: the cascades' first (untraced, then dirty),
 * then the spare's.
 */
export class ShadowCascades {
  constructor(size) {
    this.frame = worldFrame(size);
    this.order = nearestOrder(SHADOW.RES / SHADOW.TILE, 2);
    const last = SHADOW.CASCADES - 1;
    this.cascades = Array.from({ length: SHADOW.CASCADES }, (_, k) => new ShadowTarget({
      index: k, slot: k, fixed: k === last,
      texel: k === last ? 2 * this.frame.Rw / SHADOW.RES : SHADOW.TEXEL[k],
    }));
    this.spare = new ShadowTarget({ index: SHADOW.CASCADES, slot: SHADOW.CASCADES, fixed: false, texel: 1 });
    this.retracing = -1;      // the cascade the spare is being traced for, or -1
    this.epochs = 0;
  }
  _nextEpoch() { this.epochs = (this.epochs + 1) & 1023; return this.epochs; }
  update(cam, sun, changes = []) {
    const b = sunBasis(sun);
    for (const c of this.cascades) if (!c.basis) c.aim(b, this._nextEpoch());
    if (this.retracing < 0) {
      const k = this.cascades.findIndex((c) => Math.acos(Math.min(1, dot(c.basis.s, b.s))) > SHADOW.TURN_RAD);
      if (k >= 0) {
        const c = this.cascades[k];
        this.retracing = k;
        this.spare.fixed = c.fixed;
        this.spare.texel = c.texel;
        this.spare.aim(b, this._nextEpoch());
      }
    }
    for (const c of [...this.cascades, ...(this.retracing >= 0 ? [this.spare] : [])]) {
      c.centre(cam, this.frame);
      for (const { lo, hi } of changes) c.touch(lo, hi, this.frame);
    }
    if (this.retracing >= 0 && this.spare.complete()) this._swap();
  }
  _swap() {
    const k = this.retracing, c = this.cascades[k], s = this.spare;
    // the spare becomes cascade k; its old slot becomes the spare's
    this.cascades[k] = s;
    s.index = k;
    this.spare = c;
    c.index = SHADOW.CASCADES;
    this.retracing = -1;
  }
  /** The frame's tiles: { tile: [i, j], target (0..CASCADES-1 or CASCADES: the spare), slot }. */
  jobs(max = SHADOW.TILES_PER_FRAME) {
    const out = [];
    const take = (c, target) => {
      for (const t of c.pending(max - out.length, this.order)) { out.push({ tile: t, target, slot: c.slot }); c.done(t); }
    };
    for (let k = 0; k < SHADOW.CASCADES && out.length < max; k++) take(this.cascades[k], k);
    if (this.retracing >= 0 && out.length < max) take(this.spare, SHADOW.CASCADES);
    return out;
  }
  /** Is cascade k's tile [i, j] traced (the reader's tag test, on the CPU)? */
  tileValid(k, t) { return this.cascades[k].traced.has(`${t[0]},${t[1]}`); }
}

/** The readers' uniform values (shaders/world/light.js LightUniforms). */
export function lightUniformValues(size, shadow, probes, glow) {
  const f = shadow.frame;
  const cs = shadow.cascades;
  return {
    shU: cs.map((c) => [...c.basis.u, c.texel]),
    shV: cs.map((c) => [...c.basis.v, c.slot]),
    shS: cs.map((c) => [...c.basis.s, c.epoch]),
    shO: cs.map((c) => [...(c.origin ?? [0, 0]), c.origin ? 1 : 0, 0]),
    centre: [...f.centre, f.Rw],
    prO: probes.map((L) => [...(L.origin ?? [0, 0, 0]), L.spacing]),
    glO: glow.map((L) => [...(L.origin ?? [0, 0, 0]), L.spacing]),
    size: [...size, 0],
  };
}
/** The shadow writer's list values (shaders/world/lightWriters.js ShadowJobs). */
export function shadowJobValues(shadow, jobs) {
  const t = [...shadow.cascades, shadow.spare];
  const f = shadow.frame;
  return {
    count: jobs.length,
    u: t.map((c) => [...(c.basis?.u ?? [1, 0, 0]), c.texel]),
    v: t.map((c) => [...(c.basis?.v ?? [0, 0, 1]), c.slot]),
    s: t.map((c) => [...(c.basis?.s ?? [0, 1, 0]), c.epoch]),
    centre: [...f.centre, f.Rw],
    jobs: jobs.map((j) => [j.tile[0], j.tile[1], j.target, j.slot]),
  };
}

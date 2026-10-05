import { ELEMENTS, E, K } from '../elements.js';

// The construction runtime: the small API every construction is written in.
//
// Built-ins, model-written code and code run by coding agents all use the same
// functions (put, box, ball, disc, rod, ...). This module has no three.js and no
// DOM, so it runs on the main thread, in the sandbox worker and in Node.
//
// A construction is built around its base point (0, 0, 0): y is up, nothing goes
// below y = 0, and the front faces +z (it is turned toward the camera when placed).

export const MAX_CELLS = 250_000;     // cells one construction may define
export const MAX_COORD = 1000;        // |x|, |z| and y must stay below this
export const MAX_FOOT = 32;           // deepest footing below the base, in cells
export const EXEC_TIMEOUT_MS = 5000;  // sandboxed code is stopped after this long
const SCALE_AT_ZERO = 0.45;           // size scale T = SCALE_AT_ZERO + size * SCALE_PER_SIZE,
const SCALE_PER_SIZE = 0.11;          // so brush size 5 (the default) gives T = 1
const KEY_SPAN = 2048;                // packing span per axis for cell keys (> 2 * MAX_COORD)

export const scaleFor = (size) => SCALE_AT_ZERO + size * SCALE_PER_SIZE;

// Element names the API accepts: keys (WATER), TPT abbreviations (WATR) and AIR.
const ELEMENT_NAMES = new Map();
for (const e of ELEMENTS) { ELEMENT_NAMES.set(e.key, e.id); ELEMENT_NAMES.set(e.abbr, e.id); }
ELEMENT_NAMES.set('AIR', E.EMPTY);
const nameOf = (id) => (id === E.EMPTY ? 'AIR' : ELEMENTS[id].key);
export const elementNames = () => ELEMENTS.map((e) => nameOf(e.id));

export function resolveElement(el) {
  if (typeof el === 'number' && ELEMENTS[el]) return el;
  const id = typeof el === 'string' ? ELEMENT_NAMES.get(el.trim().toUpperCase()) : undefined;
  if (id === undefined) throw new Error(`Unknown element ${JSON.stringify(el)}. Use one of: ${elementNames().join(', ')}`);
  return id;
}

// mulberry32: small, fast, seedable
export function makeRng(seed) {
  let s = seed >>> 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.int = (lo, hi) => lo + Math.floor((hi - lo + 1) * r());
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  return r;
}
export const newSeed = () => (Math.random() * 4294967296) >>> 0;

// A 3-vector with the subset of three.js Vector3 methods constructions use.
export class Vec {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  clone() { return new Vec(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) { return this.set(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x); }
  lengthSq() { return this.dot(this); }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
}
const asVec = (p) => (Array.isArray(p) ? new Vec(p[0], p[1], p[2]) : p);

// ---------------------------------------------------------------- model

function checkRange(x, y, z) {
  if (Math.abs(x) < MAX_COORD && y < MAX_COORD && Math.abs(z) < MAX_COORD) return;
  throw new Error(`Cell (${x}, ${y}, ${z}) is out of range: keep |x|, |z| and y below ${MAX_COORD}`);
}

// A construction being assembled: sparse cells around its base point. Shapes
// take options { temp, ctype, soft }; soft cells never replace cells already
// placed (leaves around branches, fire between logs).
export class Model {
  constructor(rnd) {
    this.cells = new Map();
    this.rnd = rnd;
    this.foot = 0; // how deep solid base cells may grow a footing
  }

  static key(x, y, z) { return ((x + KEY_SPAN / 2) * KEY_SPAN + y) * KEY_SPAN + (z + KEY_SPAN / 2); }

  put(x, y, z, id, o) {
    x = Math.round(x); y = Math.round(y); z = Math.round(z);
    if (!(y >= 0)) return; // also drops NaN
    checkRange(x, y, z);
    const k = Model.key(x, y, z);
    const had = this.cells.has(k);
    if (o?.soft && had) return;
    if (!had && this.cells.size >= MAX_CELLS) throw new Error(`Too many cells: the limit is ${MAX_CELLS}`);
    this.cells.set(k, { x, y, z, id, temp: o?.temp ?? ELEMENTS[id].temp, ctype: o?.ctype ?? 0 });
  }

  // element id at a cell, or -1 where nothing is set
  get(x, y, z) {
    return this.cells.get(Model.key(Math.round(x), Math.round(y), Math.round(z)))?.id ?? -1;
  }

  // inclusive bounds
  box(x0, y0, z0, x1, y1, z1, id, o) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.put(x, y, z, id, o);
  }

  // Does a frayed edge or a random hole drop a cell at distance d from a shape
  // whose edge is at `edge`? rough frays the edge by up to ±rough/2.
  dropped(d, edge, rough, holes) {
    if (d > edge + rough * (this.rnd() - 0.5)) return true;
    return !!holes && this.rnd() < holes;
  }

  // Horizontal disc; `rough` frays the edge by up to ±rough/2 cells.
  disc(cx, y, cz, r, id, o = {}) {
    const R = Math.ceil(r + 1), rough = o.rough ?? 0, holes = o.holes ?? 0;
    for (let z = Math.floor(cz - R); z <= Math.ceil(cz + R); z++)
      for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
        if (!this.dropped(Math.hypot(x - cx, z - cz), r, rough, holes)) this.put(x, y, z, id, o);
      }
  }

  // Ellipsoid of radius r, squashed vertically by sy, with a frayed edge and gaps.
  ball(cx, cy, cz, r, id, o = {}) {
    const sy = o.sy ?? 1, rough = o.rough ?? 0, holes = o.holes ?? 0;
    const R = Math.ceil(r + 1), Ry = Math.ceil(r * sy + 1);
    for (let y = Math.floor(cy - Ry); y <= Math.ceil(cy + Ry); y++)
      for (let z = Math.floor(cz - R); z <= Math.ceil(cz + R); z++)
        for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
          if (!this.dropped(Math.hypot(x - cx, (y - cy) / sy, z - cz) / r, 1, rough, holes)) this.put(x, y, z, id, o);
        }
  }

  // Thick segment from a to b. r = 0.5 draws a single-cell line, kept
  // face-connected so thin trunks and branches don't touch only at corners.
  rod(a, b, r, id, o) {
    a = asVec(a); b = asVec(b);
    const n = Math.max(1, Math.ceil(a.distanceTo(b) * 2));
    const R = Math.ceil(r), r2 = r * r;
    let lx, ly, lz;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = Math.round(a.x + (b.x - a.x) * t);
      const py = Math.round(a.y + (b.y - a.y) * t);
      const pz = Math.round(a.z + (b.z - a.z) * t);
      if (i > 0 && r2 < 1) {
        if (px !== lx && (py !== ly || pz !== lz)) this.put(px, ly, lz, id, o);
        if (pz !== lz && py !== ly) this.put(px, py, lz, id, o);
      }
      lx = px; ly = py; lz = pz;
      for (let dy = -R; dy <= R; dy++)
        for (let dz = -R; dz <= R; dz++)
          for (let dx = -R; dx <= R; dx++)
            if (dx * dx + dy * dy + dz * dz <= r2) this.put(px + dx, py + dy, pz + dz, id, o);
    }
  }

  // Compact, transferable copy: one entry per cell in parallel typed arrays.
  toCells() {
    const n = this.cells.size;
    const out = {
      n, foot: this.foot,
      x: new Int16Array(n), y: new Int16Array(n), z: new Int16Array(n),
      id: new Uint8Array(n), temp: new Float32Array(n), ctype: new Uint8Array(n),
    };
    let i = 0;
    for (const c of this.cells.values()) {
      out.x[i] = c.x; out.y[i] = c.y; out.z[i] = c.z;
      out.id[i] = c.id; out.temp[i] = c.temp; out.ctype[i] = c.ctype;
      i++;
    }
    return out;
  }
}

export const cellBuffers = (c) => [c.x.buffer, c.y.buffer, c.z.buffer, c.id.buffer, c.temp.buffer, c.ctype.buffer];

// ---------------------------------------------------------------- API

// The names construction code sees. Generated code uses them as bare globals;
// built-ins destructure them from their first argument.
export const API_NAMES = ['put', 'get', 'box', 'ball', 'disc', 'rod', 'vec', 'bend', 'clamp', 'footing', 'rnd', 'T', 'SIZE'];

export function createApi(model, { size }) {
  const rnd = model.rnd;
  const opts = (o) => {
    if (o == null) return undefined;
    if (typeof o !== 'object') throw new Error('Options must be an object like { temp, ctype, soft }');
    const out = { ...o };
    if (o.ctype != null) out.ctype = resolveElement(o.ctype);
    if (o.temp != null && !Number.isFinite(o.temp)) throw new Error('temp must be a number in °C');
    return out;
  };
  const vec = (x = 0, y = 0, z = 0) => new Vec(x, y, z);
  return {
    put: (x, y, z, el, o) => model.put(x, y, z, resolveElement(el), opts(o)),
    // what this construction has put at a cell so far: an element name, 'AIR', or null
    get: (x, y, z) => { const id = model.get(x, y, z); return id < 0 ? null : nameOf(id); },
    box: (x0, y0, z0, x1, y1, z1, el, o) => model.box(x0, y0, z0, x1, y1, z1, resolveElement(el), opts(o)),
    ball: (cx, cy, cz, r, el, o) => model.ball(cx, cy, cz, r, resolveElement(el), opts(o)),
    disc: (cx, y, cz, r, el, o) => model.disc(cx, y, cz, r, resolveElement(el), opts(o)),
    rod: (a, b, r, el, o) => model.rod(a, b, r, resolveElement(el), opts(o)),
    vec,
    // turn a direction by `ang` radians toward a random perpendicular
    bend: (dir, ang) => {
      dir = asVec(dir);
      const perp = vec(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).cross(dir);
      if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0);
      perp.normalize();
      return dir.clone().multiplyScalar(Math.cos(ang)).addScaledVector(perp, Math.sin(ang)).normalize();
    },
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    // let solid cells on y = 0 grow down to the ground, up to `depth` cells
    footing: (depth = MAX_FOOT) => { model.foot = Math.max(0, Math.min(MAX_FOOT, Math.round(depth))); },
    rnd,
    T: scaleFor(size),
    SIZE: size,
  };
}

// Run a built-in generator function: fn(api, variant).
export function runGenerator(fn, { size, seed, variant }) {
  const model = new Model(makeRng(seed));
  fn(createApi(model, { size }), variant);
  return model.toCells();
}

// Globals construction code must not reach; shadowed as parameters (the
// sandbox worker also removes the real ones before running anything).
const SHADOWED = ['self', 'globalThis', 'window', 'postMessage', 'fetch', 'importScripts', 'XMLHttpRequest',
  'WebSocket', 'EventSource', 'Worker', 'indexedDB', 'caches', 'localStorage', 'document'];

// Default runner: compile with new Function in strict mode.
const runWithFunction = (code, api) => {
  const fn = new Function(...API_NAMES, ...SHADOWED, `"use strict";\n${code}\n`);
  fn(...API_NAMES.map((k) => api[k]));
};

// Run construction code (the body of a function that uses the API names as
// globals). `run` lets Node swap in a vm-based runner with a timeout.
export function execConstruction(code, { size = 5, seed = 1 } = {}, run = runWithFunction) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('No code to run');
  const model = new Model(makeRng(seed));
  run(code, createApi(model, { size }));
  if (!model.cells.size) throw new Error('The code ran but placed no cells');
  return model.toCells();
}

// ---------------------------------------------------------------- bake

const TURN = [(x, z) => [x, z], (x, z) => [z, -x], (x, z) => [-x, -z], (x, z) => [-z, x]];

// Cells turned by quarter turns about y (the front, +z, ends up facing +z, +x,
// -z or -x), with their bounding box.
export function turnCells(cells, quarter) {
  const turn = TURN[quarter];
  const X = new Int16Array(cells.n), Z = new Int16Array(cells.n);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < cells.n; i++) {
    const [x, z] = turn(cells.x[i], cells.z[i]);
    X[i] = x; Z[i] = z;
    const p = [x, cells.y[i], z];
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  }
  return { X, Z, min, max };
}

// Turn cells and pack them into the stamp texture layout: x = element id + 1
// (0 leaves the cell alone), y = temperature, z = ctype, w = 1 where a base
// cell may grow a footing.
export function bake(cells, quarter) {
  if (!cells.n) return null;
  const { X, Z, min, max } = turnCells(cells, quarter);
  const w = max[0] - min[0] + 1, h = max[1] - min[1] + 1, d = max[2] - min[2] + 1;
  const data = new Float32Array(w * h * d * 4);
  const ids = new Int16Array(w * h * d).fill(-1);
  for (let i = 0; i < cells.n; i++) {
    const id = cells.id[i];
    const j = ((Z[i] - min[2]) * h + cells.y[i] - min[1]) * w + X[i] - min[0];
    ids[j] = id;
    data[j * 4] = id + 1;
    data[j * 4 + 1] = cells.temp[i];
    data[j * 4 + 2] = cells.ctype[i];
    data[j * 4 + 3] = cells.foot && cells.y[i] === 0 && ELEMENTS[id].kind === K.SOLID ? 1 : 0;
  }
  return { w, h, d, data, ghost: ghostCells(ids, w, h, d), foot: cells.foot, base: { x: -min[0], y: -min[1], z: -min[2] } };
}

// The ghost preview draws every non-air cell that isn't buried inside the model:
// a flat list of x, y, z, id.
function ghostCells(ids, w, h, d) {
  const at = (x, y, z) => (z * h + y) * w + x;
  const solid = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < w && y < h && z < d && ids[at(x, y, z)] > 0;
  const buried = (x, y, z) => solid(x - 1, y, z) && solid(x + 1, y, z) && solid(x, y - 1, z) &&
    solid(x, y + 1, z) && solid(x, y, z - 1) && solid(x, y, z + 1);
  const ghost = [];
  for (let z = 0; z < d; z++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const id = ids[at(x, y, z)];
        if (id > 0 && !buried(x, y, z)) ghost.push(x, y, z, id);
      }
  return ghost;
}

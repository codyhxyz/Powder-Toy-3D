import * as THREE from 'three';
import { TRANSFER_SLOTS, TRANSFER_TAKE, TRANSFER_PUT, ALLOW_IDS } from '../../shaders/transfer.js';
import { povGpu } from '../gpu.js';
import { ELEMENTS, K } from '../../elements.js';
import { FULL } from '../../v2/layout.js';
import { PHYS, NOMINAL_STEP_RATE } from '../../physics.js';
import { BODY_WIDTH, BODY_HEIGHT } from '../constants.js';
import { voxelWalk } from '../grid.js';

// Exact cell transfer: the shared machinery the hand tools use to take cells out
// of the grid and put them back, conserving matter exactly although readbacks
// are asynchronous and the world keeps moving.
//
// take(): the caller lists candidate cells (nearest first) and a filter. One
// dispatch (shaders/transfer.js) tests every listed cell against the state,
// turns exactly the qualifying ones into air, and writes what each held into a
// ring slot (docs/webgpu.md D7, B7): the test and the change read the same
// state. The answer is read back asynchronously, and the promise resolves with
// the cells taken.
// put(): the same, the other way round. Each target cell must be empty air (a
// gas or anything else stays where it is); the answer tells which items landed.
//
// Between the dispatch and the readback the matter is "in flight": gone from
// the grid (take) or in the grid and reserved in the load (put). Load tracks
// both, so a load never over-fills and an item is never placed twice. If
// graphics stop before an answer lands, the world is gone with the device: a
// take keeps nothing and a put gets its items back, so nothing is counted
// twice when a new world loads.

const MAX_IN_FLIGHT = 8;                 // transfers awaiting readback at once
const SLOT_COMPONENTS = 4;               // vec4 per slot: (cell xyz, wanted id); an item; an answer
const ANY_ID = -1;                       // slot filter: any element of the allowed kinds
const ANY_HARD = 1e30;                   // take maxHard: no cap (a finite f32: the uniform buffer carries it)

export { TRANSFER_SLOTS };
export const KIND_BIT = (kind) => 1 << kind;

// A take's `allow` mask (shaders/transfer.js): a bit per element id, as vec4us.
export function allowMask(ids) {
  const words = new Uint32Array(ALLOW_IDS / 32);
  for (const id of ids) words[id >> 5] |= 1 << (id & 31);
  const out = [];
  for (let i = 0; i < words.length; i += 4) out.push([...words.subarray(i, i + 4)]);
  return out;
}

// A cell's contents as carried: [element id, temperature °C, life, ctype + seed].
export const cellOf = (buf, i) => [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], buf[i * 4 + 3],
  ...(buf.native ? buf.native.subarray(i * 5, i * 5 + 5) : [])];

const keyOf = (x, y, z) => `${x},${y},${z}`;

// ---------------------------------------------------------------- candidate cells

// Grid cells within `radius` of `center` (grid coords, cell centres at +0.5),
// nearest first, inside the grid, optionally filtered by keep(x, y, z).
export function cellsNear(center, radius, g, keep = null, max = TRANSFER_SLOTS) {
  const out = [];
  const r = Math.ceil(radius);
  const cx = Math.floor(center.x), cy = Math.floor(center.y), cz = Math.floor(center.z);
  for (let z = cz - r; z <= cz + r; z++)
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) continue;
        const d2 = (x + 0.5 - center.x) ** 2 + (y + 0.5 - center.y) ** 2 + (z + 0.5 - center.z) ** 2;
        if (d2 > radius * radius) continue;
        if (keep && !keep(x, y, z)) continue;
        out.push([x, y, z, d2]);
      }
  out.sort((a, b) => a[3] - b[3]);
  return out.slice(0, max).map(([x, y, z]) => [x, y, z]);
}

// keep() for cellsNear: leaves out the cells the body stands in (feet = player.pos).
export function outsideBody(feet, margin = 0) {
  const hw = BODY_WIDTH / 2 + margin;
  return (x, y, z) => x + 1 <= feet.x - hw || x >= feet.x + hw
    || z + 1 <= feet.z - hw || z >= feet.z + hw
    || y + 1 <= feet.y - margin || y >= feet.y + BODY_HEIGHT + margin;
}

// Distance along dir from eye to where the ray leaves the body's box (0 if the
// eye is outside it): a spout or a dump point past this doesn't fill the body.
export function bodyExit(eye, dir, feet, margin = 0) {
  const hw = BODY_WIDTH / 2 + margin;
  const lo = [feet.x - hw, feet.y - margin, feet.z - hw];
  const hi = [feet.x + hw, feet.y + BODY_HEIGHT + margin, feet.z + hw];
  const o = [eye.x, eye.y, eye.z], d = [dir.x, dir.y, dir.z];
  let tExit = Infinity;
  for (let k = 0; k < 3; k++) {
    if (o[k] < lo[k] || o[k] > hi[k]) return 0;
    if (d[k] > 0) tExit = Math.min(tExit, (hi[k] - o[k]) / d[k]);
    else if (d[k] < 0) tExit = Math.min(tExit, (lo[k] - o[k]) / d[k]);
  }
  return Number.isFinite(tExit) ? tExit : 0;
}

// Sim velocity (cells/step) from a velocity in cells/s, at the current step rate. Under V2 it is
// V1's cells/step at V1's nominal rate, with V1's V_MAX cap: the native put launches the cells at
// that velocity in m/s (shaders/v2/transfer.js), the speed the throw has in the world.
export function toStepVelocity(v, ctx, out = new THREE.Vector3()) {
  const stepsPerSecond = ctx.sim?.compact ? NOMINAL_STEP_RATE : ctx.stepsPerFrame > 0 && ctx.dt > 0 ? ctx.stepsPerFrame / ctx.dt : 0;
  if (!stepsPerSecond) return out.set(0, 0, 0);
  out.copy(v).divideScalar(stepsPerSecond);
  if (out.length() > PHYS.V_MAX) out.setLength(PHYS.V_MAX);
  return out;
}

// ---------------------------------------------------------------- loads

// A load: cells carried by a tool, each [id, T, life, ctype + seed], kept as
// they were (no heat exchange while carried). Loads outlive the toolbelt, so
// leaving POV or switching tools never loses matter.
export class Load {
  constructor(capacity) {
    this.capacity = capacity;
    this.cells = [];
    this.reserved = 0;   // room promised to takes in flight
    this.out = 0;        // cells placed by puts in flight (still counted)
    this.version = 0;    // bumped on every change
  }
  get count() { return this.cells.length + this.out; }
  get free() { return Math.max(0, this.capacity - this.count - this.reserved); }
  get busy() { return this.reserved > 0 || this.out > 0; }
  // the element most of the load is (carried cells only), or -1 when empty
  get mainId() {
    let best = -1, bestN = 0;
    for (const [id, k] of Object.entries(this.totals())) if (k > bestN) { best = +id; bestN = k; }
    return best;
  }
  get mixed() { return Object.keys(this.totals()).length > 1; }
  status() {
    if (!this.count) return null;
    const id = this.mainId;
    const abbr = id >= 0 ? ELEMENTS[id].abbr : '';
    return `${abbr}${this.mixed ? '+' : ''} ×${this.count}`;
  }
  // per-element totals, for conservation checks: { id: count }. Counted once per
  // change (the hotbar asks every frame, and a full pack is tens of thousands of cells).
  totals() {
    if (this.tally?.version !== this.version || this.tally.length !== this.cells.length) {
      const t = {};
      for (const c of this.cells) t[c[0]] = (t[c[0]] ?? 0) + 1;
      this.tally = { version: this.version, length: this.cells.length, t };
    }
    return { ...this.tally.t };
  }
}

// The pack: the player's inventory of loose matter. The shovel digs into it, the
// trowel builds from it and the shovel throws from it. Liquids go in the bucket.
export const PACK_KEY = 'PACK';
// Minecraft's inventory: 36 slots of 64 blocks (minecraft.wiki/w/Inventory), a block being the
// trowel's 3³ cells. Big enough that digging never stops for a full pack (Astroneer and Deep Rock
// Galactic never stop you digging either); it was 1000 cells, full after about 12 s of sand.
export const PACK_CAPACITY = 36 * 64 * 27;   // cells (62 208 ≈ 1680 m³ at 30 cm cells)
// owner: whose pack (env.owner, an NPC's id); the player's when absent
export const ownedKey = (key, owner) => (owner ? `${owner}:${key}` : key);
export const pack = (owner) => persistentLoad(ownedKey(PACK_KEY, owner), PACK_CAPACITY);
// what the pack holds, by element: [[id, count], ...], most first
export function packContents(load = pack()) {
  return Object.entries(load.totals()).map(([id, n]) => [+id, n]).sort((a, b) => b[1] - a[1]);
}

const loads = new Map();
// The load a tool keeps across toolbelts (POV sessions): one per key.
export function persistentLoad(key, capacity) {
  if (!loads.has(key)) loads.set(key, new Load(capacity));
  return loads.get(key);
}
export const allLoads = () => loads;
// The world was replaced (undo, a scene load, a new grid): what the tools carry
// came from the old one, so keeping it would duplicate those cells.
export function emptyLoads() {
  for (const load of loads.values()) { load.cells.length = 0; load.legacyCarry?.clear(); load.version++; }
}

// ---------------------------------------------------------------- cargo across engines

// V2's cargo (v2/transfer.js nativeCargo: four display fields, then the five raw native words) going
// into V1's cells: a runtime switch to V1 with cargo in a pump, a bucket or the pack. V1 has no fill
// or energy bank, so it gets what V2's own V1 export gives (shaders/compact.js): a non-liquid as its
// display fields (compactProbeA: id, T, life, ctype), a liquid as whole cells of its element. Liquid
// is counted by fill (FULL a whole cell), never by item, so no mass is made or lost: a liquid's fill
// short of a whole cell, or past the load's room, waits in load.legacyCarry (by element: fill and
// fill-weighted temperature) and comes out with the next V1 put. V1's 4-word cells pass unchanged,
// and V2 places them as it imports V1's (shaders/v2/transfer.js fromLegacy). native: V2 steps the grid,
// so its cargo stays exact and only whole cells of a carry left from V1 come out.
export function legacyCargo(load, { native = false } = {}) {
  const carry = load.legacyCarry;
  if ((native || !load.cells.some(c => c.length > 4)) && !carry?.size) return;
  const keep = [], liquids = new Map(carry ?? []);
  for (const c of load.cells) {
    if (c.length <= 4 || native) { keep.push(c); continue; }
    if (ELEMENTS[c[0]]?.kind !== K.LIQUID) { keep.push(c.slice(0, 4)); continue; }
    const fill = c[5] & 0xffffff, l = liquids.get(c[0]) ?? { fill: 0, heat: 0, life: c[2], ctype: c[3] };
    liquids.set(c[0], { ...l, fill: l.fill + fill, heat: l.heat + fill * c[1] });
  }
  let room = Math.max(0, load.capacity - keep.length - load.out - load.reserved);
  const rest = new Map();
  for (const [id, l] of liquids) {
    const T = l.fill > 0 ? l.heat / l.fill : 0, whole = Math.min(Math.floor(l.fill / FULL), room);
    for (let i = 0; i < whole; i++) keep.push([id, T, l.life, l.ctype]);
    room -= whole;
    const left = l.fill - whole * FULL;
    if (left > 0) rest.set(id, { ...l, fill: left, heat: T * left });
  }
  load.cells = keep;
  load.legacyCarry = rest;
  load.version++;
}

// ---------------------------------------------------------------- the transfer engine

export function createTransfer({ getSim }) {
  let inFlight = 0;

  // Record the transfer's one dispatch and read its answer back.
  function run({ cells, wants, items, mode, kinds = 0, breakDebris = false, maxHard = ANY_HARD, maxTemperature = 1e30, guard = null, allow = null, limit, vel }) {
    const sim = getSim();
    const n = Math.min(cells.length, TRANSFER_SLOTS);
    if (!sim || !n || limit <= 0 || inFlight >= MAX_IN_FLIGHT) return null;
    // a cell listed twice would be taken (or filled) twice by the answer but once in the grid
    const seen = new Set();
    const slots = [];
    for (let i = 0; i < n; i++) {
      const [x, y, z] = cells[i];
      const k = keyOf(x, y, z);
      if (seen.has(k)) continue;
      seen.add(k);
      slots.push([x, y, z, wants?.[i] ?? ANY_ID]);
    }
    const count = slots.length;
    const answer = povGpu(sim).transfer({
      count, limit: Math.min(limit, TRANSFER_SLOTS), mode, kinds, breaks: breakDebris ? 1 : 0, maxHard, only: allow ? 1 : 0, allow: allow ?? [],
      maxTemperature,
      guardBase: guard?.base ?? [0, 0, 0], guardMaterial: guard?.material ?? -1,
      guardPort: guard?.port ?? [0, 0, 0], guardPowered: guard?.powered ? 1 : 0,
      vel: vel ?? [0, 0, 0], cells: slots, items: items ? items.slice(0, TRANSFER_SLOTS) : [],
    });
    if (!answer) return null;   // (its kernel is still building: B5)
    inFlight++;
    return answer.then((bytes) => { inFlight--; return bytes instanceof Float32Array ? bytes : new Float32Array(bytes, 0, count * SLOT_COMPONENTS); },
      (err) => { inFlight--; throw err; });
  }

  return {
    get busy() { return inFlight >= MAX_IN_FLIGHT; },
    get pending() { return inFlight; },

    // Take up to `load.free` (or `limit`) qualifying cells from `cells` (nearest
    // first) into `load`. kinds: element kinds allowed (K.*). want: one element
    // id only, or -1. breakDebris: solids come out as their debris, and only
    // those no harder than maxHard (loose kinds come out as they are). ids: only
    // these elements (allowMask), or all. Returns a promise of the taken cells,
    // or null when nothing was issued (busy, full).
    // maxTemperature is inclusive and tested atomically with removal. guard:
    // {base:[x,y,z], material, port:[x,y,z], powered} requires an intact 4x4
    // base and (optionally) native TPT control, also for put(). Both opt-in.
    take(load, { cells, kinds, want = ANY_ID, breakDebris = false, maxHard = ANY_HARD, maxTemperature = 1e30, guard = null, ids = null, limit = Infinity }) {
      const n = Math.min(limit, load.free);
      if (n <= 0) return null;
      const mask = kinds.reduce((m, k) => m | KIND_BIT(k), 0);
      const wants = want === ANY_ID ? null : cells.map(() => want);
      const p = run({ cells, wants, mode: TRANSFER_TAKE, kinds: mask, breakDebris, maxHard, maxTemperature, guard, allow: ids && allowMask(ids), limit: n });
      if (!p) return null;
      load.reserved += n;
      return p.then((buf) => {
        load.reserved -= n;
        const got = [];
        for (let i = 0; i < buf.length / SLOT_COMPONENTS; i++) if (buf[i * SLOT_COMPONENTS] >= 0) got.push(cellOf(buf, i));
        load.cells.push(...got);
        load.version++;
        return got;
      }, (err) => {
        // graphics stopped: the world it came from is gone, so nothing was taken
        load.reserved -= n;
        load.version++;
        throw err;
      });
    },

    // Place up to `max` cells from `load` (the most recently loaded first; only
    // element `id`, if given) into the empty cells among `cells` (nearest first),
    // moving at `vel` cells/step. Returns a promise of how many landed; the rest
    // go back into the load.
    put(load, { cells, max = Infinity, vel, id = ANY_ID, guard = null }) {
      legacyCargo(load, { native: !!getSim()?.compact });   // (V1's cells: V2 cargo as V2's export gives it)
      const picked = [];   // indices into load.cells, newest first
      const want = Math.min(max, TRANSFER_SLOTS);
      for (let i = load.cells.length - 1; i >= 0 && picked.length < want; i--) {
        if (id === ANY_ID || load.cells[i][0] === id) picked.push(i);
      }
      const n = picked.length;
      if (n <= 0) return null;
      const items = picked.map((i) => load.cells[i]);
      const p = run({ cells, items, mode: TRANSFER_PUT, limit: n, vel, guard });
      if (!p) return null;
      const out = new Set(picked);
      load.cells = load.cells.filter((_, i) => !out.has(i));
      load.out += n;
      load.version++;
      return p.then((buf) => {
        load.out -= n;
        let landed = 0;
        for (let i = 0; i < buf.length / SLOT_COMPONENTS; i++) if (buf[i * SLOT_COMPONENTS] >= 0) landed++;
        // the first `landed` items went in (ranks 0..landed-1); the rest come back
        load.cells.push(...items.slice(landed).reverse());
        load.version++;
        return landed;
      }, (err) => {
        // graphics stopped: the world it went into is gone, so every item comes back
        load.out -= n;
        load.cells.push(...items.slice().reverse());
        load.version++;
        throw err;
      });
    },

    dispose() {},
  };
}

// One transfer engine per renderer (the page's), shared by every tool (and every toolbelt).
const engines = new WeakMap();
export function sharedTransfer(env) {
  if (!engines.has(env.renderer)) engines.set(env.renderer, createTransfer(env));
  return engines.get(env.renderer);
}

// ---------------------------------------------------------------- tool helpers

// ctx.aim if it hits something (a cell, or the floor: id -1) within `reach`
// cells of the eye, else null.
export function aimInReach(ctx, reach) {
  const a = ctx.aim;
  if (!a?.valid) return null;
  const dist = Number.isFinite(a.dist) ? a.dist
    : Math.hypot(a.cell.x + 0.5 - ctx.eye.x, a.cell.y + 0.5 - ctx.eye.y, a.cell.z + 0.5 - ctx.eye.z);
  return dist <= reach ? a : null;
}

// A grid point kept on its world cell while the window moves over a larger
// world (docs/scaling.md D11): pinned(point, sim)() is that point in the grid
// as it is then, for a result that lands a few frames after it was asked for.
export function pinned(point, sim) {
  const p = point.clone().add(sim.origin);
  return () => p.clone().sub(sim.origin);
}

// The outward normal of a pick face (../grid.js; the tools import it from here)
export { faceNormal } from '../grid.js';

const MUZZLE_SEARCH = 16;           // cells walked along the ray by muzzleCell

// First cell along eye + t·dir that doesn't overlap the body box (feet at
// pos, BODY_WIDTH square, BODY_HEIGHT tall), by grid DDA: { cell, t, path },
// t the ray distance at which it enters that cell and path every cell from
// the eye's to it. null if none within MUZZLE_SEARCH cells or it is outside
// the grid.
// (the gun's muzzle, where a thrown bomb leaves the hand)
export function muzzleCell(eye, dir, pos, g) {
  const half = BODY_WIDTH / 2;
  const lo = [pos.x - half, pos.y, pos.z - half], hi = [pos.x + half, pos.y + BODY_HEIGHT, pos.z + half];
  const path = [];
  return voxelWalk(eye, dir, Infinity, (x, y, z, t) => {
    path.push(new THREE.Vector3(x, y, z));
    const c = [x, y, z];
    if (c.every((v, k) => v < hi[k] && v + 1 > lo[k])) return undefined;   // still inside the body
    const inGrid = x >= 0 && y >= 0 && z >= 0 && x < g.nx && y < g.ny && z < g.nz;
    return inGrid ? { cell: new THREE.Vector3(x, y, z), t, path } : null;
  }, MUZZLE_SEARCH) ?? null;
}

// Radius of a ball of n cells.
export const ballRadius = (n) => Math.cbrt((3 * n) / (4 * Math.PI));

// Held items: unlit meshes with a fixed key light baked into vertex colours
// (the scene has no lights; the volume shades itself).
const HELD_LIGHT = new THREE.Vector3(0.4, 0.8, 0.45).normalize();   // toward the key light, view space
const HELD_AMBIENT = 0.45;   // share of the base colour a face turned away from the light keeps
const HELD_DIFFUSE = 0.6;    // share added at full facing
export function heldMesh(geometry, color) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.computeVertexNormals();
  const base = new THREE.Color(color);
  const n = g.attributes.normal, cols = new Float32Array(n.count * 3), v = new THREE.Vector3();
  for (let i = 0; i < n.count; i++) {
    const k = HELD_AMBIENT + HELD_DIFFUSE * Math.max(0, v.fromBufferAttribute(n, i).dot(HELD_LIGHT));
    cols.set([base.r * k, base.g * k, base.b * k], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }));
  m.frustumCulled = false;
  return m;
}
export function recolor(mesh, color) {
  mesh.material.vertexColors = false;
  mesh.material.color.set(color);
}

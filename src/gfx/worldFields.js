// The world fields (docs/seamless-world.md, "F — fields"): the render fields as camera-centred
// clipmaps in world cells, derived from the world copy. The WGSL and the layout are
// shaders/world/fields.js's; this keeps the clips, plans each frame's work and records it.
//
//   const fields = new WorldFields(gpu, worldCopy, { copyWGSL: worldCopyWGSL, tables });
//   await fields.ready;
//   fields.prime(gpu.frame, cameraWorldCell);              // load: every level filled
//   fields.update(gpu.frame, cameraWorldCell, changes);    // each frame, before the march
//   group 2 of the march: fields.bindEntries() (FIELDS_BINDINGS)
//
// Each level keeps its clip origin (level bricks: 4 texels, 4 · 2^k cells), which snaps by whole
// bricks, and the box it holds (valid). A move shrinks valid to what the new clip still holds; the
// texels that came in hold the far side's old values until filled, and fieldPick never reads them
// (FieldClip's boxes are valid's). Each frame then, within FIELD_BRICKS_PER_FRAME:
//   1. the slabs that came in, nearest level first: valid grows by one brick layer a job, on its
//      face nearest the camera, until it is the clip (less a brick at faces inside the world)
//   2. what the world copy changed: at level 0 the EMA over every brick changed within
//      FIELD_EMA_SETTLE frames (the window's EMA set, shaders/fields.js DIRTY), the fields a brick
//      around them (FIELD_REACH); at coarse levels the texels within the blur's reach, once
// A job lists the bricks it finishes (FINAL) and every brick within one of them (the chain's reach).
// Liquids' EMA history lives in level 0's clip cells, world-keyed: a physics move doesn't touch it.
import {
  fieldClipPlan, clipOrigin, FieldClip, FIELDS_BINDINGS, FIELD_FORMATS, FIELD_MAX_LEVELS, FIELD_TRANSITION,
  FIELD_FILTER_MARGIN, FIELD_FAR, FE, packEntry, fieldWorkLayout, DERIVE_LAYOUT, worldFieldKernelWGSL, WorldFieldParams,
} from '../shaders/world/fields.js';
import { FIELD_EMA_SETTLE } from '../shaders/fields.js';
import { LAYOUT } from '../shaders/common.js';
import { CHANNELS, MEDIA } from './materials.js';
import { fieldWeights } from './fieldDeriver.js';
import { fold } from '../gpu/kernels.js';
import { WC_BRICK } from '../shaders/world/cellWord.js';

/**
 * The per-frame budget: level bricks (4³ texels) every job of a frame computes, in all (a job's
 * FINAL bricks and the ring around them). It is also the scratch's size (a slot per brick), so
 * one level-0 slab of a 128-texel clip (3 × 32 × 32 bricks with its ring) fits with room for the
 * changes. At 64 threads a brick and ~9 passes, 4096 bricks are about 2.4 M thread-passes a frame.
 */
export const FIELD_BRICKS_PER_FRAME = 4096;
/** Bricks per side of the box a level grows from when it holds nothing (a load, a teleport). */
export const FIELD_GROW_SEED = 4;
/** Jobs a frame may record (each is ~9 dispatches): a frame of small jobs stops here. */
export const FIELD_JOBS_PER_FRAME = 16;
const STAMP_MAX = 0xffff;   // the slot map's stamp is 16 bits

// ---- boxes, in level bricks, hi exclusive ----
const EMPTY = Object.freeze({ lo: [0, 0, 0], hi: [0, 0, 0] });
export const boxEmpty = (b) => b.lo.some((v, i) => v >= b.hi[i]);
export const boxMeet = (a, b) => ({ lo: a.lo.map((v, i) => Math.max(v, b.lo[i])), hi: a.hi.map((v, i) => Math.min(v, b.hi[i])) });
export const boxHas = (b, p) => p.every((v, i) => v >= b.lo[i] && v < b.hi[i]);
export const boxSame = (a, b) => (boxEmpty(a) && boxEmpty(b)) || (a.lo.every((v, i) => v === b.lo[i]) && a.hi.every((v, i) => v === b.hi[i]));
const boxGrow = (b, r) => ({ lo: b.lo.map((v) => v - r), hi: b.hi.map((v) => v + r) });
const boxCount = (b) => (boxEmpty(b) ? 0 : b.hi.reduce((n, v, i) => n * (v - b.lo[i]), 1));
function* boxCells(b) {
  if (boxEmpty(b)) return;
  for (let z = b.lo[2]; z < b.hi[2]; z++) for (let y = b.lo[1]; y < b.hi[1]; y++) for (let x = b.lo[0]; x < b.hi[0]; x++) yield [x, y, z];
}
const boxDist = (b, p) => Math.max(...p.map((v, i) => Math.max(b.lo[i] - v, v - (b.hi[i] - 1), 0)));

/**
 * The world copy's changes as boxes of world cells ({ lo, hi }, hi exclusive), from what
 * WorldCopy.changesSince hands back: an array of boxes or { boxes }, each box { lo, hi },
 * { min, max } or [x0, y0, z0, x1, y1, z1].
 */
export function normalizeChanges(changes) {
  if (!changes) return [];
  const list = Array.isArray(changes) ? changes : changes.boxes ?? [];
  return list.map((c) => (Array.isArray(c) ? { lo: c.slice(0, 3), hi: c.slice(3, 6) } : { lo: c.lo ?? c.min, hi: c.hi ?? c.max }));
}

/** One level's clip: where it is, what it holds, what is pending. Pure CPU (tools/world-fields-cpu-check.mjs drives it). */
export class ClipLevel {
  constructor(level, layout) {
    Object.assign(this, { level, layout, origin: null, valid: EMPTY });
    this.world = { lo: [0, 0, 0], hi: level.worldBricks };
    this.active = new Map();   // level 0: key → [b, last frame changed] (the EMA set)
    this.dirty = new Map();    // coarse: key → b (texels to redo)
  }
  key(b) {
    const { cb, rbMax } = this.layout, rb = this.level.clipBricks[1];
    return (b[0] % cb) + cb * ((b[1] % rb) + rbMax * (b[2] % cb));
  }
  get clip() { return { lo: this.origin, hi: this.origin.map((v, i) => v + this.level.clipBricks[i]) }; }
  // the clip, less a brick on each face inside the world (the chain's ring), in the world
  get usable() {
    const c = this.clip;
    return boxMeet({ lo: c.lo.map((v) => (v > 0 ? v + 1 : v)), hi: c.hi.map((v, i) => (v < this.level.worldBricks[i] ? v - 1 : v)) }, this.world);
  }
  get complete() { return boxSame(this.valid, this.usable); }
  setCamera(cam) {
    const o = clipOrigin(this.level, cam);
    if (this.origin && o.every((v, i) => v === this.origin[i])) return false;
    this.origin = o;
    this.valid = boxMeet(this.valid, this.usable);
    if (boxEmpty(this.valid)) this.valid = EMPTY;
    return true;
  }
  camBrick(cam) { return cam.map((v, i) => Math.floor(v / this.level.s / WC_BRICK)); }
  // the next layer to fill: the seed around the camera, or valid's face nearest it
  nextLayer(cam) {
    const U = this.usable, V = this.valid, c = this.camBrick(cam);
    if (boxEmpty(U) || this.complete) return null;
    if (boxEmpty(V)) {
      const lo = c.map((v, i) => Math.max(U.lo[i], Math.min(U.hi[i] - FIELD_GROW_SEED, v - (FIELD_GROW_SEED >> 1))));
      return boxMeet({ lo, hi: lo.map((v) => v + FIELD_GROW_SEED) }, U);
    }
    let best = null, bestD = Infinity;
    for (let i = 0; i < 3; i++) {
      for (const side of [0, 1]) {
        if (side ? V.hi[i] >= U.hi[i] : V.lo[i] <= U.lo[i]) continue;
        const lo = [...V.lo], hi = [...V.hi];
        if (side) { lo[i] = V.hi[i]; hi[i] = V.hi[i] + 1; } else { hi[i] = V.lo[i]; lo[i] = V.lo[i] - 1; }
        const layer = { lo, hi }, d = boxDist(layer, c);
        if (d < bestD) { best = layer; bestD = d; }
      }
    }
    return best;
  }
  // valid after a layer is filled (a seed, or a face layer: a box either way)
  take(layer) {
    const V = this.valid;
    this.valid = boxEmpty(V) ? layer : { lo: V.lo.map((v, i) => Math.min(v, layer.lo[i])), hi: V.hi.map((v, i) => Math.max(v, layer.hi[i])) };
  }
}

// A job's entries: each brick once (by the clip's key), its flags or'ed.
class JobBuilder {
  constructor(clip) { this.clip = clip; this.at = new Map(); this.bricks = []; this.flags = []; }
  get count() { return this.bricks.length; }
  add(b, flags) {
    const C = this.clip;
    if (!boxHas(C.clip, b) || !boxHas(C.world, b)) return;
    const k = C.key(b);
    let i = this.at.get(k);
    if (i === undefined) { this.at.set(k, i = this.bricks.length); this.bricks.push(b); this.flags.push(0); }
    this.flags[i] |= flags;
  }
  entries() { return Uint32Array.from(this.bricks, (b, i) => packEntry(b, this.flags[i])); }
}

/**
 * Plans a frame (pure CPU): the clips follow the camera, the changes are noted, and the jobs are
 * chosen within the budget. Returns [{ level, entries: Uint32Array, final: number }].
 */
export function planFrame(levels, { frame, cam, changes = [], budget = FIELD_BRICKS_PER_FRAME, maxJobs = FIELD_JOBS_PER_FRAME }) {
  for (const L of levels) L.setCamera(cam);
  // the changes: level 0's EMA set, the coarse levels' texels within the blur's reach (2 texels)
  for (const box of changes) {
    for (const L of levels) {
      const s = L.level.s, r = L.level.k ? 2 : 0;
      const lo = box.lo.map((v) => Math.floor((Math.floor(v / s) - r) / WC_BRICK));
      const hi = box.hi.map((v) => Math.floor((Math.ceil(v / s) + r - 1) / WC_BRICK) + 1);
      for (const b of boxCells(boxMeet({ lo, hi }, boxMeet(L.clip, L.world)))) {
        if (L.level.k === 0) L.active.set(L.key(b), [b, frame]);
        else L.dirty.set(L.key(b), b);
      }
    }
  }
  const jobs = [];
  let left = budget;
  const push = (L, job) => {
    jobs.push({ level: L.level, entries: job.entries(), final: job.flags.filter((f) => f & FE.FINAL).length });
    left -= job.count;
  };
  // 1. the slabs, nearest level first
  for (const L of levels) {
    for (;;) {
      if (jobs.length >= maxJobs) return jobs;
      const layer = L.nextLayer(cam);
      if (!layer) break;
      const ring = boxMeet(boxGrow(layer, 1), boxMeet(L.clip, L.world));
      if (boxCount(ring) > left) break;
      const job = new JobBuilder(L), V = L.valid, stale = L.level.k === 0 ? FE.EMA | FE.FRESH : 0;
      for (const b of boxCells(ring)) job.add(b, (boxHas(layer, b) ? FE.FINAL : 0) | (boxHas(V, b) ? 0 : stale));
      L.take(layer);
      // (a brick that came in has no change pending: what changed there before is in what it reads now)
      for (const b of boxCells(layer)) { L.active.delete(L.key(b)); L.dirty.delete(L.key(b)); }
      push(L, job);
    }
  }
  // 2. the changes: level 0's EMA set (nearest first), then the coarse levels'
  for (const L of levels) {
    if (jobs.length >= maxJobs) break;
    const V = L.valid, U = L.usable, c = L.camBrick(cam), coarse = L.level.k > 0;
    const set = coarse ? L.dirty : L.active;
    const todo = [];
    for (const [k, v] of set) {
      const b = coarse ? v : v[0];
      // settled, or never to be finished here (outside the usable box: the margin, gone past)
      if ((!coarse && frame - v[1] >= FIELD_EMA_SETTLE) || !boxHas(U, b)) { set.delete(k); continue; }
      if (!boxHas(V, b)) continue;   // (a slab still to come computes it from what is there then)
      todo.push([boxDist({ lo: b, hi: b.map((x) => x + 1) }, c), k, b]);
    }
    todo.sort((a, b) => a[0] - b[0]);
    // Level 0: the EMA over the set, the fields over a brick around it (FIELD_REACH is a brick),
    // their ring a brick further; a brick outside valid holds no history: it starts at its targets.
    // A coarse level: the dirty brick (its texels already cover the blur's reach), its ring.
    const reach = coarse ? 1 : 2, need = (2 * reach + 1) ** 3, job = new JobBuilder(L);
    for (const [, k, b] of todo) {
      if (left - job.count < need) break;
      for (let dz = -reach; dz <= reach; dz++) for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const q = [b[0] + dx, b[1] + dy, b[2] + dz], d = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)), inV = boxHas(V, q);
        let flags = d <= reach - 1 && inV ? FE.FINAL : 0;
        if (!coarse) flags |= (d === 0 ? FE.EMA : 0) | (inV ? 0 : FE.EMA | FE.FRESH);
        job.add(q, flags);
      }
      if (coarse) set.delete(k);
    }
    if (job.count) push(L, job);
  }
  return jobs;
}

/** FieldClip's values for the levels as they are (what the march may read). */
export function fieldClipValues(plan, levels, world) {
  const band = [], lo = [], hi = [];
  for (let k = 0; k < FIELD_MAX_LEVELS; k++) {
    const L = levels[k];
    if (!L) { band.push([0, 1, 1, 0]); lo.push([FIELD_FAR, FIELD_FAR, FIELD_FAR, 1]); hi.push([-FIELD_FAR, -FIELD_FAR, -FIELD_FAR, 0]); continue; }
    const { s, rows, band: row, worldBricks } = L.level, V = L.valid, cells = WC_BRICK * s, m = FIELD_FILTER_MARGIN * s;
    band.push([row, rows, s, 0]);
    const width = FIELD_TRANSITION * plan.texels * s;
    if (boxEmpty(V)) { lo.push([FIELD_FAR, FIELD_FAR, FIELD_FAR, width]); hi.push([-FIELD_FAR, -FIELD_FAR, -FIELD_FAR, 0]); continue; }
    lo.push([...V.lo.map((v) => (v <= 0 ? -FIELD_FAR : v * cells + m)), width]);
    hi.push([...V.hi.map((v, i) => (v >= worldBricks[i] ? FIELD_FAR : v * cells - m)), 0]);
  }
  return { world: [...world, levels.length], band, lo, hi };
}

export class WorldFields {
  /**
   * @param {object} gpu
   * @param {object} worldCopy W's WorldCopy: its layout and bindGroup (group 1), size and changesSince
   * @param {{ copyWGSL?: string, size?: number[], tables?: GPUBindGroup, tablesLayout?: GPUBindGroupLayout,
   *   smoothing?: number, budget?: number, texels?: number, rows?: number }} [opts]
   *   copyWGSL: W's worldCopyWGSL (src/shaders/world/copy.js); tables: the element tables' group
   *   (sim.tables, LAYOUT.TABLES)
   */
  constructor(gpu, worldCopy, opts = {}) {
    // W's WGSL and the element tables' group: opts, the world copy, or set once on the class
    // (WorldFields.copyWGSL = worldCopyWGSL), so (gpu, worldCopy) is enough once wired
    const { copyWGSL = worldCopy?.wgsl ?? worldCopy?.copyWGSL ?? WorldFields.copyWGSL, size = worldCopy?.size,
      tables = worldCopy?.tables ?? gpu.tables ?? null, smoothing = 1, budget = FIELD_BRICKS_PER_FRAME, texels, rows } = opts;
    if (!copyWGSL) throw new Error('WorldFields: no world copy WGSL (WorldFields.copyWGSL = shaders/world/copy.js worldCopyWGSL)');
    if (!size) throw new Error('WorldFields: no world size (worldCopy.size)');
    Object.assign(this, { gpu, worldCopy, tables, smoothing, budget, size: [...size] });
    const plan = (this.plan = fieldClipPlan(this.size, { texels, rows }));
    const lay = (this.layout = fieldWorkLayout(plan, budget));
    this.levels = plan.levels.map((l) => new ClipLevel(l, lay));
    this.frameNo = 0;
    this.stamp = 0;
    this.rev = 0;   // the world copy's revision our changes run to (changesSince)
    this._flushes = undefined;
    const T = GPUTextureUsage, U = GPUBufferUsage, S = plan.texels;
    const tex = (name, rowsOf) => gpu.createTexture({ label: `world field ${name}`, size: [S, rowsOf, S], dimension: '3d',
      format: FIELD_FORMATS[name], usage: T.TEXTURE_BINDING | T.STORAGE_BINDING | T.COPY_SRC });
    this.textures = { tFS: tex('tFS', plan.rows), tFM: tex('tFM', plan.rows), tFT: tex('tFT', plan.thinRows) };
    this.views = Object.fromEntries(Object.entries(this.textures).map(([k, t]) => [k, t.createView({ dimension: '3d' })]));
    this.sampler = gpu.device.createSampler({ label: 'wrapLinear', magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
    this.fc = gpu.createBuffer({ label: 'world field clip (FC)', size: FieldClip.size, usage: U.UNIFORM | U.COPY_DST });
    this.book = gpu.createBuffer({ label: 'world field book', size: lay.book.words * 4, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC });
    this.work = gpu.createBuffer({ label: 'world field work', size: lay.work.words * 4, usage: U.STORAGE | U.COPY_SRC });
    const L = gpu.layout('WORLD_FIELDS_DERIVE', DERIVE_LAYOUT);
    this.group = gpu.bindGroup(L, [
      { binding: 0, resource: { buffer: this.book } }, { binding: 1, resource: { buffer: this.work } },
      { binding: 2, resource: this.views.tFS }, { binding: 3, resource: this.views.tFM }, { binding: 4, resource: this.views.tFT },
    ], 'world fields derive');
    const layouts = [opts.tablesLayout ?? gpu.layout('TABLES', LAYOUT.TABLES), worldCopy?.layout ?? gpu.L.EMPTY, L];
    this.kernels = Object.fromEntries(['slots', 'gather0', 'gather', 'blur', 'blurFinal', 'boost0', 'boost', 'peak', 'store'].map((st) => [st,
      gpu.kernel({ name: `worldField ${st}`, code: worldFieldKernelWGSL(st, { plan, cap: budget, copyWGSL }), layouts,
        params: WorldFieldParams, workgroupSize: [64, 1, 1] })]));
    this.ready = Promise.all(Object.values(this.kernels).map((k) => k.ready)).then(() => this);
    this.stats = { jobs: 0, bricks: 0 };
  }

  /** The level a pixel footprint (cells per pixel) reads: fieldLevelFor's JS twin, without the blend. */
  levelFor(footprintCells) { return Math.max(0, Math.min(this.levels.length - 1, Math.floor(Math.log2(Math.max(footprintCells, 1e-6))))); }

  /** Starts every level over (a new smoothing, a reset): the next frames refill them. */
  reset({ smoothing = this.smoothing } = {}) {
    this.smoothing = smoothing;
    for (const L of this.levels) { L.valid = EMPTY; L.active.clear(); L.dirty.clear(); }
  }

  /**
   * One frame's work, before the march: the clips follow the camera, then the slabs that came in
   * and the changed bricks, within the budget.
   * @param {object} frame gpu.frame
   * @param {number[]} cameraWorldCell the camera, in world cells
   * @param {*} [changes] world-cell boxes changed since the last call (normalizeChanges); by
   *   default the world copy's changesSince(this.rev)
   */
  update(frame, cameraWorldCell, changes = undefined) {
    cameraWorldCell = Array.isArray(cameraWorldCell) ? cameraWorldCell : [cameraWorldCell.x, cameraWorldCell.y, cameraWorldCell.z];
    if (changes === undefined && this.worldCopy?.changesSince) {
      const got = this.worldCopy.changesSince(this.rev);
      this.rev = got?.rev ?? this.worldCopy.rev ?? this.rev;
      changes = got;
    }
    this.frameNo++;
    const jobs = planFrame(this.levels, { frame: this.frameNo, cam: cameraWorldCell, changes: normalizeChanges(changes), budget: this.budget });
    this._record(frame, jobs);
    this._writeClip();
    return jobs;
  }

  /** Fills every level around the camera (a load): update until each holds its whole clip. */
  prime(frame, cameraWorldCell, { maxFrames = 4096 } = {}) {
    for (let i = 0; i < maxFrames; i++) {
      this.update(frame, cameraWorldCell, []);
      if (this.levels.every((L) => L.complete)) return i + 1;
    }
    throw new Error('WorldFields.prime: the levels never filled');
  }

  // a write lands before the commands not yet submitted: ordered unless ours were since flushed
  _write(buffer, offset, data) {
    const flushes = this.gpu.stats?.flushes;
    const ordered = this._flushes !== undefined && flushes === this._flushes;
    if (this.gpu.write) this.gpu.write(buffer, offset, data, { ordered });
    else this.gpu.queue.writeBuffer(buffer, offset, data);
  }

  _writeClip() {
    this._write(this.fc, 0, new Uint8Array(FieldClip.pack(fieldClipValues(this.plan, this.levels, this.size))));
    this._flushes = this.gpu.stats?.flushes;
  }

  _record(frame, jobs) {
    if (!jobs.length) return;
    const all = new Uint32Array(jobs.reduce((n, j) => n + j.entries.length, 0));
    let base = 0;
    for (const j of jobs) { j.base = base; all.set(j.entries, base); base += j.entries.length; }
    this._write(this.book, 0, all);
    const { w, bulk, s } = fieldWeights(this.smoothing);
    const k = this.kernels, bind = [this.tables, this.worldCopy?.bindGroup ?? this.gpu.emptyGroup, this.group];
    for (const j of jobs) {
      if (++this.stamp > STAMP_MAX) { this.stamp = 1; frame.clear(this.book, this.layout.book.map * 4, this.layout.slotMap * 4); }
      const n = j.entries.length, lv = j.level;
      const params = { w, bulk, sm: s, emaS: CHANNELS.map((c) => c.ema), emaM: MEDIA.map((m) => m.ema), world: [...this.size, 0],
        band: [lv.band, lv.rows, lv.s, lv.k], count: n, base: j.base, stamp: this.stamp, axis: 0, reset: 0 };
      const run = (kernel, size, extra = {}) => kernel.dispatch(frame, size, { bind, params: { ...params, ...extra } });
      run(k.slots, fold(Math.ceil(n / 64)));
      const per = fold(n);
      run(lv.k ? k.gather : k.gather0, per);
      run(k.blur, per, { axis: 0 });
      run(k.blur, per, { axis: 1 });
      run(k.blurFinal, per, { axis: 2 });
      if (lv.k === 0) {
        run(k.boost0, per, { axis: 0 });
        run(k.boost, per, { axis: 1 });
        run(k.boost, per, { axis: 2 });
        run(k.peak, per);
      } else run(k.store, per);
      this.stats.jobs++;
      this.stats.bricks += n;
    }
  }

  /** Group 2's entries for FIELDS_BINDINGS (the march's group: shaders/world/bindings.js). */
  bindEntries() {
    const r = { tFS: this.views.tFS, tFM: this.views.tFM, tFT: this.views.tFT, wrapLinear: this.sampler, FC: { buffer: this.fc } };
    return FIELDS_BINDINGS.map(([binding, name]) => ({ binding, resource: r[name] }));
  }

  /** Bytes held: the three textures, the book and the work buffer. */
  memory() {
    const px = { rgba16float: 8, rgba8unorm: 4 }, S = this.plan.texels;
    const t = { tFS: this.plan.rows, tFM: this.plan.rows, tFT: this.plan.thinRows };
    const textures = Object.entries(t).reduce((n, [k, r]) => n + S * r * S * px[FIELD_FORMATS[k]], 0);
    return { textures, book: this.layout.book.words * 4, work: this.layout.work.words * 4,
      total: textures + (this.layout.book.words + this.layout.work.words) * 4 + FieldClip.size };
  }

  dispose() {
    for (const x of [...Object.values(this.textures), this.fc, this.book, this.work]) x?.destroy();
  }
}

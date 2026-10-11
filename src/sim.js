import {
  BRICK, SEED_MAX, TILE, SUPER, SUPER_TEX, SUPER_CELLS, LAYOUT, STATE_OPTS, gridDims, atlasDims, sleepUnitOf,
  marksLayout, actLayout, ACT_COUNTS, ACT_MAP, tablesBuffer, cellSlot, slotCell, brickIdOf, brickCoordOf,
  editKernelWGSL, EDIT_FIELDS, EDIT_SCRATCH_BINDING,
} from './shaders/common.js';
import {
  activityPeriod, inertListFrag, inertFrag, quietFrag, drawnFrag, move1Frag, argsFrag, permuteFrag, inertRefFrag,
  BuildParams, BUILD_LAYOUT, REF_LAYOUT, ARGS, ARGS_BYTES, COUNTS_SLOTS, COUNTS_BYTES, inertFold, SUPER_SETTLE_STEPS,
} from './shaders/activity.js';
import { moveBlockFrag, MoveParams, MOVE_LAYOUT, marginBlocks, MOVE_FORM } from './shaders/move.js';
import { reactFrag, ReactParams, REACT_LAYOUT, FACES } from './shaders/react.js';
import {
  paintUpdateWGSL, PaintParams, freshFrag, copyFrag, toAtlasFrag, fromAtlasFrag, ConvertParams, CONVERT_LAYOUT, awakeFrag, AwakeParams,
} from './shaders/passes.js';
import { shiftFrag, undoShiftFrag, flowShiftFrag, ShiftParams, UNDO_LAYOUT, FLOW_SHIFT_LAYOUT } from './shaders/window.js';
import { stateLayout } from './shaders/common.js';
import { uniformStruct } from './gpu/params.js';
import { fold } from './gpu/kernels.js';

// The simulation on the GPU (docs/webgpu.md C, D): the state buffers, the
// step (the move in place, then react: shaders/move.js, react.js), the
// activity map that puts quiet bricks to sleep (shaders/activity.js), the
// writers that aren't steps (edits, loads, undo, shifts) and every read back.
// Everything records into the one open frame (gpu.frame, B3); nothing here
// submits or waits, and every read is a promise (W6).
//
//   const sim = new Simulation(gpu, 128, 128, 128);
//   await sim.ready;               // its pipelines (built asynchronously, B5)
//   sim.paint({ center, radius, shape: 0, tool: E.SAND, rate: 1, replace: false });
//   sim.step();
//   const [A, B] = await sim.readState();   // atlas order (cellTexel), as load() takes
//
// The derived passes (render fields, the brick map, light, GI) are
// src/derived.js's (docs/webgpu.md E): sim.attachDerived(d) and the
// delegating methods below. Fast particles and whitewater plug in the same
// way (attachRays, attachAeration; J3).

// cells/step² downward (the app's gravity setting overrides it)
const GRAVITY_DEFAULT = 0.025;

// Steps an activity map stays valid (shaders/activity.js).
const ACTIVITY_PERIOD = activityPeriod(BRICK);

// Cells added around a box of cell centres in the box an edit covers
// (touchCentres(): the brush, the first-person body and physgun): the centres
// sit half a cell off the grid, so this covers them with room.
const TOUCH_MARGIN = 1;

// Undo snapshots kept, at most (each is the current A and B: ~67 MB at 128³).
const UNDO_LIMIT = 3;

// Share of each update's new GI probes blended into the probe volume (the rest
// is history): smooths cells popping between bricks over a few frames. Each
// probe is updated every other frame. (The GI is src/derived.js's, U9; the
// number stays here for the modules that import it.)
export const GI_BLEND = 0.4;

export function gridLayout(nx, ny, nz) {
  const d = gridDims({ nx, ny, nz });
  const at = atlasDims(d);
  // render-field and brick atlases (WebGL; tools still size readbacks by them until their units port them)
  const ftx = Math.ceil(Math.sqrt((ny * nz) / nx));
  const fty = Math.ceil(ny / ftx);
  const btx = Math.ceil(Math.sqrt((d.by * d.bz) / d.bx));
  const bty = Math.ceil(d.by / btx);
  return {
    nx, ny, nz, stx: d.stx, sty: d.sty, stz: d.stz, stw: at.stw, ftx, btx, bty,
    width: at.width, height: at.height,
    fwidth: ftx * nx, fheight: fty * nz,
    bwidth: btx * d.bx, bheight: bty * d.bz,
    maxSteps: nx + ny + nz + 8,
    // the WebGPU layout (docs/webgpu.md C2)
    bx: d.bx, by: d.by, bz: d.bz, slots: d.slots, nbricks: d.nbricks, nsuper: d.nsuper,
  };
}

// JS mirror of the atlas order (docs/webgpu.md C2: the CPU's order, readState
// and load): the index of cell (x, y, z)'s texel in a width × height state
// texture (× 4 for its RGBA floats), and back ([x, y, z], or null for a texel
// past the last supertile, which holds no cell).
export function cellTexel(g, x, y, z) {
  const bx = Math.floor(x / BRICK), by = Math.floor(y / BRICK), bz = Math.floor(z / BRICK);   // brick
  const sx = Math.floor(bx / SUPER.x), sy = Math.floor(by / SUPER.y), sz = Math.floor(bz / SUPER.z);   // supertile
  const i = sx + g.stx * (sz + g.stz * sy);   // supertile number
  const ly = y - by * BRICK;
  const u = (i % g.stw) * SUPER_TEX + (bx - sx * SUPER.x) * TILE + (x - bx * BRICK) + BRICK * (ly & 1);
  const v = Math.floor(i / g.stw) * SUPER_TEX + (bz - sz * SUPER.z + SUPER.z * (by - sy * SUPER.y)) * TILE
    + (z - bz * BRICK) + BRICK * (ly >> 1);
  return v * g.width + u;
}
export function texelCell(g, t) {
  const u = t % g.width, v = Math.floor(t / g.width);
  const su = Math.floor(u / SUPER_TEX), sv = Math.floor(v / SUPER_TEX);   // supertile slot
  const i = su + g.stw * sv;
  if (i >= g.stx * g.sty * g.stz) return null;
  const sx = i % g.stx, sz = Math.floor(i / g.stx) % g.stz, sy = Math.floor(i / (g.stx * g.stz));
  const tu = u - su * SUPER_TEX, tv = v - sv * SUPER_TEX;   // texel in the supertile
  const ku = Math.floor(tu / TILE), kv = Math.floor(tv / TILE);   // brick tile
  const lu = tu - ku * TILE, lv = tv - kv * TILE;           // texel in the tile
  return [
    (sx * SUPER.x + ku) * BRICK + (lu % BRICK),
    (sy * SUPER.y + Math.floor(kv / SUPER.z)) * BRICK + (Math.floor(lu / BRICK) | (Math.floor(lv / BRICK) << 1)),
    (sz * SUPER.z + (kv % SUPER.z)) * BRICK + (lv % BRICK),
  ];
}
// The slot order (docs/webgpu.md C2): cell (x, y, z)'s place in the state
// buffers, and back (shaders/common.js mirrors brickId, slotOf, cellOf).
export { cellSlot, slotCell };

// WEBGPU-STUB (docs/webgpu.md J3): the brick atlas is gone (brick buffers run in brickId order).
export function brickTexel() { throw new Error('brickTexel removed in the WebGPU port: docs/webgpu.md C2 (brickId)'); }
// WEBGPU-STUB (docs/webgpu.md J3)
export function makeFieldTarget() { throw new Error('makeFieldTarget removed in the WebGPU port: docs/webgpu.md C7 (gpu.createBuffer, gpu.createTexture)'); }
// WEBGPU-STUB (docs/webgpu.md J3)
export function rawMat() { throw new Error('rawMat removed in the WebGPU port: docs/webgpu.md C7 (gpu.kernel, sim.editKernel)'); }
// WEBGPU-STUB (docs/webgpu.md J3): the reaction lookup is in the element tables (shaders/common.js rxAt).
export function reactionTexture() { throw new Error('reactionTexture removed in the WebGPU port: docs/webgpu.md C6'); }

// The window's place in the world (docs/scaling.md D11): a grid cell's world
// cell is origin + the cell. The few Vector3 methods its readers use, so sim
// code doesn't import three.
export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  equals(v) { return this.x === v.x && this.y === v.y && this.z === v.z; }
  fromArray(a, o = 0) { this.x = a[o]; this.y = a[o + 1]; this.z = a[o + 2]; return this; }
  toArray(a = [], o = 0) { a[o] = this.x; a[o + 1] = this.y; a[o + 2] = this.z; return a; }
}

// The rays layer while nothing is attached (docs/webgpu.md J3: src/wire/rays.js
// attaches the real one, U12): never active.
const NO_RAYS = Object.freeze({
  active: false, stepped: false, bricks: null, deposit: null,
  step() {}, settle() {}, paint() { return false; }, noteElement() {}, reset() {}, wake() {}, dispose() {},
});

let nextSimId = 0;

// The bind group layouts the simulation's kernels use, named in gpu.L (C4).
function simLayouts(gpu) {
  const L = {};
  for (const [name, entries] of Object.entries({
    TABLES: LAYOUT.TABLES, STATE_RW: LAYOUT.STATE_RW, STATE_RO: LAYOUT.STATE_RO, STATE_ACT: LAYOUT.STATE_ACT,
    STATE_BUILD: LAYOUT.STATE_BUILD, STATE_FLAGS_RO: stateLayout({ state: 'read', flags: true }),
    MOVE: MOVE_LAYOUT, REACT: REACT_LAYOUT, BUILD: BUILD_LAYOUT, REF: REF_LAYOUT, CONVERT: CONVERT_LAYOUT,
    UNDO: UNDO_LAYOUT, FLOW_SHIFT: FLOW_SHIFT_LAYOUT,
    EDIT_SCRATCH: [{ binding: EDIT_SCRATCH_BINDING, buffer: { type: 'storage' } }],
  })) L[name] = gpu.layout(name, entries);
  return L;
}

// The element tables' buffer (C6): one per device, made on first use.
function tablesOf(gpu) {
  if (!gpu._simTables) {
    const bytes = tablesBuffer();
    const buffer = gpu.createBuffer({ label: 'tables', size: Math.ceil(bytes.byteLength / 16) * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    gpu.queue.writeBuffer(buffer, 0, bytes);
    gpu._simTables = { buffer, group: gpu.bindGroup(simLayouts(gpu).TABLES, [{ binding: 0, resource: { buffer } }], 'tables') };
  }
  return gpu._simTables;
}

// GPU simulation driver: owns the state buffers and records the passes.
export class Simulation {
  /**
   * @param {object} gpu the gpu from src/gpu/device.js createGpu
   * @param {number} nx
   * @param {number} ny
   * @param {number} nz
   * @param {{ windowed?: boolean, world?: number[], sleepUnit?: {x: number, y: number, z: number}, debug?: boolean, form?: string }} [opts]
   *   windowed: the grid is a window of a larger world (docs/scaling.md D11);
   *   world: that world's size (the GI's far layout, src/derived.js);
   *   sleepUnit: the sleeping unit in bricks (shaders/common.js SLEEP_UNIT; SUPER for an A/B);
   *   debug: every state access tests its cell and counts misses (readDebug; I2.8)
   */
  constructor(gpu, nx, ny, nz, { windowed = false, world = null, sleepUnit = null, debug = gpu.debug, form = MOVE_FORM } = {}) {
    this.gpu = gpu;
    this.id = nextSimId++;   // tells a rebuilt simulation from the old one
    this.g = gridLayout(nx, ny, nz);
    const g = this.g;
    if (sleepUnit) g.sleepUnit = sleepUnit;
    this.unit = sleepUnitOf(g);
    this.g.windowed = windowed;   // a window of a larger world
    this.world = world;           // the world size whose far layout the GI holds (src/derived.js)
    this.debug = Boolean(debug);
    if (!gpu.fits(g)) throw new Error(`grid ${nx}×${ny}×${nz}: ${gpu.fitsReason(g)}`);
    this.frame = 0;
    this.paints = 0;   // brush strokes applied (the brush's random stream)
    this.idleEpoch = 0;
    this.idleCertified = false;
    this.idleRead = null;   // at most one asynchronous read of the activity counts
    this.gravity = GRAVITY_DEFAULT;
    // bumped by every write to the state (steps, edits, loads, undo, network
    // updates), so callers can tell when the world changed
    this.version = 0;
    // The grid is a window of the world (docs/scaling.md D11): origin is the
    // world cell of grid cell (0, 0, 0), every dispatch's header (B4). A grid
    // that is its whole world stays at 0; shift() moves it.
    this.origin = new Vec3();
    this.originUniform = { value: this.origin };   // (for the render setup until it reads the header)
    // fast particles and whitewater (attachRays, attachAeration), the derived passes (attachDerived)
    this.rays = NO_RAYS;
    this.aeration = null;
    this.derived = null;
    // profiling hook (gfx/profiler.js): onPass(name, { kind, gpuMs }) after every dispatch
    this.onPass = null;
    // test knobs (docs/webgpu.md C7, I2); test mode only
    //   logCounts: every build's counts go through the ring, into countsLog
    //   ({ frame, counts: Promise<ArrayBuffer> }: nAWAKE, nDRAWN, nMOVE1, nINERT), for budget-check
    this.test = { listOrder: null, blockOrder: null, raceProbe: false, syncAfterShift: false, logCounts: false };
    this.countsLog = [];
    this._shiftListeners = [];
    this._retired = [];

    // ---- buffers (docs/webgpu.md C1) ----
    const S = GPUBufferUsage.STORAGE, CS = GPUBufferUsage.COPY_SRC, CD = GPUBufferUsage.COPY_DST;
    const buf = (label, size, usage = S | CS | CD) => gpu.createBuffer({ label: `sim${this.id} ${label}`, size: Math.max(16, Math.ceil(size / 16) * 16), usage });
    const slots = g.slots;
    this.cur = 0;
    const A = buf('A', 2 * slots * 16), B = buf('B', 2 * slots * 16), F = buf('F', 2 * slots * 4);
    this.flow = buf('flow', slots * 8);
    this.moveSrc = buf('moveSrc (none)', 16);
    this.marks = buf('marks', marksLayout(g).words * 4);
    this.actLayout = actLayout(g);
    this.act = buf('act', this.actLayout.words * 4);
    this.args = buf('args', ARGS_BYTES, S | CS | CD | GPUBufferUsage.INDIRECT);
    // dummies for the rays layer's deposit and brick bits while none is attached
    this.noDeposit = buf('rays deposit (none)', 16);
    this.noRayBricks = buf('rays bricks (none)', 16);
    const sim = this;
    this.state = {
      A, B, F, flow: this.flow, slots,
      get cur() { return sim.cur; },
    };
    // the INERT dispatch's y and z stay 1 (its x is the inertList kernel's)
    const argsInit = new Uint32Array(ARGS_BYTES / 4);
    argsInit[1] = argsInit[2] = 1;
    gpu.queue.writeBuffer(this.args, 0, argsInit);
    // the activity counts' ring (B7): a slot per build whose counts are read
    this.counts = gpu.readback.ring(`sim${this.id} counts`, COUNTS_BYTES, COUNTS_SLOTS, { buffer: this.args, offset: ARGS.RING });

    // ---- bind groups, made once (B6) ----
    const L = (this.L = simLayouts(gpu));
    this.tables = tablesOf(gpu).group;
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    this.bindRW = gpu.bindGroup(L.STATE_RW, [b(0, A), b(1, B), b(2, F), b(3, this.marks), b(4, this.act)], 'state rw');
    this.bindRO = gpu.bindGroup(L.STATE_RO, [b(0, A), b(1, B)], 'state ro');
    this.bindAct = gpu.bindGroup(L.STATE_ACT, [b(0, A), b(1, B), b(4, this.act)], 'state act');
    this.bindBuild = gpu.bindGroup(L.STATE_BUILD, [b(0, A), b(1, B), b(2, F), b(3, this.marks), b(4, this.act)], 'state build');
    this.bindFlagsRO = gpu.bindGroup(L.STATE_FLAGS_RO, [b(0, A), b(1, B), b(2, F)], 'state flags ro');
    this._groups();

    // ---- kernels (B5): built now, asynchronously; sim.ready resolves when they are ----
    const dbg = { debug: this.debug };
    const kernel = (name, code, layouts, params, extra = {}) => gpu.kernel({ name, code, layouts: [this.L.TABLES, ...layouts], params, ...extra });
    const build = (name, frag) => kernel(name, frag(g), [L.STATE_BUILD, L.BUILD], BuildParams);
    this.kernels = {
      move: kernel('move', moveBlockFrag(g, { form, ...dbg }), [L.STATE_RW, L.MOVE], MoveParams),
      react: kernel('react', reactFrag(g, dbg), [L.STATE_RW, L.REACT], ReactParams),
      inertList: build('inertList', inertListFrag),
      inert: kernel('inert', inertFrag(g, dbg), [L.STATE_BUILD], BuildParams),
      quiet: build('quiet', quietFrag),
      drawn: build('drawn', drawnFrag),
      move1: build('move1', move1Frag),
      args: build('args', argsFrag),
    };
    // the simulation's other passes (docs/webgpu.md D6, D7, C2): built now too,
    // so a write never waits; the tools' kernels on first use (passOf)
    this.passes = {
      paint: this.editKernel('paint', { update: paintUpdateWGSL, params: PaintParams, reads: 'own' }),
      fresh: kernel('fresh', freshFrag(g, dbg), [L.STATE_RW]),
      copy: kernel('copy', copyFrag(g, dbg), [L.STATE_RW]),
      toAtlas: kernel('toAtlas', toAtlasFrag(g), [L.STATE_FLAGS_RO, L.CONVERT], ConvertParams),
      fromAtlas: kernel('fromAtlas', fromAtlasFrag(g, dbg), [L.STATE_RW, L.CONVERT], ConvertParams),
      undoShift: kernel('undoShift', undoShiftFrag(g, dbg), [L.STATE_RW, L.UNDO], ShiftParams),
      awake: kernel('awake', awakeFrag(g), [L.STATE_BUILD], AwakeParams),
    };
    this._lazy = {
      inertRef: () => kernel('inertRef', inertRefFrag(g), [L.STATE_RO, L.REF]),
      permute: () => build('permute', permuteFrag),
      moveRace: () => kernel('moveRace', moveBlockFrag(g, { form, ...dbg, raceProbe: true }), [L.STATE_RW, L.MOVE], MoveParams),
      shift: () => kernel('shift', shiftFrag(g, dbg), [L.STATE_RW], ShiftParams),
      flowShift: () => kernel('flowShift', flowShiftFrag(g), [gpu.L.EMPTY, L.FLOW_SHIFT], ShiftParams),
    };
    // a window of a larger world moves: its shift kernels are built now too
    if (windowed) { this.passOf('shift'); this.passOf('flowShift'); }
    // (the state starts blank once they are: load() needs its kernel)
    this.ready = Promise.all([...Object.values(this.kernels), ...Object.values(this.passes)].map((k) => k.ready))
      .then(() => { if (!this.disposed && this.version === 0) this.clear(); return this; });

    // ---- activity (docs/webgpu.md D4, D5) ----
    this.actAge = ACTIVITY_PERIOD;
    this.actDirty = true;
    this.actFresh = false;   // the next step is the first since a map was built (its dirty marks start over)
    this.actSteps = 0;       // steps that used the current map
    this.actFull = true;     // the next map rebuilds every brick's inert bit (not only near the last DRAWN and marks)
    this.forceAll = true;    // every unit was written since the last map: the next map draws them all
    this._skipQuiet = true;      // false: step every brick (A/B testing)
    this._skipSleeping = true;   // false: every unit DRAWN (A/B testing)
    // the derived passes' bookkeeping (src/derived.js reads and resets these)
    this.changedAll = true;  // every brick changed since the derived passes last ran
    this.actCarry = null;    // actAge at the last updateBricks while that quiet map is current
    this.actNoted = false;   // `changed` holds a quiet map noted since the last updateBricks
    this.incremental = true; // false: the derived passes rebuild every brick (A/B testing)
    this.smoothing = 1;
    this.fieldReset = true;
    this.giReset = true;
    this.shiftKeepsHistory = true;   // false: a shift starts the derived history over (A/B)
    this.history = [];
  }

  // The group-2 bind groups that hold attachable resources (rays, aeration).
  _groups() {
    const { gpu, L } = this;
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    this.moveGroup = gpu.bindGroup(L.MOVE, [b(0, this.flow), b(1, this.moveSrc)], 'move');
    this.reactGroup = gpu.bindGroup(L.REACT, [b(0, this.rays.deposit ?? this.noDeposit)], 'react');
    this.buildGroup = gpu.bindGroup(L.BUILD, [b(0, this.args), b(1, this.rays.bricks ?? this.noRayBricks)], 'build');
  }

  // A tool's kernel, made on first use; recording it needs it ready (prepare).
  passOf(name) { return (this.passes[name] ??= this._lazy[name]()); }

  /**
   * Builds kernels the simulation makes only on demand: 'inertRef',
   * 'permute' (sim.test.listOrder), 'moveRace' (sim.test.raceProbe), 'shift'
   * and 'flowShift' (a grid made without `windowed`). Resolves when they are
   * ready to record.
   * @param {...string} names
   */
  prepare(...names) { return Promise.all(names.map((n) => this.passOf(n).ready)); }

  // Settings can change while asleep (including away and back during a readback).
  get gravity() { return this._gravity; }
  set gravity(v) { if (v !== this._gravity) { this._gravity = v; this.wake(); } }
  get skipQuiet() { return this._skipQuiet; }
  set skipQuiet(v) { if (v !== this._skipQuiet) { this._skipQuiet = v; this.actFull = true; this.wake(); } }
  get skipSleeping() { return this._skipSleeping; }
  set skipSleeping(v) { if (v !== this._skipSleeping) { this._skipSleeping = v; this.wake(); } }

  wake() {
    this.idleEpoch++;
    this.idleCertified = false;
    this.actDirty = true;
  }

  /**
   * The header a dispatch on this grid gets (docs/webgpu.md B4): the window's
   * origin and the state copies it reads and writes (both the current one by
   * default: an edit's).
   */
  header(src = this.cur, dst = src) {
    return { origin: [this.origin.x, this.origin.y, this.origin.z], src, dst };
  }

  // Records a dispatch into the frame's compute pass and tells the profiler.
  _dispatch(kernel, size, opts) {
    kernel.dispatch(this.gpu.frame, size, opts);
    this.onPass?.(kernel.name, { kind: 'compute', gpuMs: null });
  }

  // ---- the activity map (docs/webgpu.md D4) ----

  // A zero AWAKE and DRAWN count certifies not just quiet cells, but that the
  // last maps settled both state copies of every unit. Steps cannot wake this
  // state themselves. External writes and settings invalidate even a late
  // result (the epoch); ordinary steps and map rebuilds need not (a map built
  // from the same state is the same fixed point), so a slow read can finish.
  _wantIdleRead() {
    return !this.idleRead && !this.idleCertified && this.skipQuiet && this.skipSleeping && !this.rays.active && !this.disposed;
  }

  _readIdle(slot) {
    const epoch = this.idleEpoch;
    this.idleRead = this.counts.read(slot).then((bytes) => {
      const [awake, drawn] = new Uint32Array(bytes);
      if (!this.disposed && epoch === this.idleEpoch && awake === 0 && drawn === 0) this.idleCertified = true;
    }).catch(() => {})   // a failed read only disables this optimization; keep stepping
      .finally(() => { this.idleRead = null; });
  }

  // Rebuild the activity map: six dispatches in the step's compute pass, one
  // of them indirect (docs/webgpu.md D4).
  updateActivity() {
    const g = this.g;
    // the outgoing map, if steps used it since the last updateBricks noted it
    const carry = this.actCarry !== null && this.actAge > this.actCarry;
    this.actCarry = null;
    const read = this._wantIdleRead();
    const order = this.gpu.testMode ? this.test.listOrder : null;
    const log = this.gpu.testMode && this.test.logCounts;
    const params = {
      full: this.actFull, enabled: this.skipQuiet, rays: this.rays.active, carry, noted: this.actNoted,
      forceAll: this.forceAll, nPrev: this.actSteps, all: !this.skipSleeping, slot: 0,
    };
    const bind = [this.tables, this.bindBuild, this.buildGroup];
    const header = this.header();
    const perBrick = fold(Math.ceil(g.nbricks / 64)), perUnit = fold(Math.ceil(this.unit.units / 64));
    const { inertList, inert, quiet, drawn, move1, args } = this.kernels;
    this._dispatch(inertList, perBrick, { bind, header, params });
    if (order) this._permute(ACT_COUNTS.INERT, order);
    this._dispatch(inert, { indirect: this.args, offset: ARGS.INERT }, { bind: [this.tables, this.bindBuild], header, params });
    this._dispatch(quiet, perBrick, { bind, header, params });
    this._dispatch(drawn, perUnit, { bind, header, params });
    this._dispatch(move1, perUnit, { bind, header, params });
    // the counts go to a ring slot when the idle check reads them, else to the spare one
    const slot = read || log ? this.counts.next() : COUNTS_SLOTS;
    this._dispatch(args, [1, 1, 1], { bind, header, params: { ...params, slot: (ARGS.RING + slot * COUNTS_BYTES) / 4 } });
    if (order) {
      this._permute(ACT_COUNTS.DRAWN, order);
      this._permute(ACT_COUNTS.MOVE1, order);
    }
    this.actNoted = true;   // the quiet kernel noted the new map in `changed` (the step about to run uses it)
    this.actAge = 0;
    this.actDirty = false;
    this.actFresh = true;
    this.actFull = false;
    this.forceAll = false;
    this.actSteps = 0;
    if (read) this._readIdle(slot);
    if (log) this.countsLog.push({ frame: this.frame, counts: this.counts.read(slot) });
  }

  // Test only (I2.1): reorders a list in place ('reverse' or 'shuffle:<seed>').
  _permute(list, order) {
    const [kind, seed] = String(order).split(':');
    const mode = kind === 'reverse' ? 1 : kind === 'shuffle' ? 2 : 0;
    if (!mode) throw new Error(`sim.test.listOrder: 'reverse' or 'shuffle:<seed>', not ${order}`);
    this._dispatch(this.passOf('permute'), [1, 1, 1], {
      bind: [this.tables, this.bindBuild, this.buildGroup], header: this.header(),
      params: { list, order: mode, seed: (Number(seed) || 0) + this.frame },
    });
  }

  // The bricks the current quiet map doesn't skip may change: note them in
  // `changed`, over what it holds unless it was consumed since (the derived
  // passes' updateDirty carry, docs/webgpu.md D4, E).
  noteAwake() {
    this._dispatch(this.passes.awake, fold(Math.ceil(this.g.nbricks / 64)), {
      bind: [this.tables, this.bindBuild], header: this.header(), params: { noted: this.actNoted },
    });
    this.actNoted = true;
  }

  // ---- the step (docs/webgpu.md D1) ----

  step() {
    const f = this.gpu.frame;   // (throws GraphicsFailure once graphics have stopped)
    this.frame++;   // simulation time and parity advance even when there is nothing to step
    // Certified idle: every unit settled in both copies, no unit AWAKE or DRAWN,
    // and that's a fixed point until something writes (docs/webgpu.md D4).
    if (this.idleCertified && !this.actDirty && !this.actFresh && this.actSteps >= SUPER_SETTLE_STEPS
        && this.skipQuiet && this.skipSleeping && !this.rays.active) {
      this.aeration?.idle?.(f);   // nothing moves, but the foam left on it still bursts
      return;
    }
    // particles fly first: the map below keeps the bricks they're in awake
    if (this.rays.active) this.rays.step(f);
    if (this.actDirty || this.actAge >= ACTIVITY_PERIOD) this.updateActivity();
    this.actAge++;
    this.actSteps++;
    const parity = this.frame & 1;
    const fresh = this.actFresh;
    this.actFresh = false;
    const outOfPlace = Boolean(this.aeration?.active);
    const cur = this.cur, other = 1 - cur;
    const testing = this.gpu.testMode;
    const move = testing && this.test.raceProbe ? this.passOf('moveRace') : this.kernels.move;
    const mp = {
      frame: this.frame, parity, gravity: this.gravity, fresh, outOfPlace, margin: 0,
      blockRev: testing && this.test.blockOrder === 'reverse', eight: 8,
    };
    // the move: in place (or into the other copy, for whitewater), over the
    // offset's list, then at offset 1 the low margin's blocks
    const mh = this.header(cur, outOfPlace ? other : cur);
    const mb = [this.tables, this.bindRW, this.moveGroup];
    this._dispatch(move, { indirect: this.args, offset: parity ? ARGS.MOVE1 : ARGS.MOVE0 }, { bind: mb, header: mh, params: mp });
    if (parity) this._dispatch(move, fold(Math.ceil(marginBlocks(this.g) / 64)), { bind: mb, header: mh, params: { ...mp, margin: 1 } });
    // whitewater's field follows the move (gfx/foam.js): it reads the copy from before it
    if (outOfPlace) this.aeration.step(f, { pre: cur, post: other, moveSrc: this.moveSrc });
    // react, from the moved state into the other copy
    const rh = outOfPlace ? this.header(other, cur) : this.header(cur, other);
    this._dispatch(this.kernels.react, { indirect: this.args, offset: ARGS.REACT }, {
      bind: [this.tables, this.bindRW, this.reactGroup], header: rh,
      params: { frame: this.frame, gravity: this.gravity, faces: FACES, rays: Boolean(this.rays.stepped) },
    });
    if (!outOfPlace) this.cur = other;
    if (this.rays.active) this.rays.settle(f);
    this.version += 2;   // (the move and react: as the WebGL build counted its two state passes)
  }

  // ---- writers that aren't steps (docs/webgpu.md D6) ----

  /**
   * A box writer's kernel (docs/webgpu.md D6): every cell of a box gets
   * update(p, a, b, oA, oB) (WGSL), stored with the flags writtenFlags leaves,
   * and the bricks it changed are marked for the activity map and the derived
   * passes. One per kind of writer and grid (pipelines are cached by source).
   * @param {string} name
   * @param {{ update: string, params?: object, reads?: 'own' | 'neighbours', decls?: string, layout?: GPUBindGroupLayoutEntry[] }} desc
   *   params  a uniformStruct whose first fields are EDIT_FIELDS, or its other
   *           fields ({ name: type }), which get EDIT_FIELDS put first
   *   reads   'own': in place; 'neighbours': update reads other cells, so it
   *           runs into a scratch first and a second dispatch stores it (two-phase)
   *   decls   WGSL declarations the update needs (its group-2 bindings, helpers)
   *   layout  those group-2 bindings' layout entries (bind them with edit's opts.bind)
   * @returns {{ name: string, params: object, reads: string, main: object, apply: object | null, layout: GPUBindGroupLayout | null, ready: Promise<unknown> }}
   */
  editKernel(name, { update, params = {}, reads = 'own', decls = '', layout = null }) {
    const struct = params.isStruct ? params : uniformStruct(`${name[0].toUpperCase()}${name.slice(1)}Params`, { ...EDIT_FIELDS, ...params });
    const code = editKernelWGSL(this.g, { update, params: struct, reads, decls, debug: this.debug });
    let entries = layout ?? [];
    if (reads === 'neighbours') entries = [...entries, { binding: EDIT_SCRATCH_BINDING, buffer: { type: 'storage' } }];
    const group2 = entries.length ? this.gpu.layout(`edit ${name} ${JSON.stringify(entries)}`, entries) : null;
    const layouts = [this.L.TABLES, this.L.STATE_RW, ...(group2 ? [group2] : [])];
    const main = this.gpu.kernel({ name, code, layouts, params: struct, workgroupSize: [4, 4, 4] });
    const apply = reads === 'neighbours' ? this.gpu.kernel({ name: `${name} apply`, code, entry: 'apply', layouts, params: struct, workgroupSize: [4, 4, 4] }) : null;
    return {
      name, params: struct, reads, main, apply, layout: group2, extra: layout ?? [],
      ready: Promise.all([main.ready, apply?.ready]),
    };
  }

  // The box [lo, hi] (inclusive grid cells) clipped to the grid, or null if empty.
  _clip(lo, hi) {
    const n = [this.g.nx, this.g.ny, this.g.nz];
    const a = lo.map((x, k) => Math.max(0, Math.floor(x)));
    const b = hi.map((x, k) => Math.min(n[k] - 1, Math.floor(x)));
    return a.every((x, k) => x <= b[k]) ? [a, b] : null;
  }

  /**
   * One edit: a dispatch of `kernel` over the box, in call order, so the next
   * edit sees this one's result (docs/webgpu.md D6). Writes the current copy;
   * the GPU marks the bricks it changes.
   * @param {ReturnType<Simulation['editKernel']>} kernel
   * @param {{ lo: number[], hi: number[] }} box inclusive grid cells (clipped to the grid)
   * @param {object} [values] the params' other fields
   * @param {{ bind?: GPUBindGroup[] }} [opts] the kernel's own group-2 resources (its layout's bindings, in order)
   */
  edit(kernel, { lo, hi }, values = {}, { bind = [] } = {}) {
    const f = this.gpu.frame;
    const box = this._clip(lo, hi);
    if (!box) return;
    const [a, b] = box;
    const nb = [0, 1, 2].map((k) => (b[k] >> 2) - (a[k] >> 2) + 1);
    const size = fold(nb[0] * nb[1] * nb[2]);
    const params = { ...values, editLo: a, editHi: b };
    let group2 = null;
    if (kernel.layout) {
      const entries = kernel.extra.map((e, i) => ({ binding: e.binding, resource: bind[i] }));
      if (kernel.reads === 'neighbours') {
        const bytes = nb[0] * nb[1] * nb[2] * 64 * 32;
        entries.push({ binding: EDIT_SCRATCH_BINDING, resource: { buffer: this._editScratch(bytes) } });
      }
      group2 = this.gpu.bindGroup(kernel.layout, entries, `${kernel.name} group`);
    }
    const groups = [this.tables, this.bindRW, ...(group2 ? [group2] : [])];
    const header = this.header();
    this._dispatch(kernel.main, size, { bind: groups, header, params });
    if (kernel.apply) this._dispatch(kernel.apply, size, { bind: groups, header, params });
    void f;
    this.version++;
    this.wake();   // the next step rebuilds the map: the marked bricks are forced
  }

  // The two-phase edits' scratch (two vec4f per cell of the brick-aligned
  // box), grown as needed; a buffer it outgrew is destroyed after the frames
  // that may hold it are done.
  _editScratch(bytes) {
    if (!this.editScratch || this.editScratch.size < bytes) {
      if (this.editScratch) this._retire(this.editScratch);
      this.editScratch = this.gpu.createBuffer({ label: `sim${this.id} edit scratch`, size: Math.max(bytes, 64 * 32), usage: GPUBufferUsage.STORAGE });
    }
    return this.editScratch;
  }

  _retire(buffer) {
    this.gpu.fence().then(() => buffer.destroy(), () => {});
  }

  // The box an edit covers for a write that changes only cells whose centres
  // lie in [lo, hi] (grid cells, any reals; [x, y, z] arrays): { lo, hi }.
  touchCentres(lo, hi) {
    return { lo: lo.map((x) => Math.floor(x) - TOUCH_MARGIN), hi: hi.map((x) => Math.floor(x) + TOUCH_MARGIN) };
  }
  // (kept for callers that declared boxes before their pass: marking is the GPU's now, D6)
  touch(lo, hi) { return { lo, hi }; }

  paint({ center, radius, shape, tool, rate, replace }) {
    // particle tools paint into the particle list, not the grid
    if (this.rays.paint({ center, radius, shape, tool, rate })) return;
    this.rays.noteElement(tool);   // plutonium emits neutrons: the layer wakes
    // Its own random stream: this.frame counts steps only. The move pass
    // alternates its block partition by the step count's parity, so a paint
    // bumping it would lock the partition when one step runs per paint (Speed
    // 1 while painting: poured matter could never leave its 2×2×2 block); the
    // POV body and the media drift clock also read it as steps taken.
    this.paints++;
    const c = [center.x, center.y, center.z];
    this.edit(this.passes.paint, this.touchCentres(c.map((x) => x - radius), c.map((x) => x + radius)), {
      center: c, radius, shape, tool, rate, replace: Boolean(replace), frame: this.paints,
    });
  }

  /**
   * A whole-grid write that isn't a step (a load, an undo, the codec's unpack):
   * the next map rebuilds every inert bit and draws every unit, and the
   * derived passes rebuild every brick.
   */
  noteWrite() {
    this.version++;
    this.forceAll = true;
    this.actFull = true;
    this.changedAll = true;
    this.wake();
  }

  // Upload CPU-built state (Float32Array RGBA per atlas texel: cellTexel)
  // into the current copy, with fresh flags (docs/webgpu.md C2).
  load(dataA, dataB) {
    const { width, height } = this.g, texels = width * height;
    const scratch = this._atlasScratch();
    this.gpu.write(scratch, 0, dataA.subarray(0, texels * 4));
    this.gpu.write(scratch, texels * 16, dataB.subarray(0, texels * 4), { ordered: false });
    this._dispatch(this.passes.fromAtlas, fold(Math.ceil(this.g.slots / 64)), {
      bind: [this.tables, this.bindRW, this._convertGroup], header: this.header(),
    });
    this.noteWrite();
    this.fieldReset = true;
    this.giReset = true;
    this.stillFlow();
    this.rays.reset();   // a new state: the old particles go, and it may hold plutonium
  }

  clear() {
    this.load(...this.blankState());
  }

  // The atlas-order scratch (load, readState, readCopies): A then B, or flags.
  _atlasScratch() {
    if (!this.atlasScratch) {
      const texels = this.g.width * this.g.height;
      this.atlasScratch = this.gpu.createBuffer({
        label: `sim${this.id} atlas scratch`, size: texels * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
      this._convertGroup = this.gpu.bindGroup(this.L.CONVERT, [{ binding: 0, resource: { buffer: this.atlasScratch } }], 'atlas scratch');
    }
    return this.atlasScratch;
  }

  // Copy the current state into the other copy, so both hold it (tools; after
  // a shift and its fill nothing needs it: docs/webgpu.md D6). An exact copy of
  // A, B and F keeps the sleeping invariant, so it forces nothing. (One
  // dispatch: WebGPU copies no range of a buffer into another range of it.)
  syncCopies() {
    this._dispatch(this.passes.copy, fold(Math.ceil(this.g.slots / 64)), {
      bind: [this.tables, this.bindRW], header: this.header(this.cur, 1 - this.cur),
    });
  }

  // ---- undo history: GPU copies of the state, newest last ----
  // Each snapshot is the current A and B (~67 MB at 128³), so keep only a few.
  // Each remembers the window's origin it was taken at (t.origin): after the
  // window moves (docs/scaling.md D11) it still holds the cells where they were.
  snapshot(limit = UNDO_LIMIT) {
    const f = this.gpu.frame, bytes = this.g.slots * 16, { A, B } = this.state;
    let t = this.history.length >= limit ? this.history.shift() : null;
    if (!t) {
      const mk = (n) => this.gpu.createBuffer({ label: `sim${this.id} undo ${n}`, size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      t = { A: mk('A'), B: mk('B') };
      t.group = this.gpu.bindGroup(this.L.UNDO, [{ binding: 0, resource: { buffer: t.A } }, { binding: 1, resource: { buffer: t.B } }], 'undo snapshot');
    }
    f.copy(A, this.cur * bytes, t.A, 0, bytes);
    f.copy(B, this.cur * bytes, t.B, 0, bytes);
    t.origin = this.origin.clone();
    t.note = null;   // the app's tag for what undoing this takes back besides cells (app.js: a shrine's orbs)
    this.history.push(t);
  }

  get canUndo() { return this.history.length > 0; }

  // Grid cells [dx, dz] the window moved since the newest snapshot was taken, or null without one.
  get undoShift() {
    const t = this.history.at(-1);
    return t ? [this.origin.x - t.origin.x, this.origin.z - t.origin.z] : null;
  }

  // Bring the newest snapshot back. Taken before the window moved, it brings
  // back the cells the old and the new window share, and the rest keep what
  // they hold now (the cells that left the window are stored edits, out of
  // its reach). If the two don't overlap at all it does nothing and keeps the
  // snapshot for when the window comes back: returns false then, and when
  // there is none.
  undo() {
    const t = this.history.at(-1);
    if (!t) return false;
    const [dx, dz] = this.undoShift;
    if (Math.abs(dx) >= this.g.nx || Math.abs(dz) >= this.g.nz) return false;
    this.history.pop();
    this._dispatch(this.passes.undoShift, fold(Math.ceil(this.g.slots / 64)), {
      bind: [this.tables, this.bindRW, t.group], header: this.header(), params: { shift: [dx, 0, dz] },
    });
    this.noteWrite();
    this.stillFlow();
    this.rays.wake();   // it may bring plutonium back
    this._retire(t.A);
    this._retire(t.B);
    return true;
  }

  // Forget the undo snapshots (they hold a window that has moved or been replaced).
  dropHistory() {
    for (const t of this.history) { this._retire(t.A); this._retire(t.B); }
    this.history = [];
  }

  // The state was replaced: nothing is moving until the next step says so.
  stillFlow() {
    this.gpu.frame.clear(this.flow);
    this.aeration?.reset?.(this.gpu.frame);
  }

  /**
   * Whole-grid shift kernels registered by the derived passes and whitewater
   * (docs/webgpu.md E: every shift kernel runs out of place, D8.12): fn(dx, dz, frame).
   * @param {(dx: number, dz: number, f: object) => void} fn
   */
  onShift(fn) { this._shiftListeners.push(fn); return () => { this._shiftListeners = this._shiftListeners.filter((x) => x !== fn); }; }

  // Move the window over the world (docs/scaling.md D11) by (dx, 0, dz) world
  // cells, whole supertiles: cell p takes the state of p + (dx, 0, dz), so the
  // content moves the other way and stays put in the world. Cells shifted in
  // from outside are still air until the caller fills them (world/window.js:
  // the generator, then stored edits, both edits over the slab). Out of place,
  // into the other copy with fresh flags; the next map draws every unit
  // (forceAll), so its first step's react rewrites the other copy before
  // anything reads it and no syncCopies is needed (docs/webgpu.md D6, G1). The
  // flow field moves with the cells; the derived passes and whitewater move
  // their own (onShift). Undo snapshots keep the window where they were taken
  // (undo maps them across).
  shift(dx, dz) {
    if (dx % SUPER_CELLS.x || dz % SUPER_CELLS.z) {
      throw new Error(`shift ${dx}, ${dz}: must be whole supertiles (${SUPER_CELLS.x} × ${SUPER_CELLS.z} cells)`);
    }
    const f = this.gpu.frame, size = fold(Math.ceil(this.g.slots / 64)), shift = [dx, 0, dz];
    this._dispatch(this.passOf('shift'), size, { bind: [this.tables, this.bindRW], header: this.header(this.cur, 1 - this.cur), params: { shift } });
    this.cur = 1 - this.cur;
    // the flow field: into a scratch, then back
    this.flowTmp ??= this.gpu.createBuffer({ label: `sim${this.id} flow shift`, size: this.flow.size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this._flowShiftGroup ??= this.gpu.bindGroup(this.L.FLOW_SHIFT, [
      { binding: 0, resource: { buffer: this.flow } }, { binding: 1, resource: { buffer: this.flowTmp } }], 'flow shift');
    this._dispatch(this.passOf('flowShift'), size, { bind: [this.tables, this.gpu.emptyGroup, this._flowShiftGroup], params: { shift } });
    f.copy(this.flowTmp, 0, this.flow, 0, this.flow.size);
    this.origin.x += dx;
    this.origin.z += dz;
    for (const fn of this._shiftListeners) fn(dx, dz, f);
    if (!this.shiftKeepsHistory) {
      this.fieldReset = this.giReset = true;
      this.stillFlow();
    }
    this.rays.reset();   // particles are in grid cells: v1 lets them go (docs/particles.md)
    this.version++;
    this.forceAll = true;
    this.actFull = true;
    this.wake();
  }

  /**
   * A shift kernel for a field of two words per slot (the flow field's; whitewater
   * shifts its aeration halves with it): records src → dst shifted by (dx, 0, dz).
   * @param {GPUBindGroup} group L.FLOW_SHIFT: src (read) at 0, dst (read_write) at 1
   */
  shiftField(group, dx, dz) {
    this._dispatch(this.passOf('flowShift'), fold(Math.ceil(this.g.slots / 64)), {
      bind: [this.tables, this.gpu.emptyGroup, group], params: { shift: [dx, 0, dz] },
    });
  }

  blankState() {
    const g = this.g;
    const a = new Float32Array(g.width * g.height * 4);
    const b = new Float32Array(g.width * g.height * 4);
    for (let i = 0; i < g.width * g.height; i++) a[i * 4 + 1] = 20;
    // One seed per texel of the Y-slice field atlas, in its row order, padding
    // included: the state atlas's order before it went brick-major, so a
    // seeded Math.random (tools/regress.mjs) still gives each cell its seed.
    for (let fy = 0; fy < g.fheight; fy++) {
      const row = Math.floor(fy / g.nz), z = fy - row * g.nz;
      for (let col = 0; col < g.ftx; col++) {
        const y = row * g.ftx + col;
        for (let x = 0; x < g.nx; x++) {
          const seed = Math.random() * SEED_MAX;
          if (y < g.ny) a[cellTexel(g, x, y, z) * 4 + 3] = seed;
        }
      }
    }
    return [a, b];
  }

  // ---- reads (all asynchronous: docs/webgpu.md W6, B7) ----

  // Index of cell (x, y, z)'s texel in the atlas-order arrays, and back (cellTexel, texelCell).
  cellTexel(x, y, z) { return cellTexel(this.g, x, y, z); }
  texelCell(i) { return texelCell(this.g, i); }

  // Records the conversion of copy `c` (A and B, or with flags its F) into the scratch.
  _toAtlas(c, flags) {
    this._atlasScratch();
    this._dispatch(this.passes.toAtlas, fold(Math.ceil(this.g.slots / 64)), {
      bind: [this.tables, this.bindFlagsRO, this._convertGroup], header: this.header(c), params: { flags },
    });
  }

  /**
   * The current state as it is at this call, as float RGBA per atlas texel in
   * the fetchA/fetchB layout (what load() takes): [A, B]. For CPU checks and
   * tools; cellTexel finds a cell in it.
   * @returns {Promise<[Float32Array, Float32Array]>}
   */
  async readState() {
    const texels = this.g.width * this.g.height;
    this._toAtlas(this.cur, false);
    const bytes = await this.gpu.readback.buffer(this.atlasScratch, 0, texels * 32);
    return [new Float32Array(bytes, 0, texels * 4), new Float32Array(bytes, texels * 16, texels * 4)];
  }

  /**
   * Both state copies as they are at this call, atlas order, flags included
   * (tools/state-hash.mjs's copies line): { A: [copy0, copy1], B: […], F: […] }.
   */
  async readCopies() {
    const texels = this.g.width * this.g.height, rb = this.gpu.readback;
    const reads = [];
    for (const c of [0, 1]) {
      this._toAtlas(c, false);
      reads.push(rb.buffer(this.atlasScratch, 0, texels * 32));
      this._toAtlas(c, true);
      reads.push(rb.buffer(this.atlasScratch, 0, texels * 4));
    }
    const [ab0, f0, ab1, f1] = await Promise.all(reads);
    const ab = (x, k) => new Float32Array(x, k * texels * 16, texels * 4);
    return { A: [ab(ab0, 0), ab(ab1, 0)], B: [ab(ab0, 1), ab(ab1, 1)], F: [new Uint32Array(f0), new Uint32Array(f1)] };
  }

  /**
   * One cell of the current state as it is at this call: [a, b] in the
   * fetchA/fetchB layout. For tests and tools.
   * @returns {Promise<[Float32Array, Float32Array]>}
   */
  async readCell(x, y, z) {
    const s = cellSlot(this.g, x, y, z), at = (this.cur * this.g.slots + s) * 16, rb = this.gpu.readback;
    const [a, b] = await Promise.all([rb.buffer(this.state.A, at, 16), rb.buffer(this.state.B, at, 16)]);
    return [new Float32Array(a), new Float32Array(b)];
  }

  // Resolves when the GPU has done everything recorded so far (wall-clock timing of GPU work).
  gpuSync() { return this.gpu.fence(); }

  /**
   * The flow field as it is at this call: half-float words (x, y, z, 0) per
   * atlas texel, as the WebGL build's RGBA16F target held it.
   * @returns {Promise<Uint16Array>}
   */
  async readFlow() {
    const g = this.g, words = new Uint16Array(await this.gpu.readback.buffer(this.flow, 0, g.slots * 8));
    const out = new Uint16Array(g.width * g.height * 4);
    for (let s = 0; s < g.slots; s++) {
      const [x, y, z] = slotCell(g, s);
      out.set(words.subarray(s * 4, s * 4 + 4), cellTexel(g, x, y, z) * 4);
    }
    return out;
  }

  /**
   * The activity maps as they are at this call, a byte per brick in brick
   * coordinates (bx + BX·(by + BY·bz)): inert, quiet, and its unit's AWAKE
   * and DRAWN (docs/webgpu.md C2; tools only).
   * @returns {Promise<{ inert: Uint8Array, quiet: Uint8Array, awake: Uint8Array, drawn: Uint8Array, run: Uint8Array }>}
   */
  async readMaps() {
    const g = this.g, L = this.actLayout, n = g.nbricks;
    const w = new Uint32Array(await this.gpu.readback.buffer(this.act, 0, L.aerSeen * 4));
    const out = { inert: new Uint8Array(n), quiet: new Uint8Array(n), awake: new Uint8Array(n), drawn: new Uint8Array(n), run: new Uint8Array(n) };
    for (let id = 0; id < n; id++) {
      const [bx, by, bz] = brickCoordOf(g, id);
      const i = bx + g.bx * (by + g.by * bz);
      const m = w[L.map + Math.floor(id / this.unit.bricks)];
      out.inert[i] = w[L.inert + id];
      out.quiet[i] = w[L.quiet + id];
      out.awake[i] = m & ACT_MAP.AWAKE ? 1 : 0;
      out.drawn[i] = m & ACT_MAP.DRAWN ? 1 : 0;
      out.run[i] = m >>> ACT_MAP.RUN_SHIFT;
    }
    return out;
  }

  /**
   * The current map's list lengths (units AWAKE, DRAWN, MOVE1; bricks the
   * inert kernel redid), as they are at this call.
   * @returns {Promise<{ awake: number, drawn: number, move1: number, inert: number, units: number }>}
   */
  async readCounts() {
    const c = new Uint32Array(await this.gpu.readback.buffer(this.act, this.actLayout.count * 4, 32));
    return { awake: c[ACT_COUNTS.AWAKE], drawn: c[ACT_COUNTS.DRAWN], move1: c[ACT_COUNTS.MOVE1], inert: c[ACT_COUNTS.INERT], units: this.unit.units };
  }

  /**
   * The inert map built from the state alone (shaders/activity.js
   * inertRefFrag: the reference tools/activity-check.mjs compares the
   * incremental build with), a byte per brick in brick coordinates: of the
   * state at this call once its kernel is built (sim.prepare('inertRef')), else
   * of the state when it is.
   * @returns {Promise<Uint8Array>}
   */
  async inertRef() {
    const g = this.g;
    if (!this.refInert) {
      this.refInert = this.gpu.createBuffer({ label: `sim${this.id} inert ref`, size: g.nbricks * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      this._refGroup = this.gpu.bindGroup(this.L.REF, [{ binding: 0, resource: { buffer: this.refInert } }], 'inert ref');
    }
    const k = this.passOf('inertRef');
    if (k.state !== 'ready') await k.ready;   // (once prepared, it records at the call, as the other reads do)
    this._dispatch(k, fold(g.nbricks), { bind: [this.tables, this.bindRO, this._refGroup], header: this.header() });
    const w = new Uint32Array(await this.gpu.readback.buffer(this.refInert, 0, g.nbricks * 4));
    const out = new Uint8Array(g.nbricks);
    for (let id = 0; id < g.nbricks; id++) {
      const [bx, by, bz] = brickCoordOf(g, id);
      out[bx + g.bx * (by + g.by * bz)] = w[id];
    }
    return out;
  }

  /** The debug prelude's count of out-of-grid accesses (I2.8; 0 without debug). */
  async readDebug() {
    const at = marksLayout(this.g).dbg * 4;
    return new Uint32Array(await this.gpu.readback.buffer(this.marks, at, 4))[0];
  }

  /**
   * A read-only probe (docs/webgpu.md D6): `kernel` writes its result into a
   * slot of `ring` (a gpu.readback.ring, its buffer bound in the kernel's own
   * groups), whose index it gets in its params as `slot`.
   * @returns {Promise<ArrayBuffer>}
   */
  probe(kernel, size, { ring, bind = [], params = {} }) {
    const slot = ring.next();
    this._dispatch(kernel, size, { bind, header: this.header(), params: { ...params, slot } });
    return ring.read(slot);
  }

  // Debug: read the full state back and summarise it per element.
  async census() {
    const { nx, ny, nz } = this.g;
    const [a] = await this.readState();
    const out = {};
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
          const i = this.cellTexel(x, y, z) * 4;
          const id = Math.round(a[i]);
          const o = (out[id] ??= { n: 0, T: 0, minY: 1e9, maxY: -1, Tmax: -1e9 });
          o.n++; o.T += a[i + 1]; o.minY = Math.min(o.minY, y); o.maxY = Math.max(o.maxY, y); o.Tmax = Math.max(o.Tmax, a[i + 1]);
        }
    for (const k in out) out[k].T = +(out[k].T / out[k].n).toFixed(1);
    return out;
  }

  // ---- what plugs in (docs/webgpu.md C7, J3) ----

  /**
   * The rays layer (raysLayer.js, U12): { active, stepped, step(f), settle(f),
   * bricks (a GPUBuffer bitset: a bit per brick), deposit (two i32 per slot),
   * paint(), noteElement(), reset(), wake() }. null detaches it.
   */
  attachRays(rays) {
    this.rays = rays ?? NO_RAYS;
    this._groups();
    this.wake();
  }

  /**
   * Whitewater's aeration field (gfx/foam.js, U12): { active, step(f, { pre,
   * post, moveSrc }), idle(f), reset(f) }. While active the move runs out of
   * place and records moveSrc.
   */
  attachAeration(aer) {
    this.aeration = aer ?? null;
    const want = aer ? this.g.slots * 4 : 16;
    if (this.moveSrc.size < want || (!aer && this.moveSrc.size > 16)) {
      this._retire(this.moveSrc);
      this.moveSrc = this.gpu.createBuffer({ label: `sim${this.id} moveSrc`, size: want, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      this._groups();
    }
  }

  /** The derived passes (src/derived.js, U4): fields, bricks, light, GI. */
  attachDerived(derived) { this.derived = derived ?? null; }

  // Delegated to src/derived.js (docs/webgpu.md C7, E): nothing to do until one is attached.
  updateBricks(...args) { return this.derived?.updateBricks(...args); }
  updateGI(...args) { return this.derived?.updateGI(...args); }
  resetGI() { this.giReset = true; return this.derived?.resetGI?.(); }
  get fieldSurf() { return this.derived?.fieldSurf ?? null; }
  get fieldMedia() { return this.derived?.fieldMedia ?? null; }
  get fieldThin() { return this.derived?.fieldThin ?? null; }
  get light() { return this.derived?.light ?? null; }
  get brick() { return this.derived?.brick ?? null; }
  get brickDist() { return this.derived?.brickDist ?? null; }
  get giTextures() { return this.derived?.giTextures ?? null; }
  get flowTexture() { return this.flow; }

  // WEBGPU-STUB (docs/webgpu.md J3): passes are dispatches (gpu.kernel, sim.edit).
  run() { throw new Error('sim.run removed in the WebGPU port: docs/webgpu.md C7 (gpu.kernel, sim.edit)'); }
  // WEBGPU-STUB (docs/webgpu.md J3)
  pass() { throw new Error('sim.pass removed in the WebGPU port: docs/webgpu.md D6 (sim.edit)'); }
  // WEBGPU-STUB (docs/webgpu.md J3)
  makeStateTarget() { throw new Error('sim.makeStateTarget removed in the WebGPU port: docs/webgpu.md C7'); }
  // WEBGPU-STUB (docs/webgpu.md J3): the state is sim.state's buffers.
  get stateA() { throw new Error('sim.stateA removed in the WebGPU port: docs/webgpu.md C7 (sim.state, sim.bindRO)'); }
  // WEBGPU-STUB (docs/webgpu.md J3)
  get stateB() { throw new Error('sim.stateB removed in the WebGPU port: docs/webgpu.md C7 (sim.state, sim.bindRO)'); }
  // WEBGPU-STUB (docs/webgpu.md J3)
  get stateF() { throw new Error('sim.stateF removed in the WebGPU port: docs/webgpu.md C7 (sim.state, sim.bindRW)'); }

  dispose() {
    this.disposed = true;
    this.wake();   // an outstanding readback cannot certify a disposed simulation
    const { A, B, F } = this.state;
    for (const b of [A, B, F, this.flow, this.moveSrc, this.marks, this.act, this.args, this.noDeposit, this.noRayBricks,
      this.flowTmp, this.atlasScratch, this.editScratch, this.refInert]) b?.destroy();
    this.counts.close();
    for (const t of this.history) { t.A.destroy(); t.B.destroy(); }
    this.history = [];
  }
}

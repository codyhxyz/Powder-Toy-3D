import { routeNativePaint, prepareNativeBrush } from './v2/interactions.js';
import { resetNativeDynamics } from './v2/dynamicState.js';
import { nativeHostTick } from './v2/host.js';
import { emitNativeRay, nativeRayKind } from './v2/tools.js';
import { NativeIntegration, nativeCapabilities } from './v2/integration.js';
import { nativeRectToAtlasWGSL } from './v2/nativeRead.js';
import {
  BRICK, SEED_MAX, TILE, SUPER, SUPER_TEX, SUPER_CELLS, LAYOUT, STATE_OPTS, gridDims, atlasDims, sleepUnitOf,
  marksLayout, actLayout, ACT_COUNTS, ACT_MAP, tablesBuffer, tablesAirTOffset, cellSlot, slotCell, brickIdOf, brickCoordOf,
  editKernelWGSL, EDIT_FIELDS, EDIT_SCRATCH_BINDING,
} from './shaders/common.js';
import {
  activityPeriod, inertListFrag, inertFrag, quietFrag, drawnFrag, move1Frag, argsFrag, permuteFrag, inertRefFrag,
  BuildParams, BUILD_LAYOUT, REF_LAYOUT, ARGS, ARGS_BYTES, COUNTS_SLOTS, COUNTS_BYTES, inertFold, SUPER_SETTLE_STEPS,
} from './shaders/activity.js';
import { moveBlockFrag, MoveParams, MOVE_LAYOUT, marginBlocks, MOVE_FORM, ownerLayout } from './shaders/move.js';
import { reactFrag, ReactParams, REACT_LAYOUT, FACES } from './shaders/react.js';
import {
  paintUpdateWGSL, PaintParams, PAINT_LAYOUT, paintDeclsWGSL, freshFrag, copyFrag, toAtlasFrag, fromAtlasFrag, ConvertParams, CONVERT_LAYOUT,
  rectToAtlasFrag, RectParams, awakeFrag, AwakeParams,
} from './shaders/passes.js';
import { shiftFrag, undoShiftFrag, flowShiftFrag, ShiftParams, UNDO_LAYOUT, FLOW_SHIFT_LAYOUT } from './shaders/window.js';
import { stateLayout } from './shaders/common.js';
import { uniformStruct } from './gpu/params.js';
import { fold } from './gpu/kernels.js';
import { TOOLS, PROP_TOOL, isDecoTool } from './elements.js';
import { strokeDabs, PROP } from './editing.js';
import { GRAV, EDGE, SIM_MODE_DEFAULTS } from './simModes.js';
import { PHYS } from './physics.js';

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
// delegating methods below. Fast particles, whitewater and TPT's decoration
// layer plug in the same way (attachRays, attachAeration, attachDeco; J3).
//
// TPT's simulation options (src/simModes.js: gravity, air, ambient heat and
// edge modes) are per-dispatch params of the move and react (B4), set by the
// setters below; switching one builds nothing. Radial gravity and void or loop
// edges switch quiet skipping off (quietOk), so the sleeping rules stay exact.

// cells/step² downward (the app's gravity setting overrides it)
const GRAVITY_DEFAULT = 0.025;

// TPT's Mix tool (elements.js TOOLS): its stroke reads other cells, so it is a two-phase edit (passes.js).
const MIX_TOOL = TOOLS.find((t) => t.key === 'MIX').id;
// Native requests held while the dynamics finish building (applyNativeTool, deferNative): the
// first frame no longer waits for them (src/v2/physics.js dynamicsReady), so a brush held from
// frame 1 must wait out their whole cold build. Thirty seconds of a 60 Hz brush: more would be a
// stuck build, not a wait.
const NATIVE_PENDING_SECONDS = 30, NATIVE_PENDING_HZ = 60;
const NATIVE_PENDING_MAX = NATIVE_PENDING_SECONDS * NATIVE_PENDING_HZ;

// Steps an activity map stays valid (shaders/activity.js).
const ACTIVITY_PERIOD = activityPeriod(BRICK);

// Cells added around a box of cell centres in the box an edit covers
// (touchCentres(): the brush, the first-person body and physgun): the centres
// sit half a cell off the grid, so this covers them with room.
const TOUCH_MARGIN = 1;

// Undo snapshots kept, at most (each is the current A and B: ~67 MB at 128³).
const UNDO_LIMIT = 3;

// The legacy state's copies (docs/webgpu.md C1; Simulation.pingPong): V1's step
// ping-pongs between two (the move in place, the react into the other); a box
// the native engine owns (src/v2/physics.js) keeps only the current one, the
// cache its edits and readbacks go through. Bytes a slot in each copy: A and B
// a vec4f each, F a u32 (a copy is 36 B a slot: 75.5 MB at 128³).
const PING_PONG = 2, ONE_COPY = 1;
const STATE_BYTES = { A: 16, B: 16, F: 4 };

// Bind groups an edit kernel keeps for its group 2, at most. Bindings are
// meant to be long-lived (B6: a pooled upload buffer and its sub-ranges); a
// caller binding a new buffer per edit would otherwise grow the cache forever.
const EDIT_GROUPS_MAX = 64;

// readStateRect's scratch is kept up to this size between reads (the
// console's block reads: a supertile's square, 32 KB); a larger one (a band
// of rows) goes once its read is submitted.
const RECT_SCRATCH_KEEP = 1 << 20;

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

// A number per object (buffer, texture view), for keys of bind group caches.
const objectIds = new WeakMap();
let nextObjectId = 1;
const idOf = (o) => { let id = objectIds.get(o); if (!id) objectIds.set(o, id = nextObjectId++); return id; };

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

// The element tables' buffer (C6): one per device, made on first use. It
// also holds the ambient air temperature every sim kernel reads (airT: shaders/
// common.js), one value for every simulation on the device, as the WebGL
// build's uAirT was one uniform for all; its word's offset is kept with the
// buffer it was laid out for.
function tablesOf(gpu) {
  if (!gpu._simTables) {
    const bytes = tablesBuffer();
    const buffer = gpu.createBuffer({ label: 'tables', size: Math.ceil(bytes.byteLength / 16) * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    gpu.queue.writeBuffer(buffer, 0, bytes);
    gpu._simTables = {
      buffer, group: gpu.bindGroup(simLayouts(gpu).TABLES, [{ binding: 0, resource: { buffer } }], 'tables'),
      airT: PHYS.AMBIENT, airTOffset: tablesAirTOffset(),
    };
  }
  return gpu._simTables;
}

// Sets the ambient air temperature (°C) in the tables' buffer, through the
// device's ordered write: a frame that has recorded anything is flushed first,
// so what it recorded keeps the value it was recorded with (as FrameUniforms'
// writes do, docs/webgpu.md B3). The render side's own copy of the tables
// (gfx/uniforms.js, made when FrameUniforms came before any simulation) gets
// it too, so an L.FRAME kernel reading airT() agrees with the sim's.
function setAirT(gpu, v) {
  const t = tablesOf(gpu);
  if (v === t.airT) return;
  const word = new Float32Array([v]);
  gpu.write(t.buffer, t.airTOffset, word);
  if (gpu._renderTables) gpu.write(gpu._renderTables, t.airTOffset, word);
  t.airT = v;
}

// GPU simulation driver: owns the state buffers and records the passes.
export class Simulation {
  /**
   * @param {object} gpu the gpu from src/gpu/device.js createGpu
   * @param {number} nx
   * @param {number} ny
   * @param {number} nz
   * @param {{ windowed?: boolean, world?: number[], sleepUnit?: {x: number, y: number, z: number}, debug?: boolean, form?: string, nativeStartup?: boolean }} [opts]
   *   windowed: the grid is a window of a larger world (docs/scaling.md D11);
   *   world: that world's size (the GI's far layout, src/derived.js);
   *   sleepUnit: the sleeping unit in bricks (shaders/common.js SLEEP_UNIT; SUPER for an A/B);
   *   debug: every state access tests its cell and counts misses (readDebug; I2.8);
   *   form: the move's code form (shaders/move.js MOVE_FORMS; tools compare them, D2)
   *   nativeStartup: defer legacy stepping kernels until prepareLegacy(); edits/imports still build now.
   *     A box keeps one state copy until something ping-pongs (pingPong)
   */
  constructor(gpu, nx, ny, nz, { windowed = false, world = null, sleepUnit = null, debug = gpu.debug, form = MOVE_FORM, nativeStartup = false } = {}) {
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
    // simulation modes (src/simModes.js), set through their setters below
    this._gravityMode = SIM_MODE_DEFAULTS.gravityMode;
    this._airMode = SIM_MODE_DEFAULTS.airMode;
    this._ambientHeat = SIM_MODE_DEFAULTS.ambientHeat;
    this._edgeMode = SIM_MODE_DEFAULTS.edgeMode;
    this.gravity = GRAVITY_DEFAULT;
    // bumped by every write to the state (steps, edits, loads, undo, network
    // updates), so callers can tell when the world changed
    this.version = 0;
    // bumped by every whole-grid write (noteWrite: a load, an undo; a shift), so a
    // second engine kept beside this state (src/v2/physics.js) knows to re-read it all
    this.wholeWrites = 0;
    // The grid is a window of the world (docs/scaling.md D11): origin is the
    // world cell of grid cell (0, 0, 0), every dispatch's header (B4). A grid
    // that is its whole world stays at 0; shift() moves it.
    this.origin = new Vec3();
    this.originUniform = { value: this.origin };   // (for the render setup until it reads the header)
    // fast particles and whitewater (attachRays, attachAeration), the derived
    // passes (attachDerived), TPT's decoration layer (attachDeco: src/deco.js, U17)
    this.rays = NO_RAYS;
    this.aeration = null;
    this.derived = null;
    this.deco = null;
    // The decoration layer exists from the first deco stroke (main's
    // ensureDeco): decoFactory(sim), set by its wire module (U17), makes it
    // then (ensureDeco); until one is set, deco strokes paint nothing.
    this.decoFactory = null;
    // profiling hook (gfx/profiler.js): onPass(name, { kind, gpuMs }) after every dispatch
    this.onPass = null;
    // test knobs (docs/webgpu.md C7, I2); test mode only
    //   logCounts: every build's counts go through the ring, into countsLog
    //   ({ frame, counts: Promise<ArrayBuffer> }: nAWAKE, nDRAWN, nMOVE1, nINERT), for budget-check
    //   loopMargin: with loop edges, run the move's low-margin blocks too: every
    //   block straddling an edge gets a second owner (the owner check's negative control)
    this.test = { listOrder: null, blockOrder: null, raceProbe: false, syncAfterShift: false, logCounts: false, loopMargin: false };
    this.countsLog = [];
    this._shiftListeners = [];
    this._scratchGroups = [];   // [edit kernel's group cache, key] of the groups holding the edit scratch

    // ---- buffers (docs/webgpu.md C1) ----
    const S = GPUBufferUsage.STORAGE, CS = GPUBufferUsage.COPY_SRC, CD = GPUBufferUsage.COPY_DST;
    const buf = (label, size, usage = S | CS | CD) => gpu.createBuffer({ label: `sim${this.id} ${label}`, size: Math.max(16, Math.ceil(size / 16) * 16), usage });
    const slots = g.slots;
    this.cur = 0;
    const { A, B, F } = this._stateBuffers(nativeStartup && !windowed ? ONE_COPY : PING_PONG);
    this.flow = buf('flow', slots * 8);
    // moveSrc's buffer: whitewater's moveSrc plane and the decoration's (_side)
    this.moveSrc = buf('moveSrc (none)', 16);
    this.sideDeco = false;   // it holds the decoration's plane (attachDeco)
    // (a debug build's move stamps its cells after the marks' own words: the owner check, shaders/move.js ownerLayout)
    this.marks = buf('marks', (this.debug ? ownerLayout(g).words : marksLayout(g).words) * 4);
    this.actLayout = actLayout(g);
    this.act = buf('act', this.actLayout.words * 4);
    this.args = buf('args', ARGS_BYTES, S | CS | CD | GPUBufferUsage.INDIRECT);
    // dummies for the rays layer's deposit and brick bits while none is attached
    this.noDeposit = buf('rays deposit (none)', 16);
    this.noRayBricks = buf('rays bricks (none)', 16);
    this.noMask = buf('paint mask (none)', 16);   // the brush's group 2 when it isn't a fill (passes.js PAINT_LAYOUT)
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
    this._stateGroups();
    this._groups();

    // ---- kernels (B5): native hosts need edits/imports now, not legacy stepping ----
    const dbg = { debug: this.debug };
    const kernel = (name, code, layouts, params, extra = {}) => gpu.kernel({ name, code, layouts: [this.L.TABLES, ...layouts], params, ...extra });
    const build = (name, frag, extra = {}) => kernel(name, frag(g), [L.STATE_BUILD, L.BUILD], BuildParams, extra);
    const legacy = nativeStartup ? { build: 'manual' } : {};
    this._legacyDeferred = nativeStartup;
    this.kernels = {
      move: kernel('move', moveBlockFrag(g, { form, ...dbg }), [L.STATE_RW, L.MOVE], MoveParams, legacy),
      react: kernel('react', reactFrag(g, dbg), [L.STATE_RW, L.REACT], ReactParams, legacy),
      inertList: build('inertList', inertListFrag, legacy),
      inert: kernel('inert', inertFrag(g, dbg), [L.STATE_BUILD], BuildParams, legacy),
      quiet: build('quiet', quietFrag, legacy),
      drawn: build('drawn', drawnFrag, legacy),
      move1: build('move1', move1Frag, legacy),
      args: build('args', argsFrag, legacy),
    };
    // the simulation's other passes (docs/webgpu.md D6, D7, C2): what a session
    // writes with (the brush, load, undo, the derived passes' note) built now
    // too, so a write never waits; the rest on first use (passOf, prepare)
    const brush = { update: paintUpdateWGSL, params: PaintParams, decls: paintDeclsWGSL(g), layout: PAINT_LAYOUT };
    // V1's edit passes a native host never records: its Mix runs natively (v2/interactions.js
    // nativeCellPaint) and its undo across a shift too (v2/integration.js undo). They build on first
    // use there (prepareLegacy builds them with V1's stepping), so the first frame never waits for them.
    const v1Edits = {
      paintMix: () => this.editKernel('paintMix', { ...brush, reads: 'neighbours' }),   // TPT's Mix tool reads its partner cell
      undoShift: () => kernel('undoShift', undoShiftFrag(g, dbg), [L.STATE_RW, L.UNDO], ShiftParams),
    };
    this._legacyEdits = nativeStartup ? Object.keys(v1Edits) : [];
    const v1Edit = (name) => (nativeStartup ? {} : { [name]: v1Edits[name]() });   // (V1's: built now, in its order)
    this.passes = {
      paint: this.editKernel('paint', { ...brush, reads: 'own' }),
      ...v1Edit('paintMix'),
      fromAtlas: kernel('fromAtlas', fromAtlasFrag(g, dbg), [L.STATE_RW, L.CONVERT], ConvertParams),
      ...v1Edit('undoShift'),
      awake: kernel('awake', awakeFrag(g), [L.STATE_BUILD], AwakeParams),
    };
    this._lazy = {
      ...v1Edits,
      toAtlas: () => kernel('toAtlas', toAtlasFrag(g), [L.STATE_FLAGS_RO, L.CONVERT], ConvertParams),
      rectToAtlas: () => kernel('rectToAtlas', rectToAtlasFrag(g), [L.STATE_FLAGS_RO, L.CONVERT], RectParams),
      nativeRectToAtlas: () => kernel('nativeRectToAtlas', nativeRectToAtlasWGSL(g), [L.STATE_RO, L.CONVERT], RectParams),
      copy: () => kernel('copy', copyFrag(g, dbg), [L.STATE_RW]),
      fresh: () => kernel('fresh', freshFrag(g, dbg), [L.STATE_RW]),
      inertRef: () => kernel('inertRef', inertRefFrag(g), [L.STATE_RO, L.REF]),
      permute: () => build('permute', permuteFrag),
      moveRace: () => kernel('moveRace', moveBlockFrag(g, { form, ...dbg, raceProbe: true }), [L.STATE_RW, L.MOVE], MoveParams),
      shift: () => kernel('shift', shiftFrag(g, dbg), [L.STATE_RW], ShiftParams),
      flowShift: () => kernel('flowShift', flowShiftFrag(g), [gpu.L.EMPTY, L.FLOW_SHIFT], ShiftParams),
    };
    // a window of a larger world moves (and its window code syncs copies until
    // U10 drops that, G1); tools read the state back from their first call
    if (windowed) for (const k of ['shift', 'flowShift', 'copy']) this.passOf(k);
    if (gpu.testMode) for (const k of ['toAtlas', 'copy']) this.passOf(k);
    // (the state starts blank once they are: load() needs its kernel)
    this.ready = Promise.all([...(nativeStartup ? [] : Object.values(this.kernels)), ...Object.values(this.passes)].map((k) => k.ready))
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

  // The legacy state's buffers with `copies` copies (docs/webgpu.md C1).
  _stateBuffers(copies) {
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const buf = (k) => this.gpu.createBuffer({ label: `sim${this.id} ${k}`, size: copies * this.g.slots * STATE_BYTES[k], usage });
    return { A: buf('A'), B: buf('B'), F: buf('F') };
  }

  // The group-1 bind groups that hold the state's buffers (made once per set of them, B6).
  _stateGroups() {
    const { gpu, L } = this, { A, B, F } = this.state;
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    this._bindRW = gpu.bindGroup(L.STATE_RW, [b(0, A), b(1, B), b(2, F), b(3, this.marks), b(4, this.act)], 'state rw');
    this._bindRO = gpu.bindGroup(L.STATE_RO, [b(0, A), b(1, B)], 'state ro');
    this._bindAct = gpu.bindGroup(L.STATE_ACT, [b(0, A), b(1, B), b(4, this.act)], 'state act');
    this.bindBuild = gpu.bindGroup(L.STATE_BUILD, [b(0, A), b(1, B), b(2, F), b(3, this.marks), b(4, this.act)], 'state build');
    this._bindFlagsRO = gpu.bindGroup(L.STATE_FLAGS_RO, [b(0, A), b(1, B), b(2, F)], 'state flags ro');
  }

  // The legacy state's copies held now.
  get copies() { return this.state.A.size / (this.g.slots * STATE_BYTES.A); }

  /**
   * Holds both legacy copies (on: V1's step, a shift, the copy tools) or only
   * the current one (off: a box the native engine owns, src/v2/physics.js). The
   * current copy keeps its words, as copy 0. A second copy comes back zeroed, as
   * a new grid's starts: V1 steps only after a whole write is noted (a load, or
   * PhysicsV2.suspend's noteWrite), so its first map draws every unit and its
   * react writes every cell of that copy before anything reads it (the
   * copy-through, shaders/react.js), as after any load. Only a box (g.windowed
   * false) drops one: a window's shift runs out of place. The groups holding the
   * old buffers are made again (here and the native owner's), and the old
   * buffers go once the queue is done with them. (Once graphics have stopped,
   * nothing is remade: nothing records any more.)
   * @param {boolean} on
   */
  pingPong(on) {
    const n = on ? PING_PONG : ONE_COPY;
    if (n === this.copies || (!on && this.g.windowed !== false) || this.gpu.failure) return;
    const f = this.gpu.frame, state = this.state, next = this._stateBuffers(n), slots = this.g.slots;
    for (const k of Object.keys(STATE_BYTES)) {
      f.copy(state[k], this.cur * slots * STATE_BYTES[k], next[k], 0, slots * STATE_BYTES[k]);
      this._retire(state[k]);
      state[k] = next[k];
    }
    this.cur = 0;
    this._stateGroups();
    this.compactOwner?.bindLegacy();
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

  // Nothing when the kernel is ready (so a read still records at its call), else its build.
  _readyFor(name) { const k = this.passOf(name); return k.state === 'ready' ? null : k.ready; }

  /**
   * Builds kernels the simulation makes only on demand: 'inertRef',
   * 'permute' (sim.test.listOrder), 'moveRace' (sim.test.raceProbe), 'shift'
   * and 'flowShift' (a grid made without `windowed`). Resolves when they are
   * ready to record.
   * @param {...string} names
   */
  prepare(...names) { return Promise.all(names.map((n) => this.passOf(n).ready)); }

  // Explicit engine-switch boundary. Build once, await every legacy step/activity
  // kernel and the initial clear; a failure leaves legacy stepping disabled.
  async prepareLegacy() {
    await Promise.all([this.ready, ...Object.values(this.kernels).map((k) => k.build()), ...this._legacyEdits.map((n) => this.passOf(n).ready)]);
    this._legacyDeferred = false;
    return this;
  }

  // Settings can change while asleep (including away and back during a readback).
  // gravity: cells/step², as the app's setting has it; read back, what pulls
  // (none with the gravity mode off: the first-person body, shots and the
  // physgun read it too, so they float as TPT's stickman does, STKM.cpp)
  get gravity() { return this._gravityMode === GRAV.OFF ? 0 : this._gravity; }
  set gravity(v) { if (v !== this._gravity) { this._gravity = v; this.wake(); } }
  // Simulation modes (src/simModes.js). World's window keeps solid edges:
  // its edge is the store's boundary, not the world's.
  get gravityMode() { return this._gravityMode; }
  set gravityMode(v) { this._setMode('_gravityMode', v); }
  get airMode() { return this._airMode; }
  set airMode(v) { this._setMode('_airMode', v); }
  get ambientHeat() { return this._ambientHeat; }
  set ambientHeat(v) { this._setMode('_ambientHeat', v); }
  get edgeMode() { return this._edgeMode; }
  set edgeMode(v) { this._setMode('_edgeMode', this.g.windowed ? EDGE.SOLID : v); }
  // May quiet bricks be skipped? Not where a resting cell could still move:
  // the rest test (shaders/activity.js) knows only vertical gravity and solid
  // edges, so radial gravity and open or looping edges step every brick.
  get quietOk() { return this._skipQuiet && this._gravityMode !== GRAV.RADIAL && this._edgeMode === EDGE.SOLID; }
  get skipQuiet() { return this._skipQuiet; }
  set skipQuiet(v) { if (v !== this._skipQuiet) { this._skipQuiet = v; this.actFull = true; this.wake(); } }
  // A mode change wakes the world; one that turns quiet skipping on or off
  // rebuilds every brick's inert bit, as a skipQuiet toggle does (docs/webgpu.md D4).
  _setMode(key, v) {
    if (v === this[key]) return;
    const quiet = this.quietOk;
    this[key] = v;
    if (this.quietOk !== quiet) this.actFull = true;
    this.wake();
  }
  get skipSleeping() { return this._skipSleeping; }
  set skipSleeping(v) { if (v !== this._skipSleeping) { this._skipSleeping = v; this.wake(); } }
  // The ambient air temperature, °C (TPT's "ambient air temperature" option):
  // what the air relaxes to and rests at (shaders/common.js airT()). One value
  // for every simulation on the device, as the WebGL build's airTUniform was;
  // app.js sets the world scene's (scene.airT) when it builds a simulation,
  // before the blank state is written (on ready). The rest test reads it, and
  // a cell's flags hold the test as it was written: set later, on a state
  // already written, every cell's flags are redone (freshFlags, a whole-grid
  // write; once its kernel is built, if it wasn't).
  get airT() { return tablesOf(this.gpu).airT; }
  set airT(v) {
    if (v === this.airT) return;
    setAirT(this.gpu, v);
    // Native settings wake activity, not the lossy legacy material cache.
    if (this.compact) { this.compact._noteModes(); return; }
    if (this.version === 0) return;
    const fresh = this.passOf('fresh');
    if (fresh.state === 'ready') this.freshFlags({ replaceState: false });
    else fresh.ready.then(() => { if (!this.disposed && !this.gpu.failure) this.freshFlags({ replaceState: false }); }, () => {});
  }

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
    return { origin: [this.origin.x, this.origin.y, this.origin.z], src, dst, format: 0, capture: this.compactOwner?.isReady ? (this.compact === this.compactOwner ? 2 : 1) : 0 };
  }

  // Writer/readback compatibility boundaries. Internal compact kernels bind
  // their own groups and legacy headers, so synchronization cannot recurse.
  legacyState(native = false) { this.compact?.exportLegacy(native); }
  get bindRW() { this.legacyState(true); return this._bindRW; }
  get bindAct() { this.legacyState(); return this._bindAct; }
  get bindFlagsRO() { this.legacyState(); return this._bindFlagsRO; }
  get bindRO() {
    const v2 = this.compact;
    if (!v2?.isReady) return this._bindRO;
    v2.sync();
    if (v2.forceCompatibility && this.gpu.testMode) { v2.exportLegacy(false); return this._bindRO; }
    return v2.readGroup();
  }
  // Physical readers share the compact core but read current native coarse
  // air in B. Format 2's group (bindRO: the drawn projection) binds the same
  // air (v2/physics.js readGroup): the draw reads it as V1's B, generic format-2
  // readers never read B.
  get bindPhysicalRO() {
    const v2 = this.compact;
    if (!v2?.isReady) return this._bindRO;
    // forceCompatibility is renderer-only: physical probes always read the
    // canonical core and current coarse air, never the visual projection.
    v2.sync();
    // (only the dynamics' buffers: their coarse air holds its rest, still air, until their kernels step it)
    const d = v2.dynamics;
    if (!d?.air || d.disposed) return null;
    if (this._physicalOwner !== this.compact) {
      this._physicalOwner = this.compact;
      this._physicalGroups = d.air.map(buffer => this.gpu.bindGroup(this.L.STATE_RO, [
        { binding: 0, resource: { buffer: this.compact.cells } }, { binding: 1, resource: { buffer } },
      ], 'native physical readers'));
    }
    return this._physicalGroups[d.airIndex];
  }
  get nativeCapabilities() { return nativeCapabilities(this); }
  async prepareNative(owner = this.compactOwner) {
    // The brush's and the window's kernels need only the owner's buffers: their builds start with
    // the owner's, not after its readiness, which made them a serial tail of the loading screen.
    if (owner && owner === this.compactOwner && owner.dynamics && !owner.isReady) prepareNativeBrush(this).catch(() => {});
    if (owner?.aux && !owner.disposed && this.nativeIntegration?.owner !== owner) {
      this.nativeIntegration?.dispose();
      this.nativeIntegration = new NativeIntegration(this, owner);
    }
    await owner?.ready;
    if (!owner?.aux) return false;
    if (this.nativeIntegration?.owner !== owner) {
      this.nativeIntegration?.dispose();
      this.nativeIntegration = new NativeIntegration(this, owner);
    }
    await this.nativeIntegration.ready;
    // The brush's native kernels are part of being ready, as V1's paint pass is.
    // (A failed build is a bug to see in the console, not a reason to stop the engine.)
    if (owner.dynamics) await prepareNativeBrush(this).catch((err) => console.error('native brush kernels failed to build', err));
    return true;
  }
  // A tool request made while the native owner is active but its dynamics or
  // integration are still building waits here (bounded) and runs once they are
  // ready, never refused nor handed to V1. A world shift still freezes tools.
  applyNativeTool(request) {
    if (this.nativeTransition || this.nativeTransitionError) return false;
    const kind = request.kind ?? 'impulse';
    if (!this.compact) return false;
    if (!this.nativeCapabilities[kind]) return this._holdNative(request);
    if (this.nativePending?.length) this.flushNativeTools();
    // (behind any request still waiting: one order)
    if (this.nativePending?.length) return this._holdNative(request);
    return this._applyNativeTool(request, kind);
  }
  _holdNative(request) {
    if ((this.nativePending ??= []).length >= NATIVE_PENDING_MAX) return false;
    this.nativePending.push(request);
    this.wake();
    return true;
  }
  /**
   * Another native writer that records the dynamics' stages (an external blast, a force kernel's
   * launch): now if they are built and nothing waits before it, else queued behind the tool requests
   * already waiting, in one order, to run once they are (flushNativeTools). Never refused for the
   * build, nor handed to V1.
   * @param {string} kind its capability (nativeCapabilities: 'externalBlast', 'force')
   * @param {() => boolean} apply records it; true when it was accepted
   * @returns {boolean} accepted, or queued
   */
  deferNative(kind, apply) {
    if (this.nativeTransition || this.nativeTransitionError || !this.compact) return false;
    if (this.nativeCapabilities[kind]) {
      if (this.nativePending?.length) this.flushNativeTools();
      if (!this.nativePending?.length) return apply();
    }
    return this._holdNative({ kind, apply });
  }
  // Runs the requests that waited for readiness, oldest first (app.js nativeBeforeStep; PhysicsV2._tick).
  flushNativeTools() {
    const pending = this.nativePending;
    if (!pending?.length || !this.compact || this.nativeTransition || this.nativeTransitionError) return 0;
    let n = 0;
    while (pending.length && this.nativeCapabilities[pending[0].kind ?? 'impulse']) {
      const request = pending.shift();
      if (request.apply ? request.apply() : this._applyNativeTool(request, request.kind ?? 'impulse')) n++;
    }
    return n;
  }
  _applyNativeTool(request, kind) {
    this.compact.sync();
    const accepted = this.compact.dynamics.applyToolImpulse(request);
    const ok = accepted === 'accepted' || accepted === 'queued' || accepted?.status === 'accepted' || accepted?.status === 'queued';
    if (ok) { this.compact.wake(); this.wake(); }
    return ok;
  }
  readHeader({ physical = false } = {}) {
    this.compact?.sync();
    const v2 = this.compact;
    return { ...this.header(), format: v2?.isReady && (physical || !(v2.forceCompatibility && this.gpu.testMode)) ? (physical ? 3 : 2) : 0 };
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
    return !this.idleRead && !this.idleCertified && this.quietOk && this.skipSleeping && !this.rays.active && !this.disposed;
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
      full: this.actFull, enabled: this.quietOk, rays: this.rays.active, carry, noted: this.actNoted,
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
    // Callers outside app.js (scripts/fixtures) step the active engine too.
    // Engine switching is explicit; a step must never silently suspend v2.
    if (this.compact) {
      if (this.compact.isReady) nativeHostTick(this.compact);
      return;
    }
    if (this._legacyDeferred) throw new Error('Legacy physics is not prepared: await sim.prepareLegacy() before stepping');
    this.pingPong(true);   // (a box the native engine owned holds one copy)
    const f = this.gpu.frame;   // (throws GraphicsFailure once graphics have stopped)
    this.frame++;   // simulation time and parity advance even when there is nothing to step
    // Certified idle: every unit settled in both copies, no unit AWAKE or DRAWN,
    // and that's a fixed point until something writes (docs/webgpu.md D4).
    if (this.idleCertified && !this.actDirty && !this.actFresh && this.actSteps >= SUPER_SETTLE_STEPS
        && this.quietOk && this.skipSleeping && !this.rays.active) {
      const aerGeneration = this.aeration?.generation, aerCopy = this.aeration?.cur;
      this.aeration?.idle?.(f);   // nothing moves, but the foam left on it still bursts
      if (this.aeration?.generation !== aerGeneration || this.aeration?.cur !== aerCopy) this.worldRenderSource?.recordLiveCopy(f, this);
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
    const modes = { gravMode: this._gravityMode, edge: this._edgeMode };
    const loop = this._edgeMode === EDGE.LOOP, loopMargin = testing && this.test.loopMargin;
    const mp = {
      frame: this.frame, parity, gravity: this.gravity, fresh, outOfPlace, margin: 0,
      blockRev: testing && this.test.blockOrder === 'reverse', eight: 8, ...modes,
      deco: this.decoCarried, decoAt: 0, srcAt: this.moveSrcAt, loopMargin,
    };
    // the move: in place (or into the other copy, for whitewater), over the
    // offset's list, then at offset 1 the low margin's blocks; with loop edges
    // those are the lists' blocks seen from the far side, which own them (one
    // owner per block, shaders/move.js), so they don't run
    const mh = this.header(cur, outOfPlace ? other : cur);
    const mb = [this.tables, this.bindRW, this.moveGroup];
    this._dispatch(move, { indirect: this.args, offset: parity ? ARGS.MOVE1 : ARGS.MOVE0 }, { bind: mb, header: mh, params: mp });
    if (parity && (!loop || loopMargin)) this._dispatch(move, fold(Math.ceil(marginBlocks(this.g) / 64)), { bind: mb, header: mh, params: { ...mp, margin: 1 } });
    // whitewater's field follows the move (gfx/foam.js): it reads the copy from
    // before it, and moveSrc's plane at word moveSrcAt of its buffer
    if (outOfPlace) this.aeration.step(f, { pre: cur, post: other, moveSrc: this.moveSrc, moveSrcAt: this.moveSrcAt });
    // react, from the moved state into the other copy
    const rh = outOfPlace ? this.header(other, cur) : this.header(cur, other);
    this._dispatch(this.kernels.react, { indirect: this.args, offset: ARGS.REACT }, {
      bind: [this.tables, this.bindRW, this.reactGroup], header: rh,
      params: {
        frame: this.frame, gravity: this.gravity, faces: FACES, headScan: this.g.ny, rays: Boolean(this.rays.stepped), ...modes,
        airMode: this._airMode, ambientHeat: this._ambientHeat,
      },
    });
    if (!outOfPlace) this.cur = other;
    if (this.rays.active) this.rays.settle(f);
    this.version += 2;   // (the move and react: as the WebGL build counted its two state passes)
    this.worldRenderSource?.noteContentChange();
    this.worldRenderSource?.recordLiveCopy(f, this);
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
   * @param {{ bind?: GPUBindingResource[], scrub?: boolean, residency?: boolean }} [opts] bind: the kernel's own group-2
   *   resources: one per entry of editKernel's `layout`, in order ({ buffer, offset?, size? } for a
   *   buffer); the sim adds the two-phase scratch and makes the bind group once per set of resources (a
   *   buffer's range included). Bind long-lived buffers (B6): a kernel keeps at most EDIT_GROUPS_MAX
   *   groups. scrub: the cells it gives a new element lose their decoration, as TPT's create_part
   *   resets dcolour (the brush, a stamp, the console's script: main's scrubDeco callers).
   *   residency: internal exact world refill/restore only; suppresses this writer's semantic
   *   content notification, never unrelated edits or callbacks.
   */
  edit(kernel, { lo, hi }, values = {}, { bind = [], scrub = false, residency = false } = {}) {
    if ((this.nativeTransitionKind === 'shift' && !this.nativeCommitting) || this.nativeTransitionError) return false;
    const box = this._clip(lo, hi);
    if (!box) return;
    const [a, b] = box;
    const nb = [0, 1, 2].map((k) => (b[k] >> 2) - (a[k] >> 2) + 1);
    const size = fold(nb[0] * nb[1] * nb[2]);
    const params = { ...values, editLo: a, editHi: b };
    let group2 = null;
    if (kernel.layout) {
      const res = [...bind];
      if (kernel.reads === 'neighbours') res.push({ buffer: this._editScratch(nb[0] * nb[1] * nb[2] * 64 * 32) });
      group2 = this._editGroup(kernel, res);
    }
    const groups = [this.tables, this.bindRW, ...(group2 ? [group2] : [])];
    const header = this.header();
    // The write is in place: afterwards nothing holds the cells as they were
    // (main scrubbed against its ping-pong pass's other copy), so the
    // decoration layer keeps what it needs of the box first (beforeWrite) and
    // compares after (scrub), both recorded around the edit's dispatches.
    const deco = scrub ? this.deco : null, f = this.gpu.frame, clipped = { lo: a, hi: b };
    deco?.beforeWrite?.(f, clipped);
    this._dispatch(kernel.main, size, { bind: groups, header, params });
    if (kernel.apply) this._dispatch(kernel.apply, size, { bind: groups, header, params });
    this.version++;
    deco?.scrub?.(f, clipped);
    if (!residency) this.worldRenderSource?.noteContentChange();
    this.wake();   // the next step rebuilds the map: the marked bricks are forced
  }

  // An edit kernel's group 2 for these resources (its own bindings, then the
  // scratch), made once per set of resources (B6), not per edit. A buffer
  // binding is keyed by its range too: two sub-ranges of one pooled buffer
  // are two groups.
  _editGroup(kernel, res) {
    const key = res.map((r) => (r.buffer ? `${idOf(r.buffer)}@${r.offset ?? 0}+${r.size ?? 'all'}` : idOf(r))).join(',');
    kernel.groups ??= new Map();
    let group = kernel.groups.get(key);
    if (!group) {
      // past the bound the cache starts over (and forgets which of its groups held the scratch)
      if (kernel.groups.size >= EDIT_GROUPS_MAX) {
        kernel.groups.clear();
        this._scratchGroups = this._scratchGroups.filter(([groups]) => groups !== kernel.groups);
      }
      const bindings = [...kernel.extra.map((e) => e.binding), ...(kernel.reads === 'neighbours' ? [EDIT_SCRATCH_BINDING] : [])];
      group = this.gpu.bindGroup(kernel.layout, bindings.map((binding, i) => ({ binding, resource: res[i] })), `${kernel.name} group`);
      kernel.groups.set(key, group);
      // (a group holding the scratch goes when the scratch does)
      if (kernel.reads === 'neighbours') this._scratchGroups.push([kernel.groups, key]);
    }
    return group;
  }

  // The two-phase edits' scratch (two vec4f per cell of the brick-aligned
  // box), grown as needed; a buffer it outgrew is destroyed once the queue is
  // done with it, and the bind groups that held it are dropped.
  _editScratch(bytes) {
    if (!this.editScratch || this.editScratch.size < bytes) {
      if (this.editScratch) this._retire(this.editScratch);
      for (const [groups, key] of this._scratchGroups) groups.delete(key);
      this._scratchGroups = [];
      this.editScratch = this.gpu.createBuffer({ label: `sim${this.id} edit scratch`, size: Math.max(bytes, 64 * 32), usage: GPUBufferUsage.STORAGE });
    }
    return this.editScratch;
  }

  // Destroys a buffer once the queue is done with it, without flushing the
  // open encoder (which may still use it): every encoder is submitted by the
  // end of the task that opened it (its microtask flush, gpu/frame.js), so
  // wait for that submit, then for the queue.
  _retire(buffer) {
    const gpu = this.gpu;
    if (gpu.failure) { buffer.destroy(); return; }
    const done = () => gpu.queue.onSubmittedWorkDone().then(() => buffer.destroy(), () => buffer.destroy());
    if (!gpu.frame.open) { done(); return; }
    const flushes = gpu.stats.flushes;
    const wait = () => (gpu.stats.flushes !== flushes || gpu.failure ? done() : setTimeout(wait, 0));
    queueMicrotask(wait);
  }

  // The box an edit covers for a write that changes only cells whose centres
  // lie in [lo, hi] (grid cells, any reals; [x, y, z] arrays): { lo, hi }.
  touchCentres(lo, hi) {
    return { lo: lo.map((x) => Math.floor(x) - TOUCH_MARGIN), hi: hi.map((x) => Math.floor(x) + TOUCH_MARGIN) };
  }
  // (kept for callers that declared boxes before their pass: marking is the GPU's now, D6)
  touch(lo, hi) { return { lo, hi }; }

  // TPT's editing tools (src/editing.js) ride along: end, a line's far end (the
  // brush swept from center to it); grow, a box's reach past the brush per axis
  // ([x, y, z]); mask, a flood fill's region ({ data, lo, hi }: editing.js
  // runFill, a byte per atlas texel) instead of the brush; filter, the only
  // element touched (-1: any); erase, specific delete; prop, the PROP tool's
  // { field, value }. wind: [x, y, z] cells the brush moved since the stroke's
  // last paint (the Wind tool's drag). One edit (docs/webgpu.md D6): Mix, whose
  // cells read their partners, a two-phase one.
  paint({ center, radius, shape, tool, rate, replace, wind = null, end = center, grow = null, mask = null, filter = -1, erase = false, prop = null }) {
    if (this.nativeTransition || this.nativeTransitionError) return false;
    // Under V2 every tool runs natively (v2/interactions.js routeNativePaint): V1's rule on V2's own
    // cells, air and particles, never V1's cells for V2 to import; photons and neutrons and the
    // decoration below have their own native owners. Not a deviation: the same stroke either way.
    if (this.compact) {
      const routed = routeNativePaint(this, { center, radius, shape, tool, rate, replace, wind, end, grow, mask, filter, erase, prop });
      if (routed !== null) return routed;
    }
    // a line or box of particles: V1's dabs, each painted once (v2/tools.js)
    if (this.compact && nativeRayKind(tool)) return emitNativeRay(this, { center, radius, shape, tool, rate, end, grow });
    if (tool === PROP_TOOL && !prop) return;
    // TPT's deco tools paint the decoration layer, not the cells (src/deco.js): made on the first stroke
    if (isDecoTool(tool)) { this.ensureDeco()?.paint?.({ center, radius, shape, tool }); return; }
    // particle tools paint into the particle list, not the grid (a line or box: dabs along it)
    const dabs = !mask && (end !== center || grow) ? strokeDabs(center, end, grow ?? undefined, radius) : [center];
    if (this.rays.paint({ center: dabs[0], radius, shape, tool, rate })) {
      for (const c of dabs.slice(1)) this.rays.paint({ center: c, radius, shape, tool, rate });
      return;
    }
    this.rays.noteElement(tool);   // plutonium emits neutrons: the layer wakes
    if (prop?.field === PROP.TYPE) this.rays.noteElement(prop.value);
    // Its own random stream: this.frame counts steps only. The move pass
    // alternates its block partition by the step count's parity, so a paint
    // bumping it would lock the partition when one step runs per paint (Speed
    // 1 while painting: poured matter could never leave its 2×2×2 block); the
    // POV body and the media drift clock also read it as steps taken.
    this.paints++;
    let box;
    if (mask) box = { lo: mask.lo, hi: mask.hi };
    else {
      // it changes cells within radius of its centre (either shape), its line or its box
      const a = [center.x, center.y, center.z], b = [end.x, end.y, end.z], reach = [0, 1, 2].map((k) => radius + Math.max(grow?.[k] ?? 0, 0));
      box = this.touchCentres(a.map((x, k) => Math.min(x, b[k]) - reach[k]), a.map((x, k) => Math.max(x, b[k]) + reach[k]));
    }
    this.edit(tool === MIX_TOOL ? this.passOf('paintMix') : this.passes.paint, box, {
      center: [center.x, center.y, center.z], radius, shape, tool, rate, replace: Boolean(replace), frame: this.paints,
      wind: wind ? [wind[0], wind[1], wind[2]] : [0, 0, 0], end: [end.x, end.y, end.z], grow: grow ?? [0, 0, 0],
      masked: Boolean(mask), filter_: filter, del: Boolean(erase), prop: prop?.field ?? 0, propValue: prop?.value ?? 0,
    }, { bind: [{ buffer: mask ? this._paintMask(mask.data) : this.noMask }], scrub: true });
  }

  // A fill's mask on the GPU (editing.js regionMask's bytes, a byte per atlas
  // texel): one buffer the size of the atlas, made on the first fill. The
  // write is ordered (gpu.write): an earlier fill recorded in the open frame
  // still reads its own mask.
  _paintMask(data) {
    const bytes = Math.ceil((this.g.width * this.g.height) / 4) * 4;
    this.paintMask ??= this.gpu.createBuffer({ label: `sim${this.id} paint mask`, size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const padded = new Uint8Array(bytes);
    padded.set(data.subarray(0, bytes));
    this.gpu.write(this.paintMask, 0, padded);
    return this.paintMask;
  }

  // WEBGPU-STUB (docs/webgpu.md J3): main scrubbed after a writer's pass,
  // against the other copy; the port's writes are in place, so the scrub rides
  // on the write: sim.edit(kernel, box, values, { scrub: true }).
  scrubDeco() { throw new Error('sim.scrubDeco removed in the WebGPU port: docs/webgpu.md Sync log S3 (sim.edit with { scrub: true })'); }

  /**
   * A whole-grid write that isn't a step (a load, an undo, the codec's unpack):
   * the next map rebuilds every inert bit and draws every unit, and the
   * derived passes rebuild every brick. Residency copies may opt out of the
   * semantic content notification for this write only (never across an await).
   * A flags-only refresh (replaceState false) keeps V2's imported state current.
   */
  noteWrite({ residency = false, replaceState = true } = {}) {
    this.version++;
    if (!residency) this.worldRenderSource?.noteContentChange();
    if (replaceState) this.wholeWrites++;
    this.forceAll = true;
    this.actFull = true;
    this.changedAll = true;
    this.wake();
  }

  /**
   * Fresh flags (freshFlags: the next map redoes every neighbour test) on
   * every cell of the current copy, for a whole-grid writer that stored A and B
   * only (D6, the codec's unpack), and the whole-grid write noted (noteWrite:
   * the next map draws every unit). Its kernel is built on demand:
   * sim.prepare('fresh').
   */
  freshFlags(options) {
    this._dispatch(this.passOf('fresh'), fold(Math.ceil(this.g.slots / 64)), { bind: [this.tables, this.bindRW], header: this.header() });
    this.noteWrite(options);
  }

  resetNativeDynamics() { return resetNativeDynamics(this.compactOwner); }

  // Upload CPU-built state (Float32Array RGBA per atlas texel: cellTexel)
  // into the current copy, with fresh flags (docs/webgpu.md C2).
  load(dataA, dataB) {
    if (this.nativeTransitionKind === 'shift') throw new Error('Cannot load during a native world shift');
    const { width, height } = this.g, texels = width * height;
    const scratch = this._atlasScratch();
    this.gpu.write(scratch, 0, dataA.subarray(0, texels * 4));
    this.gpu.write(scratch, texels * 16, dataB.subarray(0, texels * 4), { ordered: false });
    this._dispatch(this.passes.fromAtlas, fold(Math.ceil(this.g.slots / 64)), {
      bind: [this.tables, this.bindRW, this._convertGroup], header: this.header(),
    });
    this._dropAtlasScratch();
    this.noteWrite();
    this.fieldReset = true;
    this.giReset = true;
    this.stillFlow();
    this.resetNativeDynamics();
    this.rays.reset();   // a new state: the old particles go, and it may hold plutonium
    this.deco?.reset?.();   // a new state: its decoration, if any, comes after (src/deco.js uploadDeco)
  }

  clear() {
    this.load(...this.blankState());
  }

  // The atlas-order scratch (load, readState, readCopies): A then B, or
  // flags. 32 bytes a cell (67 MB at 128³), so a session lets it go once the
  // copies that use it are submitted; tools, which read back often, keep it.
  _dropAtlasScratch() {
    if (this.gpu.testMode || !this.atlasScratch) return;
    this._retire(this.atlasScratch);
    this.atlasScratch = this._convertGroup = null;
  }

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
    this.pingPong(true);
    this._dispatch(this.passOf('copy'), fold(Math.ceil(this.g.slots / 64)), {
      bind: [this.tables, this.bindRW], header: this.header(this.cur, 1 - this.cur),
    });
  }

  // ---- undo history: GPU copies of the state, newest last ----
  // A V1 entry keeps A/B (~67 MB at 128³). A V2 entry keeps V2's own words
  // instead (the compact cores, their banks, and its dynamics' flying matter,
  // air and requests: NativeDynamics.captureUndo), GPU copies recorded with the
  // stroke and never read back, so a stroke's start costs what V1's does and an
  // undo right after it waits for nothing.
  // Each remembers the window's origin it was taken at (t.origin): after the
  // window moves (docs/scaling.md D11) it still holds the cells where they were,
  // and what it was taken before (t.label: 'Sand', 'House'), for the undo
  // notice's "Undone Sand" (Garry's Mod's "Undone Prop").
  snapshot(label = null, limit = UNDO_LIMIT) {
    const f = this.gpu.frame, bytes = this.g.slots * 16;
    const t = (this.history.length >= limit ? this.history.shift() : null) ?? {};
    t.format = this.compact?.isReady ? 'v2' : 'v1';
    if (t.format === 'v2') {
      // (storage too: an undo across a move reads them in the native window's merge, v2/integration.js undo)
      const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
      t.compact ??= this.gpu.createBuffer({ label: `sim${this.id} undo compact`, size: bytes, usage });
      f.copy(this.compact.cells, 0, t.compact, 0, bytes);
      if (this.compact.aux) {
        t.aux ??= this.gpu.createBuffer({ label: `sim${this.id} undo aux`, size: this.g.slots * 4, usage });
        f.copy(this.compact.aux, 0, t.aux, 0, this.g.slots * 4);
      } else if (t.aux) { this._retire(t.aux); t.aux = null; }
        const d = this.compact.dynamics;
      if (d && !d.disposed && d.captureUndo && !this.nativeTransition) t.dynamic = d.captureUndo(t.dynamic);   // (buffers alone: while its kernels build too)
      else this._retireUndoDynamic(t);
      if (t.A) { this._retire(t.A); this._retire(t.B); t.A = t.B = t.group = null; }
    } else {
      this.legacyState();
      if (!t.A) {
        const mk = (n) => this.gpu.createBuffer({ label: `sim${this.id} undo ${n}`, size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        t.A = mk('A'); t.B = mk('B');
        t.group = this.gpu.bindGroup(this.L.UNDO, [{ binding: 0, resource: { buffer: t.A } }, { binding: 1, resource: { buffer: t.B } }], 'undo snapshot');
      }
      if (t.compact) { this._retire(t.compact); t.compact = null; }
      if (t.aux) { this._retire(t.aux); t.aux = null; }
      this._retireUndoDynamic(t);
      const { A, B } = this.state;
      f.copy(A, this.cur * bytes, t.A, 0, bytes);
      f.copy(B, this.cur * bytes, t.B, 0, bytes);
    }
    t.deco = null;
    this.deco?.snapshot?.(t);   // and the decoration (src/deco.js)
    t.origin = this.origin.clone();
    t.label = label;
    t.note = null;   // the app's tag for what undoing this takes back besides cells (app.js: a shrine's orbs)
    this.history.push(t);
  }
  _retireUndoDynamic(t) {
    for (const b of t.dynamic?.buffers ?? []) this._retire(b);
    t.dynamic = null;
  }
  _retireUndo(t) {
    for (const b of [t.A, t.B, t.compact, t.aux]) if (b) this._retire(b);
    this._retireUndoDynamic(t);
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
  // there is none. The same under either engine: a V2 entry brings back its
  // own words over the shared cells, with the flying matter, air and requests
  // over them (v2/integration.js undo).
  undo() {
    const t = this.history.at(-1);
    if (!t) return false;
    const [dx, dz] = this.undoShift;
    if (Math.abs(dx) >= this.g.nx || Math.abs(dz) >= this.g.nz) return false;
    if (t.format === 'v2') {
      const owner = this.compactOwner, native = this.nativeIntegration;
      if (!owner?.isReady || owner.disposed) throw new Error('Cannot undo that: the physics it was made under is gone');
      if ((dx || dz) && !native?.isReady) throw new Error('Native shifted undo is not ready');
      const d = owner.dynamics, dynamic = t.dynamic && d && !d.disposed && !this.nativeTransition ? t.dynamic : null;
      if (dx || dz) native.undo(t.compact, t.aux, dx, dz, dynamic);
      else { owner.restore(t.compact, t.aux); if (dynamic) d.restoreUndo(dynamic); }
      if (native?.isReady) native.changed({ all: false });   // (the restore noted its bricks)
      else { this.version++; this.changedAll = true; owner.seenVersion = this.version; }
      // V2 suspended (a runtime switch to V1): V1's cells are the restored words' projection
      if (!this.compact) { owner.exportLegacy(); this.noteWrite({ replaceState: false }); owner.seenVersion = this.version; }
    } else {
      this._dispatch(this.passOf('undoShift'), fold(Math.ceil(this.g.slots / 64)), {
        bind: [this.tables, this.bindRW, t.group], header: this.header(), params: { shift: [dx, 0, dz] },
      });
      this.noteWrite();
    }
    this.history.pop();
    this.deco?.restore?.(t, dx, dz);
    this.stillFlow();
    this.rays.wake();   // it may bring plutonium back
    this._retireUndo(t);
    return true;
  }

  // Forget the undo snapshots (they hold a window that has moved or been replaced).
  dropHistory() {
    for (const t of this.history) this._retireUndo(t);
    this.history = [];
  }

  // The state was replaced: nothing is moving until the next step says so.
  stillFlow() {
    this.gpu.frame.clear(this.flow);
    this.worldRenderSource?.noteContentChange();
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
    const native = this.compactOwner?.isReady ? this.nativeIntegration : null;
    if (this.compactOwner?.isReady && !native?.isReady) throw new Error('Native world shift is not ready');
    // Synchronize/project before moving either representation. Legacy shifting
    // is a cache move, never permission to reimport the entire native grid.
    // (Only the running owner projects: a suspended one, after a runtime switch to V1, shadows V1's cells,
    // which are V1's own. native.shift syncs it first, importing V1's writes, as exportLegacy would.)
    this.compact?.exportLegacy();
    native?.shift(dx, dz);
    this.pingPong(true);   // (out of place: a box the native engine owns holds one copy)
    const f = this.gpu.frame, size = fold(Math.ceil(this.g.slots / 64)), shift = [dx, 0, dz];
    this._dispatch(this.passOf('shift'), size, { bind: [this.tables, this._bindRW], header: { ...this.header(this.cur, 1 - this.cur), capture: 0 }, params: { shift } });
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
    this.deco?.shift?.(dx, dz, f);   // the decoration moves with its cells (src/deco.js)
    if (!this.shiftKeepsHistory) {
      this.fieldReset = this.giReset = true;
      this.stillFlow();
    }
    this.rays.reset();   // particles are in grid cells: v1 lets them go (docs/particles.md)
    this.version++;
    this.wholeWrites++;
    native?.shifted();
    this.forceAll = true;
    this.actFull = true;
    // the derived passes shift their own history by whole bricks and re-age
    // only the slab and the edges (docs/webgpu.md E); without that, all of it
    if (!this.derived?.shiftsBricks) this.changedAll = true;
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
  _toAtlas(c, flags, physical = false) {
    this.legacyState(physical);
    this._atlasScratch();
    this._dispatch(this.passOf('toAtlas'), fold(Math.ceil(this.g.slots / 64)), {
      bind: [this.tables, this._bindFlagsRO, this._convertGroup], header: this.header(c), params: { flags },
    });
  }

  /**
   * The current state as it is at this call, as float RGBA per atlas texel in
   * the fetchA/fetchB layout (what load() takes): [A, B]. For CPU checks and
   * tools; cellTexel finds a cell in it. (Its kernel is built with the rest in
   * test mode; elsewhere the first read waits for it, and reads the state then.)
   * @returns {Promise<[Float32Array, Float32Array]>}
   */
  async readState({ physical = false } = {}) {
    const texels = this.g.width * this.g.height, wait = this._readyFor('toAtlas');
    if (wait) await wait;   // (not await null: that records after the caller's next writes)
    this._toAtlas(this.cur, false, physical);
    const read = this.gpu.readback.buffer(this.atlasScratch, 0, texels * 32);
    this._dropAtlasScratch();
    const bytes = await read;
    return [new Float32Array(bytes, 0, texels * 4), new Float32Array(bytes, texels * 16, texels * 4)];
  }

  /**
   * State A as it is at this call, as readState's first (TPT's flood fill reads
   * its pmap: editing.js runFill).
   * @returns {Promise<Float32Array>}
   */
  readStateAAsync(options) { return this.readState(options).then(([a]) => a); }

  /**
   * A w × h rectangle of the state atlas at texel (x, y), as it is at this
   * call, read into a and b (Float32Array RGBA per texel, row by row, in the
   * fetchA/fetchB layout): the console's reads (src/console/gpu.js). Only
   * asynchronously (docs/webgpu.md W6): async must be true, and the promise
   * resolves once a and b hold it (or rejects: a rectangle outside the atlas).
   * It converts only the rectangle, into a scratch of its size, so the
   * console's reads of one block each cost a block (its kernel is built on
   * the first: that read waits for it, and reads the state then).
   * @returns {Promise<void>}
   */
  readStateRect(x, y, w, h, a, b, async = false) {
    if (!async) throw new Error('readStateRect: synchronous reads removed in the WebGPU port: docs/webgpu.md W6 (pass async = true)');
    const { width, height } = this.g;
    if (!(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= width && y + h <= height)) {
      return Promise.reject(new Error(`readStateRect: ${w} × ${h} at ${x}, ${y} is outside the ${width} × ${height} atlas`));
    }
    // V2: the native cells and the motion V2 holds (v2/nativeRead.js), once its readers are built
    const native = !!this.compact?.isReady && !!this.compact.dynamics;
    const pass = native ? 'nativeRectToAtlas' : 'rectToAtlas';
    const read = () => {
      const n = w * h, scratch = this._rectScratch(n * 32);
      const state = native ? this.bindPhysicalRO : this.bindFlagsRO;
      if (!state) return Promise.reject(new Error('readStateRect: the native readers changed while reading'));
      this._dispatch(this.passOf(pass), fold(Math.ceil(n / 64)), {
        bind: [this.tables, state, this._rectGroup], header: native ? this.readHeader({ physical: true }) : this.header(), params: { at: [x, y], size: [w, h] },
      });
      const got = this.gpu.readback.buffer(scratch, 0, n * 32);
      // (a later read reuses it: its dispatch is recorded after this copy)
      if (!this.gpu.testMode && scratch.size > RECT_SCRATCH_KEEP) {
        this._retire(scratch);
        this.rectScratch = this._rectGroup = null;
      }
      return got.then((bytes) => {
        a.set(new Float32Array(bytes, 0, n * 4));
        b.set(new Float32Array(bytes, n * 16, n * 4));
      });
    };
    // (the physical readers bind the dynamics' air buffers, not their kernels: bindPhysicalRO)
    const wait = this._readyFor(pass);
    return wait ? wait.then(read) : read();
  }

  // readStateRect's scratch (A then B, 32 bytes a texel), grown as needed and
  // kept while small (RECT_SCRATCH_KEEP); a buffer it outgrew is
  // destroyed once the queue is done with it.
  _rectScratch(bytes) {
    if (!this.rectScratch || this.rectScratch.size < bytes) {
      if (this.rectScratch) this._retire(this.rectScratch);
      this.rectScratch = this.gpu.createBuffer({
        label: `sim${this.id} rect scratch`, size: Math.max(bytes, 1024), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      this._rectGroup = this.gpu.bindGroup(this.L.CONVERT, [{ binding: 0, resource: { buffer: this.rectScratch } }], 'rect scratch');
    }
    return this.rectScratch;
  }

  /**
   * Both state copies as they are at this call, atlas order, flags included
   * (tools/state-hash.mjs's copies line): { A: [copy0, copy1], B: […], F: […] }.
   */
  async readCopies() {
    const texels = this.g.width * this.g.height, rb = this.gpu.readback, wait = this._readyFor('toAtlas');
    if (wait) await wait;
    this.pingPong(true);
    const reads = [];
    for (const c of [0, 1]) {
      this._toAtlas(c, false);
      reads.push(rb.buffer(this.atlasScratch, 0, texels * 32));
      this._toAtlas(c, true);
      reads.push(rb.buffer(this.atlasScratch, 0, texels * 4));
    }
    this._dropAtlasScratch();
    const [ab0, f0, ab1, f1] = await Promise.all(reads);
    const ab = (x, k) => new Float32Array(x, k * texels * 16, texels * 4);
    return { A: [ab(ab0, 0), ab(ab1, 0)], B: [ab(ab0, 1), ab(ab1, 1)], F: [new Uint32Array(f0), new Uint32Array(f1)] };
  }

  /**
   * One cell of the current state as it is at this call: [a, b] in the
   * fetchA/fetchB layout. For tests and tools.
   * @returns {Promise<[Float32Array, Float32Array]>}
   */
  async readCell(x, y, z, { physical = false } = {}) {
    this.legacyState(physical);
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
   * The current map's list lengths (units AWAKE, DRAWN, MOVE1; bricks its
   * build's inert kernel redid), as they are at this call.
   * @returns {Promise<{ awake: number, drawn: number, move1: number, inert: number, units: number }>}
   */
  async readCounts() {
    const c = new Uint32Array(await this.gpu.readback.buffer(this.act, this.actLayout.count * 4, 32));
    return { awake: c[ACT_COUNTS.AWAKE], drawn: c[ACT_COUNTS.DRAWN], move1: c[ACT_COUNTS.MOVE1], inert: c[ACT_COUNTS.INERT_LAST], units: this.unit.units };
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
    this._dispatch(k, fold(g.nbricks), { bind: [this.tables, this.bindRO, this._refGroup], header: this.readHeader() });
    const w = new Uint32Array(await this.gpu.readback.buffer(this.refInert, 0, g.nbricks * 4));
    const out = new Uint8Array(g.nbricks);
    for (let id = 0; id < g.nbricks; id++) {
      const [bx, by, bz] = brickCoordOf(g, id);
      out[bx + g.bx * (by + g.by * bz)] = w[id];
    }
    return out;
  }

  /**
   * The move's owner check (debug builds, shaders/move.js ownerLayout): how many
   * cells some block covered a second time in one step, and each slot's stamp
   * (the last frame a running block covered it), as they are at this call;
   * null without debug.
   * @returns {Promise<{ dup: number, stamps: Uint32Array } | null>}
   */
  async readOwners() {
    if (!this.debug) return null;
    const o = ownerLayout(this.g);
    const w = new Uint32Array(await this.gpu.readback.buffer(this.marks, o.dup * 4, (o.words - o.dup) * 4));
    return { dup: w[0], stamps: w.subarray(1) };
  }

  /** The debug prelude's count of out-of-grid accesses (I2.8; 0 without debug). */
  async readDebug() {
    const at = marksLayout(this.g).dbg * 4;
    return new Uint32Array(await this.gpu.readback.buffer(this.marks, at, 4))[0];
  }

  /**
   * A read-only probe (docs/webgpu.md D6): `kernel` writes its result into a
   * slot of `ring` (a gpu.readback.ring, its buffer bound in the kernel's own
   * group), whose index it gets in its params as `slot`; the promise is that
   * slot's bytes. The caller owns the ring (its slot size is the probe's) and
   * gives every bind group but the params: groups 0-2, e.g. [sim.tables,
   * sim.bindRO (or bindAct), its own group holding ring.buffer].
   * @param {object} kernel a gpu.kernel whose params struct has a `slot: u32`
   * @param {number[]} size its dispatch size
   * @param {{ ring: object, bind: GPUBindGroup[], params?: object }} opts
   * @returns {Promise<ArrayBuffer>}
   */
  probe(kernel, size, { ring, bind = [], params = {} }) {
    const physical = !!this.compact && this.compact.isReadGroup(bind[1]);
    if (physical) {
      const state = this.bindPhysicalRO;
      if (!state) return null;
      bind = [...bind]; bind[1] = state;
    }
    const slot = ring.next();
    this._dispatch(kernel, size, { bind, header: physical ? this.readHeader({ physical: true }) : this.header(), params: { ...params, slot } });
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
   * post, moveSrc, moveSrcAt }), idle(f), reset(f) }. While active the move
   * runs out of place and records moveSrc: a u32 per slot at word moveSrcAt of
   * the moveSrc buffer (0, or past the decoration's plane when there is one).
   */
  attachAeration(aer) {
    this.aeration = aer ?? null;
    this._side();
  }

  /**
   * TPT's decoration layer (src/deco.js, U17; docs/webgpu.md Sync log S3):
   * { paint(stroke), beforeWrite(f, box), scrub(f, box), snapshot(t),
   * restore(t, dx, dz), shift(dx, dz, f), reset(), dispose() }, each
   * optional. An edit with { scrub: true } (the brush, a stamp, the console's
   * script) calls beforeWrite before its in-place write and scrub after it,
   * with the open frame and the box it writes ({ lo, hi }: inclusive grid
   * cells, clipped): the layer copies what it needs of the box's cells (their
   * element ids) in the first and clears the decoration of each cell whose
   * element changed in the second. The move carries its plane, a u32 per
   * slot (0: none), with the cells (shaders/move.js): sim.decoPlane says
   * where it is ({ buffer, offset, size } in bytes; it moves when whitewater
   * comes or goes, keeping its words: bind it again then). Only blocks that
   * run write it: a block that empties a cell clears its word, and air in a
   * skipped block keeps the word it had (main's gather rewrote every cell
   * each step). null detaches it. (Attach through here, not by setting
   * sim.deco: the plane is made here. Once attached, every running block of
   * the move reads and writes 8 more words while the layer's `active` isn't
   * false (decoCarried: an inactive layer keeps its plane all 0), so make it
   * on first use: decoFactory, ensureDeco.)
   */
  attachDeco(deco) {
    this.deco = deco ?? null;
    this._side();
  }
  // The decoration layer, made by decoFactory on first use if there is none (main's ensureDeco).
  ensureDeco() {
    if (!this.deco && this.decoFactory) this.attachDeco(this.decoFactory(this));
    return this.deco;
  }
  // (while Physics V2 owns the box the plane is its own, which its moves carry: src/v2/physics.js decoPlane)
  get decoPlane() { return this.sideDeco ? (this.compact?.decoPlane ?? { buffer: this.moveSrc, offset: 0, size: this.g.slots * 4 }) : null; }
  // Whether the move carries the plane this step: while the layer may hold
  // paint (deco.active; a layer without the flag always). An inactive
  // layer's plane is all 0, which the move would only permute.
  get decoCarried() { return this.sideDeco && this.deco?.active !== false; }
  // moveSrc's plane: after the decoration's when there is one
  get moveSrcAt() { return this.sideDeco ? this.g.slots : 0; }

  // The move's moveSrc buffer (its group 2, binding 1): the decoration plane at
  // word 0 and whitewater's moveSrc plane at moveSrcAt, a plane (one u32 per
  // slot) for each that is attached, or a 16-byte dummy. Remade when that
  // changes; the decoration plane is state, so it comes along.
  _side() {
    const slots = this.g.slots, deco = Boolean(this.deco);
    const size = Math.max(16, ((deco ? slots : 0) + (this.aeration ? slots : 0)) * 4);
    const had = this.sideDeco;
    this.sideDeco = deco;
    if (size === this.moveSrc.size && had === deco) return;
    const old = this.moveSrc;
    this.moveSrc = this.gpu.createBuffer({
      label: `sim${this.id} moveSrc${deco ? ' + deco' : ''}`, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    if (had && deco) this.gpu.frame.copy(old, 0, this.moveSrc, 0, slots * 4);
    this._retire(old);
    this._groups();
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
    this.nativeIntegration?.dispose();
    this.wake();   // an outstanding readback cannot certify a disposed simulation
    // what is recorded on these buffers goes out first: a destroyed buffer in a
    // later submit is a validation error, while one already submitted is freed
    // once the queue is done with it
    if (!this.gpu.failure) this.gpu.flush('sim dispose');
    const { A, B, F } = this.state;
    this.deco?.dispose?.();   // (its own buffers; its plane is moveSrc's, below)
    for (const b of [A, B, F, this.flow, this.moveSrc, this.marks, this.act, this.args, this.noDeposit, this.noRayBricks, this.noMask,
      this.paintMask, this.flowTmp, this.atlasScratch, this.rectScratch, this.editScratch, this.refInert]) b?.destroy();
    this.counts.close();
    for (const t of this.history) for (const b of [t.A, t.B, t.compact, t.aux, ...(t.dynamic?.buffers ?? [])]) b?.destroy();   // (an entry holds V1's copies or V2's)
    this.history = [];
  }
}

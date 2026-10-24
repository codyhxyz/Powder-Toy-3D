import { decodeWorldState } from './persistence.js';
import { NativeBrickStore, legacyBrickToNative, encodeNativeBrick } from './nativeStore.js';
import { BRICK } from '../shaders/common.js';
import { leaveHeadBytes, LEAVE_BRICK_BYTES } from '../shaders/generate.js';
import { WorldGenerator } from './gpu.js';
import { WORLD_SEED } from './generator.js';
import { island } from './scenes/island.js';
import { runGenerator, bake } from '../constructions/runtime.js';
import { BUILTINS } from '../constructions/builtins.js';
import { BrickStore, encodeBrick, BRICK_FLOATS } from './store.js';
import { farLayout, farSceneLayout } from '../shaders/far.js';
import { WorldRenderSource, dropNativeWorldSource, nativePackOf, nativeSourceReady } from './renderSource.js';
import { RawWorldSourceProducer } from './renderSourceProducer.js';
import { physicsOnlyFor, ringedFor, MOVE_CPU_BUDGET_MS, LeaveQueue, moveSlabs, movePlan, slabBase, slabBrick, slabsOverlap } from './physicsRegion.js';
import { WorldCopyFill } from './copyFill.js';

// The window over a massive world (docs/scaling.md D11, phases W1 and W2;
// docs/webgpu.md G1).
//
// The simulation's grid is a window into a world of `size` cells that the
// generator defines everywhere. sim.origin is the window's world cell: a
// multiple of WIN_STEP on x and z, 0 on y (the window spans the world's
// height). Each frame update(focus) keeps it centred on the focus (the POV
// body, else the orbit target): when the focus is more than WIN_STEP +
// WIN_HYSTERESIS cells from the window's centre along x or z, the window
// moves WIN_STEP that way, at most once per frame.
//
// A move, all of it recorded into the frame's encoder (docs/webgpu.md B3):
//   1. the slab about to leave is compared with the generator brick by brick
//      and its differing bricks gathered, in one kernel (shaders/generate.js
//      sceneDiffFrag); the count, their keys and a prefix of their cells are
//      read back asynchronously (one round trip unless more differ than the
//      last move's estimate): the bricks that match leave the store, the ones
//      that differ go into it (world/store.js);
//   2. Simulation.shift moves the state and the flow, and the derived passes
//      and whitewater move theirs (sim.onShift: the render fields, bricks and
//      GI by whole bricks, only the slab and the edges re-aged);
//   3. the generator fills the slab the move uncovers (an edit over it), then
//      that slab's stored bricks are written back (another: restore);
//   4. the scene's trees (scene.trees: the island's) are stamped into the
//      brick columns the move visits for the first time, clipped to those
//      columns (the planted record): a tree is planted once, piece by piece as
//      its columns are first visited, and comes back from the store as edits
//      after that.
// No syncCopies after it (docs/webgpu.md D6, G1): the shift forces every
// unit, so the next step's react rewrites the other copy before anything
// reads it, and the slab's edits mark the bricks they change.
// No move starts while a leaving slab is still being read back, so the store
// holds everything a move can bring back, and the slab's buffers aren't
// written again before they are read.
//
// The far field (world/far.js), when the app gives the window one (far), is
// built on load, summarizes the slab about to leave in step 1, and sweeps over
// the window's region while it changes (update).
//
// What the world holds is its scene (world/scenes): P = scene.params. The
// generator (world/gpu.js) runs the scene's sceneCell for the fill and the
// diff, its resources (uniforms, data, the island's baked columns) made once
// it has prepared; whenReady builds the window's kernels and the far field's
// meanwhile, and the app loads the world once they are ready, so switching to
// a world never stalls the page on a pipeline: the window fills in, then the
// far field around it. Until load the window doesn't move.
//
// The seamless world (docs/seamless-world.md, world/physicsRegion.js): with PHYSICS_ONLY_MOVE (the lead's
// switch; physicsOnlyFor: the census maps) a move records no picture work (no derived, occupancy, far field or render source), and with a
// world copy attached (attachWorldCopy) the slab is filled from the copy, trees and all, with no CPU
// baking. Either way the leaving slab is read back as before and its bricks coded into the stores outside
// the frame, in budgeted slices (LeaveQueue); a move waits only for the readback to land, and finishes
// the coding first only of a slab it brings back.

function trackLanding(win, landing) {
  if (!landing) return;
  const epoch = win.epoch;
  const pending = Promise.resolve(landing).catch((err) => {
    if (epoch === win.epoch) win.persistenceError = win.readbackError = err;
    if (!win.gpu.failure) console.error('world window: leaving slab readback failed; native streaming/saving is blocked', err);
  }).finally(() => { win.storeReads.delete(pending); });
  win.storeReads.add(pending);
}

const FRAME_MS = 1000 / 60;            // a frame at 60 Hz: what a streaming loop waits when nothing else says when to look again
export const WIN_STEP = 16;          // cells: how far the window moves at a time (whole supertiles along x and z)
export const WIN_HYSTERESIS = 4;     // cells past WIN_STEP from the centre the focus goes before a move
// cells short of a move's threshold the focus comes before the move's fill is staged (stageAhead): a
// walker crosses 8 cells in seconds, so the stage lands frames before the move; a faster focus can reach
// the move first, which then fills in its own frame as before
export const STAGE_LEAD = 8;
const BAKED_KEEP = 256;              // baked trees kept: a tree straddling slabs is stamped once per slab
const READ_MIN = 64;                 // bricks of a leaving slab's cells read with its count at least...
const READ_AHEAD = 1.5;              // ...or this many times the last move's (a second read fetches the rest)

// Any of brick i's 64 energy banks nonzero (captureSlabRaw's banks): the native store keeps it.
const banked = (banks, i) => { for (let j = i * 64; j < i * 64 + 64; j++) if (banks[j] !== 0) return true; return false; };

export class WorldWindow {
  // sim: the window's Simulation (its grid spans the world's height); size:
  // the world in cells [x, y, z]; seed: its seed (the generator's default
  // world's without one); scene: what it holds (world/scenes). (The first
  // argument was the WebGL renderer; the window works on the sim's device.)
  constructor(_renderer, sim, { size, seed = WORLD_SEED, scene = island }) {
    const g = sim.g;
    if (g.ny !== size[1]) throw new Error(`window ${g.ny} cells tall in a world ${size[1]} tall: it spans the world's height`);
    if (size.some((n, i) => n % WIN_STEP && i !== 1)) throw new Error(`world ${size}: x and z must be multiples of ${WIN_STEP}`);
    this.sim = sim;
    sim.worldWindow = this;
    this.historyIdentity = {};
    this.historyReaders = 0;
    this.gpu = sim.gpu;
    this.size = size;
    this.scene = scene;
    this.P = scene.params({ size, seed });
    // its own generator, not generatorFor's shared one: tools run two windows
    // (its prepass room covers the far field's chunks too: world/far.js)
    const S = farSceneLayout(farLayout(size));
    this.gen = new WorldGenerator(sim, scene, this.P, { regions: [[S.side, size[1], S.side]] });
    this.wb = size.map((n) => n / BRICK);                          // the world in bricks
    this.store = new BrickStore(this.wb);
    this.nativeStore = new NativeBrickStore(this.wb); // exact core+bank; projection never decides whether to retain
    this.planted = new Uint8Array(this.wb[0] * this.wb[2]);       // brick columns whose trees are in
    this.baked = new Map();
    this.candidates = new Map();                                  // tree candidates by brick column (treesIn)
    this.storeReads = new Set();                                  // the leaving slabs' readbacks in flight (pending)
    this.held = null;                                             // a writer's transaction holding the window (pending =)
    this.leaveQueue = new LeaveQueue();                           // ...and their coding into the stores, once landed
    this.physicsOnly = physicsOnlyFor(scene);                     // a move records no picture work (physicsRegion.js)
    sim.setRinged(ringedFor(scene));                              // ...and copies nothing (ring addressing: sim.js _shiftRing)
    this.worldCopy = null;                                        // W's world copy, once attached (attachWorldCopy)
    this.copyFill = null;                                         // its slab fill (world/copyFill.js)
    this.storeRevisions = new Map();
    this.readbackError = null;
    this.capturing = false;
    this.epoch = 0;                                               // bumped by load and dispose: older readbacks are dropped
    this.last = null;                                             // what the last move cost (tools)
    this.plantCost = null;                                        // the move's tree placing and baking, ms (tools)
    this.far = null;                                              // the far field (world/far.js), if the app draws one
    this.loaded = false;                                          // load has filled the window (it moves only after)
    this.ready = null;                                            // whenReady's promise
    this.lastKept = 0;                                            // bricks the last leaving slab kept (its readback's estimate)

    // the largest slab a move exchanges: its buffers, made once
    const step = WIN_STEP / BRICK, BX = g.nx / BRICK, BY = g.ny / BRICK, BZ = g.nz / BRICK;
    this.maxBricks = Math.max(step * BY * BZ, BX * BY * step);
    this.leave = this.gen.diffBuffers(this.maxBricks);
    this.renderSource = new WorldRenderSource(this);
    this.sourceProducer = new RawWorldSourceProducer(this, this.renderSource);
  }

  // What the stores still wait for: the leaving slabs' readbacks in flight (a promise), else null. Once
  // they have landed, any coding still queued is finished now, so a reader (a save, a capture, a restore)
  // sees the whole store. (A move waits on the readbacks alone: update, blocker.)
  // A writer outside the window may hold it the same way (pov/importedInteractions.js sets pending to
  // its transaction, and back to null): it blocks moves as a readback does.
  get pending() {
    const read = this.storeReads.values().next().value ?? this.held;
    if (read) return read;
    if (this.leaveQueue.busy) this.leaveQueue.flush();
    return null;
  }
  set pending(p) { this.held = p ?? null; }
  // What a move waits for (never the coding): a readback in flight, or a writer holding the window.
  get _moveWait() { return this.storeReads.values().next().value ?? this.held ?? null; }

  // The world copy (W's WorldCopy, docs/seamless-world.md) the window fills its slabs from: wgsl is its
  // module (worldCopyWGSL, declaring group 1 and wcCell). Moves fill from it once its kernel is built and
  // V2 runs the grid; until then, and without one, from the generator with the trees baked (plant).
  attachWorldCopy(copy, { wgsl }) {
    this.worldCopy = copy;
    this.copyFill = copy ? new WorldCopyFill(this, copy, { wgsl }) : null;
    return this.copyFill?.ready ?? Promise.resolve();
  }

  // The version a leaving slab's bricks go into the stores at (later ones win): the render source's
  // revision (on a physics-only move only its counter, which stays monotonic if the switch flips).
  _token() { return this.physicsOnly ? { revision: this.renderSource.nextRevision() } : this.renderSource.token(); }

  // Mark the brick columns of grid cells [lo, hi) planted: their trees came with the world copy.
  markPlanted(lo, hi) {
    const o = this.sim.origin, w0 = [lo[0] + o.x, lo[2] + o.z].map((v) => v / BRICK), w1 = [hi[0] + o.x, hi[2] + o.z].map((v) => v / BRICK);
    for (let z = w0[1]; z < w1[1]; z++) for (let x = w0[0]; x < w1[0]; x++) this.planted[z * this.wb[0] + x] = 1;
  }

  // Resolves once the window's kernels and the far field's are built and the
  // scene has prepared (started in the background on the first call; give the
  // window its far field first): load and the moves then record at once.
  whenReady() {
    if (this.sim.compactOwner) this.gen.prepareNativeDiff?.();   // (V2's leaving slab: not awaited, see update)
    // V2: the source's native read of its cells (renderSource.js nativePackOf), which every copy of the window uses
    const pack = this.sim.compactOwner ? nativePackOf(this.sim)?.kernel.ready : null;
    return (this.ready ??= Promise.all([
      this.gen.ready, this.gen.prepareDiff(), this.sourceProducer.ready, this.sim.prepare('fresh'), this.far?.whenReady?.(), pack,
    ]).then(() => this));
  }

  // The origin that centres the window in the world.
  centre() {
    const g = this.sim.g, snap = (n) => Math.round(n / WIN_STEP) * WIN_STEP;
    return [snap((this.size[0] - g.nx) / 2), 0, snap((this.size[2] - g.nz) / 2)];
  }

  // (Re)load the world from the generator with the window at `origin`: no
  // edits, nothing planted. A whole-grid write (docs/webgpu.md D6): the next
  // map draws every unit, so no syncCopies follows (G1). Needs whenReady.
  load(origin = this.centre()) {
    if (this.sim.nativeTransitionKind === 'shift') throw new Error('Cannot replace a world during its native shift');
    const sim = this.sim, g = sim.g;
    this.historyIdentity = {};
    this.epoch++;   // a slab of the old world still being read back is dropped
    this.leaveQueue?.clear();
    this.renderSource.reset(this.epoch);
    this.storeRevisions.clear();
    this.store.clear();
    this.nativeStore.clear();
    this.persistenceError = null;
    this.readbackError = null;
    this.scene.reset?.();   // imported interaction state is per loaded run, not per cached scene
    sim.deco?.reset();   // the decoration and its store go too (src/deco.js)
    this.planted.fill(0);
    sim.origin.set(origin[0], 0, origin[2]);
    sim.resetNativeDynamics();
    if (this.copyFill?.fill([origin[0], 0, origin[2]], [0, 0, 0], [g.nx, g.ny, g.nz])) this.markPlanted([0, 0, 0], [g.nx, g.ny, g.nz]);
    else {
      this.gen.fill(this.P, [origin[0], 0, origin[2]]);
      if (this.scene.trees) this.plant([0, 0, 0], [g.nx, g.ny, g.nz]);
    }
    // Under V2 the fill and the trees wrote its cores (WorldGenerator.fill, the producer's apply), noting
    // their bricks: a whole-grid note would reimport V1's cache over them. That cache was the old
    // origin's projection: the next export rewrites all of it (BRIDGE.ALL).
    const v2 = sim.compact?.isReady ? sim.compact : null;
    if (v2) v2.legacyNative = undefined;
    sim.noteWrite({ replaceState: !v2 });
    if (!this.physicsOnly) this.far?.build();
    sim.dropHistory();   // undo would bring back a window of the old world
    // a new scene: the render fields and GI start over instead of blending in, and nothing is moving
    sim.fieldReset = sim.giReset = true;
    sim.stillFlow();
    this.loaded = true;
  }

  // A saved world back (saves/game.js): the window at `origin`, its cells
  // from fillState() (it loads the saved state into the simulation: a
  // whole-grid write), the stored bricks (BrickStore.toBytes) and the planted
  // brick columns as they were saved. Like load, it drops undo and starts the
  // derived passes over. The far field is rebuilt from the scene and the
  // window: stored edits outside the window show from afar once the window has
  // passed over them.
  loadSaved(origin, fillState, storeBytes, planted, interactions = null, nativeBytes = null) {
    const sim = this.sim;
    const next = decodeWorldState({ size: this.size, origin }, [sim.g.nx, sim.g.ny, sim.g.nz], storeBytes, planted, nativeBytes);
    if (sim.nativeTransitionKind === 'shift') throw new Error('Cannot load during a native world shift');
    this.scene.interactionState?.restore(interactions);
    this.historyIdentity = {};
    this.epoch++;
    this.leaveQueue?.clear();
    this.persistenceError = null;
    this.renderSource.reset(this.epoch);
    this.storeRevisions.clear();
    this.store.map = next.store.map; this.store.bytes = next.store.bytes;
    this.nativeStore.map = next.nativeStore.map; this.nativeStore.bytes = next.nativeStore.bytes;
    this.planted.set(next.planted);
    sim.origin.set(origin[0], 0, origin[2]);
    fillState();
    if (!this.physicsOnly) this.far?.build();
    sim.dropHistory();
    sim.fieldReset = sim.giReset = true;
    this.loaded = true;
  }

  // Acquire synchronously before save preparation can yield. Existing shifts
  // may finish their already-recorded transition/readback; only NEW shifts are
  // excluded, so waiting for this.pending while holding the lock cannot deadlock.
  acquireReadLock() {
    this.historyReaders = (this.historyReaders ?? 0) + 1;
    let released = false;
    return () => { if (!released) { released = true; this.historyReaders--; } };
  }

  // What a move toward the focus waits for now, or null when update() decides: the last move's
  // leaving slab (and the decoration's), and under V2 the window's pipelines and dynamics, which may
  // still be building after the world loads. A streaming loop (the city bus, a mode's drop-in:
  // wire/world.js streamToFocus) waits on it, so a move that can't be made yet is never taken for
  // the window having arrived.
  // (The move needs its own kernel, built with the grid, not the rest of the dynamics, which build
  // behind it; a request held for their build is in window cells, so a move waits for them to take it,
  // a frame after they are built: sim.nativePending.)
  blocker() {
    if (!this.loaded || this.persistenceError || this.capturing) return null;
    const sim = this.sim, waits = [this._moveWait, sim.deco?.pending];
    if (!this.physicsOnly && sim.compact && !nativeSourceReady(sim)) waits.push(nativePackOf(sim)?.kernel.ready);
    if (this.gen.nativeReady === false) waits.push(this.gen.prepareNativeFill());
    if (sim.compactOwner && (sim.nativeTransition || !sim.nativeCapabilities.world)) {
      const owner = sim.compactOwner;
      waits.push(sim.nativeTransition ?? Promise.all([sim.prepareNative(), owner.dynamics?.windowBuilt,
        sim.nativePending?.length ? owner.dynamicsReady : null]).then(() => new Promise((r) => setTimeout(r, FRAME_MS))));
    }
    const pending = waits.filter(Boolean);
    return pending.length ? Promise.all(pending).then(() => {}, () => {}) : null;
  }

  // Keep the window centred on the focus (world cells, x and z). Returns the
  // move made, [dx, dz] world cells, or null.
  update(fx, fz) {
    if (!this.loaded || this.persistenceError || this.sim.nativeTransition || this.historyReaders) return null;
    if (!this.physicsOnly) this.far?.tick();
    if (this.capturing || this._moveWait || this.sim.deco?.pending) return null;
    if (this.sim.compactOwner && !this.sim.nativeCapabilities.world) return null;
    // (V2: the leaving slab's copy reads its cells natively: renderSource.js nativePackOf)
    if (!this.physicsOnly && this.sim.compact && !nativeSourceReady(this.sim)) return null;
    if (this.gen.nativeReady === false) { this.gen.prepareNativeFill(); return null; }   // (and its fill writes V2's cells)
    // V2's leaving slab keeps what differs from the generator (readBack); a
    // grid V2 came to after load builds it now, keeping everything meanwhile
    if (this.sim.compactOwner) this.gen.prepareNativeDiff?.();
    const g = this.sim.g, o = this.sim.origin, lim = WIN_STEP + WIN_HYSTERESIS;
    const off = [fx - (o.x + g.nx / 2), fz - (o.z + g.nz / 2)];
    const at = [o.x, o.z], span = [g.nx, g.nz], world = [this.size[0], this.size[2]];
    let best = null;
    for (const axis of [0, 1]) {
      const excess = Math.abs(off[axis]) - lim, d = Math.sign(off[axis]) * WIN_STEP;
      const fits = at[axis] + d >= 0 && at[axis] + d + span[axis] <= world[axis];
      if (excess > 0 && fits && (!best || excess > best.excess)) best = { axis, d, excess };
    }
    if (!best) { this.stageAhead(off, at, span, world); return null; }
    const move = best.axis ? [0, best.d] : [best.d, 0];
    this.shift(...move);
    return move;
  }

  // The fill of the move the focus nears, worked out now (world/copyFill.js stage), in a frame without a
  // move, so the move's own frame only writes it (commitStaged): within STAGE_LEAD cells of a move's
  // threshold, the nearest such move. off: the focus from the window's centre; at, span, world: the
  // window's x/z origin and size and the world's (update's).
  stageAhead(off, at, span, world) {
    const fill = this.copyFill;
    if (!fill?.stageReady || !this.physicsOnly || !this.sim.compact?.isReady) return false;
    const lim = WIN_STEP + WIN_HYSTERESIS;
    let near = null;
    for (const axis of [0, 1]) {
      const excess = Math.abs(off[axis]) - lim, d = Math.sign(off[axis]) * WIN_STEP;
      const fits = d && at[axis] + d >= 0 && at[axis] + d + span[axis] <= world[axis];
      if (fits && excess > -STAGE_LEAD && (!near || excess > near.excess)) near = { axis, d, excess };
    }
    if (!near) return false;
    const [dx, dz] = near.axis ? [0, near.d] : [near.d, 0], { enterLo, enterHi, leaveLo, size } = moveSlabs(this.sim.g, dx, dz);
    const o = this.sim.origin, O = [o.x, o.y, o.z];
    if (!fill.stage([o.x + dx, o.y, o.z + dz], enterLo, enterHi)) return false;
    // and the leaving slab's diff's prepass (WorldGenerator.diff), which the move then finds done
    // (SceneGpu.prepass keeps the box it holds)
    this.gen.res.prepassFor(leaveLo.map((v, i) => v + O[i]), leaveLo.map((v, i) => v + O[i] + size[i]));
    return true;
  }

  // Capture every resident brick through the existing bounded slab diff/readback,
  // retaining off-resident edits already in the store. Caller must freeze state
  // writers for the entire operation; update() cannot move this window meanwhile.
  // A Physics V2 window also reads every resident brick's exact native cells
  // into nativeStore, slab by slab, as a leaving slab's are (captureSlab).
  async captureEdits() {
    if (!this.loaded || this.capturing) throw new Error('Window is not available for edit capture');
    this.capturing = true;
    const epoch = this.epoch, g = this.sim.g, origin = this.sim.origin, native = !!this.sim.compactOwner;
    const check = () => {
      if (this.readbackError) throw this.readbackError;
      if (this.persistenceError) throw this.persistenceError;
      if (epoch !== this.epoch || this.sim.disposed) throw new Error('Window changed during edit capture');
      if (this.gpu.failure) throw this.gpu.failure;
    };
    try {
      await this.pending;
      if (native && !(await this.sim.prepareNative())) throw new Error('Native terrain capture has no native integration');
      check();
      for (let x=0;x<g.nx;x+=WIN_STEP) {
        const lo=[x,0,0], bricks=[Math.min(WIN_STEP,g.nx-x)/BRICK,g.ny/BRICK,g.nz/BRICK];
        // Nothing moves: the store takes the resident cells at the source's current revision.
        const capture = this._token();
        const nativeRead = native ? this.sim.nativeIntegration.captureSlabRaw(lo, bricks) : null;
        const { exact } = this.leaveDiff(lo, bricks, this.leave, !!nativeRead);
        this.readBack([origin.x/BRICK+x/BRICK,0,origin.z/BRICK],bricks,capture,this.leave,nativeRead,exact);
        await this.pending;
        check();
      }
      this.leaveQueue.flush();   // (the last slab's bricks, still queued)
      check();
      return this.store;
    } finally { this.capturing = false; }
  }

  // A band cache supplies its complete compressed store after the normal load.
  // Restore in bounded slabs too: a fully edited tall window can exceed the
  // device's storage-buffer limit if uploaded as one dense restore operation.
  // native: the band's exact native bricks (TerrainEditCache.seedNative) for a
  // Physics V2 window: restored over the legacy bricks, as a shift restores.
  async restoreEdits(store, native = null) {
    if (!this.loaded || this.pending) throw new Error('Window is not ready for edit restore');
    if (!store.bricks.every((n,i)=>n===this.wb[i])) throw new Error('Edit store dimensions do not match window');
    if (native && !native.bricks.every((n,i)=>n===this.wb[i])) throw new Error('Native edit store dimensions do not match window');
    const epoch=this.epoch, g=this.sim.g, owned = !!this.sim.compactOwner;
    // (the window loads before V2's window kernels finish building)
    if (owned && !(await this.sim.prepareNative())) throw new Error('Native terrain restore has no native integration');
    if (this.epoch !== epoch || this.sim.disposed || this.pending) throw new Error('Window changed during edit restore');
    this.store.clear();
    for (const [key,bytes] of store.map) this.store.put(key,bytes);
    if (owned) {
      this.nativeStore.clear();
      for (const [key, bytes] of native?.map ?? []) this.nativeStore.put(key, bytes);
    }
    const slabs = [];
    for (let x=0;x<g.nx;x+=WIN_STEP) slabs.push([[x,0,0],[Math.min(WIN_STEP,g.nx-x)/BRICK,g.ny/BRICK,g.nz/BRICK]]);
    for (const [lo, bricks] of slabs) this.restore(lo, bricks);
    if (owned) for (const [lo, bricks] of slabs) this.restoreNative(lo, bricks);
    await this.gpu.fence();
    if (this.gpu.failure) throw this.gpu.failure;
    if (this.epoch !== epoch || this.sim.disposed) throw new Error('Window changed during edit restore');
  }

  // Move the window by (dx, 0, dz) world cells (one of them 0): steps 1–4 above.
  // Under either engine the move is made in the frame, as V1's always was: V2's
  // dynamics move with its cells in the same encoder (v2/integration.js shift),
  // so the world, the body and the tools never wait on it. What can refuse a
  // move is checked before anything moves.
  shift(dx, dz) {
    if (this.capturing) throw new Error('Cannot shift a window during edit capture');
    if (this.persistenceError) throw this.persistenceError;
    if (this.historyReaders) throw new Error('World history capture is pending');
    if (this.sim.compactOwner && this._moveWait) throw new Error('World shift while leaving slab is pending');
    if (this.sim.compactOwner && !this.sim.nativeCapabilities.world) throw new Error('Native world shift is not ready');
    if (this.sim.compact && ((!this.physicsOnly && !nativeSourceReady(this.sim)) || this.gen.nativeReady === false)) throw new Error('Native world source is not ready');
    return this._shiftCommitted(dx, dz);
  }
  // A V2 move's leaving slab of dynamics (its air and requests: NativeDynamics.recordWindowShift) is
  // read back beside the cells' (readBack): the next move waits for both, and a failed read freezes
  // the window as a failed cell read does, never the world.
  _trackDynamics(landing) { trackLanding(this, landing); }
  _shiftCommitted(dx, dz) {
    const t0 = performance.now();
    const sim = this.sim, g = sim.g, picture = !this.physicsOnly;
    // the slab that leaves (grid cells before the move) and the one the move uncovers (after it)
    const { leaveLo, enterLo, enterHi, bricks } = moveSlabs(g, dx, dz);
    const oldOrigin = [sim.origin.x, sim.origin.y, sim.origin.z], leaveB = slabBase(oldOrigin, leaveLo);
    const plan = movePlan({ physicsOnly: this.physicsOnly, worldCopy: !!this.copyFill?.isReady, native: !!sim.compactOwner, trees: !!this.scene.trees });
    let capture = null, o = null, incoming = null, restored = 0, trees = 0, staged = false;
    this.plantCost = { placeMs: 0, bakeMs: 0 };
    for (const step of plan) switch (step) {
      case 'leaveSource':
        // Source capture MUST precede diff/readback and sim.shift's mutation of
        // origin/cur. Its immutable offsets also cover a delayed-save return.
        capture = this.renderSource.recordLeavingCopy(this.gpu.frame, sim, {
          lo: leaveLo.map((v, i) => v + oldOrigin[i]), hi: leaveLo.map((v, i) => v + bricks[i] * BRICK + oldOrigin[i]),
        }, oldOrigin);
        break;
      case 'leaveCapture': {   // 1.
        capture ??= this._token();
        const nativeRead = sim.nativeIntegration?.captureSlabRaw(leaveLo, bricks) ?? null;
        const out = this.storeReads.size ? this.gen.diffBuffers(this.maxBricks) : this.leave;
        const { exact } = this.leaveDiff(leaveLo, bricks, out, !!nativeRead);
        this.readBack(leaveB, bricks, capture, out, nativeRead, exact);
        break;
      }
      case 'leaveDeco':   // the decoration of the slab that leaves goes into its own store (src/deco.js)
        sim.deco?.leave(leaveLo, bricks, (x, y, z) => this.store.key(leaveB[0] + x, leaveB[1] + y, leaveB[2] + z));
        break;
      case 'leaveFar': this.far?.summarize(leaveLo, bricks); break;
      case 'shift': {   // 2.
        sim.shift(dx, dz, { picture });
        if (sim.compactOwner) trackLanding(this, sim.nativeIntegration?.landing);
        o = [sim.origin.x, sim.origin.y, sim.origin.z];
        incoming = { lo: enterLo.map((v, i) => v + o[i]), hi: enterHi.map((v, i) => v + o[i]) };
        // an earlier leaving slab this one brings back is coded into the stores first (rare: a step back)
        const enter = { base: slabBase(o, enterLo), bricks };
        this.leaveQueue.flush((job) => slabsOverlap(job.slab, enter));
        break;
      }
      // 3.
      case 'fillCopy':   // (staged a frame or more ahead when the focus neared the move: update, stageAhead)
        if (this.copyFill.commitStaged(o, enterLo, enterHi, { picture })) staged = true;
        else this.copyFill.fill(o, enterLo, enterHi, { picture });
        this.markPlanted(enterLo, enterHi);
        break;
      case 'fillGenerator': this.gen.fill(this.P, o, enterLo, enterHi); break;
      // Preserve exact saved words BEFORE restore's floating equality can skip
      // signed-zero-only changes and before it drops the store entries.
      case 'sourceStore': this.renderSource.recordStore(incoming); break;
      case 'restoreLegacy': restored = this.restore(enterLo, bricks); break;
      case 'enterDeco':
        sim.deco?.enter(enterLo, bricks, (x, y, z) => this.store.key(o[0] / BRICK + enterLo[0] / BRICK + x, y, o[2] / BRICK + enterLo[2] / BRICK + z));
        break;
      // A native world restores every retained brick exactly (restoreNative,
      // below). Its captured cells are only V2's lossy projection, and their
      // fresh-flags write would make V2 reimport the whole window from it.
      case 'sourceCaptured': this.renderSource.restoreCaptured(this.gpu.frame, sim, incoming); break;
      case 'plant': trees = this.plant(enterLo, enterHi); break;   // 4.
      // Import only generator-owned coordinates, then restore exact retained
      // material after all legacy stamps. Untouched overlap is never imported.
      case 'restoreNative': this.restoreNative(enterLo, bricks, { picture }); break;
      default: throw new Error(`world move: unknown step ${step}`);
    }
    const ms = performance.now() - t0;
    this.last = { dx, dz, ms, overBudget: ms > MOVE_CPU_BUDGET_MS, plan, restored, trees, staged, ...this.plantCost, readbackMs: null, kept: null };
  }

  // The leaving slab's diff (step 1), into out: V2's (its head picks what both stores keep) when the
  // window reads the slab's native bricks (native). (A V2 owner suspended under V1, and the second,
  // native-only diff head it needed, went with V1.)
  leaveDiff(lo, bricks, out, native) {
    return { exact: this.gen.diff(this.P, lo, bricks, out, { native }) === true };
  }

  // Read the leaving slab back (its kernel recorded just before): the count,
  // the kept bricks' keys and a prefix of their cells, one round trip unless
  // more bricks differ than the estimate (then a second for the rest). The
  // bricks that match the generator leave the store, the ones that differ go
  // into it. base is slab brick 0's world brick.
  // nativeRead: a V2 window's exact bricks of the slab (NativeIntegration.captureSlab).
  // exact: the head came from V2's diff (WorldGenerator.diff), so it lists the
  // bricks whose cores differ from the generator's import. The native store then
  // keeps those and any with a nonzero energy bank, and lets the rest go as V1's
  // store lets a matching brick go: coming back, it is generated and imported
  // again, bit for bit (shaders/v2/leave.js). Without it every native brick stays.
  readBack(base, bricks, capture, out = this.leave, nativeRead = null, exact = false) {
    const n = bricks[0] * bricks[1] * bricks[2], rb = this.gpu.readback, epoch = this.epoch;
    const est = Math.min(n, Math.max(READ_MIN, Math.ceil(this.lastKept * READ_AHEAD)));
    const t0 = performance.now(), last = () => this.last;
    // (both copies are recorded now, at the request: docs/webgpu.md B7)
    const head = rb.buffer(out.head, 0, Math.ceil(leaveHeadBytes(n) / 4) * 4);
    const cells = rb.buffer(out.cells, 0, est * LEAVE_BRICK_BYTES);
    const pending = Promise.all([head, cells, nativeRead]).then(async ([h, c, native]) => {
      if (epoch !== this.epoch) return;
      const t1 = performance.now();
      const words = new Uint32Array(h), count = Math.min(words[0], n);
      let floats = new Float32Array(c);
      if (count > est) {
        // more differ than the estimate: the rest of them (the buffer is ours until this read lands)
        const rest = new Float32Array(await rb.buffer(out.cells, est * LEAVE_BRICK_BYTES, (count - est) * LEAVE_BRICK_BYTES));
        if (epoch !== this.epoch) return;
        const all = new Float32Array(count * LEAVE_BRICK_BYTES / 4);
        all.set(floats);
        all.set(rest, floats.length);
        floats = all;
      }
      this.lastKept = count;
      const L = last();
      if (L) Object.assign(L, { flagsMs: t1 - t0, readbackMs: t1 - t0, kept: count, landedAt: performance.now() });
      // Landed: the coding goes to the queue, a slice at a time outside the frame (physicsRegion.js).
      this.leaveQueue.add({
        slab: { base, bricks },
        steps: this._codeSlab(epoch, base, bricks, words, count, floats, native, exact, capture),
        done: () => { if (L && epoch === this.epoch) Object.assign(L, { keepMs: performance.now() - t1, codedAt: performance.now() }); },
        fail: (err) => {
          if (epoch === this.epoch) this.persistenceError = this.readbackError = err;
          if (!this.gpu.failure) console.error('world window: leaving slab coding failed; native streaming/saving is blocked', err);
        },
      });
    }).catch((err) => {
      if (epoch === this.epoch) this.persistenceError = this.readbackError = err;
      if (!this.gpu.failure) console.error('world window: leaving slab readback failed; native streaming/saving is blocked', err);
    }).finally(() => {
      this.storeReads.delete(pending);
      if (out !== this.leave) for (const b of [out.head, out.cells]) this.sim._retire(b);
    });
    this.storeReads.add(pending);
  }

  // The leaving slab's bricks into the stores, a brick a step (readBack queues it): the bricks that
  // match the generator leave the store, the ones that differ go into it (V1's projection of them, and
  // under V2 their exact cells: native, captureSlabRaw's). Only the bricks a store keeps are coded.
  *_codeSlab(epoch, base, bricks, words, count, floats, native, exact, capture) {
    const n = bricks[0] * bricks[1] * bricks[2], keep = new Set(), newer = (key) => (this.storeRevisions.get(key) ?? -1) > capture.revision;
    for (let s = 0; s < count; s++) {
      if (epoch !== this.epoch) return;
      const key = words[1 + s];
      keep.add(key);
      if (!newer(key)) {
        this.store.put(key, encodeBrick(floats, s * 2 * BRICK_FLOATS, floats, s * 2 * BRICK_FLOATS + BRICK_FLOATS));
        this.storeRevisions.set(key, capture.revision);
      }
      yield;
    }
    const keys = this.physicsOnly ? null : [];
    for (let i = 0; i < n; i++) {
      if (epoch !== this.epoch) return;
      const [x, y, z] = slabBrick(i, bricks), key = this.store.key(base[0] + x, base[1] + y, base[2] + z);
      if (!keep.has(key) && !newer(key)) { this.store.drop(key); this.storeRevisions.set(key, capture.revision); }
      const differs = !exact || keep.has(key);
      if (native && (differs || banked(native.banks, i))) this.nativeStore.put(key, encodeNativeBrick(native.cores, native.banks, i));
      else this.nativeStore.drop(key);
      keys?.push(key);
      yield;
    }
    if (keys) this.renderSource.commitStoreRevision(keys, capture);
  }

  // Take the stored bricks of the slab of grid cells [lo, lo + 4·bricks) out of V1's store, for
  // restoreNative: V2 brings each back exact from its own store, and a brick only V1's store kept (a
  // V1-made world save) is decoded into V2's cells as V2's import makes them (nativeStore.js
  // legacyBrickToNative) first. V1's restore edit went with V1. Returns how many.
  restore(lo, bricks) {
    const sim = this.sim, o = sim.origin, native = !!(sim.compactOwner?.isReady && sim.nativeIntegration?.isReady);
    const lb = lo.map((v) => v / BRICK), ob = [o.x / BRICK, o.y / BRICK, o.z / BRICK], keys = [];
    for (let bz = 0; bz < bricks[2]; bz++)
      for (let by = 0; by < bricks[1]; by++)
        for (let bx = 0; bx < bricks[0]; bx++) {
          const key = this.store.key(ob[0] + lb[0] + bx, ob[1] + lb[1] + by, ob[2] + lb[2] + bz);
          if (!this.store.has(key)) continue;
          if (!native) throw new Error('World restore needs the native owner: await sim.prepareNative()');
          const nativeKey = this.nativeStore.key(ob[0] + lb[0] + bx, ob[1] + lb[1] + by, ob[2] + lb[2] + bz);
          if (!this.nativeStore.map.has(nativeKey)) this.nativeStore.put(nativeKey, legacyBrickToNative(this.store.map.get(key)));
          keys.push(key);
        }
    for (const key of keys) this.store.drop(key);
    return keys.length;
  }

  restoreNative(lo, bricks, { picture = true } = {}) {
    const sim = this.sim, native = sim.nativeIntegration;
    if (!native?.isReady) return 0;
    sim.compactOwner.sync();
    const o = sim.origin, base = [o.x, o.y, o.z].map((v, i) => (v + lo[i]) / BRICK);
    const entries = [], keys = [];
    for (let z = 0; z < bricks[2]; z++) for (let y = 0; y < bricks[1]; y++) for (let x = 0; x < bricks[0]; x++) {
      const key = this.nativeStore.key(base[0] + x, base[1] + y, base[2] + z);
      const bytes = this.nativeStore.map.get(key);
      if (!bytes) continue;
      entries.push({ index: x + bricks[0] * (y + bricks[1] * z), bytes });
      keys.push(key);
    }
    native.restoreBricks(lo, bricks, entries, { derived: picture });
    for (const key of keys) this.nativeStore.drop(key);
    // (The scatter notes only the bricks it wrote.)
    return keys.length;
  }

  // Stamp the scene's trees in the brick columns of grid cells [lo, hi) (x and z,
  // brick-aligned) that are visited for the first time, clipped to those
  // columns, and mark them planted. Returns how many trees were stamped.
  plant(lo, hi) {
    const sim = this.sim, o = sim.origin;
    const world = { lo: lo.map((v, i) => v + [o.x, o.y, o.z][i]), hi: hi.map((v, i) => v + [o.x, o.y, o.z][i]) };
    const fresh = [];
    for (let z = world.lo[2] / BRICK; z < world.hi[2] / BRICK; z++)
      for (let x = world.lo[0] / BRICK; x < world.hi[0] / BRICK; x++) {
        const k = z * this.wb[0] + x;
        if (!this.planted[k]) fresh.push(k);
      }
    if (!fresh.length) return 0;
    const t0 = performance.now(), token = this.renderSource.token();
    let trees = 0;
    // One shared raw producer for physics and outside source. Do not mark
    // columns planted until all corresponding GPU writes have been recorded.
    for (let z = Math.floor(world.lo[2] / 32) * 32; z < world.hi[2]; z += 32)
      for (let x = Math.floor(world.lo[0] / 32) * 32; x < world.hi[0]; x += 32) {
        const result = this.sourceProducer.record(this.gpu.frame, [x, z], token, { physicsBounds: world });
        if (!result) throw new Error('tree source authority changed during synchronous population');
        trees += result.trees;
      }
    for (const k of fresh) this.planted[k] = 1;
    // The apply marks the bricks it wrote, so V2 imports only those. A whole-grid
    // write would make it reimport its lossy projection over every cell.
    sim.noteWrite({ replaceState: !sim.compactOwner });
    if (this.plantCost) this.plantCost.bakeMs += performance.now() - t0;
    return trees;
  }

  bakeTree(t) {
    const k = `${t.x},${t.z}`;
    if (!this.baked.has(k)) {
      this.baked.set(k, bake(runGenerator(BUILTINS.TREE, { size: t.size, seed: t.seed, variant: t.variant }), t.quarter));
      if (this.baked.size > BAKED_KEEP) this.baked.delete(this.baked.keys().next().value);
    }
    return this.baked.get(k);
  }

  // The store's size: bricks kept, bytes, and the brick columns planted.
  stats() {
    return { bricks: this.store.size, bytes: this.store.bytes + this.nativeStore.bytes, nativeBricks: this.nativeStore.size, planted: this.planted.reduce((n, v) => n + v, 0) };
  }

  dispose() {
    if (this.sim.worldWindow === this) this.sim.worldWindow = null;
    this.epoch++;
    this.leaveQueue?.clear();
    this.far?.dispose();
    this.sourceProducer.dispose();
    this.renderSource.dispose();
    dropNativeWorldSource(this.sim);   // (V2's cells as the World's source reads them)
    this.gen.dispose();
    // (destroyed once the frames that use them are submitted and done)
    for (const b of [this.leave.head, this.leave.cells]) if (b) this.sim._retire(b);
    this.scene.dispose?.();
  }
}

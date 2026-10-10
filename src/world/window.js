import * as THREE from 'three';
import { BRICK, stateUniforms } from '../shaders/common.js';
import { stageFrag, editFrag, gatherFrag, STAGE_W, BRICK_CELLS, SLOT_W } from '../shaders/window.js';
import { DIFF_W } from '../shaders/generate.js';
import { rawMat, makeFieldTarget, brickTexel } from '../sim.js';
import { WorldGenerator } from './gpu.js';
import { worldParams, treesIn, TREE } from './generator.js';
import { runGenerator, bake } from '../constructions/runtime.js';
import { BUILTINS } from '../constructions/builtins.js';
import { BrickStore, encodeBrick, decodeBrick, BRICK_FLOATS } from './store.js';
import { compileInBackground } from '../gfx/programs.js';

// The window over a massive world (docs/scaling.md D11, phases W1 and W2).
//
// The simulation's grid is a window into a world of `size` cells that the
// generator defines everywhere. sim.origin is the window's world cell: a
// multiple of WIN_STEP on x and z, 0 on y (the window spans the world's
// height). Each frame update(focus) keeps it centred on the focus (the POV
// body, else the orbit target): when the focus is more than WIN_STEP +
// WIN_HYSTERESIS cells from the window's centre along x or z, the window
// moves WIN_STEP that way, at most once per frame.
//
// A move:
//   1. the slab about to leave is copied out (shaders/window.js stageFrag) and
//      compared with the generator brick by brick (shaders/generate.js
//      diffFrag). The flags are read back asynchronously: the bricks that
//      match leave the store, and only the ones that differ are packed
//      (gatherFrag) and read back in turn, into the store (world/store.js);
//   2. Simulation.shift moves the state, the render fields' history and GI;
//   3. the generator fills the slab the move uncovers, then that slab's
//      stored bricks are written back (editFrag);
//   4. trees are stamped into the brick columns the move visits for the first
//      time, clipped to those columns (the planted record): a tree is planted
//      once, piece by piece as its columns are first visited, and comes back
//      from the store as edits after that;
//   5. both state copies are made the same.
// No move starts while a leaving slab is still being read back, so the store
// holds everything a move can bring back.
//
// The far field (world/far.js), when the app gives the window one (far), is
// built on load, summarizes the slab about to leave in step 1, and sweeps over
// the window's region while it changes (update).
//
// The window's own passes and the far field's are compiled in the background
// (whenReady); the app loads the world once they are ready, so switching to a
// world never stalls the page on a compile: the window fills in, then the
// far field around it as its view's program is ready (world/far.js). Until
// load the window doesn't move.

export const WIN_STEP = 16;          // cells: how far the window moves at a time (whole supertiles along x and z)
export const WIN_HYSTERESIS = 4;     // cells past WIN_STEP from the centre the focus goes before a move
const BAKED_KEEP = 256;              // baked trees kept: a tree straddling slabs is stamped once per slab
const CANDIDATES_KEEP = 1 << 16;     // tree candidates kept (one per brick column; a move asks for its neighbours again)
const MASK_SET = 255;                // a set byte of the column mask (the shader reads it as 1)

export class WorldWindow {
  // sim: the window's Simulation (its grid spans the world's height);
  // size: the world in cells [x, y, z]; seed: its generator seed; snow: its
  // snow caps (world/generator.js worldParams)
  constructor(renderer, sim, { size, seed, snow }) {
    const g = sim.g;
    if (g.ny !== size[1]) throw new Error(`window ${g.ny} cells tall in a world ${size[1]} tall: it spans the world's height`);
    if (size.some((n, i) => n % WIN_STEP && i !== 1)) throw new Error(`world ${size}: x and z must be multiples of ${WIN_STEP}`);
    this.renderer = renderer;
    this.sim = sim;
    this.size = size;
    this.P = worldParams({ size, seed, snow });
    this.gen = new WorldGenerator(sim);   // its own, not generatorFor's shared one: tools run two windows
    this.wb = size.map((n) => n / BRICK);                          // the world in bricks
    this.store = new BrickStore(this.wb);
    this.planted = new Uint8Array(this.wb[0] * this.wb[2]);       // brick columns whose trees are in
    this.baked = new Map();
    this.candidates = new Map();                                  // tree candidates by brick column (treesIn)
    this.pending = null;                                          // the leaving slab's readback
    this.epoch = 0;                                               // bumped by load and dispose: older readbacks are dropped
    this.last = null;                                             // what the last move cost (tools)
    this.plantCost = null;                                        // the move's tree placing and baking, ms (tools)
    this.far = null;                                              // the far field (world/far.js), if the app draws one
    this.loaded = false;                                          // load has filled the window (it moves only after)
    this.ready = null;                                            // whenReady's promise

    // the largest slab a move exchanges, and the targets it goes through
    const step = WIN_STEP / BRICK, BX = g.nx / BRICK, BY = g.ny / BRICK, BZ = g.nz / BRICK;
    const maxBricks = Math.max(step * BY * BZ, BX * BY * step);
    const rows = Math.ceil(maxBricks * BRICK_CELLS / STAGE_W);
    this.stage = makeFieldTarget(STAGE_W, rows, 2, THREE.FloatType, THREE.NearestFilter);
    this.packed = makeFieldTarget(STAGE_W, rows, 2, THREE.FloatType, THREE.NearestFilter);   // the differing bricks
    this.slots = new Float32Array(SLOT_W * Math.ceil(maxBricks / SLOT_W));                 // ...which staged brick each is
    this.slotsTex = dataTexture(this.slots, SLOT_W, Math.ceil(maxBricks / SLOT_W), THREE.RedFormat, THREE.FloatType);
    this.diffTarget = makeFieldTarget(DIFF_W, Math.ceil(maxBricks / DIFF_W), 1, THREE.UnsignedByteType, THREE.NearestFilter);
    this.bufA = new Float32Array(STAGE_W * rows * 4);
    this.bufB = new Float32Array(STAGE_W * rows * 4);
    this.bufF = new Uint8Array(DIFF_W * Math.ceil(maxBricks / DIFF_W) * 4);
    // writing stored bricks back: per grid brick its slot + 1 (0: none), and
    // per grid brick column whether to plant it
    this.editIdx = new Float32Array(g.bwidth * g.bheight);
    this.editIdxTex = dataTexture(this.editIdx, g.bwidth, g.bheight, THREE.RedFormat, THREE.FloatType);
    this.colMask = new Uint8Array(BX * BZ);
    this.colMaskTex = dataTexture(this.colMask, BX, BZ, THREE.RedFormat, THREE.UnsignedByteType);
    const v3 = () => ({ value: new THREE.Vector3() });
    this.mats = {
      stage: rawMat(stageFrag(g), { tA: { value: null }, tB: { value: null }, uLo: v3(), uBricks: v3() }),
      edit: rawMat(editFrag(g), {
        ...stateUniforms(),
        tEditIdx: { value: this.editIdxTex }, tEditA: { value: null }, tEditB: { value: null },
      }),
      gather: rawMat(gatherFrag(), {
        tStageA: { value: this.stage.textures[0] }, tStageB: { value: this.stage.textures[1] }, tSlots: { value: this.slotsTex },
      }),
    };
    for (const [k, m] of Object.entries(this.mats)) m.name = k;
  }

  // Every full-screen pass the window and its far field draw.
  materials() {
    this.gen.diffMat();
    return [...Object.values(this.mats), ...Object.values(this.gen.mats), ...Object.values(this.far?.mats ?? {})];
  }

  // Resolves once every pass of the window and its far field is compiled
  // (started in the background on the first call; give the window its far
  // field first): load and the moves then run without a compile stall.
  whenReady() {
    return (this.ready ??= compileInBackground(this.renderer, this.materials()));
  }

  // The origin that centres the window in the world.
  centre() {
    const g = this.sim.g, snap = (n) => Math.round(n / WIN_STEP) * WIN_STEP;
    return [snap((this.size[0] - g.nx) / 2), 0, snap((this.size[2] - g.nz) / 2)];
  }

  // (Re)load the world from the generator with the window at `origin`: no edits, nothing planted.
  load(origin = this.centre()) {
    const sim = this.sim, g = sim.g;
    this.epoch++;   // a slab of the old world still being read back is dropped
    this.store.clear();
    this.planted.fill(0);
    sim.origin.set(origin[0], 0, origin[2]);
    this.gen.fill(this.P, [origin[0], 0, origin[2]]);
    this.plant([0, 0, 0], [g.nx, g.ny, g.nz]);
    sim.syncCopies();
    this.far?.build();
    sim.dropHistory();   // undo would bring back a window of the old world
    // a new scene: the render fields and GI start over instead of blending in, and nothing is moving
    sim.fieldReset = sim.giReset = true;
    sim.stillFlow();
    this.loaded = true;
  }

  // Keep the window centred on the focus (world cells, x and z). Returns the
  // move made, [dx, dz] world cells, or null.
  update(fx, fz) {
    if (!this.loaded) return null;
    this.far?.tick();
    if (this.pending) return null;
    const g = this.sim.g, o = this.sim.origin, lim = WIN_STEP + WIN_HYSTERESIS;
    const off = [fx - (o.x + g.nx / 2), fz - (o.z + g.nz / 2)];
    const at = [o.x, o.z], span = [g.nx, g.nz], world = [this.size[0], this.size[2]];
    let best = null;
    for (const axis of [0, 1]) {
      const excess = Math.abs(off[axis]) - lim, d = Math.sign(off[axis]) * WIN_STEP;
      const fits = at[axis] + d >= 0 && at[axis] + d + span[axis] <= world[axis];
      if (excess > 0 && fits && (!best || excess > best.excess)) best = { axis, d, excess };
    }
    if (!best) return null;
    const move = best.axis ? [0, best.d] : [best.d, 0];
    this.shift(...move);
    return move;
  }

  // Move the window by (dx, 0, dz) world cells (one of them 0): steps 1–5 above.
  shift(dx, dz) {
    const t0 = performance.now();
    const sim = this.sim, g = sim.g, before = sim.origin.clone();
    // the slab that leaves (grid cells before the move) and the one the move uncovers (after it)
    const size = [dx ? Math.abs(dx) : g.nx, g.ny, dz ? Math.abs(dz) : g.nz];
    const leaveLo = [dx < 0 ? g.nx + dx : 0, 0, dz < 0 ? g.nz + dz : 0];
    const enterLo = [dx > 0 ? g.nx - dx : 0, 0, dz > 0 ? g.nz - dz : 0];
    const enterHi = enterLo.map((v, i) => v + size[i]);
    const bricks = size.map((n) => n / BRICK);
    // 1.
    const u = this.mats.stage.uniforms;
    u.tA.value = sim.stateA;
    u.tB.value = sim.stateB;
    u.uLo.value.set(...leaveLo);
    u.uBricks.value.set(...bricks);
    sim.run(this.mats.stage, this.stage);
    this.gen.diff(this.P, leaveLo, bricks, this.diffTarget);
    this.readBack([before.x / BRICK + leaveLo[0] / BRICK, 0, before.z / BRICK + leaveLo[2] / BRICK], bricks);
    this.far?.summarize(leaveLo, bricks);
    // 2.
    sim.shift(dx, dz);
    // 3.
    const o = sim.origin;
    this.gen.fill(this.P, [o.x, o.y, o.z], enterLo, enterHi);
    const restored = this.restore(enterLo, bricks);
    // 4.
    this.plantCost = { placeMs: 0, bakeMs: 0 };
    const trees = this.plant(enterLo, enterHi);
    // 5.
    sim.syncCopies();
    this.last = { dx, dz, ms: performance.now() - t0, restored, trees, ...this.plantCost, readbackMs: null, kept: null };
  }

  // Read the leaving slab's diff flags back; the bricks that match the
  // generator leave the store, and the ones that differ are packed from the
  // staged slab, read back and kept. base is slab brick 0's world brick.
  readBack(base, bricks) {
    const n = bricks[0] * bricks[1] * bricks[2], drows = Math.ceil(n / DIFF_W);
    const r = this.renderer, sim = this.sim, t0 = performance.now(), last = () => this.last, epoch = this.epoch;
    const f = this.bufF.subarray(0, DIFF_W * drows * 4);
    let keys = [], t1 = 0;
    this.pending = r.readRenderTargetPixelsAsync(this.diffTarget, 0, 0, DIFF_W, drows, f).then(() => {
      if (epoch !== this.epoch) return null;
      t1 = performance.now();
      this.slots.fill(0);
      for (let i = 0; i < n; i++) {
        const bx = i % bricks[0], by = Math.floor(i / bricks[0]) % bricks[1], bz = Math.floor(i / (bricks[0] * bricks[1]));
        const key = this.store.key(base[0] + bx, base[1] + by, base[2] + bz);
        if (f[i * 4]) { this.slots[keys.length] = i; keys.push(key); } else this.store.drop(key);
      }
      if (!keys.length) return null;
      this.slotsTex.needsUpdate = true;
      sim.run(this.mats.gather, this.packed);
      const rows = Math.ceil(keys.length * BRICK_CELLS / STAGE_W);
      const a = this.bufA.subarray(0, STAGE_W * rows * 4), b = this.bufB.subarray(0, STAGE_W * rows * 4);
      return Promise.all([
        r.readRenderTargetPixelsAsync(this.packed, 0, 0, STAGE_W, rows, a, undefined, 0),
        r.readRenderTargetPixelsAsync(this.packed, 0, 0, STAGE_W, rows, b, undefined, 1),
      ]).then(() => [a, b]);
    }).then((got) => {
      if (epoch !== this.epoch) return;
      const t2 = performance.now();
      if (got) keys.forEach((key, s) => this.store.put(key, encodeBrick(got[0], s * BRICK_FLOATS, got[1], s * BRICK_FLOATS)));
      const L = last();
      if (L) Object.assign(L, { flagsMs: t1 - t0, readbackMs: t2 - t0, keepMs: performance.now() - t2, kept: keys.length, landedAt: performance.now() });
    }).catch((err) => {
      console.error('world window: a leaving slab could not be read back; its edits are lost', err);
    }).finally(() => { this.pending = null; });
  }

  // Write the stored bricks of the slab of grid cells [lo, lo + 4·bricks) back
  // into the grid, taking them out of the store. Returns how many.
  restore(lo, bricks) {
    const sim = this.sim, g = sim.g, o = sim.origin;
    const lb = lo.map((v) => v / BRICK), ob = [o.x / BRICK, o.y / BRICK, o.z / BRICK];
    const slots = [];
    for (let bz = 0; bz < bricks[2]; bz++)
      for (let by = 0; by < bricks[1]; by++)
        for (let bx = 0; bx < bricks[0]; bx++) {
          const key = this.store.key(ob[0] + lb[0] + bx, ob[1] + lb[1] + by, ob[2] + lb[2] + bz);
          if (this.store.has(key)) slots.push([lb[0] + bx, lb[1] + by, lb[2] + bz, key]);
        }
    if (!slots.length) return 0;
    const rows = Math.ceil(slots.length * BRICK_CELLS / STAGE_W);
    const A = new Float32Array(STAGE_W * rows * 4), B = new Float32Array(STAGE_W * rows * 4);
    this.editIdx.fill(0);
    slots.forEach(([bx, by, bz, key], s) => {
      decodeBrick(this.store.take(key), A, s * BRICK_FLOATS, B, s * BRICK_FLOATS);
      this.editIdx[brickTexel(g, bx, by, bz)] = s + 1;
    });
    this.editIdxTex.needsUpdate = true;
    const texA = dataTexture(A, STAGE_W, rows, THREE.RGBAFormat, THREE.FloatType);
    const texB = dataTexture(B, STAGE_W, rows, THREE.RGBAFormat, THREE.FloatType);
    const u = this.mats.edit.uniforms;
    u.tEditA.value = texA;
    u.tEditB.value = texB;
    sim.pass(this.mats.edit);
    texA.dispose();
    texB.dispose();
    return slots.length;
  }

  // Stamp the trees of the brick columns of grid cells [lo, hi) (x and z,
  // brick-aligned) that are visited for the first time, clipped to those
  // columns, and mark them planted. Returns how many trees were stamped.
  plant(lo, hi) {
    const sim = this.sim, g = sim.g, o = sim.origin, BX = g.nx / BRICK;
    this.colMask.fill(0);
    let fresh = 0, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;   // their bounds, world cells
    for (let bz = lo[2] / BRICK; bz < hi[2] / BRICK; bz++)
      for (let bx = lo[0] / BRICK; bx < hi[0] / BRICK; bx++) {
        const wx = o.x / BRICK + bx, wz = o.z / BRICK + bz, k = wz * this.wb[0] + wx;
        if (this.planted[k]) continue;
        this.planted[k] = 1;
        this.colMask[bz * BX + bx] = MASK_SET;
        fresh++;
        x0 = Math.min(x0, wx * BRICK); x1 = Math.max(x1, (wx + 1) * BRICK);
        z0 = Math.min(z0, wz * BRICK); z1 = Math.max(z1, (wz + 1) * BRICK);
      }
    if (!fresh) return 0;
    const R = TREE.REACH, list = [];
    if (this.candidates.size > CANDIDATES_KEEP) this.candidates.clear();
    const t0 = performance.now(), trees = treesIn(x0 - R, z0 - R, x1 + R, z1 + R, this.P, this.candidates), t1 = performance.now();
    if (this.plantCost) this.plantCost.placeMs += t1 - t0;
    for (const t of trees) {
      const s = this.bakeTree(t);
      if (!s) continue;
      // the construction's base point on the ground at the trunk (WorldGenerator.plantTrees)
      const at = [t.x - o.x - s.base.x, t.y - o.y - s.base.y, t.z - o.z - s.base.z];
      if (at[0] + s.w <= x0 - o.x || at[0] >= x1 - o.x || at[2] + s.d <= z0 - o.z || at[2] >= z1 - o.z) continue;
      list.push({ s, at, seed: t.seed });
    }
    if (this.plantCost) this.plantCost.bakeMs += performance.now() - t1;
    if (!list.length) return 0;
    this.colMaskTex.needsUpdate = true;
    this.gen.stampMany(list, this.colMaskTex);
    return list.length;
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
    return { bricks: this.store.size, bytes: this.store.bytes, planted: this.planted.reduce((n, v) => n + v, 0) };
  }

  dispose() {
    this.epoch++;
    this.far?.dispose();
    this.gen.dispose();
    this.stage.dispose();
    this.packed.dispose();
    this.slotsTex.dispose();
    this.diffTarget.dispose();
    this.editIdxTex.dispose();
    this.colMaskTex.dispose();
    Object.values(this.mats).forEach((m) => m.dispose());
  }
}

function dataTexture(data, w, h, format, type) {
  const t = new THREE.DataTexture(data, w, h, format, type);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

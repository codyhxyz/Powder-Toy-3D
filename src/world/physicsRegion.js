// The physics region (docs/seamless-world.md, "P — physics region"): the 128³ window kept for physics
// only. A move touches nothing the picture reads: no derived fields, occupancy, GI, far field or render
// source, and no CPU tree baking. Its new slab is filled from the world copy (shaders/world/physicsFill.js)
// and the exact native store is laid over it; its leaving slab's exact bricks are read back and coded
// outside the frame, in budgeted slices (LeaveQueue). Touchstone: Minecraft 1.18's Simulation Distance,
// separate from its Render Distance.
//
// The pure parts live here (the move's slabs, the order of its steps, the slicing), so
// tools/world-move-cpu-check.mjs runs them without a GPU. world/window.js runs them.
import { BRICK } from '../shaders/common.js';

// The lead's switch (seamless world integration): true once the march reads the world copy (agent M),
// so nothing on screen reads the physics window's derived data. A move then records no picture work.
// False keeps today's move (derived, occupancy, far field and render source follow the window).
export const PHYSICS_ONLY_MOVE = true;
// The maps the switch covers: the seamless world's census (docs/seamless-world.md). Intentional (user,
// 2026-10-24: "don't worry about descent"): Descent's levels and the Noita source scenes keep the old
// picture, and so the old move, until the march covers them.
export const SEAMLESS_SCENES = new Set(['island', 'labWorld', 'volcanoWorld', 'giantVolcano', 'willowCove']);
// Test only: ?physicsOnly=1 turns the switch on for a page (tools/world-move-browser-check.mjs), as the
// lead's flip would; nothing else reads it.
const PAGE_SWITCH = typeof location !== 'undefined' && new URLSearchParams(location.search).get('physicsOnly') === '1';
/** Whether a window over this world scene moves physics only (world/window.js reads it at construction). */
export const physicsOnlyFor = (scene, on = PHYSICS_ONLY_MOVE || PAGE_SWITCH) => on && SEAMLESS_SCENES.has(scene?.key);
// A physics-only window's grid is laid out by ring addressing (shaders/common.js ringOf; src/sim.js
// _shiftRing): a move copies nothing and rewrites only the slab it uncovers. Its whole-window copies (V2's
// cores and banks out to a scratch and back, the requests, the flow) were ~6.6 of a move's ~8 ms of GPU
// (P2's slot, 2026-10-24). False keeps the copying move under the switch.
// Every reader of physics state is ring-aware since P3 (2026-10-24): the march's physSlot, the world copy's
// writeback, the particles' air, the derived passes' dispatches and saves' native words (world/ringSave.js).
export const RING_MOVE = true;
// Test only: ?ring=0 lays a page's grid out unringed (tools/world-move-browser-check.mjs compares the two).
const PAGE_UNRINGED = typeof location !== 'undefined' && new URLSearchParams(location.search).get('ring') === '0';
/** Whether a window over this scene lays its grid out by ring addressing (world/window.js, at construction). */
export const ringedFor = (scene, on = RING_MOVE && !PAGE_UNRINGED) => on && physicsOnlyFor(scene);

// What a move may cost in its own frame (docs/seamless-world.md, P's budget); the rest spreads over frames.
export const MOVE_GPU_BUDGET_MS = 2;
export const MOVE_CPU_BUDGET_MS = 2;
// The leaving slab's bookkeeping (validate, code and file each kept brick) in slices of at most this
// long, one per idle period or frame, so it never lands in one frame as the readback's microtask did.
export const LEAVE_SLICE_MS = 1;
// An idle callback's deadline: a slice runs within this even if the page is never idle (a busy loop).
export const LEAVE_IDLE_TIMEOUT_MS = 50;
// Bricks a slice handles between clock reads: a kept brick's validation and coding is ~40 µs, a clock
// read ~0.05 µs, so 4 keeps a slice within ~0.2 ms of its budget.
export const LEAVE_SLICE_BRICKS = 4;

/**
 * The slabs of a move by (dx, 0, dz) cells (one of them 0) of a grid g: the one that leaves (grid cells
 * before the move), the one the move uncovers (after it), and their size in cells and bricks.
 */
export function moveSlabs(g, dx, dz) {
  if ((dx && dz) || (!dx && !dz)) throw new Error(`move ${dx}, ${dz}: exactly one axis moves`);
  const size = [dx ? Math.abs(dx) : g.nx, g.ny, dz ? Math.abs(dz) : g.nz];
  if (size.some((n) => n % BRICK)) throw new Error(`move ${dx}, ${dz}: whole bricks only`);
  const leaveLo = [dx < 0 ? g.nx + dx : 0, 0, dz < 0 ? g.nz + dz : 0];
  const enterLo = [dx > 0 ? g.nx - dx : 0, 0, dz > 0 ? g.nz - dz : 0];
  const enterHi = enterLo.map((v, i) => v + size[i]);
  return { size, leaveLo, enterLo, enterHi, bricks: size.map((n) => n / BRICK) };
}

/** The world brick of a slab's brick 0: grid cells lo at world cell origin o ([x, y, z]). */
export const slabBase = (o, lo) => lo.map((v, i) => (o[i] + v) / BRICK);

/** Brick i of a slab of `bricks` (x fastest, then y, then z), as [x, y, z] bricks from its brick 0. */
export const slabBrick = (i, bricks) => [i % bricks[0], Math.floor(i / bricks[0]) % bricks[1], Math.floor(i / (bricks[0] * bricks[1]))];

/** Whether two slabs of world bricks [base, base + bricks) overlap. */
export function slabsOverlap(a, b) {
  return a.base.every((v, i) => v < b.base[i] + b.bricks[i] && b.base[i] < v + a.bricks[i]);
}

/**
 * A move's steps, in the order the window records them (world/window.js _shiftCommitted).
 * physicsOnly: the switch (PHYSICS_ONLY_MOVE). worldCopy: one is attached, so the slab is filled from it
 * and its trees with it. native: Physics V2 runs the window (its exact store is laid over the fill).
 *   leaveSource    the render source's copy of the slab (old picture: before the capture, which it versions)
 *   leaveCapture   the leaving slab's cells gathered (V2's exact bricks) and its diff, read back and coded later
 *   leaveDeco      its decoration into the decoration's store (state, not picture: src/deco.js)
 *   shift          Simulation.shift: V2's cells, its dynamics, the flow (and, old picture only, the derived
 *                  passes' and occupancy's onShift); then the coding of any earlier leaving slab the new
 *                  one overlaps is finished, so the store holds everything the move brings back
 *   fillCopy       the slab from the world copy (and the generator where they agree: physicsFill.js)
 *   fillGenerator  the slab from the generator (no world copy)
 *   sourceStore    the render source keeps the stored bricks' exact words (old picture: before restoreLegacy drops them)
 *   restoreLegacy  V1-format stored bricks, decoded into the native store
 *   enterDeco      the slab's decoration back
 *   sourceCaptured the render source's captured copies written back (old picture, a V1 grid only)
 *   plant          the scene's trees, baked on the CPU (no world copy: the copy holds its trees)
 *   restoreNative  the exact native store over all of it: last, so nothing writes over exact state
 */
export function movePlan({ physicsOnly = PHYSICS_ONLY_MOVE, worldCopy = false, native = true, trees = true } = {}) {
  const picture = !physicsOnly;
  return [
    picture && 'leaveSource',
    'leaveCapture',
    'leaveDeco',
    'shift',
    worldCopy ? 'fillCopy' : 'fillGenerator',
    picture && 'sourceStore',
    'restoreLegacy',
    'enterDeco',
    picture && !native && 'sourceCaptured',
    !worldCopy && trees && 'plant',
    native && 'restoreNative',
  ].filter(Boolean);
}

/**
 * Budgeted background work: jobs of small steps, run a slice at a time outside the frame (an idle
 * callback, else a timer), each slice no longer than LEAVE_SLICE_MS. flush() runs everything now, for a
 * reader that needs the result (a move bringing those bricks back, a save, a capture).
 * A job is an iterator: each next() does one unit of work; done ends it. now and schedule are injectable
 * (tools/world-move-cpu-check.mjs drives them by hand).
 */
export class LeaveQueue {
  constructor({ sliceMs = LEAVE_SLICE_MS, now = () => performance.now(), schedule = defaultSchedule } = {}) {
    this.sliceMs = sliceMs; this.now = now; this.schedule = schedule;
    this.jobs = [];
    this.scheduled = false;
    this.slices = 0;            // slices run (tools)
    this.longestMs = 0;         // the longest slice (tools)
  }
  get busy() { return this.jobs.length > 0; }
  /** Queue a job ({ steps: iterator, done?: () => void, fail?: (err) => void, tag? }). */
  add(job) {
    this.jobs.push(job);
    this._kick();
    return job;
  }
  _kick() {
    if (this.scheduled || !this.jobs.length) return;
    this.scheduled = true;
    this.schedule(() => { this.scheduled = false; this.slice(); this._kick(); });
  }
  _step(job) {
    try {
      if (job.steps.next().done) { this.jobs.splice(this.jobs.indexOf(job), 1); job.done?.(); return false; }
      return true;
    } catch (err) {
      this.jobs.splice(this.jobs.indexOf(job), 1);
      if (job.fail) job.fail(err); else throw err;
      return false;
    }
  }
  /** One slice: steps of the oldest job until sliceMs has passed (checked every LEAVE_SLICE_BRICKS steps). */
  slice(budgetMs = this.sliceMs) {
    const t0 = this.now();
    let n = 0;
    while (this.jobs.length) {
      const job = this.jobs[0];
      this._step(job);
      if (++n % LEAVE_SLICE_BRICKS === 0 && this.now() - t0 >= budgetMs) break;
    }
    if (n) { this.slices++; this.longestMs = Math.max(this.longestMs, this.now() - t0); }
    return n;
  }
  /** Finish the jobs that match (every job without a test) now. */
  flush(test = null) {
    for (const job of this.jobs.filter((j) => !test || test(j))) while (this.jobs.includes(job) && this._step(job));
  }
  clear() { this.jobs = []; }
}

function defaultSchedule(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: LEAVE_IDLE_TIMEOUT_MS });
  else setTimeout(fn, 0);
}

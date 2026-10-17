import { DECO_ID0 } from './elements.js';
import { BRICK, brickIdOf, brickCoordOf } from './shaders/common.js';
import { BRICK_CELLS } from './shaders/window.js';
import { DECO_KERNELS, DECO_LAYOUT, boxDispatch, stageDispatch } from './shaders/deco.js';
import { fold } from './gpu/kernels.js';
import { cellTexel } from './sim.js';

// The Powder Toy's decoration layer ("deco"): a colour painted onto matter
// that travels with it. TPT keeps it per particle (dcolour, 0xAARRGGBB:
// src/simulation/Particle.h), paints it with the deco tools
// (src/gui/game/tool/DecorationTool.cpp → Simulation::ApplyDecoration*,
// src/simulation/Editing.cpp) and blends it over the element's colour by its
// alpha when drawing (src/graphics/Renderer.cpp), unless decoration display is
// off (Ctrl+B, src/gui/game/GameView.cpp).
//
// Storage: the decoration plane, a u32 per cell (RGBA8) in the state's slot
// order, which the simulation keeps beside whitewater's moveSrc so the move
// carries it with the cells (src/sim.js attachDeco, decoPlane; shaders/deco.js
// has the rules). The state's buffers have no spare bits (A's w already packs
// ctype and the cell's seed into one float). It exists from the first deco
// stroke (or a load that brings decoration: sim.decoFactory, ensureDeco) and
// costs nothing until then: no buffer, no pipeline, nothing in the move. Once
// there, a running block of the move reads and writes 8 more words while
// anything is decorated (`active`), and an idle world, which skips its steps,
// skips that too. Anything that replaces the whole state (a load, a new world)
// clears it and switches it off again.
//
// It survives what the state survives:
//   - undo: each snapshot carries a copy of the plane (Simulation.snapshot / undo);
//   - the World's window: it moves with the cells on a shift, the slab that
//     leaves is read back into a store of its own (decorated bricks only, 256
//     bytes each) and comes back when the window returns (leave, enter);
//   - stamps and the brush: a cell they give a new element loses its paint,
//     as TPT's create_part resets it (scrub, around sim.edit's write with
//     { scrub: true }); everything else keeps it.
// Multiplayer v1: the host's state stream doesn't carry it, so guests see no
// decoration and can't paint it (src/wire/deco.js, app.js).
//
// Its kernels (shaders/deco.js) build when a deco tool is picked
// (prepareDeco) or the layer is made, never at boot. A stroke made while they
// are still building waits for them (they take a few tens of ms on the test
// device); `pending` holds the World's window back meanwhile, as it does
// while a leaving slab is read back.

// The deco tools (elements.js DECO_TOOLS) in TPT's mode order (shaders/deco.js DECO_MODE).
const modeOf = (tool) => DECO_ID0 - tool;
export const DECO_BYTES = 4;   // RGBA8 per cell
// TPT's default decoration colour, (200, 100, 50) opaque
// (src/gui/game/GameModel.cpp, prefs Decoration.Red/Green/Blue/Alpha).
const DECO_DEFAULT = [200, 100, 50, 255];
const BYTE_MAX = 255;
const STORE_KEY = 'powder-toy-3d:deco';   // the picker's colour (TPT keeps it in its prefs too)
const TILE = 2 * BRICK;                   // a brick's 64 slots are its atlas tile's 8 rows of 8 (docs/webgpu.md C2)

// The picker's colour (sRGB 0..255 and alpha) and whether decoration is drawn.
export const decoView = { show: true, color: [...DECO_DEFAULT] };
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  if (Array.isArray(saved) && saved.length === DECO_BYTES && saved.every((v) => Number.isInteger(v) && v >= 0 && v <= BYTE_MAX)) decoView.color = saved;
} catch { /* storage unavailable */ }
export function setDecoColor(rgba) {
  decoView.color = rgba.map((v) => Math.max(0, Math.min(BYTE_MAX, Math.round(v))));
  try { localStorage.setItem(STORE_KEY, JSON.stringify(decoView.color)); } catch { /* storage unavailable */ }
}
// Is sim's decoration drawn (display on, and anything decorated)? The volume
// reads it each draw (gfx/volume.js: VolumeParams.deco).
export const decoShown = (sim) => !!sim?.deco?.active && decoView.show;

// ---- the kernels: one set per device and grid, shared by every layer of that grid ----
const kernelSets = new WeakMap();   // gpu → Map(grid key → { kernels, ready })
function kernelsOf(sim) {
  const gpu = sim.gpu, g = sim.g;
  let byGrid = kernelSets.get(gpu);
  if (!byGrid) kernelSets.set(gpu, byGrid = new Map());
  const key = `${g.nx}x${g.ny}x${g.nz}`;
  let set = byGrid.get(key);
  if (!set) {
    const layout = gpu.layout('DECO', DECO_LAYOUT);
    const kernels = {};
    for (const { name, code, entry, params, workgroupSize } of DECO_KERNELS) {
      kernels[name] = gpu.kernel({ name, code: code(g), entry, layouts: [sim.L.TABLES, sim.L.STATE_RO, layout], params, workgroupSize });
    }
    set = { kernels, layout, ready: Promise.all(Object.values(kernels).map((k) => k.ready)) };
    byGrid.set(key, set);
  }
  return set;
}

// ---- the plane and the save's atlas order (sim.js cellTexel) ----
// Calls fn(slot, texel) for the first of each run of TILE cells that are
// consecutive in both orders: a brick tile's rows.
function eachRow(g, fn) {
  for (let id = 0; id < g.nbricks; id++) {
    const [bx, by, bz] = brickCoordOf(g, id);
    const t0 = cellTexel(g, bx * BRICK, by * BRICK, bz * BRICK);
    for (let v = 0; v < TILE; v++) fn(id * BRICK_CELLS + v * TILE, t0 + v * g.width);
  }
}
/** Plane words (slot order) → RGBA8 per atlas texel (sim.cellTexel(x, y, z) * 4 is a cell's). */
export function planeToAtlas(g, words) {
  const out = new Uint32Array(g.width * g.height);
  eachRow(g, (s, t) => out.set(words.subarray(s, s + TILE), t));
  return new Uint8Array(out.buffer);
}
/** RGBA8 per atlas texel → plane words (slot order). */
export function atlasToPlane(g, bytes) {
  const texels = bytes.byteOffset % 4 ? new Uint32Array(bytes.slice().buffer) : new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const out = new Uint32Array(g.slots);
  eachRow(g, (s, t) => out.set(texels.subarray(t, t + TILE), s));
  return out;
}
// A slab brick's 64 cells (shaders/window.js slabCell: x fastest, then y,
// then z) → its 64 slots (the brick tile's row-major order).
const SLAB_TO_SLOT = Uint8Array.from({ length: BRICK_CELLS }, (_, l) => {
  const x = l & 3, y = (l >> 2) & 3, z = l >> 4;
  return x + 4 * (y & 1) + 8 * (z + 4 * (y >> 1));
});

export class Deco {
  /** @param {import('./sim.js').Simulation} sim (attach it with sim.attachDeco, or ensureDeco) */
  constructor(sim) {
    this.sim = sim;
    this.gpu = sim.gpu;
    const set = kernelsOf(sim);
    this.k = set.kernels;
    this.layout = set.layout;
    /** Resolves when the layer's kernels are built. */
    this.ready = set.ready.then(() => this);
    this.ready.catch(() => {});
    this.active = false;     // the plane may hold decoration (else it is all 0 and nothing reads or carries it)
    this.store = new Map();  // the World's decorated bricks outside the window, by world brick key (leave)
    this.storeReads = new Set(); // retain EVERY outstanding read, even reversed completions
    this.storeRevisions = new Map();
    this.revision = 0;
    this.epoch = 0;          // bumped by reset: a readback of what was before lands nowhere
    this.queue = [];         // work waiting for the kernels, in call order
    this.snaps = new Set();  // undo snapshots holding a copy of the plane (t.decoBuf)
    this.work = null;        // a plane-sized scratch (made on first use)
    this.groups = new Map(); // group 2 per plane buffer and source
    this.groupsFor = null;   // the plane buffer those groups bind (whitewater remakes it)
    this.dummy = this.gpu.createBuffer({ label: `sim${sim.id} deco source (none)`, size: 16, usage: GPUBufferUsage.STORAGE });
  }

  /** The plane: { buffer, offset, size } (src/sim.js decoPlane), or null before the layer is attached. */
  get plane() { return this.sim.decoPlane; }

  /**
   * What the World's window waits for before it moves (world/window.js): a
   * leaving slab's readback, or, while anything is decorated, the kernels
   * a move needs (they are still building only just after the layer was
   * made by a load). null when nothing is outstanding.
   */
  get pending() {
    return this.storeReads.values().next().value ?? (this.active && !this.kernelsReady ? this.ready : null);
  }

  get kernelsReady() { return Object.values(this.k).every((k) => k.state === 'ready'); }

  // Runs fn now when the kernels are built, else once they are, after the
  // work queued before it (in call order).
  _whenReady(fn) {
    if (this.kernelsReady && !this.queue.length) { fn(); return; }
    this.queue.push(fn);
    if (this.queue.length > 1) return;
    this.ready.then(() => {
      const epoch = this.epoch;
      while (this.queue.length && epoch === this.epoch) {
        try { this.queue.shift()(); } catch (e) { if (!this.gpu.failure) console.error('deco: queued work failed', e); }
      }
    }, () => { this.queue = []; });
  }

  _work() {
    const bytes = this.sim.g.slots * 4;
    if (!this.work || this.work.size < bytes) {
      this.work?.destroy();
      this.work = this.gpu.createBuffer({ label: `sim${this.sim.id} deco work`, size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      this.groups.clear();
    }
    return this.work;
  }

  // Group 2 (shaders/deco.js DECO_LAYOUT): the plane, the work buffer and a
  // source (an undo snapshot's plane, else the dummy). Made once per plane
  // buffer and source; a snapshot's group goes with its restore.
  _group(source = this.dummy, plane = this.plane) {
    const work = this._work();
    if (this.groupsFor !== plane.buffer) { this.groups.clear(); this.groupsFor = plane.buffer; }
    let group = source === this.dummy ? this.groups.get(plane.buffer) : null;
    if (!group) {
      group = this.gpu.bindGroup(this.layout, [
        { binding: 0, resource: { buffer: plane.buffer, offset: plane.offset, size: plane.size } },
        { binding: 1, resource: { buffer: work } },
        { binding: 2, resource: { buffer: source } },
      ], `sim${this.sim.id} deco`);
      if (source === this.dummy) this.groups.set(plane.buffer, group);
    }
    return group;
  }

  _run(name, size, params, opts = {}) {
    const sim = this.sim;
    sim._dispatch(this.k[name], size, {
      bind: [sim.tables, sim.bindRO, this._group(opts.source, opts.plane)], header: sim.header(), params,
    });
  }

  // The brush's box (sim.touchCentres: cells whose centres are within radius), clipped; null if empty.
  _box(center, radius) {
    const c = [center.x, center.y, center.z];
    const { lo, hi } = this.sim.touchCentres(c.map((v) => v - radius), c.map((v) => v + radius));
    return this.sim._clip(lo, hi);
  }

  // A deco tool's brush stroke (Simulation.paint): the picker's colour at the call.
  paint({ center, radius, shape, tool }) {
    const box = this._box(center, radius);
    if (!box) return;
    const [lo, hi] = box;
    const params = {
      lo, hi, center: [center.x, center.y, center.z], radius, shape, mode: modeOf(tool),
      color: decoView.color.map((v) => v / BYTE_MAX),
    };
    this._whenReady(() => {
      const size = boxDispatch(lo, hi);
      this._run('decoPaint', size, params);
      this._run('decoPaintApply', size, params);
      this.active = true;
      this.sim.version++;   // the picture changed (gfx/pacing.js redraws on it)
      this.sim.worldRenderSource?.noteContentChange();
    });
  }

  // Around a write to the state that isn't a step (sim.edit with { scrub:
  // true }), over its box: before it, keep the box's elements; after it, the
  // cells it gave a new element, or emptied, lose their decoration. f is the
  // open frame (the dispatches record into it).
  beforeWrite(f, box) {
    this._scrubbing = this.active && this.kernelsReady && !this.queue.length;
    if (this._scrubbing) this._run('decoKeep', boxDispatch(box.lo, box.hi), { lo: box.lo, hi: box.hi });
  }
  scrub(f, box) {
    if (!this._scrubbing) return;
    this._scrubbing = false;
    this._run('decoScrub', boxDispatch(box.lo, box.hi), { lo: box.lo, hi: box.hi });
  }

  // The window moved by (dx, 0, dz) grid cells (Simulation.shift): the
  // decoration moves with the cells, out of place through the work buffer;
  // the slab uncovered starts undecorated.
  shift(dx, dz) {
    if (!this.active) return;
    if (!this.kernelsReady) {
      // (the window waits on `pending` for these; a caller that didn't loses the paint rather than misplacing it)
      console.warn('deco: the window moved before the decoration\'s kernels were built; its paint is dropped');
      this.reset();
      return;
    }
    const p = this.plane, work = this._work();
    this._run('decoShift', fold(Math.ceil(this.sim.g.slots / 64)), { shift: [dx, 0, dz], blank: 0 });
    this.gpu.frame.copy(work, 0, p.buffer, p.offset, p.size);
  }

  // Undo snapshots (Simulation.snapshot, undo): t carries a copy (t.deco),
  // or none if nothing was decorated when it was taken.
  snapshot(t) {
    this._sweep();
    t.deco = null;
    if (!this.active) return;
    const p = this.plane;
    t.decoBuf ??= this.gpu.createBuffer({ label: `sim${this.sim.id} undo deco`, size: p.size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.snaps.add(t);
    this.gpu.frame.copy(p.buffer, p.offset, t.decoBuf, 0, p.size);
    t.deco = t.decoBuf;
  }

  // Bring snapshot t's decoration back, (dx, dz) being the grid cells the
  // window moved since it was taken: the cells it holds take its decoration
  // (none, if it has none); the rest keep theirs. The snapshot is spent.
  restore(t, dx, dz) {
    const had = t.deco;
    t.deco = null;
    if (!had && !this.active) { this._spend(t); return; }
    this._whenReady(() => {
      this._run('decoUndo', fold(Math.ceil(this.sim.g.slots / 64)), { shift: [dx, 0, dz], blank: had ? 0 : 1 }, { source: had ?? this.dummy });
      this.active = true;
      this.sim.worldRenderSource?.noteContentChange();
      this._spend(t);
    });
  }

  // A snapshot's copy goes once the queue is done with it.
  _spend(t) {
    if (!t.decoBuf) return;
    this.sim._retire(t.decoBuf);
    t.decoBuf = null;
    this.snaps.delete(t);
  }
  // Snapshots the simulation forgot (dropHistory, or pushed out by newer ones) let their copies go.
  _sweep() {
    for (const t of this.snaps) if (!this.sim.history.includes(t)) this._spend(t);
  }

  // Everything goes (a new state replaced the old: Simulation.load, a new world).
  reset() {
    this._sweep();
    if (!this.active && !this.store.size && !this.storeReads.size && !this.queue.length) return;
    const p = this.plane;
    if (p && this.active) this.gpu.frame.clear(p.buffer, p.offset, p.size);
    this.queue = [];   // (strokes waiting for the kernels were made on the old state)
    this.store.clear();
    this.storeRevisions.clear();
    this.epoch++;
    this.sim.worldRenderSource?.noteContentChange();
    this.active = false;
  }

  // ---- the World's window (world/window.js) ----
  // The slab of grid cells [lo, lo + 4·bricks) is about to leave: read its
  // decoration back, and keep each brick with any (key(slab brick x, y, z)
  // gives its world key) in the store, dropping the ones without.
  leave(lo, bricks, key) {
    if (!this.active) return;
    if (!this.kernelsReady) { console.warn('deco: a slab left before the decoration\'s kernels were built; its paint is lost'); return; }
    const n = bricks[0] * bricks[1] * bricks[2], brickBytes = BRICK_CELLS * DECO_BYTES;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(key(i % bricks[0], Math.floor(i / bricks[0]) % bricks[1], Math.floor(i / (bricks[0] * bricks[1]))));
    this._run('decoStage', stageDispatch(bricks), { lo, bricks });
    const epoch = this.epoch, revision = ++this.revision;
    // Reserve each key at request time, including deletes and failed newer
    // reads. An older completion must never resurrect obsolete paint.
    for (const k of keys) this.storeRevisions.set(k, revision);
    // (the copy is recorded now, before whatever the frame records next into the work buffer: docs/webgpu.md B7)
    const read = this.gpu.readback.buffer(this.work, 0, n * brickBytes).then((bytes) => {
      if (epoch !== this.epoch) return;
      const buf = new Uint8Array(bytes);
      keys.forEach((k, i) => {
        if (this.storeRevisions.get(k) !== revision) return;
        const b = buf.subarray(i * brickBytes, (i + 1) * brickBytes);
        if (b.some((v) => v)) this.store.set(k, b.slice());
        else this.store.delete(k);
      });
    }).catch((err) => {
      if (!this.gpu.failure) console.error('deco: a leaving slab could not be read back; its decoration is lost', err);
    }).finally(() => { this.storeReads.delete(read); });
    this.storeReads.add(read);
  }

  // The slab of grid cells [lo, lo + 4·bricks) was uncovered: its stored
  // bricks come back (key as in leave), and leave the store. Each is one
  // brick's run of the plane (64 words), written in order after what the
  // frame recorded before (gpu.write).
  enter(lo, bricks, key) {
    if (!this.store.size || !this.plane) return;
    const g = this.sim.g, p = this.plane, words = new Uint32Array(BRICK_CELLS);
    let any = false;
    for (let bz = 0; bz < bricks[2]; bz++)
      for (let by = 0; by < bricks[1]; by++)
        for (let bx = 0; bx < bricks[0]; bx++) {
          const k = key(bx, by, bz), bytes = this.store.get(k);
          if (!bytes) continue;
          const src = new Uint32Array(bytes.slice().buffer, 0, BRICK_CELLS);
          for (let l = 0; l < BRICK_CELLS; l++) words[SLAB_TO_SLOT[l]] = src[l];
          const id = brickIdOf(g, lo[0] / BRICK + bx, lo[1] / BRICK + by, lo[2] / BRICK + bz);
          this.gpu.write(p.buffer, p.offset + id * BRICK_CELLS * 4, words);
          this.store.delete(k);
          any = true;
        }
    if (any) {
      this.active = true;
      this.sim.version++;
    }
  }

  // ---- saves (readDeco / uploadDeco below) ----
  /** The decoration as RGBA8 per state-atlas texel (async: docs/webgpu.md W6). */
  async read() {
    const p = this.plane;
    if (!p) return null;
    const bytes = await this.gpu.readback.buffer(p.buffer, p.offset, p.size);
    return planeToAtlas(this.sim.g, new Uint32Array(bytes));
  }

  upload(data) {
    const words = atlasToPlane(this.sim.g, data), p = this.plane;
    this.gpu.write(p.buffer, p.offset, words);
    this.active = words.some((v) => v);
    this.sim.version++;
    this.sim.worldRenderSource?.noteContentChange();
  }

  dispose() {
    this.epoch++;
    this.queue = [];
    for (const t of this.snaps) { t.decoBuf?.destroy(); t.decoBuf = null; t.deco = null; }
    this.snaps.clear();
    this.work?.destroy();
    this.dummy.destroy();
    this.groups.clear();
  }
}

// sim's decoration layer, made and attached the first time it is needed (the
// plane comes with it: src/sim.js attachDeco). A wire module may set
// sim.decoFactory = (sim) => ensureDeco(sim) (or new Deco(sim)); either way
// the layer is attached once.
export function ensureDeco(sim) {
  if (!sim.deco) sim.attachDeco(new Deco(sim));
  return sim.deco;
}
// A deco tool was picked: build the layer's kernels in the background, so
// the first stroke doesn't wait on them. The layer itself (its plane) comes
// with the first stroke. Resolves when they are built.
export function prepareDeco(sim) {
  if (!sim) return Promise.resolve();
  return sim.deco?.ready ?? kernelsOf(sim).ready;
}

// For saves (a save section's save and load): the decoration as RGBA8 per
// state-atlas texel (sim.cellTexel(x, y, z) * 4 is a cell's sRGB colour and
// alpha), or null if nothing is decorated (a promise of it: the plane is read
// back, docs/webgpu.md W6); and the same back into sim (after its state is
// loaded: Simulation.load clears the decoration). A World's decorated bricks
// outside the window are sim.deco.store (world brick key → 256 bytes, its 64
// cells in the slab order of shaders/window.js).
export function readDeco(sim) {
  return sim.deco?.active ? sim.deco.read() : null;
}
export function uploadDeco(sim, data) {
  const { width, height } = sim.g;
  if (!data || data.length !== width * height * DECO_BYTES) return false;
  ensureDeco(sim).upload(data);
  return true;
}

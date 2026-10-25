import { Matrix4, Vector3 } from 'three/webgpu';
import { BRICK } from '../shaders/common.js';
import {
  farLayout, FAR_SCENE, FAR_FORMATS, occupancyWords,
  farClearFrag, farBoostFrag, farMip1Frag, farMip2Frag, farTopFrag, farShadowFrag, farFrag,
  RegionParams, regionDispatch, ShadowParams, columnDispatch, nodeDispatch,
  FAR_CLEAR_LAYOUT, FAR_BOOST_LAYOUT, FAR_MIP1_LAYOUT, FAR_MIP2_LAYOUT, FAR_TOP_LAYOUT,
  FAR_SHADOW_LAYOUT, FAR_VIEW_FRAME, FarViewParams, farViewPipeline,
} from '../shaders/far.js';
import { farCopyFrag, FAR_COPY_LAYOUT } from '../shaders/world/farFromCopy.js';
import { WORLD_COPY_LAYOUT } from '../shaders/world/copy.js';
import { frameUniformsOf } from '../gfx/uniforms.js';
import { appearanceRegion, uploadAppearance, uploadAppearanceRange, SOURCE_APPEARANCE_ENABLED } from '../gfx/sourceAppearance.js';

// The far field of a big map (docs/scaling.md D11, phase W4; docs/webgpu.md
// G1; the WGSL and the far grid's layout are in shaders/far.js): a
// brick-resolution grid of the whole world, its distance level of detail.
//
// Built from, and kept current from, the world copy (docs/seamless-world.md,
// "work parity": world/worldCopy.js, the whole map at full detail, resident
// from load), never from the physics window, so a window move costs it
// nothing:
//   - useWorldCopy(copy) once the copy is built (wire/world.js, after
//     worldView.build): the grid starts empty and fills a chunk of
//     FAR_SCENE.CHUNK² brick columns at a time (every height), summarized
//     from the copy's cells (shaders/world/farFromCopy.js farCopyFrag), then
//     its field (farBoostFrag), COPY_CHUNKS_PER_FRAME chunks a frame in tick,
//     nearest the window's centre (the camera's focus) first, so no frame is
//     long and the far field fills in around you; the view draws what is
//     built so far (unbuilt bricks are empty: the plain or sea beyond). The
//     copy holds the trees and structures, so nothing places them here;
//   - every tick, the boxes the copy changed since (changesSince: what physics
//     wrote back, a frame or two late) are summarized again, with the bricks
//     whose cubes reach into them, up to CHANGE_BRICKS_PER_FRAME bricks a
//     frame; a bigger change (a reload of the copy: its whole world) joins
//     the chunk queue instead;
//   - after these the occupancy levels, the brick-column tops and the shadow
//     heights are rebuilt (refresh, at the next view since the view marches
//     them): during the build every BUILD_REFRESH_FRAMES frames and at its
//     end, after changes at most every CHANGE_REFRESH_FRAMES frames (the
//     cadence the window's sweeps had), and the shadow heights again when the
//     sun turns.
// Everything records into the open frame (docs/webgpu.md B3).
//
// The view is one full-screen pass (shaders/far.js farFrag), in the realistic
// view only: sky, the open sea beyond the world and the far grid. Its lighting
// group is the volume's with the far grid, tops and shadow heights in it
// (attachVolume): its ground's elements and the sun's shadow on it.
//
// The rolling log (gfx/presentation.js: `presentation`, set by
// src/wire/world.js): while a gamemode's effect bends the view, the view draws
// its curved variant (its own pipeline, built the first time it is wanted).

const COPY_CHUNKS_PER_FRAME = 2;    // the build: chunks summarized a frame (each 16² brick columns, every height: 8192 bricks of the
                                    // 1024² × 128 world, 256 chunks, ~2 s at 60 fps; a uniform neighbour brick is one read)
const SOFTWARE_CHUNKS_PER_FRAME = 1;   // on a software adapter (SwiftShader: the container, ?software=1): one a frame
const BUILD_REFRESH_FRAMES = 8;     // frames between rebuilding the levels, tops and shadows while the build runs
const CHANGE_BRICKS_PER_FRAME = 32768;   // bricks of changed boxes summarized in a frame (a 128³-cell window's: 32³); more joins the queue
const CHANGE_BOXES_MERGE = 4;       // more change boxes than this are summarized as their bounding box, if it fits the budget
const CHANGE_REFRESH_FRAMES = 120;  // frames between rebuilding the levels, tops and shadows while the copy keeps changing (the sweeps' cadence)
// The shadow heights are rebuilt once the sun has turned this many bricks' worth since:
// a column h cells tall moves its shadow's edge by about h·angle cells, so at the world's full height the edge
// moves less than this share of a brick. The day cycle turns the sun every frame; rebuilding the whole world's
// shadows each frame was most of the far field's upkeep.
const SHADOW_TURN_BRICKS = 0.5;
// The shadow heights' second channel (shaders/far.js farShadowFrag: casters outside a box of brick columns)
// leaves nothing out: the window is physics' alone, and the view reads the first. Intentional (seamless
// world: a window move costs the far field nothing, so its shadows don't follow the window).
const NO_SHADOW_BOX = [0, 0, 0, 0];
const EDGE_SAMPLES = 256;           // columns along the world's edge whose ground a sea-less world's plain beyond it is the median of
const TEX = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08 };   // (GPUTextureUsage's bits)
const BUFFER = { STORAGE: 0x80, COPY_DST: 0x08, COPY_SRC: 0x04 };                                // (GPUBufferUsage's bits)
const CUBE_REACH_BRICKS = 1;        // bricks around a changed cell whose cubes (FAR.CUBE, 2 cells past their brick) or votes (the cell over) read it

// The open level beyond a world's edge (cells): its sea, or for a world
// without one (sea 0: world/scenes) the plain the far view draws there, at the
// median height of the ground along its edge, so the plain meets it.
export function beyondLevel(scene, P) {
  if (P.sea > 0) return P.sea;
  const [wx, , wz] = P.size, per = 2 * (wx + wz), hs = [];
  for (let i = 0; i < EDGE_SAMPLES; i++) {
    const d = (i + 0.5) * per / EDGE_SAMPLES;   // distance along the edge, from (0, 0) round by +x
    const [x, z] = d < wx ? [d, 0] : d < wx + wz ? [wx - 1, d - wx] : d < 2 * wx + wz ? [2 * wx + wz - d, wz - 1] : [0, per - d];
    hs.push(scene.ground(Math.floor(x), Math.floor(z), P));
  }
  hs.sort((a, b) => a - b);
  return hs[EDGE_SAMPLES >> 1];
}

/**
 * World-cell boxes ({ lo, hi }, hi exclusive) to the world bricks whose summaries read them: [lo, hi) bricks,
 * CUBE_REACH_BRICKS around, held to the world (wb: its bricks). Exported for tools.
 */
export function changedBricks(box, wb) {
  const lo = box.lo.map((v) => Math.max(0, Math.floor(v / BRICK) - CUBE_REACH_BRICKS));
  const hi = box.hi.map((v, i) => Math.min(wb[i], Math.ceil(v / BRICK) + CUBE_REACH_BRICKS));
  return { lo, hi };
}
const volumeOf = ({ lo, hi }) => (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);

export class FarField {
  // win: the WorldWindow (its world's size, scene and simulation: the device and
  // tables; nothing of its cells); sun: the key light's direction (app.js SUN, a
  // unit vector the app keeps current). (The first argument was the WebGL
  // renderer; the far field works on the window's device.)
  constructor(_renderer, win, { sun } = {}) {
    this.win = win;
    this.sim = win.sim;
    this.gpu = win.sim.gpu;
    const sim = this.sim, gpu = this.gpu, g = sim.g, L = this.L = farLayout(win.size);
    const [bx, by, bz] = L.bricks.n;
    const tex3 = (label, format) => gpu.createTexture({ label, size: [bx, by, bz], dimension: '3d', format, usage: TEX.STORAGE_BINDING | TEX.TEXTURE_BINDING | TEX.COPY_SRC });
    const tex2 = (label, format) => gpu.createTexture({ label, size: [bx, bz], format, usage: TEX.STORAGE_BINDING | TEX.TEXTURE_BINDING | TEX.COPY_SRC });
    // Capability comes from the actual imported scene, never the selected view/style.
    this.sourceAppearance = SOURCE_APPEARANCE_ENABLED && !!win.scene.importManifest?.appearance;
    this.appearance = appearanceRegion(L.bricks.n, this.sourceAppearance ? win.scene.importManifest.appearance.totalWords : 0, gpu.device.limits.maxTextureDimension3D);
    this.grid = gpu.createTexture({ label: 'far grid + source appearance', size: this.appearance.size, dimension: '3d',
      format: FAR_FORMATS.grid, usage: TEX.STORAGE_BINDING | TEX.TEXTURE_BINDING | TEX.COPY_SRC | TEX.COPY_DST });
    this.field = tex3('far field', FAR_FORMATS.field);   // what the view draws (farBoostFrag)
    this.top = tex2('far tops', FAR_FORMATS.top);
    this.shadow = tex2('far shadow heights', FAR_FORMATS.shadow);
    this.occ = gpu.createBuffer({ label: 'far occupancy', size: occupancyWords(L) * 4, usage: BUFFER.STORAGE | BUFFER.COPY_SRC });
    this.views = {
      grid: this.grid.createView({ label: 'far grid', dimension: '3d' }),
      field: this.field.createView({ label: 'far field', dimension: '3d' }),
      top: this.top.createView({ label: 'far tops' }),
      shadow: this.shadow.createView({ label: 'far shadow heights' }),
    };
    this.sun = sun;
    this.built = false;          // a build from the world copy has started (the grid holds what it has summarized)
    this.dirty = false;          // the far grid changed since the levels, tops and shadows were built
    this.shadowStale = true;     // ...and the shadow heights since (or never built)
    this.shadowSun = null;       // the sun the shadow heights were built for (SHADOW_TURN_BRICKS)
    this.last = null;            // what the last build or refresh cost (tools)
    this.scene = win.scene;
    this.copy = null;            // the world copy it is built from (useWorldCopy)
    this.rev = 0;                // the copy's revision its changes were last taken at
    this.queue = [];             // chunks still to summarize (world brick column [x, z] of each), nearest last
    this.queued = new Set();     // ...their keys
    this.building = false;       // the queue holds the build's chunks (last.buildMs once it empties)
    this.chunksDrawn = 0;        // chunks summarized since the build began (the app redraws the view as it grows)
    this.stale = false;          // changes summarized since the levels were last rebuilt for them...
    this.age = 0;                // ...and frames since then
    this.vol = null;             // the volume whose lighting group the view binds (attachVolume)
    this.behind = false;         // drawBehind draws this frame (viewBehind)

    // the kernels (built while the window's are: whenReady)
    const tl = sim.L, E = gpu.L.EMPTY;
    const layout = (name, entries) => gpu.layout(name, entries);
    const kernel = (name, code, g2, params, g1 = E) => gpu.kernel({ name, code, layouts: [tl.TABLES, g1, g2], params });
    this.k = {
      copy: kernel('farCopy', farCopyFrag(g, L), layout('far copy', FAR_COPY_LAYOUT), RegionParams, layout('WORLD_COPY', WORLD_COPY_LAYOUT)),
      clear: kernel('farClear', farClearFrag(g, L), layout('far clear', FAR_CLEAR_LAYOUT), RegionParams),
      boost: kernel('farBoost', farBoostFrag(g, L), layout('far boost', FAR_BOOST_LAYOUT), RegionParams),
      mip1: kernel('farMip1', farMip1Frag(g, L), layout('far mip1', FAR_MIP1_LAYOUT)),
      mip2: kernel('farMip2', farMip2Frag(g, L), layout('far mip2', FAR_MIP2_LAYOUT)),
      top: kernel('farTop', farTopFrag(g, L), layout('far top', FAR_TOP_LAYOUT)),
      shadow: kernel('farShadow', farShadowFrag(g, L), layout('far shadow', FAR_SHADOW_LAYOUT), ShadowParams),
    };
    // the bind groups (the copy's own, group 1, is read from it at each dispatch: it is made again when its pool grows)
    const v = this.views, b = (buffer) => ({ buffer });
    const group = (k, entries, label) => gpu.bindGroup(k.groups[2], entries.map(([binding, resource]) => ({ binding, resource })), label);
    this.groupsFixed = {
      copy: group(this.k.copy, [[0, v.grid]], 'far copy'),
      clear: group(this.k.clear, [[0, v.grid], [1, v.field]], 'far clear'),
      boost: group(this.k.boost, [[0, v.grid], [1, v.field]], 'far boost'),
      mip1: group(this.k.mip1, [[0, v.field], [1, b(this.occ)]], 'far mip1'),
      mip2: group(this.k.mip2, [[1, b(this.occ)]], 'far mip2'),
      top: group(this.k.top, [[0, v.field], [1, v.top]], 'far top'),
      shadow: group(this.k.shadow, [[0, v.top], [1, gpu._volumeSamplers?.clamp ?? gpu.device.createSampler({ magFilter: 'linear', minFilter: 'linear' })], [2, v.shadow]], 'far shadow'),
    };

    // the view: its pipeline built the first time drawBehind wants it
    const P = win.P;
    this.level = beyondLevel(this.scene, P);
    this.sea = P.sea;
    this.floor = P.sea > 0 ? P.floor : this.level;
    this.fu = frameUniformsOf(gpu);
    this.viewFrameLayout = layout('FAR_VIEW_FRAME', FAR_VIEW_FRAME);
    this.viewFrameGroup = null;
    this.presentation = null;
    this.viewParams = {
      clipToWorld: new Matrix4(), worldToClip: new Matrix4(), eye: [0, 0, 0], sea: this.sea, winLo: [0, 0, 0], floor: this.floor,
      warpK: 0, warpAnchor: [0, 0], warpDir: [0, 1],
    };
    this._m = { toWorld: new Matrix4(), eye: new Vector3() };
    this.ready = false;   // (the build kernels: whenReady)
    this.disposed = false;
  }

  // Whether the rolling log bends the view now (gfx/presentation.js).
  get curved() { return !!this.presentation?.active && this.presentation.parameters.k !== 0; }

  /** Resolves when the build's kernels are ready (the window's whenReady waits for it); the view builds when it is first drawn (drawBehind). */
  whenReady() {
    return (this._ready ??= Promise.all(Object.values(this.k).map((k) => k.ready)).then(() => { this.ready = true; return this; }));
  }

  // The view's group 0: FrameUniforms, the field, the occupancy.
  _frameGroup() {
    return (this.viewFrameGroup ??= this.gpu.bindGroup(this.viewFrameLayout, [
      { binding: 0, resource: { buffer: this.fu.tables } }, { binding: 1, resource: { buffer: this.fu.uniforms.buffer } },
      { binding: 2, resource: this.views.field }, { binding: 3, resource: { buffer: this.occ } },
    ], 'far view frame'));
  }

  // A region kernel over world bricks [lo, lo + size) (x, y, z).
  box(kernel, group, lo, size, opts = {}) {
    kernel.dispatch(this.gpu.frame, regionDispatch(size), {
      bind: [this.sim.tables, opts.g1 ?? null, group], header: opts.header,
      params: { lo, size, chunkLo: [0, 0] },
    });
  }

  // A region kernel over world brick columns [lo, lo + size) (x, z), every height.
  region(kernel, group, lo, size, opts = {}) {
    this.box(kernel, group, [lo[0], 0, lo[1]], [size[0], this.L.bricks.n[1], size[1]], opts);
  }

  // The world copy's summary of world bricks [lo, lo + size) (x, y, z), and the field over them and the brick
  // around them (their neighbours changed). Needs the copy built (its bindGroup).
  summarizeBox(lo, size) {
    this.box(this.k.copy, this.groupsFixed.copy, lo, size, { g1: this.copy.bindGroup });
    const n = this.L.bricks.n, a = lo.map((v) => Math.max(v - 1, 0)), b = lo.map((v, i) => Math.min(v + size[i] + 1, n[i]));
    this.box(this.k.boost, this.groupsFixed.boost, a, b.map((v, i) => v - a[i]));
  }

  /**
   * Build the far field from the world copy (W's WorldCopy, built: docs/seamless-world.md) and keep it current
   * from its changes. The app calls it once the copy is built (wire/world.js, after worldView.build resolves),
   * and again after a rebuild of it; null stops it. near: the world cell [x, z] the build starts from (the
   * window's centre by default). The kernels may still be building: it starts once they are (whenReady).
   * @param {object|null} copy
   * @param {{ near?: number[] }} [opts]
   */
  useWorldCopy(copy, { near } = {}) {
    this.copy = copy ?? null;
    this.queue = [];
    this.queued.clear();
    if (!copy) return Promise.resolve(this);
    const s = this.L.size;
    if (copy.size.some((n, i) => n !== s[i])) throw new Error(`far field: world copy ${copy.size} for a world of ${s}`);
    return this.whenReady().then(() => {
      if (this.disposed || this.copy !== copy) return this;
      this._startBuild(near);
      return this;
    });
  }

  // (The window's load and a replica's backdrop asked for this when the far field was built from the window:
  // it starts the build if the copy is in and none has started. A load rebuilds the copy, whose whole-world
  // change then refreshes every chunk: tick.)
  build() { if (this.copy && this.ready && !this.built) this._startBuild(); }

  // The build: the grid and field cleared, every chunk queued nearest `near` last (tick takes them from the end).
  _startBuild(near) {
    if (!this.ready) throw new Error('far field: build before its kernels are ready (await whenReady)');
    const t0 = performance.now();
    const L = this.L, [bx, , bz] = L.bricks.n, C = FAR_SCENE.CHUNK;
    // Generator preparation has loaded and validated both files. The summary
    // only writes the original brick region, never these tail planes.
    this.unsubscribeAppearance?.();
    this.unsubscribeAppearance = null;
    if (this.appearance.planes) {
      const scene = this.scene;
      uploadAppearance(this.gpu, this.grid, scene.appearanceWords, this.appearance);
      this.unsubscribeAppearance = scene.subscribeAppearance?.((at, data) => {
        if (!this.disposed && this.scene === scene) uploadAppearanceRange(this.gpu, this.grid, scene.appearanceWords, this.appearance, at, data.length);
      });
    }
    this.region(this.k.clear, this.groupsFixed.clear, [0, 0], [bx, bz]);
    this.built = true;
    this.rev = this.copy?.revision ?? 0;
    this.queue = [];
    this.queued.clear();
    for (let z = 0; z < bz; z += C) for (let x = 0; x < bx; x += C) this._enqueue(x, z);
    this._sortQueue(near);
    this.building = true;
    this.chunksDrawn = 0;
    this.buildFrames = 0;
    this.buildStart = t0;
    this.stale = false;
    this.refresh(true);
    this.last = { buildMs: null, chunks: this.queue.length };
  }

  _enqueue(x, z) {
    const key = `${x},${z}`;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push([x, z]);
  }

  // The queue nearest `near` (world cells [x, z]; the window's centre by default) last.
  _sortQueue(near) {
    const o = this.sim.origin, g = this.sim.g, C = FAR_SCENE.CHUNK;
    const mid = (near ?? [o.x + g.nx / 2, o.z + g.nz / 2]).map((v) => v / BRICK);   // brick columns
    const dist = ([x, z]) => Math.hypot(x + C / 2 - mid[0], z + C / 2 - mid[1]);
    this.queue.sort((a, b) => dist(b) - dist(a));
  }

  // The next chunks of the queue (tick, every frame while there are any; tools drain it).
  chunks(n = this.gpu.adapterInfo?.isFallbackAdapter ? SOFTWARE_CHUNKS_PER_FRAME : COPY_CHUNKS_PER_FRAME) {
    const [bx, by, bz] = this.L.bricks.n, C = FAR_SCENE.CHUNK;
    for (let k = 0; k < n && this.queue.length; k++) {
      const [x, z] = this.queue.pop();
      this.queued.delete(`${x},${z}`);
      this.summarizeBox([x, 0, z], [Math.min(C, bx - x), by, Math.min(C, bz - z)]);
      this.chunksDrawn++;
    }
    this.buildFrames++;
    if (!this.queue.length) {
      this.dirty = true;
      if (this.building) this.last = { ...this.last, buildMs: performance.now() - this.buildStart, frames: this.buildFrames };
      this.building = false;
    } else if (this.buildFrames % BUILD_REFRESH_FRAMES === 0) this.dirty = true;
  }

  // What the copy changed since the last tick, summarized again (CHANGE_BRICKS_PER_FRAME; more joins the queue).
  _changes() {
    const copy = this.copy;
    if (copy.revision === this.rev) return;
    const boxes = copy.changesSince(this.rev);
    this.rev = copy.revision;
    if (!boxes.length) return;
    const wb = this.L.bricks.n, C = FAR_SCENE.CHUNK;
    let regions = boxes.map((b) => changedBricks(b, wb)).filter((r) => volumeOf(r) > 0);
    if (regions.length > CHANGE_BOXES_MERGE) {
      const all = { lo: [0, 1, 2].map((i) => Math.min(...regions.map((r) => r.lo[i]))), hi: [0, 1, 2].map((i) => Math.max(...regions.map((r) => r.hi[i]))) };
      if (volumeOf(all) <= CHANGE_BRICKS_PER_FRAME) regions = [all];
    }
    let budget = CHANGE_BRICKS_PER_FRAME, queued = false;
    for (const r of regions) {
      const v = volumeOf(r);
      if (v <= budget) {
        this.summarizeBox(r.lo, r.hi.map((h, i) => h - r.lo[i]));
        budget -= v;
        this.stale = true;
        continue;
      }
      for (let z = Math.floor(r.lo[2] / C) * C; z < r.hi[2]; z += C) for (let x = Math.floor(r.lo[0] / C) * C; x < r.hi[0]; x += C) this._enqueue(x, z);
      queued = true;
    }
    if (queued) this._sortQueue();
  }

  // Every frame (world/window.js update; a replica's follow): what the copy changed, the queue's next chunks,
  // and the levels, tops and shadows due for a rebuild. Nothing here reads the window.
  tick() {
    if (!this.built || !this.copy?.bindGroup) return;
    this._changes();
    if (this.queue.length) this.chunks();
    this.age++;
    if (this.stale && this.age >= CHANGE_REFRESH_FRAMES) { this.dirty = true; this.stale = false; this.age = 0; }
  }

  // Rebuild what derives from the far grid (after it changed) and the shadow
  // heights (after that, or a sun move). force: all of it.
  refresh(force = false) {
    if (!this.built) return;
    const s = this.sun, f = this.gpu.frame, t = this.sim.tables, F = this.groupsFixed;
    const t0 = performance.now();
    let what = 0;
    if (this.dirty || force) {
      this.k.mip1.dispatch(f, nodeDispatch(this.L.l1), { bind: [t, null, F.mip1] });
      this.k.mip2.dispatch(f, nodeDispatch(this.L.l2), { bind: [t, null, F.mip2] });
      this.k.top.dispatch(f, columnDispatch(this.L), { bind: [t, null, F.top] });
      this.dirty = false;
      this.shadowStale = true;
      what++;
    }
    const d = this.shadowSun;
    const turned = !d || d[0] * s.x + d[1] * s.y + d[2] * s.z < Math.cos(SHADOW_TURN_BRICKS * BRICK / this.L.size[1]);
    if (this.shadowStale || turned) {
      this.k.shadow.dispatch(f, columnDispatch(this.L), {
        bind: [t, null, F.shadow],
        params: { sun: [s.x, s.y, s.z], winCols: NO_SHADOW_BOX },
      });
      this.shadowStale = false;
      this.shadowSun = [s.x, s.y, s.z];
      what++;
    }
    if (what) this.last = { ...this.last, refreshMs: performance.now() - t0 };
  }

  // The volume whose lighting group the view binds, the far grid, tops and
  // shadow heights put in it (nothing else of the volume reads them), so the
  // view's ground has its elements and the sun's shadow.
  attachVolume(vol) {
    if (this.vol && this.vol !== vol) this.vol.attachFar(null);
    this.vol = vol;
    vol?.attachFar({ grid: this.views.grid, top: this.views.top, shadow: this.views.shadow });
  }

  // The view's params for the camera FrameUniforms holds now (the frame's
  // jittered one, or a still's): world cells → clip and back, the eye.
  _params() {
    const o = this.sim.origin, last = this.fu.last, p = this.viewParams, m = this._m;
    // world cells → clip: the volume's model (grid → scene) after world → grid
    m.toWorld.makeTranslation(-o.x, -o.y, -o.z);
    p.worldToClip.multiplyMatrices(last.viewProj, last.model).multiply(m.toWorld);
    p.clipToWorld.copy(p.worldToClip).invert();
    m.eye.copy(last.eye).applyMatrix4(m.toWorld.copy(last.model).invert());
    p.eye = [m.eye.x + o.x, m.eye.y + o.y, m.eye.z + o.z];
    p.winLo = [o.x, o.y, o.z];
    // the rolling log's parameters (world cells, as these are), or flat
    const w = this.curved ? this.presentation.parameters : null;
    p.warpK = w ? w.k : 0;
    p.warpAnchor = w ? w.anchor : [0, 0];
    p.warpDir = w ? w.dir : [0, 1];
    return p;
  }

  /**
   * Big maps' distance level of detail (app.js drawSkyFor): the view drawn behind
   * the window's volume, after the sky, without writing depth, marched past the
   * window's box, so the volume draws the window and the coarse grid the world past
   * it. The rule of every engine's LOD: a coarser level past the fine one (Tanner
   * et al. 1998, "The Clipmap"). Its ground is the far grid's coarse surface.
   * @param {GPURenderPassEncoder} rp
   * @returns {boolean} whether it drew
   */
  drawBehind(rp) {
    if (!this.behind || !this.vol) return false;
    const pipe = this.behindPipeline;
    if (pipe.state !== 'ready') { if (pipe.state === 'idle') pipe.build().then(() => this.onChange?.(), () => {}); return false; }
    pipe.draw(rp, { bind: [this._frameGroup(), this.sim.bindRO, this.vol.lightingGroup], params: this._params(),
      header: { ...this.sim.readHeader(), origin: [0, 0, 0] }, count: 3 });
    return true;
  }

  // Before a WORLD frame: whether drawBehind draws (visible: the realistic
  // view), and what derives from the grid brought up to date.
  viewBehind(visible) {
    this.behind = visible && this.built;
    if (this.built) this.refresh();
  }

  // drawBehind's pipeline: the view's, flat or the rolling log's.
  get behindPipeline() {
    const curved = this.curved, key = curved ? 'behindCurved' : 'behindFlat';
    return (this[key] ??= this.gpu.renderPipeline({
      name: curved ? 'far view behind curved' : 'far view behind', code: farFrag(this.sim.g, this.L, { curved, sourceAppearance: this.sourceAppearance }),
      layouts: [this.viewFrameLayout, this.sim.L.STATE_RO, this.gpu.L.LIGHTING],
      params: FarViewParams, ...farViewPipeline(), build: 'manual',
    }));
  }

  dispose() {
    this.disposed = true;
    this.unsubscribeAppearance?.();
    this.unsubscribeAppearance = null;
    this.queue = [];
    this.copy = null;
    this.vol?.attachFar(null);
    const retire = (b) => b && this.sim._retire(b);
    for (const t of [this.grid, this.field, this.top, this.shadow, this.occ]) retire(t);
  }
}

import { Matrix4, Vector3 } from 'three/webgpu';
import { BRICK } from '../shaders/common.js';
import {
  farLayout, FAR, FAR_SCENE, farSceneLayout, FAR_FORMATS, occupancyWords,
  farWinFrag, farSceneFrag, farSceneCellsFrag, farClearFrag, farBoostFrag, farMip1Frag, farMip2Frag, farTopFrag, farShadowFrag,
  farTreeCandFrag, farTreeThinFrag, farTreeBandFrag, farFrag,
  RegionParams, regionDispatch, SceneCellsParams, sceneCellsDispatch, ShadowParams, columnDispatch, nodeDispatch,
  FAR_WIN_LAYOUT, FAR_SCENE_LAYOUT, FAR_CLEAR_LAYOUT, FAR_BOOST_LAYOUT, FAR_MIP1_LAYOUT, FAR_MIP2_LAYOUT, FAR_TOP_LAYOUT,
  FAR_SHADOW_LAYOUT, FAR_TREE_BAND_LAYOUT, SCENE_CELLS_LAYOUT_OF, SCENE_CELLS_BINDING, TREE_CAND_LAYOUT, TREE_THIN_LAYOUT,
  TREE_CAND_BINDING, FAR_VIEW_FRAME, FarViewParams, farViewPipeline,
} from '../shaders/far.js';
import { frameUniformsOf } from '../gfx/uniforms.js';
import { appearanceRegion, uploadAppearance, uploadAppearanceRange, SOURCE_APPEARANCE_ENABLED } from '../gfx/sourceAppearance.js';

// The far field of a big map (docs/scaling.md D11, phase W4; docs/webgpu.md
// G1; the WGSL and the far grid's layout are in shaders/far.js): a
// brick-resolution grid of the whole world, its distance level of detail,
// drawn behind the big map's volume wherever that has nothing (drawBehind).
//
// Built from the world's scene (world/scenes), progressively: the window's
// region from its state at once, then the rest a chunk at a time from the
// scene's sceneCell (shaders/far.js farSceneCellsFrag, farSceneFrag),
// SCENE_CHUNKS_PER_FRAME chunks a frame (or the scene's farChunksPerFrame)
// in tick, nearest the window first, so no frame is long and the far field
// fills in around you; the view draws what is built so far (the rest is the
// plain or sea beyond: unbuilt bricks are empty). A brick column the window
// has summarized (on load, a leaving slab, a sweep) is left as it is (the
// window mask): the window's state wins there. The occupancy levels, tops and
// shadows follow every SCENE_REFRESH_FRAMES frames of it, and at its end. A
// scene with trees (scene.trees: the island) has them placed first, on the
// GPU (a candidate per brick column, thinned: its treesIn's own placement),
// and each chunk's bricks join the shapes of the trees in reach. The chunks'
// sceneCell runs after the scene's prepass over the chunk (the island's:
// world/gpu.js SceneGpu.prepass), the window's generator's resources shared.
//
// Kept up to date from the window, whose state wins wherever it has been:
//   - a move summarizes the slab about to leave (world/window.js, before the
//     shift), so what was built, burnt or dug there stays in the far view;
//   - while the simulation changes the window, it is summarized too, a slab of
//     SWEEP_CELLS a frame, a sweep at most every SWEEP_FRAMES frames;
//   - after these the occupancy levels, the brick-column tops and the shadow
//     heights are rebuilt (refresh: after a leaving slab, at the next view,
//     since the view marches it; after a sweep, at its end), and the shadow
//     heights again when the sun or the window moves.
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

const SWEEP_FRAMES = 120;        // frames between sweeps over the window's own region while the sim changes it (its copy only casts the far shadows and feeds the window's GI)
const SWEEP_CELLS = 16;          // ...summarizing this many cells of it along x per frame
const SCENE_CHUNKS_PER_FRAME = 1;   // a scene's far build: chunks a frame (each ~0.6M sceneCells, then twice a leaving slab's summary;
                                    // 256 chunks: ~4 s at 60 fps, the chunks around the window in the first few frames),
                                    // unless the scene says how many (farChunksPerFrame: cheap cells)
const SCENE_REFRESH_FRAMES = 8;     // ...and frames between rebuilding the levels, tops and shadows while it runs
const SOFTWARE_CHUNKS_PER_FRAME = 1;   // on a software adapter (SwiftShader: the container, ?software=1) a chunk is
                                       // seconds of CPU: one a frame, whatever the scene says
// The shadow heights are rebuilt once the sun has turned this many bricks' worth since (or the window moved):
// a column h cells tall moves its shadow's edge by about h·angle cells, so at the world's full height the edge
// moves less than this share of a brick. The day cycle turns the sun every frame; rebuilding the whole world's
// shadows each frame was most of the far field's upkeep.
const SHADOW_TURN_BRICKS = 0.5;
const EDGE_SAMPLES = 256;           // columns along the world's edge whose ground a sea-less world's plain beyond it is the median of
const TEX = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08 };   // (GPUTextureUsage's bits)
const BUFFER = { STORAGE: 0x80, COPY_DST: 0x08, COPY_SRC: 0x04 };                                // (GPUBufferUsage's bits)

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

export class FarField {
  // win: the WorldWindow; sun: the key light's direction (app.js SUN, a unit
  // vector the app keeps current). (The first argument was the WebGL renderer;
  // the far field works on the window's device. time: the volume's clock,
  // FrameUniforms.time now.)
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
    // a bit per world brick column: the window's state has been summarized there
    this.winMask = new Uint32Array(Math.ceil(bx * bz / 32));
    this.winMaskBuf = gpu.createBuffer({ label: 'far window mask', size: Math.max(16, this.winMask.byteLength), usage: BUFFER.STORAGE | BUFFER.COPY_DST });
    this.maskDirty = false;
    this.sun = sun;
    this.built = false;
    this.dirty = false;          // the far grid changed since the levels, tops and shadows were built
    this.shadowKey = '';         // the window the shadow heights were built for...
    this.shadowSun = null;       // ...and the sun (SHADOW_TURN_BRICKS)
    this.age = 0;                // frames since the last sweep over the window's region began
    this.version = -1;           // the simulation's version then
    this.sweep = -1;             // the next slab of the sweep under way (-1: none)
    this.last = null;            // what the last build or refresh cost (tools)
    this.scene = win.scene;
    this.queue = [];             // a scene's far build: the chunks still to draw (world brick column [x, z] of each), nearest last
    this.chunksDrawn = 0;        // ...and how many it has drawn (the app redraws the view as it grows)
    this.cells = null;           // the scene cells of a chunk while a build runs
    this.trees = null;           // the tree map and bands while a build with trees runs
    this.vol = null;             // the volume whose lighting group the view binds (attachVolume)
    this.behind = false;         // drawBehind draws this frame (viewBehind)

    // the kernels (built while the window's are: whenReady)
    const S = this.cellsLayout = farSceneLayout(L);
    const trees = !!this.scene.trees, tl = sim.L, E = gpu.L.EMPTY;
    const layout = (name, entries) => gpu.layout(name, entries);
    const kernel = (name, code, g2, params, state = E) => gpu.kernel({ name, code, layouts: [tl.TABLES, state, g2], params });
    const sceneKey = JSON.stringify(SCENE_CELLS_LAYOUT_OF(this.scene));
    this.k = {
      win: kernel('farWin', farWinFrag(g, L), layout('far win', FAR_WIN_LAYOUT), RegionParams, tl.STATE_RO),
      scene: kernel(`farScene${trees ? ' trees' : ''}`, farSceneFrag(g, L, trees), layout(`far scene${trees ? ' trees' : ''}`, FAR_SCENE_LAYOUT(trees)), RegionParams),
      cells: kernel(`${this.scene.key} farSceneCells`, farSceneCellsFrag(g, L, this.scene.glsl(g), S), layout(`far scene cells ${sceneKey}`, SCENE_CELLS_LAYOUT_OF(this.scene)), SceneCellsParams),
      clear: kernel('farClear', farClearFrag(g, L), layout('far clear', FAR_CLEAR_LAYOUT), RegionParams),
      boost: kernel('farBoost', farBoostFrag(g, L), layout('far boost', FAR_BOOST_LAYOUT), RegionParams),
      mip1: kernel('farMip1', farMip1Frag(g, L), layout('far mip1', FAR_MIP1_LAYOUT)),
      mip2: kernel('farMip2', farMip2Frag(g, L), layout('far mip2', FAR_MIP2_LAYOUT)),
      top: kernel('farTop', farTopFrag(g, L), layout('far top', FAR_TOP_LAYOUT)),
      shadow: kernel('farShadow', farShadowFrag(g, L), layout('far shadow', FAR_SHADOW_LAYOUT), ShadowParams),
      ...(trees ? {
        cand: kernel(`${this.scene.key} farTreeCand`, farTreeCandFrag(g, L, null, this.scene.trees.glsl()), layout(`far tree cand ${sceneKey}`, TREE_CAND_LAYOUT(this.scene))),
        thin: kernel(`${this.scene.key} farTreeThin`, farTreeThinFrag(g, L, null, this.scene.trees.glsl()), layout(`far tree thin ${sceneKey}`, TREE_THIN_LAYOUT(this.scene))),
        band: kernel('farTreeBand', farTreeBandFrag(g, L), layout('far tree band', FAR_TREE_BAND_LAYOUT)),
      } : {}),
    };
    // the bind groups that don't change (the scene's are made once its resources are: groups())
    const v = this.views, b = (buffer) => ({ buffer });
    const group = (k, entries, label) => gpu.bindGroup(k.groups[2], entries.map(([binding, resource]) => ({ binding, resource })), label);
    this.groupsFixed = {
      win: group(this.k.win, [[0, v.grid]], 'far win'),
      clear: group(this.k.clear, [[0, v.grid], [1, v.field]], 'far clear'),
      boost: group(this.k.boost, [[0, v.grid], [1, v.field]], 'far boost'),
      mip1: group(this.k.mip1, [[0, v.field], [1, b(this.occ)]], 'far mip1'),
      mip2: group(this.k.mip2, [[1, b(this.occ)]], 'far mip2'),
      top: group(this.k.top, [[0, v.field], [1, v.top]], 'far top'),
      shadow: group(this.k.shadow, [[0, v.top], [1, gpu._volumeSamplers?.clamp ?? gpu.device.createSampler({ magFilter: 'linear', minFilter: 'linear' })], [2, v.shadow]], 'far shadow'),
    };
    this.g = null;

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

  // The bind groups over the scene's resources (the window's generator's,
  // made once it has prepared) and the build's buffers.
  groups() {
    if (this.g) return this.g;
    const res = this.win.gen.res, gpu = this.gpu, k = this.k;
    const S = this.cellsLayout, [bx, , bz] = this.L.bricks.n;
    this.cells = gpu.createBuffer({ label: 'far scene cells', size: S.cells * 4, usage: BUFFER.STORAGE });
    const g = {
      cells: gpu.bindGroup(k.cells.groups[2], res.entries([{ binding: SCENE_CELLS_BINDING, resource: { buffer: this.cells } }]), 'far scene cells'),
    };
    const sceneEntries = [
      { binding: 0, resource: this.views.grid }, { binding: 1, resource: { buffer: this.cells } }, { binding: 2, resource: { buffer: this.winMaskBuf } },
    ];
    if (this.scene.trees) {
      const U = BUFFER.STORAGE, cols = bx * bz;
      this.treeBufs = {
        cand: gpu.createBuffer({ label: 'far tree candidates', size: cols * 16, usage: U }),
        map: gpu.createBuffer({ label: 'far tree map', size: cols * 16, usage: U | BUFFER.COPY_SRC }),
        band: gpu.createBuffer({ label: 'far tree bands', size: cols * 8, usage: U }),
      };
      const t = this.treeBufs;
      g.cand = gpu.bindGroup(k.cand.groups[2], res.entries([{ binding: TREE_CAND_BINDING, resource: { buffer: t.cand } }]), 'far tree cand');
      g.thin = gpu.bindGroup(k.thin.groups[2], res.entries([
        { binding: TREE_CAND_BINDING, resource: { buffer: t.cand } }, { binding: TREE_CAND_BINDING + 1, resource: { buffer: t.map } }]), 'far tree thin');
      g.band = gpu.bindGroup(k.band.groups[2], [{ binding: 0, resource: { buffer: t.map } }, { binding: 1, resource: { buffer: t.band } }], 'far tree band');
      sceneEntries.push({ binding: 3, resource: { buffer: t.map } }, { binding: 4, resource: { buffer: t.band } });
    }
    g.scene = gpu.bindGroup(k.scene.groups[2], sceneEntries, 'far scene');
    return (this.g = g);
  }

  // A region kernel over world brick columns [lo, lo + size) (x, z), every height.
  region(kernel, group, lo, size, opts = {}) {
    const n = [size[0], this.L.bricks.n[1], size[1]];
    kernel.dispatch(this.gpu.frame, regionDispatch(n), {
      bind: [this.sim.tables, opts.state ?? null, group], header: opts.header,
      params: { lo: [lo[0], 0, lo[1]], size: n, chunkLo: opts.chunkLo ?? [0, 0] },
    });
  }

  // The field over world bricks [lo, lo + size) and the brick around them (their neighbours changed).
  boost(lo, size) {
    const [bx, , bz] = this.L.bricks.n;
    const a = [Math.max(lo[0] - 1, 0), Math.max(lo[1] - 1, 0)];
    const b = [Math.min(lo[0] + size[0] + 1, bx), Math.min(lo[1] + size[1] + 1, bz)];
    this.region(this.k.boost, this.groupsFixed.boost, a, [b[0] - a[0], b[1] - a[1]]);
  }

  // Build the far grid from the scene (world/window.js load: the window has
  // just been generated): its region from the window's state now, the rest
  // over the next frames (tick). Needs whenReady.
  build() { this.sceneBuild(); }

  // A scene's build: the far grid starts empty but for the window's region,
  // summarized from its state, and the chunks are queued nearest the window
  // last (tick draws them from the end).
  sceneBuild() {
    if (!this.ready) throw new Error('far field: build before its kernels are ready (await whenReady)');
    const t0 = performance.now();
    const L = this.L, [bx, , bz] = L.bricks.n, C = FAR_SCENE.CHUNK;
    this.groups();
    // Generator preparation has loaded and validated both files. Terrain
    // kernels only write the original brick region, never these tail planes.
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
    this.winMask.fill(0);
    this.maskDirty = true;
    this.built = true;
    this.summarizeWindow();
    const o = this.sim.origin, g = this.sim.g;
    const mid = [(o.x + g.nx / 2) / BRICK, (o.z + g.nz / 2) / BRICK];   // the window's centre, brick columns
    const dist = ([x, z]) => Math.hypot(x + C / 2 - mid[0], z + C / 2 - mid[1]);
    this.queue = [];
    for (let z = 0; z < bz; z += C) for (let x = 0; x < bx; x += C) {
      // Sparse folded terrain can prove an entire column empty. Include the
      // far filter's sample halo; all other scenes keep the existing queue.
      const halo = (FAR.CUBE - BRICK) / 2;
      if (this.scene.mayContainCellsXZ?.([x * BRICK, z * BRICK],
        [Math.min(x + C, bx) * BRICK, Math.min(z + C, bz) * BRICK], halo) === false) continue;
      this.queue.push([x, z]);
    }
    this.queue.sort((a, b) => dist(b) - dist(a));
    this.chunksDrawn = 0;
    this.buildFrames = 0;
    this.buildStart = t0;
    if (this.scene.trees) this.placeTreeMaps();
    this.refresh(true);
    this.last = { buildMs: null, chunks: this.queue.length };
  }

  // The window mask to the GPU, if it changed (before a chunk reads it).
  _uploadMask() {
    if (!this.maskDirty) return;
    this.gpu.write(this.winMaskBuf, 0, this.winMask);
    this.maskDirty = false;
  }

  // Draw the next chunks of a scene's build (tick, every frame while there are any).
  sceneChunks(n = this.gpu.adapterInfo?.isFallbackAdapter ? SOFTWARE_CHUNKS_PER_FRAME : this.scene.farChunksPerFrame ?? SCENE_CHUNKS_PER_FRAME) {
    const L = this.L, [bx, , bz] = L.bricks.n, C = FAR_SCENE.CHUNK, S = this.cellsLayout, res = this.win.gen.res;
    const lo = (FAR.CUBE - BRICK) / 2;   // the cells a brick's cube reaches past it (FAR_CUBE_LO)
    const g = this.groups(), f = this.gpu.frame, WY = L.size[1];
    this._uploadMask();
    for (let k = 0; k < n && this.queue.length; k++) {
      const [x, z] = this.queue.pop(), size = [Math.min(C, bx - x), Math.min(C, bz - z)];
      const chunkLo = [x * BRICK - lo, z * BRICK - lo];
      // the scene's prepass over the columns the cells read (held to the world, as they are)
      const c0 = chunkLo.map((v, i) => Math.max(0, v)), c1 = chunkLo.map((v, i) => Math.min(L.size[2 * i], v + S.side));
      res.prepassFor([c0[0], 0, c0[1]], [c1[0], WY, c1[1]]);
      this.k.cells.dispatch(f, sceneCellsDispatch(S), { bind: [this.sim.tables, null, g.cells], params: { chunkLo } });
      this.region(this.k.scene, g.scene, [x, z], size, { chunkLo });
      this.boost([x, z], size);
      this.chunksDrawn++;
    }
    this.buildFrames++;
    if (!this.queue.length) {
      this.sim._retire(this.cells);
      this.cells = null;
      this.disposeTreeMaps();
      this.g = null;
      this.dirty = true;
      this.last = { ...this.last, buildMs: performance.now() - this.buildStart, frames: this.buildFrames };
    } else if (this.buildFrames % SCENE_REFRESH_FRAMES === 0) this.dirty = true;
  }

  // The scene's trees, as its treesIn places them: the tree map, a vec4f per
  // brick column (shaders/far.js treeOf), recorded now.
  // (tools/far-check.mjs compares it with treesIn.)
  placeTrees() {
    const g = this.groups(), f = this.gpu.frame, d = columnDispatch(this.L), t = this.sim.tables;
    this.k.cand.dispatch(f, d, { bind: [t, null, g.cand] });
    this.k.thin.dispatch(f, d, { bind: [t, null, g.thin] });
    return this.treeBufs.map;
  }

  // The tree map and the band each brick column finds its trees in, for the
  // chunks of a build (sceneBuild; disposeTreeMaps when it's done).
  placeTreeMaps() {
    const g = this.groups();
    this.placeTrees();
    this.k.band.dispatch(this.gpu.frame, columnDispatch(this.L), { bind: [this.sim.tables, null, g.band] });
    this.trees = this.treeBufs;
  }

  disposeTreeMaps() {
    if (!this.treeBufs) return;
    for (const b of Object.values(this.treeBufs)) this.sim._retire(b);
    this.treeBufs = null;
    this.trees = null;
  }

  // Summarize the window's bricks [lo, lo + bricks) (grid cells lo, brick
  // aligned; bricks along x, y, z) into the far grid, at the window's origin:
  // the slab about to leave on a move (before the shift), a slab of a sweep,
  // or all of it. derive: rebuild what derives from the grid before the next view.
  summarize(lo, bricks, derive = true) {
    if (!this.built) return;
    const sim = this.sim, o = sim.origin;
    const at = [(o.x + lo[0]) / BRICK, (o.z + lo[2]) / BRICK], size = [bricks[0], bricks[2]];
    this.region(this.k.win, this.groupsFixed.win, at, size, { state: sim.bindRO, header: sim.readHeader() });
    this.boost(at, size);
    if (derive) this.dirty = true;
    const bx = this.L.bricks.n[0];
    for (let z = at[1]; z < at[1] + size[1]; z++)
      for (let x = at[0]; x < at[0] + size[0]; x++) { const i = z * bx + x; this.winMask[i >> 5] |= 1 << (i & 31); }
    this.maskDirty = true;
  }

  summarizeWindow() {
    const g = this.sim.g;
    this.summarize([0, 0, 0], [g.nx / BRICK, g.ny / BRICK, g.nz / BRICK]);
    this.sweep = -1;
    this.age = 0;
    this.version = this.sim.version;
  }

  // Every frame (world/window.js update): the build's next chunks, and a sweep
  // over the window's region, a slab a frame, while the simulation changes it.
  tick() {
    if (!this.built) return;
    if (this.queue.length) this.sceneChunks();
    const g = this.sim.g;
    this.age++;
    if (this.sweep < 0 && this.sim.version !== this.version && this.age >= SWEEP_FRAMES) {
      this.sweep = 0;
      this.age = 0;
      this.version = this.sim.version;
    }
    if (this.sweep >= 0) {
      const x = this.sweep * SWEEP_CELLS, last = x + SWEEP_CELLS >= g.nx;
      this.summarize([x, 0, 0], [SWEEP_CELLS / BRICK, g.ny / BRICK, g.nz / BRICK], last);
      this.sweep = last ? -1 : this.sweep + 1;
    }
  }

  // Rebuild what derives from the far grid (after it changed) and the shadow
  // heights (after that, a sun move or a window move). force: all of it.
  refresh(force = false) {
    if (!this.built) return;
    const sim = this.sim, o = sim.origin, g = sim.g, s = this.sun, f = this.gpu.frame, t = sim.tables, F = this.groupsFixed;
    const t0 = performance.now();
    let what = 0;
    if (this.dirty || force) {
      this.k.mip1.dispatch(f, nodeDispatch(this.L.l1), { bind: [t, null, F.mip1] });
      this.k.mip2.dispatch(f, nodeDispatch(this.L.l2), { bind: [t, null, F.mip2] });
      this.k.top.dispatch(f, columnDispatch(this.L), { bind: [t, null, F.top] });
      this.dirty = false;
      this.shadowKey = '';
      what++;
    }
    const key = `${o.x},${o.z}`, d = this.shadowSun;
    const turned = !d || d[0] * s.x + d[1] * s.y + d[2] * s.z < Math.cos(SHADOW_TURN_BRICKS * BRICK / this.L.size[1]);
    if (key !== this.shadowKey || turned) {
      this.k.shadow.dispatch(f, columnDispatch(this.L), {
        bind: [t, null, F.shadow],
        params: { sun: [s.x, s.y, s.z], winCols: [o.x / BRICK, o.z / BRICK, (o.x + g.nx) / BRICK, (o.z + g.nz) / BRICK] },
      });
      this.shadowKey = key;
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
   * Big maps' distance level of detail (the WORLD renderer: wire/worldRenderFrame.js,
   * app.js drawWorldSky): the view drawn behind the WORLD volume, after the sky,
   * without writing depth, so the volume draws over it wherever it hits and the
   * coarse grid shows only where the volume has nothing (a brick not loaded yet,
   * one the GPU page budget dropped, or past what it asks for), never the sky
   * through the ground. The rule of every engine's LOD and of virtual texturing:
   * a missing fine page falls back to a coarser one that is always resident
   * (UE5 virtual textures, Nanite's root pages; Tanner et al. 1998, "The Clipmap").
   * The far field was the big maps' coarse level until 2026-10-15 (dc480f4f);
   * the WORLD renderer had none since, so a missing brick drew the sky's grey.
   * Its ground is the far grid's coarse surface (9fef2822 had left opaque
   * terrain to detail meshes that were never drawn behind the WORLD volume:
   * the fallback showed sea and sky where land was; 2026-10-23).
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
    this.vol?.attachFar(null);
    const retire = (b) => b && this.sim._retire(b);
    for (const t of [this.grid, this.field, this.top, this.shadow, this.occ, this.winMaskBuf, this.cells]) retire(t);
    this.cells = null;
    this.disposeTreeMaps();
  }
}

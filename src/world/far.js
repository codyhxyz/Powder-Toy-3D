import * as THREE from 'three';
import { BRICK } from '../shaders/common.js';
import { columnFrag, COLUMN_MARGIN } from '../shaders/generate.js';
import {
  farLayout, farRegionVert, farLayersFrag, farTreeCandFrag, farTreeThinFrag, farTreeBandFrag, farGenFrag,
  farWinFrag, farBoostFrag, farMip1Frag, farMip2Frag, farTopFrag, farShadowFrag, farVert, farFrag, WORLD_SIZE,
  farSceneCellsFrag, farSceneFrag, farSceneLayout, FAR_SCENE, FAR,
} from '../shaders/far.js';
import { rawMat, makeFieldTarget } from '../sim.js';
import { genUniforms, setWorld } from './gpu.js';
import { gfxUniforms } from '../gfx/uniforms.js';

// The far field of a massive world (docs/scaling.md D11, phase W4; the GLSL
// and the far grid's layout are in shaders/far.js): a brick-resolution grid of
// the whole world, drawn wherever the window isn't.
//
// Built at world load from the generator, at world scale: genColumn for every
// world column, genLayers for every column, the trees (a candidate per brick
// column, thinned: treesIn's own placement), then every brick from the layers
// of the columns its cube spans and the shapes of the trees in reach.
//
// Kept up to date from the window, whose state wins wherever it has been:
//   - a move summarizes the slab about to leave (world/window.js, before the
//     shift), so what was built, burnt or dug there stays in the far view;
//   - while the simulation changes the window, it is summarized too, a slab of
//     SWEEP_CELLS a frame, a sweep at most every SWEEP_FRAMES frames: the far
//     grid's copy of it casts the far field's shadows (and the field next to
//     the window's sides blends into it);
//   - after these the occupancy levels, the brick-column tops and the shadow
//     heights are rebuilt (refresh: after a leaving slab, at once, since the
//     view marches it; after a sweep, at its end), and the shadow heights
//     again when the sun or the window moves.
//
// Any other world scene (world/scenes) is built from its sceneCell instead
// (shaders/far.js farSceneCellsFrag, farSceneFrag): the window's region from
// its state at once, then the rest a chunk at a time, SCENE_CHUNKS_PER_FRAME
// chunks a frame (tick), nearest the window first, so no draw is long and the
// far field fills in around you; the view draws what is built so far (the
// rest is the plain or sea beyond: unbuilt bricks are empty). A brick column
// the window has summarized (on load, a leaving slab, a sweep) is left as it
// is (winMask): the window's state wins there. The levels, tops and shadows
// follow every SCENE_REFRESH_FRAMES frames of it, and at its end.
//
// The window takes three things from the far field (attach): its shadow map
// the far field's shadows (a mountain outside shades the window, and its GI),
// its GI the far field past where its rays end (distant hills block the low
// sky and light it back), and its volume the same aerial perspective, so the
// window doesn't stand out crisper than the land around it at the same distance.
//
// The view is one full-screen pass drawn before everything else in the scene
// (FarField.mesh): sky, the open sea beyond the world and the far grid, with
// depth, so the window's volume and the scene's objects composite over it.
// It marches the far grid past the window's box, which the volume draws.

const SWEEP_FRAMES = 120;        // frames between sweeps over the window's own region while the sim changes it (its copy only casts the far shadows and feeds the window's GI)
const SWEEP_CELLS = 16;          // ...summarizing this many cells of it along x per frame
const VIEW_ORDER = -10;          // renderOrder of the view: first of the scene's opaque objects
const SCENE_CHUNKS_PER_FRAME = 2;   // a scene's far build: chunks a frame (each one sceneCell per cell of its columns, ~0.6M cells)
const SCENE_REFRESH_FRAMES = 8;     // ...and frames between rebuilding the levels, tops and shadows while it runs
const MASK_SET = 255;               // a set byte of the window mask (the shader reads it as 1)

// A full-screen triangle (clip space): the view's geometry.
function screenTriangle() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return geo;
}

// One quad per brick slice of the far grid (shaders/far.js farRegionVert): x, y the corner, z the slice.
function sliceQuads(slices) {
  const corners = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
  const v = [];
  for (let s = 0; s < slices; s++) for (const [x, y] of corners) v.push(x, y, s);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return geo;
}

export class FarField {
  // win: the WorldWindow; sun: the key light's direction (app.js SUN); time:
  // the volume's uTime uniform (animated looks: ripples, lava)
  constructor(renderer, win, { sun, time }) {
    this.renderer = renderer;
    this.win = win;
    this.sim = win.sim;
    const g = this.sim.g, L = this.L = farLayout(win.size);
    // the view, shadow and GI programs have WORLD_SIZE's far layout compiled in (attach)
    if (win.size.some((n, i) => n !== WORLD_SIZE[i])) throw new Error(`far field: world ${win.size}, but the programs are built for ${WORLD_SIZE}`);
    const U8 = THREE.UnsignedByteType, HALF = THREE.HalfFloatType, NEAR = THREE.NearestFilter, LIN = THREE.LinearFilter;
    this.grid = makeFieldTarget(L.bricks.width, L.bricks.height, 1, U8, NEAR);   // raw shares, ids, glow
    this.field = makeFieldTarget(L.bricks.width, L.bricks.height, 1, U8, LIN);   // what the view draws (farBoostFrag)
    this.l1 = makeFieldTarget(L.l1.width, L.l1.height, 1, U8, NEAR);
    this.l2 = makeFieldTarget(L.l2.width, L.l2.height, 1, U8, NEAR);
    this.top = makeFieldTarget(L.bricks.n[0], L.bricks.n[2], 1, HALF, LIN);
    this.shadow = makeFieldTarget(L.bricks.n[0], L.bricks.n[2], 1, HALF, LIN);
    this.sun = sun;
    this.built = false;
    this.dirty = false;          // the far grid changed since the levels, tops and shadows were built
    this.shadowKey = '';         // the sun and window the shadow heights were built for
    this.age = 0;                // frames since the last sweep over the window's region began
    this.version = -1;           // the simulation's version then
    this.sweep = -1;             // the next slab of the sweep under way (-1: none)
    this.last = null;            // what the last build or refresh cost (tools)
    this.scene = win.scene;
    this.queue = [];             // a scene's far build: the chunks still to draw (world brick column [x, z] of each), nearest last
    this.chunksDrawn = 0;        // ...and how many it has drawn (the app redraws the view as it grows)

    // region draws into the far grid (farRegionVert): their own scene
    const region = (frag, uniforms) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: farRegionVert(L), fragmentShader: frag,
      uniforms: { ...uniforms, uFarLo: { value: new THREE.Vector3() }, uFarSize: { value: new THREE.Vector3() } },
      depthTest: false, depthWrite: false,
    });
    this.regionMesh = new THREE.Mesh(sliceQuads(L.bricks.n[1]));
    this.regionMesh.frustumCulled = false;
    this.regionScene = new THREE.Scene();
    this.regionScene.add(this.regionMesh);
    this.regionCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // the build: the island's from its columns, layers and trees; any other scene's from its sceneCell
    const build = this.scene.island ? {
      farColumn: rawMat(columnFrag(g), { ...genUniforms(), uColOrigin: { value: new THREE.Vector2(-COLUMN_MARGIN, -COLUMN_MARGIN) } }),
      farLayers: rawMat(farLayersFrag(g), { ...genUniforms(), tCol: { value: null } }),
      farTreeCand: rawMat(farTreeCandFrag(g, L), { ...genUniforms(), tCol: { value: null } }),
      farTreeThin: rawMat(farTreeThinFrag(g, L), { ...genUniforms(), tCand: { value: null } }),
      farTreeBand: rawMat(farTreeBandFrag(g, L), { tTrees: { value: null } }),
      farGen: region(farGenFrag(g, L), {
        ...genUniforms(), tLayers: { value: null }, tTrees: { value: null }, tTreeBand: { value: null },
      }),
    } : this.sceneMats(region);
    this.mats = {
      ...build,
      farWin: region(farWinFrag(g, L), { tA: { value: null }, uOrigin: this.sim.originUniform }),
      farBoost: region(farBoostFrag(L), { tFar: { value: this.grid.texture } }),
      farMip1: rawMat(farMip1Frag(L), { tFar: { value: this.field.texture } }),
      farMip2: rawMat(farMip2Frag(L), { tFar1: { value: this.l1.texture } }),
      farTop: rawMat(farTopFrag(L), { tFar: { value: this.field.texture } }),
      farShadow: rawMat(farShadowFrag(L), {
        tTop: { value: this.top.texture }, uSun: { value: new THREE.Vector3() }, uWinCols: { value: new THREE.Vector4() },
      }),
    };
    for (const [k, m] of Object.entries(this.mats)) m.name = k;   // the profiler's labels

    // the view
    this.worldToScene = new THREE.Matrix4();
    this.sceneToWorld = new THREE.Matrix4();
    const P = win.P;
    this.mesh = new THREE.Mesh(screenTriangle(), new THREE.ShaderMaterial({
      name: 'far',
      vertexShader: farVert,
      fragmentShader: farFrag(g, L),
      uniforms: {
        ...gfxUniforms,
        tFar: { value: this.grid.texture }, tFarField: { value: this.field.texture },
        tFar1: { value: this.l1.texture }, tFar2: { value: this.l2.texture }, tFarShadow: { value: this.shadow.texture },
        uWorldToScene: { value: this.worldToScene }, uSceneToWorld: { value: this.sceneToWorld },
        uWinLo: { value: new THREE.Vector3() },
        uSea: { value: P.sea }, uFloor: { value: P.floor },
        uOrigin: { value: new THREE.Vector3() },   // world cells throughout: the look's worldPos() is the identity
        uSun: { value: sun }, uTime: time,
      },
      // drawn first and everywhere: its depth always goes in (with the test off, GL writes none)
      depthTest: true,
      depthFunc: THREE.AlwaysDepth,
      depthWrite: true,
      blending: THREE.NoBlending,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = VIEW_ORDER;
    this.mesh.visible = false;
    // the view's program is as big as the volume's: compiled in the background
    // (parallel compile), the far field showing once it's ready, instead of
    // stalling the first frame
    this.ready = false;
    this.compile();
  }

  // A scene's build passes, its window mask (one byte per world brick column)
  // and its cells' target, made at build (sceneBuild).
  sceneMats(region) {
    const g = this.sim.g, L = this.L, [bx, , bz] = L.bricks.n;
    this.winMask = new Uint8Array(bx * bz);
    this.winMaskTex = new THREE.DataTexture(this.winMask, bx, bz, THREE.RedFormat, THREE.UnsignedByteType);
    this.winMaskTex.minFilter = this.winMaskTex.magFilter = THREE.NearestFilter;
    this.winMaskTex.unpackAlignment = 1;
    this.winMaskTex.needsUpdate = true;
    this.cells = null;
    const chunkLo = { value: new THREE.Vector2() };   // (both passes': the chunk being drawn)
    return {
      farSceneCells: rawMat(farSceneCellsFrag(g, L, this.scene.glsl(g)), { ...this.win.sceneU, uChunkLo: chunkLo }),
      farScene: region(farSceneFrag(g, L), { tCells: { value: null }, tWinMask: { value: this.winMaskTex }, uChunkLo: chunkLo }),
    };
  }

  compile() {
    // post.js's scene target formats, so the program compiled is the one the view uses
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    const done = this.renderer.compileAsync(this.mesh, new THREE.PerspectiveCamera(), new THREE.Scene());
    this.renderer.setRenderTarget(prev);
    // (showing it changes the scene's key: a settled view draws again, app.js gfx/pacing.js)
    done.then(() => { this.ready = true; this.mesh.visible = this.built; },
      (err) => console.error('far field: the view failed to compile', err))
      .finally(() => { target.depthTexture.dispose(); target.dispose(); });
  }

  // Draw material mat into the far grid (or target) over world bricks [lo, lo + size) along x and z (every slice).
  drawRegion(mat, lo, size, target = this.grid) {
    mat.uniforms.uFarLo.value.set(lo[0], 0, lo[1]);
    mat.uniforms.uFarSize.value.set(size[0], this.L.bricks.n[1], size[1]);
    this.regionMesh.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.regionScene, this.regionCamera);
    this.sim.onPass?.(mat.name, target);
  }

  // The field over world bricks [lo, lo + size) and the brick around them (their neighbours changed).
  boost(lo, size) {
    const [bx, , bz] = this.L.bricks.n;
    const a = [Math.max(lo[0] - 1, 0), Math.max(lo[1] - 1, 0)];
    const b = [Math.min(lo[0] + size[0] + 1, bx), Math.min(lo[1] + size[1] + 1, bz)];
    this.drawRegion(this.mats.farBoost, a, [b[0] - a[0], b[1] - a[1]], this.field);
  }

  // The whole far grid from the generator, then the window's own region from
  // its state (world/window.js load: the window has just been generated).
  build() {
    if (!this.scene.island) { this.sceneBuild(); return; }
    const t0 = performance.now();
    const sim = this.sim, L = this.L, [wx, , wz] = L.size, P = this.win.P;
    const { farColumn, farLayers, farTreeBand, farGen } = this.mats;
    for (const m of [farColumn, farLayers, farGen]) setWorld(m.uniforms, P);
    // genColumn for every world column plus the margin genLayers reads, then genLayers per column
    const F32 = THREE.FloatType, NEAR = THREE.NearestFilter, [bx, , bz] = L.bricks.n;
    const columns = makeFieldTarget(wx + 2 * COLUMN_MARGIN, wz + 2 * COLUMN_MARGIN, 1, F32, NEAR);
    const layers = makeFieldTarget(wx, wz, 1, THREE.UnsignedByteType, NEAR);
    sim.run(farColumn, columns);
    farLayers.uniforms.tCol.value = columns.texture;
    sim.run(farLayers, layers);
    // the trees: candidates per brick column, thinned, and the band each column's bricks find them in
    const trees = this.placeTrees(columns);
    const band = makeFieldTarget(bx, bz, 1, F32, NEAR);
    farTreeBand.uniforms.tTrees.value = trees.texture;
    sim.run(farTreeBand, band);
    const u = farGen.uniforms;
    u.tLayers.value = layers.texture;
    u.tTrees.value = trees.texture;
    u.tTreeBand.value = band.texture;
    this.drawRegion(farGen, [0, 0], [bx, bz]);
    this.boost([0, 0], [bx, bz]);
    for (const t of [columns, layers, trees, band]) t.dispose();
    this.built = true;
    this.summarizeWindow();
    this.refresh(true);
    this.last = { buildMs: performance.now() - t0 };
  }

  // A scene's build: the far grid starts empty but for the window's region,
  // summarized from its state, and the chunks are queued nearest the window
  // last (tick draws them from the end).
  sceneBuild() {
    const t0 = performance.now();
    const L = this.L, [bx, , bz] = L.bricks.n, C = FAR_SCENE.CHUNK;
    const r = this.renderer, prev = r.getRenderTarget(), color = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of [this.grid, this.field]) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setClearColor(color, alpha);
    r.setRenderTarget(prev);
    this.winMask.fill(0);
    this.winMaskTex.needsUpdate = true;
    this.built = true;
    this.summarizeWindow();
    const o = this.sim.origin, g = this.sim.g;
    const mid = [(o.x + g.nx / 2) / BRICK, (o.z + g.nz / 2) / BRICK];   // the window's centre, brick columns
    const dist = ([x, z]) => Math.hypot(x + C / 2 - mid[0], z + C / 2 - mid[1]);
    this.queue = [];
    for (let z = 0; z < bz; z += C) for (let x = 0; x < bx; x += C) this.queue.push([x, z]);
    this.queue.sort((a, b) => dist(b) - dist(a));
    this.chunksDrawn = 0;
    this.buildFrames = 0;
    this.buildStart = t0;
    if (!this.cells) {
      const S = farSceneLayout(L);
      this.cells = makeFieldTarget(S.width, S.height, 1, THREE.HalfFloatType, THREE.NearestFilter);
      this.mats.farScene.uniforms.tCells.value = this.cells.texture;
    }
    this.refresh(true);
    this.last = { buildMs: null, chunks: this.queue.length };
  }

  // Draw the next chunks of a scene's build (tick, every frame while there are any).
  sceneChunks() {
    const sim = this.sim, L = this.L, [bx, , bz] = L.bricks.n, C = FAR_SCENE.CHUNK;
    const lo = (FAR.CUBE - BRICK) / 2;   // the cells a brick's cube reaches past it (FAR_CUBE_LO)
    const { farSceneCells, farScene } = this.mats;
    for (let k = 0; k < SCENE_CHUNKS_PER_FRAME && this.queue.length; k++) {
      const [x, z] = this.queue.pop(), size = [Math.min(C, bx - x), Math.min(C, bz - z)];
      farSceneCells.uniforms.uChunkLo.value.set(x * BRICK - lo, z * BRICK - lo);
      sim.run(farSceneCells, this.cells);
      this.drawRegion(farScene, [x, z], size);
      this.boost([x, z], size);
      this.chunksDrawn++;
    }
    this.buildFrames++;
    if (!this.queue.length) {
      this.cells.dispose();
      this.cells = null;
      this.mats.farScene.uniforms.tCells.value = null;
      this.dirty = true;
      this.last = { ...this.last, buildMs: performance.now() - this.buildStart, frames: this.buildFrames };
    } else if (this.buildFrames % SCENE_REFRESH_FRAMES === 0) this.dirty = true;
  }

  // The world's trees, as treesIn places them: a target with one texel per
  // brick column (shaders/far.js treeOf), from the world's columns (genColumn
  // plus the margin; the caller disposes of the target). Without columns, it
  // makes them (tools: tools/far-check.mjs compares it with treesIn).
  placeTrees(columns = null) {
    const sim = this.sim, L = this.L, [wx, , wz] = L.size, [bx, , bz] = L.bricks.n, P = this.win.P;
    const F32 = THREE.FloatType, NEAR = THREE.NearestFilter;
    const { farColumn, farTreeCand, farTreeThin } = this.mats;
    for (const m of [farColumn, farTreeCand, farTreeThin]) setWorld(m.uniforms, P);
    const own = !columns;
    if (own) {
      columns = makeFieldTarget(wx + 2 * COLUMN_MARGIN, wz + 2 * COLUMN_MARGIN, 1, F32, NEAR);
      sim.run(farColumn, columns);
    }
    const cand = makeFieldTarget(bx, bz, 1, F32, NEAR), trees = makeFieldTarget(bx, bz, 1, F32, NEAR);
    farTreeCand.uniforms.tCol.value = columns.texture;
    sim.run(farTreeCand, cand);
    farTreeThin.uniforms.tCand.value = cand.texture;
    sim.run(farTreeThin, trees);
    cand.dispose();
    if (own) columns.dispose();
    return trees;
  }

  // Summarize the window's bricks [lo, lo + bricks) (grid cells lo, brick
  // aligned; bricks along x, y, z) into the far grid, at the window's origin:
  // the slab about to leave on a move (before the shift), a slab of a sweep,
  // or all of it. derive: rebuild what derives from the grid before the next view.
  summarize(lo, bricks, derive = true) {
    if (!this.built) return;
    const o = this.sim.origin, m = this.mats.farWin;
    const at = [(o.x + lo[0]) / BRICK, (o.z + lo[2]) / BRICK], size = [bricks[0], bricks[2]];
    m.uniforms.tA.value = this.sim.stateA;
    this.drawRegion(m, at, size);
    this.boost(at, size);
    if (derive) this.dirty = true;
    if (this.winMask) {
      for (let z = at[1]; z < at[1] + size[1]; z++) this.winMask.fill(MASK_SET, z * this.L.bricks.n[0] + at[0], z * this.L.bricks.n[0] + at[0] + size[0]);
      this.winMaskTex.needsUpdate = true;
    }
  }

  summarizeWindow() {
    const g = this.sim.g;
    this.summarize([0, 0, 0], [g.nx / BRICK, g.ny / BRICK, g.nz / BRICK]);
    this.sweep = -1;
    this.age = 0;
    this.version = this.sim.version;
  }

  // Every frame (world/window.js update): sweep over the window's region,
  // a slab a frame, while the simulation changes it.
  tick() {
    if (!this.built) return;
    if (this.queue.length) this.sceneChunks();
    const g = this.sim.g;
    this.age++;
    if (this.sweep < 0) {
      if (this.sim.version === this.version || this.age < SWEEP_FRAMES) return;
      this.sweep = 0;
      this.age = 0;
      this.version = this.sim.version;
    }
    const x = this.sweep * SWEEP_CELLS, last = x + SWEEP_CELLS >= g.nx;
    this.summarize([x, 0, 0], [SWEEP_CELLS / BRICK, g.ny / BRICK, g.nz / BRICK], last);
    this.sweep = last ? -1 : this.sweep + 1;
  }

  // Rebuild what derives from the far grid (after it changed) and the shadow
  // heights (after that, a sun move or a window move). force: all of it.
  refresh(force = false) {
    if (!this.built) return;
    const sim = this.sim, o = sim.origin, g = sim.g, s = this.sun;
    const t0 = performance.now();
    let what = 0;
    if (this.dirty || force) {
      sim.run(this.mats.farMip1, this.l1);
      sim.run(this.mats.farMip2, this.l2);
      sim.run(this.mats.farTop, this.top);
      this.dirty = false;
      this.shadowKey = '';
      what++;
    }
    const key = `${s.x},${s.y},${s.z}|${o.x},${o.z}`;
    if (key !== this.shadowKey) {
      const u = this.mats.farShadow.uniforms;
      u.uSun.value.copy(s);
      u.uWinCols.value.set(o.x / BRICK, o.z / BRICK, (o.x + g.nx) / BRICK, (o.z + g.nz) / BRICK);
      sim.run(this.mats.farShadow, this.shadow);
      this.shadowKey = key;
      what++;
    }
    if (what) this.last = { ...this.last, refreshMs: performance.now() - t0 };
  }

  // The window's volume and sun shadow map (the app's materials) and its GI
  // (the simulation's) take the far field: the volume its aerial perspective
  // (render.js volumeFrag's haze), the shadow map the shade from outside the
  // window, by the shadow heights of the columns outside it (shadowFrag's
  // casters), the GI's rays the far field past their end (gi.js giGatherFrag's
  // far). Their programs already hold these parts, off (shaders/far.js
  // WORLD_SIZE): this only turns them on, so nothing compiles.
  attach(volumeMat, shadowMat) {
    volumeMat.uniforms.uFar.value = true;
    shadowMat.uniforms.uFar.value = true;
    shadowMat.uniforms.tFarShadow.value = this.shadow.texture;
    const gi = this.sim.mats.giGather.uniforms;
    gi.uFar.value = true;
    gi.tFar.value = this.grid.texture;
    gi.tFarTop.value = this.top.texture;
    gi.tFarShadow.value = this.shadow.texture;
    gi.uSea.value = this.win.P.sea;
    gfxUniforms.uClouds.value = true;   // the cumulus deck overhead, and its shadows (shaders/gfx/clouds.js)
    gfxUniforms.uCloudSea.value = this.win.P.sea;
  }

  // Before the scene renders: the view's transforms for this frame (the
  // volume's matrix maps grid cells into the scene; world = grid + origin).
  // visible: the realistic view (the data views draw the window alone).
  view(volume, visible) {
    this.mesh.visible = visible && this.built && this.ready;
    if (!this.mesh.visible) return;
    const o = this.sim.origin;
    this.worldToScene.copy(volume.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
    this.sceneToWorld.copy(this.worldToScene).invert();
    this.mesh.material.uniforms.uWinLo.value.copy(o);
    this.refresh();
  }

  // retire: as Simulation.dispose's (the view's program and the passes' carry
  // over to a new far field that claims them before they're disposed of)
  dispose(retire = null) {
    this.queue = [];
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.regionMesh.geometry.dispose();
    for (const t of [this.grid, this.field, this.l1, this.l2, this.top, this.shadow]) t.dispose();
    this.cells?.dispose();
    this.winMaskTex?.dispose();
    const mats = [this.mesh.material, ...Object.values(this.mats)];
    if (retire) retire.push(...mats);
    else mats.forEach((m) => m.dispose());
  }
}

import * as THREE from 'three';
import { BRICK } from '../shaders/common.js';
import { columnFrag, COLUMN_MARGIN } from '../shaders/generate.js';
import {
  farLayout, farRegionVert, farLayersFrag, farGenFrag, farWinFrag, farMip1Frag, farMip2Frag,
  farTopFrag, farShadowFrag, farVert, farFrag,
} from '../shaders/far.js';
import { rawMat, makeFieldTarget } from '../sim.js';
import { genUniforms, setWorld } from './gpu.js';
import { gfxUniforms } from '../gfx/uniforms.js';

// The far field of a massive world (docs/scaling.md D11, phase W4; the GLSL
// and the far grid's layout are in shaders/far.js): a brick-resolution grid of
// the whole world, drawn wherever the window isn't.
//
// Built at world load from the generator, at world scale: genColumn for every
// world column, genLayers for every column, then every brick from its 16
// columns' layers. The trees aren't in it until the window has planted them.
//
// Kept up to date from the window, whose state wins wherever it has been:
//   - a move summarizes the slab about to leave (world/window.js, before the
//     shift), so what was built, burnt or dug there stays in the far view;
//   - after a move, and every REFRESH_FRAMES frames while the simulation
//     changes, the whole window is summarized too: the far grid's copy of it
//     casts the far field's shadows (and the field next to the window's sides
//     blends into it);
//   - after any of these the occupancy levels, the brick-column tops and the
//     shadow heights are rebuilt (refresh), and the shadow heights again when
//     the sun moves.
//
// The view is one full-screen pass drawn before everything else in the scene
// (FarField.mesh): sky, the open sea beyond the world and the far grid, with
// depth, so the window's volume and the scene's objects composite over it.
// It marches the far grid past the window's box, which the volume draws.

const REFRESH_FRAMES = 30;       // frames between summaries of the window's own region while the sim changes it
const VIEW_ORDER = -10;          // renderOrder of the view: first of the scene's opaque objects

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
    const U8 = THREE.UnsignedByteType, HALF = THREE.HalfFloatType, NEAR = THREE.NearestFilter, LIN = THREE.LinearFilter;
    this.grid = makeFieldTarget(L.bricks.width, L.bricks.height, 1, U8, LIN);
    this.l1 = makeFieldTarget(L.l1.width, L.l1.height, 1, U8, NEAR);
    this.l2 = makeFieldTarget(L.l2.width, L.l2.height, 1, U8, NEAR);
    this.top = makeFieldTarget(L.bricks.n[0], L.bricks.n[2], 1, HALF, LIN);
    this.shadow = makeFieldTarget(L.bricks.n[0], L.bricks.n[2], 1, HALF, LIN);
    this.sun = sun;
    this.built = false;
    this.dirty = false;          // the far grid changed since the levels, tops and shadows were built
    this.shadowKey = '';         // the sun and window the shadow heights were built for
    this.age = 0;                // frames since the window's region was last summarized
    this.version = -1;           // the simulation's version then
    this.last = null;            // what the last build or refresh cost (tools)

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
    this.mats = {
      farColumn: rawMat(columnFrag(g), { ...genUniforms(), uColOrigin: { value: new THREE.Vector2(-COLUMN_MARGIN, -COLUMN_MARGIN) } }),
      farLayers: rawMat(farLayersFrag(g), { ...genUniforms(), tCol: { value: null } }),
      farGen: region(farGenFrag(g, L), { ...genUniforms(), tLayers: { value: null } }),
      farWin: region(farWinFrag(g, L), { tA: { value: null }, uOrigin: this.sim.originUniform }),
      farMip1: rawMat(farMip1Frag(L), { tFar: { value: this.grid.texture } }),
      farMip2: rawMat(farMip2Frag(L), { tFar1: { value: this.l1.texture } }),
      farTop: rawMat(farTopFrag(L), { tFar: { value: this.grid.texture } }),
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
        tFar: { value: this.grid.texture }, tFar1: { value: this.l1.texture }, tFar2: { value: this.l2.texture },
        tFarShadow: { value: this.shadow.texture },
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
  }

  // Draw material mat into the far grid over world bricks [lo, lo + size) along x and z (every slice).
  drawRegion(mat, lo, size) {
    mat.uniforms.uFarLo.value.set(lo[0], 0, lo[1]);
    mat.uniforms.uFarSize.value.set(size[0], this.L.bricks.n[1], size[1]);
    this.regionMesh.material = mat;
    this.renderer.setRenderTarget(this.grid);
    this.renderer.render(this.regionScene, this.regionCamera);
    this.sim.onPass?.(mat.name, this.grid);
  }

  // The whole far grid from the generator, then the window's own region from
  // its state (world/window.js load: the window has just been generated).
  build() {
    const t0 = performance.now();
    const sim = this.sim, L = this.L, [wx, , wz] = L.size, P = this.win.P;
    const { farColumn, farLayers, farGen } = this.mats;
    for (const m of [farColumn, farLayers, farGen]) setWorld(m.uniforms, P);
    // genColumn for every world column plus the margin genLayers reads, then genLayers per column
    const columns = makeFieldTarget(wx + 2 * COLUMN_MARGIN, wz + 2 * COLUMN_MARGIN, 1, THREE.FloatType, THREE.NearestFilter);
    const layers = makeFieldTarget(wx, wz, 1, THREE.UnsignedByteType, THREE.NearestFilter);
    sim.run(farColumn, columns);
    farLayers.uniforms.tCol.value = columns.texture;
    sim.run(farLayers, layers);
    farGen.uniforms.tLayers.value = layers.texture;
    this.drawRegion(farGen, [0, 0], [L.bricks.n[0], L.bricks.n[2]]);
    columns.dispose();
    layers.dispose();
    this.built = true;
    this.summarizeWindow();
    this.refresh(true);
    this.last = { buildMs: performance.now() - t0 };
  }

  // Summarize the window's bricks [lo, lo + bricks) (grid cells lo, brick
  // aligned; bricks along x, y, z) into the far grid, at the window's origin:
  // the slab about to leave on a move (before the shift), or all of it.
  summarize(lo, bricks) {
    if (!this.built) return;
    const o = this.sim.origin, m = this.mats.farWin;
    m.uniforms.tA.value = this.sim.stateA;
    this.drawRegion(m, [(o.x + lo[0]) / BRICK, (o.z + lo[2]) / BRICK], [bricks[0], bricks[2]]);
    this.dirty = true;
  }

  summarizeWindow() {
    const g = this.sim.g;
    this.summarize([0, 0, 0], [g.nx / BRICK, g.ny / BRICK, g.nz / BRICK]);
    this.age = 0;
    this.version = this.sim.version;
  }

  // Every frame (world/window.js update): summarize the window's region now
  // and then while the simulation changes it.
  tick() {
    if (!this.built || this.sim.version === this.version || ++this.age < REFRESH_FRAMES) return;
    this.summarizeWindow();
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

  // Before the scene renders: the view's transforms for this frame (the
  // volume's matrix maps grid cells into the scene; world = grid + origin).
  // visible: the realistic view (the data views draw the window alone).
  view(volume, visible) {
    this.mesh.visible = visible && this.built;
    if (!this.mesh.visible) return;
    const o = this.sim.origin;
    this.worldToScene.copy(volume.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
    this.sceneToWorld.copy(this.worldToScene).invert();
    this.mesh.material.uniforms.uWinLo.value.copy(o);
    this.refresh();
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.regionMesh.geometry.dispose();
    for (const t of [this.grid, this.l1, this.l2, this.top, this.shadow]) t.dispose();
    Object.values(this.mats).forEach((m) => m.dispose());
  }
}

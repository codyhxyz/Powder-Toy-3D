import * as THREE from 'three';
import { rawMat, makeFieldTarget } from '../sim.js';
import { columnFrag, fillFrag, summaryFrag, COLUMN_MARGIN } from '../shaders/generate.js';
import { stampFrag } from '../shaders/stamp.js';
import { runGenerator, bake, MAX_FOOT } from '../constructions/runtime.js';
import { BUILTINS } from '../constructions/builtins.js';
import { worldParams, treesIn, TREE } from './generator.js';

// The world generator on the GPU (shaders/generate.js), for one simulation
// grid: a window of the world (world/generator.js) at a world-cell origin.
// Today's grid sizes are a world the size of the grid at origin 0 (the Island
// scene, loadIsland below); the massive world's window (docs/scaling.md D11)
// fills the slabs a shift uncovers with fill(..., min, max) and builds its far
// field from summarize().

// The generator's uniforms (shaders/generate.js), set from a world's parameters.
const genUniforms = () => ({
  uGenSeed: { value: 0 }, uGenSea: { value: 0 }, uGenRelief: { value: 0 }, uGenFloor: { value: 0 },
  uGenCenter: { value: new THREE.Vector2() }, uGenRadius: { value: 1 },
  uGenAxis: { value: new THREE.Vector2(1, 0) }, uGenStretch: { value: 1 }, uGenFeature: { value: 1 },
});
function setWorld(u, P) {
  u.uGenSeed.value = P.seed;
  u.uGenSea.value = P.sea;
  u.uGenRelief.value = P.relief;
  u.uGenFloor.value = P.floor;
  u.uGenCenter.value.set(...P.center);
  u.uGenRadius.value = P.radius;
  u.uGenAxis.value.set(...P.axis);
  u.uGenStretch.value = P.stretch;
  u.uGenFeature.value = P.feature;
}

export class WorldGenerator {
  constructor(sim) {
    this.sim = sim;
    const g = sim.g;
    const F32 = THREE.FloatType, U8 = THREE.UnsignedByteType, NEAR = THREE.NearestFilter;
    // genColumn for the grid's columns plus a margin (columnFrag)
    this.columns = makeFieldTarget(g.nx + 2 * COLUMN_MARGIN, g.nz + 2 * COLUMN_MARGIN, 1, F32, NEAR);
    this.columnsKey = '';
    // the grid's far-field brick summary (summaryFrag)
    this.summary = makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR);
    const v3 = () => ({ value: new THREE.Vector3() });
    this.mats = {
      column: rawMat(columnFrag(g), { ...genUniforms(), uColOrigin: { value: new THREE.Vector2() } }),
      fill: rawMat(fillFrag(g), {
        ...genUniforms(), tA: { value: null }, tB: { value: null }, tCol: { value: null },
        uOrigin: v3(), uFillMin: v3(), uFillMax: v3(),
      }),
      summary: rawMat(summaryFrag(g), { ...genUniforms(), tCol: { value: null }, uOrigin: v3() }),
      // constructions.js places its stamps with the same pass
      stamp: rawMat(stampFrag(g), {
        tA: { value: null }, tB: { value: null }, tStamp: { value: null },
        uOrigin: v3(), uSize: v3(), uFoot: { value: 0 }, uSeed: { value: 0 },
      }),
    };
  }

  // Evaluate genColumn for the grid at world origin [x, y, z] (kept until the world or origin changes).
  updateColumns(P, origin) {
    const key = JSON.stringify([P, origin]);
    if (key === this.columnsKey) return;
    const { column, fill, summary } = this.mats;
    for (const m of [column, fill, summary]) setWorld(m.uniforms, P);
    column.uniforms.uColOrigin.value.set(origin[0] - COLUMN_MARGIN, origin[2] - COLUMN_MARGIN);
    this.sim.run(column, this.columns);
    this.columnsKey = key;
  }

  // Generate world P into the grid's cells [min, max) (window-local; the whole
  // grid by default), the grid sitting at world cell `origin`.
  fill(P, origin = [0, 0, 0], min = [0, 0, 0], max = null) {
    const g = this.sim.g;
    this.updateColumns(P, origin);
    const u = this.mats.fill.uniforms;
    u.tCol.value = this.columns.texture;
    u.uOrigin.value.set(...origin);
    u.uFillMin.value.set(...min);
    u.uFillMax.value.set(...(max ?? [g.nx, g.ny, g.nz]));
    this.sim.pass(this.mats.fill);
    // a new scene: the render fields and GI start over instead of blending in
    this.sim.fieldReset = true;
    this.sim.giReset = true;
  }

  // The far-field summary of world P over the grid's bricks: one RGBA8 texel
  // per brick (shaders/generate.js summaryFrag). Returns the target.
  summarize(P, origin = [0, 0, 0]) {
    this.updateColumns(P, origin);
    const u = this.mats.summary.uniforms;
    u.tCol.value = this.columns.texture;
    u.uOrigin.value.set(...origin);
    this.sim.run(this.mats.summary, this.summary);
    return this.summary;
  }

  // Stamp the trees of world P whose crowns may reach the grid. Returns them.
  plantTrees(P, origin = [0, 0, 0]) {
    const g = this.sim.g, R = TREE.REACH;
    const trees = treesIn(origin[0] - R, origin[2] - R, origin[0] + g.nx + R, origin[2] + g.nz + R, P);
    for (const t of trees) {
      const cells = runGenerator(BUILTINS.TREE, { size: t.size, seed: t.seed, variant: t.variant });
      const s = bake(cells, t.quarter);
      if (!s) continue;
      // the construction's base point on the ground at the trunk (the stamp pass grows its footing)
      this.stamp(s, [t.x - origin[0] - s.base.x, t.y - origin[1] - s.base.y, t.z - origin[2] - s.base.z], t.seed);
    }
    return trees;
  }

  // Write a baked construction (runtime.js bake) into the grid at window cell `at`.
  stamp(s, at, seed) {
    const tex = new THREE.Data3DTexture(s.data, s.w, s.h, s.d);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.FloatType;
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    const u = this.mats.stamp.uniforms;
    u.tStamp.value = tex;
    u.uOrigin.value.set(...at);
    u.uSize.value.set(s.w, s.h, s.d);
    u.uFoot.value = Math.min(s.foot, MAX_FOOT);
    u.uSeed.value = seed;
    this.sim.pass(this.mats.stamp);
    tex.dispose();
  }

  dispose() {
    this.columns.dispose();
    this.summary.dispose();
    Object.values(this.mats).forEach((m) => m.dispose());
  }
}

// One generator, for the app's current simulation (a new grid replaces it).
let current = null;
export function generatorFor(sim) {
  if (current?.sim !== sim) {
    current?.dispose();
    current = new WorldGenerator(sim);
  }
  return current;
}

// The Island scene: a world the size of the grid, at origin 0, with its trees.
export function loadIsland(sim, { seed } = {}) {
  const { nx, ny, nz } = sim.g;
  const P = worldParams({ size: [nx, ny, nz], seed });
  const gen = generatorFor(sim);
  gen.fill(P);
  gen.plantTrees(P);
  return P;
}

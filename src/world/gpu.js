import * as THREE from 'three';
import { rawMat, makeFieldTarget } from '../sim.js';
import { columnFrag, fillFrag, diffFrag, COLUMN_MARGIN } from '../shaders/generate.js';
import { stampFrag, stampManyFrag, MAX_STAMPS } from '../shaders/stamp.js';
import { runGenerator, bake, MAX_FOOT } from '../constructions/runtime.js';
import { BUILTINS } from '../constructions/builtins.js';
import { worldParams, treesIn, TREE } from './generator.js';

// The world generator on the GPU (shaders/generate.js), for one simulation
// grid: a window of the world (world/generator.js) at a world-cell origin.
// Today's grid sizes are a world the size of the grid at origin 0 (the Island
// scene, loadIsland below); the massive world's window (docs/scaling.md D11)
// fills the slabs a shift uncovers with fill(..., min, max). Its far field
// (world/far.js) runs the column pass over the whole world.

// The generator's uniforms (shaders/generate.js), set from a world's parameters.
export const genUniforms = () => ({
  uGenSeed: { value: 0 }, uGenSea: { value: 0 }, uGenRelief: { value: 0 }, uGenFloor: { value: 0 },
  uGenCenter: { value: new THREE.Vector2() }, uGenRadius: { value: 1 },
  uGenAxis: { value: new THREE.Vector2(1, 0) }, uGenStretch: { value: 1 }, uGenFeature: { value: 1 },
});
export function setWorld(u, P) {
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
    const F32 = THREE.FloatType, NEAR = THREE.NearestFilter;
    // genColumn for the grid's columns plus a margin (columnFrag)
    this.columns = makeFieldTarget(g.nx + 2 * COLUMN_MARGIN, g.nz + 2 * COLUMN_MARGIN, 1, F32, NEAR);
    this.columnsKey = '';
    const v3 = () => ({ value: new THREE.Vector3() });
    this.mats = {
      column: rawMat(columnFrag(g), { ...genUniforms(), uColOrigin: { value: new THREE.Vector2() } }),
      fill: rawMat(fillFrag(g), {
        ...genUniforms(), tA: { value: null }, tB: { value: null }, tCol: { value: null },
        uOrigin: v3(), uFillMin: v3(), uFillMax: v3(),
      }),
      // constructions.js places its stamps with the same pass
      stamp: rawMat(stampFrag(g), {
        tA: { value: null }, tB: { value: null }, tStamp: { value: null },
        uAt: v3(), uSize: v3(), uFoot: { value: 0 }, uSeed: { value: 0 },
      }),
    };
    for (const [k, m] of Object.entries(this.mats)) m.name = k;   // the profiler's labels
    // the world window's passes (docs/scaling.md D11) are made on first use
    this.v3 = v3;
  }

  // Which bricks of the slab of grid cells [lo, lo + 4·bricks) differ from
  // world P (shaders/generate.js diffFrag), the grid sitting at the
  // simulation's origin: written to target, one texel per brick.
  diff(P, lo, bricks, target) {
    const o = this.sim.origin;
    this.updateColumns(P, [o.x, o.y, o.z]);
    this.mats.diff ??= Object.assign(rawMat(diffFrag(this.sim.g), {
      ...genUniforms(), tA: { value: null }, tB: { value: null }, tCol: { value: null },
      uLo: this.v3(), uBricks: this.v3(),
    }), { name: 'diff' });
    setWorld(this.mats.diff.uniforms, P);
    const u = this.mats.diff.uniforms;
    u.tA.value = this.sim.stateA;
    u.tB.value = this.sim.stateB;
    u.tCol.value = this.columns.texture;
    u.uLo.value.set(...lo);
    u.uBricks.value.set(...bricks);
    this.sim.run(this.mats.diff, target);
  }

  // Stamp baked constructions (runtime.js bake) in as few passes as there are
  // MAX_STAMPS of them (shaders/stamp.js stampManyFrag), each { s, at, seed }
  // with at its low corner in grid cells, writing only the grid brick columns
  // set in colMask (a texture, one texel per brick column x, z).
  stampMany(list, colMask) {
    const g = this.sim.g;
    this.mats.stampMany ??= Object.assign(rawMat(stampManyFrag(g), {
      tA: { value: null }, tB: { value: null }, tStamps: { value: null }, tColMask: { value: null },
      uStampCount: { value: 0 },
      uStampAt: { value: new Int32Array(3 * MAX_STAMPS) }, uStampBox: { value: new Int32Array(4 * MAX_STAMPS) },
      uStampFoot: { value: new Int32Array(MAX_STAMPS) }, uStampSeed: { value: new Uint32Array(MAX_STAMPS) },
    }), { name: 'stampMany' });
    const u = this.mats.stampMany.uniforms;
    u.tColMask.value = colMask;
    for (let k = 0; k < list.length; k += MAX_STAMPS) {
      const batch = list.slice(k, k + MAX_STAMPS);
      // the batch's stamps side by side along x in one 3D texture
      const W = batch.reduce((n, b) => n + b.s.w, 0);
      const H = Math.max(...batch.map((b) => b.s.h)), D = Math.max(...batch.map((b) => b.s.d));
      const data = new Float32Array(W * H * D * 4);
      let x0 = 0;
      batch.forEach(({ s, at, seed }, i) => {
        for (let z = 0; z < s.d; z++)
          for (let y = 0; y < s.h; y++) {
            const src = ((z * s.h + y) * s.w) * 4;
            data.set(s.data.subarray(src, src + s.w * 4), ((z * H + y) * W + x0) * 4);
          }
        u.uStampAt.value.set(at, 3 * i);
        u.uStampBox.value.set([s.w, s.h, s.d, x0], 4 * i);
        u.uStampFoot.value[i] = Math.min(s.foot, MAX_FOOT);
        u.uStampSeed.value[i] = seed;
        x0 += s.w;
      });
      const tex = new THREE.Data3DTexture(data, W, H, D);
      tex.format = THREE.RGBAFormat;
      tex.type = THREE.FloatType;
      tex.minFilter = tex.magFilter = THREE.NearestFilter;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      u.tStamps.value = tex;
      u.uStampCount.value = batch.length;
      this.sim.pass(this.mats.stampMany);
      tex.dispose();
    }
  }

  // Evaluate genColumn for the grid at world origin [x, y, z] (kept until the world or origin changes).
  updateColumns(P, origin) {
    const key = JSON.stringify([P, origin]);
    if (key === this.columnsKey) return;
    const { column, fill } = this.mats;
    for (const m of [column, fill]) setWorld(m.uniforms, P);
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
    u.uAt.value.set(...at);
    u.uSize.value.set(s.w, s.h, s.d);
    u.uFoot.value = Math.min(s.foot, MAX_FOOT);
    u.uSeed.value = seed;
    this.sim.pass(this.mats.stamp);
    tex.dispose();
  }

  dispose() {
    this.columns.dispose();
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
  // a new scene: the render fields and GI start over instead of blending in, and nothing is moving
  sim.fieldReset = true;
  sim.giReset = true;
  sim.stillFlow();
  return P;
}

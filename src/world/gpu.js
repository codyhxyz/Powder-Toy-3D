import * as THREE from 'three';
import { rawMat } from '../sim.js';
import { stateUniforms } from '../shaders/common.js';
import { sceneFillFrag, sceneDiffFrag } from '../shaders/generate.js';
import { stampFrag, stampManyFrag, MAX_STAMPS } from '../shaders/stamp.js';
import { runGenerator, bake, MAX_FOOT } from '../constructions/runtime.js';
import { BUILTINS } from '../constructions/builtins.js';
import { worldParams, TREE } from './generator.js';
import { island, islandUniforms, setIslandUniforms, IslandColumns } from './scenes/island.js';

// A world scene's generator on the GPU (world/scenes), for one simulation
// grid: a window of the world at a world-cell origin. It fills cells and
// diffs slabs through the scene's sceneCell (shaders/generate.js
// sceneFillFrag, sceneDiffFrag) and stamps the scene's trees, if it has any
// (scene.trees: the island's). Today's grid sizes are a world the size of the
// grid at origin 0 (the box's Island preset, loadIsland below); the massive
// world's window (docs/scaling.md D11) fills the slabs a shift uncovers with
// fill(..., min, max).

export class WorldGenerator {
  // scene: a world scene's { glsl: its glsl(g), uniforms: its uniforms(P),
  // trees: its tree hook or none } (world/scenes)
  constructor(sim, scene) {
    this.sim = sim;
    this.scene = scene;
    const v3 = () => ({ value: new THREE.Vector3() });
    this.v3 = v3;
    // (the scene's uniform objects are shared with its other passes: world/window.js)
    this.mats = {
      fill: rawMat(sceneFillFrag(sim.g, scene.glsl), {
        ...scene.uniforms, ...stateUniforms(), uOrigin: v3(), uFillMin: v3(), uFillMax: v3(),
      }),
    };
    this.mats.fill.name = 'sceneFill';   // the profiler's label
    // the stamps and the world window's diff are made on first use
  }

  // The world window's diff pass (diff), made on first use.
  diffMat() {
    return this.mats.diff ??= Object.assign(rawMat(sceneDiffFrag(this.sim.g, this.scene.glsl), {
      ...this.scene.uniforms, tA: { value: null }, tB: { value: null }, uLo: this.v3(), uBricks: this.v3(),
    }), { name: 'sceneDiff' });
  }

  // The stamp pass (constructions.js places its stamps with the same pass), made on first use.
  stampMat() {
    return this.mats.stamp ??= Object.assign(rawMat(stampFrag(this.sim.g), {
      ...stateUniforms(), tStamp: { value: null },
      uAt: this.v3(), uSize: this.v3(), uFoot: { value: 0 }, uSeed: { value: 0 },
    }), { name: 'stamp' });
  }

  // Which bricks of the slab of grid cells [lo, lo + 4·bricks) differ from
  // world P (shaders/generate.js sceneDiffFrag), the grid sitting at the
  // simulation's origin: written to target, one texel per brick.
  diff(P, lo, bricks, target) {
    const u = this.diffMat().uniforms;
    u.tA.value = this.sim.stateA;
    u.tB.value = this.sim.stateB;
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
      ...stateUniforms(), tStamps: { value: null }, tColMask: { value: null },
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

  // Generate world P into the grid's cells [min, max) (window-local; the whole
  // grid by default), the grid sitting at world cell `origin`.
  fill(P, origin = [0, 0, 0], min = [0, 0, 0], max = null) {
    const g = this.sim.g;
    const u = this.mats.fill.uniforms;
    u.uOrigin.value.set(...origin);
    u.uFillMin.value.set(...min);
    u.uFillMax.value.set(...(max ?? [g.nx, g.ny, g.nz]));
    this.sim.pass(this.mats.fill);
  }

  // Stamp the trees of world P whose crowns may reach the grid. Returns them.
  plantTrees(P, origin = [0, 0, 0]) {
    const g = this.sim.g, R = TREE.REACH;
    if (!this.scene.trees) return [];
    const trees = this.scene.trees.treesIn(origin[0] - R, origin[2] - R, origin[0] + g.nx + R, origin[2] + g.nz + R, P);
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
    const u = this.stampMat().uniforms;
    u.tStamp.value = tex;
    u.uAt.value.set(...at);
    u.uSize.value.set(s.w, s.h, s.d);
    u.uFoot.value = Math.min(s.foot, MAX_FOOT);
    u.uSeed.value = seed;
    this.sim.pass(this.mats.stamp);
    tex.dispose();
  }

  // retire: as Simulation.dispose's
  dispose(retire = null) {
    if (retire) retire.push(...Object.values(this.mats));
    else Object.values(this.mats).forEach((m) => m.dispose());
  }
}

// The box's Island preset: the island scene (scenes/island.js) over a world
// the size of the grid, at origin 0, with snow and its own baked columns.
export class IslandGenerator extends WorldGenerator {
  constructor(sim) {
    const P = worldParams({ size: [sim.g.nx, sim.g.ny, sim.g.nz] });
    super(sim, { glsl: island.glsl(sim.g), uniforms: islandUniforms(P), trees: island.trees });
    this.columns = new IslandColumns(P);
  }

  // Bake world P's columns (synchronous: the program compiles on first use)
  // into the passes' uniforms; fill and plantTrees then generate it.
  prepare(P) {
    setIslandUniforms(this.scene.uniforms, P, this.columns.bake(this.sim.renderer, P));
  }

  dispose(retire = null) {
    super.dispose(retire);
    this.columns.dispose();
  }
}

// One generator, for the app's current simulation (a new grid replaces it).
let current = null;
export function generatorFor(sim) {
  if (current?.sim !== sim) {
    current?.dispose();
    current = new IslandGenerator(sim);
  }
  return current;
}
// The simulation is going away: so does its generator, if it has one
// (retire: as Simulation.dispose's).
export function releaseGenerator(sim, retire = null) {
  if (current?.sim !== sim) return;
  current.dispose(retire);
  current = null;
}

// The Island scene: a world the size of the grid, at origin 0, with its trees.
export function loadIsland(sim, { seed } = {}) {
  const { nx, ny, nz } = sim.g;
  const P = worldParams({ size: [nx, ny, nz], seed });
  const gen = generatorFor(sim);
  gen.prepare(P);
  gen.fill(P);
  gen.plantTrees(P);
  // a new scene: the render fields and GI start over instead of blending in, and nothing is moving
  sim.fieldReset = true;
  sim.giReset = true;
  sim.stillFlow();
  return P;
}

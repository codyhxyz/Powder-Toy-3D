import * as THREE from 'three';
import { gridLayout } from '../../sim.js';
import { WorldGenerator } from '../gpu.js';
import { PATCH_TILE, islandParams } from './patchworkBake.js';

// The patchwork scene's island tile (scenes/patchwork.js): the island box
// preset, made the way the Scene row makes it (world/gpu.js loadIsland: the
// generator's fill pass, then its trees stamped in) on a box-sized grid of its
// own, and read back. Its trees are CPU-built constructions stamped on the GPU
// and its frozen rock's temperatures are float32 GPU arithmetic, so running
// the same passes is the one exact route; a CPU port of the generator would
// round differently at band edges. The grid is a stand-in for the parts of
// Simulation the generator uses (g, run, pass, the state textures, origin),
// so no simulation's other targets are made, and it's freed when done.

// Attachment index of the activity flags in a state target (as sim.js's).
const STATE_FLAGS = 2;
// A state target: A and B (RGBA32F) and the activity flags (R8UI), as sim.js
// makeStateTarget makes them (the generator's passes write all three).
function stateTarget(g) {
  const t = new THREE.WebGLRenderTarget(g.width, g.height, {
    count: STATE_FLAGS + 1, type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
  t.textures[STATE_FLAGS].format = THREE.RedIntegerFormat;
  t.textures[STATE_FLAGS].type = THREE.UnsignedByteType;
  return t;
}

class BakeGrid {
  constructor(renderer, n) {
    this.renderer = renderer;
    this.g = gridLayout(n, n, n);
    this.targets = [stateTarget(this.g), stateTarget(this.g)];
    this.cur = 0;
    this.origin = new THREE.Vector3();   // a box: its own whole world, at 0
    this.originUniform = { value: this.origin };
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get stateA() { return this.targets[this.cur].textures[0]; }
  get stateB() { return this.targets[this.cur].textures[1]; }
  get stateF() { return this.targets[this.cur].textures[STATE_FLAGS]; }

  // as Simulation.run: a full-screen pass into target (the box's origin unless it brings its own)
  run(mat, target) {
    mat.uniforms.uOrigin ??= this.originUniform;
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  // as Simulation.pass: a ping-pong pass over the state
  pass(mat) {
    mat.uniforms.tA.value = this.stateA;
    mat.uniforms.tB.value = this.stateB;
    mat.uniforms.tF.value = this.stateF;
    this.run(mat, this.targets[1 - this.cur]);
    this.cur = 1 - this.cur;
  }

  // Compile mats without stalling (KHR_parallel_shader_compile where there
  // is one), for a render target like the ones they draw into.
  async compile(mats) {
    const scene = new THREE.Scene();
    for (const m of mats) {
      const mesh = new THREE.Mesh(this.quad.geometry, m);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    const before = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.targets[0]);
    const done = this.renderer.compileAsync(scene, this.camera);
    this.renderer.setRenderTarget(before);
    await done;
  }

  dispose() {
    for (const t of this.targets) t.dispose();
    this.quad.geometry.dispose();
  }
}

// The island box preset for world seed `seed`: { g, A }, its state A (the
// fetchA layout, RGBA floats per atlas texel of a PATCH_TILE³ grid g).
// renderer: the app's WebGLRenderer. Its passes run in one go between the
// compile and the readback, leaving the render target and autoClear as they
// were (they cover every texel, and clearing a target with an integer
// attachment is a GL error: app.js turns autoClear off too).
export async function bakeIslandState(renderer, seed) {
  const grid = new BakeGrid(renderer, PATCH_TILE);
  const gen = new WorldGenerator(grid);
  try {
    await grid.compile([gen.mats.column, gen.mats.fill, gen.mats.stamp]);
    const before = renderer.getRenderTarget(), autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      const P = islandParams(seed);
      gen.fill(P);
      gen.plantTrees(P);
    } finally {
      renderer.setRenderTarget(before);
      renderer.autoClear = autoClear;
    }
    const { g } = grid;
    const A = new Float32Array(g.width * g.height * 4);
    await renderer.readRenderTargetPixelsAsync(grid.targets[grid.cur], 0, 0, g.width, g.height, A, undefined, 0);
    return { g, A };
  } finally {
    gen.dispose();
    grid.dispose();
  }
}

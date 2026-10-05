import * as THREE from 'three';
import { quadVert } from './shaders/common.js';
import { moveBlockFrag, moveGatherFrag } from './shaders/move.js';
import { reactFrag } from './shaders/react.js';
import { paintFrag, copyFrag, brickFrag, blurFrag } from './shaders/passes.js';

export function gridLayout(nx, ny, nz) {
  const tx = Math.ceil(Math.sqrt((ny * nz) / nx));
  const ty = Math.ceil(ny / tx);
  const bx = nx / 4, by = ny / 4, bz = nz / 4;
  const btx = Math.ceil(Math.sqrt((by * bz) / bx));
  const bty = Math.ceil(by / btx);
  // Margolus blocks: 2×2×2, partition offset by 0 or 1, so N/2+1 per axis.
  const mx = nx / 2 + 1, my = ny / 2 + 1, mz = nz / 2 + 1;
  const mtx = Math.ceil(Math.sqrt((my * mz) / mx));
  const mty = Math.ceil(my / mtx);
  return {
    nx, ny, nz, tx, ty, btx, bty, mx, my, mz, mtx,
    width: tx * nx, height: ty * nz,
    bwidth: btx * bx, bheight: bty * bz,
    mwidth: mtx * mx, mheight: mty * mz,
    maxSteps: nx + ny + nz + 8,
  };
}

function makeTarget(w, h, count = 2) {
  return new THREE.WebGLRenderTarget(w, h, {
    count,
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

function rawMat(frag, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: quadVert,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

// GPU simulation driver: owns the state ping-pong targets and runs passes.
export class Simulation {
  constructor(renderer, nx, ny, nz) {
    this.renderer = renderer;
    this.g = gridLayout(nx, ny, nz);
    const g = this.g;
    this.frame = 0;
    this.gravity = 0.025;

    this.targets = [makeTarget(g.width, g.height), makeTarget(g.width, g.height)];
    this.cur = 0;
    this.blocks = makeTarget(g.mwidth, g.mheight, 8);
    this.brick = makeTarget(g.bwidth, g.bheight, 1);
    this.light = [makeTarget(g.bwidth, g.bheight, 1), makeTarget(g.bwidth, g.bheight, 1)];

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const state = () => ({ tA: { value: null }, tB: { value: null } });
    this.mats = {
      moveBlock: rawMat(moveBlockFrag(g), { ...state(), uParity: { value: 0 }, uFrame: { value: 0 } }),
      moveGather: rawMat(moveGatherFrag(g), {
        ...state(), uParity: { value: 0 },
        ...Object.fromEntries([...Array(8).keys()].map((i) => [`tM${i}`, { value: null }])),
      }),
      react: rawMat(reactFrag(g), { ...state(), uFrame: { value: 0 }, uGravity: { value: this.gravity } }),
      paint: rawMat(paintFrag(g), {
        ...state(), uFrame: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uRadius: { value: 4 },
        uShape: { value: 0 }, uTool: { value: 2 }, uRate: { value: 1 }, uReplace: { value: false },
      }),
      copy: rawMat(copyFrag(g), state()),
      brick: rawMat(brickFrag(g), { tA: { value: null }, tB: { value: null } }),
      blur: rawMat(blurFrag(g), { tSrc: { value: null }, uAxis: { value: 0 } }),
    };
    this.clear();
  }

  get stateA() { return this.targets[this.cur].textures[0]; }
  get stateB() { return this.targets[this.cur].textures[1]; }

  run(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  // Ping-pong pass over the state.
  pass(mat) {
    mat.uniforms.tA.value = this.stateA;
    mat.uniforms.tB.value = this.stateB;
    this.run(mat, this.targets[1 - this.cur]);
    this.cur = 1 - this.cur;
  }

  step() {
    this.frame++;
    const { moveBlock, moveGather, react } = this.mats;
    // movement: solve each 2×2×2 block once, then every cell gathers its result
    moveBlock.uniforms.uParity.value = this.frame & 1;
    moveBlock.uniforms.uFrame.value = this.frame;
    moveBlock.uniforms.tA.value = this.stateA;
    moveBlock.uniforms.tB.value = this.stateB;
    this.run(moveBlock, this.blocks);
    moveGather.uniforms.uParity.value = this.frame & 1;
    for (let i = 0; i < 8; i++) moveGather.uniforms[`tM${i}`].value = this.blocks.textures[i];
    this.pass(moveGather);
    react.uniforms.uFrame.value = this.frame;
    react.uniforms.uGravity.value = this.gravity;
    this.pass(react);
  }

  paint({ center, radius, shape, tool, rate, replace }) {
    const u = this.mats.paint.uniforms;
    this.frame++;
    u.uFrame.value = this.frame;
    u.uCenter.value.copy(center);
    u.uRadius.value = radius;
    u.uShape.value = shape;
    u.uTool.value = tool;
    u.uRate.value = rate;
    u.uReplace.value = replace;
    this.pass(this.mats.paint);
  }

  // Rebuild the empty-space bricks and the blurred light volume.
  updateBricks() {
    this.mats.brick.uniforms.tA.value = this.stateA;
    this.mats.brick.uniforms.tB.value = this.stateB;
    this.run(this.mats.brick, this.brick);
    const blur = this.mats.blur;
    let src = this.brick.texture;
    for (let i = 0; i < 6; i++) {
      blur.uniforms.tSrc.value = src;
      blur.uniforms.uAxis.value = i % 3;
      const dst = this.light[i & 1];
      this.run(blur, dst);
      src = dst.texture;
    }
    this.lightTexture = src;
  }

  // Upload CPU-built state (Float32Array RGBA per atlas texel).
  load(dataA, dataB) {
    const { width, height } = this.g;
    const texA = new THREE.DataTexture(dataA, width, height, THREE.RGBAFormat, THREE.FloatType);
    const texB = new THREE.DataTexture(dataB, width, height, THREE.RGBAFormat, THREE.FloatType);
    texA.needsUpdate = texB.needsUpdate = true;
    const u = this.mats.copy.uniforms;
    u.tA.value = texA;
    u.tB.value = texB;
    this.run(this.mats.copy, this.targets[this.cur]);
    texA.dispose();
    texB.dispose();
  }

  clear() {
    this.load(...this.blankState());
  }

  // ---- undo history: full GPU copies of the state, newest last ----
  // Each snapshot is two RGBA32F atlases (~70 MB at 128³), so keep only a few.
  snapshot(limit = 3) {
    this.history ??= [];
    const t = this.history.length >= limit ? this.history.shift() : makeTarget(this.g.width, this.g.height);
    const u = this.mats.copy.uniforms;
    u.tA.value = this.stateA;
    u.tB.value = this.stateB;
    this.run(this.mats.copy, t);
    this.history.push(t);
  }

  get canUndo() { return (this.history?.length ?? 0) > 0; }

  undo() {
    const t = this.history?.pop();
    if (!t) return false;
    const u = this.mats.copy.uniforms;
    u.tA.value = t.textures[0];
    u.tB.value = t.textures[1];
    this.run(this.mats.copy, this.targets[this.cur]);
    t.dispose();
    return true;
  }

  blankState() {
    const { width, height } = this.g;
    const a = new Float32Array(width * height * 4);
    const b = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      a[i * 4 + 1] = 20;
      a[i * 4 + 3] = Math.random() * 0.999;
    }
    return [a, b];
  }

  // Debug: read the full state back and summarise it per element.
  census() {
    const { width, height, nx, ny, nz, tx } = this.g;
    const a = new Float32Array(width * height * 4);
    this.renderer.readRenderTargetPixels(this.targets[this.cur], 0, 0, width, height, a, undefined, 0);
    const out = {};
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
          const i = ((Math.floor(y / tx) * nz + z) * width + (y % tx) * nx + x) * 4;
          const id = Math.round(a[i]);
          const o = (out[id] ??= { n: 0, T: 0, minY: 1e9, maxY: -1, Tmax: -1e9 });
          o.n++; o.T += a[i + 1]; o.minY = Math.min(o.minY, y); o.maxY = Math.max(o.maxY, y); o.Tmax = Math.max(o.Tmax, a[i + 1]);
        }
    for (const k in out) out[k].T = +(out[k].T / out[k].n).toFixed(1);
    return out;
  }

  dispose() {
    this.targets.forEach((t) => t.dispose());
    this.brick.dispose();
    this.blocks.dispose();
    this.light.forEach((t) => t.dispose());
    this.history?.forEach((t) => t.dispose());
    Object.values(this.mats).forEach((m) => m.dispose());
    this.quad.geometry.dispose();
  }
}

import * as THREE from 'three';
import { quadVert, BRICK, SEED_MAX } from './shaders/common.js';
import { inertFrag, quietFrag, activityPeriod } from './shaders/activity.js';
import { moveBlockFrag, moveGatherFrag, moveFlowFrag } from './shaders/move.js';
import { reactFrag } from './shaders/react.js';
import { paintFrag, copyFrag, brickFrag, blurFrag, brickDistFrag } from './shaders/passes.js';
import { fieldEmaFrag, fieldBlurFrag, fieldBoostFrag, BOOST_STAGES } from './shaders/fields.js';
import { giSourceFrag, giGatherFrag } from './shaders/gi.js';
import { CHANNELS, MEDIA, gauss5, bulkPeak, bulkPeakCubic, CUBIC_LATTICE } from './gfx/materials.js';
import { gfxUniforms } from './gfx/uniforms.js';

// cells/step² downward (the app's gravity setting overrides it)
const GRAVITY_DEFAULT = 0.025;
// blur passes over the glow volume: x, y, z, twice
const LIGHT_BLUR_PASSES = 6;

// Steps an activity map stays valid (shaders/activity.js).
const ACTIVITY_PERIOD = activityPeriod(BRICK);

export function gridLayout(nx, ny, nz) {
  const tx = Math.ceil(Math.sqrt((ny * nz) / nx));
  const ty = Math.ceil(ny / tx);
  const bx = nx / BRICK, by = ny / BRICK, bz = nz / BRICK;
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

function makeFieldTarget(w, h, count, type, filter) {
  return new THREE.WebGLRenderTarget(w, h, {
    count, type, format: THREE.RGBAFormat, minFilter: filter, magFilter: filter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
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

// Uniforms of the GI passes (shaders/gi.js); the probe textures are rebound per frame.
const giUniforms = () => ({
  tA: { value: null }, tBrick: { value: null }, tShadow: { value: null }, uShadowRes: { value: 1 },
  uShadows: { value: true }, uSun: { value: new THREE.Vector3(0, 1, 0) },
  // sky values (computed per frame by updateGfxUniforms)
  uSunExt: gfxUniforms.uSunExt, uSunCol: gfxUniforms.uSunCol, uSkyUp: gfxUniforms.uSkyUp, uGround: gfxUniforms.uGround,
  uKeyLight: gfxUniforms.uKeyLight,
});
const giProbeUniforms = () => Object.fromEntries([0, 1, 2, 3].map((i) => [`tGI${i}`, { value: null }]));

// Share of each step's displacements blended into the flow field (the rest is
// history): grains move a cell on some steps and not others, so the field
// averages their speed over about 1 / FLOW_BLEND steps.
const FLOW_BLEND = 0.05;

// Share of each update's new GI probes blended into the probe volume (the rest
// is history): smooths cells popping between bricks over a few frames. Each
// probe is updated every other frame.
export const GI_BLEND = 0.4;

const fieldBlurUniforms = () => ({
  t0: { value: null }, t1: { value: null }, t2: { value: null }, uAxis: { value: 0 },
  uW: { value: [...Array(5)].map(() => new THREE.Vector4()) },
});

let nextSimId = 0;

// GPU simulation driver: owns the state ping-pong targets and runs passes.
export class Simulation {
  constructor(renderer, nx, ny, nz) {
    this.renderer = renderer;
    this.id = nextSimId++;   // tells a rebuilt simulation from the old one
    this.g = gridLayout(nx, ny, nz);
    const g = this.g;
    this.frame = 0;
    this.paints = 0;   // brush strokes applied (the paint pass's random stream)
    this.gravity = GRAVITY_DEFAULT;
    // bumped by every write to the state (steps, painting, loads, undo, network
    // updates), so callers can tell when the world changed
    this.version = 0;

    this.targets = [makeTarget(g.width, g.height), makeTarget(g.width, g.height)];
    this.cur = 0;
    this.blocks = makeTarget(g.mwidth, g.mheight, 8);
    this.brick = makeTarget(g.bwidth, g.bheight, 1);
    this.light = [makeTarget(g.bwidth, g.bheight, 1), makeTarget(g.bwidth, g.bheight, 1)];
    // render fields (see shaders/fields.js): EMA ping-pong + blur and boost
    // scratch in RGBA8, the blurred fields in half floats, the boosted final
    // fields (and the thin-feature mask) in filterable half floats
    const U8 = THREE.UnsignedByteType, NEAR = THREE.NearestFilter, HALF = THREE.HalfFloatType;
    this.fieldEma = [makeFieldTarget(g.width, g.height, 3, U8, NEAR), makeFieldTarget(g.width, g.height, 3, U8, NEAR)];
    this.fieldTmp = makeFieldTarget(g.width, g.height, 3, U8, NEAR);
    this.fieldsBlurred = makeFieldTarget(g.width, g.height, 2, HALF, NEAR);
    this.fields = makeFieldTarget(g.width, g.height, 3, HALF, THREE.LinearFilter);
    // how fast matter has been moving through each cell (shaders/move.js moveFlowFrag)
    this.flowV = makeFieldTarget(g.width, g.height, 1, HALF, NEAR);
    this.fieldCur = 0;
    this.fieldReset = true;
    this.smoothing = 1;
    // GI (shaders/gi.js): per-brick light sources and blockers, and the probe
    // volume (L1 spherical harmonics, filterable for trilinear lookups)
    this.giSrc = makeFieldTarget(g.bwidth, g.bheight, 3, HALF, NEAR);
    this.giProbes = makeFieldTarget(g.bwidth, g.bheight, 4, HALF, THREE.LinearFilter);
    this.giReset = true;
    // activity map (shaders/activity.js): inert bricks, then the quiet ones the
    // step passes skip. Rebuilt every ACTIVITY_PERIOD steps and after any
    // write that isn't a step (painting, loads), which may wake a brick.
    // empty-space distance per brick (shaders/passes.js brickDistFrag), and its scratch
    this.brickDist = [makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR), makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR)];
    this.actInert = makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR);
    this.actQuiet = makeFieldTarget(g.bwidth, g.bheight, 1, U8, NEAR);
    this.actAge = ACTIVITY_PERIOD;
    this.actDirty = true;
    this.stepping = false;
    this.skipQuiet = true;   // false: step every brick (A/B testing)

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const state = () => ({ tA: { value: null }, tB: { value: null } });
    this.mats = {
      moveBlock: rawMat(moveBlockFrag(g), { ...state(), uParity: { value: 0 }, uFrame: { value: 0 }, tQuiet: { value: null } }),
      moveGather: rawMat(moveGatherFrag(g), {
        ...state(), uParity: { value: 0 },
        ...Object.fromEntries([...Array(8).keys()].map((i) => [`tM${i}`, { value: null }])),
      }),
      react: rawMat(reactFrag(g), { ...state(), uFrame: { value: 0 }, uGravity: { value: this.gravity }, tQuiet: { value: null } }),
      inert: rawMat(inertFrag(g), state()),
      quiet: rawMat(quietFrag(g), { tInert: { value: null }, uEnabled: { value: true } }),
      paint: rawMat(paintFrag(g), {
        ...state(), uFrame: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uRadius: { value: 4 },
        uShape: { value: 0 }, uTool: { value: 2 }, uRate: { value: 1 }, uReplace: { value: false },
      }),
      copy: rawMat(copyFrag(g), state()),
      moveFlow: rawMat(moveFlowFrag(g), {
        uParity: { value: 0 }, tQuiet: { value: null }, ...Object.fromEntries([...Array(8).keys()].map((i) => [`tM${i}`, { value: null }])),
      }),
      brick: rawMat(brickFrag(g), {
        tA: { value: null }, tB: { value: null }, tFS: { value: null }, tFM: { value: null }, tFT: { value: null },
      }),
      fieldEma: rawMat(fieldEmaFrag(g), {
        tA: { value: null }, tP0: { value: null }, tP1: { value: null },
        uEmaS: { value: new THREE.Vector4() }, uEmaM: { value: new THREE.Vector4() },
      }),
      fieldBlur: rawMat(fieldBlurFrag(g, false), fieldBlurUniforms()),
      fieldFinal: rawMat(fieldBlurFrag(g, true), fieldBlurUniforms()),
      fieldBoost: [...Array(BOOST_STAGES).keys()].map((stage) => rawMat(fieldBoostFrag(g, stage), {
        t0: { value: null }, t1: { value: null }, tPhi: { value: null }, tMed: { value: null },
        uS: { value: new THREE.Vector4(...CHANNELS.map((c) => (c.cubic ? CUBIC_LATTICE[1] : 1))) },
        uBulk: { value: new THREE.Vector4() },
      })),
      blur: rawMat(blurFrag(g), { tSrc: { value: null }, uAxis: { value: 0 } }),
      brickDist: [0, 1, 2].map((axis) => rawMat(brickDistFrag(g, axis), { tSrc: { value: null } })),
      giSource: rawMat(giSourceFrag(g), { ...giUniforms(), ...giProbeUniforms() }),
      giGather: rawMat(giGatherFrag(g), {
        ...giUniforms(), tGIRad: { value: null }, tGICov: { value: null }, tGIDir: { value: null },
        uParity: { value: -1 },
      }),
    };
    // the flow pass blends into the flow field: new * FLOW_BLEND + old * (1 - FLOW_BLEND)
    Object.assign(this.mats.moveFlow, {
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.ConstantAlphaFactor, blendDst: THREE.OneMinusConstantAlphaFactor, blendAlpha: FLOW_BLEND,
    });
    // the gather blends into the probe volume: new * GI_BLEND + old * (1 - GI_BLEND)
    Object.assign(this.mats.giGather, {
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.ConstantAlphaFactor, blendDst: THREE.OneMinusConstantAlphaFactor,
    });
    this.clear();
  }

  get stateA() { return this.targets[this.cur].textures[0]; }
  get stateB() { return this.targets[this.cur].textures[1]; }

  run(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    if (target === this.targets[0] || target === this.targets[1]) {
      this.version++;
      if (!this.stepping) this.actDirty = true;
    }
  }

  // Rebuild the activity map from the current state (shaders/activity.js).
  updateActivity() {
    const { inert, quiet } = this.mats;
    inert.uniforms.tA.value = this.stateA;
    inert.uniforms.tB.value = this.stateB;
    this.run(inert, this.actInert);
    quiet.uniforms.tInert.value = this.actInert.texture;
    quiet.uniforms.uEnabled.value = this.skipQuiet;
    this.run(quiet, this.actQuiet);
    this.actAge = 0;
    this.actDirty = false;
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
    if (this.actDirty || this.actAge >= ACTIVITY_PERIOD) this.updateActivity();
    this.actAge++;
    this.stepping = true;
    const { moveBlock, moveGather, react } = this.mats;
    moveBlock.uniforms.tQuiet.value = react.uniforms.tQuiet.value = this.actQuiet.texture;
    // movement: solve each 2×2×2 block once, then every cell gathers its result
    moveBlock.uniforms.uParity.value = this.frame & 1;
    moveBlock.uniforms.uFrame.value = this.frame;
    moveBlock.uniforms.tA.value = this.stateA;
    moveBlock.uniforms.tB.value = this.stateB;
    this.run(moveBlock, this.blocks);
    moveGather.uniforms.uParity.value = this.frame & 1;
    for (let i = 0; i < 8; i++) moveGather.uniforms[`tM${i}`].value = this.blocks.textures[i];
    this.pass(moveGather);
    const { moveFlow } = this.mats;
    moveFlow.uniforms.uParity.value = this.frame & 1;
    moveFlow.uniforms.tQuiet.value = this.actQuiet.texture;
    for (let i = 0; i < 8; i++) moveFlow.uniforms[`tM${i}`].value = this.blocks.textures[i];
    this.run(moveFlow, this.flowV);
    react.uniforms.uFrame.value = this.frame;
    react.uniforms.uGravity.value = this.gravity;
    this.pass(react);
    this.stepping = false;
  }

  paint({ center, radius, shape, tool, rate, replace }) {
    const u = this.mats.paint.uniforms;
    // Its own random stream: this.frame counts steps only. The move pass
    // alternates its block partition by the step count's parity, so a paint
    // bumping it would lock the partition when one step runs per paint (Speed
    // 1 while painting: poured matter could never leave its 2×2×2 block); the
    // POV body and the media drift clock also read it as steps taken.
    this.paints++;
    u.uFrame.value = this.paints;
    u.uCenter.value.copy(center);
    u.uRadius.value = radius;
    u.uShape.value = shape;
    u.uTool.value = tool;
    u.uRate.value = rate;
    u.uReplace.value = replace;
    this.pass(this.mats.paint);
  }

  get flowTexture() { return this.flowV.texture; }
  get fieldSurf() { return this.fields.textures[0]; }
  get fieldMedia() { return this.fields.textures[1]; }
  get fieldThin() { return this.fields.textures[2]; }

  // Rebuild the renderer's continuous fields (shaders/fields.js).
  updateFields() {
    const { fieldEma, fieldBlur, fieldFinal } = this.mats;
    const prev = this.fieldEma[this.fieldCur], next = this.fieldEma[1 - this.fieldCur];
    const reset = this.fieldReset;
    this.fieldReset = false;
    const u = fieldEma.uniforms;
    u.tA.value = this.stateA;
    u.tP0.value = prev.textures[0];
    u.tP1.value = prev.textures[1];
    u.uEmaS.value.set(...CHANNELS.map((c) => (reset ? 1 : c.ema)));
    u.uEmaM.value.set(...MEDIA.map((m) => (reset ? 1 : m.ema)));
    this.run(fieldEma, next);
    this.fieldCur = 1 - this.fieldCur;
    // per-channel kernels, tap-major
    const k = CHANNELS.map((c) => gauss5(Math.max(c.sigma * this.smoothing, 0.05)));
    const setW = (mat) => mat.uniforms.uW.value.forEach((v, i) => v.set(k[0][i], k[1][i], k[2][i], k[3][i]));
    // x: next -> prev (free until the next frame), y: prev -> tmp, z: tmp -> blurred
    const passes = [[fieldBlur, next, prev], [fieldBlur, prev, this.fieldTmp], [fieldFinal, this.fieldTmp, this.fieldsBlurred]];
    passes.forEach(([mat, src, dst], axis) => {
      setW(mat);
      mat.uniforms.uAxis.value = axis;
      mat.uniforms.t0.value = src.textures[0];
      mat.uniforms.t1.value = src.textures[1];
      mat.uniforms.t2.value = src.textures[2];
      this.run(mat, dst);
    });
    // thin-feature boost: smooth x, y, z then peak x, y, z, ping-ponging
    // between prev and tmp; stage 0 reads the blurred fields and the state,
    // the last writes the final fields
    const boost = this.mats.fieldBoost;
    const last = BOOST_STAGES - 1;
    const dst = (s) => (s === last ? this.fields : s % 2 ? this.fieldTmp : prev);
    const lu = boost[last].uniforms;
    lu.tPhi.value = this.fieldsBlurred.textures[0];
    lu.tMed.value = this.fieldsBlurred.textures[1];
    lu.uBulk.value.set(...k.map((w, i) => (CHANNELS[i].cubic ? bulkPeakCubic(w) : bulkPeak(w))));
    boost.forEach((mat, s) => {
      mat.uniforms.t0.value = s ? dst(s - 1).textures[0] : this.fieldsBlurred.textures[0];
      mat.uniforms.t1.value = s ? dst(s - 1).textures[1] : this.stateA;
      this.run(mat, dst(s));
    });
  }

  // Rebuild the render fields, the empty-space bricks and the blurred light volume.
  updateBricks() {
    this.updateFields();
    this.mats.brick.uniforms.tA.value = this.stateA;
    this.mats.brick.uniforms.tB.value = this.stateB;
    this.mats.brick.uniforms.tFS.value = this.fieldSurf;
    this.mats.brick.uniforms.tFM.value = this.fieldMedia;
    this.mats.brick.uniforms.tFT.value = this.fieldThin;
    this.run(this.mats.brick, this.brick);
    // empty-space distance: x from the brick map, then y, then z (ends in brickDist[0])
    const [dx, dy, dz] = this.mats.brickDist;
    dx.uniforms.tSrc.value = this.brick.texture;
    this.run(dx, this.brickDist[0]);
    dy.uniforms.tSrc.value = this.brickDist[0].texture;
    this.run(dy, this.brickDist[1]);
    dz.uniforms.tSrc.value = this.brickDist[1].texture;
    this.run(dz, this.brickDist[0]);
    const blur = this.mats.blur;
    let src = this.brick.texture;
    for (let i = 0; i < LIGHT_BLUR_PASSES; i++) {
      blur.uniforms.tSrc.value = src;
      blur.uniforms.uAxis.value = i % 3;
      const dst = this.light[i & 1];
      this.run(blur, dst);
      src = dst.texture;
    }
    this.lightTexture = src;
  }

  get giTextures() { return this.giProbes.textures; }
  get brickDistTexture() { return this.brickDist[0].texture; }

  // Rebuild the GI probe volume (realistic view; after the shadow map, which it
  // reads for sunlight). sun: unit vector toward the sun.
  updateGI(sun, shadowMap, shadowRes, shadows) {
    const { giSource, giGather } = this.mats;
    for (const m of [giSource, giGather]) {
      const u = m.uniforms;
      u.tA.value = this.stateA;
      u.tBrick.value = this.brick.texture;
      u.tShadow.value = shadowMap;
      u.uShadowRes.value = shadowRes;
      u.uShadows.value = shadows;
      u.uSun.value.copy(sun);
    }
    this.giProbes.textures.forEach((t, i) => { giSource.uniforms[`tGI${i}`].value = t; });
    this.run(giSource, this.giSrc);
    const u = giGather.uniforms;
    [u.tGIRad.value, u.tGICov.value, u.tGIDir.value] = this.giSrc.textures;
    // after a reset trace every probe and replace; else half of them, blended in
    this.giFrame = (this.giFrame ?? 0) + 1;
    u.uParity.value = this.giReset ? -1 : this.giFrame & 1;
    giGather.blendAlpha = this.giReset ? 1 : GI_BLEND;
    this.giReset = false;
    this.run(giGather, this.giProbes);
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
    this.fieldReset = true;
    this.giReset = true;
    this.stillFlow();
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
    this.stillFlow();
    t.dispose();
    return true;
  }

  // The state was replaced: nothing is moving until the next step says so.
  stillFlow() {
    this.renderer.setRenderTarget(this.flowV);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, false, false);
  }

  blankState() {
    const { width, height } = this.g;
    const a = new Float32Array(width * height * 4);
    const b = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      a[i * 4 + 1] = 20;
      a[i * 4 + 3] = Math.random() * SEED_MAX;
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
    this.fieldEma.forEach((t) => t.dispose());
    this.fieldTmp.dispose();
    this.fieldsBlurred.dispose();
    this.fields.dispose();
    this.flowV.dispose();
    this.brickDist.forEach((t) => t.dispose());
    this.actInert.dispose();
    this.actQuiet.dispose();
    this.giSrc.dispose();
    this.giProbes.dispose();
    this.history?.forEach((t) => t.dispose());
    Object.values(this.mats).forEach((m) => m.dispose());
    this.quad.geometry.dispose();
  }
}

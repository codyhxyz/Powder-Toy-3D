import * as THREE from 'three';
import { quadVert, BRICK, SEED_MAX, TILE, SUPER, SUPER_TEX, SUPER_CELLS } from './shaders/common.js';
import { inertFrag, quietFrag, activityPeriod } from './shaders/activity.js';
import { moveBlockFrag, moveGatherFrag } from './shaders/move.js';
import { reactFrag } from './shaders/react.js';
import { paintFrag, copyFrag, brickFrag, blurFrag, brickDistFrag } from './shaders/passes.js';
import { fieldEmaFrag, fieldBlurFrag, fieldBoostFrag, BOOST_STAGES } from './shaders/fields.js';
import { giSourceFrag, giGatherFrag } from './shaders/gi.js';
import { shiftFrag, giShiftFrag } from './shaders/window.js';
import { CHANNELS, MEDIA, gauss5, bulkPeak, bulkPeakCubic, CUBIC_LATTICE } from './gfx/materials.js';
import { gfxUniforms } from './gfx/uniforms.js';

// cells/step² downward (the app's gravity setting overrides it)
const GRAVITY_DEFAULT = 0.025;
// blur passes over the glow volume: x, y, z, twice
const LIGHT_BLUR_PASSES = 6;

// Steps an activity map stays valid (shaders/activity.js).
const ACTIVITY_PERIOD = activityPeriod(BRICK);

// The state atlas may be at most this many times wider than tall (atlasColumns).
const ATLAS_ASPECT_MAX = 4;

// Supertiles per state-atlas row: the smallest divisor of their count from its
// square root up, so the atlas is near square and every texel holds a cell
// (all the app's grid sizes). If that would make it more than ATLAS_ASPECT_MAX
// times wider than tall, a square atlas whose last row is partly empty.
function atlasColumns(count) {
  const root = Math.ceil(Math.sqrt(count));
  let w = root;
  while (count % w) w++;
  return w * w <= ATLAS_ASPECT_MAX * count ? w : root;
}

export function gridLayout(nx, ny, nz) {
  if (nx % SUPER_CELLS.x || ny % SUPER_CELLS.y || nz % SUPER_CELLS.z) {
    throw new Error(`grid ${nx}×${ny}×${nz}: sides must be multiples of ${SUPER_CELLS.x}×${SUPER_CELLS.y}×${SUPER_CELLS.z} (a supertile)`);
  }
  // state atlas (brick-major, shaders/common.js): supertiles row-major
  const stx = nx / SUPER_CELLS.x, sty = ny / SUPER_CELLS.y, stz = nz / SUPER_CELLS.z;
  const stw = atlasColumns(stx * sty * stz);
  const sth = Math.ceil((stx * sty * stz) / stw);
  // render-field atlas: Y-slices, ftx per row
  const ftx = Math.ceil(Math.sqrt((ny * nz) / nx));
  const fty = Math.ceil(ny / ftx);
  const bx = nx / BRICK, by = ny / BRICK, bz = nz / BRICK;
  const btx = Math.ceil(Math.sqrt((by * bz) / bx));
  const bty = Math.ceil(by / btx);
  // Margolus blocks: 2×2×2, partition offset by 0 or 1, so N/2+1 per axis.
  const mx = nx / 2 + 1, my = ny / 2 + 1, mz = nz / 2 + 1;
  const mtx = Math.ceil(Math.sqrt((my * mz) / mx));
  const mty = Math.ceil(my / mtx);
  return {
    nx, ny, nz, stx, sty, stz, stw, ftx, btx, bty, mx, my, mz, mtx,
    width: stw * SUPER_TEX, height: sth * SUPER_TEX,
    fwidth: ftx * nx, fheight: fty * nz,
    bwidth: btx * bx, bheight: bty * bz,
    mwidth: mtx * mx, mheight: mty * mz,
    maxSteps: nx + ny + nz + 8,
  };
}

// JS mirror of atlas() and cellFromFrag() (shaders/common.js), for CPU code
// that builds or reads the state: the index of cell (x, y, z)'s texel in a
// width × height state texture (× 4 for its RGBA floats), and back ([x, y, z],
// or null for a texel past the last supertile, which holds no cell).
export function cellTexel(g, x, y, z) {
  const bx = Math.floor(x / BRICK), by = Math.floor(y / BRICK), bz = Math.floor(z / BRICK);   // brick
  const sx = Math.floor(bx / SUPER.x), sy = Math.floor(by / SUPER.y), sz = Math.floor(bz / SUPER.z);   // supertile
  const i = sx + g.stx * (sz + g.stz * sy);   // supertile number
  const ly = y - by * BRICK;
  const u = (i % g.stw) * SUPER_TEX + (bx - sx * SUPER.x) * TILE + (x - bx * BRICK) + BRICK * (ly & 1);
  const v = Math.floor(i / g.stw) * SUPER_TEX + (bz - sz * SUPER.z + SUPER.z * (by - sy * SUPER.y)) * TILE
    + (z - bz * BRICK) + BRICK * (ly >> 1);
  return v * g.width + u;
}
export function texelCell(g, t) {
  const u = t % g.width, v = Math.floor(t / g.width);
  const su = Math.floor(u / SUPER_TEX), sv = Math.floor(v / SUPER_TEX);   // supertile slot
  const i = su + g.stw * sv;
  if (i >= g.stx * g.sty * g.stz) return null;
  const sx = i % g.stx, sz = Math.floor(i / g.stx) % g.stz, sy = Math.floor(i / (g.stx * g.stz));
  const tu = u - su * SUPER_TEX, tv = v - sv * SUPER_TEX;   // texel in the supertile
  const ku = Math.floor(tu / TILE), kv = Math.floor(tv / TILE);   // brick tile
  const lu = tu - ku * TILE, lv = tv - kv * TILE;           // texel in the tile
  return [
    (sx * SUPER.x + ku) * BRICK + (lu % BRICK),
    (sy * SUPER.y + Math.floor(kv / SUPER.z)) * BRICK + (Math.floor(lu / BRICK) | (Math.floor(lv / BRICK) << 1)),
    (sz * SUPER.z + (kv % SUPER.z)) * BRICK + (lv % BRICK),
  ];
}

// JS mirror of brickAtlas() (shaders/common.js): the index of brick (bx, by,
// bz)'s texel in the brick-resolution targets (bwidth × bheight).
export function brickTexel(g, bx, by, bz) {
  const BX = g.nx / BRICK, BZ = g.nz / BRICK;
  return (Math.floor(by / g.btx) * BZ + bz) * g.bwidth + (by % g.btx) * BX + bx;
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

export function makeFieldTarget(w, h, count, type, filter) {
  return new THREE.WebGLRenderTarget(w, h, {
    count, type, format: THREE.RGBAFormat, minFilter: filter, magFilter: filter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}

export function rawMat(frag, uniforms) {
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
    // (all in the field atlas: Y-slices, fwidth × fheight)
    this.fieldEma = [makeFieldTarget(g.fwidth, g.fheight, 3, U8, NEAR), makeFieldTarget(g.fwidth, g.fheight, 3, U8, NEAR)];
    this.fieldTmp = makeFieldTarget(g.fwidth, g.fheight, 3, U8, NEAR);
    this.fieldsBlurred = makeFieldTarget(g.fwidth, g.fheight, 2, HALF, NEAR);
    this.fields = makeFieldTarget(g.fwidth, g.fheight, 3, HALF, THREE.LinearFilter);
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

    // The grid is a window of the world (docs/scaling.md D11): origin is the
    // world cell of grid cell (0, 0, 0), the prelude's uOrigin in every pass
    // (run). A grid that is its whole world stays at 0; shift() moves it.
    this.origin = new THREE.Vector3();
    this.originUniform = { value: this.origin };
    // grid cells the window moved since the render fields last updated (their history follows)
    this.fieldShift = new THREE.Vector3();
    // false: a shift starts the render fields and GI over instead of moving their history (A/B)
    this.shiftKeepsHistory = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const state = () => ({ tA: { value: null }, tB: { value: null } });
    this.mats = {
      moveBlock: rawMat(moveBlockFrag(g), {
        ...state(), uParity: { value: 0 }, uFrame: { value: 0 }, uGravity: { value: this.gravity }, tQuiet: { value: null },
      }),
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
      brick: rawMat(brickFrag(g), {
        tA: { value: null }, tB: { value: null }, tFS: { value: null }, tFM: { value: null }, tFT: { value: null },
      }),
      fieldEma: rawMat(fieldEmaFrag(g), {
        tA: { value: null }, tP0: { value: null }, tP1: { value: null },
        uEmaS: { value: new THREE.Vector4() }, uEmaM: { value: new THREE.Vector4() }, uShift: { value: new THREE.Vector3() },
      }),
      fieldBlur: rawMat(fieldBlurFrag(g, false), fieldBlurUniforms()),
      fieldFinal: rawMat(fieldBlurFrag(g, true), fieldBlurUniforms()),
      fieldBoost: [...Array(BOOST_STAGES).keys()].map((stage) => rawMat(fieldBoostFrag(g, stage), {
        tA: { value: null }, t0: { value: null }, t1: { value: null }, tPhi: { value: null }, tMed: { value: null },
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
    // the gather blends into the probe volume: new * GI_BLEND + old * (1 - GI_BLEND)
    Object.assign(this.mats.giGather, {
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.ConstantAlphaFactor, blendDst: THREE.OneMinusConstantAlphaFactor,
    });
    // pass names (the profiler's labels): the key, plus the stage for staged passes (fieldBoost0…)
    for (const [key, m] of Object.entries(this.mats)) {
      if (Array.isArray(m)) m.forEach((stage, i) => { stage.name = `${key}${i}`; });
      else m.name = key;
    }
    // profiling hook (gfx/profiler.js): onPass(name, target) after every pass
    this.onPass = null;
    this.clear();
  }

  get stateA() { return this.targets[this.cur].textures[0]; }
  get stateB() { return this.targets[this.cur].textures[1]; }

  // Index of cell (x, y, z)'s texel in the state arrays, and back (cellTexel, texelCell).
  cellTexel(x, y, z) { return cellTexel(this.g, x, y, z); }
  texelCell(i) { return texelCell(this.g, i); }

  // The current state read back, as float RGBA per atlas texel in the
  // fetchA/fetchB layout (what load() takes): [A, B]. For CPU checks and
  // tools; cellTexel finds a cell in it.
  readState() {
    const { width, height } = this.g;
    const t = this.targets[this.cur];
    const a = new Float32Array(width * height * 4), b = new Float32Array(width * height * 4);
    this.renderer.readRenderTargetPixels(t, 0, 0, width, height, a, undefined, 0);
    this.renderer.readRenderTargetPixels(t, 0, 0, width, height, b, undefined, 1);
    return [a, b];
  }

  // One cell of the current state, read back: [a, b] in the fetchA/fetchB
  // layout (two RGBA float arrays). Synchronous; for tests and tools.
  readCell(x, y, z) {
    const i = this.cellTexel(x, y, z), w = this.g.width;
    const t = this.targets[this.cur];
    const a = new Float32Array(4), b = new Float32Array(4);
    this.renderer.readRenderTargetPixels(t, i % w, Math.floor(i / w), 1, 1, a, undefined, 0);
    this.renderer.readRenderTargetPixels(t, i % w, Math.floor(i / w), 1, 1, b, undefined, 1);
    return [a, b];
  }

  // Block until the GPU has done everything queued so far, by reading one
  // texel of the current state back (wall-clock timing of GPU work).
  gpuSync() {
    this.syncTexel ??= new Float32Array(4);
    this.renderer.readRenderTargetPixels(this.targets[this.cur], 0, 0, 1, 1, this.syncTexel, undefined, 0);
  }

  run(mat, target) {
    // every pass sees the window's origin (shaders/common.js uOrigin), unless it brings its own
    mat.uniforms.uOrigin ??= this.originUniform;
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.onPass?.(mat.name, target);
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
    moveBlock.uniforms.uGravity.value = this.gravity;
    moveBlock.uniforms.tA.value = this.stateA;
    moveBlock.uniforms.tB.value = this.stateB;
    this.run(moveBlock, this.blocks);
    moveGather.uniforms.uParity.value = this.frame & 1;
    for (let i = 0; i < 8; i++) moveGather.uniforms[`tM${i}`].value = this.blocks.textures[i];
    this.pass(moveGather);
    react.uniforms.uFrame.value = this.frame;
    react.uniforms.uGravity.value = this.gravity;
    this.pass(react);
    this.stepping = false;
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
    u.uShift.value.copy(this.fieldShift);
    this.fieldShift.set(0, 0, 0);
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
      if (s) mat.uniforms.t1.value = dst(s - 1).textures[1];
      else mat.uniforms.tA.value = this.stateA;
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

  // Move the window over the world (docs/scaling.md D11) by (dx, 0, dz) world
  // cells, whole supertiles: cell p takes the state of p + (dx, 0, dz), so the
  // content moves the other way and stays put in the world. Cells shifted in
  // from outside are still air until the caller fills them (world/window.js:
  // the generator, then stored edits). One pass: the other state copy is left
  // stale until syncCopies(), so the caller fills first and syncs once. The
  // render fields' history and the GI probes move with the cells, the brick
  // maps rebuild with the next updateBricks and the activity map is redone
  // (run). Undo snapshots hold the old window: they are dropped.
  shift(dx, dz) {
    if (dx % SUPER_CELLS.x || dz % SUPER_CELLS.z) {
      throw new Error(`shift ${dx}, ${dz}: must be whole supertiles (${SUPER_CELLS.x} × ${SUPER_CELLS.z} cells)`);
    }
    // (made on the first shift: only a window of a larger world moves)
    const g = this.g;
    this.mats.shift ??= Object.assign(rawMat(shiftFrag(g), { tA: { value: null }, tB: { value: null }, uShift: { value: new THREE.Vector3() } }), { name: 'shift' });
    this.mats.giShift ??= Object.assign(rawMat(giShiftFrag(g), { ...giProbeUniforms(), uShift: { value: new THREE.Vector3() } }), { name: 'giShift' });
    const m = this.mats.shift;
    m.uniforms.uShift.value.set(dx, 0, dz);
    this.pass(m);
    this.origin.x += dx;
    this.origin.z += dz;
    if (!this.shiftKeepsHistory) {
      this.fieldReset = this.giReset = true;
    } else {
      this.fieldShift.x += dx;
      this.fieldShift.z += dz;
      if (!this.giReset) {
        const gs = this.mats.giShift;
        this.giProbesTmp ??= makeFieldTarget(g.bwidth, g.bheight, 4, THREE.HalfFloatType, THREE.LinearFilter);
        gs.uniforms.uShift.value.set(dx / BRICK, 0, dz / BRICK);
        this.giProbes.textures.forEach((t, i) => { gs.uniforms[`tGI${i}`].value = t; });
        this.run(gs, this.giProbesTmp);
        [this.giProbes, this.giProbesTmp] = [this.giProbesTmp, this.giProbes];
      }
    }
    this.history?.forEach((t) => t.dispose());
    this.history = [];
  }

  // Copy the current state into the other copy, so both hold it (after passes
  // that leave it stale: a shift and its fill). Where nothing steps, the two
  // copies must agree (docs/scaling.md D8).
  syncCopies() {
    const u = this.mats.copy.uniforms;
    u.tA.value = this.stateA;
    u.tB.value = this.stateB;
    this.run(this.mats.copy, this.targets[1 - this.cur]);
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
    const g = this.g;
    const a = new Float32Array(g.width * g.height * 4);
    const b = new Float32Array(g.width * g.height * 4);
    for (let i = 0; i < g.width * g.height; i++) a[i * 4 + 1] = 20;
    // One seed per texel of the Y-slice field atlas, in its row order, padding
    // included: the state atlas's order before it went brick-major, so a
    // seeded Math.random (tools/regress.mjs) still gives each cell its seed.
    for (let fy = 0; fy < g.fheight; fy++) {
      const row = Math.floor(fy / g.nz), z = fy - row * g.nz;
      for (let col = 0; col < g.ftx; col++) {
        const y = row * g.ftx + col;
        for (let x = 0; x < g.nx; x++) {
          const seed = Math.random() * SEED_MAX;
          if (y < g.ny) a[cellTexel(g, x, y, z) * 4 + 3] = seed;
        }
      }
    }
    return [a, b];
  }

  // Debug: read the full state back and summarise it per element.
  census() {
    const { nx, ny, nz } = this.g;
    const [a] = this.readState();
    const out = {};
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
          const i = this.cellTexel(x, y, z) * 4;
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
    this.brickDist.forEach((t) => t.dispose());
    this.actInert.dispose();
    this.actQuiet.dispose();
    this.giSrc.dispose();
    this.giProbes.dispose();
    this.giProbesTmp?.dispose();
    this.history?.forEach((t) => t.dispose());
    Object.values(this.mats).flat().forEach((m) => m.dispose());   // (fieldBoost, brickDist are arrays)
    this.quad.geometry.dispose();
  }
}

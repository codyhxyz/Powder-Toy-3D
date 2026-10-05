// Graphics settings and the uniforms shared by the render shaders (volume and
// shadow pass). Entry points spread `gfxUniforms` into their materials and
// call `updateGfxUniforms(sim, sun)` once per frame before rendering, so new
// graphics features only need to touch this file, not the app wiring.
import { mediaNoiseUniform } from './mediaNoise.js';
import { skyState } from './sky.js';

// The media detail clock (simulation steps) wraps here, seamlessly for the
// drift speeds allowed in gfx/materials.js (MEDIA rise).
const SIM_CLOCK_WRAP = 1 << 20;

export const gfx = {
  smoothing: 1,          // multiplier on every smooth channel's blur radius
  materials: 1,          // textured materials (0 = flat albedo, for A/B timing)
  bevel: 0.12,           // crisp-voxel edge radius in cells (0 = sharp cubes)
  glints: 0.4,           // sun glints on sand, snow and gunpowder (untuned: kept low to avoid fireflies)
};

export const gfxUniforms = {
  tB: { value: null },        // velocity xyz (cells/step), pressure
  tFS: { value: null },       // smooth-surface fields
  tFM: { value: null },       // media fields
  tFT: { value: null },       // thin-feature mask (cubic liquid)
  uFrame: { value: 0 },       // frame counter (for temporal jitter)
  uSimClock: { value: 0 },    // simulation steps (wrapped): media detail drifts with it, frozen when paused
  tMediaNoise: mediaNoiseUniform(),   // tileable detail noise for smoke, steam and fire
  tGI0: { value: null },      // GI probe volume (shaders/gi.js): L1 SH bands 0, 1x, 1y, 1z
  tGI1: { value: null },
  tGI2: { value: null },
  tGI3: { value: null },
  uSunExt: { value: [1, 1, 1] }, // sky values that depend only on the sun (gfx/sky.js)
  uSunCol: { value: [1, 1, 1] },
  uSkyUp: { value: [0, 0, 0] },
  uGround: { value: [0, 0, 0] },
  uMatDetail: { value: 1 },
  uBevel: { value: 0.12 },
  uGlints: { value: 0.4 },
};

const sky = { sunExt: null, sunCol: null, skyUp: null, ground: null };
const skySun = { x: NaN, y: NaN, z: NaN };

// sun: unit vector toward the sun.
export function updateGfxUniforms(sim, sun) {
  if (sun.x !== skySun.x || sun.y !== skySun.y || sun.z !== skySun.z) {
    Object.assign(skySun, { x: sun.x, y: sun.y, z: sun.z });
    skyState(sun, sky);
    gfxUniforms.uSunExt.value = sky.sunExt;
    gfxUniforms.uSunCol.value = sky.sunCol;
    gfxUniforms.uSkyUp.value = sky.skyUp;
    gfxUniforms.uGround.value = sky.ground;
  }
  sim.smoothing = gfx.smoothing;
  gfxUniforms.tB.value = sim.stateB;
  gfxUniforms.tFS.value = sim.fieldSurf;
  gfxUniforms.tFM.value = sim.fieldMedia;
  gfxUniforms.tFT.value = sim.fieldThin;
  sim.giTextures.forEach((t, i) => { gfxUniforms[`tGI${i}`].value = t; });
  gfxUniforms.uFrame.value = (gfxUniforms.uFrame.value + 1) % 1048576;
  gfxUniforms.uSimClock.value = sim.frame % SIM_CLOCK_WRAP;
  gfxUniforms.uMatDetail.value = gfx.materials;
  gfxUniforms.uBevel.value = Math.min(Math.max(gfx.bevel, 0), 0.45);
  gfxUniforms.uGlints.value = gfx.glints;
}

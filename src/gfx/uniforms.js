// Graphics settings and the uniforms shared by the render shaders (volume and
// shadow pass). Entry points spread `gfxUniforms` into their materials and
// call `updateGfxUniforms(sim, sun, light)` once per frame before rendering, so new
// graphics features only need to touch this file, not the app wiring.
import { mediaNoiseUniform } from './mediaNoise.js';
import { skyState } from './sky.js';
import { cloudShift } from '../shaders/gfx/clouds.js';
import { LAMP_MAX } from './lamps.js';

// The media detail clock (simulation steps) wraps here, seamlessly for the
// drift speeds allowed in gfx/materials.js (MEDIA rise).
const SIM_CLOCK_WRAP = 1 << 20;
// the frame counter wraps here, before float32 loses whole frames
const FRAME_WRAP = 1 << 20;
// cells: rounder than this and a crisp voxel's bevels would meet
const BEVEL_MAX = 0.45;

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
  tFT: { value: null },
  tBrickDist: { value: null }, // empty-space distance per brick (shaders/passes.js)       // thin-feature mask (cubic liquid)
  uFrame: { value: 0 },       // frame counter (for temporal jitter)
  uPixScale: { value: 1 },    // output pixel in rendered pixels (set by gfx/post.js per render)
  uSimClock: { value: 0 },    // simulation steps (wrapped): media detail drifts with it, frozen when paused
  uClouds: { value: false },      // World's cumulus deck (shaders/gfx/clouds.js): on in a world (world/far.js attach)...
  uCloudShift: { value: [0, 0] }, // ...its wind drift (cells)...
  uCloudSea: { value: 0 },        // ...and the sea level its height counts from (world cells)
  tFlowV: { value: null },    // flow field: how fast matter moves through each cell (Simulation.flowTexture)
  tMediaNoise: mediaNoiseUniform(),   // tileable detail noise for smoke, steam and fire
  tGI0: { value: null },      // GI probe volume (shaders/gi.js): L1 SH bands 0, 1x, 1y, 1z
  tGI1: { value: null },
  tGI2: { value: null },
  tGI3: { value: null },
  uSunExt: { value: [1, 1, 1] }, // sky values that depend only on the sun (gfx/sky.js)
  uSunCol: { value: [1, 1, 1] },
  uSkyUp: { value: [0, 0, 0] },
  uGround: { value: [0, 0, 0] },
  uKeyLight: { value: [1, 1, 1] }, // the key light's colour scale (gfx/daylight.js)
  uMatDetail: { value: 1 },
  uBevel: { value: 0.12 },
  uGlints: { value: 0.4 },
  uNearGI: { value: true },     // lighting upgrades (gfx/lighting.js), switched from Settings → Lighting
  uGlowLights: { value: true },
  uCaustics: { value: true },
  uLampCount: { value: 0 },   // hand lamps (gfx/lamps.js; src/pov/lamps.js sets them)
  uLampPos: { value: new Float32Array(4 * LAMP_MAX) },
  uLampCol: { value: new Float32Array(4 * LAMP_MAX) },
};

const sky = { sunExt: null, sunCol: null, skyUp: null, ground: null };
const skySun = { x: NaN, y: NaN, z: NaN, light: '' };

// sun: unit vector toward the key light (sun or moon); light: its colour scale.
export function updateGfxUniforms(sim, sun, light) {
  if (sun.x !== skySun.x || sun.y !== skySun.y || sun.z !== skySun.z || String(light) !== skySun.light) {
    Object.assign(skySun, { x: sun.x, y: sun.y, z: sun.z, light: String(light) });
    skyState(sun, light, sky);
    gfxUniforms.uKeyLight.value = [...light];
    gfxUniforms.uSunExt.value = sky.sunExt;
    gfxUniforms.uSunCol.value = sky.sunCol;
    gfxUniforms.uSkyUp.value = sky.skyUp;
    gfxUniforms.uGround.value = sky.ground;
  }
  sim.smoothing = gfx.smoothing;
  gfxUniforms.tB.value = sim.stateB;
  gfxUniforms.tFS.value = sim.fieldSurf;
  gfxUniforms.tFlowV.value = sim.flowTexture;
  gfxUniforms.tFM.value = sim.fieldMedia;
  gfxUniforms.tFT.value = sim.fieldThin;
  gfxUniforms.tBrickDist.value = sim.brickDistTexture;
  sim.giTextures.forEach((t, i) => { gfxUniforms[`tGI${i}`].value = t; });
  gfxUniforms.uFrame.value = (gfxUniforms.uFrame.value + 1) % FRAME_WRAP;
  gfxUniforms.uSimClock.value = sim.frame % SIM_CLOCK_WRAP;
  cloudShift(sim.frame, gfxUniforms.uCloudShift.value);
  gfxUniforms.uMatDetail.value = gfx.materials;
  gfxUniforms.uBevel.value = Math.min(Math.max(gfx.bevel, 0), BEVEL_MAX);
  gfxUniforms.uGlints.value = gfx.glints;
}

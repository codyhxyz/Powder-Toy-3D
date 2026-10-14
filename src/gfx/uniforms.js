// Graphics settings and the values every render pass of ours reads
// (docs/webgpu.md F6). gfxUniforms keeps today's shared `{ value }` objects on
// the CPU: lamps, wand lights, the far field and the figures write and read
// them as before. updateGfxUniforms(sim, sun, light) refreshes them once per
// view frame; writeFrameUniforms(gpu, frame) then packs them, with the camera
// and the volume's own values, into FrameUniforms, the one uniform buffer the
// volume, shadow, GI, the sign probe, the far view and the scene overlays bind
// (group 0 binding 1, beside the element tables: frameUniformsOf(gpu).group).
// Write it once per tick that records a reader (B3: post.render's prepare
// hook, or a derived-only tick before its shadow and GI), so every command
// sees the value current when it was recorded.
import { Vector4, Matrix4, Vector3 } from 'three/webgpu';
import { skyState } from './sky.js';
import { cloudShift } from '../shaders/gfx/clouds.js';
import { LAMP_MAX } from './lamps.js';
import { WAND_LIGHTS } from '../shaders/gfx/lighting.js';
import { FRAME_UNIFORM_FIELDS, RENDER_LAYOUT } from '../shaders/bindings.js';
import { tablesBuffer } from '../shaders/common.js';
import { uniformStruct } from '../gpu/params.js';
import { decoShown } from '../deco.js';
import { materialStyleForView } from '../views.js';
export { WAND_LIGHTS };

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

// The values. The textures the WebGL materials took from here are bind
// groups now, made once per grid by their owners (src/derived.js,
// gfx/volume.js).
export const gfxUniforms = {
  uWandLightCount: { value: 0 },
  uWandLightPosition: { value: Array.from({ length: WAND_LIGHTS }, () => new Vector4()) }, // grid xyz, radius
  uWandLightColor: { value: Array.from({ length: WAND_LIGHTS }, () => new Vector4()) }, // linear rgb, intensity
  uFrame: { value: 0 },       // frame counter (for temporal jitter)
  uPixScale: { value: 1 },    // output pixel in rendered pixels (set by gfx/post.js per render)
  uSimClock: { value: 0 },    // simulation steps (wrapped): media detail drifts with it, frozen when paused
  uClouds: { value: false },      // World's cumulus deck (shaders/gfx/clouds.js): on in a world (world/far.js attach)...
  uCloudShift: { value: [0, 0] }, // ...its wind drift (cells)...
  uCloudSea: { value: 0 },        // ...and the sea level its height counts from (world cells)
  uDeco: { value: false },    // TPT's decoration layer (src/deco.js) drawn: painted, display on (Ctrl+B); the volume reads the same each draw (VolumeParams.deco)
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
  uLampShape: { value: new Float32Array(4 * LAMP_MAX) },   // x radius, y length (cells): the light's own size
  uCaveAmbient: { value: [0, 0, 0] },   // the scene's ambient floor (a world scene's `ambient`: Descent's caves), radiance
  uDigMin: { value: [0, 0, 0, 0] },     // the dig tools' aimed bite, drawn on the surface (src/pov/tools/dig.js sets it)
  uDigMax: { value: [0, 0, 0, 0] },
  uBeacon: { value: new Float32Array(4) },     // world xyz, reach in cells
  uBeaconDir: { value: new Float32Array(4) },  // unit direction, night gain
  uBeaconCell: { value: new Float32Array(4) }, // physical CRYSTAL switch, world xyz
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
  gfxUniforms.uFrame.value = (gfxUniforms.uFrame.value + 1) % FRAME_WRAP;
  gfxUniforms.uSimClock.value = sim.frame % SIM_CLOCK_WRAP;
  cloudShift(sim.frame, gfxUniforms.uCloudShift.value);
  gfxUniforms.uMatDetail.value = gfx.materials;
  gfxUniforms.uBevel.value = Math.min(Math.max(gfx.bevel, 0), BEVEL_MAX);
  gfxUniforms.uGlints.value = gfx.glints;
  gfxUniforms.uDeco.value = decoShown(sim);
}

// ---------------------------------------------------------------- FrameUniforms

/** FrameUniforms' struct and packer (the WGSL is shaders/bindings.js's, from the same field list). */
export const FrameUniformsStruct = uniformStruct('FrameUniforms', FRAME_UNIFORM_FIELDS);

/**
 * The device's FrameUniforms (gpu.frameUniforms, a SharedUniforms: a write
 * flushes first when the open frame already reads it, B3) and the render
 * kernels' group 0 (RENDER_LAYOUT.FRAME: the element tables and FrameUniforms),
 * made once. `last` holds the latest write's camera and volume matrices,
 * which the volume's mesh cut and the brush read, so they agree with what
 * FrameUniforms holds.
 * @param {object} gpu
 * @returns {{ uniforms: object, layout: GPUBindGroupLayout, group: GPUBindGroup, tables: GPUBuffer,
 *   last: { viewProj: Matrix4, invViewProj: Matrix4, model: Matrix4, eye: Vector3, written: boolean } }}
 */
export function frameUniformsOf(gpu) {
  if (!gpu._frameUniforms) {
    const uniforms = (gpu.frameUniforms ??= gpu.uniforms(FrameUniformsStruct, 'FrameUniforms'));
    const tables = tablesOf(gpu);
    const layout = gpu.layout('FRAME', RENDER_LAYOUT.FRAME);
    const group = gpu.bindGroup(layout, [
      { binding: 0, resource: { buffer: tables } }, { binding: 1, resource: { buffer: uniforms.buffer } },
    ], 'frame');
    const last = { viewProj: new Matrix4(), invViewProj: new Matrix4(), model: new Matrix4(), eye: new Vector3(), written: false };
    gpu._frameUniforms = { uniforms, layout, group, tables, last };
  }
  return gpu._frameUniforms;
}

// The element tables' buffer: the simulation's when it has made one (src/sim.js), else our own.
function tablesOf(gpu) {
  if (gpu._simTables) return gpu._simTables.buffer;
  if (!gpu._renderTables) {
    const bytes = tablesBuffer();
    gpu._renderTables = gpu.createBuffer({ label: 'tables (render)', size: Math.ceil(bytes.byteLength / 16) * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    gpu.queue.writeBuffer(gpu._renderTables, 0, bytes);
  }
  return gpu._renderTables;
}

// a Float32Array of LAMP_MAX vec4s as the packer's array of vectors
const vec4s = (a) => Array.from({ length: LAMP_MAX }, (_, i) => a.subarray(4 * i, 4 * i + 4));
const toGrid = new Matrix4();

/**
 * Writes FrameUniforms for this tick: gfxUniforms' values, the camera's and
 * the volume's. The camera is the one post jittered for the frame (its
 * projectionMatrix holds the jitter, F4), or the unjittered one on a
 * derived-only tick.
 * @param {object} gpu
 * @param {{ camera: object, model: object, sun: object, view?: number, shadowRes?: number, time?: number,
 *   lightGain?: number, shadows?: boolean, far?: boolean, sea?: number, jitter?: number[] }} frame
 *   model: the volume's matrixWorld (grid cells → scene); sun: unit vector toward
 *   the key light; view: src/views.js id; shadowRes: the shadow map's texels per
 *   side (gfx/volume.js); time: the animation clock (uTime: it runs with the
 *   simulation); lightGain: the glow's gain (uLightGain); far: a world's far
 *   field is drawn; sea: its sea level; jitter: post.jitter
 */
export function writeFrameUniforms(gpu, { camera, model, sun, view = 0, shadowRes = 1, time = 0, lightGain = 1, shadows = true, far = false, sea = 0, jitter = [0, 0] }) {
  const { uniforms, last } = frameUniformsOf(gpu);
  camera.updateMatrixWorld();
  last.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  last.invViewProj.copy(last.viewProj).invert();
  last.model.copy(model);
  last.eye.setFromMatrixPosition(camera.matrixWorld);
  last.written = true;
  const cam = last.eye.clone().applyMatrix4(toGrid.copy(model).invert());   // the eye in grid cells (uCam)
  const u = gfxUniforms;
  uniforms.write({
    viewProj: last.viewProj, invViewProj: last.invViewProj, model: last.model,
    lampPos: vec4s(u.uLampPos.value), lampCol: vec4s(u.uLampCol.value), lampShape: vec4s(u.uLampShape.value),
    wandLightPosition: u.uWandLightPosition.value, wandLightColor: u.uWandLightColor.value,
    cam, time, sun, lightGain,
    sunExt: u.uSunExt.value, simClock: u.uSimClock.value, sunCol: u.uSunCol.value, pixScale: u.uPixScale.value,
    skyUp: u.uSkyUp.value, cloudSea: u.uCloudSea.value, ground: u.uGround.value, sea,
    keyLight: u.uKeyLight.value, matDetail: u.uMatDetail.value, materialStyle: materialStyleForView(view) ?? 0, jitter, cloudShift: u.uCloudShift.value,
    bevel: u.uBevel.value, glints: u.uGlints.value, view, frame: u.uFrame.value, shadowRes,
    lampCount: u.uLampCount.value, wandLightCount: u.uWandLightCount.value,
    beacon: u.uBeacon.value, beaconDir: u.uBeaconDir.value, beaconCell: u.uBeaconCell.value,
    shadows: !!shadows, nearGI: !!u.uNearGI.value, glowLights: !!u.uGlowLights.value, caustics: !!u.uCaustics.value,
    clouds: !!u.uClouds.value, far: !!far, caveAmbient: u.uCaveAmbient.value, digMin: u.uDigMin.value, digMax: u.uDigMax.value,
  });
}

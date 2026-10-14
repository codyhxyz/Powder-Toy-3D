// The render library's shared bindings (docs/webgpu.md F6): every declaration
// two render modules share lives here, so no two declare the same binding and
// the numbers can't disagree. The volume, the shadow kernel, GI gather and
// source, the sign probe and the far view bind these.
//   FrameUniforms  group 0 binding 1 (L.FRAME, beside the element tables at
//                  binding 0): everything today's render code read as shared
//                  uniforms, written once per tick that records a reader
//                  (B3), from gfx/uniforms.js gfxUniforms and the camera
//   L.LIGHTING     group 2 of render kernels: fields, light, GI, shadow, noise,
//                  the far field, samplers, the brick map, flow, aeration;
//                  and its writer variants, same numbers (_SHADOW, _GI, _GISRC)
//   BrickInfo      the brick map's record and its decoders
// Later units only append to these (fields, bindings), never reorder or rename
// them, and say so in their hand-back (docs/webgpu.md J3).
import { LAMP_MAX } from '../gfx/lamps.js';
import { hostStruct } from './hostStruct.js';
import { STAGE } from './common.js';

// Wand lights at once (pov/wands: gfx/uniforms.js uWandLightPosition). The
// count lives here, beside the uniform arrays it sizes; shaders/gfx/lighting.js
// re-exports it.
export const WAND_LIGHTS = 8;
export { LAMP_MAX };

// ---------------------------------------------------------------- FrameUniforms
// [name, WGSL type, where the value comes from]: a gfxUniforms key (gfx/uniforms.js),
// or the volume material's own uniform it replaces (app.js: uCam, uView,
// uShadows, uTime, uLightGain, uShadowRes, uFar, uSun), or the camera. Bools
// are u32 (1 or 0, docs/webgpu.md H1.15). The order is the packing: matrices,
// arrays, then each vec3 with a scalar after it.
export const FRAME_UNIFORMS = [
  ['viewProj', 'mat4x4f', 'camera: projection (jittered, F4) · view'],
  ['invViewProj', 'mat4x4f', 'camera: inverse(viewProj)'],
  ['model', 'mat4x4f', 'the volume: grid cells → world (render.js modelMatrix)'],
  ['lampPos', `array<vec4f, ${LAMP_MAX}>`, 'uLampPos'],
  ['lampCol', `array<vec4f, ${LAMP_MAX}>`, 'uLampCol'],
  ['lampShape', `array<vec4f, ${LAMP_MAX}>`, 'uLampShape'],
  ['wandLightPosition', `array<vec4f, ${WAND_LIGHTS}>`, 'uWandLightPosition'],
  ['wandLightColor', `array<vec4f, ${WAND_LIGHTS}>`, 'uWandLightColor'],
  ['cam', 'vec3f', 'uCam (the eye in grid cells)'],
  ['time', 'f32', 'uTime'],
  ['sun', 'vec3f', 'uSun'],
  ['lightGain', 'f32', 'uLightGain'],
  ['sunExt', 'vec3f', 'uSunExt'],
  ['simClock', 'f32', 'uSimClock'],
  ['sunCol', 'vec3f', 'uSunCol'],
  ['pixScale', 'f32', 'uPixScale'],
  ['skyUp', 'vec3f', 'uSkyUp'],
  ['cloudSea', 'f32', 'uCloudSea'],
  ['ground', 'vec3f', 'uGround'],
  ['sea', 'f32', 'uSea (the far field\'s sea level: shaders/far.js)'],
  ['keyLight', 'vec3f', 'uKeyLight'],
  ['matDetail', 'f32', 'uMatDetail'],
  ['jitter', 'vec2f', 'post: the TAA jitter, pixels, y down (F4)'],
  ['cloudShift', 'vec2f', 'uCloudShift'],
  ['bevel', 'f32', 'uBevel'],
  ['glints', 'f32', 'uGlints'],
  ['view', 'i32', 'uView'],
  ['frame', 'i32', 'uFrame'],
  ['shadowRes', 'i32', 'uShadowRes'],
  ['lampCount', 'i32', 'uLampCount'],
  ['wandLightCount', 'i32', 'uWandLightCount'],
  ['shadows', 'u32', 'uShadows (bool)'],
  ['nearGI', 'u32', 'uNearGI (bool)'],
  ['glowLights', 'u32', 'uGlowLights (bool)'],
  ['caustics', 'u32', 'uCaustics (bool)'],
  ['clouds', 'u32', 'uClouds (bool)'],
  ['far', 'u32', 'uFar (bool): a world\'s far field is drawn (box and world share pipelines, E)'],
  // appended (F6) at Sync 3: a world scene's ambient floor (Descent's caves), in giIrradiance and giRadiance
  ['caveAmbient', 'vec3f', 'uCaveAmbient'],
  // the dig tools' aimed bite (pov/tools/dig.js), drawn on the surface itself (surface.js digMark)
  ['digMin', 'vec4f', 'uDigMin: its min corner, grid cells; w: share of the blows it needs that have landed (cracks)'],
  ['digMax', 'vec4f', 'uDigMax: its max corner; w: 1 + the aimed face\'s axis, 0: none shown'],
];
// { name: type }, the field list src/gpu/params.js uniformStruct takes.
export const FRAME_UNIFORM_FIELDS = Object.fromEntries(FRAME_UNIFORMS.map(([n, t]) => [n, t]));
// The struct, WGSL and packer (uniform address space). The WGSL is what
// uniformStruct('FrameUniforms', FRAME_UNIFORM_FIELDS) emits; gfx/uniforms.js
// packs with either.
export const FrameUniforms = hostStruct('FrameUniforms', FRAME_UNIFORM_FIELDS, { space: 'uniform' });

// WGSL of group 0 binding 1 (L.FRAME): the struct, its binding as FU, and the
// sizes of its arrays. After the prelude (which binds the tables at binding 0).
export const frameBindings = () => /* wgsl */ `
const LAMP_MAX: i32 = ${LAMP_MAX};
const WAND_LIGHTS: i32 = ${WAND_LIGHTS};
${FrameUniforms.wgsl}
@group(0) @binding(1) var<uniform> FU: FrameUniforms;`;

// ---------------------------------------------------------------- the brick map
// What a brick holds (the brick kernel writes it, shaders/passes.js; the
// volume, shadow, GI, light and signs read it): emission (rgb, light blur pass
// 0 reads it as a vec4f's .rgb, H2) and an info word:
//   bits 0-4   BRICK_MEDIA, _SURF, _OPAQUE, _THIN, _MIXED (passes.js BRICK_BITS)
//   bits 5-7   air flags AIR_HOT, _PRESSURE, _FLOW (passes.js AIR_FLAGS): air
//              worth showing in the heat, pressure and flow views
//   bits 8-14  the brick's steam and smoke cells, 0-64
//   bit 15     BRICK_MATTER: the brick holds matter
// Matter bricks set bit 15; air-only bricks only bits 5-7; empty bricks are 0.
export const BRICK_INFO = { MEDIA: 1, SURF: 2, OPAQUE: 4, THIN: 8, MIXED: 16, AIR_SHIFT: 5, GAS_SHIFT: 8, MATTER: 1 << 15 };
export const AIR = { HOT: 1, PRESSURE: 2, FLOW: 4 };
export const BRICK_GAS_DIV = 64;   // cells per brick: gas share = count / this
// JS twins, for tools and the brick kernel's tests (bits: the BRICK_* sum, air: the AIR sum).
export const packBrickInfo = ({ bits = 0, air = 0, gas = 0, matter = false }) =>
  (bits | (air << BRICK_INFO.AIR_SHIFT) | (gas << BRICK_INFO.GAS_SHIFT) | (matter ? BRICK_INFO.MATTER : 0)) >>> 0;
export const unpackBrickInfo = (info) => ({
  bits: info & 31, air: (info >>> BRICK_INFO.AIR_SHIFT) & 7, gas: (info >>> BRICK_INFO.GAS_SHIFT) & 127,
  matter: (info & BRICK_INFO.MATTER) !== 0,
});
export const BrickInfo = hostStruct('BrickInfo', { emit: 'vec3f', info: 'u32' });

// The record, its bit constants and its decoders. lightingBindings includes
// it; a kernel that writes the map without the lighting group includes it alone.
export const brickInfoWGSL = /* wgsl */ `
${BrickInfo.wgsl}
const BRICK_MEDIA: u32 = ${BRICK_INFO.MEDIA}u;
const BRICK_SURF: u32 = ${BRICK_INFO.SURF}u;
const BRICK_OPAQUE: u32 = ${BRICK_INFO.OPAQUE}u;
const BRICK_THIN: u32 = ${BRICK_INFO.THIN}u;
const BRICK_MIXED: u32 = ${BRICK_INFO.MIXED}u;
const AIR_HOT: u32 = ${AIR.HOT}u;
const AIR_PRESSURE: u32 = ${AIR.PRESSURE}u;
const AIR_FLOW: u32 = ${AIR.FLOW}u;
const BRICK_AIR_SHIFT: u32 = ${BRICK_INFO.AIR_SHIFT}u;
const BRICK_GAS_SHIFT: u32 = ${BRICK_INFO.GAS_SHIFT}u;
const BRICK_MATTER: u32 = ${BRICK_INFO.MATTER}u;
const BRICK_GAS_DIV: f32 = ${BRICK_GAS_DIV.toFixed(1)};   // gas share = steam/smoke cells / cells per brick
// an info word from its parts (bits: BRICK_* sum, air: AIR_* sum, gas: steam/smoke cells)
fn brickInfoWord(bits: u32, air: u32, gas: u32, matter: bool) -> u32 {
  return bits | (air << BRICK_AIR_SHIFT) | (gas << BRICK_GAS_SHIFT) | select(0u, BRICK_MATTER, matter);
}
fn brickBits(info: u32) -> u32 { return info & 31u; }
fn brickAir(info: u32) -> u32 { return (info >> BRICK_AIR_SHIFT) & 7u; }
// how much of the brick is steam or smoke: exactly the old gas / BRICK_GAS_DIV
fn brickGas(info: u32) -> f32 { return f32((info >> BRICK_GAS_SHIFT) & 127u) / BRICK_GAS_DIV; }
fn brickMatter(info: u32) -> bool { return (info & BRICK_MATTER) != 0u; }`;

// ---------------------------------------------------------------- L.LIGHTING
// Group 2 of every render kernel. Each binding: [number, WGSL name, WGSL type,
// layout entry body]. A resource a pipeline lacks (box mode's far textures,
// aeration with Whitewater off) is bound to a dummy (a 1×1(×1) texture, a
// 16-byte buffer), never left out, so one layout serves every pipeline.
const float3d = { texture: { sampleType: 'float', viewDimension: '3d' } };
const float2d = { texture: { sampleType: 'float', viewDimension: '2d' } };
const unfilterable2d = { texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } };
const readBuffer = { buffer: { type: 'read-only-storage' } };
const LIGHTING_BINDINGS = [
  [0, 'tFS', 'texture_3d<f32>', float3d],          // fieldSurf: smooth-surface fields (liquid, molten, granular, organic)
  [1, 'tFM', 'texture_3d<f32>', float3d],          // fieldMedia: media fields (smoke, steam, fire, heat)
  [2, 'tFT', 'texture_3d<f32>', float3d],          // fieldThin: thin-feature mask (x: liquid)
  [3, 'tLight', 'texture_3d<f32>', float3d],       // light: the glow volume, per brick
  [4, 'tGI0', 'texture_3d<f32>', float3d],         // gi0..gi3: GI probes, L1 SH bands 0, 1x, 1y, 1z
  [5, 'tGI1', 'texture_3d<f32>', float3d],
  [6, 'tGI2', 'texture_3d<f32>', float3d],
  [7, 'tGI3', 'texture_3d<f32>', float3d],
  [8, 'tShadow', 'texture_2d<f32>', unfilterable2d],    // shadow: the sun's map, rgba32float (textureLoad only)
  [9, 'tShadowX', 'texture_2d<f32>', unfilterable2d],   // shadowX: its .x as r32float, for PCSS's 16 taps (E)
  [10, 'tMediaNoise', 'texture_3d<f32>', float3d],      // mediaNoise: 64³ rgba8unorm detail noise (gfx/mediaNoise.js)
  [11, 'tFarGrid', 'texture_3d<u32>', { texture: { sampleType: 'uint', viewDimension: '3d' } }],   // farGrid: rgba16uint (G1)
  [12, 'tFarTop', 'texture_2d<f32>', float2d],          // farTop: column tops
  [13, 'tFarShadow', 'texture_2d<f32>', float2d],       // farShadow: shadow heights
  [14, 'linearClamp', 'sampler', { sampler: { type: 'filtering' } }],
  [15, 'linearRepeat', 'sampler', { sampler: { type: 'filtering' } }],
  [16, 'brick', 'array<BrickInfo>', readBuffer],        // the brick map, brickId order
  [17, 'brickDist', 'array<u32>', readBuffer],          // empty-space distance + 1 per brick (brickDistAt), then the occupancy (shaders/occupancy.js)
  [18, 'flow', 'array<vec2u>', readBuffer],             // flow, per slot: 3 × f16 + 0 (pack2x16float)
  [19, 'aeration', 'array<vec2u>', readBuffer],         // whitewater's aeration, both copies (G4)
];
const FAR_BINDINGS = new Set([11, 12, 13]);
const storageTex = (format, viewDimension) => ({ storageTexture: { access: 'write-only', format, viewDimension } });
// The writer variants (docs/webgpu.md F6): the same numbers with the bindings
// the kernel writes as storage. A texture is never sampled and storage-written
// in one dispatch.
const VARIANTS = {
  // the volume (fragment) and the read-only probes (compute)
  LIGHTING: { stages: STAGE.FRAGMENT | STAGE.COMPUTE, swap: {} },
  // the shadow kernel: the map and its .x copy, written in one dispatch
  LIGHTING_SHADOW: { stages: STAGE.COMPUTE, swap: {
    8: ['texture_storage_2d<rgba32float, write>', storageTex('rgba32float', '2d')],
    9: ['texture_storage_2d<r32float, write>', storageTex('r32float', '2d')],
  } },
  // GI gather: the four bands stored as textures; flow and aeration dropped;
  // giSrc (giSource's output) and the probe history (4 bands, f16 packed) as buffers
  LIGHTING_GI: { stages: STAGE.COMPUTE, drop: [18, 19], swap: {
    4: ['texture_storage_3d<rgba16float, write>', storageTex('rgba16float', '3d')],
    5: ['texture_storage_3d<rgba16float, write>', storageTex('rgba16float', '3d')],
    6: ['texture_storage_3d<rgba16float, write>', storageTex('rgba16float', '3d')],
    7: ['texture_storage_3d<rgba16float, write>', storageTex('rgba16float', '3d')],
  }, add: [
    [20, 'giSrc', 'array<vec4u>', readBuffer],
    [21, 'giHist', 'array<vec2u>', { buffer: { type: 'storage' } }],
  ] },
  // GI source: everything LIGHTING has, and its output giSrc
  LIGHTING_GISRC: { stages: STAGE.COMPUTE, add: [[20, 'giSrc', 'array<vec4u>', { buffer: { type: 'storage' } }]] },
};
function variantBindings(variant) {
  const v = VARIANTS[variant];
  if (!v) throw new Error(`lightingBindings: no variant ${variant}`);
  return [
    ...LIGHTING_BINDINGS.filter(([n]) => !v.drop?.includes(n)).map(([n, name, type, body]) =>
      (v.swap?.[n] ? [n, name, v.swap[n][0], v.swap[n][1]] : [n, name, type, body])),
    ...(v.add ?? []),
  ];
}
const writable = (body) => body.storageTexture || body.buffer?.type === 'storage';

// The layout entries (GPUBindGroupLayoutEntry) of each render group, for
// gpu.layout(name, entries) (docs/webgpu.md B1, C4). FRAME: group 0 of render
// kernels, the element tables and FrameUniforms.
export const RENDER_LAYOUT = {
  FRAME: [
    { binding: 0, visibility: STAGE.FRAGMENT | STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: STAGE.VERTEX | STAGE.FRAGMENT | STAGE.COMPUTE, buffer: { type: 'uniform' } },
  ],
  ...Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, variantBindings(k).map(([binding, , , body]) => ({
    binding, visibility: writable(body) ? STAGE.COMPUTE : VARIANTS[k].stages, ...body,
  }))])),
};

const declare = ([n, name, type, body]) => (type === 'sampler'
  ? `@group(2) @binding(${n}) var ${name}: sampler;`
  : body.buffer
    ? `@group(2) @binding(${n}) var<storage, ${body.buffer.type === 'storage' ? 'read_write' : 'read'}> ${name}: ${type};`
    : `@group(2) @binding(${n}) var ${name}: ${type};`);

/**
 * WGSL declarations of group 2 for a render kernel (after the prelude and
 * frameBindings()). The layout always has every binding of the variant; a
 * module may declare fewer:
 *   far       the far field's textures (11-13); false where nothing reads them
 *   aeration  the aeration buffer (19); false where nothing reads it
 *   variant   'LIGHTING' | 'LIGHTING_SHADOW' | 'LIGHTING_GI' | 'LIGHTING_GISRC'
 * With the brick map come its record, decoders and brickAt/brickDistAt.
 */
export function lightingBindings({ far = true, aeration = true, variant = 'LIGHTING' } = {}) {
  const list = variantBindings(variant).filter(([n]) => (far || !FAR_BINDINGS.has(n)) && (aeration || n !== 19));
  return /* wgsl */ `
${brickInfoWGSL}
${list.map(declare).join('\n')}
// brick b's record, and its empty-space distance in bricks (the stored value
// less one, as gfx/core.js decoded today's 8-bit channel; -1: none stored)
fn brickAt(b: vec3i) -> BrickInfo { return brick[brickId(b)]; }
fn brickDistAt(b: vec3i) -> i32 { return i32(brickDist[brickId(b)]) - 1; }`;
}

// Which bindings each variant declares, for tools (check-wgsl's layout match).
export const lightingVariant = (variant) => variantBindings(variant).map(([binding, name, type]) => ({ binding, name, type }));

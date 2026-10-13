// Drawing the decoration layer (src/deco.js, shaders/deco.js): The Powder
// Toy's deco colour over a cell's own. TPT blends it into the particle's
// colour by its alpha, `col = (deca*decr + (256-deca)*col) >> 8`
// (src/graphics/Renderer.cpp), and leaves fire's glow to the fire. Here:
//   - a surface's albedo (crisp voxels, grains, and the smooth channels:
//     powders, lava, organics) goes to the deco colour by its alpha. The
//     material's own light-dark texture stays, scaled by how bright the
//     texture is there against the element's mean albedo, so painted sand still
//     shows its grains; a painted metal turns into a painted (dielectric) coat;
//   - a liquid's or glass's interior scatters the deco colour and grows opaque
//     by its alpha (DECO_SIGMA), so painted water reads as paint, not dye;
//   - emission is left alone: hot matter glows through its paint.
// The blend is in linear light (TPT's is on sRGB bytes; the two agree at
// alpha 0 and 1). P.deco off (Ctrl+B, or nothing decorated) reads as no deco.
// The smooth channels take the colour of the cell the surface's material
// comes from (Surf.cell), so paint edges there follow cells.
//
// WGSL (docs/webgpu.md W2; the names are the GLSL version's). The view reads
// the paint straight from the decoration's plane, the u32 per cell the move
// carries (src/sim.js decoPlane: RGBA8, r in the low byte, in slot order),
// bound at the volume's group 0 binding 3 (DECO_PLANE_ENTRY, beside the
// tables, FrameUniforms and the meshes' depth: shaders/render.js
// VOLUME_LAYOUTS). The WebGL view had no texture unit left for it and read a
// copy of the flow field with the paint packed into its spare w, 6 bits a
// channel; a storage buffer takes no texture unit (the volume's eight storage
// buffers: tables, the plane, A, B, bricks, brickDist, flow, aeration), so the
// view reads all 8 bits. The switch is the volume's own param
// (VolumeParams.deco: gfx/volume.js sets it from src/deco.js decoShown), so
// turning it on or off builds nothing.
import { STAGE } from '../../gpu/kernels.js';

// Optical depth per cell of fully painted liquid or glass: a cell of it lets
// e^-DECO_SIGMA (14%) through.
const DECO_SIGMA = 2.0;
// Ceiling on how much brighter than the element's mean a textured point may
// make its paint (the texture's highlights), and the luminance below which
// a mean counts as black.
const DECO_DETAIL_MAX = 2.0;
const DECO_LUM_MIN = 1e-3;

/** The volume's group 0 binding of the decoration plane, and its layout entry. */
export const DECO_PLANE_BINDING = 3;
export const DECO_PLANE_ENTRY = { binding: DECO_PLANE_BINDING, visibility: STAGE.FRAGMENT, buffer: { type: 'read-only-storage' } };

// WEBGPU-STUB (docs/webgpu.md J3): the view reads the plane's 8 bits a
// channel; nothing packs the paint into the flow field any more.
export const DECO_PACK_LEVELS = null;
// WEBGPU-STUB (docs/webgpu.md J3)
export const decoPackGLSL = '';

// The binding, the lookups and the albedo tint (plain.js and the realistic
// tracer call them). Needs the render library (slotOf, outside) and the
// volume's params P (shaders/render.js VolumeParams: deco).
export const decoViewGLSL = /* wgsl */ `
@group(0) @binding(${DECO_PLANE_BINDING}) var<storage, read> decoPlane: array<u32>;   // RGBA8 per slot (src/deco.js)
const DECO_SIGMA: f32 = ${DECO_SIGMA.toFixed(1)};
const DECO_DETAIL_MAX: f32 = ${DECO_DETAIL_MAX.toFixed(1)};
const DECO_LUM_MIN: f32 = ${DECO_LUM_MIN};
const DECO_LUM: vec3f = vec3f(0.2126, 0.7152, 0.0722);   // Rec. 709 luminance weights
// cell c's paint (sRGB colour and alpha, 0..1): none outside the grid or while P.deco is off
fn decoAt(c: vec3i) -> vec4f {
  if (P.deco == 0u || outside(c)) { return vec4f(0.0); }
  return unpack4x8unorm(decoPlane[slotOf(c)]);
}
fn decoLinear(c: vec3f) -> vec3f { return select(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), c >= vec3f(0.04045)); }
// albedo alb of an element whose mean albedo is base, painted with d
fn decoTint(alb: vec3f, base: vec3f, d: vec4f) -> vec3f {
  if (d.a <= 0.0) { return alb; }
  let detail = clamp(dot(alb, DECO_LUM) / max(dot(base, DECO_LUM), DECO_LUM_MIN), 0.0, DECO_DETAIL_MAX);
  return mix(alb, decoLinear(d.rgb) * detail, d.a);
}
`;

// The realistic view's hooks (with surfaceGLSL's Surf and liquidGLSL's
// interiorLight).
export const decoSurfGLSL = /* wgsl */ `
// a surface record painted with its cell's decoration (render.js, before shadeSurf)
fn decoSurf(s: ptr<function, Surf>) {
  let d = decoAt((*s).cell);
  if (d.a <= 0.0) { return; }
  (*s).albedo = decoTint((*s).albedo, ALBEDO((*s).id), d);
  (*s).metal *= 1.0 - d.a;
}
// liquid.js absorbSegment through cell c of element id, painted with c's decoration
fn absorbDeco(id: i32, c: vec3i, p: vec3f, seg: f32, sunVis: vec3f, T: f32, col: ptr<function, vec3f>, trans: ptr<function, vec3f>) {
  let d = decoAt(c);
  let att = exp(-mix(SIGMA(id), vec3f(DECO_SIGMA), d.a) * seg);
  let alb = mix(SCATALB(id), decoLinear(d.rgb), d.a);
  *col += *trans * (1.0 - att) * (alb * interiorLight(p, sunVis) + emission(id, T));
  *trans *= att;
}
`;

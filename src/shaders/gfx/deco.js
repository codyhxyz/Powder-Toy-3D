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
// alpha 0 and 1). uDeco off (Ctrl+B, or nothing decorated) reads as no deco.
// The smooth channels take the colour of the cell the surface's material
// comes from (Surf.cell), so paint edges there follow cells.

// Optical depth per cell of fully painted liquid or glass: a cell of it lets
// e^-DECO_SIGMA (14%) through.
const DECO_SIGMA = 2.0;
// Ceiling on how much brighter than the element's mean a textured point may
// make its paint (the texture's highlights), and the luminance below which
// a mean counts as black.
const DECO_DETAIL_MAX = 2.0;
const DECO_LUM_MIN = 1e-3;

// Uniforms, lookups and the albedo tint: before surfaceGLSL and plainGLSL.
export const decoViewGLSL = /* glsl */ `
uniform bool uDeco;          // draw the decoration (display on, and something is decorated)
uniform sampler2D tDeco;     // per cell: sRGB colour and alpha (src/deco.js), laid out like the state
#define DECO_SIGMA ${DECO_SIGMA.toFixed(1)}
#define DECO_DETAIL_MAX ${DECO_DETAIL_MAX.toFixed(1)}
#define DECO_LUM_MIN ${DECO_LUM_MIN}
const vec3 DECO_LUM = vec3(0.2126, 0.7152, 0.0722);   // Rec. 709 luminance weights
vec4 decoAt(ivec3 c) { return uDeco && !outside(c) ? texelFetch(tDeco, atlas(c), 0) : vec4(0.0); }
vec3 decoLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
// albedo alb of an element whose mean albedo is base, painted with d
vec3 decoTint(vec3 alb, vec3 base, vec4 d) {
  if (d.a <= 0.0) return alb;
  float detail = clamp(dot(alb, DECO_LUM) / max(dot(base, DECO_LUM), DECO_LUM_MIN), 0.0, DECO_DETAIL_MAX);
  return mix(alb, decoLinear(d.rgb) * detail, d.a);
}
`;

// The realistic view's hooks: after surfaceGLSL and liquidGLSL.
export const decoSurfGLSL = /* glsl */ `
// a surface record painted with its cell's decoration (render.js, before shadeSurf)
void decoSurf(inout Surf s) {
  vec4 d = decoAt(s.cell);
  if (d.a <= 0.0) return;
  s.albedo = decoTint(s.albedo, ALBEDO[s.id], d);
  s.metal *= 1.0 - d.a;
}
// liquid.js absorbSegment through cell c of element id, painted with c's decoration
void absorbDeco(int id, ivec3 c, vec3 p, float seg, vec3 sunVis, float T, inout vec3 col, inout vec3 trans) {
  vec4 d = decoAt(c);
  vec3 att = exp(-mix(SIGMA[id], vec3(DECO_SIGMA), d.a) * seg);
  vec3 alb = mix(SCATALB[id], decoLinear(d.rgb), d.a);
  col += trans * (1.0 - att) * (alb * interiorLight(p, sunVis) + emission(id, T));
  trans *= att;
}
`;

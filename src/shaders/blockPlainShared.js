// Plain's original voxel shading; explicit leaves keep BOX emissions unchanged.
import { SKY } from '../gfx/sky.js';

// Original native target operations, shared by BOX faces and WORLD raw rays.
export const BLOCK_PLAIN_ABSORB = { color: { srcFactor: 'zero', dstFactor: 'src' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
export const BLOCK_PLAIN_ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };

export const blockClassesWGSL = /* wgsl */ `
const CL_NONE: u32 = 0u;
const CL_OPAQUE: u32 = 1u;
const CL_LIQUID: u32 = 2u;
const CL_GLASS: u32 = 3u;
const CL_GAS: u32 = 4u;
const CL_FIRE: u32 = 5u;
fn classOf(id: i32) -> u32 {
  if (id == E_EMPTY) { return CL_NONE; }
  let r = RCLASS(id);
  if (r == R_OPAQUE) { return CL_OPAQUE; }
  if (r == R_LIQUID) { return CL_LIQUID; }
  if (r == R_GLASS) { return CL_GLASS; }
  if (r == R_GAS) { return CL_GAS; }
  if (r == R_FIRE) { return CL_FIRE; }
  return CL_NONE;
}`;

export const blockVisibilityWGSL = /* wgsl */ `// Whether a cell of class me shows its side to a neighbour of class nb.
fn shows(me: u32, nb: u32) -> bool {
  switch me {
    case 1u: { return nb != CL_OPAQUE; }
    case 2u: { return nb == CL_NONE || nb == CL_GAS || nb == CL_FIRE || nb == CL_GLASS; }
    case 3u: { return nb != CL_OPAQUE && nb != CL_GLASS; }
    case 4u: { return nb == CL_NONE; }
    case 5u: { return nb == CL_NONE || nb == CL_GAS; }
    default: { return false; }
  }
}
// A vertex's AO level from its two edge neighbours and its corner neighbour
// (0: boxed in, 3: open), Lysenko 2013: both edges closed close the corner.
fn cornerAO(s1: u32, s2: u32, c: u32) -> u32 {
  if (s1 == 1u && s2 == 1u) { return 0u; }
  return 3u - s1 - s2 - c;
}`;

export const blockFaceMetadataWGSL = /* wgsl */ `      let tint = u32(clamp(fract(a.w), 0.0, 0.999) * 256.0);
      let ctype = floor(a.w);
      var glow = 0u;
      if (sparkLive(id, ctype)) { glow = 1u; }
      if (id == E_LAMP && sparkLevel(ctype) > 0) { glow = 2u; }
      let head = (u32(id) << 3u) | (tint << 19u) | (glow << 27u);`;

export const blockFaceAOWGSL = /* wgsl */ `          // the face's plane is in q; its corners' neighbours are q's in that plane
          var eu = vec3i(0);
          eu[(axis + 1u) % 3u] = 1;
          var ev = vec3i(0);
          ev[(axis + 2u) % 3u] = 1;
          let u0 = occ(q - eu);
          let u1 = occ(q + eu);
          let v0 = occ(q - ev);
          let v1 = occ(q + ev);
          ao = cornerAO(u0, v0, occ(q - eu - ev)) | (cornerAO(u1, v0, occ(q + eu - ev)) << 2u)
             | (cornerAO(u0, v1, occ(q - eu + ev)) << 4u) | (cornerAO(u1, v1, occ(q + eu + ev)) << 6u);`;

export const blockLookConstantsWGSL = /* wgsl */ `const BK_AO_FLOOR: f32 = 0.35;           // brightness at a fully boxed-in corner (AO level 0 of 3)
const BK_SUN_AO: f32 = 0.5;              // share of the AO the sun's light takes (the rest: the sky's alone)
const BK_HOT_FROM: f32 = 350.0;          // °C: hot surfaces lose reflected light from here ...
const BK_HOT_TO: f32 = 1000.0;           // ... to here, where their glow takes over (the old ray-marched plain view's)
const BK_HOT_ALBEDO: f32 = 0.2;
const BK_LAVA_ALB: vec3f = vec3f(0.05, 0.03, 0.02);   // lava's crust, lit mostly by its own glow (the old plain view's)
const BK_ALPHA_LIQUID: f32 = 0.6;        // TPT's liquids read as coloured, see-through sheets: coverage ...
const BK_LIQUID_TINT: f32 = 0.45;        // ... their hue's hold on what shows through, per crossing ...
const BK_LIQUID_DIM: f32 = 0.15;         // ... the light a crossing loses besides ...
const BK_LIQUID_SCATTER: f32 = 0.35;     // ... and the share of their lit colour they add
const BK_GLASS_TINT: f32 = 0.15;
const BK_ALPHA_GLASS: f32 = 0.22;
const BK_ALPHA_SMOKE: f32 = 0.55;
const BK_ALPHA_STEAM: f32 = 0.3;
const BK_ALPHA_GAS: f32 = 0.12;          // the clear gases (hydrogen, CO2, ...): a faint hint
const BK_FIRE_MIN_T: f32 = 900.0;        // °C: a flame glows at least as this hot
const BK_FIRE_GAIN: f32 = 1.5;
const BK_FIRE_ALPHA: f32 = 0.25;
const BK_FLOOR_GRID: f32 = 8.0;          // cells per floor square
const BK_FLOOR_LINE: f32 = 0.7;          // the floor's lines: its brightness times this
// Gases are soft (the old plain view's soft blobs, Noita's smoke): no face
// shade or n·l, so a cloud's cube faces don't read as a box's, and their
// coverage thins toward each face's rim and with a slow-drifting noise
const BK_GAS_SUN: f32 = 0.5;             // the sun's share on a gas (scattered every way, shadowed)
const BK_GAS_RIM: f32 = 0.35;            // coverage left at a face's corners (1 at its middle)
const BK_GAS_NOISE: f32 = 0.6;           // the noise's hold on the coverage ...
const BK_GAS_NOISE_SCALE: f32 = 0.45;    // ... its features per cell ...
const BK_GAS_DRIFT: f32 = 0.3;           // ... and how fast it drifts upward (cells per second)
const BK_SHADOW_NORMAL: f32 = 1.5;       // shadow-map texels a lookup moves off its surface along the normal ...
const BK_SHADOW_BIAS: f32 = 0.03;        // ... and cells toward the sun (against acne)
const BK_GROUND_ALB: vec3f = vec3f(${SKY.groundAlb.join(', ')});   // the floor's albedo (gfx/sky.js groundAlb)`;

export const blockLookHelpersWGSL = ({ prefix = '', input = 'VOut' } = {}) => /* wgsl */ `fn ${prefix}sideNormal(side: u32) -> vec3f {
  var n = vec3f(0.0);
  n[side >> 1u] = select(-1.0, 1.0, (side & 1u) == 1u);
  return n;
}
// Minecraft's per-face shade of the sky light (ClientLevel.getShade): up 1,
// down 0.5, north and south (z) 0.8, east and west (x) 0.6.
fn ${prefix}faceShade(side: u32) -> f32 {
  switch side >> 1u {
    case 0u: { return 0.6; }
    case 1u: { return select(0.5, 1.0, (side & 1u) == 1u); }
    default: { return 0.8; }
  }
}
// the corner AO at uv, 0..1 (1: open)
fn ${prefix}faceAO(info: u32, uv: vec2f) -> f32 {
  let a = (info >> 11u) & 255u;
  let lo = mix(f32(a & 3u), f32((a >> 2u) & 3u), uv.x);
  let hi = mix(f32((a >> 4u) & 3u), f32((a >> 6u) & 3u), uv.x);
  return mix(lo, hi, uv.y) / 3.0;
}
// the sky's irradiance on a face looking along n (shaders/gfx/lighting.js skyIrradiance's split)
fn ${prefix}skyLight(n: vec3f) -> vec3f {
  let up = n.y * 0.5 + 0.5;
  return up * FU.skyUp + (1.0 - up) * FU.ground + FU.caveAmbient;
}
// value noise in grid space, 0..1 (a gas's softness)
fn ${prefix}bkHash(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}
fn ${prefix}bkNoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(${prefix}bkHash(i), ${prefix}bkHash(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(${prefix}bkHash(i + vec3f(0.0, 1.0, 0.0)), ${prefix}bkHash(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(${prefix}bkHash(i + vec3f(0.0, 0.0, 1.0)), ${prefix}bkHash(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(${prefix}bkHash(i + vec3f(0.0, 1.0, 1.0)), ${prefix}bkHash(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}
// a gas face's coverage at uv: thinner toward the rim, broken up by the drifting noise
fn ${prefix}gasSoft(v: ${input}) -> f32 {
  let q = v.uv * 2.0 - 1.0;
  let rim = mix(1.0, BK_GAS_RIM, smoothstep(0.0, 2.0, dot(q, q)));
  let nz = ${prefix}bkNoise((v.grid - vec3f(0.0, FU.time * BK_GAS_DRIFT, 0.0)) * BK_GAS_NOISE_SCALE);
  return rim * mix(1.0, nz * 1.6, BK_GAS_NOISE);
}`;

export const blockLookWGSL = ({ prefix = '', input = 'VOut', sun = 'sunVisible', coloredSun = false } = {}) => /* wgsl */ `// What a face does to the light behind it (translucent faces) and what it
// gives off: tr, the share of each colour it lets through; a, the coverage
// it adds (the sky behind it shows less); e, its own radiance (lit colour,
// glow), added. Opaque faces: tr 0, a 1.
struct ${prefix}Look {
  tr: vec3f,
  a: f32,
  e: vec3f,
}
fn ${prefix}look(v: ${input}, back: bool) -> ${prefix}Look {
  let info = v.info;
  let side = info & 7u;
  let id = i32((info >> 3u) & 255u);
  let cls = classOf(id);
  let ht = unpack2x16float(v.heat);
  let T = ht.x;
  let life = ht.y;
  var n = ${prefix}sideNormal(side);
  if (back) { n = -n; }
  let ao = ${prefix}faceAO(info, v.uv);
  let tint = f32((info >> 19u) & 255u) / 255.0;
  var alb = COLOR(id) * (1.0 + COLORVAR(id) * (tint * 2.0 - 1.0));   // TPT's per-particle colour jitter
  if (id == E_BUTTON || id == E_CONTACTOR) { alb = contactFaceAlbedo(id, life > 0.0, v.uv); }
  if (cls == CL_FIRE) {
    // a flame: its blackbody glow and a little of its own colour, taking nothing away
    let e = incandescence(max(T, BK_FIRE_MIN_T)) * BK_FIRE_GAIN * mix(0.5, 1.0, clamp(life, 0.0, 1.0));
    return ${prefix}Look(vec3f(1.0), BK_FIRE_ALPHA, e + alb * 0.05);
  }
  var emit = vec3f(0.0);
  if (id == E_LAVA) { alb = BK_LAVA_ALB; }
  else { alb *= mix(1.0, BK_HOT_ALBEDO, smoothstep(BK_HOT_FROM, BK_HOT_TO, T)); }
  if (cls == CL_OPAQUE) { emit = cellEmission(id, T, 0.0); }   // (no ctype here: lava sets as stone would)
  let glow = info >> 27u;
  if (glow == 1u) { emit += SPARK_GLOW; }
  if (glow == 2u) { emit += LAMP_GLOW; }
${coloredSun ? `  let ndl = max(dot(n, FU.sun), 0.0);
  var direct = vec3f(0.0);
  if (ndl > 0.0) { direct = FU.sunCol * ndl * ${sun}(v.grid, n); }
  let aoL = mix(BK_AO_FLOOR, 1.0, ao);
  let lit = direct * mix(1.0, aoL, BK_SUN_AO) + ${prefix}skyLight(n) * ${prefix}faceShade(side) * aoL;` : `  var ndl = max(dot(n, FU.sun), 0.0);
  if (ndl > 0.0) { ndl *= ${sun}(v.grid, n); }
  let aoL = mix(BK_AO_FLOOR, 1.0, ao);
  let lit = FU.sunCol * ndl * mix(1.0, aoL, BK_SUN_AO) + ${prefix}skyLight(n) * ${prefix}faceShade(side) * aoL;`}
  let c = alb * lit + emit;
  if (cls == CL_OPAQUE) { return ${prefix}Look(vec3f(0.0), 1.0, c); }
  // see-through: its hue filters what is behind (Beer–Lambert's tint per
  // crossing) and it scatters some light of its own back
  let hue = alb / max(max(alb.r, max(alb.g, alb.b)), 1e-4);
  if (cls == CL_LIQUID) { return ${prefix}Look(mix(vec3f(1.0), hue, BK_LIQUID_TINT) * (1.0 - BK_LIQUID_DIM), BK_ALPHA_LIQUID, c * BK_LIQUID_SCATTER); }
  if (cls == CL_GLASS) { return ${prefix}Look(mix(vec3f(1.0), hue, BK_GLASS_TINT) * (1.0 - BK_ALPHA_GLASS), BK_ALPHA_GLASS, c * BK_ALPHA_GLASS); }
  // a gas: lit the same from every side (the sky's average and some shadowed sun), soft
  var al = BK_ALPHA_GAS;
  if (id == E_SMOKE) { al = BK_ALPHA_SMOKE * clamp(life, 0.2, 1.0); }
  else if (id == E_STEAM || id == E_CLOUD) { al = BK_ALPHA_STEAM; }
  al = clamp(al * ${prefix}gasSoft(v), 0.0, 1.0);
${coloredSun ? `  let gl = FU.sunCol * BK_GAS_SUN * ${sun}(v.grid, FU.sun) + ${prefix}skyLight(vec3f(0.0, 1.0, 0.0)) * 0.75;` : `  let gl = FU.sunCol * (BK_GAS_SUN * ${sun}(v.grid, FU.sun)) + ${prefix}skyLight(vec3f(0.0, 1.0, 0.0)) * 0.75;`}
  return ${prefix}Look(vec3f(1.0 - al), al, (alb * gl + emit) * al);
}`;

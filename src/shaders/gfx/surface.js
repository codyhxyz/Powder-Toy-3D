import { reliefGLSL } from './relief.js';
import { liquidGLSL } from './liquid.js';
import { liquidDetailGLSL } from './liquidDetail.js';
import { mediaGLSL } from './media.js';
import { grainsGLSL, GRAINS_ANY } from './grains.js';
import { lib, libLayouts } from './lib.js';
import { fullscreenVert } from '../../gpu/wgsl.js';
import { DETAIL, DETAIL_FADE_LO, DETAIL_FADE_HI, COST } from '../../gfx/detail.js';

// Opaque surfaces: per-element solid textures (world-space, so nothing
// reveals the grid), bevelled crisp voxels, and energy-conserving PBR shading.
//
// Pipeline for a hit: gatherSurf (smooth surfaces) or crispSurf (voxels and
// grains) builds a Surf from the material function matOf(); shadeSurf lights it.
// Moving grains carry their texture along with them (flowing grains, below).
//
// WGSL, after the render library (shaders/gfx/lib.js lib(): the prelude, the
// lighting group, core, noise, lighting, crystal); the names are the GLSL
// version's (docs/webgpu.md W2). What were uniforms are FrameUniforms fields:
// uMatDetail is FU.matDetail (1 = textured materials, 0 = flat albedo: A/B and
// fallback), uBevel FU.bevel (crisp-voxel edge radius in cells, 0 = sharp
// cubes), uGlints FU.glints (1 = sun glints on grains). The close-up detail
// that was #ifdef'd is a JS template switch (docs/webgpu.md F2): detail is the
// defines object gfx/detail.js detailDefines() makes ({ DETAIL_RELIEF: 1, ... }).
//   DETAIL_RELIEF                         relief.js, carved into the smooth hits
//   DETAIL_GRAINS, DETAIL_GRAIN_CLUSTERS  grains.js's gGrainSun in shadeSurf
//
// Derivatives: surfView takes the pixel's angular size from dpdx/dpdy of the
// ray direction, exact in a fragment shader as dFdx/dFdy were, but only in
// uniform control flow: the tracer calls it at the top of its entry point,
// before any branch (docs/webgpu.md F2). Everything after the march is in
// non-uniform control flow, where WGSL has no derivatives, so the floor's
// grid lines take their fwidth analytically from those ray derivatives
// (floorFwidth). Nothing here samples with an implicit level.
const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
export const surfaceGLSL = (detail = {}) => {
  const relief = !!detail.DETAIL_RELIEF;
  const grains = !!(detail.DETAIL_GRAINS || detail.DETAIL_GRAIN_CLUSTERS);
  return /* wgsl */ `
const PI_S: f32 = 3.14159265;
${grains ? `
// Close-up grains (gfx/grains.js, gfx/detail.js): compiled in only when switched on.
var<private> gGrainSun: f32 = 1.0;   // sun visibility past a grain's neighbours, set around its shadeSurf` : ''}

struct Surf {
  p: vec3f,         // hit point (grid units)
  tp: vec3f,        // where the texture is read: p, or for flowing grains p pushed back along the flow
  tp1: vec3f,       // flowing grains: the second texture layer's point (see flowing grains)
  flowW: f32,       // weight of that second layer (0 = one layer, at tp)
  n: vec3f,         // shading normal (geometry + material bump)
  ng: vec3f,        // geometric normal (field gradient / voxel face / bevel)
  id: i32,          // dominant element
  ch: i32,          // smooth channel, or -1 for a crisp voxel face
  cell: vec3i,      // dominant cell
  face: vec3i,      // axis-aligned face normal (crisp voxels, for faceAO)
  albedo: vec3f,    // diffuse albedo, or F0 for metals
  T: f32,           // temperature, blended across cells
  rough: f32,
  metal: f32,
  seed: f32,        // per-cell random in [0, 1)
  f0: f32,          // dielectric normal-incidence reflectance (from the IOR)
  sss: f32,         // wrap / subsurface amount
  sssCol: vec3f,    // tint of light that scattered deep (snow: blue)
  glint: f32,       // fraction of the sun's specular that arrives as glints
  glintDens: f32,   // relative glint density on screen (1 = one facet per GLINT_CELL_PX² pixels)
  cav: f32,         // cavity (micro) occlusion from the texture, 1 = open
  aniso: f32,       // brushed anisotropy along tang (0 = isotropic)
  tang: vec3f,
  trans: f32,       // backlit translucency (leaves)
  emit: vec3f,      // emitted radiance (incandescence)
}

// ---- view: set once per pixel by the tracer, in uniform control flow ----
const PIX_ANG_INIT: f32 = 0.002;   // radians per pixel until surfView sets it
const PIX_ANG_MIN: f32 = 1e-5;     // clamp on a pixel's angular size (radians)
const PIX_ANG_MAX: f32 = 0.05;
var<private> gEye: vec3f = vec3f(0.0);
var<private> gPixAng: f32 = PIX_ANG_INIT;
var<private> gRdDx: vec3f = vec3f(0.0);   // the ray direction's screen derivatives (surfView; zero after surfViewAng)
var<private> gRdDy: vec3f = vec3f(0.0);
// The eye and a pixel's angular size (radians per rendered pixel, from the
// ray direction's screen derivatives, which are kept for floorFwidth).
// Fragment shaders only, at the top of the entry point in uniform control flow.
fn surfView(eye: vec3f, rd: vec3f) {
  let dx = dpdx(rd);
  let dy = dpdy(rd);
  surfViewAng(eye, max(length(dx), length(dy)));
  gRdDx = dx;
  gRdDy = dy;
}
// The same with the angular size already known (radians per rendered pixel):
// for code that has no derivatives (a compute kernel tracing its own pixels).
fn surfViewAng(eye: vec3f, pixAng: f32) {
  gEye = eye;
  gPixAng = clamp(pixAng * FU.pixScale, PIX_ANG_MIN, PIX_ANG_MAX);
  gRdDx = vec3f(0.0);
  gRdDy = vec3f(0.0);
}
// size of a pixel at p, in grid units
fn footprint(p: vec3f) -> f32 { return distance(p, gEye) * gPixAng; }
// weight of detail with spatial frequency f (cycles per cell): fades out
// before it would alias (Nyquist = 0.5 cycles per pixel; gfx/detail.js)
const DETAIL_FADE_LO: f32 = ${f(DETAIL_FADE_LO)};   // fade range, cycles per pixel
const DETAIL_FADE_HI: f32 = ${f(DETAIL_FADE_HI)};
fn lodFade(f: f32, fp: f32) -> f32 { return 1.0 - smoothstep(DETAIL_FADE_LO, DETAIL_FADE_HI, f * fp); }

// ---- material noise (all world space; the lattice is rotated so it never lines up with the grid) ----
const M_ROT: mat3x3f = mat3x3f(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

// Value noise with its analytic gradient: (value in [0, 1], d/dx, d/dy, d/dz).
fn mNoiseD(x: vec3f) -> vec4f {
  let i = floor(x);
  let f = x - i;
  let u = f * f * (3.0 - 2.0 * f);
  let du = 6.0 * f * (1.0 - f);
  let a = hash13(i);
  let b = hash13(i + vec3f(1.0, 0.0, 0.0));
  let c = hash13(i + vec3f(0.0, 1.0, 0.0));
  let d = hash13(i + vec3f(1.0, 1.0, 0.0));
  let e = hash13(i + vec3f(0.0, 0.0, 1.0));
  let g = hash13(i + vec3f(1.0, 0.0, 1.0));
  let h = hash13(i + vec3f(0.0, 1.0, 1.0));
  let k = hash13(i + vec3f(1.0, 1.0, 1.0));
  let k1 = b - a;
  let k2 = c - a;
  let k3 = e - a;
  let k4 = a - b - c + d;
  let k5 = a - c - e + h;
  let k6 = a - b - e + g;
  let k7 = -a + b + c - d + e - g - h + k;
  return vec4f(a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
               du * vec3f(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
                          k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
                          k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y));
}
// noise of q = J p, gradient with respect to p
fn mNoiseJ(p: vec3f, J: mat3x3f, off: vec3f) -> vec4f {
  let n = mNoiseD(J * p + off);
  return vec4f(n.x, transpose(J) * n.yzw);
}

// fBm with gradient, centred on 0 (about ±0.45). Base frequency f cycles per
// cell; octaves finer than the pixel footprint fp fade out instead of aliasing.
const MFBM_MAX_OCT: i32 = 4;          // most octaves a caller may ask for
const MFBM_AMP0: f32 = 0.5;           // amplitude of the first octave
const MFBM_GAIN: f32 = 0.5;           // amplitude ratio between octaves
const MFBM_LACUNARITY: f32 = 2.03;    // frequency ratio between octaves (not 2, so they don't line up)
const MFBM_OCT_SHIFT: f32 = 7.31;     // lattice offset per octave (decorrelates them)
fn mFbmD(p: vec3f, f0: f32, oct: i32, fp: f32) -> vec4f {
  var s = vec4f(0.0);
  var a = MFBM_AMP0;
  var f = f0;
  var J = M_ROT * f0;
  for (var i = 0; i < MFBM_MAX_OCT; i++) {
    if (i >= oct) { break; }
    let lw = lodFade(f, fp);
    if (lw <= 0.0) { break; }
    let n = mNoiseD(J * p + f32(i) * MFBM_OCT_SHIFT);
    s += a * lw * vec4f(n.x - 0.5, transpose(J) * n.yzw);
    J = M_ROT * J * MFBM_LACUNARITY;
    f *= MFBM_LACUNARITY;
    a *= MFBM_GAIN;
  }
  return s;
}

// Cellular (Worley) noise: (F1, distance to the border with the second
// nearest cell, two hashes of the nearest cell). *ge = gradient of that border
// distance, *r1 = vector to the nearest seed.
const CELL_FAR: f32 = 1e9;   // "none yet": beyond any squared distance a search can find
// (scale, offset) of the nearest cell's position for its two hashes
const CELL_HASH_Z: vec2f = vec2f(1.31, 4.7);
const CELL_HASH_W: vec2f = vec2f(0.71, 9.2);
fn mCell(p: vec3f, ge: ptr<function, vec3f>, r1: ptr<function, vec3f>) -> vec4f {
  let i = floor(p);
  let f = p - i;
  var d1 = CELL_FAR;
  var d2 = CELL_FAR;
  var s1 = vec3f(0.0);
  var s2 = vec3f(1.0);
  var c1 = vec3f(0.0);
  for (var k = 0; k < 27; k++) {
    let o = vec3f(f32(k % 3), f32((k / 3) % 3), f32(k / 9)) - 1.0;
    let r = o + hash33(i + o) - f;
    let d = dot(r, r);
    if (d < d1) { d2 = d1; s2 = s1; d1 = d; s1 = r; c1 = i + o; }
    else if (d < d2) { d2 = d; s2 = r; }
  }
  let u = normalize(s2 - s1 + 1e-6);
  *ge = -u;
  *r1 = s1;
  return vec4f(sqrt(d1), dot(0.5 * (s1 + s2), u), hash13(c1 * CELL_HASH_Z.x + CELL_HASH_Z.y), hash13(c1 * CELL_HASH_W.x + CELL_HASH_W.y));
}

fn sminP(a: f32, b: f32, k: f32) -> f32 {     // polynomial smooth minimum, blend width k
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn dSmooth(a: f32, b: f32, x: f32) -> f32 {   // derivative of smoothstep(a, b, x)
  let t = clamp((x - a) / (b - a), 0.0, 1.0);
  return 6.0 * t * (1.0 - t) / (b - a);
}

// Crease noise: |2n - 1| of the noise of q = J p, with its gradient. It is 0
// along the n = 0.5 isolines, which meander and merge instead of tiling, so it
// makes natural cracks, furrows and V-shaped creases.
fn mCreaseJ(p: vec3f, J: mat3x3f, off: vec3f) -> vec4f {
  let n = mNoiseJ(p, J, off);
  let s = 2.0 * n.x - 1.0;
  return vec4f(abs(s), 2.0 * sign(s) * n.yzw);
}

// Sparse round spots (grains, flecks, pits) on a rotated lattice of f cells
// per grid unit. Each lattice cell holds, with probability prob, a ball of
// radius up to rmax (lattice units) kept inside its cell, so one lookup is
// enough. Returns (coverage in [0, 1] with a soft rim, gradient of a dome of
// height 1 over the ball, in grid units); *h = a hash of the spot. Beyond the
// pixel footprint the coverage fades to its mean (the balls' volume fraction,
// which is also the area fraction they cover on any plane cut).
const DOT_RIM: f32 = 0.3;     // soft rim, as a fraction of the radius
const DOT_RMIN: f32 = 0.4;    // smallest ball, as a fraction of rmax
const DOT_SALT: f32 = 23.7;   // decorrelates the position hash from the size hash
// E[r^3] / rmax^3 for r uniform in [DOT_RMIN, 1] rmax, times the volume of a
// unit ball with that soft rim (taken at the rim's middle; within 2%)
const UNIT_BALL_VOL: f32 = 4.18879;   // 4π/3
const DOT_VOL: f32 = (1.0 - DOT_RMIN * DOT_RMIN * DOT_RMIN * DOT_RMIN) / (4.0 * (1.0 - DOT_RMIN))
                   * UNIT_BALL_VOL * (1.0 - 0.5 * DOT_RIM) * (1.0 - 0.5 * DOT_RIM) * (1.0 - 0.5 * DOT_RIM);
fn mDots(p: vec3f, f: f32, prob: f32, rmax: f32, fp: f32, h: ptr<function, f32>) -> vec4f {
  let q = M_ROT * p * f;
  let i = floor(q);
  let a = hash33(i);
  let b = hash33(i + DOT_SALT);
  *h = a.z;
  let r = rmax * mix(DOT_RMIN, 1.0, a.y);
  let d = q - (i + 0.5 + (b - 0.5) * (1.0 - 2.0 * r));
  let dl = length(d);
  let on = step(a.x, prob);
  let cov = on * (1.0 - smoothstep((1.0 - DOT_RIM) * r, r, dl));
  let g = on * step(dl, r) * (-2.0 * f / (r * r)) * (transpose(M_ROT) * d);
  let lw = lodFade(f, fp);
  return vec4f(mix(prob * DOT_VOL * rmax * rmax * rmax, cov, lw), lw * g);
}

// ---- materials ----
struct Mat {
  alb: vec3f,     // diffuse albedo (dielectrics) or F0 (metals)
  g: vec3f,       // gradient of the bump height, grid units (perturbs the normal)
  emit: vec3f,
  tang: vec3f,
  sssCol: vec3f,
  rough: f32, metal: f32, f0: f32, sss: f32, glint: f32, glintDens: f32, cav: f32, aniso: f32, trans: f32,
}

fn mixMat(a0: Mat, b: Mat, k: f32) -> Mat {
  var a = a0;
  a.alb = mix(a.alb, b.alb, k); a.g = mix(a.g, b.g, k); a.emit = mix(a.emit, b.emit, k);
  a.tang = mix(a.tang, b.tang, k); a.sssCol = mix(a.sssCol, b.sssCol, k);
  a.rough = mix(a.rough, b.rough, k); a.metal = mix(a.metal, b.metal, k); a.f0 = mix(a.f0, b.f0, k);
  a.sss = mix(a.sss, b.sss, k); a.glint = mix(a.glint, b.glint, k); a.glintDens = mix(a.glintDens, b.glintDens, k);
  a.cav = mix(a.cav, b.cav, k); a.aniso = mix(a.aniso, b.aniso, k); a.trans = mix(a.trans, b.trans, k);
  return a;
}

// Lava freezes back into its ctype at MELT - LAVA_FREEZE_BELOW (src/physics.js).
fn solidusOf(ctype: f32) -> f32 {
  var ct = i32(ctype);
  if (ct <= 0 || ct >= NE || MELT(ct) <= 0.0) { ct = E_STONE; }
  return MELT(ct) - LAVA_FREEZE_BELOW;
}

// Glow of an opaque surface whose bulk is at T (°C): its thermal glow plus
// any luminescence of element id (emission). Kirchhoff: a surface emits what
// it doesn't reflect (emissivity = 1 - reflectance), so pale rock glows less
// than black crust and gold hardly at all. The open skin radiates its heat
// away and runs INCAND_SKIN_DROP below the bulk, while crevices and pores (low
// cavity term) show the hot interior: heat reads as glowing cracks rather than
// a tint over the whole surface.
const LUMA_W: vec3f = vec3f(0.2126, 0.7152, 0.0722);
// glow of material m of element id with its visible surface at Ts (°C)
fn glowAt(m: Mat, id: i32, Ts: f32) -> vec3f {
  let refl = mix(m.f0 + (1.0 - m.f0) * m.alb, m.alb, m.metal);
  return emissionWith(id, Ts, 1.0 - clamp(dot(refl, LUMA_W), 0.0, 1.0));
}
fn hotEmit(m: Mat, id: i32, T: f32) -> vec3f { return glowAt(m, id, T - INCAND_SKIN_DROP * clamp(m.cav, 0.0, 1.0)); }

// Hot steel's mill scale (E_METAL)
const OXIDE_T0: f32 = 400.0;     // °C: scale starts to darken the steel…
const OXIDE_T1: f32 = 650.0;     // …and covers it (wüstite forms above ~570 °C)
const OXIDE_ALB: vec3f = vec3f(0.03, 0.027, 0.025);   // black, a touch of rust brown
const OXIDE_F0: f32 = 0.05;      // porous, dull: little sky in it, even at grazing angles
const OXIDE_ROUGH: f32 = 0.8;
const SCALE_M: f32 = 0.073;      // m, patches of thick scale
const SCALE_FREQ: f32 = CELL_M / SCALE_M;   // per cell
const SCALE_OCT: i32 = 3;        // fBm octaves of the scale thickness
const SCALE_SPLIT: f32 = 0.18;   // thin → thick over this much of the thickness noise
const SCALE_COVER: f32 = 0.06;   // shifts the thickness noise: most of the steel is under thick scale
const SCALE_ALB_VAR: f32 = 0.6;  // thick scale is a little greyer
const SCALE_BUMP: f32 = 0.02 / CELL_M;   // blistered relief: 2 cm, in cells
const SCALE_DROP: f32 = 150.0;   // °C thick scale runs below the steel

// Lava (E_LAVA)
const LAVA_CHURN: f32 = 0.0096 / CELL_M;   // drift of the molten skin pattern: m/s, as cells per second
const LAVA_SKIN_M: f32 = 0.2;        // m, skin pattern wavelength
const LAVA_SKIN_FREQ: f32 = CELL_M / LAVA_SKIN_M;   // per cell
const LAVA_SKIN_OCT: i32 = 2;        // fBm octaves of the skin pattern
const LAVA_SKIN_VAR: f32 = 0.6;      // how far the skin pattern shifts the crust line
const LAVA_SKIN_DT: f32 = 150.0;     // °C: skin temperature swing on the melt
const LAVA_MELT_RANGE: f32 = 450.0;  // °C above the solidus where it is fully molten
const LAVA_CRUST_X0: f32 = 0.2;      // crust starts to break up (fraction of that range)…
const LAVA_CRUST_X1: f32 = 0.8;      // …and is gone
const LAVA_PLATE_M: f32 = 0.1;       // m, crust plate size
const LAVA_PLATE_FREQ: f32 = CELL_M / LAVA_PLATE_M;   // crust plates per cell
const LAVA_CRACK_LOD: f32 = 4.0;     // cracks are narrow: fade them at this multiple of the plate frequency
const LAVA_CRACK_CORE: f32 = 0.5;    // fraction of the crack half-width that is fully open melt
const LAVA_CRACK_OPEN: f32 = 1.0;    // crack half-width once the crust has broken up (no plates left)…
const LAVA_CRACK_SHUT: f32 = 0.04;   // …and once it has set (cellular-noise units)
const LAVA_RIM: f32 = 0.12;          // plate edge still glowing beside a crack
const LAVA_CRACK_AREA: f32 = 1.6;    // area share of cracks per unit half-width (far LOD)
const LAVA_CRUST_T: f32 = 450.0;     // °C: top of a crust right at the solidus…
const LAVA_CRUST_K: f32 = 0.8;       // …rising this much per °C of melt above it
const LAVA_MELT_ALB: vec3f = vec3f(0.05, 0.035, 0.025);   // dark glassy melt
const LAVA_MELT_ROUGH: f32 = 0.25;
const LAVA_CRUST_ROUGH: f32 = 0.55;  // glassy, silvery basalt skin (pahoehoe)
const LAVA_CRUST_VAR: f32 = 0.5;     // plate-to-plate albedo spread (± half of it)
const LAVA_CRACK_CAV: f32 = 0.5;     // cavity term down in a crack
const LAVA_PLATE_BUMP: f32 = 0.016 / CELL_M;   // relief of the plate edges: 1.6 cm, in cells
const LAVA_PLATE_EDGE: f32 = 0.35;   // width of the rounded plate edge
const LAVA_SKIN_BUMP: f32 = 0.008 / CELL_M;    // ripples on the melt: 8 mm, in cells

// Turns a lattice 30° about y, so bark plates and rain streaks don't line up with the grid.
const TURN_Y30: mat3x3f = mat3x3f(0.866, 0.0, 0.5, 0.0, 1.0, 0.0, -0.5, 0.0, 0.866);

// ---- relief: the heights that are geometry up close ----
// The mid-scale relief of the smooth solids (clumps, crags, bark plates) is a
// height field over the surface, in cells, centred on 0: matOf bumps the
// normal by its gradient, and close up (gfx/relief.js, DETAIL_RELIEF) the
// tracer carves the surface itself by it. Both read it from here, so the
// geometry and the shading are one relief.
// Sizes are in metres (m), converted to cells through CELL_M (src/scale.js):
// a wavelength X_M becomes X_F = CELL_M / X_M per cell, a height X_H = m / CELL_M cells.
// Sand: the lumpy slump surface a pile's avalanches leave, and clumps and
// dimples on it. Each avalanche on a slip face runs down as a grainflow
// tongue 1-5 cm thick and a few decimetres wide (Hunter 1977,
// Sedimentology 24): lobes ~2 cm proud over ~30 cm.
const SAND_SLUMP_M: f32 = 0.27;              // m, slump wavelength
const SAND_SLUMP_F: f32 = CELL_M / SAND_SLUMP_M;   // per cell
const SAND_SLUMP_H: f32 = 0.06 / CELL_M;     // 6 cm per unit of noise (±2 cm, 3 at most), in cells
const SAND_SLUMP_OCT: i32 = 2;               // fBm octaves
fn sandSlumps(p: vec3f, fp: f32) -> vec4f { return mFbmD(p, SAND_SLUMP_F, SAND_SLUMP_OCT, fp); }
const SAND_CLUMP_M: f32 = 0.025;             // m, clump wavelength
const SAND_CLUMP_F: f32 = CELL_M / SAND_CLUMP_M;   // per cell
const SAND_CLUMP_H: f32 = 0.01 / CELL_M;     // 1 cm per unit of noise (±3-4 mm), in cells
const SAND_CLUMP_OCT: i32 = 3;    // fBm octaves
fn sandClumps(p: vec3f, fp: f32) -> vec4f { return mFbmD(p, SAND_CLUMP_F, SAND_CLUMP_OCT, fp); }
// Snow: soft drifts (1-2 cm over ~35 cm) and clumps.
const SNOW_DRIFT_M: f32 = 0.36;              // m, wavelength
const SNOW_DRIFT_F: f32 = CELL_M / SNOW_DRIFT_M;
const SNOW_DRIFT_H: f32 = 0.05 / CELL_M;
const SNOW_DRIFT_OCT: i32 = 2;
fn snowDrifts(p: vec3f, fp: f32) -> vec4f { return mFbmD(p, SNOW_DRIFT_F, SNOW_DRIFT_OCT, fp); }
const SNOW_CLUMP_M: f32 = 0.031;             // m, wavelength
const SNOW_CLUMP_F: f32 = CELL_M / SNOW_CLUMP_M;
const SNOW_CLUMP_H: f32 = 0.008 / CELL_M;
const SNOW_CLUMP_OCT: i32 = 2;
fn snowClumps(p: vec3f, fp: f32) -> vec4f { return mFbmD(p, SNOW_CLUMP_F, SNOW_CLUMP_OCT, fp); }
// Foliage: leaves grow in sprays and the sprays in clumps, so a crown is lumps
// of foliage with shaded hollows between them at every distance, not one
// smooth green surface once its 3.5 cm leaves are below a pixel. Octaves of
// 60, 30 and 15 cm, each fading in turn (mFbmD), carry it out to the horizon.
const LEAF_CLUMP_M: f32 = 0.6;               // m, the largest clumps' wavelength
const LEAF_CLUMP_F: f32 = CELL_M / LEAF_CLUMP_M;
const LEAF_CLUMP_H: f32 = 0.15 / CELL_M;     // relief per unit of noise, cells
const LEAF_CLUMP_CAV: f32 = 0.9;             // cavity swing per unit of noise: the hollows' shade
const LEAF_CLUMP_OCT: i32 = 3;
fn leafClumps(p: vec3f, fp: f32) -> vec4f { return mFbmD(p, LEAF_CLUMP_F, LEAF_CLUMP_OCT, fp); }
// Gunpowder: lumps of granules.
const POWDER_LUMP_M: f32 = 0.13;             // m, wavelength
const POWDER_LUMP_F: f32 = CELL_M / POWDER_LUMP_M;
const POWDER_LUMP_H: f32 = 0.0064 / CELL_M;
const POWDER_LUMP_OCT: i32 = 2;
fn powderLumps(p: vec3f, fp: f32) -> vec4f { return mFbmD(p, POWDER_LUMP_F, POWDER_LUMP_OCT, fp); }
// Ash: soft lumps.
const ASH_LUMP_M: f32 = 0.18;                // m, wavelength
const ASH_LUMP_F: f32 = CELL_M / ASH_LUMP_M;
const ASH_LUMP_H: f32 = 0.012 / CELL_M;
const ASH_LUMP_OCT: i32 = 3;
fn ashLumps(p: vec3f, fp: f32) -> vec4f { return mFbmD(p, ASH_LUMP_F, ASH_LUMP_OCT, fp); }
// Rock (the CRAG texture family, gfx/materials.js surf: ROCK, sandstone,
// limestone, coal): big lumps (bump only: they are the size of the smooth
// surface's own shape), which warp the crags: octaves of crease noise. Each
// element scales the crags' height by its CRAG(id).x (relief).
const ROCK_LUMP_M: f32 = 0.5;                // m, wavelength
const ROCK_LUMP_F: f32 = CELL_M / ROCK_LUMP_M;
const ROCK_LUMP_H: f32 = 0.072 / CELL_M;
const ROCK_LUMP_OCT: i32 = 3;
fn rockLumps(p: vec3f, fp: f32) -> vec4f { return mFbmD(p, ROCK_LUMP_F, ROCK_LUMP_OCT, fp); }
// Crags, ledges and cracks of weathered lava rock: 25, 12 and 5.5 cm octaves,
// knobs ~4 cm proud and creases ~6-9 cm deep. Measured lava surfaces are
// self-affine (Hurst exponent ~0.6-0.8) with RMS heights at a 1 m baseline
// of a few cm on smooth pahoehoe to 10-30 cm on aa (Shepard et al. 2001,
// JGR 106 E12; Morris et al. 2008, JGR 113 E12007); broken, weathered rock
// between the two, ~8 cm at 1 m, is ~3.5 cm RMS at the crags' 25 cm, which
// these octaves give.
const ROCK_CRAG_M: f32 = 0.25;               // m, wavelength of the first crag octave
const ROCK_CRAG_F: f32 = CELL_M / ROCK_CRAG_M;   // its frequency (per cell)
const ROCK_CRAG_H: f32 = 0.07 / CELL_M;      // its relief (7 cm, in cells)
const ROCK_CRAG_LAC: f32 = 2.13;             // per octave: frequency x ...
const ROCK_CRAG_GAIN: f32 = 0.55;            // ... relief x
// The first octave is creases (h = 1 - (1 - c)^2: flat knobs, V valleys),
// the finer ones sharp ridges (h = (1 - c)^2): broken, angular edges
// instead of the soft knobs that read as clay.
const ROCK_CREASE_MEAN: f32 = 0.6;           // mean heights of the two profiles
const ROCK_RIDGE_MEAN: f32 = 0.4;
const ROCK_WARP: f32 = 0.0192 / (CELL_M * CELL_M);   // crag warp per unit of the lumps' slope (m² per unit slope per m, as cells)
const ROCK_CRAG_OCT: i32 = 3;                // octaves of crease noise
const ROCK_CRAG_LOD: f32 = 2.0;              // creases are sharp: fade them at this multiple of their frequency
const ROCK_CRAG_SALT: f32 = 3.1;             // noise offset of the first crag octave ...
const ROCK_CRAG_SALT_STEP: f32 = 5.3;        // ... added per octave
// (crag height, its gradient) in units of ROCK_CRAG_H, given the lumps lo;
// *ws = the octaves' total weight (height / ws is roughly ±0.5)
fn rockCrags(p: vec3f, lo: vec4f, fp: f32, ws: ptr<function, f32>) -> vec4f {
  let pw = p + ROCK_WARP * lo.yzw;
  var hc = 0.0;
  *ws = 0.0;
  var gc = vec3f(0.0);
  var J = M_ROT * ROCK_CRAG_F;
  var f = ROCK_CRAG_F;
  var a = 1.0;
  for (var i = 0; i < ROCK_CRAG_OCT; i++) {
    let lw = lodFade(ROCK_CRAG_LOD * f, fp);
    let c = mCreaseJ(pw, J, vec3f(ROCK_CRAG_SALT + ROCK_CRAG_SALT_STEP * f32(i)));
    let r2 = (1.0 - c.x) * (1.0 - c.x);
    let dr2 = -2.0 * (1.0 - c.x) * c.yzw;
    hc += a * lw * select(r2 - ROCK_RIDGE_MEAN, 1.0 - r2 - ROCK_CREASE_MEAN, i == 0);
    gc += a * lw * select(dr2, -dr2, i == 0);
    *ws += a;
    J = M_ROT * J * ROCK_CRAG_LAC;
    f *= ROCK_CRAG_LAC;
    a *= ROCK_CRAG_GAIN;
  }
  return vec4f(hc, gc);
}
// Wood bark: long corky plates (cellular cells stretched along y, turned about
// it), split by V furrows, each plate slightly domed; and, a scale up, ridges
// of plates split by deep fissures (crease noise stretched along y), which is
// what still reads as bark from across the box, long after the plates are
// sub-pixel. Returns (height, gradient); *mv = the furrows' meander noise, *c =
// the plate cell (mCell), *fr = 0 down a fissure .. 1 on a ridge (faded to its
// area mean far away).
const WOOD_PLATE_W_M: f32 = 0.05;            // m: plates ~5 cm wide, ...
const WOOD_PLATE_L_M: f32 = 0.3;             // ... ~30 cm long (big trunk)
const WOOD_PLATE_FH: f32 = CELL_M / WOOD_PLATE_W_M;   // plates per cell: across ...
const WOOD_PLATE_FV: f32 = CELL_M / WOOD_PLATE_L_M;   // ... along
const WOOD_MEANDER_M: f32 = 0.27;            // m, furrow meander wavelength
const WOOD_MEANDER_F: f32 = CELL_M / WOOD_MEANDER_M;  // its frequency ...
const WOOD_MEANDER: f32 = 0.024 / CELL_M;    // ... and amplitude (2.4 cm, in cells)
const WOOD_WAVE_M: f32 = 0.06;               // m, wavelength of the furrow edges' wander
const WOOD_WAVE_F: f32 = CELL_M / WOOD_WAVE_M;        // its frequency ...
const WOOD_WAVE: f32 = 0.00051 / (CELL_M * CELL_M);   // ... cells per unit slope
const WOOD_FUR_W: f32 = 0.3;                 // furrow half-width, lattice units
// Furrows run nearly through the outer bark, which on a mature thick-barked
// trunk is ~4-7% of its diameter (Ryan & Reinhardt 1988, Can. J. For. Res.
// 18: ponderosa pine 6.3%, Douglas-fir 6.5%; oaks similar): 3 cm on a ~50 cm trunk.
const WOOD_FUR_DEPTH: f32 = 0.03 / CELL_M;   // furrows 3 cm deep, ...
const WOOD_PLATE_DOME: f32 = 0.006 / CELL_M; // ... plates domed 6 mm, in cells
// Narrow furrows alias a little sooner than the plates: fade at this multiple
// of WOOD_PLATE_FH (plates fully drawn while ~10 px across, ~10 m away).
const WOOD_FURROW_LOD: f32 = 1.3;
const WOOD_MEANDER_OCT: i32 = 2;             // fBm octaves
const WOOD_WAVE_OCT: i32 = 1;
const WOOD_RIDGE_W_M: f32 = 0.15;            // m: ridges of plates ~15 cm apart, ...
const WOOD_RIDGE_L_M: f32 = 0.9;             // ... ~90 cm long
const WOOD_RIDGE_FH: f32 = CELL_M / WOOD_RIDGE_W_M;   // per cell: across ...
const WOOD_RIDGE_FV: f32 = CELL_M / WOOD_RIDGE_L_M;   // ... along
const WOOD_FISSURE_W: f32 = 0.2;             // fissure half-width in crease units (|2n - 1|): ~20% of the bark
const WOOD_FISSURE_MEAN: f32 = 0.8;          // area mean of smoothstep(0, WOOD_FISSURE_W, crease) (value noise, sampled)
const WOOD_FISSURE_DEPTH: f32 = 0.02 / CELL_M;   // fissures 2 cm below the plates' furrows' level, in cells
const WOOD_FISSURE_SALT: vec3f = vec3f(3.7); // decorrelates the fissures from the other layers
const WOOD_TOP_EDGE: vec2f = vec2f(0.6, 0.9);   // |n.y| range over which a face turns into end grain
fn woodPlates(p: vec3f, fp: f32, mv: ptr<function, vec4f>, c: ptr<function, vec4f>, fr: ptr<function, f32>) -> vec4f {
  let J = TURN_Y30 * mat3x3f(WOOD_PLATE_FH, 0.0, 0.0, 0.0, WOOD_PLATE_FV, 0.0, 0.0, 0.0, WOOD_PLATE_FH);
  let m = mFbmD(p, WOOD_MEANDER_F, WOOD_MEANDER_OCT, fp);
  *mv = m;
  let wv = mFbmD(p, WOOD_WAVE_F, WOOD_WAVE_OCT, fp);
  let pw = p + WOOD_MEANDER * m.x * vec3f(1.0, 0.0, 1.0) + WOOD_WAVE * wv.yzw;
  var ge: vec3f;
  var r1: vec3f;
  let cc = mCell(J * pw, &ge, &r1);
  *c = cc;
  let lwF = lodFade(WOOD_PLATE_FH * WOOD_FURROW_LOD, fp);
  // furrow: up from its floor to the plate; dome: down from the plate's seed
  let h = WOOD_FUR_DEPTH * smoothstep(0.0, WOOD_FUR_W, cc.y) - 0.5 * WOOD_PLATE_DOME * dot(r1, r1);
  let pl = lwF * vec4f(h, transpose(J) * (WOOD_FUR_DEPTH * dSmooth(0.0, WOOD_FUR_W, cc.y) * ge + WOOD_PLATE_DOME * r1));
  // fissures: down from the plates' level (the relief's top stays the plates')
  let JR = TURN_Y30 * mat3x3f(WOOD_RIDGE_FH, 0.0, 0.0, 0.0, WOOD_RIDGE_FV, 0.0, 0.0, 0.0, WOOD_RIDGE_FH);
  let cr = mCreaseJ(pw, JR, WOOD_FISSURE_SALT);
  let lwR = lodFade(WOOD_RIDGE_FH * WOOD_FURROW_LOD, fp);
  let ridge = smoothstep(0.0, WOOD_FISSURE_W, cr.x);
  *fr = mix(WOOD_FISSURE_MEAN, ridge, lwR);
  return pl + lwR * WOOD_FISSURE_DEPTH * vec4f(ridge - 1.0, dSmooth(0.0, WOOD_FISSURE_W, cr.x) * cr.yzw);
}
// share of sawn end grain (no bark) on a face with normal n
fn woodEndGrain(n: vec3f) -> f32 { return smoothstep(WOOD_TOP_EDGE.x, WOOD_TOP_EDGE.y, abs(n.y)); }

// The relief of element id at p (height in cells, gradient): the part of its
// bump that is real geometry up close. n: the surface normal (wood's end
// grain is flat). Elements without one return 0.
fn reliefHeight(id: i32, p: vec3f, n: vec3f, fp: f32) -> vec4f {
  if (id == E_SAND) { return SAND_SLUMP_H * sandSlumps(p, fp) + SAND_CLUMP_H * sandClumps(p, fp); }
  if (id == E_SNOW) { return SNOW_DRIFT_H * snowDrifts(p, fp) + SNOW_CLUMP_H * snowClumps(p, fp); }
  if (id == E_GUNPOWDER) { return POWDER_LUMP_H * powderLumps(p, fp); }
  if (id == E_ASH) { return ASH_LUMP_H * ashLumps(p, fp); }
  if (SURF(id) == SURF_CRAG) { var ws: f32; return CRAG(id).x * ROCK_CRAG_H * rockCrags(p, rockLumps(p, fp), fp, &ws); }
  if (id == E_WOOD) { var mv: vec4f; var c: vec4f; var fr: f32; return woodPlates(p, fp, &mv, &c, &fr) * (1.0 - woodEndGrain(n)); }
  return vec4f(0.0);
}

// Rubble (E_STONE): rock broken by a pick, a blast or a fall (ROCK breaks
// into it). Its chips' tones and look, shared by the texture (matOf) and the
// chips drawn as geometry up close (gfx/grains.js), so the hand-off between
// them keeps the same stones. One parent rock, so the tones are its faces:
// fresh fractures paler than the weathered skin, a few dark or rusty chips
// (relative albedo; their mean is ~1).
const PEB_FRESH: vec3f = vec3f(1.12, 1.1, 1.07);
const PEB_SKIN: vec3f = vec3f(0.92, 0.9, 0.88);
const PEB_DARK: vec3f = vec3f(0.68, 0.68, 0.7);
const PEB_RUST: vec3f = vec3f(1.12, 0.94, 0.82);
// cumulative shares of the tones (the rest is rust)
const PEB_FRESH_UPTO: f32 = 0.45;
const PEB_SKIN_UPTO: f32 = 0.8;
const PEB_DARK_UPTO: f32 = 0.93;
const PEB_SHADE_MIN: f32 = 0.8;                // chip-to-chip shade ...
const PEB_SHADE_RANGE: f32 = 0.4;
const PEB_ROUGH_VAR: f32 = 0.3;                // chip-to-chip roughness spread
const PEB_POLISH: f32 = 0.0;                   // broken faces are as rough as the rubble overall
const PEBBLE_M: f32 = 0.05;                    // m: a small chip (the fill between the big ones)
const PEBBLE_F: f32 = CELL_M / PEBBLE_M;       // small chips per cell along a line
// texture within a pebble: wavelength and relief (m), as frequency (per cell) and height (cells)
const PEB_MOTTLE_M: f32 = 0.017;
const PEB_MOTTLE_H_M: f32 = 0.0024;
const PEB_MOTTLE_F: f32 = CELL_M / PEB_MOTTLE_M;
const PEB_MOTTLE_H: f32 = PEB_MOTTLE_H_M / CELL_M;
const PEB_MOTTLE_ALB: f32 = 0.35;              // albedo swing per unit of the mottle
const PEB_MOTTLE_OCT: i32 = 2;                 // fBm octaves of the mottle
const PEB_VOID_ALB: f32 = 0.1;                 // the voids between pebbles: crevices in deep shade
const PEB_VOID_CAV: f32 = 0.15;
// tone of a chip from a uniform hash
fn pebbleRock(h: f32) -> vec3f {
  if (h < PEB_FRESH_UPTO) { return PEB_FRESH; }
  if (h < PEB_SKIN_UPTO) { return PEB_SKIN; }
  if (h < PEB_DARK_UPTO) { return PEB_DARK; }
  return PEB_RUST;
}

// Fluorite (E_CRYSTAL), on the crystals gfx/crystal.js draws for it: a
// translucent crystal drawn opaque, so each face works out what it shows of
// the body behind it. p is a world point; the crystal (gCrys) is in grid units.
// Colour: violet to blue (Weardale, Blue John), drifting over metres so a
// cluster is one colour, a little different from crystal to crystal. As in
// amethyst and fluorite points alike, the colour (and the europium that
// glows) gathered toward the growing end: a crystal is milky toward its root
// and takes its colour over its last CRYS_COLOUR_LEN cells.
const FLUORITE_VIOLET: vec3f = vec3f(0.105, 0.045, 0.27);   // linear albedo of the body's colours
const FLUORITE_BLUE: vec3f = vec3f(0.045, 0.08, 0.3);
const FLUORITE_MILK: vec3f = vec3f(0.3, 0.28, 0.34);        // the colourless root, clouded with inclusions
const CRYS_HUE_M: f32 = 3.0;               // m: the colour drifts over this
const CRYS_HUE_F: f32 = CELL_M / CRYS_HUE_M;
const CRYS_HUE_EDGE: vec2f = vec2f(0.4, 0.7);  // violet below the drift noise's first edge, blue above the second
const CRYS_SHADE_VAR: f32 = 0.15;          // ± crystal-to-crystal shade
const CRYS_COLOUR_LEN: vec2f = vec2f(0.5, 2.0);   // cells back from the apex: full colour to here, milky past here
const CRYS_PALE_MIX: f32 = 0.6;            // how milky the root is
const CRYS_ROOT_GLOW: f32 = 0.4;           // the root's glow, relative to the coloured part
// Colour zoning: phantoms. A crystal grew as nested crystals, each taking up
// colour centres (and europium) its own way; a face shows the zone the
// refracted view meets CRYS_ZONE_DEPTH apothems in, so the phantoms inside
// shift with the view as through real glass.
const CRYS_ZONE_DEPTH: f32 = 0.6;
const CRYS_BANDS_MIN: f32 = 1.5;           // zones from axis to faces
const CRYS_BANDS_MAX: f32 = 3.0;
const CRYS_BAND_MIX: f32 = 0.25;           // how far a zone shifts toward the other colour (subtle)
const CRYS_ZONE_GLOW: f32 = 0.1;           // ± share the glow swings across the zones…
const CRYS_SEED_GLOW: f32 = 0.25;          // …and from crystal to crystal (both average out)
// Glow from inside. A thin glowing body is as bright as the path the eye
// looks along through it: a face shows the refracted view's run to the far
// side, in mean chords (2 apothems for a long prism), so a crystal seen
// end-on or through its thick middle is bright and its thin rims are dim,
// times the Fresnel transmittance (dim at grazing angles). Light trapped by
// total internal reflection is piped along a long crystal and leaves through
// its point (the luminescent-concentrator effect: Weber & Lambe 1976), whose
// faces are a few times smaller than its sides: the points glow brightest.
const CRYS_PATH_MAX: f32 = 3.0;            // most mean chords a view counts (end-on)
const CRYS_PIPE: f32 = 0.25;               // share of the light piped to the point
const CRYS_PIPE_MAX: f32 = 2.5;            // most the point is brightened
// area of the sides per unit length, per apothem: 6 faces 2/√3 apothems wide;
// area of the point per apothem²: the hexagon (2√3) over the faces' cosine to the axis
const CRYS_SIDE_AREA: f32 = 6.9282;
const CRYS_TIP_AREA: f32 = 3.4641 * 1.6154;
// Faces: each face of a crystal grew (and so glows and takes its colour) a
// little its own way, so its facets read apart; and prism faces carry growth
// lines across them (quartz's horizontal striations), a few per centimetre
// at most, drawn as fine bands in the glow until they are smaller than a pixel.
const CRYS_FACE_VAR: f32 = 0.18;           // ± face-to-face glow
const CRYS_STRIA_M: f32 = 0.012;           // m: the growth lines' typical spacing
const CRYS_STRIA_F: f32 = CELL_M / CRYS_STRIA_M;   // per cell
const CRYS_STRIA_GLOW: f32 = 0.25;         // glow swing across a line
// Where it grows on into other crystal its cell cuts it: a rough, milky break.
const CRYS_CUT_ROUGH: f32 = 0.3;
const CRYS_CUT_GLINT: f32 = 0.6;
const CRYS_CUT_GLOW: f32 = 0.5;
const CRYS_ZONE_EPS: f32 = 1e-3;           // apothems: the zones' scale at the very apex
fn crystalLook(m: ptr<function, Mat>, id: i32, p: vec3f, n: vec3f, T: f32, fp: f32) -> vec3f {
  let gp = p - vec3f(H.origin);   // grid units, as the crystal and the eye
  let v = normalize(gEye - gp);
  let ior = IOR(id);
  (*m).alb = mix(FLUORITE_VIOLET, FLUORITE_BLUE, smoothstep(CRYS_HUE_EDGE.x, CRYS_HUE_EDGE.y, vnoise(M_ROT * p * CRYS_HUE_F)));
  // not from crystalHit (the far view)
  if (!gCrysOn || any(vec3i(floor(gp - n * CRYS_IN)) != gCrysCell)) { return hotEmit(*m, id, T); }
  let f0 = (*m).f0;
  let nv = clamp(dot(n, v), 0.0, 1.0);
  let tr = (1.0 - (f0 + (1.0 - f0) * pow(1.0 - nv, 5.0))) / (1.0 - f0);
  if (gCrysKind == CRYS_CUT) {
    (*m).alb = mix((*m).alb, FLUORITE_MILK, CRYS_PALE_MIX);
    (*m).rough = CRYS_CUT_ROUGH;
    (*m).glint = CRYS_CUT_GLINT;
    return hotEmit(*m, id, T) * tr * CRYS_CUT_GLOW;
  }
  let s = gCrys;
  let lp = lodFade(1.0 / s.r, fp);   // the crystal's own detail, gone once it is a pixel
  // colour: the crystal's shade, milky toward the root, zoned
  let col = (*m).alb * (1.0 + CRYS_SHADE_VAR * (2.0 * s.seed - 1.0));
  let coloured = 1.0 - smoothstep(CRYS_COLOUR_LEN.x, CRYS_COLOUR_LEN.y, s.len - dot(gp - s.o, s.d));
  let r = refract(-v, n, 1.0 / ior);
  let q = gp + r * (CRYS_ZONE_DEPTH * s.r) - s.o;
  var zr = 0.0;
  for (var i = 0; i < 3; i++) { zr = max(zr, abs(dot(q, CRYS_HEX[i].x * s.u + CRYS_HEX[i].y * s.w))); }
  let x = s.len - dot(q, s.d);   // back from the apex: the nested points narrow toward it
  let z = zr / max(min(s.r, x / CRYS_TIP_K), CRYS_ZONE_EPS);   // 0 on the axis, 1 on the faces
  let bands = mix(CRYS_BANDS_MIN, CRYS_BANDS_MAX, fract(s.seed * CRYS_SALT));
  let band = 0.5 + 0.5 * cos(2.0 * PI_S * z * bands);
  let lz = lodFade(bands / s.r, fp);
  let zoned = mix(col, mix(col, FLUORITE_BLUE + FLUORITE_VIOLET - col, CRYS_BAND_MIX * band), lz);
  (*m).alb = mix(FLUORITE_MILK, zoned, mix(1.0 - CRYS_PALE_MIX, 1.0, coloured));
  // glow: the view's path through the body, the light piped to the point
  let chord = min(shardExit(s, gp, r) / (2.0 * s.r), CRYS_PATH_MAX);
  let body = max(s.len - CRYS_TIP_K * s.r, 0.0);
  let pipe = select(1.0 - CRYS_PIPE, min(1.0 + CRYS_PIPE * CRYS_SIDE_AREA * body / (CRYS_TIP_AREA * s.r), CRYS_PIPE_MAX),
                    gCrysKind == CRYS_TIP);
  var glow = tr * mix(1.0, chord * pipe, lp);
  // which face: the hexagon side (or the face of the point above it) it faces
  var face = 0;
  var fb = -2.0;
  for (var i = 0; i < 6; i++) {
    let k = dot(n, CRYS_HEX[i].x * s.u + CRYS_HEX[i].y * s.w);
    if (k > fb) { fb = k; face = i; }
  }
  let fh = hash13(vec3f(s.seed * CRYS_SALT, f32(face), f32(gCrysKind)));
  glow *= 1.0 + CRYS_FACE_VAR * (2.0 * fh - 1.0) * lp;
  if (gCrysKind == CRYS_SIDE) {
    let st = vnoise(vec3f(dot(gp - s.o, s.a) * CRYS_STRIA_F, fh * CRYS_SALT, s.seed * CRYS_SALT2));
    glow *= 1.0 + CRYS_STRIA_GLOW * (2.0 * st - 1.0) * lodFade(CRYS_STRIA_F, fp);
  }
  glow *= mix(CRYS_ROOT_GLOW, 1.0, coloured);
  glow *= (1.0 + CRYS_ZONE_GLOW * (2.0 * band - 1.0) * lz) * (1.0 + CRYS_SEED_GLOW * (2.0 * fract(s.seed * CRYS_SALT2) - 1.0));
  return hotEmit(*m, id, T) * glow;
}

// The look of element id at world point p (grid units) on a surface with
// normal n, temperature T (°C). fp = pixel footprint (grid units) for LOD.
fn matOf(id: i32, p: vec3f, n: vec3f, T: f32, ctype: f32, fp: f32) -> Mat {
  var m: Mat;
  m.alb = ALBEDO(id); m.g = vec3f(0.0); m.tang = vec3f(1.0, 0.0, 0.0); m.sssCol = vec3f(1.0);
  m.rough = ROUGH(id); m.metal = METAL(id);
  m.f0 = (IOR(id) - 1.0) / (IOR(id) + 1.0); m.f0 *= m.f0;
  m.sss = SSS(id); m.glint = GLINT(id); m.glintDens = 1.0; m.cav = 1.0; m.aniso = 0.0; m.trans = 0.0;
  m.emit = vec3f(0.0);
  // anything hot glows (hotEmit, once the texture is known); lava does its own thing
  if (FU.matDetail < 0.5) {
    if (id == E_METAL) { m.emit = glowAt(m, id, T); } else { m.emit = hotEmit(m, id, T); }
    m.emit += sparkEmit(id, ctype);
    return m;
  }

  // Scale: a cell is CELL_M (src/scale.js). Frequencies below are cycles (or
  // lattice cells) per cell; the *_H / *_DEPTH bump amplitudes are heights in
  // cells. The natural materials give their sizes in metres (*_M) and convert.
  if (id == E_SAND) {
    // Dry sand. Its grains (~0.3 mm) are far below a pixel, so it reads as a
    // matte surface with soft mottling (sorting, damp patches), shallow
    // dimples, a faint grain-scale mottle and, up close, scattered dark
    // mineral grains. The sparkle of the quartz faces comes from the glints.
    // (slumps and clumps: sandSlumps, sandClumps)
    const GRAIN_M: f32 = 0.0067;              // m, wavelength
    const GRAIN_F: f32 = CELL_M / GRAIN_M;
    const GRAIN_H: f32 = 0.00048 / CELL_M;    // 0.5 mm, in cells
    const HUE: vec3f = vec3f(0.07, 0.0, -0.1);    // patches drift yellow-red .. grey
    const DARK_M: f32 = 0.0044;               // m: coarse dark grains ~4 mm apart
    const DARK_F: f32 = CELL_M / DARK_M;      // their lattice, per cell
    const DARK_P: f32 = 0.4;                  // how many, ...
    const DARK_R: f32 = 0.25;                 // ... how big (lattice units)
    const DARK_ALB: f32 = 0.45;               // their albedo relative to the sand
    const DARK_WARP: f32 = 0.000032 / (CELL_M * CELL_M);   // bends the grains out of round (cells per unit slope)
    const GRAIN_OCT: i32 = 2;                 // fBm octaves
    const PATCH_ALB: f32 = 0.25;              // albedo swing per unit of each noise
    const CLUMP_ALB: f32 = 0.18;
    const GRAIN_ALB: f32 = 0.3;
    const CLUMP_CAV: f32 = 0.4;               // cavity swing of the clumps
    let lo = sandSlumps(p, fp);
    let gr = sandClumps(p, fp);
    let fg = mFbmD(p, GRAIN_F, GRAIN_OCT, fp);
    var dh: f32;
    let dk = mDots(p + DARK_WARP * fg.yzw, DARK_F, DARK_P, DARK_R, fp, &dh);
    m.alb *= (1.0 + PATCH_ALB * lo.x + CLUMP_ALB * gr.x + GRAIN_ALB * fg.x) * (1.0 + HUE * lo.x) * mix(1.0, DARK_ALB, dk.x);
    m.g = SAND_SLUMP_H * lo.yzw + SAND_CLUMP_H * gr.yzw + GRAIN_H * fg.yzw;
    m.cav = 1.0 + CLUMP_CAV * gr.x;
  } else if (id == E_STONE) {
    // Rubble: angular chips of broken rock in two sizes, big CHUNK_M blocks
    // with small PEBBLE_M chips packed into the gaps between them, and dark
    // voids where neither reaches. Each chip is a cellular cell (measured
    // within the surface): its outline is the cell's polygon, sharp-cornered,
    // and its top two flat faces meeting at a ridge, the whole tilted its own
    // way, so each face catches the light differently. Chips sit at different
    // depths in the heap (the lower, the darker), and the gaps between them
    // are contact shadow fading into dark voids, not an even grout line. No
    // domes and no even tiling: those read as cobbled paving, a solid.
    // (small-chip size and tones: PEBBLE_M, PEB_* above, shared with gfx/grains.js)
    const CHUNK_M: f32 = 0.11;                // m: a big chip
    const CHUNK_F: f32 = CELL_M / CHUNK_M;
    const CHUNK_P: f32 = 0.6;                 // share of big-chip cells holding one (the rest is small chips)
    const CHUNK_R_MIN: f32 = 0.3;             // big-chip radius range, lattice units (cuts the polygon)
    const CHUNK_R_VAR: f32 = 0.4;
    const SMALL_R_MIN: f32 = 0.35;            // small-chip radius range, lattice units
    const SMALL_R_VAR: f32 = 0.35;
    const GAP: f32 = 0.05;                    // gap where two chips meet, lattice units
    const RIM: f32 = 0.03;                    // edge sharpness, lattice units
    const SHADOW_W: f32 = 0.18;               // contact shadow in from a chip's edge, lattice units
    const SHADOW: f32 = 0.55;                 // darkening at the edge
    const RIDGE: f32 = 0.7;                   // slope of the two faces either side of a chip's ridge
    const DEPTH_MIN: f32 = 0.5;               // albedo of the deepest chips (the top ones 1)
    const RIDGE_SALT: f32 = 5.37;             // decorrelates the ridge's direction from the tilt
    const BEVEL: f32 = 0.12;                  // edge bevel width, lattice units
    const BEVEL_SLOPE: f32 = 1.2;             // the bevel's slope (it rolls off into the gap)
    const TILT: f32 = 0.5;                    // slope of a chip's tilt, at most
    const EDGE_CAV: f32 = 0.5;                // occlusion at a chip's edge
    const MEAN: f32 = 0.8;                    // area-average shade of chips and voids (the far look)
    const GRIT_M: f32 = 0.0073;               // grit in the voids: wavelength, ...
    const GRIT_H_M: f32 = 0.0008;             // ... relief (m)
    const GRIT_F: f32 = CELL_M / GRIT_M;
    const GRIT_H: f32 = GRIT_H_M / CELL_M;
    const GRIT_ALB: f32 = 0.8;                // albedo swing per unit of the grit
    const CHIP_LOD: f32 = 2.0;                // outlines are sharp: fade them at this multiple of the chip frequency
    const SMALL_SALT: f32 = 17.3;             // decorrelates the small chips' lattice from the big ones'
    const GRIT_OCT: i32 = 2;                  // fBm octaves
    var geB: vec3f;
    var r1B: vec3f;
    var geS: vec3f;
    var r1S: vec3f;
    let cb = mCell(p * CHUNK_F, &geB, &r1B);
    let cs = mCell(p * PEBBLE_F + SMALL_SALT, &geS, &r1S);
    let lwB = lodFade(CHUNK_F * CHIP_LOD, fp);
    let lwS = lodFade(PEBBLE_F * CHIP_LOD, fp);
    // distance in from each chip's outline (lattice units; < 0 outside it)
    let dB = length(r1B - n * dot(r1B, n));
    let dS = length(r1S - n * dot(r1S, n));
    let eB = select(-1.0, min(CHUNK_R_MIN + CHUNK_R_VAR * cb.w - dB, cb.y - GAP), cb.z < CHUNK_P);
    let eS = min(SMALL_R_MIN + SMALL_R_VAR * cs.w - dS, cs.y - GAP);
    let onB = smoothstep(0.0, RIM, eB) * lwB;
    let onS = smoothstep(0.0, RIM, eS) * lwS * (1.0 - onB);
    // the chip there: its hashes, edge distance, edge gradient
    let big = onB > 0.0;
    let c = select(cs, cb, big);
    let e = select(eS, eB, big);
    let ge = select(geS, geB, big);
    let pm = onB + onS;                       // 1 on a chip, 0 in a void
    // a flat face tilted its own way, rolled off at the bevel
    var tilt = TILT * (2.0 * vec3f(c.z, c.w, fract(c.z * 7.31 + c.w * 3.17)) - 1.0);
    tilt -= n * dot(tilt, n);
    // the ridge: a line through the chip's seed; each side rises toward it
    let r1 = select(r1S, r1B, big);
    let rt = r1 - n * dot(r1, n);             // to the seed, within the surface
    var ax = hash33(vec3f(c.zw, RIDGE_SALT)) - 0.5;
    ax -= n * dot(ax, n);
    ax /= max(length(ax), 1e-4);
    tilt += RIDGE * sign(dot(rt, ax)) * ax;
    let bev = 1.0 - smoothstep(0.0, BEVEL, e);
    var gEdge = BEVEL_SLOPE * bev * ge;       // ge: gradient of the edge distance (points into the chip)
    gEdge -= n * dot(gEdge, n);
    let gr = mFbmD(p, PEB_MOTTLE_F, PEB_MOTTLE_OCT, fp);
    let gt = mFbmD(p, GRIT_F, GRIT_OCT, fp);
    let depth = mix(DEPTH_MIN, 1.0, fract(c.z * 3.91 + c.w * 11.3));
    let shadow = 1.0 - SHADOW * (1.0 - smoothstep(0.0, SHADOW_W, e));
    let chip = pebbleRock(fract(c.z * 13.7 + c.w)) * (PEB_SHADE_MIN + PEB_SHADE_RANGE * c.w) * (1.0 + PEB_MOTTLE_ALB * gr.x) * depth * shadow;
    let voids = PEB_VOID_ALB * (1.0 + GRIT_ALB * gt.x) * vec3f(1.0);
    let lw = max(lwB, lwS);
    m.alb *= mix(vec3f(MEAN), mix(voids, chip, pm), lw);
    m.g = pm * (tilt + gEdge) + (1.0 - pm) * lw * GRIT_H * gt.yzw + PEB_MOTTLE_H * gr.yzw;
    m.cav = mix(MEAN, mix(PEB_VOID_CAV, (1.0 - EDGE_CAV * bev) * depth, pm), lw);
    m.rough += (PEB_ROUGH_VAR * (c.w - 0.5) - PEB_POLISH * pm) * lw;
  } else if (id == E_SNOW) {
    // Old powder snow: soft drifts, clumps and (up close) a sugary crust of
    // crystals; the sparkle comes from the glints.
    // (drifts and clumps: snowDrifts, snowClumps)
    const CRYSTAL_M: f32 = 0.008;             // m, wavelength
    const CRYSTAL_F: f32 = CELL_M / CRYSTAL_M;
    const CRYSTAL_H: f32 = 0.00064 / CELL_M;  // 0.6 mm, in cells
    const CRYSTAL_OCT: i32 = 2;               // fBm octaves
    const DRIFT_ALB: f32 = 0.03;              // albedo swing per unit of each noise
    const CLUMP_ALB: f32 = 0.04;
    const DEEP_TINT: vec3f = vec3f(0.8, 0.94, 1.12);  // deep-scattered light: ice absorbs red
    const GLINT_DENS: f32 = 1.4;              // ice crystals: more facets than sand
    let lo = snowDrifts(p, fp);
    let gr = snowClumps(p, fp);
    let cr = mFbmD(p, CRYSTAL_F, CRYSTAL_OCT, fp);
    m.alb *= 1.0 + DRIFT_ALB * lo.x + CLUMP_ALB * gr.x;
    m.g = SNOW_DRIFT_H * lo.yzw + SNOW_CLUMP_H * gr.yzw + CRYSTAL_H * cr.yzw;
    m.sssCol = DEEP_TINT;
    m.glintDens = GLINT_DENS;
  } else if (id == E_GUNPOWDER) {
    // Black powder: graphite-glazed granules (~1 mm) with a soft silvery
    // sheen, a granular mottle in colour and gloss, and many tiny glints.
    const GRAIN_M: f32 = 0.0089;              // m, granule mottle wavelength
    const GRAIN_F: f32 = CELL_M / GRAIN_M;
    const GRAIN_H: f32 = 0.00032 / CELL_M;    // 0.3 mm, in cells
    const GRAIN_OCT: i32 = 3;                 // fBm octaves
    const LUMP_ALB: f32 = 0.2;                // albedo swing per unit of each noise
    const GRAIN_ALB: f32 = 0.7;
    const GRAIN_ROUGH: f32 = 0.1;             // gloss and cavity swing of the granules
    const GRAIN_CAV: f32 = 0.6;
    const GLINT_DENS: f32 = 1.3;              // relative glint density (fine granules)
    let lo = powderLumps(p, fp);
    let gr = mFbmD(p, GRAIN_F, GRAIN_OCT, fp);
    m.alb *= (1.0 + LUMP_ALB * lo.x) * (1.0 + GRAIN_ALB * gr.x);
    m.g = POWDER_LUMP_H * lo.yzw + GRAIN_H * gr.yzw;
    m.rough += GRAIN_ROUGH * gr.x;
    m.cav = 1.0 + GRAIN_CAV * gr.x;
    m.glintDens = GLINT_DENS;
  } else if (id == E_ASH) {
    // Wood ash: pale, very fine and soft, with flecks of charcoal.
    const FINE_M: f32 = 0.0089;               // m, wavelength
    const FINE_F: f32 = CELL_M / FINE_M;
    const FINE_H: f32 = 0.00048 / CELL_M;     // 0.5 mm, in cells
    const FLECK_M: f32 = 0.013;               // m between fleck sites
    const FLECK_F: f32 = CELL_M / FLECK_M;
    const FLECK_P: f32 = 0.6;                 // flecks up to ~8 mm
    const FLECK_R: f32 = 0.3;
    const FLECK_WARP: f32 = 0.00016 / (CELL_M * CELL_M);   // bends flecks out of round (cells per unit slope)
    const FLECK_SETTLE: f32 = 1.5;            // how strongly flecks gather in the hollows
    const CHARCOAL: vec3f = vec3f(0.025, 0.024, 0.023);
    const CHARCOAL_ROUGH: f32 = 0.6;
    const FLECK_SHARE: f32 = 0.5;             // share of fleck sites filled where the lumps are at their mean height
    const FLECK_BLACK_MIN: f32 = 0.4;         // fleck-to-fleck blackness
    const FLECK_BLACK_RANGE: f32 = 0.6;
    const FINE_OCT: i32 = 2;                  // fBm octaves
    const LUMP_ALB: f32 = 0.2;                // albedo swing per unit of each noise
    const FINE_ALB: f32 = 0.2;
    const LUMP_CAV: f32 = 0.4;                // cavity swing of the lumps
    let lo = ashLumps(p, fp);
    let gr = mFbmD(p, FINE_F, FINE_OCT, fp);
    var fh: f32;
    // flecks gather where the lumps are low (they settle) and vary in blackness
    let fl = mDots(p + FLECK_WARP * gr.yzw, FLECK_F, FLECK_P * clamp(FLECK_SHARE - FLECK_SETTLE * lo.x, 0.0, 1.0), FLECK_R, fp, &fh);
    m.alb *= 1.0 + LUMP_ALB * lo.x + FINE_ALB * gr.x;
    m.alb = mix(m.alb, CHARCOAL, fl.x * mix(1.0, FLECK_BLACK_MIN + FLECK_BLACK_RANGE * fh, lodFade(FLECK_F, fp)));
    m.rough = mix(m.rough, CHARCOAL_ROUGH, fl.x);
    m.g = ASH_LUMP_H * lo.yzw + FINE_H * gr.yzw;
    m.cav = 1.0 + LUMP_CAV * lo.x;
  } else if (id == E_WOOD) {
    // Bark: long corky plates split by deep V furrows. The plates are
    // cellular cells stretched along y (and turned about it so nothing lines
    // up with the grid), so the furrows interlace like oak or pine bark
    // instead of closing into loops. Each plate is slightly domed, has its
    // own shade and greyness, and flaky layers across it; the furrows are
    // in shade and show the darker, redder inner bark.
    // (plates and furrows: woodPlates)
    const FLAKE_W_M: f32 = 0.027;             // m: flaky layers across a plate (across, ...
    const FLAKE_L_M: f32 = 0.0089;            // ... along)
    const FLAKE_FH: f32 = CELL_M / FLAKE_W_M;
    const FLAKE_FV: f32 = CELL_M / FLAKE_L_M;
    const FLAKE_H: f32 = 0.00032 / CELL_M;
    const FIB_W_M: f32 = 0.0057;              // m: fibres (across, ...
    const FIB_L_M: f32 = 0.05;                // ... along)
    const FIB_FH: f32 = CELL_M / FIB_W_M;
    const FIB_FV: f32 = CELL_M / FIB_L_M;
    const FIB_H: f32 = 0.00024 / CELL_M;
    const RIDGE_MEAN: f32 = 0.7;              // area fraction of plate (the far-away mix)
    const FURROW: vec3f = vec3f(0.25, 0.2, 0.18);    // inner bark in shade, relative to the base colour
    const GREY: vec3f = vec3f(1.05, 1.1, 1.22);      // weathered outer bark
    const PLATE_SHADE_MIN: f32 = 0.7;         // plate-to-plate shade
    const PLATE_SHADE_RANGE: f32 = 0.6;
    const MEANDER_ALB: f32 = 0.4;             // albedo swing per unit of each noise
    const FLAKE_ALB: f32 = 0.3;
    const FIB_ALB: f32 = 0.25;
    const FURROW_CAV: f32 = 0.3;              // cavity term down in a furrow
    const FLAKE_SALT: vec3f = vec3f(13.1);    // noise offsets (decorrelate the layers)
    const FIB_SALT: vec3f = vec3f(5.7);
    var mv: vec4f;
    var c: vec4f;
    var fr: f32;   // 0 down a fissure .. 1 on a ridge
    let pl = woodPlates(p, fp, &mv, &c, &fr);
    let fl = mNoiseJ(p, TURN_Y30 * mat3x3f(FLAKE_FH, 0.0, 0.0, 0.0, FLAKE_FV, 0.0, 0.0, 0.0, FLAKE_FH), FLAKE_SALT);
    let fb = mNoiseJ(p, TURN_Y30 * mat3x3f(FIB_FH, 0.0, 0.0, 0.0, FIB_FV, 0.0, 0.0, 0.0, FIB_FH), FIB_SALT);
    // narrow furrows alias sooner than the plate frequency says
    let lwF = lodFade(WOOD_PLATE_FH * WOOD_FURROW_LOD, fp);
    let lwL = lodFade(FLAKE_FV, fp);
    let lwB = lodFade(FIB_FH, fp);
    let ridge = smoothstep(0.0, WOOD_FUR_W, c.y);   // 0 in a furrow, 1 on a plate
    let rl = mix(RIDGE_MEAN, ridge, lwF);
    let plate = mix(vec3f(1.0), (PLATE_SHADE_MIN + PLATE_SHADE_RANGE * c.z) * mix(vec3f(1.0), GREY, c.w), lwF);
    // (fissures keep the bark's mean albedo: they darken their share, the ridges make it up)
    m.alb *= mix(FURROW, plate, rl) * mix(FURROW, vec3f(1.0), fr) / mix(FURROW, vec3f(1.0), WOOD_FISSURE_MEAN) * (1.0 + MEANDER_ALB * mv.x)
           * (1.0 + FLAKE_ALB * lwL * (fl.x - 0.5)) * (1.0 + FIB_ALB * lwB * (fb.x - 0.5));
    m.g = pl.yzw + lwL * FLAKE_H * ridge * fl.yzw + lwB * FIB_H * fb.yzw;
    m.cav = mix(FURROW_CAV, 1.0, rl) * mix(FURROW_CAV, 1.0, fr);
    // Sawn end grain on top faces: growth rings around the pith of each log
    // (piths on a coarse jittered lattice), wobbling with the grain, latewood
    // bands darker, heartwood darker than sapwood.
    let top = woodEndGrain(n);
    if (top > 0.0) {
      const LOG_SIZE: f32 = 1.28 / CELL_M;    // cells between piths (1.28 m)
      const RING_M: f32 = 0.013;              // m, growth ring spacing
      const RING_F: f32 = CELL_M / RING_M;    // growth rings per cell
      const RING_WOBBLE_M: f32 = 0.1;         // m, wavelength of the rings' irregularity
      const RING_WOBBLE: f32 = 0.6;           // its amplitude (rings), ...
      const RING_WOBBLE_F: f32 = CELL_M / RING_WOBBLE_M;   // ... frequency
      const PITH_JITTER: f32 = 0.6;           // spread of a pith within its lattice cell
      const HEART_R: f32 = 0.24 / CELL_M;     // heartwood radius (24 cm), in cells
      const SAPWOOD: vec3f = vec3f(0.42, 0.28, 0.16);
      const HEARTWOOD: vec3f = vec3f(0.3, 0.17, 0.09);
      const LATEWOOD: f32 = 0.6;              // albedo of the latewood bands
      const LATE_EDGE: vec2f = vec2f(0.55, 0.95);   // ring phase over which a latewood band fades in
      const RING_LOD: f32 = 2.0;              // rings are sharp: fade them at this multiple of RING_F
      const HEART_EDGE: f32 = 0.7;            // heartwood fades to sapwood from this fraction of HEART_R
      const END_ROUGH: f32 = 0.65;            // sawn end grain
      const PITH_SALT: f32 = 7.7;             // decorrelates the pith hash
      const TURN2: mat2x2f = mat2x2f(0.8, 0.6, -0.6, 0.8);   // turns the pith lattice off the grid (~37°)
      let xz = TURN2 * p.xz / LOG_SIZE;
      let ci = floor(xz);
      var r2 = CELL_FAR;
      for (var k = 0; k < 9; k++) {
        let o = vec2f(f32(k % 3), f32(k / 3)) - 1.0;
        let dv = ci + o + 0.5 + PITH_JITTER * (hash33(vec3f(ci + o, PITH_SALT)).xy - 0.5) - xz;
        r2 = min(r2, dot(dv, dv));
      }
      let r = sqrt(r2) * LOG_SIZE;
      let rr = r * RING_F + RING_WOBBLE * vnoise(M_ROT * p * RING_WOBBLE_F);
      let ring = smoothstep(LATE_EDGE.x, LATE_EDGE.y, fract(rr)) * lodFade(RING_F * RING_LOD, fp);
      let endg = mix(HEARTWOOD, SAPWOOD, smoothstep(HEART_EDGE * HEART_R, HEART_R, r)) * mix(1.0, LATEWOOD, ring);
      m.alb = mix(m.alb, endg, top);
      m.g *= 1.0 - top;
      m.cav = mix(m.cav, 1.0, top);
      m.rough = mix(m.rough, END_ROUGH, top);
    }
  } else if (id == E_PLANT) {
    // Foliage: each cellular cell holds a leaf, an ellipse around its seed
    // (measured within the surface) along a random axis, with its own tilt,
    // size, hue and gloss and a paler midrib, cut by its cell where it meets
    // a neighbour. Between leaves the eye sees into the shaded depth of the clump.
    const LEAF_M: f32 = 0.035;                // m, leaf spacing
    const LEAF_F: f32 = CELL_M / LEAF_M;      // leaves per cell along a line
    const LEAF_R: f32 = 0.5;                  // leaf half-length range, lattice units
    const LEAF_RV: f32 = 0.3;
    const LEAF_ASPECT: f32 = 0.55;            // half-width / half-length
    const LEAF_TILT: f32 = 1.3;               // facing jitter; ...
    const LEAF_CURL: f32 = 0.024 / CELL_M;    // ... cupping toward the rim (m per lattice², in cells)
    const GAP: f32 = 0.04;                    // lattice units
    const RIM: f32 = 0.05;
    const DEPTH_ALB: f32 = 0.35;              // the clump's shaded interior
    const DEPTH_CAV: f32 = 0.2;
    const MEAN: f32 = 0.88;                   // area-average shade of leaves and depth (the far look)
    const RIB_W: f32 = 0.04;                  // midrib half-width (lattice units), ...
    const RIB_ALB: f32 = 1.2;                 // ... brightness
    const HUE_BLUE: vec3f = vec3f(0.8, 1.0, 0.6);     // leaf hue range
    const HUE_YELLOW: vec3f = vec3f(1.3, 1.1, 0.55);
    const SHADE_MIN: f32 = 0.65;              // leaf-to-leaf shade
    const SHADE_RANGE: f32 = 0.7;
    const WAX_VAR: f32 = 0.25;                // leaf-to-leaf roughness spread
    const DEEP_TINT: vec3f = vec3f(0.85, 1.15, 0.55);   // light that scattered through leaves
    const LEAF_LOD: f32 = 1.5;                // fade leaves at this multiple of LEAF_F
    const TILT_SALT: f32 = 0.37;              // hash input for a leaf's tilt
    const TILT_HASH_SCALE: f32 = 157.0;
    let lw = lodFade(LEAF_F * LEAF_LOD, fp);
    if (lw <= 0.0) {
      // Exactly the averaged result below. Do not search 27 cellular
      // neighbours for leaves that are already smaller than a pixel.
      m.alb *= MEAN;
      m.cav = MEAN;
    } else {
    var ge: vec3f;
    var r1: vec3f;
    let c = mCell(p * LEAF_F, &ge, &r1);
    let tilt = hash33(vec3f(c.z, c.w, TILT_SALT) * TILT_HASH_SCALE) - 0.5;
    let rt = r1 - n * dot(r1, n);             // to the seed, within the surface
    let ax = normalize(tilt - n * dot(tilt, n) + 1e-4);
    let along = dot(rt, ax);
    let across = dot(rt, cross(n, ax));
    let de = length(vec2f(along, across / LEAF_ASPECT));
    let e = min(LEAF_R + LEAF_RV * c.w - de, c.y - GAP);
    let pm = smoothstep(0.0, RIM, e);         // 1 on a leaf, 0 in the depth between
    let rib = (1.0 - smoothstep(0.0, RIB_W, abs(across))) * pm;
    let hue = mix(HUE_BLUE, HUE_YELLOW, c.z);   // blue-green .. yellow-green
    let leaf = hue * (SHADE_MIN + SHADE_RANGE * c.w) * mix(1.0, RIB_ALB, rib);
    m.g = lw * pm * (LEAF_TILT * tilt + LEAF_CURL * rt * LEAF_F);
    m.cav = mix(MEAN, mix(DEPTH_CAV, 1.0, pm), lw);
    m.alb *= mix(vec3f(MEAN), mix(DEPTH_ALB * hue, leaf, pm), lw);
    m.rough += WAX_VAR * (c.z - 0.5) * lw;     // some leaves waxier than others
    }
    let cl = leafClumps(p, fp);
    m.g += LEAF_CLUMP_H * cl.yzw;
    m.cav *= 1.0 + LEAF_CLUMP_CAV * cl.x;
    m.sssCol = DEEP_TINT;
    m.trans = 1.0;
  } else if (id == E_METAL) {
    // brushed steel: fine grooves along a fixed world direction, anisotropic highlight
    const BD: vec3f = vec3f(1.0, 0.1, 0.35);
    let t = normalize(BD - n * dot(n, BD) + 1e-5);
    let b = cross(n, t);
    // Brushing marks are far below a pixel: what shows is the stretched
    // highlight and faint streaks where the brushing pressure varied, plus
    // smudges where the polish is uneven.
    const STREAK_M: f32 = 0.0067;             // m, spacing of streaks and grooves across the brushing
    const GROOVE_M: f32 = 0.002;
    const STREAK_F: f32 = CELL_M / STREAK_M;  // per cell
    const GROOVE_F: f32 = CELL_M / GROOVE_M;
    const STREAK_LEN: f32 = 0.1;              // streak length, as a fraction of their spacing
    const SMUDGE_M: f32 = 0.23;               // m, smudge wavelength
    const SMUDGE_F: f32 = CELL_M / SMUDGE_M;
    const SMUDGE_OCT: i32 = 2;                // fBm octaves
    const STREAK_SLICE: f32 = 0.5;            // noise z slices (decorrelate the two)
    const GROOVE_SLICE: f32 = 7.5;
    const GROOVE_W: f32 = 0.6;                // grooves' weight relative to the streaks
    const SMUDGE_ROUGH: f32 = 0.1;            // roughness swing per unit of each
    const BRUSH_ROUGH: f32 = 0.08;
    const SMUDGE_ALB: f32 = 0.06;             // albedo swing per unit of each
    const BRUSH_ALB: f32 = 0.05;
    const BRUSH_ANISO: f32 = 0.7;             // anisotropy of the brushed highlight
    let u = dot(p, t);
    let w = dot(p, b);
    let s1 = vnoise(vec3f(u * STREAK_F * STREAK_LEN, w * STREAK_F, STREAK_SLICE));
    let s2 = vnoise(vec3f(u * GROOVE_F * STREAK_LEN, w * GROOVE_F, GROOVE_SLICE));
    let l1 = lodFade(STREAK_F, fp);
    let l2 = lodFade(GROOVE_F, fp);
    let lo = mFbmD(p, SMUDGE_F, SMUDGE_OCT, fp);
    let br = l1 * (s1 - 0.5) + GROOVE_W * l2 * (s2 - 0.5);
    m.rough = ROUGH(id) + SMUDGE_ROUGH * lo.x + BRUSH_ROUGH * br;
    m.alb *= 1.0 + SMUDGE_ALB * lo.x + BRUSH_ALB * br;
    m.tang = t; m.aniso = BRUSH_ANISO;
    // Hot steel grows black mill scale (magnetite): a rough dielectric, no
    // longer a metal mirroring the sky. It is patchy; where it is thick it
    // blisters off the steel and runs cooler, so the glow is mottled with dark
    // patches (a look only: the oxide isn't simulated and fades as it cools).
    let ox = smoothstep(OXIDE_T0, OXIDE_T1, T);
    var flakeT = T;   // temperature of the visible surface
    if (ox > 0.0) {
      let th = mFbmD(p, SCALE_FREQ, SCALE_OCT, fp);   // scale thickness, centred on 0
      m.alb = mix(m.alb, OXIDE_ALB * (1.0 + SCALE_ALB_VAR * th.x), ox);
      m.metal *= 1.0 - ox;
      m.f0 = mix(m.f0, OXIDE_F0, ox);
      m.rough = mix(m.rough, OXIDE_ROUGH, ox);
      m.aniso *= 1.0 - ox;
      m.g = mix(m.g, SCALE_BUMP * th.yzw, ox);
      flakeT = T - ox * SCALE_DROP * smoothstep(-SCALE_SPLIT, SCALE_SPLIT, th.x + SCALE_COVER);
    }
    // steel conducts: no skin of its own, only the insulating flakes run cooler
    m.emit = glowAt(m, id, flakeT);
  } else if (id == E_CRYSTAL) {
    let e = crystalLook(&m, id, p, n, T, fp);
    m.emit = e;
  } else if (id == E_CLONE) {
    // Polished gold: a faint waviness left by the polishing and a fine haze
    // in the gloss. No blotches: gold doesn't tarnish.
    const WAVE_M: f32 = 0.16;                 // m, wavelengths of the waviness ...
    const HAZE_M: f32 = 0.013;                // ... and the haze
    const WAVE_F: f32 = CELL_M / WAVE_M;      // per cell
    const HAZE_F: f32 = CELL_M / HAZE_M;
    const WAVE_H: f32 = 0.0012 / CELL_M;      // 1.2 mm, in cells
    const WAVE_OCT: i32 = 2;                  // fBm octaves
    const HAZE_OCT: i32 = 2;
    const WAVE_ROUGH: f32 = 0.05;             // roughness swing per unit of each noise
    const HAZE_ROUGH: f32 = 0.03;
    let lo = mFbmD(p, WAVE_F, WAVE_OCT, fp);
    let hz = mFbmD(p, HAZE_F, HAZE_OCT, fp);
    m.g = WAVE_H * lo.yzw;
    m.rough += WAVE_ROUGH * lo.x + HAZE_ROUGH * hz.x;
  } else if (id == E_WALL) {
    // Cast concrete: cloudy mottling from the pour, fine sand-and-cement
    // grit, scattered round air-bubble pits ("bug holes", up to ~1 cm) and
    // faint rain streaks down vertical faces.
    const MOTTLE_M: f32 = 0.44;               // m, wavelengths
    const GRIT_M: f32 = 0.016;
    const MOTTLE_F: f32 = CELL_M / MOTTLE_M;  // per cell
    const GRIT_F: f32 = CELL_M / GRIT_M;
    const MOTTLE_H: f32 = 0.0048 / CELL_M;    // 4.8 mm, ...
    const GRIT_H: f32 = 0.001 / CELL_M;       // ... 1 mm, in cells
    const PIT_M: f32 = 0.036;                 // m, spacing of the pit lattice
    const PIT_F: f32 = CELL_M / PIT_M;
    const PIT_P: f32 = 0.3;
    const PIT_R: f32 = 0.22;
    const PIT_DEPTH: f32 = 0.0003 / CELL_M;   // pits 0.3 mm deep
    const PIT_ALB: f32 = 0.45;                // a pit's shadowed floor
    const STREAK_W_M: f32 = 0.032;            // m, streak spacing across ...
    const STREAK_L_M: f32 = 0.67;             // ... and length down
    const STREAK_FH: f32 = CELL_M / STREAK_W_M;
    const STREAK_FV: f32 = CELL_M / STREAK_L_M;
    const STREAK_DARK: f32 = 0.12;
    const STREAK_EDGE: vec2f = vec2f(0.45, 0.85);   // noise range over which a streak fades in
    const STREAK_SALT: f32 = 2.3;             // noise offset of the streaks
    const MOTTLE_OCT: i32 = 3;                // fBm octaves
    const GRIT_OCT: i32 = 3;
    const MOTTLE_ALB: f32 = 0.35;             // albedo swing per unit of each noise
    const GRIT_ALB: f32 = 0.25;
    const PIT_CAV: f32 = 0.6;                 // cavity: down in a pit, ...
    const GRIT_CAV: f32 = 0.3;                // ... swing with the grit
    const GRIT_ROUGH: f32 = 0.08;             // roughness swing with the grit
    let lo = mFbmD(p, MOTTLE_F, MOTTLE_OCT, fp);
    let gr = mFbmD(p, GRIT_F, GRIT_OCT, fp);
    var ph: f32;
    let pit = mDots(p, PIT_F, PIT_P, PIT_R, fp, &ph);
    let st = vnoise(TURN_Y30 * (p * vec3f(STREAK_FH, STREAK_FV, STREAK_FH)) + STREAK_SALT);
    let streak = STREAK_DARK * (1.0 - abs(n.y)) * smoothstep(STREAK_EDGE.x, STREAK_EDGE.y, st) * lodFade(STREAK_FH, fp);
    m.alb *= (1.0 + MOTTLE_ALB * lo.x + GRIT_ALB * gr.x) * mix(1.0, PIT_ALB, pit.x) * (1.0 - streak);
    m.g = MOTTLE_H * lo.yzw + GRIT_H * gr.yzw - PIT_DEPTH * pit.yzw;
    m.cav = (1.0 - PIT_CAV * pit.x) * (1.0 + GRIT_CAV * gr.x);
    m.rough += GRIT_ROUGH * gr.x;
  } else if (SURF(id) == SURF_CRAG) {
    // Natural rock, ROCK's weathered basalt the reference: big lumps, then
    // craggy relief from several octaves of crease noise (flat-topped knobs
    // between sharp V creases, each octave turned and warped by the lumps,
    // so the creases of one scale break up those of the next instead of
    // drawing a network), dark in its hollows; rusty oxidised and pale
    // weathered patches, faint flow banding and, up close, clusters of gas
    // vesicles. No cell lattice: that read as paving. Each element scales
    // these by its CRAG(id) (gfx/materials.js crag): the relief, the pits
    // (vesicles; a limestone's solution pits), the banding (a sedimentary
    // rock's bedding) and the rust stains.
    // (lumps and crags: rockLumps, rockCrags)
    const GRAIN_M: f32 = 0.018;               // m, gritty surface (3 octaves, to ~4 mm)
    const GRAIN_F: f32 = CELL_M / GRAIN_M;
    const GRAIN_H: f32 = 0.0036 / CELL_M;
    const TINT_M: f32 = 0.89;                 // m, oxidised / weathered patches
    const TINT_F: f32 = CELL_M / TINT_M;
    const RUST: vec3f = vec3f(1.18, 0.98, 0.86);
    const PALE: vec3f = vec3f(1.3, 1.3, 1.28);
    const RUST_EDGE: vec2f = vec2f(0.6, 0.8);     // tint-noise ranges of the patches
    const PALE_EDGE: vec2f = vec2f(0.35, 0.15);
    const SKY_EDGE: vec2f = vec2f(0.2, 0.8);      // n.y range over which a face counts as sky-facing
    const BAND_W_M: f32 = 1.6;                // m: lava-flow banding (across, ...
    const BAND_H_M: f32 = 0.2;                // ... up)
    const BAND_FH: f32 = CELL_M / BAND_W_M;
    const BAND_FV: f32 = CELL_M / BAND_H_M;
    const BAND_LO: vec3f = vec3f(0.94, 0.96, 1.0);
    const BAND_HI: vec3f = vec3f(1.06, 1.0, 0.94);
    const VES_M: f32 = 0.0114;                // m between vesicle sites
    const VES_F: f32 = CELL_M / VES_M;
    const VES_P: f32 = 0.55;
    const VES_R: f32 = 0.32;
    const VES_DEPTH: f32 = 0.00024 / CELL_M;
    const VES_ALB: f32 = 0.35;
    const VES_CLUSTER_M: f32 = 0.27;          // m: vesicles come in patches
    const VES_CLUSTER_F: f32 = CELL_M / VES_CLUSTER_M;
    const VES_CLUSTER_EDGE: vec2f = vec2f(0.45, 0.7);
    const VES_WARP: f32 = 0.000128 / (CELL_M * CELL_M);   // bends vesicles out of round (cells per unit slope)
    const GRAIN_OCT: i32 = 3;                 // fBm octaves
    const TINT_SALT: f32 = 1.7;               // noise offsets
    const VES_CLUSTER_SALT: f32 = 6.1;
    const LUMP_ALB: f32 = 0.35;               // albedo swing per unit of each
    const GRAIN_ALB: f32 = 0.6;
    const CRAG_ALB: f32 = 0.6;
    const HOLLOW_CAV: f32 = 0.8;              // cavity: hollows of the relief, vesicles, grit
    const VES_CAV: f32 = 0.6;
    const GRAIN_CAV: f32 = 0.6;
    const GRAIN_ROUGH: f32 = 0.1;             // roughness swing with the grit
    let cp = CRAG(id);                        // (relief, pits, bands, stain), ROCK's = 1
    let lo = rockLumps(p, fp);
    var ws: f32;
    let cg = rockCrags(p, lo, fp, &ws);
    let hc = cp.x * cg.x / ws;                // relief about its mean, roughly ±0.5
    let gc = cp.x * cg.yzw;
    let gr = mFbmD(p, GRAIN_F, GRAIN_OCT, fp);
    let tn = vnoise(M_ROT * p * TINT_F + TINT_SALT);
    let rust = cp.w * smoothstep(RUST_EDGE.x, RUST_EDGE.y, tn);
    let pale = smoothstep(PALE_EDGE.x, PALE_EDGE.y, tn) * smoothstep(SKY_EDGE.x, SKY_EDGE.y, n.y);   // weathering on what faces the sky
    let band = vnoise(vec3f(p.x * BAND_FH, p.y * BAND_FV, p.z * BAND_FH));
    let bandLo = 1.0 + cp.z * (BAND_LO - 1.0);
    let bandHi = 1.0 + cp.z * (BAND_HI - 1.0);
    var ves = vec4f(0.0);
    if (cp.y > 0.0) {
      var vh: f32;
      let vp = cp.y * VES_P * smoothstep(VES_CLUSTER_EDGE.x, VES_CLUSTER_EDGE.y, vnoise(M_ROT * p * VES_CLUSTER_F + VES_CLUSTER_SALT));
      ves = mDots(p + VES_WARP * gr.yzw, VES_F, vp, VES_R, fp, &vh);
    }
    m.alb *= (1.0 + LUMP_ALB * lo.x + GRAIN_ALB * gr.x) * (1.0 + CRAG_ALB * hc)
           * mix(vec3f(1.0), RUST, rust) * mix(vec3f(1.0), PALE, pale) * mix(bandLo, bandHi, band)
           * mix(1.0, VES_ALB, ves.x);
    m.g = ROCK_LUMP_H * lo.yzw + ROCK_CRAG_H * gc + GRAIN_H * gr.yzw - VES_DEPTH * ves.yzw;
    m.cav = (1.0 + HOLLOW_CAV * min(hc, 0.0)) * (1.0 - VES_CAV * ves.x) * (1.0 + GRAIN_CAV * gr.x);
    m.rough += GRAIN_ROUGH * gr.x;
  } else if (id == E_LAVA) {
    // Molten well above the solidus; nearer it a crust skins over. The crust
    // radiates its heat away far below the bulk temperature and breaks into
    // plates: the cracks between them show the melt, brightest down the middle
    // and dull red where they meet the cooler plate edges.
    let Ts = solidusOf(ctype);
    let sk = mFbmD(p + vec3f(0.0, FU.time * LAVA_CHURN, 0.0), LAVA_SKIN_FREQ, LAVA_SKIN_OCT, fp);   // churning skin
    let x = (T - Ts) / LAVA_MELT_RANGE + LAVA_SKIN_VAR * sk.x;   // 0 = at the solidus, 1 = fully molten
    let crust = 1.0 - smoothstep(LAVA_CRUST_X0, LAVA_CRUST_X1, x);
    var ge: vec3f;
    var r1: vec3f;
    let c = mCell(p * LAVA_PLATE_FREQ, &ge, &r1);   // crust plates
    let lwc = lodFade(LAVA_PLATE_FREQ * LAVA_CRACK_LOD, fp);
    // crack half-width: hairlines once the crust has set, wide enough to
    // swallow the plates once it has broken up
    let w = mix(LAVA_CRACK_SHUT, LAVA_CRACK_OPEN, (1.0 - crust) * (1.0 - crust));
    let crk = mix(1.0 - smoothstep(LAVA_CRACK_CORE * w, w, c.y), min(LAVA_CRACK_AREA * w, 1.0), 1.0 - lwc);   // open melt
    let rim = 1.0 - smoothstep(LAVA_CRACK_CORE * w, w + LAVA_RIM, c.y);   // 1 in the melt .. 0 on the plate
    let Tmelt = T + LAVA_SKIN_DT * sk.x;
    // young crust is thin and still glows; old crust is cold on top
    let Tcrust = mix(T, min(T, LAVA_CRUST_T + LAVA_CRUST_K * (T - Ts)), crust);
    let eNear = emission(id, mix(Tcrust, Tmelt, rim * rim));
    let eFar = mix(emission(id, Tcrust), emission(id, Tmelt), crk);
    m.emit = mix(eFar, eNear, lwc);
    let solid = 1.0 - crk;
    m.alb = mix(LAVA_MELT_ALB, ALBEDO(id) * (1.0 + LAVA_CRUST_VAR * (c.z - 0.5)), solid);
    m.rough = mix(LAVA_MELT_ROUGH, LAVA_CRUST_ROUGH, solid);
    m.g = solid * lwc * LAVA_PLATE_BUMP * dSmooth(0.0, LAVA_PLATE_EDGE, c.y) * ge * LAVA_PLATE_FREQ
        + (1.0 - solid) * LAVA_SKIN_BUMP * sk.yzw;
    m.cav = mix(1.0, mix(LAVA_CRACK_CAV, 1.0, smoothstep(0.0, LAVA_PLATE_EDGE, c.y)), solid * lwc);
  }
  if (id != E_LAVA && id != E_METAL && id != E_CRYSTAL) { m.emit = hotEmit(m, id, T); }
  m.emit += sparkEmit(id, ctype);   // a live conductor (src/electricity.js)
  return m;
}

// Base colour of an element at world point p (kept for callers that only need
// a colour). Another call site of matOf: a module that also shades surfaces
// compiles matOf twice if it calls this.
fn albedoOf(id: i32, p: vec3f, seed: f32) -> vec3f {
  return matOf(id, p, vec3f(0.0, 1.0, 0.0), AMBIENT, 0.0, 0.0).alb;
}

const MAT_ROUGH_MIN: f32 = 0.04;   // smoothest a textured surface may get (GGX roughness)
const BUMP_MAX_SLOPE: f32 = 1.5;   // cap on the bump's tangential height gradient
fn applyMat(s: ptr<function, Surf>, m: Mat) {
  (*s).albedo = max(m.alb, vec3f(0.0)); (*s).rough = clamp(m.rough, MAT_ROUGH_MIN, 1.0); (*s).metal = m.metal; (*s).f0 = m.f0;
  (*s).sss = m.sss; (*s).sssCol = m.sssCol; (*s).glint = m.glint; (*s).glintDens = m.glintDens;
  (*s).cav = clamp(m.cav, 0.0, 1.0); (*s).aniso = m.aniso; (*s).tang = m.tang; (*s).trans = m.trans; (*s).emit = m.emit;
  // bump: tilt the normal by the tangential part of the height gradient
  let ng = (*s).ng;
  var gt = m.g - ng * dot(ng, m.g);
  let gl = length(gt);
  if (gl > BUMP_MAX_SLOPE) { gt *= BUMP_MAX_SLOPE / gl; }
  (*s).n = normalize(ng - gt);
}
${relief ? reliefGLSL : ''}
// Surface record for a smooth-channel hit: blend the material of the cells of
// that channel around the point, weighted trilinearly. The two most common
// elements get a full material each; their border is broken up with noise so
// it doesn't follow the cell lattice.
const GATHER_DEPTH: f32 = 0.4;      // cells below the surface where the cells are weighted
const GATHER_W_MIN: f32 = 1e-3;     // weight floor: every cell of the channel counts a little
const GATHER_DEEP: f32 = 0.9;       // cells below the surface for the fallback search
const MAT_BORDER_EDGE: vec2f = vec2f(0.25, 0.75);   // share of the second element over which it takes over
const MAT_BORDER_F: f32 = 1.7;      // frequency of the noise breaking up that border, per cell
const MAT_BORDER_SALT: f32 = 2.9;   // its noise offset
const MAT_BORDER_AMP: f32 = 0.6;    // how far it shifts the share
// The material of a two-element mix at texture point p (r: share of id2).
// matOf is huge and a GPU compiler inlines every call to it: the two
// materials are one call in a loop, not two calls.
fn gatherMat(id1: i32, id2: i32, ct1: f32, ct2: f32, r: f32, p: vec3f, n: vec3f, T: f32, fp: f32) -> Mat {
  var k = 0.0;
  if (id2 >= 0) {
    k = smoothstep(MAT_BORDER_EDGE.x, MAT_BORDER_EDGE.y, r + (vnoise(M_ROT * p * MAT_BORDER_F + MAT_BORDER_SALT) - 0.5) * MAT_BORDER_AMP);
  }
  var m: Mat;
  let count = select(1, 2, k > 0.0);
  for (var j = 0; j < count; j++) {
    let mj = matOf(select(id2, id1, j == 0), p, n, T, select(ct2, ct1, j == 0), fp);
    if (j == 0) { m = mj; } else { m = mixMat(m, mj, k); }
  }
  return m;
}

// ---- flowing grains ----
// Moving sand carries its texture along: the flow-map technique of Valve's
// Portal 2 (Vlachos, "Water Flow in Portal 2", SIGGRAPH 2010; Valve's GDC
// 2011 talk on Portal 2's non-standard textures). The texture is read at a point
// pushed back along the grains' velocity by the time since its layer last
// reset. The velocity is the sim's flow field (the move kernel's, shaders/move.js),
// standing in for Portal 2's authored flow map. A layer pushed for long would
// stretch where the flow is uneven, so two layers run half a cycle apart and
// are crossfaded, each reset while unseen. The cycle phase is offset by noise
// so the resets don't pulse in unison.
// Pushing is centred on each layer's midpoint, so a layer strays at most half
// a cycle's travel. Grains at rest have no flow, so their texture stays put.
const FLOW_PERIOD: f32 = 32.0;      // sim steps per cycle of a texture layer
const FLOW_PHASE_F: f32 = 0.37;     // frequency of the noise offsetting the phase, per cell
const FLOW_MIN_TRAVEL: f32 = 0.01;  // cells a layer must travel in a cycle to count as moving
// phase of the first layer at p, in [0, 1); the second is half a cycle on
fn flowPhase(p: vec3f) -> f32 { return fract(FU.simClock / FLOW_PERIOD + vnoise(M_ROT * worldPos(p) * FLOW_PHASE_F)); }

fn gatherSurf(hp: vec3f, n: vec3f, ch: i32) -> Surf {
  var s: Surf;
  s.p = hp; s.tp = hp; s.tp1 = hp; s.flowW = 0.0; s.n = n; s.ng = n; s.ch = ch; s.id = E_EMPTY; s.cell = vec3i(floor(hp - n * 0.5)); s.seed = 0.0;
  s.face = vec3i(0, 1, 0);${relief ? `
  if (gRelOn) { s.tp = gRelQ; s.tp1 = gRelQ; }   // a carved hit's texture lies over the envelope (gfx/relief.js)` : ''}
  let q = hp - n * GATHER_DEPTH - 0.5;
  let c0 = vec3i(floor(q));
  let f = q - vec3f(c0);
  var id1 = -1;
  var id2 = -1;
  var w1 = 0.0;
  var w2 = 0.0;
  var T = 0.0;
  var wsum = 0.0;
  var wbest = -1.0;
  var ct1 = 0.0;
  var ct2 = 0.0;
  let flowing = ch == CH_GRANULAR;   // grains' texture moves with them (flowing grains)
  var vel = vec3f(0.0);
  for (var i = 0; i < 8; i++) {
    let o = vec3i(i & 1, (i >> 1u) & 1, (i >> 2u) & 1);
    let c = c0 + o;
    if (outside(c)) { continue; }
    let a = fetchA(c);
    let id = eid(a);
    if (SURFCH(id) != ch) { continue; }
    let wv = mix(1.0 - f, f, vec3f(o));
    let w = wv.x * wv.y * wv.z + GATHER_W_MIN;
    T += w * a.y;
    wsum += w;
    if (flowing) { vel += w * cellFlow(c); }
    if (id1 < 0 || id == id1) {
      id1 = id; w1 += w;
      if (w > wbest) { wbest = w; s.cell = c; s.seed = fract(a.w); ct1 = floor(a.w); }
    } else if (id2 < 0 || id == id2) {
      if (id2 < 0) { ct2 = floor(a.w); }
      id2 = id; w2 += w;
    }
  }
  if (wsum == 0.0) {
    // the smoothed surface spilled past its own cells: look a bit deeper
    let cc = vec3i(floor(hp - n * GATHER_DEEP));
    for (var i = 0; i < 27 && wsum == 0.0; i++) {
      let c = cc + vec3i(i % 3, (i / 3) % 3, i / 9) - 1;
      if (outside(c)) { continue; }
      let a = fetchA(c);
      let id = eid(a);
      if (SURFCH(id) != ch) { continue; }
      id1 = id; w1 = 1.0; T = a.y; wsum = 1.0; s.cell = c; s.seed = fract(a.w); ct1 = floor(a.w);
      if (flowing) { vel = cellFlow(c); }
    }
  }
  if (wsum == 0.0) {
    if (ch == CH_LIQUID) { id1 = E_WATER; } else if (ch == CH_MOLTEN) { id1 = E_LAVA; } else if (ch == CH_GRANULAR) { id1 = E_SAND; } else { id1 = E_PLANT; }
    w1 = 1.0; T = AMBIENT; wsum = 1.0;
  }
  if (w2 > w1) {
    let ti = id1; id1 = id2; id2 = ti;
    let tw = w1; w1 = w2; w2 = tw;
    let tc = ct1; ct1 = ct2; ct2 = tc;
  }
  s.id = id1;
  s.T = T / wsum;
  let fp = footprint(hp);
  let r = select(0.0, w2 / (w1 + w2), id2 >= 0);
  let travel = vel / wsum * FLOW_PERIOD;   // cells a layer moves in a cycle
  if (flowing && length(travel) > FLOW_MIN_TRAVEL) {
    let ph = flowPhase(hp);
    let ph1 = fract(ph + 0.5);
    s.tp1 = s.tp - travel * (ph1 - 0.5);
    s.tp -= travel * (ph - 0.5);
    s.flowW = abs(2.0 * ph - 1.0);   // 0 while the second layer resets, 1 while the first does
  }
  // the texture is anchored in the world (tp, tp1 stay grid points: footprints and glints take them);
  // the flow layers: one gatherMat call in a loop (see gatherMat)
  var m: Mat;
  let layers = select(1, 2, s.flowW > 0.0);
  for (var j = 0; j < layers; j++) {
    let mj = gatherMat(id1, id2, ct1, ct2, r, worldPos(select(s.tp1, s.tp, j == 0)), n, s.T, fp);
    if (j == 0) { m = mj; } else { m = mixMat(m, mj, s.flowW); }
  }
  applyMat(&s, m);
  return s;
}

// ---- crisp voxels: bevelled boxes ----
// A crisp neighbour that a voxel's face is flush with (the floor counts; glass doesn't).
fn flushNb(c: vec3i) -> bool {
  if (c.y < 0) { return true; }
  if (outside(c)) { return false; }
  let id = eid(fetchA(c));
  return isCrisp(id) && RCLASS(id) != R_GLASS;
}

// Ray vs rounded box (Inigo Quilez): centred at the origin, inner half-size b,
// radius r. Returns the entry t, RBOX_MISS on a miss, RBOX_INSIDE if ro is inside the bounds.
const RBOX_MISS: f32 = -1.0;
const RBOX_INSIDE: f32 = -2.0;
const RBOX_NONE: f32 = 1e20;        // "no root yet"
const RBOX_NONE_TEST: f32 = 1e19;   // a t above this is still RBOX_NONE
fn rboxHit(ro0: vec3f, rd0: vec3f, b: vec3f, r: f32) -> f32 {
  let m = 1.0 / rd0;
  let nn = m * ro0;
  let k = abs(m) * (b + r);
  let t1 = -nn - k;
  let t2 = -nn + k;
  let tN = max(max(t1.x, t1.y), t1.z);
  let tF = min(min(t2.x, t2.y), t2.z);
  if (tN > tF || tF < 0.0) { return RBOX_MISS; }
  if (tN < 0.0) { return RBOX_INSIDE; }
  var t = tN;
  let s = sign(ro0 + t * rd0);
  let ro = ro0 * s;
  let rd = rd0 * s;
  var pos = (ro0 + t * rd0) * s - b;
  pos = max(pos.xyz, pos.yzx);
  if (min(min(pos.x, pos.y), pos.z) < 0.0) { return t; }   // a flat face
  let oc = ro - b;
  let dd = rd * rd;
  let oo = oc * oc;
  let od = oc * rd;
  let ra2 = r * r;
  t = RBOX_NONE;
  {
    let bb = od.x + od.y + od.z;
    let c = oo.x + oo.y + oo.z - ra2;
    let h = bb * bb - c;
    if (h > 0.0) { t = -bb - sqrt(h); }
  }
  {
    let a = dd.y + dd.z;
    let bb = od.y + od.z;
    let c = oo.y + oo.z - ra2;
    var h = bb * bb - a * c;
    if (h > 0.0) { h = (-bb - sqrt(h)) / a; if (h > 0.0 && h < t && abs(ro.x + rd.x * h) < b.x) { t = h; } }
  }
  {
    let a = dd.z + dd.x;
    let bb = od.z + od.x;
    let c = oo.z + oo.x - ra2;
    var h = bb * bb - a * c;
    if (h > 0.0) { h = (-bb - sqrt(h)) / a; if (h > 0.0 && h < t && abs(ro.y + rd.y * h) < b.y) { t = h; } }
  }
  {
    let a = dd.x + dd.y;
    let bb = od.x + od.y;
    let c = oo.x + oo.y - ra2;
    var h = bb * bb - a * c;
    if (h > 0.0) { h = (-bb - sqrt(h)) / a; if (h > 0.0 && h < t && abs(ro.z + rd.z * h) < b.z) { t = h; } }
  }
  return select(t, RBOX_MISS, t > RBOX_NONE_TEST);
}

// Shape of a crisp voxel: the ray enters the cell at tEnter through face
// normal *n. The voxel is a box with rounded edges, but only where it is
// exposed: on sides with a flush crisp neighbour the box reaches past the cell,
// so a wall of many voxels is one flat slab with rounded outer edges (concave
// edges stay sharp). Returns false if the shape is missed within [tEnter, tExit).
const CRISP_EPS: f32 = 1e-4;   // tolerance of the entry tests (cells)
fn crispHit(cell: vec3i, id: i32, ro: vec3f, rd: vec3f, tEnter: f32, tExit: f32, t: ptr<function, f32>, n: ptr<function, vec3f>) -> bool {
  if (id == E_CRYSTAL) { return crystalHit(cell, ro, rd, tEnter, tExit, t, n); }   // prisms (gfx/crystal.js)
  let R = FU.bevel * BEVEL(id);
  if (R <= 0.0 || RCLASS(id) == R_GLASS) { return true; }
  var lo = vec3f(0.0);
  var hi = vec3f(1.0);
  for (var k = 0; k < 3; k++) {
    var e = vec3i(0);
    e[k] = 1;
    if (flushNb(cell - e)) { lo[k] = -R; }
    if (flushNb(cell + e)) { hi[k] = 1.0 + R; }
  }
  let b = 0.5 * (hi - lo) - R;
  let c = vec3f(cell) + 0.5 * (lo + hi);
  let pe = ro + rd * tEnter - c;
  if (length(max(abs(pe) - b, vec3f(0.0))) <= R + CRISP_EPS) { return true; }   // entered through a flat part
  let tb = tEnter - 1.0;
  var th = rboxHit(ro + rd * tb - c, rd, b, R);
  if (th == RBOX_INSIDE) { return true; }
  if (th < 0.0) { return false; }
  th += tb;
  if (th < tEnter - CRISP_EPS || th >= tExit) { return false; }
  let tt = max(th, tEnter);
  *t = tt;
  let ph = ro + rd * tt - c;
  let q = max(abs(ph) - b, vec3f(0.0));
  if (dot(q, q) > 1e-12) { *n = sign(ph) * normalize(q); }
  return true;
}

// A crisp cell's temperature at the point hp on its face: bilinear between its
// own and its three neighbours' nearest hp in the face's plane, as gatherSurf
// blends a smooth channel's cells. A cell holds one temperature, so taken
// alone a hot patch glowed as one flat square per cell; blended, it glows as
// one smooth spot. Gas doesn't count: the face's glow is the matter's.
fn crispT(cell: vec3i, T: f32, hp: vec3f, face: vec3i) -> f32 {
  let fa = abs(face);
  let u = select(vec3i(1, 0, 0), vec3i(0, 1, 0), fa.x == 1);
  let v = select(vec3i(0, 0, 1), vec3i(0, 1, 0), fa.z == 1);
  let f = clamp(hp - vec3f(cell) - 0.5, vec3f(-0.5), vec3f(0.5));   // from the cell's centre
  let fu = dot(f, vec3f(u));
  let fv = dot(f, vec3f(v));
  let su = select(u, -u, fu < 0.0);
  let sv = select(v, -v, fv < 0.0);
  let wu = abs(fu);
  let wv = abs(fv);
  let w0 = (1.0 - wu) * (1.0 - wv);
  var sum = T * w0;
  var wsum = w0;
  for (var k = 0; k < 3; k++) {
    var c = cell + su + sv;
    var w = wu * wv;
    if (k == 0) { c = cell + su; w = wu * (1.0 - wv); }
    else if (k == 1) { c = cell + sv; w = (1.0 - wu) * wv; }
    if (outside(c)) { continue; }
    let b = fetchA(c);
    if (isGasLike(eid(b))) { continue; }
    sum += w * b.y;
    wsum += w;
  }
  return sum / wsum;
}

// Surface record for a crisp voxel, or (with ch set by the caller) a grain.
fn crispSurf(cell: vec3i, id: i32, a: vec4f, hp: vec3f, n: vec3f) -> Surf {
  var s: Surf;
  s.p = hp; s.tp = hp; s.tp1 = hp; s.flowW = 0.0; s.n = n; s.ng = n; s.ch = -1; s.id = id; s.cell = cell; s.seed = fract(a.w);
  // a crystal inside its cell: the corner AO of the side it points out of
  var fd = n;
  if (id == E_CRYSTAL && gCrysOn) { fd = gCrys.d; }
  let an = abs(fd);
  if (an.x >= an.y && an.x >= an.z) { s.face = vec3i(i32(sign(fd.x)), 0, 0); }
  else if (an.y >= an.z) { s.face = vec3i(0, i32(sign(fd.y)), 0); }
  else { s.face = vec3i(0, 0, i32(sign(fd.z))); }
  s.T = crispT(cell, a.y, hp, s.face);
  // an isolated grain carries its texture with it (its seed moves with the grain);
  // a voxel's is anchored in the world
  const GRAIN_TEX_SPREAD: f32 = 61.0;   // cells of texture space the seed spreads grains over
  var tp = worldPos(hp);
  if (SURFCH(id) >= 0) { tp = hp - vec3f(cell) + s.seed * GRAIN_TEX_SPREAD; }
  applyMat(&s, matOf(id, tp, n, s.T, floor(a.w), footprint(hp)));
  return s;
}

// ---- shading ----
// Split-sum environment BRDF, analytic fit (Karis 2014): (scale, bias) on F0.
fn envBRDF(nv: f32, rough: f32) -> vec2f {
  // the fit's coefficients
  const c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
  const c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  const c2 = -9.28;
  const c3 = vec2f(-1.04, 1.04);
  let r = rough * c0 + c1;
  let a004 = min(r.x * r.x, exp2(c2 * nv)) * r.x + r.y;
  return c3 * a004 + r.zw;
}

// (GGX_ALPHA_MIN, smithV, ggxSpecA and ggxSpec live in gfx/lighting.js, beside
// the hand lamps' specular, which shares them with the sun's here)

// Glints: a world-space lattice of tiny mirror facets (one ball per lattice
// cell around a jittered centre, cut by the surface into a disc) whose
// normals are drawn from a GGX distribution. A facet lights up when it
// reflects the sun into the eye (within an angular tolerance standing in for
// the sun's disc plus facet curvature). The result is normalised so its
// expected value equals the smooth GGX lobe it replaces (an unbiased
// estimator), so it converges to the same brightness when averaged (TAA,
// distance). A cheap stand-in for Deliot & Belcour 2023.
//
// The grains that sparkle are far below a pixel, so a sparkle is a point of
// light at any distance. The lattice is anchored in the world but its scale
// follows the pixel footprint: the two power-of-two levels around
// GLINT_CELL_PX pixels per lattice cell are blended, so a facet stays ~2 px
// across (wide enough that TAA's sub-pixel jitter can't make it blink).
const GLINT_CELL_PX: f32 = 6.0;       // lattice cell size in pixels, at glintDens 1
const GLINT_R0: f32 = 0.17;           // facet ball radius: solid core, ...
const GLINT_R1: f32 = 0.25;           // ... soft edge (lattice units)
const GLINT_COV: f32 = 0.0396;        // volume of that soft ball = the disc area it covers on average
const GLINT_DELTA: f32 = 0.12;        // angular tolerance (radians)
const GLINT_OMEGA: f32 = PI_S * GLINT_DELTA * GLINT_DELTA * 0.5;   // integral of the kernel below
// Cap on the facets' slope spread: the crystal faces that flash lie flatter
// than the grains' overall roughness, so sparkles gather around the sun's
// reflection instead of peppering the whole surface.
const GLINT_FACET_ROUGH: f32 = 0.5;
const GLINT_LEVEL_SALT: f32 = 17.3;   // decorrelates the facets of different levels
const GLINT_NORMAL_SALT: f32 = 41.7;  // decorrelates a facet's normal from its position
const GLINT_FRAME_UP_MAX: f32 = 0.9;  // |n.y| above which the tangent frame is built from x instead of y
const TWO_PI_S: f32 = 6.2831853;

// Kernel weight times coverage of the facet in q's lattice cell.
fn glintFacet(q: vec3f, n: vec3f, t1: vec3f, t2: vec3f, h: vec3f, a2: f32, salt: f32) -> f32 {
  let ci = floor(q);
  let h1 = hash33(ci + salt);
  let cov = 1.0 - smoothstep(GLINT_R0, GLINT_R1, length(q - ci - (GLINT_R1 + (1.0 - 2.0 * GLINT_R1) * h1)));
  if (cov <= 0.0) { return 0.0; }
  let h2 = hash33(ci + salt + GLINT_NORMAL_SALT);
  let phi = TWO_PI_S * h2.x;
  let ct = sqrt((1.0 - h2.y) / (1.0 + (a2 - 1.0) * h2.y));
  let st = sqrt(max(1.0 - ct * ct, 0.0));
  let m = (t1 * cos(phi) + t2 * sin(phi)) * st + n * ct;
  let x = length(m - h) / GLINT_DELTA;
  return max(1.0 - x * x, 0.0) * cov;
}

fn glintSpec(p: vec3f, n: vec3f, v: vec3f, l: vec3f, rough: f32, F0: vec3f, dens: f32) -> vec3f {
  let nl = dot(n, l);
  if (nl <= 0.0) { return vec3f(0.0); }
  let lv = log2(dens / (GLINT_CELL_PX * footprint(p)));   // lattice level wanted
  let L0 = floor(lv);
  let t = lv - L0;
  let r = min(rough, GLINT_FACET_ROUGH);
  let a = max(r * r, GGX_ALPHA_MIN);
  let h = normalize(v + l);
  let t1 = normalize(cross(n, select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.y) < GLINT_FRAME_UP_MAX)));
  let t2 = cross(n, t1);
  let q = M_ROT * worldPos(p);   // the lattice is anchored in the world (footprint() takes the grid point)
  let k = (1.0 - t) * glintFacet(q * exp2(L0), n, t1, t2, h, a * a, L0 * GLINT_LEVEL_SALT)
        + t * glintFacet(q * exp2(L0 + 1.0), n, t1, t2, h, a * a, (L0 + 1.0) * GLINT_LEVEL_SALT);
  if (k <= 0.0) { return vec3f(0.0); }
  let nv = max(dot(n, v), 1e-4);
  let nh = max(dot(n, h), 1e-3);
  let vh = max(dot(v, h), 0.0);
  let F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
  return F * smithV(nl, nv, a) * nl * k / (nh * GLINT_OMEGA * GLINT_COV);
}

// Diffuse of a rough (powdery) surface relative to Lambert, times n·l: Fujii's
// improved qualitative Oren–Nayar (sigma = facet slope spread, radians).
// Flatter than Lambert and brighter toward the sun (back-scattering).
fn orenNayar(nl: f32, nv: f32, lv: f32, sigma: f32) -> f32 {
  let s = lv - nl * nv;
  let t = select(1.0, max(max(nl, nv), 1e-3), s > 0.0);
  let A = 1.0 / (1.0 + (0.5 - 2.0 / (3.0 * PI_S)) * sigma);
  return max(nl, 0.0) * A * (1.0 + sigma * s / t);
}

// Reflections go from a sharp sky to the probes' blurred light over this roughness range.
const ENV_SHARP_ROUGH: f32 = 0.25;
const ENV_BLUR_ROUGH: f32 = 0.9;
const LOCAL_METAL_DIFFUSE: f32 = 0.5;  // share of a metal's F0 lit by the local lights as diffuse (gi.js GI_METAL_DIFFUSE)
const LOCAL_PROBE_LIFT: f32 = 0.75;   // cells off the surface where the glow volume is sampled
// Glow-volume light: this much reaches even fully occluded spots, plus LOCAL_AO_GAIN × AO.
const LOCAL_AO_MIN: f32 = 0.35;
const LOCAL_AO_GAIN: f32 = 0.65;
const SHADE_NV_MIN: f32 = 0.05;       // the bumped normal faces the eye at least this much (cosine)
// Oren–Nayar slope spread: none up to ON_ROUGH_START, then ON_SIGMA_RATE radians per unit roughness.
const ON_ROUGH_START: f32 = 0.45;
const ON_SIGMA_RATE: f32 = 1.6;
// Sun diffuse: this much ignores the cavity term, plus SUN_CAV_GAIN × cavity.
const SUN_CAV_MIN: f32 = 0.5;
const SUN_CAV_GAIN: f32 = 0.5;
// Leaves: thickness of the clump toward the sun, from two samples of the natural-solids field
// (distance along the sun ray, cells; cells of path each stands for).
const LEAF_TH_D1: f32 = 0.9;
const LEAF_TH_W1: f32 = 0.9;
const LEAF_TH_D2: f32 = 2.2;
const LEAF_TH_W2: f32 = 1.3;
const LEAF_SHADOW_D: f32 = 3.0;       // cells toward the sun where the light through them is shadow-tested
const LEAF_TRANS_GAIN: f32 = 1.6;     // brightness of the light through
const LEAF_EXT: f32 = 2.5;            // its extinction per cell of clump
const ANISO_BEND_RATE: f32 = 5.0;     // anisotropic lookup bend reaches full strength by roughness 1/this
// The dig tools' mark (src/pov/tools/dig.js) on the surface inside the aimed bite: Minecraft's block
// outline, black at 40 % (LevelRenderer.renderHitOutline), where the bite's side walls cut the
// surface, so it follows the ground, a trunk or a slope instead of hanging in the air; and its
// cracks (Minecraft's 10 destroy stages), the edges of a 3D cell pattern that open as the blows land.
const DIG_LINE_PX: f32 = 1.5;      // px: the outline's width on screen
const DIG_LINE_DARK: f32 = 0.4;    // Minecraft's outline: black at 40 %
const DIG_CRACK_F: f32 = 1.4;      // crack cells per grid cell
const DIG_CRACK_PX: f32 = 1.3;     // px: a crack's width on screen
const DIG_CRACK_CELLS: f32 = 0.03; // cells: ...and at least this wide up close
const DIG_CRACK_DARK: f32 = 0.75;  // how dark a crack is
// half the distance between q's two nearest sites (≈ distance to the edge between them), in
// pattern units, when that edge has opened (either site's random under k), else a large number
fn digCrack(q: vec3f, k: f32) -> f32 {
  let c = floor(q);
  var f1 = 1e9;
  var f2 = 1e9;
  var r1 = 1.0;
  var r2 = 1.0;
  for (var z = -1; z <= 1; z++) { for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let g = c + vec3f(f32(x), f32(y), f32(z));
    let h = hash33(g);
    let d = distance(q, g + h);
    if (d < f1) { f2 = f1; r2 = r1; f1 = d; r1 = h.x; } else if (d < f2) { f2 = d; r2 = h.x; }
  } } }
  return select(1e9, (f2 - f1) * 0.5, min(r1, r2) < k);
}
fn digMark(s: ptr<function, Surf>) {
  if (FU.digMax.w <= 0.0) { return; }
  let p = (*s).p;
  let lo = FU.digMin.xyz;
  let hi = FU.digMax.xyz;
  if (any(p < lo) || any(p > hi)) { return; }
  let px = footprint(p);
  // the outline: near a side wall (the aimed axis's two faces are the surface and behind it: not lines)
  let axis = i32(FU.digMax.w) - 1;
  var wall = min(p - lo, hi - p);
  wall[axis] = 1e9;
  let edge = min(min(wall.x, wall.y), wall.z);
  var dark = DIG_LINE_DARK * (1.0 - smoothstep(0.5, 1.0, edge / (px * DIG_LINE_PX)));
  let k = FU.digMin.w;
  if (k > 0.0) {
    let e = digCrack(p * DIG_CRACK_F, k) / DIG_CRACK_F;
    let w = max(px * DIG_CRACK_PX, DIG_CRACK_CELLS);
    dark = max(dark, DIG_CRACK_DARK * (1.0 - smoothstep(0.5 * w, w, e)));
  }
  (*s).albedo *= 1.0 - dark;
}

fn shadeSurf(s0: Surf, rd: vec3f) -> vec3f {
  var s = s0;
  digMark(&s);
  let v = -rd;
  let ng = s.ng;
  var ao: f32;
  if (s.ch >= 0) { ao = fieldAO(s.p, ng); } else { ao = faceAO(s.cell, s.face, s.p); }
  var local = sampleLight(s.p + ng * LOCAL_PROBE_LIFT) * FU.lightGain;
  // keep the bumped normal on the visible side
  var n = s.n;
  let nvr = dot(n, v);
  if (nvr < SHADE_NV_MIN) { n = normalize(n + v * (SHADE_NV_MIN - nvr)); }
  let nv = clamp(dot(n, v), 1e-4, 1.0);
  let l = FU.sun;
  let nl = dot(n, l);
  let ngl = dot(ng, l);
  let w = s.sss;
  var sh = vec3f(0.0);
  if (max(nl, ngl) + w > 0.0) {
    sh = vec3f(1.0);
    if (FU.shadows != 0u) { sh = sunShadow(s.p, ng); }
  }${grains ? `
  sh *= gGrainSun;   // a grain shaded by the grains next to it (gfx/grains.js)` : ''}${relief ? `
  sh *= reliefSunVis();   // in the shade of the relief (gfx/relief.js)` : ''}
  var aoT = ao * s.cav;

  // specular layer (F0) and the energy it takes from the diffuse one
  // (multiple-scattering GGX after Fdez-Agüera 2019)
  let F0 = mix(vec3f(s.f0), s.albedo, s.metal);
  let AB = envBRDF(nv, s.rough);
  let FssEss = F0 * AB.x + AB.y;
  let Ess = AB.x + AB.y;
  let Ems = 1.0 - Ess;
  let Favg = F0 + (1.0 - F0) / 21.0;
  let Fms = FssEss * Favg / (1.0 - Ems * Favg);
  let kD = s.albedo * (1.0 - s.metal) * (1.0 - FssEss - Fms * Ems);

  // sun: diffuse (rough powders back-scatter; porous stuff wraps light past the terminator)
  let sigma = max(s.rough - ON_ROUGH_START, 0.0) * ON_SIGMA_RATE;
  let lam = orenNayar(nl, nv, dot(l, v), sigma);
  let wrap = max(nl + w, 0.0) / ((1.0 + w) * (1.0 + w));
  let dSun = kD * mix(vec3f(lam), wrap * s.sssCol, w);
  // sun: specular, with multiple-scattering energy compensation
  let msK = 1.0 + F0 * (1.0 / max(Ess, 1e-3) - 1.0);   // (the lamps' specular below takes it too)
  var spec = ggxSpecA(n, v, l, s.rough, F0, s.tang, s.aniso) * msK;
  let g = s.glint * FU.glints;   // (glintSpec sizes its facets to the pixel, so no distance fade)
  if (g > 0.0) {
    // glints are part of the texture, so flowing grains carry them too
    var gs = glintSpec(s.tp, n, v, l, s.rough, F0, s.glintDens);
    if (s.flowW > 0.0) { gs = mix(gs, glintSpec(s.tp1, n, v, l, s.rough, F0, s.glintDens), s.flowW); }
    spec = mix(spec, gs, g);
  }
  // (FU.sunCol is irradiance / pi in this renderer's units, hence the pi on the BRDF term)
  var c = FU.sunCol * sh * (dSun * (SUN_CAV_MIN + SUN_CAV_GAIN * s.cav) + PI_S * spec);${relief ? `
  // down a carved crevice: less sky and ambient (the sun had reliefSunVis)
  {
    let sky = reliefSkyVis();
    s.cav *= sky;
    aoT *= sky;
  }` : ''}

  // leaves: sunlight through a thin clump (thickness from the natural-solids field)
  if (s.trans > 0.0 && ngl < 0.0) {
    let th = surfField(s.p + l * LEAF_TH_D1)[CH_ORGANIC] * LEAF_TH_W1
           + surfField(s.p + l * LEAF_TH_D2)[CH_ORGANIC] * LEAF_TH_W2;
    var shT = vec3f(1.0);
    if (FU.shadows != 0u) { shT = sunShadowAt(s.p + l * LEAF_SHADOW_D); }
    c += s.trans * FU.sunCol * shT * (s.albedo * s.sssCol * LEAF_TRANS_GAIN) * (-ngl) * exp(-LEAF_EXT * th);
  }

  // environment: specular (anisotropic lobes bend the lookup normal, rough
  // lobes reflect toward the normal), horizon- and AO-occluded. The probes'
  // light toward r (sky + bounce, already occluded), blurrier for rough lobes.
  var nb = n;
  if (s.aniso > 0.0) {
    let at = cross(s.tang, v);
    nb = normalize(mix(n, cross(at, s.tang), s.aniso * clamp(ANISO_BEND_RATE * s.rough, 0.0, 1.0)));
  }
  var r = reflect(rd, nb);
  r = normalize(mix(r, nb, s.rough * s.rough));
  let hor = clamp(1.0 + dot(r, ng), 0.0, 1.0);
  // (fetched here, after the shadow loops, so the probe isn't held across them)
  let gi = surfProbe(s.p, ng);
  let irr = giIrradiance(gi, n);
  // L1 probes are far too blurry for a polished surface: smooth lobes see the
  // clear sky itself as far as the probes say it is open toward r, and the
  // probes' light (bounce, nearby matter) for the rest.
  let blur = smoothstep(ENV_SHARP_ROUGH, ENV_BLUR_ROUGH, s.rough);
  let envSharp = mix(giRadiance(gi, r, 0.0), skyColor(r), giSkyVis(gi, r));
  let envL = mix(envSharp, giRadiance(gi, r, blur), blur);
  // indirect diffuse: the probes' light times AO, or the traced near field
  var ind = irr * aoT;
  if (FU.nearGI != 0u) {
    var vis: f32;
    ind = nearField(s.p, ng, n, irr, &vis) * s.cav;
    aoT = vis * s.cav;
  }
  if (glowWorthIt(local, irr)) { local *= glowLightScale(s.p, ng, n); }
  // specular occlusion (Lagarde & de Rousiers 2014)
  let specAO = clamp(pow(nv + aoT, exp2(-16.0 * s.rough - 1.0)) - 1.0 + aoT, 0.0, 1.0);
  c += (envL * FssEss * hor * hor + irr * Fms * Ems) * specAO;
  // indirect (sky + bounce) and glow volume: diffuse
  // the local lights (glow volume, lamps) have no direction to reflect: a metal takes
  // a share of its F0 as diffuse from them (as the GI does: gi.js GI_METAL_DIFFUSE), so
  // iron by a torch catches its light instead of staying a black slab
  let kL = kD + F0 * (s.metal * LOCAL_METAL_DIFFUSE);
  c += kD * ind + kL * local * (LOCAL_AO_MIN + LOCAL_AO_GAIN * aoT);
  // a torch or lantern (traced shadows, so no AO); it has a direction and a
  // size too, so it also reflects as the sun does (lighting.js lampShade:
  // Karis 2013's tube light), with the same multiple-scattering compensation
  if (FU.lampCount > 0) {
    let lit = lampShade(s.p, ng, n, true, LampSpecIn(v, s.rough, F0, s.tang, s.aniso, true));
    c += kL * lit.diff + lit.spec * msK;
  }
  return c + s.emit;
}

// The size of a pixel on the floor (y = 0) at hp, seen along rd: world cells
// per pixel along x and z, what fwidth(worldPos(hp).xz) * uPixScale was in
// GLSL. The floor is shaded after the march, in non-uniform control flow,
// where WGSL has no derivatives (docs/webgpu.md F2), so it is worked out from
// the ray direction's screen derivatives, which surfView took at the top of
// the entry point. A ray that has come a path t meets the floor at
// hp = o + rd·t with t = −o.y / rd.y, so one pixel to the side moves hp by
// t·(drd − rd·drd.y / rd.y): the plane's own derivative, which fwidth's
// difference between neighbouring pixels is to first order, anywhere on the
// screen and for any camera. The ray is taken as straight from the eye
// (hazeBend and refraction bend it a little; the quad difference saw that).
// A render-only change: within a pixel of the GLSL's except where the floor
// meets other geometry, where the derivative across the edge was meaningless.
const FLOOR_FW_SIN_MIN: f32 = 1e-3;   // floor on |rd.y| (a ray along the floor sees it infinitely stretched)
// t: the ray's path from the eye; dx, dy: its direction's change per pixel
fn floorFwidthRay(t: f32, rd: vec3f, dx: vec3f, dy: vec3f) -> vec2f {
  let ry = select(-1.0, 1.0, rd.y > 0.0) * max(abs(rd.y), FLOOR_FW_SIN_MIN);
  if (dot(dx, dx) + dot(dy, dy) == 0.0) {
    // No derivatives (surfViewAng): the pixel's footprint across the ray,
    // stretched by 1/|rd.y| along the ray's heading h. Near the image centre
    // of a camera without roll the screen's x axis runs across the heading
    // and its y axis along it, so fwidth of x is t·pix·(|h.z| + |h.x|/|rd.y|),
    // and of z the same with h's parts swapped. Off the axis that drifts
    // (1.9x at the side edges of a 60° view), so it is only the fallback.
    let lh = length(rd.xz);
    var h = vec2f(1.0, 0.0);   // looking straight down: any heading
    if (lh > 1e-6) { h = rd.xz / lh; }
    return t * gPixAng * (abs(h.yx) + abs(h) / abs(ry));
  }
  let ex = t * (dx - rd * (dx.y / ry));
  let ey = t * (dy - rd * (dy.y / ry));
  return (abs(ex.xz) + abs(ey.xz)) * FU.pixScale;
}
fn floorFwidth(hp: vec3f, rd: vec3f) -> vec2f { return floorFwidthRay(distance(hp, gEye), rd, gRdDx, gRdDy); }
// The same for a ray a mirror at m turned into rd (reflectTrace's floor). A
// plane mirror reflects the whole path: hp is the mirror image of a point on
// the eye's straight ray as far as eye → m → hp, and the ray's derivatives
// turn as the ray does, by I − 2·nm·nmᵀ; with that path and those derivatives
// the plane form above holds. nm lies along the difference of the two
// directions, the incoming one taken straight from the eye. A ripple's
// curvature, which spread the GLSL's quad difference too, is left out.
fn floorFwidthMirror(hp: vec3f, rd: vec3f, m: vec3f) -> vec2f {
  let v = m - gEye;
  let k = rd - v / max(length(v), 1e-6);
  var dx = gRdDx;
  var dy = gRdDy;
  if (dot(k, k) > 1e-8) {   // (else a grazing hit that hardly turned the ray)
    let nm = normalize(k);
    dx -= 2.0 * dot(nm, dx) * nm;
    dy -= 2.0 * dot(nm, dy) * nm;
  }
  return floorFwidthRay(length(v) + distance(m, hp), rd, dx, dy);
}

const FLOOR_LINE_ALB: vec3f = vec3f(0.075, 0.078, 0.085);   // the grid's seams, darker than the floor
const FLOOR_LINE_CELLS: f32 = 8.0;   // cells between the floor's grid lines
fn shadeFloor(hp: vec3f, rd: vec3f) -> vec3f { return shadeFloorFw(hp, floorFwidth(hp, rd)); }
// fw: the grid lines' fwidth there (floorFwidth, or floorFwidthMirror in a reflection)
fn shadeFloorFw(hp: vec3f, fw: vec2f) -> vec3f {
  let q = worldPos(hp).xz / FLOOR_LINE_CELLS;
  let gq = abs(fract(q - 0.5) - 0.5) / max(fw / FLOOR_LINE_CELLS, vec2f(1e-4));
  let line = 1.0 - min(min(gq.x, gq.y), 1.0);
  let alb = mix(GROUND_ALB, FLOOR_LINE_ALB, line);
  let n = vec3f(0.0, 1.0, 0.0);
  let ndl = max(FU.sun.y, 0.0);
  var sh = vec3f(1.0);
  if (FU.shadows != 0u) { sh = sunShadow(hp, n); }
  var ao = min(faceAO(vec3i(i32(floor(hp.x)), -1, i32(floor(hp.z))), vec3i(0, 1, 0), hp), fieldAO(vec3f(hp.x, 0.0, hp.z), n));
  var local = sampleLight(vec3f(hp.x, 0.5, hp.z)) * FU.lightGain;
  let irr = giIrradiance(surfProbe(vec3f(hp.x, 0.0, hp.z), n), n);
  var ind = irr * ao;
  let pf = vec3f(hp.x, 0.0, hp.z);
  if (FU.nearGI != 0u) { ind = nearField(pf, n, n, irr, &ao); }
  if (glowWorthIt(local, irr)) { local *= glowLightScale(pf, n, n); }
  var lamps = vec3f(0.0);
  if (FU.lampCount > 0) { lamps = lampLight(pf, n, n); }
  return alb * (FU.sunCol * ndl * sh + ind + local * (LOCAL_AO_MIN + LOCAL_AO_GAIN * ao) + lamps);
}
`;
};

// ---------------------------------------------------------------- the probes
// Fragment shaders that run the material library the way the volume's tracer
// does (shaders/render.js), so tools/check-wgsl.mjs validates every module at
// every detail level and builds what a view pipeline compiles: Tint validates
// a whole module, but a pipeline compiles only what its entry point reaches.
// One call site per expensive function, as the tracer keeps them (matOf and
// shadeSurf are inlined wherever they are called): the hit that ends the ray
// is shaded once, whichever kind it is.
//
// The library at a detail level, in the order the tracer pastes it after
// lib(g): surface (relief inside), liquid, liquid detail, media, grains. render.js defines what the material code calls
// back (the march's event codes, softBlob, meshCutT) and pastes the
// decoration's lookups (shaders/gfx/deco.js); a probe brings stand-ins with
// the GLSL's definitions (the mesh cut and the paint read from the frame).
const materialLib = (detail) =>
  [surfaceGLSL(detail), liquidGLSL, liquidDetailGLSL(detail), mediaGLSL(detail), grainsGLSL(detail)].join('\n');
const TRACER_STANDINS = /* wgsl */ `
// ---- stand-ins for the tracer's (shaders/render.js) ----
const EV_NONE: i32 = 0;
const EV_OPAQUE: i32 = 1;
const EV_ENTER: i32 = 2;
const EV_EXIT: i32 = 3;
const BLOB_R_IN: f32 = 0.1;
const BLOB_R_OUT: f32 = 0.95;
const BLOB_PEAK: f32 = 1.8;
fn softBlob(cell: vec3i, ro: vec3f, rd: vec3f, t0: f32, t1: f32) -> f32 {
  let cc = vec3f(cell) + 0.5;
  let tm = clamp(dot(cc - ro, rd), t0, t1);
  return smoothstep(BLOB_R_OUT, BLOB_R_IN, length(ro + rd * tm - cc)) * BLOB_PEAK;
}
// the opaque meshes' cut (gfx/meshCut.js; the tracer reads the scene target's
// depth): a value from the frame, through the library's meshCutAt
fn meshCutT(rd: vec3f) -> f32 { return meshCutAt(fract(FU.time), FU.invViewProj, vec2f(f32(FU.shadowRes)), rd); }
// ---- stand-ins for the decoration's lookups (shaders/gfx/deco.js decoViewGLSL,
// pasted by the view before the materials) ----
const DECO_SIGMA: f32 = 2.0;
const DECO_DETAIL_MAX: f32 = 2.0;
const DECO_LUM_MIN: f32 = 1e-3;
const DECO_LUM: vec3f = vec3f(0.2126, 0.7152, 0.0722);
// (the paint is the view's: here a pattern from the cell and the frame)
fn decoAt(c: vec3i) -> vec4f { return select(vec4f(0.0), fract(vec4f(vec3f(c), FU.time) * 0.37), FU.view == 7); }
fn decoLinear(c: vec3f) -> vec3f { return select(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), c >= vec3f(0.04045)); }
fn decoTint(alb: vec3f, base: vec3f, d: vec4f) -> vec3f {
  if (d.a <= 0.0) { return alb; }
  let detail = clamp(dot(alb, DECO_LUM) / max(dot(base, DECO_LUM), DECO_LUM_MIN), 0.0, DECO_DETAIL_MAX);
  return mix(alb, decoLinear(d.rgb) * detail, d.a);
}`;

// The detail levels of gfx/detail.js (Settings → Detail up close): none, the
// cost-tier defaults, every switch.
const defines = (keep) => Object.fromEntries(DETAIL.filter(keep).map((d) => [d.define, 1]));
export const DETAIL_LEVELS_WGSL = {
  off: () => ({}),
  balanced: () => defines((d) => COST[d.cost].on),
  full: () => defines(() => true),
};

// The realistic path at detail d: the ray's first event in a cell (a crisp
// voxel, a carved relief hit, grain geometry), the hit shaded once, the floor,
// a liquid interface with its detail and traced reflection, its absorption,
// and a media segment. In scope: ro, rd, p (a grid point on the ray), n (a
// unit normal), ci, a, id (a cell of the state and its element), s (a scalar).
const realisticBody = (d) => /* wgsl */ `
  // the hit that ends the ray, shaded once whatever its kind (as the tracer does)
  var t = s;
  var nh = n;
  var hitK = 2;   // 1 crisp, 2 smooth, 3 grain
  var hp = p;
  if (crispHit(ci, id, ro, rd, s, s + 1.0, &t, &nh)) { hitK = 1; hp = ro + rd * t; }${d.DETAIL_RELIEF ? `
  else {
    var tr = s;
    if (reliefHit(ro, rd, CH_GRANULAR, &tr)) { hp = ro + rd * tr; }
  }` : ''}${GRAINS_ANY(d) ? `
  var ev = EV_OPAQUE;
  var tEv = s + 0.5;
  var anyHit = false;
  var hitPos = p;
  grainEvent(ci, id, a, ro, rd, s, s + 1.0, acc.xyz, vec3f(1.0), &ev, CH_GRANULAR, &tEv, &anyHit, &hitPos);
  if (ev == EV_GRAIN) { hitK = 3; hp = ro + rd * tEv; }
  acc += vec4f(hitPos, gAltW + select(0.0, 1.0, anyHit || gAltGeom) + gAltCol.x + gAltTrans.y + gAltRd.z + gAltP.x + f32(gAltA.x + gAltK));` : ''}
  var sf: Surf;
  if (hitK == 1) { sf = crispSurf(ci, id, a, hp, nh); }${GRAINS_ANY(d) ? `
  else if (hitK == 3) { sf = grainSurf(gHitA, gHitK, hp, rd); }` : ''}
  else { sf = gatherSurf(hp, surfNormal(hp, CH_GRANULAR, -rd), CH_GRANULAR); }
  acc += vec4f(shadeSurf(sf, rd), 1.0);${GRAINS_ANY(d) ? `
  gGrainSun = 1.0;` : ''}
  acc += vec4f(shadeFloor(vec3f(p.x, 0.0, p.z), rd), 0.0);
  // a liquid surface: its ripples and detail, refraction with the scene in its
  // reflection, the liquid's absorption
  var lro = ro;
  var lrd = rd;
  var col = acc.xyz;
  var trans = vec3f(1.0);
  var ml = vec3f(1.0);
  let lid = liquidIdAt(p, E_WATER);
  var nl = liquidRipple(p, n);
  nl = liquidDetail(p, nl, lid, &col, &trans);
  let inside = liquidInterface(p, nl, s > 0.5, lid, true, &lro, &lrd, &col, &trans, &ml);
  absorbSegment(lid, lro, thinBodySeg(p, s), ml, AMBIENT, &col, &trans);   // (drops and pours show their colour, as the tracer)
  acc += vec4f(col + trans + lro + lrd, select(0.0, 1.0, inside));
  acc.w += fresnelSchlick(s, IOR(lid)) + skyInAt(probeAt(p)) + gSkyIn + envReflect(p, nl, ml).x;
  // a media segment, the media lattice carrying on from the ray's jitter
  var next = ign(gFragCoord, f32(FU.frame)) * MEDIA_STEP;
  var mcol = vec3f(0.0);
  var mtrans = vec3f(1.0);
  let mrd = safeDir(hazeBend(ro, rd, s, s + 4.0));
  let al = mediaSegment(ro, mrd, s, s + 4.0, &next, &mcol, &mtrans);
  acc += vec4f(mcol + mtrans, al + next);`;

// The probe's fragment entry: gFragCoord and the aeration copy set first, then
// surfView at the top in uniform control flow, as the tracer must; inputs from
// the pixel and FrameUniforms, so nothing folds.
const probeEntry = (body) => /* wgsl */ `
${fullscreenVert('vs')}
@fragment fn fs(frag: FullScreen) -> @location(0) vec4f {
  gFragCoord = frag.position.xy;
  gAerCopy = u32(FU.frame) & 1u;
  let ro = FU.cam;
  let rd = safeDir(normalize(vec3f(frag.uv * 2.0 - 1.0, 1.0) + FU.sun));
  surfView(ro, rd);   // the pixel's footprint: derivatives, in uniform control flow
  let p = ro + rd * FU.time;
  let n = normalize(FU.sun + vec3f(0.0, 1.0, 0.0));
  let ci = clamp(vec3i(floor(p)), vec3i(0), GRID - 1);
  let a = fetchA(ci);
  let id = eid(a);
  let s = FU.lightGain;
  var acc = vec4f(0.0);
${body}
  return acc;
}`;

/**
 * The material library's module text for grid g at detail (a defines
 * object), without an entry point: the render library (lib.js, its LIGHTING
 * variant, aeration declared), the tracer's stand-ins and the material
 * library. Tools append their own entry (tools/material-lod-check.mjs).
 * @param {object} g
 * @param {object} detail
 */
export const materialModule = (g, detail) => [
  lib(g, { variant: 'LIGHTING', far: false, aeration: true }),
  TRACER_STANDINS,
  materialLib(detail),
].join('\n');

/**
 * A probe's WGSL for grid g: materialModule and a fragment entry running
 * the realistic path.
 * @param {object} g
 * @param {object} detail
 */
export const materialProbe = (g, detail) => [
  `// material probe: realistic, detail ${Object.keys(detail).join(' ') || 'off'}`,
  materialModule(g, detail),
  probeEntry(realisticBody(detail)),
].join('\n');
// its groups: the render library's (group 0 FRAME, 1 STATE_RO, 2 LIGHTING, 3 PARAMS)
export const materialProbeLayouts = () => libLayouts('LIGHTING');

// Every combination of the detail switches: 2^n defines objects (n = 10, 1024), in
// the order of gfx/detail.js's DETAIL (bit i: DETAIL[i]).
export const detailCombination = (bits) => Object.fromEntries(DETAIL.filter((_, i) => (bits >> i) & 1).map((d) => [d.define, 1]));
export const DETAIL_COMBINATIONS = 1 << DETAIL.length;

/**
 * A probe as a check-wgsl entry (src/gpu/checks.js): a render pipeline,
 * the full-screen triangle into rgba16float (the scene target's format).
 * warm: false: a test kernel no game path builds, so preload's warm-on-menu
 * set leaves it out (B5).
 */
export const probeCheck = (name, detail, grids = true) => ({
  name,
  warm: false,
  kind: 'render',
  grids,
  code: (g) => materialProbe(g, detail),
  layouts: () => materialProbeLayouts(),
  vertex: { entry: 'vs' },
  fragment: { entry: 'fs', targets: [{ format: 'rgba16float' }] },
});
// What check-wgsl validates (every grid) and builds (at the smallest): the
// realistic path at the three detail levels. Every
// switch's code is in mat.full, every switch-off alternative in mat.off.
// Each switch alone and all 1024 combinations are validated, and each switch
// alone built, by tools/material-lod-check.mjs (--only combos): built here
// they would add about a minute of SwiftShader to every check-wgsl run.
const CHECKS = {
  surface: () => Object.entries(DETAIL_LEVELS_WGSL).map(([k, d]) => probeCheck(`mat.${k}`, d())),
};
/**
 * The WGSL_CHECK entries of surface.js ('surface'). A function, not an
 * array: the material modules import each other.
 * @param {string} module
 */
export const materialChecks = (module) => CHECKS[module]();

/** tools/check-wgsl.mjs: the detail levels' probes (materialChecks) */
export const WGSL_CHECK = () => materialChecks('surface');

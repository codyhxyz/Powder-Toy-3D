// Opaque surfaces: per-element solid textures (world-space, so nothing
// reveals the grid), bevelled crisp voxels, and energy-conserving PBR shading.
//
// Pipeline for a hit: gatherSurf (smooth surfaces) or crispSurf (voxels and
// grains) builds a Surf from the material function matOf(); shadeSurf lights it.
export const surfaceGLSL = /* glsl */ `
uniform float uMatDetail;   // 1 = textured materials, 0 = flat albedo (A/B and fallback)
uniform float uBevel;       // crisp-voxel edge radius in cells (0 = sharp cubes)
uniform float uGlints;      // 1 = sun glints on grains

const float PI_S = 3.14159265;

struct Surf {
  vec3 p;       // hit point (grid units)
  vec3 n;       // shading normal (geometry + material bump)
  vec3 ng;      // geometric normal (field gradient / voxel face / bevel)
  int id;       // dominant element
  int ch;       // smooth channel, or -1 for a crisp voxel face
  ivec3 cell;   // dominant cell
  ivec3 face;   // axis-aligned face normal (crisp voxels, for faceAO)
  vec3 albedo;  // diffuse albedo, or F0 for metals
  float T;      // temperature, blended across cells
  float rough;
  float metal;
  float seed;   // per-cell random in [0, 1)
  float f0;     // dielectric normal-incidence reflectance (from the IOR)
  float sss;    // wrap / subsurface amount
  vec3 sssCol;  // tint of light that scattered deep (snow: blue)
  float glint;  // fraction of the sun's specular that arrives as glints
  float glintDens; // relative glint density on screen (1 = one facet per GLINT_CELL_PX² pixels)
  float cav;    // cavity (micro) occlusion from the texture, 1 = open
  float aniso;  // brushed anisotropy along tang (0 = isotropic)
  vec3 tang;
  float trans;  // backlit translucency (leaves)
  vec3 emit;    // emitted radiance (incandescence)
};

// ---- view: set once per pixel by the tracer, in uniform control flow ----
const float PIX_ANG_INIT = 0.002;   // radians per pixel until surfView sets it
const float PIX_ANG_MIN = 1e-5, PIX_ANG_MAX = 0.05;   // clamp on a pixel's angular size (radians)
vec3 gEye = vec3(0.0);
float gPixAng = PIX_ANG_INIT;
void surfView(vec3 eye, vec3 rd) {
  gEye = eye;
  gPixAng = clamp(max(length(dFdx(rd)), length(dFdy(rd))) * uPixScale, PIX_ANG_MIN, PIX_ANG_MAX);
}
// size of a pixel at p, in grid units
float footprint(vec3 p) { return distance(p, gEye) * gPixAng; }
// weight of detail with spatial frequency f (cycles per cell): fades out
// before it would alias (Nyquist = 0.5 cycles per pixel)
const float DETAIL_FADE_LO = 0.15, DETAIL_FADE_HI = 0.4;   // fade range, cycles per pixel
float lodFade(float f, float fp) { return 1.0 - smoothstep(DETAIL_FADE_LO, DETAIL_FADE_HI, f * fp); }

// ---- material noise (all world space; the lattice is rotated so it never lines up with the grid) ----
const mat3 M_ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

// Value noise with its analytic gradient: (value in [0, 1], d/dx, d/dy, d/dz).
vec4 mNoiseD(vec3 x) {
  vec3 i = floor(x), f = x - i;
  vec3 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), g = hash13(i + vec3(1, 0, 1)), h = hash13(i + vec3(0, 1, 1)), k = hash13(i + vec3(1, 1, 1));
  float k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d, k5 = a - c - e + h, k6 = a - b - e + g;
  float k7 = -a + b + c - d + e - g - h + k;
  return vec4(a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
              du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
                        k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
                        k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y));
}
// noise of q = J p, gradient with respect to p
vec4 mNoiseJ(vec3 p, mat3 J, vec3 off) {
  vec4 n = mNoiseD(J * p + off);
  return vec4(n.x, transpose(J) * n.yzw);
}

// fBm with gradient, centred on 0 (about ±0.45). Base frequency f cycles per
// cell; octaves finer than the pixel footprint fp fade out instead of aliasing.
const int MFBM_MAX_OCT = 4;          // most octaves a caller may ask for
const float MFBM_AMP0 = 0.5;         // amplitude of the first octave
const float MFBM_GAIN = 0.5;         // amplitude ratio between octaves
const float MFBM_LACUNARITY = 2.03;  // frequency ratio between octaves (not 2, so they don't line up)
const float MFBM_OCT_SHIFT = 7.31;   // lattice offset per octave (decorrelates them)
vec4 mFbmD(vec3 p, float f, int oct, float fp) {
  vec4 s = vec4(0.0);
  float a = MFBM_AMP0;
  mat3 J = M_ROT * f;
  for (int i = 0; i < MFBM_MAX_OCT; i++) {
    if (i >= oct) break;
    float lw = lodFade(f, fp);
    if (lw <= 0.0) break;
    vec4 n = mNoiseD(J * p + float(i) * MFBM_OCT_SHIFT);
    s += a * lw * vec4(n.x - 0.5, transpose(J) * n.yzw);
    J = M_ROT * J * MFBM_LACUNARITY;
    f *= MFBM_LACUNARITY;
    a *= MFBM_GAIN;
  }
  return s;
}

// Cellular (Worley) noise: (F1, distance to the border with the second
// nearest cell, two hashes of the nearest cell). ge = gradient of that border
// distance, r1 = vector to the nearest seed.
const float CELL_FAR = 1e9;   // "none yet": beyond any squared distance a search can find
// (scale, offset) of the nearest cell's position for its two hashes
const vec2 CELL_HASH_Z = vec2(1.31, 4.7), CELL_HASH_W = vec2(0.71, 9.2);
vec4 mCell(vec3 p, out vec3 ge, out vec3 r1) {
  vec3 i = floor(p), f = p - i;
  float d1 = CELL_FAR, d2 = CELL_FAR;
  vec3 s1 = vec3(0.0), s2 = vec3(1.0), c1 = vec3(0.0);
  for (int k = 0; k < 27; k++) {
    vec3 o = vec3(float(k % 3), float((k / 3) % 3), float(k / 9)) - 1.0;
    vec3 r = o + hash33(i + o) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; s2 = s1; d1 = d; s1 = r; c1 = i + o; }
    else if (d < d2) { d2 = d; s2 = r; }
  }
  vec3 u = normalize(s2 - s1 + 1e-6);
  ge = -u;
  r1 = s1;
  return vec4(sqrt(d1), dot(0.5 * (s1 + s2), u), hash13(c1 * CELL_HASH_Z.x + CELL_HASH_Z.y), hash13(c1 * CELL_HASH_W.x + CELL_HASH_W.y));
}

float sminP(float a, float b, float k) {     // polynomial smooth minimum, blend width k
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float dSmooth(float a, float b, float x) {   // derivative of smoothstep(a, b, x)
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return 6.0 * t * (1.0 - t) / (b - a);
}

// Crease noise: |2n - 1| of the noise of q = J p, with its gradient. It is 0
// along the n = 0.5 isolines, which meander and merge instead of tiling, so it
// makes natural cracks, furrows and V-shaped creases.
vec4 mCreaseJ(vec3 p, mat3 J, vec3 off) {
  vec4 n = mNoiseJ(p, J, off);
  float s = 2.0 * n.x - 1.0;
  return vec4(abs(s), 2.0 * sign(s) * n.yzw);
}

// Sparse round spots (grains, flecks, pits) on a rotated lattice of f cells
// per grid unit. Each lattice cell holds, with probability prob, a ball of
// radius up to rmax (lattice units) kept inside its cell, so one lookup is
// enough. Returns (coverage in [0, 1] with a soft rim, gradient of a dome of
// height 1 over the ball, in grid units); h = a hash of the spot. Beyond the
// pixel footprint the coverage fades to its mean (the balls' volume fraction,
// which is also the area fraction they cover on any plane cut).
const float DOT_RIM = 0.3;     // soft rim, as a fraction of the radius
const float DOT_RMIN = 0.4;    // smallest ball, as a fraction of rmax
const float DOT_SALT = 23.7;   // decorrelates the position hash from the size hash
// E[r^3] / rmax^3 for r uniform in [DOT_RMIN, 1] rmax, times the volume of a
// unit ball with that soft rim (taken at the rim's middle; within 2%)
const float UNIT_BALL_VOL = 4.18879;   // 4π/3
const float DOT_VOL = (1.0 - DOT_RMIN * DOT_RMIN * DOT_RMIN * DOT_RMIN) / (4.0 * (1.0 - DOT_RMIN))
                    * UNIT_BALL_VOL * (1.0 - 0.5 * DOT_RIM) * (1.0 - 0.5 * DOT_RIM) * (1.0 - 0.5 * DOT_RIM);
vec4 mDots(vec3 p, float f, float prob, float rmax, float fp, out float h) {
  vec3 q = M_ROT * p * f;
  vec3 i = floor(q);
  vec3 a = hash33(i), b = hash33(i + DOT_SALT);
  h = a.z;
  float r = rmax * mix(DOT_RMIN, 1.0, a.y);
  vec3 d = q - (i + 0.5 + (b - 0.5) * (1.0 - 2.0 * r));
  float dl = length(d);
  float on = step(a.x, prob);
  float cov = on * (1.0 - smoothstep((1.0 - DOT_RIM) * r, r, dl));
  vec3 g = on * step(dl, r) * (-2.0 * f / (r * r)) * (transpose(M_ROT) * d);
  float lw = lodFade(f, fp);
  return vec4(mix(prob * DOT_VOL * rmax * rmax * rmax, cov, lw), lw * g);
}

// ---- materials ----
struct Mat {
  vec3 alb;     // diffuse albedo (dielectrics) or F0 (metals)
  vec3 g;       // gradient of the bump height, grid units (perturbs the normal)
  vec3 emit;
  vec3 tang;
  vec3 sssCol;
  float rough, metal, f0, sss, glint, glintDens, cav, aniso, trans;
};

Mat mixMat(Mat a, Mat b, float k) {
  a.alb = mix(a.alb, b.alb, k); a.g = mix(a.g, b.g, k); a.emit = mix(a.emit, b.emit, k);
  a.tang = mix(a.tang, b.tang, k); a.sssCol = mix(a.sssCol, b.sssCol, k);
  a.rough = mix(a.rough, b.rough, k); a.metal = mix(a.metal, b.metal, k); a.f0 = mix(a.f0, b.f0, k);
  a.sss = mix(a.sss, b.sss, k); a.glint = mix(a.glint, b.glint, k); a.glintDens = mix(a.glintDens, b.glintDens, k);
  a.cav = mix(a.cav, b.cav, k); a.aniso = mix(a.aniso, b.aniso, k); a.trans = mix(a.trans, b.trans, k);
  return a;
}

// Lava freezes back into its ctype at MELT - LAVA_FREEZE_BELOW (src/physics.js).
float solidusOf(float ctype) {
  int ct = int(ctype);
  if (ct <= 0 || ct >= NE || MELT[ct] <= 0.0) ct = E_STONE;
  return MELT[ct] - LAVA_FREEZE_BELOW;
}

// Thermal glow of an opaque surface whose bulk is at T (°C). Kirchhoff: a
// surface emits what it doesn't reflect (emissivity = 1 - reflectance), so pale
// rock glows less than black crust and gold hardly at all. The open skin
// radiates its heat away and runs INCAND_SKIN_DROP below the bulk, while
// crevices and pores (low cavity term) show the hot interior: heat reads as
// glowing cracks rather than a tint over the whole surface.
const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);
// glow of material m with its visible surface at Ts (°C)
vec3 glowAt(Mat m, float Ts) {
  if (Ts <= INCAND_T0) return vec3(0.0);
  vec3 refl = mix(m.f0 + (1.0 - m.f0) * m.alb, m.alb, m.metal);
  return (1.0 - clamp(dot(refl, LUMA_W), 0.0, 1.0)) * incandescence(Ts);
}
vec3 hotEmit(Mat m, float T) { return glowAt(m, T - INCAND_SKIN_DROP * clamp(m.cav, 0.0, 1.0)); }

// Hot steel's mill scale (E_METAL)
const float OXIDE_T0 = 400.0;     // °C: scale starts to darken the steel…
const float OXIDE_T1 = 650.0;     // …and covers it (wüstite forms above ~570 °C)
const vec3 OXIDE_ALB = vec3(0.03, 0.027, 0.025);   // black, a touch of rust brown
const float OXIDE_F0 = 0.05;      // porous, dull: little sky in it, even at grazing angles
const float OXIDE_ROUGH = 0.8;
const float SCALE_FREQ = 1.1;     // patches of thick scale, per cell
const int SCALE_OCT = 3;          // fBm octaves of the scale thickness
const float SCALE_SPLIT = 0.18;   // thin → thick over this much of the thickness noise
const float SCALE_COVER = 0.06;   // shifts the thickness noise: most of the steel is under thick scale
const float SCALE_ALB_VAR = 0.6;  // thick scale is a little greyer
const float SCALE_BUMP = 0.25;    // blistered relief
const float SCALE_DROP = 150.0;   // °C thick scale runs below the steel

// Lava (E_LAVA)
const float LAVA_CHURN = 0.12;        // drift of the molten skin pattern, cells per second
const float LAVA_SKIN_FREQ = 0.4;     // skin pattern frequency, per cell
const int LAVA_SKIN_OCT = 2;          // fBm octaves of the skin pattern
const float LAVA_SKIN_VAR = 0.6;      // how far the skin pattern shifts the crust line
const float LAVA_SKIN_DT = 150.0;     // °C: skin temperature swing on the melt
const float LAVA_MELT_RANGE = 450.0;  // °C above the solidus where it is fully molten
const float LAVA_CRUST_X0 = 0.2;      // crust starts to break up (fraction of that range)…
const float LAVA_CRUST_X1 = 0.8;      // …and is gone
const float LAVA_PLATE_FREQ = 0.8;    // crust plates per cell
const float LAVA_CRACK_LOD = 4.0;     // cracks are narrow: fade them at this multiple of the plate frequency
const float LAVA_CRACK_CORE = 0.5;    // fraction of the crack half-width that is fully open melt
const float LAVA_CRACK_OPEN = 1.0;    // crack half-width once the crust has broken up (no plates left)…
const float LAVA_CRACK_SHUT = 0.04;   // …and once it has set (cellular-noise units)
const float LAVA_RIM = 0.12;          // plate edge still glowing beside a crack
const float LAVA_CRACK_AREA = 1.6;    // area share of cracks per unit half-width (far LOD)
const float LAVA_CRUST_T = 450.0;     // °C: top of a crust right at the solidus…
const float LAVA_CRUST_K = 0.8;       // …rising this much per °C of melt above it
const vec3 LAVA_MELT_ALB = vec3(0.05, 0.035, 0.025);   // dark glassy melt
const float LAVA_MELT_ROUGH = 0.25;
const float LAVA_CRUST_ROUGH = 0.55;  // glassy, silvery basalt skin (pahoehoe)
const float LAVA_CRUST_VAR = 0.5;     // plate-to-plate albedo spread (± half of it)
const float LAVA_CRACK_CAV = 0.5;     // cavity term down in a crack
const float LAVA_PLATE_BUMP = 0.2;    // relief of the plate edges
const float LAVA_PLATE_EDGE = 0.35;   // width of the rounded plate edge
const float LAVA_SKIN_BUMP = 0.1;     // ripples on the melt

// Turns a lattice 30° about y, so bark plates and rain streaks don't line up with the grid.
const mat3 TURN_Y30 = mat3(0.866, 0.0, 0.5, 0.0, 1.0, 0.0, -0.5, 0.0, 0.866);

// The look of element id at world point p (grid units) on a surface with
// normal n, temperature T (°C). fp = pixel footprint (grid units) for LOD.
Mat matOf(int id, vec3 p, vec3 n, float T, float ctype, float fp) {
  Mat m;
  m.alb = ALBEDO[id]; m.g = vec3(0.0); m.tang = vec3(1.0, 0.0, 0.0); m.sssCol = vec3(1.0);
  m.rough = ROUGH[id]; m.metal = METAL[id];
  m.f0 = (IOR[id] - 1.0) / (IOR[id] + 1.0); m.f0 *= m.f0;
  m.sss = SSS[id]; m.glint = GLINT[id]; m.glintDens = 1.0; m.cav = 1.0; m.aniso = 0.0; m.trans = 0.0;
  m.emit = vec3(0.0);
  // anything hot glows (hotEmit, once the texture is known); lava does its own thing
  if (uMatDetail < 0.5) { m.emit = id == E_METAL ? glowAt(m, T) : hotEmit(m, T); return m; }

  // Scale: a cell is ~8 cm. Frequencies below are cycles (or lattice cells)
  // per cell; the *_H / *_DEPTH bump amplitudes are heights in cells.
  if (id == E_SAND) {
    // Dry sand. Its grains (~0.3 mm) are far below a pixel, so it reads as a
    // matte surface with soft mottling (sorting, damp patches), shallow
    // dimples, a faint grain-scale mottle and, up close, scattered dark
    // mineral grains. The sparkle of the quartz faces comes from the glints.
    const float PATCH_F = 0.3, CLUMP_F = 3.2, GRAIN_F = 12.0;
    const float PATCH_H = 0.35, CLUMP_H = 0.08, GRAIN_H = 0.006;
    const vec3 HUE = vec3(0.07, 0.0, -0.1);    // patches drift yellow-red .. grey
    const float DARK_F = 18.0;                 // lattice of coarse dark grains (~4 mm apart)
    const float DARK_P = 0.4, DARK_R = 0.25;   // how many, how big (lattice units)
    const float DARK_ALB = 0.45;               // their albedo relative to the sand
    const float DARK_WARP = 0.005;             // bends the grains out of round (cells per unit slope)
    const int PATCH_OCT = 2, CLUMP_OCT = 3, GRAIN_OCT = 2;              // fBm octaves
    const float PATCH_ALB = 0.25, CLUMP_ALB = 0.18, GRAIN_ALB = 0.3;   // albedo swing per unit of each noise
    const float CLUMP_CAV = 0.4;               // cavity swing of the clumps
    vec4 lo = mFbmD(p, PATCH_F, PATCH_OCT, fp);
    vec4 gr = mFbmD(p, CLUMP_F, CLUMP_OCT, fp);
    vec4 fg = mFbmD(p, GRAIN_F, GRAIN_OCT, fp);
    float dh;
    vec4 dk = mDots(p + DARK_WARP * fg.yzw, DARK_F, DARK_P, DARK_R, fp, dh);
    m.alb *= (1.0 + PATCH_ALB * lo.x + CLUMP_ALB * gr.x + GRAIN_ALB * fg.x) * (1.0 + HUE * lo.x) * mix(1.0, DARK_ALB, dk.x);
    m.g = PATCH_H * lo.yzw + CLUMP_H * gr.yzw + GRAIN_H * fg.yzw;
    m.cav = 1.0 + CLUMP_CAV * gr.x;
  } else if (id == E_STONE) {
    // Gravel: rounded pebbles of mixed rock. Each pebble is a disc of its own
    // size around a cellular seed (measured within the surface, so every
    // cell the surface cuts shows a whole pebble), cut by its cell where it
    // would touch a neighbour, so outlines run from round to polygonal. It is
    // shaded as a dome steepening toward its outline; between pebbles are
    // dark voids with grit in them. Each has its own rock type, shade and polish.
    const float PEBBLE_F = 1.7;                // pebbles per cell along a line (~5 cm)
    const float R_MIN = 0.42, R_VAR = 0.35;    // pebble radius range, lattice units
    const float GAP = 0.04;                    // gap where two pebbles meet, lattice units
    const float RIM = 0.05;                    // pebble edge softness, lattice units
    const float ROUND = 0.25;                  // rounds off the corners where the cell cuts a pebble
    const float RIM_CAV = 0.35;                // occlusion toward a pebble's outline (it curves away)
    const float POLISH = 0.15;                 // pebbles are smoother than the gravel's overall roughness
    const float U_MAX = 0.95;                  // caps the dome's slope at the outline
    const float VOID_ALB = 0.1, VOID_CAV = 0.15;    // the voids: crevices in deep shade, not a matrix
    const float MEAN = 0.82;                   // area-average shade of pebbles and voids (the far look)
    const float MOTTLE_F = 5.0, GRIT_F = 11.0; // texture within a pebble; grit in the voids
    const float MOTTLE_H = 0.03, GRIT_H = 0.01;
    // rock types (relative albedo; their mean is ~1)
    const vec3 GRANITE = vec3(1.0, 1.02, 1.05), BASALT = vec3(0.6, 0.6, 0.63);
    const vec3 SANDSTONE = vec3(1.22, 1.08, 0.92), QUARTZ = vec3(1.3), RUST = vec3(1.15, 0.92, 0.8);
    // cumulative shares of the rock types (the rest is rust)
    const float GRANITE_UPTO = 0.35, BASALT_UPTO = 0.6, SANDSTONE_UPTO = 0.8, QUARTZ_UPTO = 0.9;
    const float SHADE_MIN = 0.8, SHADE_RANGE = 0.4;   // pebble-to-pebble shade
    const float ROUGH_VAR = 0.3;               // pebble-to-pebble roughness spread
    const float MOTTLE_ALB = 0.35, GRIT_ALB = 0.8;    // albedo swing per unit of each noise
    const float PEBBLE_LOD = 2.0;              // outlines are sharp: fade them at this multiple of the pebble frequency
    const int MOTTLE_OCT = 2, GRIT_OCT = 2;    // fBm octaves
    vec3 ge, r1;
    vec4 c = mCell(p * PEBBLE_F, ge, r1);
    float lw = lodFade(PEBBLE_F * PEBBLE_LOD, fp);
    vec3 rt = r1 - n * dot(r1, n);             // to the seed, within the surface
    float d = length(rt);
    float e = sminP(R_MIN + R_VAR * c.w - d, c.y - GAP, ROUND);   // distance in from the pebble's outline
    float u = clamp(d / max(d + e, 1e-3), 0.0, U_MAX);    // 0 at the pebble's middle, 1 at its outline
    float sh = sqrt(1.0 - u * u);
    float pm = smoothstep(0.0, RIM, e);        // 1 on a pebble, 0 in a void
    vec4 gr = mFbmD(p, MOTTLE_F, MOTTLE_OCT, fp);
    vec4 gt = mFbmD(p, GRIT_F, GRIT_OCT, fp);
    vec3 type = c.z < GRANITE_UPTO ? GRANITE : (c.z < BASALT_UPTO ? BASALT
              : (c.z < SANDSTONE_UPTO ? SANDSTONE : (c.z < QUARTZ_UPTO ? QUARTZ : RUST)));
    vec3 peb = type * (SHADE_MIN + SHADE_RANGE * c.w) * (1.0 + MOTTLE_ALB * gr.x);
    m.alb *= mix(vec3(MEAN), mix(VOID_ALB * (1.0 + GRIT_ALB * gt.x) * vec3(1.0), peb, pm), lw);
    m.g = lw * (pm * (u / sh) * rt / max(d, 1e-4) + (1.0 - pm) * GRIT_H * gt.yzw) + MOTTLE_H * gr.yzw;
    m.cav = mix(MEAN, mix(VOID_CAV, mix(RIM_CAV, 1.0, sh), pm), lw);
    m.rough += (ROUGH_VAR * (c.w - 0.5) - POLISH * pm) * lw;
  } else if (id == E_SNOW) {
    // Old powder snow: soft drifts, clumps and (up close) a sugary crust of
    // crystals; the sparkle comes from the glints.
    const float DRIFT_F = 0.22, CLUMP_F = 2.6, CRYSTAL_F = 10.0;
    const float DRIFT_H = 0.6, CLUMP_H = 0.06, CRYSTAL_H = 0.008;
    const int DRIFT_OCT = 2, CLUMP_OCT = 2, CRYSTAL_OCT = 2;   // fBm octaves
    const float DRIFT_ALB = 0.03, CLUMP_ALB = 0.04;           // albedo swing per unit of each noise
    const vec3 DEEP_TINT = vec3(0.8, 0.94, 1.12);  // deep-scattered light: ice absorbs red
    const float GLINT_DENS = 1.4;              // ice crystals: more facets than sand
    vec4 lo = mFbmD(p, DRIFT_F, DRIFT_OCT, fp);
    vec4 gr = mFbmD(p, CLUMP_F, CLUMP_OCT, fp);
    vec4 cr = mFbmD(p, CRYSTAL_F, CRYSTAL_OCT, fp);
    m.alb *= 1.0 + DRIFT_ALB * lo.x + CLUMP_ALB * gr.x;
    m.g = DRIFT_H * lo.yzw + CLUMP_H * gr.yzw + CRYSTAL_H * cr.yzw;
    m.sssCol = DEEP_TINT;
    m.glintDens = GLINT_DENS;
  } else if (id == E_GUNPOWDER) {
    // Black powder: graphite-glazed granules (~1 mm) with a soft silvery
    // sheen, a granular mottle in colour and gloss, and many tiny glints.
    const float LUMP_F = 0.6, GRAIN_F = 9.0;
    const float LUMP_H = 0.08, GRAIN_H = 0.004;
    const int LUMP_OCT = 2, GRAIN_OCT = 3;     // fBm octaves
    const float LUMP_ALB = 0.2, GRAIN_ALB = 0.7;   // albedo swing per unit of each noise
    const float GRAIN_ROUGH = 0.1, GRAIN_CAV = 0.6;   // gloss and cavity swing of the granules
    const float GLINT_DENS = 1.3;              // relative glint density (fine granules)
    vec4 lo = mFbmD(p, LUMP_F, LUMP_OCT, fp);
    vec4 gr = mFbmD(p, GRAIN_F, GRAIN_OCT, fp);
    m.alb *= (1.0 + LUMP_ALB * lo.x) * (1.0 + GRAIN_ALB * gr.x);
    m.g = LUMP_H * lo.yzw + GRAIN_H * gr.yzw;
    m.rough += GRAIN_ROUGH * gr.x;
    m.cav = 1.0 + GRAIN_CAV * gr.x;
    m.glintDens = GLINT_DENS;
  } else if (id == E_ASH) {
    // Wood ash: pale, very fine and soft, with flecks of charcoal.
    const float LUMP_F = 0.45, FINE_F = 9.0;
    const float LUMP_H = 0.15, FINE_H = 0.006;
    const float FLECK_F = 6.0, FLECK_P = 0.6, FLECK_R = 0.3;   // flecks up to ~8 mm
    const float FLECK_WARP = 0.025;            // bends flecks out of round (cells per unit slope)
    const float FLECK_SETTLE = 1.5;            // how strongly flecks gather in the hollows
    const vec3 CHARCOAL = vec3(0.025, 0.024, 0.023);
    const float CHARCOAL_ROUGH = 0.6;
    const float FLECK_SHARE = 0.5;             // share of fleck sites filled where the lumps are at their mean height
    const float FLECK_BLACK_MIN = 0.4, FLECK_BLACK_RANGE = 0.6;   // fleck-to-fleck blackness
    const int LUMP_OCT = 3, FINE_OCT = 2;      // fBm octaves
    const float LUMP_ALB = 0.2, FINE_ALB = 0.2;   // albedo swing per unit of each noise
    const float LUMP_CAV = 0.4;                // cavity swing of the lumps
    vec4 lo = mFbmD(p, LUMP_F, LUMP_OCT, fp);
    vec4 gr = mFbmD(p, FINE_F, FINE_OCT, fp);
    float fh;
    // flecks gather where the lumps are low (they settle) and vary in blackness
    vec4 fl = mDots(p + FLECK_WARP * gr.yzw, FLECK_F, FLECK_P * clamp(FLECK_SHARE - FLECK_SETTLE * lo.x, 0.0, 1.0), FLECK_R, fp, fh);
    m.alb *= 1.0 + LUMP_ALB * lo.x + FINE_ALB * gr.x;
    m.alb = mix(m.alb, CHARCOAL, fl.x * mix(1.0, FLECK_BLACK_MIN + FLECK_BLACK_RANGE * fh, lodFade(FLECK_F, fp)));
    m.rough = mix(m.rough, CHARCOAL_ROUGH, fl.x);
    m.g = LUMP_H * lo.yzw + FINE_H * gr.yzw;
    m.cav = 1.0 + LUMP_CAV * lo.x;
  } else if (id == E_WOOD) {
    // Bark: long corky plates split by deep V furrows. The plates are
    // cellular cells stretched along y (and turned about it so nothing lines
    // up with the grid), so the furrows interlace like oak or pine bark
    // instead of closing into loops. Each plate is slightly domed, has its
    // own shade and greyness, and flaky layers across it; the furrows are
    // in shade and show the darker, redder inner bark.
    const float PLATE_FH = 2.0, PLATE_FV = 0.33;   // plates per cell: across (~4 cm wide), along (~25 cm)
    const float MEANDER_F = 0.3, MEANDER = 0.3;    // furrow meander: frequency, amplitude (cells)
    const float WAVE_F = 1.3, WAVE = 0.08;         // furrow edges wander: frequency, cells per unit slope
    const float FUR_W = 0.3;                       // furrow half-width, lattice units
    const float FUR_DEPTH = 0.05, PLATE_DOME = 0.05;
    const float FLAKE_FH = 3.0, FLAKE_FV = 9.0, FLAKE_H = 0.004;   // flaky layers across a plate
    const float FIB_FH = 14.0, FIB_FV = 1.6, FIB_H = 0.003;         // fibres
    const float RIDGE_MEAN = 0.7;                  // area fraction of plate (the far-away mix)
    const vec3 FURROW = vec3(0.25, 0.2, 0.18);     // inner bark in shade, relative to the base colour
    const vec3 GREY = vec3(1.05, 1.1, 1.22);       // weathered outer bark
    const float PLATE_SHADE_MIN = 0.7, PLATE_SHADE_RANGE = 0.6;   // plate-to-plate shade
    const float MEANDER_ALB = 0.4, FLAKE_ALB = 0.3, FIB_ALB = 0.25;   // albedo swing per unit of each noise
    const float FURROW_CAV = 0.3;                  // cavity term down in a furrow
    const float FURROW_LOD = 3.0;                  // narrow furrows alias sooner: fade at this multiple of PLATE_FH
    const int MEANDER_OCT = 2, WAVE_OCT = 1;       // fBm octaves
    const vec3 FLAKE_SALT = vec3(13.1), FIB_SALT = vec3(5.7);   // noise offsets (decorrelate the layers)
    const vec2 TOP_EDGE = vec2(0.6, 0.9);          // |n.y| range over which a face turns into end grain
    mat3 J = TURN_Y30 * mat3(PLATE_FH, 0.0, 0.0, 0.0, PLATE_FV, 0.0, 0.0, 0.0, PLATE_FH);
    vec4 mv = mFbmD(p, MEANDER_F, MEANDER_OCT, fp);
    vec4 wv = mFbmD(p, WAVE_F, WAVE_OCT, fp);
    vec3 pw = p + MEANDER * mv.x * vec3(1.0, 0.0, 1.0) + WAVE * wv.yzw;
    vec3 ge, r1;
    vec4 c = mCell(J * pw, ge, r1);
    vec4 fl = mNoiseJ(p, TURN_Y30 * mat3(FLAKE_FH, 0.0, 0.0, 0.0, FLAKE_FV, 0.0, 0.0, 0.0, FLAKE_FH), FLAKE_SALT);
    vec4 fb = mNoiseJ(p, TURN_Y30 * mat3(FIB_FH, 0.0, 0.0, 0.0, FIB_FV, 0.0, 0.0, 0.0, FIB_FH), FIB_SALT);
    // narrow furrows alias sooner than the plate frequency says
    float lwF = lodFade(PLATE_FH * FURROW_LOD, fp), lwL = lodFade(FLAKE_FV, fp), lwB = lodFade(FIB_FH, fp);
    float ridge = smoothstep(0.0, FUR_W, c.y);     // 0 in a furrow, 1 on a plate
    float rl = mix(RIDGE_MEAN, ridge, lwF);
    vec3 plate = mix(vec3(1.0), (PLATE_SHADE_MIN + PLATE_SHADE_RANGE * c.z) * mix(vec3(1.0), GREY, c.w), lwF);
    m.alb *= mix(FURROW, plate, rl) * (1.0 + MEANDER_ALB * mv.x) * (1.0 + FLAKE_ALB * lwL * (fl.x - 0.5))
           * (1.0 + FIB_ALB * lwB * (fb.x - 0.5));
    m.g = lwF * transpose(J) * (FUR_DEPTH * dSmooth(0.0, FUR_W, c.y) * ge + PLATE_DOME * r1)
        + lwL * FLAKE_H * ridge * fl.yzw + lwB * FIB_H * fb.yzw;
    m.cav = mix(FURROW_CAV, 1.0, rl);
    // Sawn end grain on top faces: growth rings around the pith of each log
    // (piths on a coarse jittered lattice), wobbling with the grain, latewood
    // bands darker, heartwood darker than sapwood.
    float top = smoothstep(TOP_EDGE.x, TOP_EDGE.y, abs(n.y));
    if (top > 0.0) {
      const float LOG_SIZE = 16.0;             // cells between piths
      const float RING_F = 6.0;                // growth rings per cell (~1.3 cm apart)
      const float RING_WOBBLE = 0.6, RING_WOBBLE_F = 0.8;   // irregularity: amplitude (rings), frequency
      const float PITH_JITTER = 0.6;           // spread of a pith within its lattice cell
      const float HEART_R = 3.0;               // heartwood radius, cells
      const vec3 SAPWOOD = vec3(0.42, 0.28, 0.16), HEARTWOOD = vec3(0.3, 0.17, 0.09);
      const float LATEWOOD = 0.6;              // albedo of the latewood bands
      const vec2 LATE_EDGE = vec2(0.55, 0.95); // ring phase over which a latewood band fades in
      const float RING_LOD = 2.0;              // rings are sharp: fade them at this multiple of RING_F
      const float HEART_EDGE = 0.7;            // heartwood fades to sapwood from this fraction of HEART_R
      const float END_ROUGH = 0.65;            // sawn end grain
      const float PITH_SALT = 7.7;             // decorrelates the pith hash
      const mat2 TURN2 = mat2(0.8, 0.6, -0.6, 0.8);   // turns the pith lattice off the grid (~37°)
      vec2 xz = TURN2 * p.xz / LOG_SIZE;
      vec2 ci = floor(xz);
      float r2 = CELL_FAR;
      for (int k = 0; k < 9; k++) {
        vec2 o = vec2(float(k % 3), float(k / 3)) - 1.0;
        vec2 dv = ci + o + 0.5 + PITH_JITTER * (hash33(vec3(ci + o, PITH_SALT)).xy - 0.5) - xz;
        r2 = min(r2, dot(dv, dv));
      }
      float r = sqrt(r2) * LOG_SIZE;
      float rr = r * RING_F + RING_WOBBLE * vnoise(M_ROT * p * RING_WOBBLE_F);
      float ring = smoothstep(LATE_EDGE.x, LATE_EDGE.y, fract(rr)) * lodFade(RING_F * RING_LOD, fp);
      vec3 endg = mix(HEARTWOOD, SAPWOOD, smoothstep(HEART_EDGE * HEART_R, HEART_R, r)) * mix(1.0, LATEWOOD, ring);
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
    const float LEAF_F = 2.3;                  // leaves per cell along a line (~3.5 cm)
    const float LEAF_R = 0.5, LEAF_RV = 0.3;   // leaf half-length range, lattice units
    const float LEAF_ASPECT = 0.55;            // half-width / half-length
    const float LEAF_TILT = 1.3, LEAF_CURL = 0.3;   // facing jitter; cupping toward the rim
    const float GAP = 0.04, RIM = 0.05;        // lattice units
    const float DEPTH_ALB = 0.35, DEPTH_CAV = 0.2;  // the clump's shaded interior
    const float MEAN = 0.88;                   // area-average shade of leaves and depth (the far look)
    const float RIB_W = 0.04, RIB_ALB = 1.2;   // midrib half-width (lattice units), brightness
    const vec3 HUE_BLUE = vec3(0.8, 1.0, 0.6), HUE_YELLOW = vec3(1.3, 1.1, 0.55);   // leaf hue range
    const float SHADE_MIN = 0.65, SHADE_RANGE = 0.7;   // leaf-to-leaf shade
    const float WAX_VAR = 0.25;                // leaf-to-leaf roughness spread
    const vec3 DEEP_TINT = vec3(0.85, 1.15, 0.55);   // light that scattered through leaves
    const float LEAF_LOD = 1.5;                // fade leaves at this multiple of LEAF_F
    const float TILT_SALT = 0.37, TILT_HASH_SCALE = 157.0;   // hash input for a leaf's tilt
    vec3 ge, r1;
    vec4 c = mCell(p * LEAF_F, ge, r1);
    float lw = lodFade(LEAF_F * LEAF_LOD, fp);
    vec3 tilt = hash33(vec3(c.z, c.w, TILT_SALT) * TILT_HASH_SCALE) - 0.5;
    vec3 rt = r1 - n * dot(r1, n);             // to the seed, within the surface
    vec3 ax = normalize(tilt - n * dot(tilt, n) + 1e-4);
    float along = dot(rt, ax), across = dot(rt, cross(n, ax));
    float de = length(vec2(along, across / LEAF_ASPECT));
    float e = min(LEAF_R + LEAF_RV * c.w - de, c.y - GAP);
    float pm = smoothstep(0.0, RIM, e);        // 1 on a leaf, 0 in the depth between
    float rib = (1.0 - smoothstep(0.0, RIB_W, abs(across))) * pm;
    vec3 hue = mix(HUE_BLUE, HUE_YELLOW, c.z);   // blue-green .. yellow-green
    vec3 leaf = hue * (SHADE_MIN + SHADE_RANGE * c.w) * mix(1.0, RIB_ALB, rib);
    m.g = lw * pm * (LEAF_TILT * tilt + LEAF_CURL * rt * LEAF_F);
    m.cav = mix(MEAN, mix(DEPTH_CAV, 1.0, pm), lw);
    m.alb *= mix(vec3(MEAN), mix(DEPTH_ALB * hue, leaf, pm), lw);
    m.rough += WAX_VAR * (c.z - 0.5) * lw;     // some leaves waxier than others
    m.sssCol = DEEP_TINT;
    m.trans = 1.0;
  } else if (id == E_METAL) {
    // brushed steel: fine grooves along a fixed world direction, anisotropic highlight
    const vec3 BD = vec3(1.0, 0.1, 0.35);
    vec3 t = normalize(BD - n * dot(n, BD) + 1e-5);
    vec3 b = cross(n, t);
    // Brushing marks are far below a pixel: what shows is the stretched
    // highlight and faint streaks where the brushing pressure varied, plus
    // smudges where the polish is uneven.
    const float STREAK_F = 12.0, GROOVE_F = 40.0;   // streaks across the brushing, per cell
    const float STREAK_LEN = 0.1;              // streak length, as a fraction of their spacing
    const float SMUDGE_F = 0.35;
    const int SMUDGE_OCT = 2;                  // fBm octaves
    const float STREAK_SLICE = 0.5, GROOVE_SLICE = 7.5;   // noise z slices (decorrelate the two)
    const float GROOVE_W = 0.6;                // grooves' weight relative to the streaks
    const float SMUDGE_ROUGH = 0.1, BRUSH_ROUGH = 0.08;   // roughness swing per unit of each
    const float SMUDGE_ALB = 0.06, BRUSH_ALB = 0.05;      // albedo swing per unit of each
    const float BRUSH_ANISO = 0.7;             // anisotropy of the brushed highlight
    float u = dot(p, t), w = dot(p, b);
    float s1 = vnoise(vec3(u * STREAK_F * STREAK_LEN, w * STREAK_F, STREAK_SLICE));
    float s2 = vnoise(vec3(u * GROOVE_F * STREAK_LEN, w * GROOVE_F, GROOVE_SLICE));
    float l1 = lodFade(STREAK_F, fp), l2 = lodFade(GROOVE_F, fp);
    vec4 lo = mFbmD(p, SMUDGE_F, SMUDGE_OCT, fp);
    float br = l1 * (s1 - 0.5) + GROOVE_W * l2 * (s2 - 0.5);
    m.rough = ROUGH[id] + SMUDGE_ROUGH * lo.x + BRUSH_ROUGH * br;
    m.alb *= 1.0 + SMUDGE_ALB * lo.x + BRUSH_ALB * br;
    m.tang = t; m.aniso = BRUSH_ANISO;
    // Hot steel grows black mill scale (magnetite): a rough dielectric, no
    // longer a metal mirroring the sky. It is patchy; where it is thick it
    // blisters off the steel and runs cooler, so the glow is mottled with dark
    // patches (a look only: the oxide isn't simulated and fades as it cools).
    float ox = smoothstep(OXIDE_T0, OXIDE_T1, T);
    float flakeT = T;   // temperature of the visible surface
    if (ox > 0.0) {
      vec4 th = mFbmD(p, SCALE_FREQ, SCALE_OCT, fp);   // scale thickness, centred on 0
      m.alb = mix(m.alb, OXIDE_ALB * (1.0 + SCALE_ALB_VAR * th.x), ox);
      m.metal *= 1.0 - ox;
      m.f0 = mix(m.f0, OXIDE_F0, ox);
      m.rough = mix(m.rough, OXIDE_ROUGH, ox);
      m.aniso *= 1.0 - ox;
      m.g = mix(m.g, SCALE_BUMP * th.yzw, ox);
      flakeT = T - ox * SCALE_DROP * smoothstep(-SCALE_SPLIT, SCALE_SPLIT, th.x + SCALE_COVER);
    }
    // steel conducts: no skin of its own, only the insulating flakes run cooler
    m.emit = glowAt(m, flakeT);
  } else if (id == E_CLONE) {
    // Polished gold: a faint waviness left by the polishing and a fine haze
    // in the gloss. No blotches: gold doesn't tarnish.
    const float WAVE_F = 0.5, HAZE_F = 6.0;
    const float WAVE_H = 0.015;
    const int WAVE_OCT = 2, HAZE_OCT = 2;      // fBm octaves
    const float WAVE_ROUGH = 0.05, HAZE_ROUGH = 0.03;   // roughness swing per unit of each noise
    vec4 lo = mFbmD(p, WAVE_F, WAVE_OCT, fp);
    vec4 hz = mFbmD(p, HAZE_F, HAZE_OCT, fp);
    m.g = WAVE_H * lo.yzw;
    m.rough += WAVE_ROUGH * lo.x + HAZE_ROUGH * hz.x;
  } else if (id == E_WALL) {
    // Cast concrete: cloudy mottling from the pour, fine sand-and-cement
    // grit, scattered round air-bubble pits ("bug holes", up to ~1 cm) and
    // faint rain streaks down vertical faces.
    const float MOTTLE_F = 0.18, GRIT_F = 5.0;
    const float MOTTLE_H = 0.06, GRIT_H = 0.012;
    const float PIT_F = 2.2, PIT_P = 0.3, PIT_R = 0.22, PIT_DEPTH = 0.004;
    const float PIT_ALB = 0.45;                // a pit's shadowed floor
    const float STREAK_FH = 2.5, STREAK_FV = 0.12, STREAK_DARK = 0.12;
    const vec2 STREAK_EDGE = vec2(0.45, 0.85);    // noise range over which a streak fades in
    const float STREAK_SALT = 2.3;             // noise offset of the streaks
    const int MOTTLE_OCT = 3, GRIT_OCT = 3;    // fBm octaves
    const float MOTTLE_ALB = 0.35, GRIT_ALB = 0.25;   // albedo swing per unit of each noise
    const float PIT_CAV = 0.6, GRIT_CAV = 0.3; // cavity: down in a pit, swing with the grit
    const float GRIT_ROUGH = 0.08;             // roughness swing with the grit
    vec4 lo = mFbmD(p, MOTTLE_F, MOTTLE_OCT, fp);
    vec4 gr = mFbmD(p, GRIT_F, GRIT_OCT, fp);
    float ph;
    vec4 pit = mDots(p, PIT_F, PIT_P, PIT_R, fp, ph);
    float st = vnoise(TURN_Y30 * (p * vec3(STREAK_FH, STREAK_FV, STREAK_FH)) + STREAK_SALT);
    float streak = STREAK_DARK * (1.0 - abs(n.y)) * smoothstep(STREAK_EDGE.x, STREAK_EDGE.y, st) * lodFade(STREAK_FH, fp);
    m.alb *= (1.0 + MOTTLE_ALB * lo.x + GRIT_ALB * gr.x) * mix(1.0, PIT_ALB, pit.x) * (1.0 - streak);
    m.g = MOTTLE_H * lo.yzw + GRIT_H * gr.yzw - PIT_DEPTH * pit.yzw;
    m.cav = (1.0 - PIT_CAV * pit.x) * (1.0 + GRIT_CAV * gr.x);
    m.rough += GRIT_ROUGH * gr.x;
  } else if (id == E_ROCK) {
    // Weathered volcanic rock: big lumps, then craggy relief from several
    // octaves of crease noise (flat-topped knobs between sharp V creases,
    // each octave turned and warped by the lumps, so the creases of one
    // scale break up those of the next instead of drawing a network), dark
    // in its hollows; rusty oxidised and pale weathered patches, faint
    // flow banding and, up close, clusters of gas vesicles. No cell
    // lattice: that read as paving.
    const float LUMP_F = 0.16, LUMP_H = 0.9;
    const float CRAG_F = 0.55, CRAG_H = 0.14;  // first crag octave: frequency, relief (cells)
    const float CRAG_LAC = 2.13, CRAG_GAIN = 0.55;   // per octave: frequency x, relief x
    // The first octave is creases (h = 1 - (1 - c)^2: flat knobs, V valleys),
    // the finer ones sharp ridges (h = (1 - c)^2): broken, angular edges
    // instead of the soft knobs that read as clay.
    const float CREASE_MEAN = 0.6, RIDGE_MEAN = 0.4;   // mean heights of the two profiles
    const float GRAIN_F = 4.5, GRAIN_H = 0.045;    // gritty surface (3 octaves, to ~2 mm)
    const float WARP = 3.0;                    // crag warp per unit of the lumps' slope (cells)
    const float TINT_F = 0.09;                 // oxidised / weathered patches
    const vec3 RUST = vec3(1.18, 0.98, 0.86), PALE = vec3(1.3, 1.3, 1.28);
    const vec2 RUST_EDGE = vec2(0.6, 0.8), PALE_EDGE = vec2(0.35, 0.15);   // tint-noise ranges of the patches
    const vec2 SKY_EDGE = vec2(0.2, 0.8);      // n.y range over which a face counts as sky-facing
    const float BAND_FH = 0.05, BAND_FV = 0.4; // lava-flow banding
    const vec3 BAND_LO = vec3(0.94, 0.96, 1.0), BAND_HI = vec3(1.06, 1.0, 0.94);
    const float VES_F = 7.0, VES_P = 0.55, VES_R = 0.32, VES_DEPTH = 0.003, VES_ALB = 0.35;
    const float VES_CLUSTER_F = 0.3;           // vesicles come in patches
    const vec2 VES_CLUSTER_EDGE = vec2(0.45, 0.7);
    const float VES_WARP = 0.02;               // bends vesicles out of round (cells per unit slope)
    const int LUMP_OCT = 3, CRAG_OCT = 3, GRAIN_OCT = 3;   // octaves (fBm; crease noise)
    const float CRAG_LOD = 2.0;                // creases are sharp: fade them at this multiple of their frequency
    const float CRAG_SALT = 3.1, CRAG_SALT_STEP = 5.3;   // noise offset of the first crag octave, added per octave
    const float TINT_SALT = 1.7, VES_CLUSTER_SALT = 6.1;  // noise offsets
    const float LUMP_ALB = 0.35, GRAIN_ALB = 0.6, CRAG_ALB = 0.6;   // albedo swing per unit of each
    const float HOLLOW_CAV = 0.8, VES_CAV = 0.6, GRAIN_CAV = 0.6;   // cavity: hollows of the relief, vesicles, grit
    const float GRAIN_ROUGH = 0.1;             // roughness swing with the grit
    vec4 lo = mFbmD(p, LUMP_F, LUMP_OCT, fp);
    vec3 pw = p + WARP * lo.yzw;
    float hc = 0.0, ws = 0.0;                  // relief (relative to its mean), weight
    vec3 gc = vec3(0.0);
    mat3 J = M_ROT * CRAG_F;
    float f = CRAG_F, a = 1.0;
    for (int i = 0; i < CRAG_OCT; i++) {
      float lw = lodFade(CRAG_LOD * f, fp);
      vec4 c = mCreaseJ(pw, J, vec3(CRAG_SALT + CRAG_SALT_STEP * float(i)));
      float r2 = (1.0 - c.x) * (1.0 - c.x);
      vec3 dr2 = -2.0 * (1.0 - c.x) * c.yzw;
      hc += a * lw * (i == 0 ? 1.0 - r2 - CREASE_MEAN : r2 - RIDGE_MEAN);
      gc += a * lw * (i == 0 ? -dr2 : dr2);
      ws += a;
      J = M_ROT * J * CRAG_LAC; f *= CRAG_LAC; a *= CRAG_GAIN;
    }
    hc /= ws;                                  // relief about its mean, roughly ±0.5
    vec4 gr = mFbmD(p, GRAIN_F, GRAIN_OCT, fp);
    float tn = vnoise(M_ROT * p * TINT_F + TINT_SALT);
    float rust = smoothstep(RUST_EDGE.x, RUST_EDGE.y, tn);
    float pale = smoothstep(PALE_EDGE.x, PALE_EDGE.y, tn) * smoothstep(SKY_EDGE.x, SKY_EDGE.y, n.y);   // weathering on what faces the sky
    float band = vnoise(vec3(p.x * BAND_FH, p.y * BAND_FV, p.z * BAND_FH));
    float vh;
    float vp = VES_P * smoothstep(VES_CLUSTER_EDGE.x, VES_CLUSTER_EDGE.y, vnoise(M_ROT * p * VES_CLUSTER_F + VES_CLUSTER_SALT));
    vec4 ves = mDots(p + VES_WARP * gr.yzw, VES_F, vp, VES_R, fp, vh);
    m.alb *= (1.0 + LUMP_ALB * lo.x + GRAIN_ALB * gr.x) * (1.0 + CRAG_ALB * hc)
           * mix(vec3(1.0), RUST, rust) * mix(vec3(1.0), PALE, pale) * mix(BAND_LO, BAND_HI, band)
           * mix(1.0, VES_ALB, ves.x);
    m.g = LUMP_H * lo.yzw + CRAG_H * gc + GRAIN_H * gr.yzw - VES_DEPTH * ves.yzw;
    m.cav = (1.0 + HOLLOW_CAV * min(hc, 0.0)) * (1.0 - VES_CAV * ves.x) * (1.0 + GRAIN_CAV * gr.x);
    m.rough += GRAIN_ROUGH * gr.x;
  } else if (id == E_LAVA) {
    // Molten well above the solidus; nearer it a crust skins over. The crust
    // radiates its heat away far below the bulk temperature and breaks into
    // plates: the cracks between them show the melt, brightest down the middle
    // and dull red where they meet the cooler plate edges.
    float Ts = solidusOf(ctype);
    vec4 sk = mFbmD(p + vec3(0.0, uTime * LAVA_CHURN, 0.0), LAVA_SKIN_FREQ, LAVA_SKIN_OCT, fp);   // churning skin
    float x = (T - Ts) / LAVA_MELT_RANGE + LAVA_SKIN_VAR * sk.x;   // 0 = at the solidus, 1 = fully molten
    float crust = 1.0 - smoothstep(LAVA_CRUST_X0, LAVA_CRUST_X1, x);
    vec3 ge, r1;
    vec4 c = mCell(p * LAVA_PLATE_FREQ, ge, r1);   // crust plates
    float lwc = lodFade(LAVA_PLATE_FREQ * LAVA_CRACK_LOD, fp);
    // crack half-width: hairlines once the crust has set, wide enough to
    // swallow the plates once it has broken up
    float w = mix(LAVA_CRACK_SHUT, LAVA_CRACK_OPEN, (1.0 - crust) * (1.0 - crust));
    float crk = mix(1.0 - smoothstep(LAVA_CRACK_CORE * w, w, c.y), min(LAVA_CRACK_AREA * w, 1.0), 1.0 - lwc);   // open melt
    float rim = 1.0 - smoothstep(LAVA_CRACK_CORE * w, w + LAVA_RIM, c.y);   // 1 in the melt .. 0 on the plate
    float Tmelt = T + LAVA_SKIN_DT * sk.x;
    // young crust is thin and still glows; old crust is cold on top
    float Tcrust = mix(T, min(T, LAVA_CRUST_T + LAVA_CRUST_K * (T - Ts)), crust);
    vec3 eNear = incandescence(mix(Tcrust, Tmelt, rim * rim));
    vec3 eFar = mix(incandescence(Tcrust), incandescence(Tmelt), crk);
    m.emit = mix(eFar, eNear, lwc);
    float solid = 1.0 - crk;
    m.alb = mix(LAVA_MELT_ALB, ALBEDO[id] * (1.0 + LAVA_CRUST_VAR * (c.z - 0.5)), solid);
    m.rough = mix(LAVA_MELT_ROUGH, LAVA_CRUST_ROUGH, solid);
    m.g = solid * lwc * LAVA_PLATE_BUMP * dSmooth(0.0, LAVA_PLATE_EDGE, c.y) * ge * LAVA_PLATE_FREQ
        + (1.0 - solid) * LAVA_SKIN_BUMP * sk.yzw;
    m.cav = mix(1.0, mix(LAVA_CRACK_CAV, 1.0, smoothstep(0.0, LAVA_PLATE_EDGE, c.y)), solid * lwc);
  }
  if (id != E_LAVA && id != E_METAL) m.emit = hotEmit(m, T);
  return m;
}

// Base colour of an element at world point p (kept for callers that only need a colour).
vec3 albedoOf(int id, vec3 p, float seed) {
  return matOf(id, p, vec3(0.0, 1.0, 0.0), AMBIENT, 0.0, 0.0).alb;
}

const float MAT_ROUGH_MIN = 0.04;   // smoothest a textured surface may get (GGX roughness)
const float BUMP_MAX_SLOPE = 1.5;   // cap on the bump's tangential height gradient
void applyMat(inout Surf s, Mat m) {
  s.albedo = max(m.alb, vec3(0.0)); s.rough = clamp(m.rough, MAT_ROUGH_MIN, 1.0); s.metal = m.metal; s.f0 = m.f0;
  s.sss = m.sss; s.sssCol = m.sssCol; s.glint = m.glint; s.glintDens = m.glintDens;
  s.cav = clamp(m.cav, 0.0, 1.0); s.aniso = m.aniso; s.tang = m.tang; s.trans = m.trans; s.emit = m.emit;
  // bump: tilt the normal by the tangential part of the height gradient
  vec3 gt = m.g - s.ng * dot(s.ng, m.g);
  float gl = length(gt);
  if (gl > BUMP_MAX_SLOPE) gt *= BUMP_MAX_SLOPE / gl;
  s.n = normalize(s.ng - gt);
}

// Surface record for a smooth-channel hit: blend the material of the cells of
// that channel around the point, weighted trilinearly. The two most common
// elements get a full material each; their border is broken up with noise so
// it doesn't follow the cell lattice.
const float GATHER_DEPTH = 0.4;      // cells below the surface where the cells are weighted
const float GATHER_W_MIN = 1e-3;     // weight floor: every cell of the channel counts a little
const float GATHER_DEEP = 0.9;       // cells below the surface for the fallback search
const vec2 MAT_BORDER_EDGE = vec2(0.25, 0.75);   // share of the second element over which it takes over
const float MAT_BORDER_F = 1.7;      // frequency of the noise breaking up that border, per cell
const float MAT_BORDER_SALT = 2.9;   // its noise offset
const float MAT_BORDER_AMP = 0.6;    // how far it shifts the share
Surf gatherSurf(vec3 hp, vec3 n, int ch) {
  Surf s;
  s.p = hp; s.n = n; s.ng = n; s.ch = ch; s.id = E_EMPTY; s.cell = ivec3(floor(hp - n * 0.5)); s.seed = 0.0;
  s.face = ivec3(0, 1, 0);
  vec3 q = hp - n * GATHER_DEPTH - 0.5;
  ivec3 c0 = ivec3(floor(q));
  vec3 f = q - vec3(c0);
  int id1 = -1, id2 = -1;
  float w1 = 0.0, w2 = 0.0, T = 0.0, wsum = 0.0, wbest = -1.0, ct1 = 0.0, ct2 = 0.0;
  for (int i = 0; i < 8; i++) {
    ivec3 o = ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    ivec3 c = c0 + o;
    if (outside(c)) continue;
    vec4 a = cellA(c);
    int id = eid(a);
    if (SURFCH[id] != ch) continue;
    vec3 wv = mix(1.0 - f, f, vec3(o));
    float w = wv.x * wv.y * wv.z + GATHER_W_MIN;
    T += w * a.y;
    wsum += w;
    if (id1 < 0 || id == id1) {
      id1 = id; w1 += w;
      if (w > wbest) { wbest = w; s.cell = c; s.seed = fract(a.w); ct1 = floor(a.w); }
    } else if (id2 < 0 || id == id2) {
      if (id2 < 0) ct2 = floor(a.w);
      id2 = id; w2 += w;
    }
  }
  if (wsum == 0.0) {
    // the smoothed surface spilled past its own cells: look a bit deeper
    ivec3 cc = ivec3(floor(hp - n * GATHER_DEEP));
    for (int i = 0; i < 27 && wsum == 0.0; i++) {
      ivec3 c = cc + ivec3(i % 3, (i / 3) % 3, i / 9) - 1;
      if (outside(c)) continue;
      vec4 a = cellA(c);
      int id = eid(a);
      if (SURFCH[id] != ch) continue;
      id1 = id; w1 = 1.0; T = a.y; wsum = 1.0; s.cell = c; s.seed = fract(a.w); ct1 = floor(a.w);
    }
  }
  if (wsum == 0.0) {
    id1 = ch == CH_LIQUID ? E_WATER : (ch == CH_MOLTEN ? E_LAVA : (ch == CH_GRANULAR ? E_SAND : E_PLANT));
    w1 = 1.0; T = AMBIENT; wsum = 1.0;
  }
  if (w2 > w1) { int ti = id1; id1 = id2; id2 = ti; float tw = w1; w1 = w2; w2 = tw; float tc = ct1; ct1 = ct2; ct2 = tc; }
  s.id = id1;
  s.T = T / wsum;
  float fp = footprint(hp);
  Mat m = matOf(id1, hp, n, s.T, ct1, fp);
  if (id2 >= 0) {
    float r = w2 / (w1 + w2);
    float k = smoothstep(MAT_BORDER_EDGE.x, MAT_BORDER_EDGE.y,
                         r + (vnoise(M_ROT * hp * MAT_BORDER_F + MAT_BORDER_SALT) - 0.5) * MAT_BORDER_AMP);
    if (k > 0.0) m = mixMat(m, matOf(id2, hp, n, s.T, ct2, fp), k);
  }
  applyMat(s, m);
  return s;
}

// ---- crisp voxels: bevelled boxes ----
// A crisp neighbour that a voxel's face is flush with (the floor counts; glass doesn't).
bool flushNb(ivec3 c) {
  if (c.y < 0) return true;
  if (outside(c)) return false;
  int id = eid(cellA(c));
  return isCrisp(id) && RCLASS[id] != R_GLASS;
}

// Ray vs rounded box (Inigo Quilez): centred at the origin, inner half-size b,
// radius r. Returns the entry t, RBOX_MISS on a miss, RBOX_INSIDE if ro is inside the bounds.
const float RBOX_MISS = -1.0, RBOX_INSIDE = -2.0;
const float RBOX_NONE = 1e20;        // "no root yet"
const float RBOX_NONE_TEST = 1e19;   // a t above this is still RBOX_NONE
float rboxHit(vec3 ro, vec3 rd, vec3 b, float r) {
  vec3 m = 1.0 / rd;
  vec3 nn = m * ro;
  vec3 k = abs(m) * (b + r);
  vec3 t1 = -nn - k, t2 = -nn + k;
  float tN = max(max(t1.x, t1.y), t1.z);
  float tF = min(min(t2.x, t2.y), t2.z);
  if (tN > tF || tF < 0.0) return RBOX_MISS;
  if (tN < 0.0) return RBOX_INSIDE;
  float t = tN;
  vec3 pos = ro + t * rd;
  vec3 s = sign(pos);
  ro *= s; rd *= s; pos *= s;
  pos -= b;
  pos = max(pos.xyz, pos.yzx);
  if (min(min(pos.x, pos.y), pos.z) < 0.0) return t;   // a flat face
  vec3 oc = ro - b;
  vec3 dd = rd * rd, oo = oc * oc, od = oc * rd;
  float ra2 = r * r;
  t = RBOX_NONE;
  { float bb = od.x + od.y + od.z, c = oo.x + oo.y + oo.z - ra2, h = bb * bb - c;
    if (h > 0.0) t = -bb - sqrt(h); }
  { float a = dd.y + dd.z, bb = od.y + od.z, c = oo.y + oo.z - ra2, h = bb * bb - a * c;
    if (h > 0.0) { h = (-bb - sqrt(h)) / a; if (h > 0.0 && h < t && abs(ro.x + rd.x * h) < b.x) t = h; } }
  { float a = dd.z + dd.x, bb = od.z + od.x, c = oo.z + oo.x - ra2, h = bb * bb - a * c;
    if (h > 0.0) { h = (-bb - sqrt(h)) / a; if (h > 0.0 && h < t && abs(ro.y + rd.y * h) < b.y) t = h; } }
  { float a = dd.x + dd.y, bb = od.x + od.y, c = oo.x + oo.y - ra2, h = bb * bb - a * c;
    if (h > 0.0) { h = (-bb - sqrt(h)) / a; if (h > 0.0 && h < t && abs(ro.z + rd.z * h) < b.z) t = h; } }
  return t > RBOX_NONE_TEST ? RBOX_MISS : t;
}

// Shape of a crisp voxel: the ray enters the cell at tEnter through face
// normal n. The voxel is a box with rounded edges, but only where it is
// exposed: on sides with a flush crisp neighbour the box reaches past the cell,
// so a wall of many voxels is one flat slab with rounded outer edges (concave
// edges stay sharp). Returns false if the shape is missed within [tEnter, tExit).
const float CRISP_EPS = 1e-4;   // tolerance of the entry tests (cells)
bool crispHit(ivec3 cell, int id, vec3 ro, vec3 rd, float tEnter, float tExit, inout float t, inout vec3 n) {
  float R = uBevel;
  if (R <= 0.0 || RCLASS[id] == R_GLASS) return true;
  vec3 lo = vec3(0.0), hi = vec3(1.0);
  for (int k = 0; k < 3; k++) {
    ivec3 e = ivec3(0);
    e[k] = 1;
    if (flushNb(cell - e)) lo[k] = -R;
    if (flushNb(cell + e)) hi[k] = 1.0 + R;
  }
  vec3 b = 0.5 * (hi - lo) - R;
  vec3 c = vec3(cell) + 0.5 * (lo + hi);
  vec3 pe = ro + rd * tEnter - c;
  if (length(max(abs(pe) - b, 0.0)) <= R + CRISP_EPS) return true;   // entered through a flat part
  float tb = tEnter - 1.0;
  float th = rboxHit(ro + rd * tb - c, rd, b, R);
  if (th == RBOX_INSIDE) return true;
  if (th < 0.0) return false;
  th += tb;
  if (th < tEnter - CRISP_EPS || th >= tExit) return false;
  t = max(th, tEnter);
  vec3 ph = ro + rd * t - c;
  vec3 q = max(abs(ph) - b, 0.0);
  if (dot(q, q) > 1e-12) n = sign(ph) * normalize(q);
  return true;
}

// Surface record for a crisp voxel, or (with ch set by the caller) a grain.
Surf crispSurf(ivec3 cell, int id, vec4 a, vec3 hp, vec3 n) {
  Surf s;
  s.p = hp; s.n = n; s.ng = n; s.ch = -1; s.id = id; s.cell = cell; s.seed = fract(a.w); s.T = a.y;
  vec3 an = abs(n);
  s.face = an.x >= an.y && an.x >= an.z ? ivec3(int(sign(n.x)), 0, 0)
         : (an.y >= an.z ? ivec3(0, int(sign(n.y)), 0) : ivec3(0, 0, int(sign(n.z))));
  // an isolated grain carries its texture with it (its seed moves with the grain)
  const float GRAIN_TEX_SPREAD = 61.0;   // cells of texture space the seed spreads grains over
  vec3 tp = SURFCH[id] >= 0 ? hp - vec3(cell) + s.seed * GRAIN_TEX_SPREAD : hp;
  applyMat(s, matOf(id, tp, n, a.y, floor(a.w), footprint(hp)));
  return s;
}

// ---- shading ----
// Split-sum environment BRDF, analytic fit (Karis 2014): (scale, bias) on F0.
vec2 envBRDF(float nv, float rough) {
  // the fit's coefficients
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  const float c2 = -9.28;
  const vec2 c3 = vec2(-1.04, 1.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(c2 * nv)) * r.x + r.y;
  return c3 * a004 + r.zw;
}

const float GGX_ALPHA_MIN = 2e-3;   // floor on GGX alpha (= roughness²): keeps the lobe finite

// Height-correlated Smith visibility, V = G2 / (4 n·l n·v).
float smithV(float nl, float nv, float a) {
  float a2 = a * a;
  float gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  float gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

// GGX specular BRDF times n·l, optionally anisotropic: grooves along t are
// smoother along t than across, so the highlight stretches across them.
vec3 ggxSpecA(vec3 n, vec3 v, vec3 l, float rough, vec3 F0, vec3 t, float aniso) {
  float nl = dot(n, l);
  if (nl <= 0.0) return vec3(0.0);
  vec3 h = normalize(v + l);
  float nv = max(dot(n, v), 1e-4), nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
  float a = max(rough * rough, GGX_ALPHA_MIN);
  float D;
  if (aniso > 0.0) {
    vec3 b = normalize(cross(n, t));
    t = cross(b, n);
    float at = max(a * (1.0 - aniso), GGX_ALPHA_MIN), ab = max(a * (1.0 + aniso), GGX_ALPHA_MIN);
    float th = dot(t, h) / at, bh = dot(b, h) / ab;
    float d = th * th + bh * bh + nh * nh;
    D = 1.0 / (PI_S * at * ab * d * d);
    a = sqrt(at * ab);
  } else {
    float a2 = a * a;
    float d = nh * nh * (a2 - 1.0) + 1.0;
    D = a2 / (PI_S * d * d);
  }
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
  return D * smithV(nl, nv, a) * F * nl;
}
vec3 ggxSpec(vec3 n, vec3 v, vec3 l, float rough, vec3 F0) {
  return ggxSpecA(n, v, l, rough, F0, vec3(1.0, 0.0, 0.0), 0.0);
}

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
const float GLINT_CELL_PX = 6.0;       // lattice cell size in pixels, at glintDens 1
const float GLINT_R0 = 0.17, GLINT_R1 = 0.25;   // facet ball radius: solid core, soft edge (lattice units)
const float GLINT_COV = 0.0396;        // volume of that soft ball = the disc area it covers on average
const float GLINT_DELTA = 0.12;        // angular tolerance (radians)
const float GLINT_OMEGA = PI_S * GLINT_DELTA * GLINT_DELTA * 0.5;   // integral of the kernel below
// Cap on the facets' slope spread: the crystal faces that flash lie flatter
// than the grains' overall roughness, so sparkles gather around the sun's
// reflection instead of peppering the whole surface.
const float GLINT_FACET_ROUGH = 0.5;
const float GLINT_LEVEL_SALT = 17.3;   // decorrelates the facets of different levels
const float GLINT_NORMAL_SALT = 41.7;  // decorrelates a facet's normal from its position
const float GLINT_FRAME_UP_MAX = 0.9;  // |n.y| above which the tangent frame is built from x instead of y
const float TWO_PI_S = 6.2831853;

// Kernel weight times coverage of the facet in q's lattice cell.
float glintFacet(vec3 q, vec3 n, vec3 t1, vec3 t2, vec3 h, float a2, float salt) {
  vec3 ci = floor(q);
  vec3 h1 = hash33(ci + salt);
  float cov = 1.0 - smoothstep(GLINT_R0, GLINT_R1, length(q - ci - (GLINT_R1 + (1.0 - 2.0 * GLINT_R1) * h1)));
  if (cov <= 0.0) return 0.0;
  vec3 h2 = hash33(ci + salt + GLINT_NORMAL_SALT);
  float phi = TWO_PI_S * h2.x;
  float ct = sqrt((1.0 - h2.y) / (1.0 + (a2 - 1.0) * h2.y));
  float st = sqrt(max(1.0 - ct * ct, 0.0));
  vec3 m = (t1 * cos(phi) + t2 * sin(phi)) * st + n * ct;
  float x = length(m - h) / GLINT_DELTA;
  return max(1.0 - x * x, 0.0) * cov;
}

vec3 glintSpec(vec3 p, vec3 n, vec3 v, vec3 l, float rough, vec3 F0, float dens) {
  float nl = dot(n, l);
  if (nl <= 0.0) return vec3(0.0);
  float lv = log2(dens / (GLINT_CELL_PX * footprint(p)));   // lattice level wanted
  float L0 = floor(lv), t = lv - L0;
  float r = min(rough, GLINT_FACET_ROUGH);
  float a = max(r * r, GGX_ALPHA_MIN);
  vec3 h = normalize(v + l);
  vec3 t1 = normalize(cross(n, abs(n.y) < GLINT_FRAME_UP_MAX ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(n, t1);
  vec3 q = M_ROT * p;
  float k = (1.0 - t) * glintFacet(q * exp2(L0), n, t1, t2, h, a * a, L0 * GLINT_LEVEL_SALT)
          + t * glintFacet(q * exp2(L0 + 1.0), n, t1, t2, h, a * a, (L0 + 1.0) * GLINT_LEVEL_SALT);
  if (k <= 0.0) return vec3(0.0);
  float nv = max(dot(n, v), 1e-4), nh = max(dot(n, h), 1e-3), vh = max(dot(v, h), 0.0);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
  return F * smithV(nl, nv, a) * nl * k / (nh * GLINT_OMEGA * GLINT_COV);
}

// Diffuse of a rough (powdery) surface relative to Lambert, times n·l: Fujii's
// improved qualitative Oren–Nayar (sigma = facet slope spread, radians).
// Flatter than Lambert and brighter toward the sun (back-scattering).
float orenNayar(float nl, float nv, float lv, float sigma) {
  float s = lv - nl * nv;
  float t = s > 0.0 ? max(max(nl, nv), 1e-3) : 1.0;
  float A = 1.0 / (1.0 + (0.5 - 2.0 / (3.0 * PI_S)) * sigma);
  return max(nl, 0.0) * A * (1.0 + sigma * s / t);
}

// Reflections go from a sharp sky to the probes' blurred light over this roughness range.
const float ENV_SHARP_ROUGH = 0.25;
const float ENV_BLUR_ROUGH = 0.9;
const float LOCAL_PROBE_LIFT = 0.75;   // cells off the surface where the glow volume is sampled
// Glow-volume light: this much reaches even fully occluded spots, plus LOCAL_AO_GAIN × AO.
const float LOCAL_AO_MIN = 0.35, LOCAL_AO_GAIN = 0.65;
const float SHADE_NV_MIN = 0.05;       // the bumped normal faces the eye at least this much (cosine)
// Oren–Nayar slope spread: none up to ON_ROUGH_START, then ON_SIGMA_RATE radians per unit roughness.
const float ON_ROUGH_START = 0.45, ON_SIGMA_RATE = 1.6;
// Sun diffuse: this much ignores the cavity term, plus SUN_CAV_GAIN × cavity.
const float SUN_CAV_MIN = 0.5, SUN_CAV_GAIN = 0.5;
// Leaves: thickness of the clump toward the sun, from two samples of the natural-solids field
// (distance along the sun ray, cells; cells of path each stands for).
const float LEAF_TH_D1 = 0.9, LEAF_TH_W1 = 0.9, LEAF_TH_D2 = 2.2, LEAF_TH_W2 = 1.3;
const float LEAF_SHADOW_D = 3.0;       // cells toward the sun where the light through them is shadow-tested
const float LEAF_TRANS_GAIN = 1.6;     // brightness of the light through
const float LEAF_EXT = 2.5;            // its extinction per cell of clump
const float ANISO_BEND_RATE = 5.0;     // anisotropic lookup bend reaches full strength by roughness 1/this
vec3 shadeSurf(Surf s, vec3 rd) {
  vec3 v = -rd;
  vec3 ng = s.ng;
  float ao = s.ch >= 0 ? fieldAO(s.p, ng) : faceAO(s.cell, s.face, s.p);
  vec3 local = sampleLight(s.p + ng * LOCAL_PROBE_LIFT) * uLightGain;
  // keep the bumped normal on the visible side
  vec3 n = s.n;
  float nvr = dot(n, v);
  if (nvr < SHADE_NV_MIN) n = normalize(n + v * (SHADE_NV_MIN - nvr));
  float nv = clamp(dot(n, v), 1e-4, 1.0);
  vec3 l = uSun;
  float nl = dot(n, l), ngl = dot(ng, l);
  float w = s.sss;
  vec3 sh = vec3(0.0);
  if (max(nl, ngl) + w > 0.0) sh = uShadows ? sunShadow(s.p, ng) : vec3(1.0);
  float aoT = ao * s.cav;

  // specular layer (F0) and the energy it takes from the diffuse one
  // (multiple-scattering GGX after Fdez-Agüera 2019)
  vec3 F0 = mix(vec3(s.f0), s.albedo, s.metal);
  vec2 AB = envBRDF(nv, s.rough);
  vec3 FssEss = F0 * AB.x + AB.y;
  float Ess = AB.x + AB.y;
  float Ems = 1.0 - Ess;
  vec3 Favg = F0 + (1.0 - F0) / 21.0;
  vec3 Fms = FssEss * Favg / (1.0 - Ems * Favg);
  vec3 kD = s.albedo * (1.0 - s.metal) * (1.0 - FssEss - Fms * Ems);

  // sun: diffuse (rough powders back-scatter; porous stuff wraps light past the terminator)
  float sigma = max(s.rough - ON_ROUGH_START, 0.0) * ON_SIGMA_RATE;
  float lam = orenNayar(nl, nv, dot(l, v), sigma);
  float wrap = max(nl + w, 0.0) / ((1.0 + w) * (1.0 + w));
  vec3 dSun = kD * mix(vec3(lam), wrap * s.sssCol, w);
  // sun: specular, with multiple-scattering energy compensation
  vec3 spec = ggxSpecA(n, v, l, s.rough, F0, s.tang, s.aniso) * (1.0 + F0 * (1.0 / max(Ess, 1e-3) - 1.0));
  float g = s.glint * uGlints;   // (glintSpec sizes its facets to the pixel, so no distance fade)
  if (g > 0.0) spec = mix(spec, glintSpec(s.p, n, v, l, s.rough, F0, s.glintDens), g);
  // (SUN_COL is irradiance / pi in this renderer's units, hence the pi on the BRDF term)
  vec3 c = SUN_COL * sh * (dSun * (SUN_CAV_MIN + SUN_CAV_GAIN * s.cav) + PI_S * spec);

  // leaves: sunlight through a thin clump (thickness from the natural-solids field)
  if (s.trans > 0.0 && ngl < 0.0) {
    float th = surfField(s.p + l * LEAF_TH_D1)[CH_ORGANIC] * LEAF_TH_W1
             + surfField(s.p + l * LEAF_TH_D2)[CH_ORGANIC] * LEAF_TH_W2;
    vec3 shT = uShadows ? sunShadow(s.p + l * LEAF_SHADOW_D) : vec3(1.0);
    c += s.trans * SUN_COL * shT * (s.albedo * s.sssCol * LEAF_TRANS_GAIN) * (-ngl) * exp(-LEAF_EXT * th);
  }

  // environment: specular (anisotropic lobes bend the lookup normal, rough
  // lobes reflect toward the normal), horizon- and AO-occluded. The probes'
  // light toward r (sky + bounce, already occluded), blurrier for rough lobes.
  vec3 nb = n;
  if (s.aniso > 0.0) {
    vec3 at = cross(s.tang, v);
    nb = normalize(mix(n, cross(at, s.tang), s.aniso * clamp(ANISO_BEND_RATE * s.rough, 0.0, 1.0)));
  }
  vec3 r = reflect(rd, nb);
  r = normalize(mix(r, nb, s.rough * s.rough));
  float hor = clamp(1.0 + dot(r, ng), 0.0, 1.0);
  // (fetched here, after the shadow loops, so the probe isn't held across them)
  Probe gi = surfProbe(s.p, ng);
  vec3 irr = giIrradiance(gi, n);
  // L1 probes are far too blurry for a polished surface: smooth lobes see the
  // clear sky itself as far as the probes say it is open toward r, and the
  // probes' light (bounce, nearby matter) for the rest.
  float blur = smoothstep(ENV_SHARP_ROUGH, ENV_BLUR_ROUGH, s.rough);
  vec3 envSharp = mix(giRadiance(gi, r, 0.0), skyColor(r), giSkyVis(gi, r));
  vec3 envL = mix(envSharp, giRadiance(gi, r, blur), blur);
  // indirect diffuse: the probes' light times AO, or the traced near field
  vec3 ind = irr * aoT;
  if (uNearGI) { float vis; ind = nearField(s.p, ng, n, irr, vis) * s.cav; aoT = vis * s.cav; }
  if (glowWorthIt(local, irr)) local *= glowLightScale(s.p, ng, n);
  // specular occlusion (Lagarde & de Rousiers 2014)
  float specAO = clamp(pow(nv + aoT, exp2(-16.0 * s.rough - 1.0)) - 1.0 + aoT, 0.0, 1.0);
  c += (envL * FssEss * hor * hor + irr * Fms * Ems) * specAO;
  // indirect (sky + bounce) and glow volume: diffuse
  c += kD * (ind + local * (LOCAL_AO_MIN + LOCAL_AO_GAIN * aoT));
  return c + s.emit;
}

const vec3 FLOOR_LINE_ALB = vec3(0.075, 0.078, 0.085);   // the grid's seams, darker than the floor
const float FLOOR_LINE_CELLS = 8.0;   // cells between the floor's grid lines
vec3 shadeFloor(vec3 hp, vec3 rd) {
  vec2 q = hp.xz / FLOOR_LINE_CELLS;
  vec2 gq = abs(fract(q - 0.5) - 0.5) / max(fwidth(q) * uPixScale, vec2(1e-4));
  float line = 1.0 - min(min(gq.x, gq.y), 1.0);
  vec3 alb = mix(GROUND_ALB, FLOOR_LINE_ALB, line);
  vec3 n = vec3(0.0, 1.0, 0.0);
  float ndl = max(uSun.y, 0.0);
  vec3 sh = uShadows ? sunShadow(hp, n) : vec3(1.0);
  float ao = min(faceAO(ivec3(floor(hp.x), -1, floor(hp.z)), ivec3(0, 1, 0), hp), fieldAO(vec3(hp.x, 0.0, hp.z), n));
  vec3 local = sampleLight(vec3(hp.x, 0.5, hp.z)) * uLightGain;
  vec3 irr = giIrradiance(surfProbe(vec3(hp.x, 0.0, hp.z), n), n);
  vec3 ind = irr * ao;
  vec3 pf = vec3(hp.x, 0.0, hp.z);
  if (uNearGI) ind = nearField(pf, n, n, irr, ao);
  if (glowWorthIt(local, irr)) local *= glowLightScale(pf, n, n);
  return alb * (SUN_COL * ndl * sh + ind + local * (LOCAL_AO_MIN + LOCAL_AO_GAIN * ao));
}
`;

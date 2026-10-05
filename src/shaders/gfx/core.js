import { brickGLSL, BRICK_DIST_SCALE } from '../passes.js';

// Shared render core: state/brick/field access, the DDA helpers and the
// smooth-surface machinery (sampling, root finding, normals).
export const coreGLSL = (g) => /* glsl */ `
${brickGLSL}
uniform sampler2D tA;
uniform sampler2D tB;    // velocity xyz (cells/step), air pressure
uniform sampler2D tBrick;
uniform sampler2D tBrickDist;   // empty-space distance per brick (shaders/passes.js)
#define BRICK_DIST_SCALE ${BRICK_DIST_SCALE.toFixed(1)}
uniform sampler2D tLight;
uniform sampler2D tFS;   // smooth-surface fields (liquid, molten, granular, organic); SURF_ISO = surface
uniform sampler2D tFM;   // media fields (smoke, steam, fire, heat)
uniform sampler2D tFT;   // thin-feature mask (x: liquid), see shaders/fields.js
uniform int uView;
uniform bool uShadows;
uniform float uTime;
uniform float uLightGain;
uniform int uFrame;

const ivec3 GRID = ivec3(NX, NY, NZ);
#define MAX_STEPS ${g.maxSteps}

vec4 cellA(ivec3 c) { return texelFetch(tA, atlas(c), 0); }
vec4 cellB(ivec3 c) { return texelFetch(tB, atlas(c), 0); }
bool outside(ivec3 c) { return any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, GRID)); }

// Crisp elements are drawn as voxels; everything else is a field.
bool isCrisp(int id) { return id != E_EMPTY && SURFCH[id] < 0 && MEDIACH[id] < 0; }

// ---- bricks (see brickFrag and BRICK_BITS in passes.js) ----
// a = 0: empty. a < 0: air only, flagged for the data views.
// a >= 1: 1 + gas fraction + 2·bits (+ air flags / BRICK_FLAG_DIV); the gas
// fraction is at most 1, so halving leaves the bits in the integer part.
float brickOcc(ivec3 bc) { return texelFetch(tBrick, brickAtlas(bc), 0).a; }
int brickBits(float occ) { return int((occ - 1.0) * 0.5); }
float brickGas(float occ) { return occ > 0.5 ? clamp(occ - 1.0 - 2.0 * float(brickBits(occ)), 0.0, 1.0) : 0.0; }
// realistic view: 0 = skip the brick, else 1 + bits
int brickInfo(ivec3 bc) { float a = brickOcc(bc); return a < 0.5 ? 0 : 1 + brickBits(a); }
bool brickHas(int f, int bit) { return f > 0 && ((f - 1) & bit) != 0; }
bool brickMedia(int f) { return brickHas(f, BRICK_MEDIA); }
bool brickSurf(int f) { return brickHas(f, BRICK_SURF); }
bool brickOpaque(int f) { return brickHas(f, BRICK_OPAQUE); }   // crisp or opaque smooth matter
bool brickThin(int f) { return brickHas(f, BRICK_THIN); }       // thin liquid: read cubic
bool brickMixed(int f) { return brickHas(f, BRICK_MIXED); }     // more than one liquid

// A ray entering the box starts its DDA in the cell this far (cells) past the
// entry point, so the cell it starts in is the one inside.
#define DDA_START_NUDGE 1e-4

vec3 safeDir(vec3 rd) {
  return vec3(abs(rd.x) < 1e-6 ? 1e-6 : rd.x, abs(rd.y) < 1e-6 ? 1e-6 : rd.y, abs(rd.z) < 1e-6 ? 1e-6 : rd.z);
}
// returns (tNear, tFar, entryAxis)
vec3 boxHit(vec3 ro, vec3 rd) {
  vec3 t0 = (vec3(0.0) - ro) / rd, t1 = (vec3(GRID) - ro) / rd;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float n = max(max(tn.x, tn.y), tn.z);
  float axis = tn.x >= tn.y && tn.x >= tn.z ? 0.0 : (tn.y >= tn.z ? 1.0 : 2.0);
  return vec3(n, min(min(tf.x, tf.y), tf.z), axis);
}
int argmin3(vec3 v) { return v.x <= v.y && v.x <= v.z ? 0 : (v.y <= v.z ? 1 : 2); }

// Jump the DDA to the exit of empty brick bc. Updates cell/tMax/tEnter, returns axis crossed.
int skipBrick(ivec3 bc, vec3 ro, vec3 rd, ivec3 istp, inout ivec3 cell, inout vec3 tMax, inout float tEnter) {
  vec3 bmin = vec3(bc * BS), bmax = bmin + float(BS);
  vec3 tb = (mix(bmin, bmax, step(0.0, rd)) - ro) / rd;
  int ax = argmin3(tb);
  float tx = tb[ax];
  cell = ivec3(floor(ro + rd * tx));
  cell[ax] = istp[ax] > 0 ? int(bmax[ax]) : int(bmin[ax]) - 1;
  tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  tEnter = tx;
  return ax;
}

// Jump the DDA out of the empty region around empty brick bc: every brick
// within (distance - 1) of it is empty (shaders/passes.js brickDistFrag), so
// the ray crosses that whole cube in one step. Same contract as skipBrick.
// Only for walks that treat "brick alpha < 0.5" as empty (not the data views,
// which also visit flagged air).
int skipEmpty(ivec3 bc, vec3 ro, vec3 rd, ivec3 istp, inout ivec3 cell, inout vec3 tMax, inout float tEnter) {
  int r = max(int(texelFetch(tBrickDist, brickAtlas(bc), 0).x * BRICK_DIST_SCALE + 0.5) - 1, 0);
  vec3 bmin = vec3((bc - r) * BS), bmax = vec3((bc + r + 1) * BS);
  vec3 tb = (mix(bmin, bmax, step(0.0, rd)) - ro) / rd;
  int ax = argmin3(tb);
  float tx = tb[ax];
  cell = ivec3(floor(ro + rd * tx));
  cell[ax] = istp[ax] > 0 ? int(bmax[ax]) : int(bmin[ax]) - 1;
  tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  tEnter = tx;
  return ax;
}

// ---- continuous fields ----
// A smooth surface is where its field crosses this level (shaders/fields.js
// builds them so: inside > SURF_ISO > outside).
#define SURF_ISO 0.5
// The fields live in the same Y-slice atlas as the state. Hardware bilinear
// filtering works inside a slice (clamped to the tile), and one lerp between
// two slices completes the trilinear sample: 2 taps.
vec4 fieldTex(sampler2D t, vec3 p) {
  vec3 q = clamp(p, vec3(0.5), vec3(GRID) - 0.5);
  float fy = q.y - 0.5;
  int y0 = int(fy);
  int y1 = min(y0 + 1, NY - 1);
  vec2 inv = 1.0 / vec2(textureSize(t, 0));
  vec2 o0 = vec2(float((y0 % TX) * NX), float((y0 / TX) * NZ));
  vec2 o1 = vec2(float((y1 % TX) * NX), float((y1 / TX) * NZ));
  return mix(texture(t, (o0 + q.xz) * inv), texture(t, (o1 + q.xz) * inv), fy - float(y0));
}
vec4 surfField(vec3 p) { return fieldTex(tFS, p); }
vec4 mediaField(vec3 p) { return fieldTex(tFM, p); }

// Cubic B-spline sample of a field (cell values are its control points).
// Trilinear interpolation of a lone peak has octahedral isosurfaces, so drops
// drawn from it are faceted gems; the B-spline's kernel is smooth (C²) and
// nearly radial, so they come out round and their normals smooth. Sigg &
// Hadwiger's trick folds each pair of x and z taps into one bilinear fetch,
// 2×2 per slice; y has no hardware filtering, so 4 slices: 16 fetches.
// Taps are clamped to the slice's tile, i.e. the grid is extended by its edge.
vec4 fieldCubic(sampler2D t, vec3 p) {
  vec3 c = clamp(p, vec3(0.5), vec3(GRID) - 0.5) - 0.5;   // cell centres at integers
  vec3 i = floor(c), f = c - i;
  vec3 f2 = f * f, f3 = f2 * f;
  // weights of the control points at i-1, i, i+1, i+2
  vec3 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec3 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec3 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec3 w3 = f3 / 6.0;
  // x and z: two bilinear taps each, between i-1|i and i+1|i+2 (texel units)
  vec2 g0 = w0.xz + w1.xz, g1 = w2.xz + w3.xz;
  vec2 lo = vec2(0.5), hi = vec2(NX, NZ) - 0.5;
  vec2 a = clamp(i.xz - 0.5 + w1.xz / g0, lo, hi);
  vec2 b = clamp(i.xz + 1.5 + w3.xz / g1, lo, hi);
  vec2 inv = 1.0 / vec2(textureSize(t, 0));
  vec4 wy = vec4(w0.y, w1.y, w2.y, w3.y);
  vec4 s = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    int y = clamp(int(i.y) - 1 + k, 0, NY - 1);
    vec2 o = vec2(float((y % TX) * NX), float((y / TX) * NZ));
    s += wy[k] * (g0.y * (g0.x * texture(t, (o + vec2(a.x, a.y)) * inv) + g1.x * texture(t, (o + vec2(b.x, a.y)) * inv))
                + g1.y * (g0.x * texture(t, (o + vec2(a.x, b.y)) * inv) + g1.x * texture(t, (o + vec2(b.x, b.y)) * inv)));
  }
  return s;
}

// The liquid channel (gfx/materials.js CHANNELS cubic) reads cubic only for
// thin features, blended in by the thin mask; bulk surfaces (pools, seas)
// read the same either way and stay trilinear. In the tracer's march it also
// only reads cubic near the surface: where the trilinear value is outside
// this band, both readings fall on the same side of it (checked for drops,
// streams, films, slabs, edges, corners and bubbles; the closest call is
// ~0.54..0.70), so the cheap one decides.
#define LIQ_CUBIC_LO 0.3
#define LIQ_CUBIC_HI 0.85
// Whether the brick being traced holds thin liquid (brickThin): set by the
// marches on entering each brick, so bulk liquid never reads the mask.
bool gThin = true;
float liquidCubic(vec3 p, float tri) {
  if (!gThin) return tri;
  float t = fieldTex(tFT, p).x;
  return t > 0.0 ? mix(tri, fieldCubic(tFS, p).x, t) : tri;
}
// The surface fields as the tracer sees them.
vec4 surfSample(vec3 p) {
  vec4 s = surfField(p);
  if (s.x > LIQ_CUBIC_LO && s.x < LIQ_CUBIC_HI) s.x = liquidCubic(p, s.x);
  return s;
}
// One channel, at the surface (root finding, normals).
float surfChannel(vec3 p, int ch) {
  float v = surfField(p)[ch];
  return ch == CH_LIQUID ? liquidCubic(p, v) : v;
}

// Root of φ_ch(t) = SURF_ISO bracketed by [ta, tb] (fa, fb = φ - SURF_ISO at
// the ends, opposite signs). Clamped regula falsi: the field is smooth, so a
// few steps do. Each step's split is kept this far (share of the bracket)
// from either end, so a lopsided bracket still shrinks from both sides.
#define SURF_ROOT_STEPS 5
#define SURF_ROOT_SPLIT_LO 0.15
#define SURF_ROOT_SPLIT_HI 0.85
float surfRoot(vec3 ro, vec3 rd, int ch, float ta, float tb, float fa, float fb) {
  for (int k = 0; k < SURF_ROOT_STEPS; k++) {
    float tm = mix(ta, tb, clamp(fa / (fa - fb), SURF_ROOT_SPLIT_LO, SURF_ROOT_SPLIT_HI));
    float fm = surfChannel(ro + rd * tm, ch) - SURF_ISO;
    if ((fm < 0.0) == (fa < 0.0)) { ta = tm; fa = fm; } else { tb = tm; fb = fm; }
  }
  return mix(ta, tb, clamp(fa / (fa - fb), 0.0, 1.0));
}

#define NO_HIT 1e9

// Where along [ta, tb] the ray first crosses channel ch's surface, going into
// the material (into = true) or out of it; NO_HIT if it doesn't. The field is
// sampled at both ends and at tm, where the ray passes closest to a cell
// centre: a lone droplet or grain can sit entirely between the ends. With no
// middle sample, pass tm = tb and phiM = phiB.
float surfCross(vec3 ro, vec3 rd, int ch, bool into, float ta, float tm, float tb,
                float phiA, float phiM, float phiB) {
  float a = phiA - SURF_ISO, m = phiM - SURF_ISO, b = phiB - SURF_ISO;
  if (into ? (a < 0.0 && m >= 0.0) : (a >= 0.0 && m < 0.0)) return surfRoot(ro, rd, ch, ta, tm, a, m);
  if (tm < tb && (into ? (m < 0.0 && b >= 0.0) : (m >= 0.0 && b < 0.0))) return surfRoot(ro, rd, ch, tm, tb, m, b);
  return NO_HIT;
}

// Where in [ta, tb] the ray passes closest to the centre of cell c.
float tClosest(ivec3 c, vec3 ro, vec3 rd, float ta, float tb) {
  return clamp(dot(vec3(c) + 0.5 - ro, rd), ta, tb);
}

// Outward surface normal (−∇φ) from a tetrahedral central difference. The
// step is wide on purpose: trilinear fields have creased gradients at the
// cell-centre lattice, and a wide stencil irons them out. Where the liquid
// reads cubic (thin features) it is smooth, and the step only has to be
// small next to a drop's radius.
#define NORMAL_STEP 0.55
#define NORMAL_STEP_CUBIC 0.25
vec3 surfNormal(vec3 p, int ch, vec3 fallback) {
  const vec2 k = vec2(1.0, -1.0);
  float h = ch == CH_LIQUID && gThin ? mix(NORMAL_STEP, NORMAL_STEP_CUBIC, fieldTex(tFT, p).x) : NORMAL_STEP;
  vec3 gr = k.xyy * surfChannel(p + k.xyy * h, ch) + k.yyx * surfChannel(p + k.yyx * h, ch)
          + k.yxy * surfChannel(p + k.yxy * h, ch) + k.xxx * surfChannel(p + k.xxx * h, ch);
  float l = length(gr);
  return l > 1e-5 ? -gr / l : fallback;
}
`;

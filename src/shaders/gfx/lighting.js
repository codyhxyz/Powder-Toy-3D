import { skyGLSL } from '../../gfx/sky.js';
import { cloudDeckGLSL } from './clouds.js';
import { LAMP_MAX, LAMP_UNIT } from '../../gfx/lamps.js';

// Soft-shadow taps per pass (blocker search, then filter).
const PCSS_TAPS = 8;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// Points of an n-point Vogel (sunflower) disc of radius 1, as GLSL vec2s.
const vogel = (n) => Array.from({ length: n }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / n), a = i * GOLDEN_ANGLE;
  return `vec2(${(r * Math.cos(a)).toFixed(5)}, ${(r * Math.sin(a)).toFixed(5)})`;
}).join(', ');

// Lighting: sun + shadow map, sky, the GI probe volume, the glow (emission)
// volume and ambient occlusion. Shading code only talks to the scene's light
// through these.
export const lightingGLSL = /* glsl */ `
uniform vec3 uSun;
const float PI_L = 3.14159265;
// Lighting upgrades, each switchable at run time (Settings → Lighting):
uniform bool uNearGI;      // traced voxel AO and nearby bounce light
uniform bool uGlowLights;  // lava and fire as shadowed lights
uniform bool uCaustics;    // sun caustics through liquid
// Hand lamps (src/pov/lamps.js): point lights the first-person body carries or
// throws, the torch and the lantern. uLampCount 0 (none lit) costs nothing.
#define LAMP_MAX ${LAMP_MAX}
uniform int uLampCount;
uniform vec4 uLampPos[LAMP_MAX];   // xyz grid cells, w its reach (cells)
uniform vec4 uLampCol[LAMP_MAX];   // rgb: linear colour × intensity, in SUN_COL's units at LAMP_UNIT cells

// ---- sun and sky: a clear-sky atmosphere (gfx/sky.js) ----
// Values that only depend on the sun are computed once per frame in JS.
${skyGLSL()}
uniform vec3 uSunExt;   // transmittance of the air along the sun's path
uniform vec3 uSunCol;   // direct sunlight at the ground: warmer and dimmer as the sun gets lower
uniform vec3 uSkyUp;    // open-sky irradiance on an upward surface
uniform vec3 uGround;   // radiance of the sunlit, sky-lit ground around the box
uniform vec3 uKeyLight; // sunlight's colour scale: 1 by day, dim blue under the moon (gfx/daylight.js)
#define SUN_COL uSunCol
// World's cumulus deck (clouds.js): sunShadow multiplies its shadow in.
${cloudDeckGLSL}
const float HORIZON_BLEND = 0.02;  // sky -> ground blend half-width at the horizon (direction y)

float airMass(float cz) {
  cz = max(cz, 0.0);
  return 1.0 / (cz + AIRMASS_HORIZON * exp(-AIRMASS_FALLOFF * cz));
}

// Clear-sky radiance toward d (d.y >= 0; lower directions see the horizon), without the sun's disc.
vec3 skyRadiance(vec3 d) {
  float mu = dot(d, uSun);
  float mv = airMass(d.y), ms = airMass(uSun.y);
  float pR = 3.0 / (16.0 * PI_L) * (1.0 + mu * mu);
  float g2 = AEROSOL_G * AEROSOL_G;
  float pM = (1.0 - g2) / (4.0 * PI_L * pow(1.0 + g2 - 2.0 * AEROSOL_G * mu, 1.5));
  // the integral over height of e^(-tau ms x) e^(-tau mv (1 - x)) (x = relative air density)
  float dm = mv - ms;
  vec3 ev = exp(-TAU_AIR * mv);
  vec3 path = abs(dm) < AIRMASS_EQ_EPS ? TAU_AIR * mv * ev : mv * (uSunExt - ev) / dm;
  return uKeyLight * SKY_MULTI * PI_L * SUN_TOA * (TAU_RAYLEIGH * pR + TAU_AEROSOL * pM) / TAU_AIR * path;
}

// Radiance of the environment toward d: sky above the horizon, ground below.
vec3 skyColor(vec3 d) {
  return mix(uGround, skyRadiance(d), smoothstep(-HORIZON_BLEND, HORIZON_BLEND, d.y));
}
// Rough open-environment irradiance / pi on a surface facing n (no occlusion):
// the sky over the share of n's hemisphere it covers, the ground below. The GI
// probes integrate the real thing; this is for code without them.
vec3 skyAmbient(vec3 n) {
  float up = 0.5 + 0.5 * n.y;
  return up * uSkyUp + (1.0 - up) * uGround;
}

// ---- sun shadow map ----
// An orthographic shadow map covering the box, traced once per frame from the
// sun. Each texel stores (depth of first opaque surface, depth where
// translucent material starts, depth where it ends, tint element id *
// SHADOW_TINT_ID_SCALE + optical depth accumulated through it). Points in
// between get a proportional share.
uniform sampler2D tShadow;
uniform int uShadowRes;
// w packing: id * this + optical depth (< this); written by render.js's shadow
// pass. The map is 32-bit float, so with element ids up to 255 (docs/elements.md)
// w stays below 2^16 and keeps the optical depth to 2^-8 (0.4% in the light
// let through). Depth past SCALE - 1 lets no light through anyway (e^-255); it
// only flattens the proportional share inside a medium that thick (~270 cells
// of oil along the sun, 10,000 of water).
const float SHADOW_TINT_ID_SCALE = 256.0;
const float SHADOW_PAD = 1.0;              // voxels the map's disc reaches past the box's bounding sphere
const float SHADOW_NORMAL_OFFSET = 0.002;  // voxels a surface lookup moves off the surface along its normal
// Hard-map depth bias (voxels), see sunShadow: at least SHADOW_BIAS_MIN, else the
// PCF slope term (n.sun floored at SHADOW_BIAS_NS_MIN) plus SHADOW_BIAS_PAD.
const float SHADOW_BIAS_MIN = 0.8;
const float SHADOW_BIAS_NS_MIN = 0.25;
const float SHADOW_BIAS_PAD = 0.1;
const float VOLUME_SHADOW_BIAS = 0.6;      // depth bias (voxels) for points inside volumes (no normal)
// Exact sun rays: smooth opaque surfaces block them where their field is
// inside (by SUN_RAY_ISO_MARGIN: trilinear creases wobble about the level),
// except within SUN_RAY_SMOOTH_SKIP voxels of the start, which sits on one;
// the ray stops this far past the nearest occluder depth the shadow-map taps saw.
const float SUN_RAY_SMOOTH_SKIP = 0.5;
const float SUN_RAY_ISO_MARGIN = 0.02;
const float SUN_RAY_REACH_PAD = 1.5;
const float SUN_RAY_NUDGE = 1e-4;          // voxels past the box entry at which the start cell is looked up

// Soft shadows (PCSS): the sun is a disc, so a shadow's edge blurs with the
// distance from its caster. tan of the sun's apparent radius: the real sun is
// 0.27 deg; 1.2 deg stands in for a slightly hazy sky, so penumbrae read at
// the scale of the box while contact shadows stay crisp.
const float SUN_TAN_RADIUS = 0.021;
#define PCSS_TAPS ${PCSS_TAPS}                 // taps for the blocker search, and again for the filter
const float PCSS_HARD_TEXELS = 1.0;  // penumbra radius (texels) below which the hard path settles the edge
const float PCSS_NS_MIN = 0.2;       // n.sun floor for the receiver-plane slope (grazing receivers)
const float PCSS_BIAS = 0.35;        // depth bias (voxels) on top of the receiver plane
const float GOLDEN_ANGLE = ${GOLDEN_ANGLE.toFixed(8)};

// ---- caustics: sunlight focused by the ripples on open liquid ----
// The ripple height field (gfx/liquid.js tilts liquid normals with it): a
// slowly drifting two-octave value noise, in noise space q = xz * RIPPLE_FREQ.
#define RIPPLE_FREQ 0.3        // cycles per cell, first octave
#define RIPPLE_DRIFT 0.6       // noise-space speed, per second
#define RIPPLE_OCT2 2.1        // second octave: frequency multiple ...
#define RIPPLE_OCT2_AMP 0.5    // ... height multiple ...
#define RIPPLE_OCT2_DRIFT 1.3  // ... drift multiple ...
#define RIPPLE_OCT2_SHIFT 7.3  // ... and offset, so it doesn't line up with the first
float rippleH(vec2 q, float t) {
  return vnoise(vec3(q, t)) + RIPPLE_OCT2_AMP * vnoise(vec3(q * RIPPLE_OCT2 + RIPPLE_OCT2_SHIFT, t * RIPPLE_OCT2_DRIFT));
}
// Refraction bends a beam entering at a surface slope g by about
// CAUSTIC_BEND * g (1 - 1/n for water), so at depth D it lands displaced by
// D * CAUSTIC_BEND * grad h. The light of a patch of surface then covers
// det(I + D * CAUSTIC_BEND * Hessian(h)) ~ 1 + D * CAUSTIC_BEND * lap(h) of
// the bed: crests focus it, troughs spread it. The sun's disc blurs the
// pattern with depth (the penumbra of a beam is D * SUN_TAN_RADIUS), which
// fades its contrast like a Gaussian of the ripples' wavelength.
// The rendered ripples are kept gentle (RIPPLE_SLOPE) so the mirror stays
// readable; light sees the slopes of real wind ripples, a few degrees steeper.
#define CAUSTIC_BEND 0.25       // 1 - 1/1.33
#define CAUSTIC_SLOPE 0.18      // ripple slope per unit noise gradient, for the light
#define CAUSTIC_EPS 0.35        // finite-difference step of the Laplacian, noise space (wide enough to
                                // smooth over the value noise's lattice, whose curvature jumps there)
#define CAUSTIC_BED_GAP 2.0     // cells: the liquid must reach this close to a point (along the sun) to
                                // focus light on it; a drop or puddle higher up just tints its shadow
#define CAUSTIC_FILL 0.7        // share of the path below the liquid's top that must be liquid: a pool
                                // (water soaked into sand or gravel has no open surface to focus with)
#define CAUSTIC_MAX 4.0         // brightest focus (beams cross past it)
#define CAUSTIC_MIN 0.3         // darkest spread
// Whether a shadow-map texel sm, seen from depth d, has the receiver under a body of liquid tid.
bool underPool(vec4 sm, float d, int tid) {
  if (RCLASS[tid] != R_LIQUID || d <= sm.y || d >= sm.z + CAUSTIC_BED_GAP) return false;
  float lenL = (sm.w - float(tid) * SHADOW_TINT_ID_SCALE) / max(dot(SIGMA[tid], vec3(1.0 / 3.0)), 1e-4);
  return lenL >= CAUSTIC_FILL * (min(d, sm.z) - sm.y);
}
float causticGain(vec3 p, float D) {
  vec3 s = p + uSun * D;   // where the light entered the liquid
  vec2 q = worldPos(s).xz * RIPPLE_FREQ;   // the ripples are anchored in the world (gfx/liquid.js)
  float t = uTime * RIPPLE_DRIFT;
  float h0 = rippleH(q, t);
  float lapQ = (rippleH(q + vec2(CAUSTIC_EPS, 0.0), t) + rippleH(q - vec2(CAUSTIC_EPS, 0.0), t)
              + rippleH(q + vec2(0.0, CAUSTIC_EPS), t) + rippleH(q - vec2(0.0, CAUSTIC_EPS), t) - 4.0 * h0)
              / (CAUSTIC_EPS * CAUSTIC_EPS);
  float lap = CAUSTIC_SLOPE * RIPPLE_FREQ * lapQ;   // per cell
  float I = clamp(1.0 / max(1.0 + D * CAUSTIC_BEND * lap, 1e-3), CAUSTIC_MIN, CAUSTIC_MAX);
  float blur = D * SUN_TAN_RADIUS * RIPPLE_FREQ * 2.0 * PI_L;
  return mix(1.0, I, exp(-0.5 * blur * blur));
}

void sunBasis(out vec3 c, out float R, out vec3 u, out vec3 v) {
  c = vec3(GRID) * 0.5;
  R = 0.5 * length(vec3(GRID)) + SHADOW_PAD;
  u = normalize(cross(vec3(0.0, 1.0, 0.0), uSun));
  v = cross(uSun, u);
  // The map's texel lattice stays put in the world as the window moves
  // (docs/scaling.md D11): the centre takes the window's offset rounded to
  // whole texels across the sun (along it, depths only shift). Within half a
  // texel, which SHADOW_PAD covers. In a box uOrigin is 0 and so is the snap.
  vec3 o = vec3(uOrigin);
  float T = 2.0 * R / float(max(uShadowRes, 1));   // texel size (a pass without a map: anything finite)
  vec2 ot = vec2(dot(o, u), dot(o, v)) / T;
  vec2 snap = (round(ot) - ot) * T;
  c += snap.x * u + snap.y * v;
}

// 1 if the ray from ro toward the sun gets tLim voxels without entering
// opaque matter, else 0 (exact DDA, same traversal as the view rays). Crisp
// voxels block as cubes. Smooth surfaces block as drawn, by their field (as
// the shadow map pass sees them), not as their cells: the cells' staircase
// stands proud of a smooth slope, and on lit sand it cut jagged shadows.
float smoothOpaque(vec3 p) { vec4 s = surfField(p); return max(s.y, max(s.z, s.w)); }
float sunRayClear(vec3 ro, float tLim) {
  vec3 rd = safeDir(uSun);
  vec3 bh = boxHit(ro, rd);
  float t = max(bh.x, 0.0);
  if (bh.y <= t) return 1.0;
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t + SUN_RAY_NUDGE))), ivec3(0), GRID - 1);
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = t;
  float tSkip = t + SUN_RAY_SMOOTH_SKIP;
  ivec3 lastB = ivec3(-1);
  float occ = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (outside(cell) || tEnter > tLim) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; occ = brickOcc(bc); }
    if (occ < 0.5) { skipEmpty(bc, ro, rd, istp, cell, tMax, tEnter); continue; }
    int id = eid(fetchA(cell));
    int ax = argmin3(tMax);
    float tExit = min(tMax[ax], tLim);
    if (isCrisp(id)) {
      if (RCLASS[id] == R_OPAQUE) return 0.0;
    } else {
      // where the ray passes closest to the cell centre (a lone grain can
      // sit between the ends) and where it leaves the cell
      float tM = tClosest(cell, ro, rd, tEnter, tExit);
      if (tM > tSkip && smoothOpaque(ro + rd * tM) > SURF_ISO + SUN_RAY_ISO_MARGIN) return 0.0;
      if (tExit > tSkip && smoothOpaque(ro + rd * tExit) > SURF_ISO + SUN_RAY_ISO_MARGIN) return 0.0;
    }
    tEnter = tMax[ax];
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return 1.0;
}

// The taps: a Vogel (sunflower) disc of radius 1, rotated per pixel and frame.
const vec2 VOGEL[PCSS_TAPS] = vec2[PCSS_TAPS](${vogel(PCSS_TAPS)});

// Sun visibility at a surface point hp with normal n, from the map (sunShadow
// below adds the clouds).
vec3 sunMapShadow(vec3 hp, vec3 n) {
  vec3 c, u, v; float R;
  sunBasis(c, R, u, v);
  vec3 p = hp + n * SHADOW_NORMAL_OFFSET;
  vec3 q = p - c;
  vec2 st = vec2(dot(q, u), dot(q, v)) / R * 0.5 + 0.5;
  float d = R - dot(q, uSun);
  // Depth bias. A PCF tap one texel (T voxels) away sees the receiver's own face
  // up to T*(|n.u|+|n.v|)/(n.s) closer, and at the foot of a sun-facing wall it
  // sees that wall up to ~0.6 closer: hence >= 0.8. It must stay well below
  // 1/uSun.y (1.23), the depth gap to the top of a 1-voxel step.
  float T = 2.0 * R / float(uShadowRes);
  float bias = max(SHADOW_BIAS_MIN, T * (abs(dot(n, u)) + abs(dot(n, v))) / max(dot(n, uSun), SHADOW_BIAS_NS_MIN) + SHADOW_BIAS_PAD);
  vec2 f = st * float(uShadowRes) - 0.5;
  ivec2 i0 = ivec2(floor(f));
  vec2 w = f - vec2(i0);
  vec3 acc = vec3(0.0), tr = vec3(0.0);
  float nLit = 0.0, dMin = 1e9;
  float cD = 0.0, cW = 0.0;   // depth under liquid (along the sun), weight of the taps that see it
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    vec4 sm = texelFetch(tShadow, clamp(i0 + o, ivec2(0), ivec2(uShadowRes - 1)), 0);
    float lit = d < sm.x + bias ? 1.0 : 0.0;
    vec3 att = vec3(1.0);
    int tid = int(sm.w / SHADOW_TINT_ID_SCALE);
    if (tid > 0 && d > sm.y) {
      float tau = sm.w - float(tid) * SHADOW_TINT_ID_SCALE;
      float frac = clamp((d - sm.y) / max(sm.z - sm.y, 1e-3), 0.0, 1.0);
      vec3 tint = SIGMA[tid] / max(dot(SIGMA[tid], vec3(1.0 / 3.0)), 1e-4);
      att = exp(-tint * tau * frac);
    }
    float wk = (o.x == 1 ? w.x : 1.0 - w.x) * (o.y == 1 ? w.y : 1.0 - w.y);
    if (tid > 0 && underPool(sm, d, tid)) { cD += (d - sm.y) * wk; cW += wk; }
    acc += lit * att * wk;
    tr += att * wk;
    nLit += lit;
    dMin = min(dMin, sm.x);
  }
  if (uCaustics && cW > 0.0) {
    float cg = mix(1.0, causticGain(p, cD / cW), cW);
    acc *= cg;
    tr *= cg;
  }

  // Clearly lit by the hard map: done. Penumbrae are only grown inward, into
  // the hard shadow (below), so lit pixels (most of them) skip the search.
  if (nLit == 4.0) return acc;

  // PCSS. Taps are compared against the receiver's plane (its depth moves by
  // slope per voxel along u, v), so wide kernels don't shadow sloped receivers.
  float ns = max(dot(n, uSun), PCSS_NS_MIN);
  vec2 slope = vec2(dot(n, u), dot(n, v)) / ns;
  vec2 ft = st * float(uShadowRes);
  ivec2 hi = ivec2(uShadowRes - 1);
  float rot = 2.0 * PI_L * ign(gl_FragCoord.xy, float(uFrame));
  mat2 R2 = mat2(cos(rot), sin(rot), -sin(rot), cos(rot));
  // blocker search over the widest penumbra anything in front of p could cast
  float rs = SUN_TAN_RADIUS * d;
  float bSum = 0.0, bN = 0.0;
  for (int i = 0; i < PCSS_TAPS; i++) {
    vec2 o = R2 * VOGEL[i] * rs;
    float sm = texelFetch(tShadow, clamp(ivec2(floor(ft + o / T)), ivec2(0), hi), 0).x;
    if (sm + PCSS_BIAS < d + dot(o, slope)) { bSum += sm; bN += 1.0; }
  }
  float pen = bN > 0.0 ? SUN_TAN_RADIUS * (d - bSum / bN) : 0.0;
  if (pen < PCSS_HARD_TEXELS * T) {
    // Hard edge (contact, or no caster near). Where the taps disagree p is
    // within a texel (~0.44 voxels at 128^3) of a shadow edge, where the map
    // can only blur: settle it with an exact ray, traced only as far as the
    // occluders those taps saw.
    if (nLit > 0.0) return tr * sunRayClear(p, d - dMin + SUN_RAY_REACH_PAD);
    return acc;
  }
  // The filtered visibility is 1/2 on the hard edge and falls to 0 a penumbra
  // inside it: doubled, it meets the lit side continuously.
  float lit = 0.0;
  for (int i = 0; i < PCSS_TAPS; i++) {
    vec2 o = R2 * VOGEL[i] * pen;
    float sm = texelFetch(tShadow, clamp(ivec2(floor(ft + o / T)), ivec2(0), hi), 0).x;
    lit += sm + PCSS_BIAS >= d + dot(o, slope) ? 1.0 : 0.0;
  }
  return tr * min(2.0 * lit / float(PCSS_TAPS), 1.0);
}

// Bilinear weight of tap o (0/1 each way) at fraction w.
float wk0(ivec2 o, vec2 w) { return (o.x == 1 ? w.x : 1.0 - w.x) * (o.y == 1 ? w.y : 1.0 - w.y); }

// Sun visibility at a point inside a volume (media, liquid interiors), from the map.
vec3 sunMapShadow(vec3 p) {
  vec3 c, u, v; float R;
  sunBasis(c, R, u, v);
  vec3 q = p - c;
  vec2 st = vec2(dot(q, u), dot(q, v)) / R * 0.5 + 0.5;
  float d = R - dot(q, uSun);
  vec2 f = st * float(uShadowRes) - 0.5;
  ivec2 i0 = ivec2(floor(f));
  vec2 w = f - vec2(i0);
  vec3 acc = vec3(0.0);
  float cD = 0.0, cW = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    vec4 sm = texelFetch(tShadow, clamp(i0 + o, ivec2(0), ivec2(uShadowRes - 1)), 0);
    vec3 lit = d < sm.x + VOLUME_SHADOW_BIAS ? vec3(1.0) : vec3(0.0);
    int tid = int(sm.w / SHADOW_TINT_ID_SCALE);
    if (tid > 0 && d > sm.y) {
      float tau = sm.w - float(tid) * SHADOW_TINT_ID_SCALE;
      float frac = clamp((d - sm.y) / max(sm.z - sm.y, 1e-3), 0.0, 1.0);
      vec3 tint = SIGMA[tid] / max(dot(SIGMA[tid], vec3(1.0 / 3.0)), 1e-4);
      lit *= exp(-tint * tau * frac);
      if (underPool(sm, d, tid)) { cD += (d - sm.y) * wk0(o, w); cW += wk0(o, w); }
    }
    acc += lit * wk0(o, w);
  }
  if (uCaustics && cW > 0.0) acc *= mix(1.0, causticGain(p, cD / cW), cW);
  return acc;
}

// Sunlight at grid point p: the map, under the clouds' shadow (a fully
// clouded point skips the map).
vec3 sunShadow(vec3 hp, vec3 n) {
  float c = cloudShadow(worldPos(hp));
  return c > CLOUD_SHADOW_SKIP ? c * sunMapShadow(hp, n) : vec3(0.0);
}
vec3 sunShadow(vec3 p) {
  float c = cloudShadow(worldPos(p));
  return c > CLOUD_SHADOW_SKIP ? c * sunMapShadow(p) : vec3(0.0);
}

// ---- indirect light: the GI probe volume (shaders/gi.js) ----
// One probe per brick centre holds the light arriving there from every
// direction (sky, ground and one-or-more bounces off lit matter, occluded at
// brick scale) as L1 spherical harmonics: rgb = radiance, a = sky visibility.
uniform sampler2D tGI0;   // band 0
uniform sampler2D tGI1;   // band 1, x
uniform sampler2D tGI2;   // band 1, y
uniform sampler2D tGI3;   // band 1, z
const float SH_Y0 = 0.282095;      // Y00
const float SH_Y1 = 0.488603;      // Y1m = SH_Y1 * (x, y, z)
const float SH_COS1 = 2.0 / 3.0;   // band-1 clamped-cosine convolution / pi (band 0: 1)
// Surfaces read the probes this many cells out along their normal: past the
// brick their own matter shares, into the light in front of them. Detail
// closer than that comes from the near-field AO below.
const float GI_OFFSET = 3.0;
const float SKYVIS_MIN = 0.05;     // floor of the open-sky share used to normalise sky visibility

// Trilinear probe lookup at p (grid units): hardware bilinear inside a brick
// slice of the atlas, one lerp between slices.
vec4 probeTex(sampler2D t, vec3 p) {
  vec3 q = clamp(p / float(BS), vec3(0.5), vec3(BX, BY, BZ) - 0.5);
  float fy = q.y - 0.5;
  int y0 = int(fy);
  int y1 = min(y0 + 1, BY - 1);
  vec2 inv = 1.0 / vec2(textureSize(t, 0));
  vec2 o0 = vec2(float((y0 % BTX) * BX), float((y0 / BTX) * BZ));
  vec2 o1 = vec2(float((y1 % BTX) * BX), float((y1 / BTX) * BZ));
  return mix(texture(t, (o0 + q.xz) * inv), texture(t, (o1 + q.xz) * inv), fy - float(y0));
}

struct Probe { vec4 c0, cx, cy, cz; };
Probe probeAt(vec3 p) {
  return Probe(probeTex(tGI0, p), probeTex(tGI1, p), probeTex(tGI2, p), probeTex(tGI3, p));
}
// Probe for a surface at p with geometric normal n.
Probe surfProbe(vec3 p, vec3 n) { return probeAt(p + n * GI_OFFSET); }

// Indirect irradiance / pi on a surface facing n.
vec3 giIrradiance(Probe g, vec3 n) {
  return max(SH_Y0 * g.c0.rgb + SH_COS1 * SH_Y1 * (g.cx.rgb * n.x + g.cy.rgb * n.y + g.cz.rgb * n.z), 0.0);
}
// Indirect radiance arriving from direction d, as blurry as L1 allows; blur
// in [0, 1] widens it further, to the irradiance lobe (rough reflections).
vec3 giRadiance(Probe g, vec3 d, float blur) {
  float k1 = SH_Y1 * mix(1.0, SH_COS1, blur);
  return max(SH_Y0 * g.c0.rgb + k1 * (g.cx.rgb * d.x + g.cy.rgb * d.y + g.cz.rgb * d.z), 0.0);
}
// Share of the open sky a surface facing n sees (1 in the open, less under
// overhangs, in pits and between tall things).
float giSkyVis(Probe g, vec3 n) {
  float v = SH_Y0 * g.c0.a + SH_COS1 * SH_Y1 * (g.cx.a * n.x + g.cy.a * n.y + g.cz.a * n.z);
  return clamp(v / max(0.5 + 0.5 * n.y, SKYVIS_MIN), 0.0, 1.0);
}

// ---- glow volume: blurred emission of lava, fire, hot metal ----
vec3 sampleLight(vec3 gp) {
  vec3 bpos = gp / float(BS) - 0.5;
  ivec3 b0 = ivec3(floor(bpos));
  vec3 f = bpos - vec3(b0);
  ivec3 hi = ivec3(BX, BY, BZ) - 1;
  vec3 s = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    ivec3 o = ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    vec3 wv = mix(1.0 - f, f, vec3(o));
    s += texelFetch(tLight, brickAtlas(clamp(b0 + o, ivec3(0), hi)), 0).rgb * wv.x * wv.y * wv.z;
  }
  return s;
}

// ---- ambient occlusion (near field; the probes cover the larger scale) ----
bool occluder(ivec3 c) {
  if (c.y < 0) return true;
  if (outside(c)) return false;
  int id = eid(fetchA(c));
  return id != E_EMPTY && KIND[id] != K_GAS;
}

// Smooth per-corner AO on a crisp voxel face (Minecraft style).
const float FACE_AO_MIN = 0.25;   // light left in a fully enclosed corner
float faceAO(ivec3 cell, ivec3 n, vec3 hp) {
  ivec3 u = n.x != 0 ? ivec3(0, 1, 0) : ivec3(1, 0, 0);
  ivec3 w = n.z != 0 ? ivec3(0, 1, 0) : ivec3(0, 0, 1);
  ivec3 b = cell + n;
  float s1 = float(occluder(b + u)), s2 = float(occluder(b - u));
  float s3 = float(occluder(b + w)), s4 = float(occluder(b - w));
  float c1 = float(occluder(b + u + w)), c2 = float(occluder(b + u - w));
  float c3 = float(occluder(b - u + w)), c4 = float(occluder(b - u - w));
  float aPP = s1 * s3 > 0.0 ? 0.0 : 3.0 - (s1 + s3 + c1);
  float aPM = s1 * s4 > 0.0 ? 0.0 : 3.0 - (s1 + s4 + c2);
  float aMP = s2 * s3 > 0.0 ? 0.0 : 3.0 - (s2 + s3 + c3);
  float aMM = s2 * s4 > 0.0 ? 0.0 : 3.0 - (s2 + s4 + c4);
  float fu = fract(dot(hp, vec3(u))), fw = fract(dot(hp, vec3(w)));
  float ao = mix(mix(aMM, aPM, fu), mix(aMP, aPP, fu), fw) / 3.0;
  return FACE_AO_MIN + (1.0 - FACE_AO_MIN) * ao;
}

// How solid the world is at p, 0..1 (smooth surfaces from the fields, crisp
// voxels and the floor from the state).
const float AO_LIQUID_SOLIDITY = 0.6;   // how much liquid occludes, relative to solid matter
float solidity(vec3 p) {
  if (p.y < 0.0) return 1.0;
  vec4 s = surfField(p);
  float o = max(max(s.y, s.z), max(s.w, s.x * AO_LIQUID_SOLIDITY));
  ivec3 c = ivec3(floor(p));
  if (!outside(c) && isCrisp(eid(fetchA(c)))) o = 1.0;
  return clamp(o, 0.0, 1.0);
}

// AO for smooth surfaces: probe the solidity along the normal (a flat surface
// sees ~0 from FIELD_AO_D1 out, crevices and the foot of piles see more).
const float FIELD_AO_D1 = 1.5, FIELD_AO_D2 = 3.0, FIELD_AO_D3 = 5.0;    // probe distances (cells)
const float FIELD_AO_W1 = 0.45, FIELD_AO_W2 = 0.3, FIELD_AO_W3 = 0.2;   // their weights
const float FIELD_AO_MIN = 0.2;   // light left in the deepest crevice
float fieldAO(vec3 p, vec3 n) {
  float occ = FIELD_AO_W1 * solidity(p + n * FIELD_AO_D1) + FIELD_AO_W2 * solidity(p + n * FIELD_AO_D2)
            + FIELD_AO_W3 * solidity(p + n * FIELD_AO_D3);
  return clamp(1.0 - occ, FIELD_AO_MIN, 1.0);
}

// ---- traced near field: short rays through the voxel grid ----
// First matter a ray from ro along rd enters within tLim cells: returns its
// distance (or -1) and the cell and entry-face normal. opaqueOnly: only matter
// that blocks light outright counts (shadow rays); otherwise anything but gas
// does (AO). Smooth surfaces count as drawn, where their field is inside
// (sampled where the ray passes closest to the cell centre: their cells'
// staircase stands proud of a slope), and only from selfSkip cells out, since
// the ray starts by one; the floor counts as matter.
const int NEAR_MAX_STEPS = 48;   // cells (or empty-region jumps) a traced ray may visit
// Whether p is inside a smooth surface (opaqueOnly: an opaque one; else liquid too).
bool nearSmoothIn(vec3 p, bool opaqueOnly) {
  vec4 s = surfField(p);
  return max(max(s.y, s.z), max(s.w, opaqueOnly ? 0.0 : s.x)) >= SURF_ISO;
}
float traceNear(vec3 ro, vec3 rd, float tLim, bool opaqueOnly, float selfSkip, out ivec3 hc, out vec3 hn) {
  rd = safeDir(rd);
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = ivec3(floor(ro));
  hc = cell; hn = vec3(0.0);
  if (cell.y < 0 || outside(cell)) return -1.0;
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = 0.0;
  int ax = 1;
  ivec3 lastB = ivec3(-1);
  float occ = 0.0;
  for (int i = 0; i < NEAR_MAX_STEPS; i++) {
    if (tEnter > tLim) break;
    if (cell.y < 0) { hc = cell; hn = vec3(0.0, 1.0, 0.0); return tEnter; }
    if (outside(cell)) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; occ = brickOcc(bc); }
    if (occ < 0.5) { ax = skipEmpty(bc, ro, rd, istp, cell, tMax, tEnter); continue; }
    int id = eid(fetchA(cell));
    int axOut = argmin3(tMax);
    if (id != E_EMPTY && KIND[id] != K_GAS && (!opaqueOnly || RCLASS[id] == R_OPAQUE)
        && (isCrisp(id) || (tEnter > selfSkip && nearSmoothIn(ro + rd * tClosest(cell, ro, rd, tEnter, tMax[axOut]), opaqueOnly)))) {
      hc = cell;
      hn = vec3(0.0); hn[ax] = -float(istp[ax]);
      return tEnter;
    }
    ax = axOut;
    tEnter = tMax[ax];
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return -1.0;
}

// Random numbers for this pixel and frame: k-th of a decorrelated set.
#define NEAR_RAND_STREAMS 8       // random streams per frame (near-field rays, glow candidates)
vec2 pixRand(int k) {
  return hash33(vec3(gl_FragCoord.xy, float(uFrame) * float(NEAR_RAND_STREAMS) + float(k))).xy;
}

// Voxel AO and nearby bounce light (Teardown style). NEAR_RAYS cosine-
// distributed rays per pixel and frame (TAA averages them) walk the grid up to
// NEAR_RANGE cells. A ray that hits matter sees that matter's own light: its
// albedo times the sun (shadow-mapped), the probes' light and the glow there.
// A ray that escapes sees what the probes say (irr). Probes already hold
// occlusion at brick scale, so a hit's weight fades with its distance, handing
// far hits back to them. Returns the indirect irradiance / pi to use instead
// of irr * AO, and writes the visibility for specular occlusion and glow.
#define NEAR_RAYS 2
const float NEAR_RANGE = 6.0;     // cells a ray reaches
const float NEAR_START = 0.55;    // cells off the surface (along its normal) a ray starts
const float NEAR_SELF_SKIP = 1.0; // smooth-surface cells ignored this close to the start
const float NEAR_HIT_LIFT = 0.5;  // cells off a hit's face where its light is looked up
const float NEAR_VIS_MIN = 0.15;  // light left in the deepest crevice
vec3 nearField(vec3 p, vec3 ng, vec3 n, vec3 irr, out float vis) {
  vec3 t1 = normalize(cross(abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), n));
  vec3 t2 = cross(n, t1);
  vec3 ro = p + ng * NEAR_START;
  vec3 sum = vec3(0.0);
  vis = 0.0;
  for (int i = 0; i < NEAR_RAYS; i++) {
    vec2 u = pixRand(i);
    float r = sqrt(u.x), a = 2.0 * PI_L * u.y;
    vec3 d = t1 * (r * cos(a)) + t2 * (r * sin(a)) + n * sqrt(max(1.0 - u.x, 0.0));
    if (dot(d, ng) < 0.0) d = reflect(d, ng);   // keep it above the geometric surface
    ivec3 hc; vec3 hn;
    float t = traceNear(ro, d, NEAR_RANGE, false, NEAR_SELF_SKIP, hc, hn);
    if (t < 0.0) { sum += irr; vis += 1.0; continue; }
    float w = 1.0 - t / NEAR_RANGE;
    vec3 hp = ro + d * t + hn * NEAR_HIT_LIFT;
    vec3 alb = hc.y < 0 ? GROUND_ALB : ALBEDO[eid(fetchA(hc))];
    float ndl = max(dot(hn, uSun), 0.0);
    vec3 sun = ndl > 0.0 ? SUN_COL * ndl * (uShadows ? sunShadow(hp) : vec3(1.0)) : vec3(0.0);
    vec3 Lhit = alb * (sun + giIrradiance(probeAt(hp + hn * GI_OFFSET), hn) + sampleLight(hp) * uLightGain);
    sum += mix(irr, Lhit, w);
    vis += 1.0 - w;
  }
  vis = max(vis / float(NEAR_RAYS), NEAR_VIS_MIN);
  return sum / float(NEAR_RAYS);
}

// ---- lava and fire as lights ----
// The glow volume carries emitted light blurred over bricks: no direction and
// no shadows. Here each pixel picks one emitting brick near it by resampled
// importance sampling (GLOW_CANDIDATES random bricks within GLOW_REACH bricks,
// weighted by emitted power / distance^2) and traces a shadow ray to a random
// point in it. The glow volume's light is then scaled by what that ray says:
// 0 in its shadow, 2 n.l facing it (1 on average over a hemisphere of
// emitters). With no emitter among the candidates the glow is left as it is.
#define GLOW_CANDIDATES 6
const int GLOW_REACH = 3;            // bricks each way the candidates are drawn from
const float GLOW_MIN_D2 = 4.0;       // cells^2: floor of the 1/d^2 weight
const float GLOW_EMIT_MIN = 1e-4;    // a brick's emitted power (luminance) below this is dark
const float GLOW_START = 0.55;       // cells off the surface a shadow ray starts
const float GLOW_SELF_SKIP = 1.0;    // smooth-surface cells ignored this close to its start
const float GLOW_ENTRY_PAD = 0.05;   // cells short of the emitter's brick the ray stops
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
// Worth tracing only where the glow is at least this share of the light already there.
const float GLOW_REL_MIN = 0.05;
bool glowWorthIt(vec3 local, vec3 irr) { return uGlowLights && dot(local, LUMA) > GLOW_REL_MIN * dot(irr, LUMA); }
float glowLightScale(vec3 p, vec3 ng, vec3 n) {
  ivec3 pb = ivec3(floor(p)) / BS;
  ivec3 lo = max(pb - GLOW_REACH, ivec3(0)), hi = min(pb + GLOW_REACH, ivec3(BX, BY, BZ) - 1);
  vec3 span = vec3(hi - lo + 1);
  float wSum = 0.0;
  ivec3 pick = ivec3(-1);
  for (int i = 0; i < GLOW_CANDIDATES; i++) {
    vec3 u = hash33(vec3(gl_FragCoord.xy, float(uFrame) * float(NEAR_RAND_STREAMS) + float(NEAR_RAYS + i)));
    ivec3 bc = min(lo + ivec3(u * span), hi);
    float e = dot(texelFetch(tBrick, brickAtlas(bc), 0).rgb, LUMA);
    if (e < GLOW_EMIT_MIN) continue;
    vec3 dv = (vec3(bc) + 0.5) * float(BS) - p;
    float wt = e / max(dot(dv, dv), GLOW_MIN_D2);
    wSum += wt;
    if (hash13(vec3(u.zx * 97.0, float(i))) * wSum < wt) pick = bc;
  }
  if (pick.x < 0) return 1.0;
  if (pick == pb) return 1.0;   // inside the emitter's own brick: no direction to speak of
  vec3 bmin = vec3(pick * BS);
  vec3 target = bmin + hash33(vec3(gl_FragCoord.yx, float(uFrame) + 0.5)) * float(BS);
  vec3 ro = p + ng * GLOW_START;
  vec3 dv = target - ro;
  float dist = length(dv);
  vec3 d = dv / dist;
  float nl = dot(n, d);
  if (nl <= 0.0) return 0.0;
  // distance to where the ray enters the emitter's brick
  vec3 sd = safeDir(d);
  vec3 ta = (bmin - ro) / sd, tb = (bmin + float(BS) - ro) / sd;
  vec3 tn = min(ta, tb);
  float tIn = max(max(tn.x, tn.y), max(tn.z, 0.0));
  ivec3 hc; vec3 hn;
  float t = traceNear(ro, d, max(tIn - GLOW_ENTRY_PAD, 0.0), true, GLOW_SELF_SKIP, hc, hn);
  return t < 0.0 ? 2.0 * nl : 0.0;
}

// ---- hand lamps ----
// The light of the lamps at surface point p (normal n, geometric normal ng),
// to be multiplied by the albedo: each an inverse-square point light,
// (LAMP_UNIT / d)² × its colour, faded smoothly to nothing at its reach, and
// shadowed by a traced ray to it (opaque matter only, as the glow lights').
const float LAMP_UNIT = ${LAMP_UNIT.toFixed(1)};        // cells at which a lamp's colour is its irradiance
const float LAMP_START = 0.55;      // cells off the surface a shadow ray starts
const float LAMP_SELF_SKIP = 1.0;   // smooth-surface cells ignored this close to its start
const float LAMP_PAD = 0.3;         // cells short of the lamp the shadow ray stops (it hangs in air)
vec3 lampLight(vec3 p, vec3 ng, vec3 n) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < LAMP_MAX; i++) {
    if (i >= uLampCount) break;
    vec3 ro = p + ng * LAMP_START;
    vec3 dv = uLampPos[i].xyz - ro;
    float d2 = dot(dv, dv), R = uLampPos[i].w;
    if (d2 >= R * R) continue;
    float d = sqrt(d2);
    vec3 l = dv / max(d, 1e-4);
    float nl = dot(n, l);
    if (nl <= 0.0) continue;
    float fade = 1.0 - d2 / (R * R);
    float fall = LAMP_UNIT * LAMP_UNIT / max(d2, LAMP_UNIT) * fade * fade;
    ivec3 hc; vec3 hn;
    if (traceNear(ro, l, max(d - LAMP_PAD, 0.0), true, LAMP_SELF_SKIP, hc, hn) >= 0.0) continue;
    sum += uLampCol[i].rgb * nl * fall;
  }
  return sum;
}
`;

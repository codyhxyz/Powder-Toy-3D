import { skyGLSL } from '../../gfx/sky.js';

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

// ---- sun and sky: a clear-sky atmosphere (gfx/sky.js) ----
// Values that only depend on the sun are computed once per frame in JS.
${skyGLSL()}
uniform vec3 uSunExt;   // transmittance of the air along the sun's path
uniform vec3 uSunCol;   // direct sunlight at the ground: warmer and dimmer as the sun gets lower
uniform vec3 uSkyUp;    // open-sky irradiance on an upward surface
uniform vec3 uGround;   // radiance of the sunlit, sky-lit ground around the box
#define SUN_COL uSunCol
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
  return SKY_MULTI * PI_L * SUN_TOA * (TAU_RAYLEIGH * pR + TAU_AEROSOL * pM) / TAU_AIR * path;
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
const float SHADOW_TINT_ID_SCALE = 1000.0; // w packing: id * this + optical depth (< this); written by render.js's shadow pass
const float SHADOW_PAD = 1.0;              // voxels the map's disc reaches past the box's bounding sphere
const float SHADOW_NORMAL_OFFSET = 0.002;  // voxels a surface lookup moves off the surface along its normal
// Hard-map depth bias (voxels), see sunShadow: at least SHADOW_BIAS_MIN, else the
// PCF slope term (n.sun floored at SHADOW_BIAS_NS_MIN) plus SHADOW_BIAS_PAD.
const float SHADOW_BIAS_MIN = 0.8;
const float SHADOW_BIAS_NS_MIN = 0.25;
const float SHADOW_BIAS_PAD = 0.1;
const float VOLUME_SHADOW_BIAS = 0.6;      // depth bias (voxels) for points inside volumes (no normal)
// Exact sun rays: a smooth opaque surface's own cells are ignored for this many
// voxels from the start, and the ray stops this far past the nearest occluder
// depth the shadow-map taps saw.
const float SUN_RAY_SELF_SKIP = 1.2;
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

void sunBasis(out vec3 c, out float R, out vec3 u, out vec3 v) {
  c = vec3(GRID) * 0.5;
  R = 0.5 * length(vec3(GRID)) + SHADOW_PAD;
  u = normalize(cross(vec3(0.0, 1.0, 0.0), uSun));
  v = cross(uSun, u);
}

// 1 if the ray from ro toward the sun gets tLim voxels without entering an
// opaque voxel, else 0 (exact DDA, same traversal as the view rays). Cells of
// a smooth opaque surface only count beyond SUN_RAY_SELF_SKIP: the surface the
// ray starts on may sit inside its own cells.
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
  ivec3 lastB = ivec3(-1);
  float occ = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (outside(cell) || tEnter > tLim) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; occ = brickOcc(bc); }
    if (occ < 0.5) { skipEmpty(bc, ro, rd, istp, cell, tMax, tEnter); continue; }
    int id = eid(cellA(cell));
    if (id != E_EMPTY && RCLASS[id] == R_OPAQUE && (isCrisp(id) || tEnter - t > SUN_RAY_SELF_SKIP)) return 0.0;
    int ax = argmin3(tMax);
    tEnter = tMax[ax];
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return 1.0;
}

// The taps: a Vogel (sunflower) disc of radius 1, rotated per pixel and frame.
const vec2 VOGEL[PCSS_TAPS] = vec2[PCSS_TAPS](${vogel(PCSS_TAPS)});

// Sun visibility at a surface point hp with normal n.
vec3 sunShadow(vec3 hp, vec3 n) {
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
    acc += lit * att * wk;
    tr += att * wk;
    nLit += lit;
    dMin = min(dMin, sm.x);
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

// Sun visibility at a point inside a volume (media, liquid interiors).
vec3 sunShadow(vec3 p) {
  vec3 c, u, v; float R;
  sunBasis(c, R, u, v);
  vec3 q = p - c;
  vec2 st = vec2(dot(q, u), dot(q, v)) / R * 0.5 + 0.5;
  float d = R - dot(q, uSun);
  vec2 f = st * float(uShadowRes) - 0.5;
  ivec2 i0 = ivec2(floor(f));
  vec2 w = f - vec2(i0);
  vec3 acc = vec3(0.0);
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
    }
    float wk = (o.x == 1 ? w.x : 1.0 - w.x) * (o.y == 1 ? w.y : 1.0 - w.y);
    acc += lit * wk;
  }
  return acc;
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
  int id = eid(cellA(c));
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
  if (!outside(c) && isCrisp(eid(cellA(c)))) o = 1.0;
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
`;

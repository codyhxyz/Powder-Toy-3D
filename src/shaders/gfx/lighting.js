// Lighting: sun + shadow map, sky, the glow (emission) volume and ambient
// occlusion. Shading code only talks to the scene's light through these.
export const lightingGLSL = /* glsl */ `
const vec3 SUN_COL = vec3(1.25, 1.15, 1.0);

// ---- sun shadow map ----
// An orthographic shadow map covering the box, traced once per frame from the
// sun. Each texel stores (depth of first opaque surface, depth where
// translucent material starts, depth where it ends, tint element id * 1000 +
// optical depth accumulated through it). Points in between get a proportional share.
uniform vec3 uSun;
uniform sampler2D tShadow;
uniform int uShadowRes;

void sunBasis(out vec3 c, out float R, out vec3 u, out vec3 v) {
  c = vec3(GRID) * 0.5;
  R = 0.5 * length(vec3(GRID)) + 1.0;
  u = normalize(cross(vec3(0.0, 1.0, 0.0), uSun));
  v = cross(uSun, u);
}

// 1 if the ray from ro toward the sun gets tLim voxels without entering an
// opaque voxel, else 0 (exact DDA, same traversal as the view rays). Cells of
// a smooth opaque surface only count beyond 1.2 voxels: the surface the ray
// starts on may sit inside its own cells.
float sunRayClear(vec3 ro, float tLim) {
  vec3 rd = safeDir(uSun);
  vec3 bh = boxHit(ro, rd);
  float t = max(bh.x, 0.0);
  if (bh.y <= t) return 1.0;
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t + 1e-4))), ivec3(0), GRID - 1);
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = t;
  ivec3 lastB = ivec3(-1);
  float occ = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (outside(cell) || tEnter > tLim) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; occ = brickOcc(bc); }
    if (occ < 0.5) { skipBrick(bc, ro, rd, istp, cell, tMax, tEnter); continue; }
    int id = eid(cellA(cell));
    if (id != E_EMPTY && RCLASS[id] == R_OPAQUE && (isCrisp(id) || tEnter - t > 1.2)) return 0.0;
    int ax = argmin3(tMax);
    tEnter = tMax[ax];
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return 1.0;
}

// Sun visibility at a surface point hp with normal n.
vec3 sunShadow(vec3 hp, vec3 n) {
  vec3 c, u, v; float R;
  sunBasis(c, R, u, v);
  vec3 p = hp + n * 0.002;
  vec3 q = p - c;
  vec2 st = vec2(dot(q, u), dot(q, v)) / R * 0.5 + 0.5;
  float d = R - dot(q, uSun);
  // Depth bias. A PCF tap one texel (T voxels) away sees the receiver's own face
  // up to T*(|n.u|+|n.v|)/(n.s) closer, and at the foot of a sun-facing wall it
  // sees that wall up to ~0.6 closer: hence >= 0.8. It must stay well below
  // 1/uSun.y (1.23), the depth gap to the top of a 1-voxel step.
  float T = 2.0 * R / float(uShadowRes);
  float bias = max(0.8, T * (abs(dot(n, u)) + abs(dot(n, v))) / max(dot(n, uSun), 0.25) + 0.1);
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
    int tid = int(sm.w / 1000.0);
    if (tid > 0 && d > sm.y) {
      float tau = sm.w - float(tid) * 1000.0;
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
  // The taps disagree, so p is within a texel (~0.44 voxels at 128^3) of a shadow
  // edge, where the map can only blur. Settle it with an exact ray, traced only
  // as far as the occluders those taps saw.
  if (nLit > 0.0 && nLit < 4.0) return tr * sunRayClear(p, d - dMin + 1.5);
  return acc;
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
    vec3 lit = d < sm.x + 0.6 ? vec3(1.0) : vec3(0.0);
    int tid = int(sm.w / 1000.0);
    if (tid > 0 && d > sm.y) {
      float tau = sm.w - float(tid) * 1000.0;
      float frac = clamp((d - sm.y) / max(sm.z - sm.y, 1e-3), 0.0, 1.0);
      vec3 tint = SIGMA[tid] / max(dot(SIGMA[tid], vec3(1.0 / 3.0)), 1e-4);
      lit *= exp(-tint * tau * frac);
    }
    float wk = (o.x == 1 ? w.x : 1.0 - w.x) * (o.y == 1 ? w.y : 1.0 - w.y);
    acc += lit * wk;
  }
  return acc;
}

// ---- sky ----
vec3 skyColor(vec3 d) {
  float y = d.y * 0.5 + 0.5;
  return mix(vec3(0.05, 0.05, 0.06), vec3(0.42, 0.52, 0.68), smoothstep(0.2, 1.0, y));
}
// irradiance-ish ambient from the sky for a surface facing n
vec3 skyAmbient(vec3 n) {
  return mix(vec3(0.07, 0.065, 0.06), vec3(0.32, 0.38, 0.5), n.y * 0.5 + 0.5);
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

// ---- ambient occlusion ----
bool occluder(ivec3 c) {
  if (c.y < 0) return true;
  if (outside(c)) return false;
  int id = eid(cellA(c));
  return id != E_EMPTY && KIND[id] != K_GAS;
}

// Smooth per-corner AO on a crisp voxel face (Minecraft style).
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
  return 0.25 + 0.75 * ao;
}

// How solid the world is at p, 0..1 (smooth surfaces from the fields, crisp
// voxels and the floor from the state).
float solidity(vec3 p) {
  if (p.y < 0.0) return 1.0;
  vec4 s = surfField(p);
  float o = max(max(s.y, s.z), max(s.w, s.x * 0.6));
  ivec3 c = ivec3(floor(p));
  if (!outside(c) && isCrisp(eid(cellA(c)))) o = 1.0;
  return clamp(o, 0.0, 1.0);
}

// AO for smooth surfaces: probe the solidity along the normal (a flat surface
// sees ~0 from 1.5 cells out, crevices and the foot of piles see more).
float fieldAO(vec3 p, vec3 n) {
  float occ = 0.45 * solidity(p + n * 1.5) + 0.3 * solidity(p + n * 3.0) + 0.2 * solidity(p + n * 5.0);
  return clamp(1.0 - occ, 0.2, 1.0);
}
`;

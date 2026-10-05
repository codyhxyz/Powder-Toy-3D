import { prelude } from './common.js';
import { ELEMENTS } from '../elements.js';
import { COLORMAPS, xrayDensity } from '../views.js';

// Voxel raymarcher. Rays are traced through the grid with an Amanatides–Woo
// DDA. A 4×4×4 brick occupancy map lets the ray jump over empty space in one
// step. Opaque voxels are lit by the sun (with a secondary shadow ray), sky
// ambient with per-face corner AO, and a blurred light volume carrying the
// glow of lava/fire/hot metal. Liquids and glass are traced through with
// Beer–Lambert absorption and a Fresnel reflection at each interface; gases
// and flames are integrated as participating media.
export const lib = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tA;
uniform sampler2D tBrick;
uniform sampler2D tLight;

const ivec3 GRID = ivec3(NX, NY, NZ);

vec4 cellA(ivec3 c) { return texelFetch(tA, atlas(c), 0); }
float brickOcc(ivec3 bc) { return texelFetch(tBrick, brickAtlas(bc), 0).a; }
bool outside(ivec3 c) { return any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, GRID)); }

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

// ---- sun shadow map ----
// An orthographic shadow map covering the box, traced once per frame from the
// sun. Each texel stores (depth of first opaque voxel, depth where translucent
// material starts, depth where it ends, tint element id * 1000 + optical depth
// accumulated through it). Points in between get a proportional share.
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
// opaque voxel, else 0 (exact DDA, same traversal as the view rays).
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
  for (int i = 0; i < ${g.maxSteps}; i++) {
    if (outside(cell) || tEnter > tLim) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; occ = brickOcc(bc); }
    if (occ < 0.5) { skipBrick(bc, ro, rd, istp, cell, tMax, tEnter); continue; }
    int id = eid(cellA(cell));
    if (id != E_EMPTY && RCLASS[id] == R_OPAQUE) return 0.0;
    int ax = argmin3(tMax);
    tEnter = tMax[ax];
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  return 1.0;
}

// hp: a point on a voxel face, n: that face's normal.
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

`;

export const volumeVert = /* glsl */ `
out vec3 vGrid;
void main() {
  vGrid = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// ---- data views: GLSL generated from the colormaps in src/views.js ----

const glf = (x) => {
  const s = String(+(+x).toPrecision(7));
  return /[.e]/.test(s) ? s : s + '.0';
};
const srgbOf = (hex) => [0, 2, 4].map((o) => parseInt(hex.slice(1 + o, 3 + o), 16) / 255);

// For a colormap {knots, log}: <name>Pos(x) maps a value to its legend
// position (0..1), <name>Srgb(p) maps a position to its colour (interpolated
// in sRGB like the CSS legend), <name>Color(x) gives linear RGB.
function colormapGLSL(name, cm) {
  const k = cm.knots, n = k.length, C = `${name.toUpperCase()}_C`;
  let pos = `float ${name}Pos(float x) {\n  if (x <= ${glf(k[0][0])}) return 0.0;\n`;
  for (let i = 1; i < n; i++) {
    const a = k[i - 1][0], b = k[i][0];
    const f = cm.log && a * b > 0
      ? `log(x * ${glf(1 / a)}) * ${glf(1 / Math.log(b / a))}`
      : `(x - ${glf(a)}) * ${glf(1 / (b - a))}`;
    pos += `  if (x <= ${glf(b)}) return (${glf(i - 1)} + ${f}) * ${glf(1 / (n - 1))};\n`;
  }
  pos += '  return 1.0;\n}\n';
  const cols = k.map(([, h]) => `vec3(${srgbOf(h).map(glf).join(', ')})`).join(', ');
  return `${pos}const vec3 ${C}[${n}] = vec3[${n}](${cols});
vec3 ${name}Srgb(float p) {
  float f = clamp(p, 0.0, 1.0) * ${glf(n - 1)};
  int j = min(int(f), ${n - 2});
  return mix(${C}[j], ${C}[j + 1], f - float(j));
}
vec3 ${name}Color(float x) { return toLinear(${name}Srgb(${name}Pos(x))); }
`;
}

// X-ray attenuation per cell from density (compressed: ρ^0.6).
const xrayMu = () => `const float XRAY_MU[NE] = float[NE](${ELEMENTS.map((e) => glf(+(0.035 * Math.pow(xrayDensity(e), 0.6)).toFixed(5))).join(', ')});`;

export const volumeFrag = (g) => {
  // DDA shared by the data views. `body` runs for every voxel the ray visits
  // inside a brick holding matter, with cell, a (state A), id, n (entry face
  // normal), hp (entry point), seg, tEnter, tExit, occ, prevId and airOn (the
  // brick's air has something this view draws) in scope; it may `break`
  // (after setting trans/tHit). Bricks holding only air are integrated in one
  // go by `hooks.airBrick` (chord tB0..tB1 through brick bc) instead of voxel
  // by voxel, which is what keeps big clouds cheap. `air` = the brick flag
  // bits this view draws in air (1 warm/cold air, 2 pressure, 4 motion).
  // hooks.decl: declarations; hooks.onBrick: runs on entering each brick;
  // hooks.flush: composites anything deferred that the ray has now passed.
  const march = (name, air, body, floor, hooks = {}) => {
    const { decl = '', onBrick = '', airBrick = '', flush = '' } = hooks;
    return /* glsl */ `
void ${name}(vec3 ro, vec3 rd, float t0, int ax, inout vec3 col, inout float trans, inout float tHit) {
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t0 + 1e-4))), ivec3(0), GRID - 1);
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = t0;
  int prevId = E_EMPTY;
  ivec3 lastB = ivec3(-1);
  float occ = 0.0;
  bool live = false, airOn = false;
${decl}
  for (int i = 0; i < ${g.maxSteps}; i++) {
    if (outside(cell)) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) {
      lastB = bc;
      occ = brickOcc(bc);
      airOn = (brickFlags(occ) & ${air}) != 0;
      live = occ > 0.5 || airOn;
${onBrick}
    }
    if (!live) { ax = skipBrick(bc, ro, rd, istp, cell, tMax, tEnter); prevId = E_EMPTY; continue; }
    if (occ < -0.5) {
      // only air: integrate the whole chord through the brick, then jump past it
${flush}
      float tB0 = tEnter;
      ax = skipBrick(bc, ro, rd, istp, cell, tMax, tEnter);
      float tB1 = tEnter;
${airBrick}
      prevId = E_EMPTY;
      if (tHit < 0.0 && trans < 0.5) tHit = tB0;
      if (trans < 0.01) break;
      continue;
    }
    float tExit = min(tMax.x, min(tMax.y, tMax.z));
    float seg = tExit - tEnter;
    vec4 a = cellA(cell);
    int id = eid(a);
    vec3 n = vec3(0.0);
    n[ax] = -float(istp[ax]);
    vec3 hp = ro + rd * tEnter;
${flush}
${body}
    if (tHit < 0.0 && trans < 0.5) tHit = tEnter;
    if (trans < 0.01) break;
    prevId = id;
    ax = argmin3(tMax);
    tEnter = tExit;
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
${flush}
  if (trans >= 0.01 && cell.y < 0 && rd.y < 0.0) {
    float tf = -ro.y / rd.y;
    vec3 hp = ro + rd * tf;
    col += trans * (${floor});
    if (tHit < 0.0) tHit = tf;
    trans = 0.0;
  }
}
`;
  };

  // An opaque surface ends the ray.
  const solidHit = (c) => `
      col += trans * (${c});
      trans = 0.0;
      if (tHit < 0.0) tHit = tEnter;
      break;`;

  return /* glsl */ `
${lib(g)}
uniform sampler2D tB;
uniform vec3 uCam;
uniform int uView;
uniform bool uShadows;
uniform float uTime;
uniform float uLightGain;
uniform mat4 projectionMatrix;
uniform mat4 modelMatrix;
in vec3 vGrid;

// The view is picked at run time from uView. Defining VIEW (e.g.
// material.defines = { VIEW: 2 }) compiles a program specialised to one view.
#ifdef VIEW
#define CUR_VIEW VIEW
#else
#define CUR_VIEW uView
#endif

const vec3 SUN_COL = vec3(1.25, 1.15, 1.0);

bool occluder(ivec3 c) {
  if (c.y < 0) return true;
  if (outside(c)) return false;
  int id = eid(cellA(c));
  return id != E_EMPTY && RCLASS[id] != R_GAS && RCLASS[id] != R_FIRE;
}

// Smooth per-corner ambient occlusion on a voxel face (Minecraft style).
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

vec3 skyColor(vec3 d) {
  float y = d.y * 0.5 + 0.5;
  return mix(vec3(0.05, 0.05, 0.06), vec3(0.42, 0.52, 0.68), smoothstep(0.2, 1.0, y));
}

float occupied(ivec3 c) {
  if (c.y < 0) return 1.0;
  if (outside(c)) return 0.0;
  int id = eid(cellA(c));
  return (id == E_EMPTY || KIND[id] == K_GAS) ? 0.0 : 1.0;
}
// smooth-ish normal for liquid surfaces from the occupancy gradient
vec3 liquidNormal(ivec3 c, vec3 faceN) {
  vec3 gr = vec3(
    occupied(c + ivec3(1, 0, 0)) - occupied(c - ivec3(1, 0, 0)),
    occupied(c + ivec3(0, 1, 0)) - occupied(c - ivec3(0, 1, 0)),
    occupied(c + ivec3(0, 0, 1)) - occupied(c - ivec3(0, 0, 1)));
  vec3 n = faceN - gr * 0.6;
  return normalize(n);
}

vec3 shadeOpaque(ivec3 cell, int id, vec4 a, vec3 hp, vec3 n, vec3 rd) {
  float seed = fract(a.w);
  float T = a.y;
  vec3 alb = COLOR[id] * (1.0 + COLORVAR[id] * (seed * 2.0 - 1.0));
  vec3 emit = vec3(0.0);
  if (id == E_LAVA) {
    float flick = 0.85 + 0.15 * sin(uTime * 3.0 + seed * 40.0);
    alb = vec3(0.05, 0.03, 0.02);
    emit = incandescence(T) * flick;
  } else {
    // hot surfaces read as glowing: the emission dominates and the
    // reflected light fades (think of a red-hot poker)
    emit = incandescence(T);
    alb *= mix(1.0, 0.2, smoothstep(350.0, 1000.0, T));
  }
  if (id == E_PLANT) alb *= 0.8 + 0.4 * fract(seed * 7.3);
  float ndl = max(dot(n, uSun), 0.0);
  vec3 sh = (uShadows && ndl > 0.0) ? sunShadow(hp, n) : vec3(1.0);
  float ao = faceAO(cell, ivec3(n), hp);
  vec3 sky = mix(vec3(0.07, 0.065, 0.06), vec3(0.32, 0.38, 0.5), n.y * 0.5 + 0.5);
  vec3 local = sampleLight(hp + n * 0.75) * uLightGain;
  vec3 c = alb * (SUN_COL * ndl * sh + sky * ao + local * (0.35 + 0.65 * ao));
  if (id == E_METAL || id == E_WALL) {
    vec3 h = normalize(uSun - rd);
    float sp = pow(max(dot(n, h), 0.0), id == E_METAL ? 48.0 : 16.0) * (id == E_METAL ? 0.8 : 0.08);
    c += SUN_COL * sh * sp;
  }
  return c + emit;
}

vec3 shadeFloor(vec3 hp, vec3 rd) {
  vec2 q = hp.xz / 8.0;
  vec2 gq = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-4));
  float line = 1.0 - min(min(gq.x, gq.y), 1.0);
  vec3 alb = mix(vec3(0.075, 0.078, 0.085), vec3(0.14, 0.15, 0.17), line);
  vec3 n = vec3(0.0, 1.0, 0.0);
  float ndl = max(uSun.y, 0.0);
  vec3 sh = uShadows ? sunShadow(hp, n) : vec3(1.0);
  float ao = faceAO(ivec3(floor(hp.x), -1, floor(hp.z)), ivec3(0, 1, 0), hp);
  vec3 local = sampleLight(vec3(hp.x, 0.5, hp.z)) * uLightGain;
  return alb * (SUN_COL * ndl * sh + vec3(0.3, 0.35, 0.45) * ao + local * (0.35 + 0.65 * ao));
}

float softBlob(ivec3 cell, vec3 ro, vec3 rd, float t0, float t1) {
  vec3 cc = vec3(cell) + 0.5;
  float tm = clamp(dot(cc - ro, rd), t0, t1);
  return smoothstep(0.95, 0.1, length(ro + rd * tm - cc)) * 1.8;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// =====================================================================
// Data views: heat (1), pressure (2), flow (3), X-ray (4).
// False-colour renderings with soft "clay" lighting (sun direction, sky fill,
// corner AO) and no shadows. Colours stay in linear RGB and are written
// without the filmic curve, so a fully lit surface shows exactly its legend
// colour. They share the DDA from march() in render.js.
// =====================================================================

float gPix;   // angular size of a pixel (radians), for anti-aliasing thin strokes

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

${colormapGLSL('heat', COLORMAPS.heat)}
${colormapGLSL('pressure', COLORMAPS.pressure)}
${colormapGLSL('flowDir', COLORMAPS.flowDir)}
${colormapGLSL('flowSpeed', COLORMAPS.flowSpeed)}
${xrayMu()}

// Bricks carry flags (see brickFrag) saying what the data views would draw in
// their air: 1 = warmer/colder than ambient, 2 = pressure, 4 = moving.
int brickFlags(float occ) {
  if (occ > 0.5) return int(fract((occ - 1.0) * 64.0) * 1024.0 + 0.5);
  return occ < -0.5 ? int((-occ - 1.0) * 8.0 + 0.5) : 0;
}

float clay(ivec3 cell, vec3 hp, vec3 n) {
  float ndl = max(dot(n, uSun), 0.0);
  float ao = faceAO(cell, ivec3(n), hp);
  return (0.45 + 0.41 * ndl + 0.21 * (0.5 + 0.5 * n.y)) * (0.6 + 0.4 * ao);
}

vec3 dataFloor(vec3 hp, vec3 lo, vec3 hi) {
  vec2 q = hp.xz / 8.0;
  vec2 gq = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-4));
  float line = 1.0 - min(min(gq.x, gq.y), 1.0);
  float ao = faceAO(ivec3(floor(hp.x), -1, floor(hp.z)), ivec3(0, 1, 0), hp);
  return mix(lo, hi, line) * (0.5 + 0.5 * ao);
}

// Neutral stand-in for a material: its own lightness, no hue.
vec3 neutral(int id) { return vec3(0.05 + 0.2 * sqrt(luma(COLOR[id]))); }

// ---- heat ----
// Air glows faintly where it is warmer or colder than the room.
void heatAir(float T, float ds, inout vec3 col, inout float trans) {
  float d = abs(T - AMBIENT);
  if (d <= 3.0) return;
  float s = clamp(log2(d * (1.0 / 3.0)) * 0.125, 0.0, 1.0);   // 3 °C -> 0, 770 °C -> 1
  float e = 0.045 * s * s * ds;
  col += trans * heatColor(T) * e;
  trans *= exp(-0.5 * e);
}

${march('marchHeat', 1, /* glsl */ `
    if (id != E_EMPTY) {
      float T = a.y;
      if (KIND[id] == K_GAS) {
        // steam, smoke and flames: soft blobs coloured by their temperature
        float local = clamp(occ - 1.0, 0.0, 1.0);
        float dens = softBlob(cell, ro, rd, tEnter, tExit) * (0.4 + 2.0 * local)
                   * (id == E_SMOKE ? clamp(a.z, 0.0, 1.0) : 1.0);
        float al = 1.0 - exp(-(id == E_FIRE ? 0.6 : 0.3) * seg * dens);
        col += trans * al * heatColor(T);
        trans *= 1.0 - al;
      } else if (id == E_GLASS) {
        // glass is opaque to a real thermal camera, but here a container
        // shouldn't hide what's inside: a thin pane showing its temperature
        float al = 1.0 - exp(-0.5 * seg);
        col += trans * al * heatColor(T) * 0.85;
        trans *= 1.0 - al;
      } else {${solidHit('heatColor(T) * mix(1.0, clay(cell, hp, n), 0.7)')}
      }
    } else {
      heatAir(a.y, seg, col, trans);
    }`, 'dataFloor(hp, heatColor(AMBIENT) * 0.3, heatColor(AMBIENT) * 0.6)', {
  airBrick: /* glsl */ `
      int ns = clamp(int(ceil(tB1 - tB0)), 1, 7);
      float ds = (tB1 - tB0) / float(ns);
      for (int j = 0; j < 7; j++) {
        if (j >= ns) break;
        vec3 p = ro + rd * (tB0 + (float(j) + 0.5) * ds);
        heatAir(cellA(clamp(ivec3(floor(p)), ivec3(0), GRID - 1)).y, ds, col, trans);
      }`,
})}

// ---- pressure ----
// Pressure is a smooth field, so the cloud samples it trilinearly at the
// middle of the ray's path through each voxel: shock fronts read as smooth
// surfaces instead of voxel staircases.
float pressureAt(vec3 p) {
  vec3 q = p - 0.5;
  ivec3 i0 = ivec3(floor(q));
  vec3 f = q - vec3(i0);
  float s = 0.0;
  for (int k = 0; k < 8; k++) {
    ivec3 o = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    vec3 w = mix(1.0 - f, f, vec3(o));
    s += texelFetch(tB, atlas(clamp(i0 + o, ivec3(0), GRID - 1)), 0).w * w.x * w.y * w.z;
  }
  return s;
}

// The pressure field as a cloud, denser the stronger it is.
void pressureCloud(float P, float ds, inout vec3 col, inout float trans) {
  float s = abs(pressurePos(P) - 0.5) * 2.0;   // 0 ambient, .25 at |P|=0.1, .5 at 1, 1 at 100
  if (s <= 0.15) return;
  float al = 1.0 - exp(-0.3 * s * s * sqrt(s) * ds);
  col += trans * al * pressureColor(P);
  trans *= 1.0 - al;
}

${march('marchPressure', 2, /* glsl */ `
    int k = KIND[id];
    if (airOn && k != K_SOLID) pressureCloud(pressureAt(ro + rd * (tEnter + 0.5 * seg)), seg, col, trans);
    if (id != E_EMPTY) {
      if (k == K_GAS) {
        // smoke/steam/fire stay visible as faint grey wisps
        float al = 1.0 - exp(-0.06 * seg * softBlob(cell, ro, rd, tEnter, tExit));
        col += trans * al * vec3(0.12);
        trans *= 1.0 - al;
      } else if (RCLASS[id] == R_LIQUID || RCLASS[id] == R_GLASS) {
        // liquids, glass and ice: translucent grey, so pressure inside shows
        // (a thin pane seen edge-on is longer along the ray, so it outlines itself)
        float al = 1.0 - exp(-(id == E_GLASS ? 0.18 : 0.06) * seg);
        col += trans * al * neutral(id) * 0.8;
        trans *= 1.0 - al;
      } else {
        // pressure-sensitive paint: the face takes the colour of the
        // pressure pushing on it from the cell in front
        ivec3 f = cell + ivec3(n);
        float Pf = outside(f) ? 0.0 : texelFetch(tB, atlas(f), 0).w;
        float Pc = k == K_SOLID ? 0.0 : texelFetch(tB, atlas(cell), 0).w;
        float Pm = abs(Pf) > abs(Pc) ? Pf : Pc;
        float sm = abs(pressurePos(Pm) - 0.5) * 2.0;
        vec3 c = mix(neutral(id), pressureColor(Pm), smoothstep(0.2, 0.6, sm));${solidHit('c * clay(cell, hp, n)')}
      }
    }`, 'dataFloor(hp, vec3(0.012), vec3(0.03))', {
  airBrick: /* glsl */ `
      int ns = clamp(int(ceil((tB1 - tB0) * 0.8)), 1, 6);
      float ds = (tB1 - tB0) / float(ns);
      for (int j = 0; j < 6; j++) {
        if (j >= ns) break;
        pressureCloud(pressureAt(ro + rd * (tB0 + (float(j) + 0.5) * ds)), ds, col, trans);
      }`,
})}

// ---- flow ----
// Can particle a displace b moving down (0), up (1) or sideways (2)? Mirrors
// canMove() in move.js.
bool canDisplace(int a, int b, int dir) {
  if (KIND[a] == K_SOLID || KIND[b] == K_SOLID || a == b) return false;
  if (isGasLike(a) && isGasLike(b)) return true;
  if (!isFluid(a) && !isFluid(b)) return false;
  float da = DENS[a], db = DENS[b];
  return dir == 0 ? da > db : (dir == 1 ? da != db : db < da);
}
// The part of a particle's velocity that actually moves it. Liquid under a
// head keeps a random sideways velocity even in a still pool, and resting
// grains keep one tick of gravity; components pointing into something the
// particle can't displace (a wall, the same material, a denser grain) are
// dropped. A liquid's free surface also churns sideways at random as the
// automaton levels it, so sideways motion only counts for liquid that isn't
// resting on more of itself (a film spreading, a stream crossing ground).
vec3 mobileVel(ivec3 c, int id, vec3 v) {
  if (KIND[id] == K_LIQUID && c.y > 0 && eid(cellA(c - ivec3(0, 1, 0))) == id) v.xz = vec2(0.0);
  vec3 r = vec3(0.0);
  for (int k = 0; k < 3; k++) {
    if (abs(v[k]) < 0.01) continue;
    ivec3 q = c;
    q[k] += v[k] > 0.0 ? 1 : -1;
    int nb = outside(q) ? E_WALL : eid(cellA(q));
    if (canDisplace(id, nb, k != 1 ? 2 : (v.y < 0.0 ? 0 : 1))) r[k] = v[k];
  }
  return r;
}
// Colour for a velocity: hue from its direction (falling blue, sideways
// green, rising amber), mixed in from 'still' by w = speed position.
vec3 flowTint(vec3 still, vec3 v, float w) {
  vec3 hue = flowDirSrgb(flowDirPos(v.y / max(length(v), 1e-6)));
  return toLinear(mix(toSrgb(still), hue, w));
}

// Moving air is drawn as one stroke per brick (4³ cells): through a jittered
// point near the brick's centre, along the air's velocity there, longer when
// faster and brighter toward its head, so together they read as a 3D field
// of arrows. Returns the stroke's coverage of this ray (0..1), the velocity
// v sampled for the brick (zero where there is matter) and where along the
// ray the stroke is (gt).
float brickStroke(ivec3 bc, vec3 ro, vec3 rd, float ta, float tb, bool check, out vec3 v, out float gt) {
  uint hs = pcg(uint(bc.x) | uint(bc.y) << 10 | uint(bc.z) << 20);
  vec3 cc = vec3(bc * BS) + 2.0 + (vec3(uvec3(hs, hs >> 8, hs >> 16) & 255u) * (1.0 / 255.0) - 0.5);
  ivec3 c = ivec3(floor(cc));
  v = vec3(0.0);
  gt = ta;
  if (check && eid(cellA(c)) != E_EMPTY) return 0.0;
  v = texelFetch(tB, atlas(c), 0).xyz;
  float sp = length(v);
  if (sp < 0.06) return 0.0;
  float w = flowSpeedPos(sp);
  float h = 0.5 + 0.9 * w;                       // half-length, cells
  vec3 d = v / sp, w0 = ro - cc;
  float b = dot(rd, d), dr = dot(rd, w0), dw = dot(d, w0);
  float sl = clamp((dw - b * dr) / max(1.0 - b * b, 1e-4), -h, h);
  gt = clamp(dot(cc + d * sl - ro, rd), ta, tb);
  float dist = length(ro + rd * gt - cc - d * sl);
  float r = max(0.09, gt * gPix * 0.8);
  return smoothstep(r * 1.6, r * 0.4, dist) * min(1.0, 0.09 / r) * (0.2 + 0.8 * (sl / h * 0.5 + 0.5))
       * smoothstep(0.06, 0.2, sp);
}

${march('marchFlow', 4, /* glsl */ `
    if (id == E_EMPTY) {
      // moving air: faint haze from the brick's sampled velocity
      if (hazeW > 0.0) {
        float al = hazeW * 0.006 * seg;
        col += trans * al * hazeCol;
        trans *= 1.0 - 0.6 * al;
      }
    } else if (KIND[id] == K_GAS) {
      vec3 v = texelFetch(tB, atlas(cell), 0).xyz;
      float local = clamp(occ - 1.0, 0.0, 1.0);
      float dens = softBlob(cell, ro, rd, tEnter, tExit) * (0.4 + 2.0 * local)
                 * (id == E_SMOKE ? clamp(a.z, 0.0, 1.0) : 1.0);
      float al = 1.0 - exp(-0.25 * seg * dens);
      col += trans * al * flowTint(vec3(0.03), v, flowSpeedPos(length(v)));
      trans *= 1.0 - al;
    } else if (id == E_GLASS) {
      float al = 1.0 - exp(-0.18 * seg);
      col += trans * al * vec3(0.05);
      trans *= 1.0 - al;
    } else {
      vec3 v = mobileVel(cell, id, texelFetch(tB, atlas(cell), 0).xyz);
      float w = flowSpeedPos(length(v));
      vec3 still = mix(vec3(luma(COLOR[id])), COLOR[id], 0.35) * 0.35;${solidHit('flowTint(still, v, w) * clay(cell, hp, n)')}
    }`, 'dataFloor(hp, vec3(0.01), vec3(0.028))', {
  decl: /* glsl */ `
  float hazeW = 0.0, gT = 0.0, gAl = 0.0;
  vec3 hazeCol = vec3(0.0);`,
  onBrick: /* glsl */ `
      hazeW = 0.0;
      if (occ > 0.5 && airOn) {
        // brick with matter: its stroke is composited once the ray gets
        // past it, and dropped if a surface hides it first
        vec3 bmin = vec3(bc * BS);
        vec3 tb = (mix(bmin, bmin + float(BS), step(0.0, rd)) - ro) / rd;
        vec3 v;
        gAl = 0.8 * brickStroke(bc, ro, rd, tEnter, min(tb.x, min(tb.y, tb.z)), true, v, gT);
        float sp = length(v);
        hazeW = flowSpeedPos(sp) * smoothstep(0.06, 0.2, sp);
        hazeCol = flowTint(vec3(0.0), v, 1.0);
      }`,
  flush: /* glsl */ `
    if (gAl > 0.0 && tEnter >= gT) {
      col += trans * gAl * hazeCol;
      trans *= 1.0 - 0.6 * gAl;
      gAl = 0.0;
    }`,
  airBrick: /* glsl */ `
      vec3 v;
      float gt;
      float cov = brickStroke(bc, ro, rd, tB0, tB1, false, v, gt);
      float sp = length(v);
      if (sp > 0.06) {
        float al = flowSpeedPos(sp) * smoothstep(0.06, 0.2, sp) * 0.006 * (tB1 - tB0) + 0.8 * cov;
        col += trans * al * flowTint(vec3(0.0), v, 1.0);
        trans *= 1.0 - 0.6 * al;
      }`,
})}

// ---- X-ray ----
// Element colour lifted toward a common lightness so dark materials still show.
vec3 xrayColor(int id) {
  vec3 c = COLOR[id];
  float L = luma(c);
  return c * (mix(L, 0.4, 0.6) / max(L, 1e-3));
}

${march('marchXray', 0, /* glsl */ `
    // nearer things a little brighter, so depth reads without lighting
    float cue = 1.0 / (1.0 + 0.004 * (tEnter - t0));
    if (id != prevId) {
      // A boundary shows as a thin sheet. Borders between two materials (the
      // structure inside piles and containers) are emphasised; outer surfaces
      // stay faint, since a thin shell seen edge-on already outlines itself
      // (and a grazing ray crosses a voxel wall's faces many times).
      bool inner = id != E_EMPTY && prevId != E_EMPTY;
      int m = id != E_EMPTY ? id : prevId;
      float sheet = inner ? 0.2 * (0.5 + 0.5 * (1.0 - abs(dot(n, rd)))) : 0.05;
      sheet *= clamp(XRAY_MU[m] * 16.0, 0.2, 1.0);
      col += trans * sheet * xrayColor(m) * 1.6 * cue;
      trans *= 1.0 - 0.5 * sheet;
    }
    if (id != E_EMPTY) {
      // emission a little above absorption, so overlaps add up like a radiograph
      float al = 1.0 - exp(-XRAY_MU[id] * seg);
      col += trans * al * xrayColor(id) * 1.15 * cue;
      trans *= 1.0 - al;
    }`, 'dataFloor(hp, vec3(0.006), vec3(0.022))')}

void dataView(vec3 ro, vec3 rd, float t0, vec3 bh) {
  vec3 col = vec3(0.0);
  float trans = 1.0, tHit = -1.0;
  int ax = int(bh.z);
  if (CUR_VIEW == 1) marchHeat(ro, rd, t0, ax, col, trans, tHit);
  else if (CUR_VIEW == 2) marchPressure(ro, rd, t0, ax, col, trans, tHit);
  else if (CUR_VIEW == 3) marchFlow(ro, rd, t0, ax, col, trans, tHit);
  else marchXray(ro, rd, t0, ax, col, trans, tHit);
  float alpha = 1.0 - trans;
  if (alpha < 0.002) discard;
  vec3 c = col / alpha;
  if (CUR_VIEW == 4) c = 1.0 - exp(-1.25 * c);  // X-ray: soft clip, overlaps add up
  gl_FragColor = vec4(toSrgb(clamp(c, 0.0, 1.0)) * alpha, alpha);
  // depth: where the ray became mostly opaque, else where it leaves the box
  float td = tHit >= 0.0 ? tHit : bh.y;
  vec4 clip = projectionMatrix * viewMatrix * modelMatrix * vec4(ro + rd * td, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
}

void main() {
  vec3 ro = uCam;
  vec3 rd = safeDir(normalize(vGrid - uCam));
  if (CUR_VIEW == 3) gPix = length(fwidth(rd));
  vec3 bh = boxHit(ro, rd);
  float t0 = max(bh.x, 0.0);
  if (bh.y <= t0) discard;
  if (CUR_VIEW != 0) { dataView(ro, rd, t0, bh); return; }

  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t0 + 1e-4))), ivec3(0), GRID - 1);
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = t0;
  int ax = int(bh.z);

  vec3 col = vec3(0.0);
  vec3 trans = vec3(1.0);
  float tHit = -1.0;
  int prevId = E_EMPTY;
  vec3 mediumLight = vec3(1.0);
  ivec3 lastB = ivec3(-1);
  float occ = 0.0;

  for (int i = 0; i < ${g.maxSteps}; i++) {
    if (outside(cell)) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; occ = brickOcc(bc); }
    if (occ < 0.5) {
      ax = skipBrick(bc, ro, rd, istp, cell, tMax, tEnter);
      prevId = E_EMPTY;
      continue;
    }
    float tExit = min(tMax.x, min(tMax.y, tMax.z));
    float seg = tExit - tEnter;
    vec4 a = cellA(cell);
    int id = eid(a);
    vec3 n = vec3(0.0);
    n[ax] = -float(istp[ax]);

    if (id != E_EMPTY) {
      int rc = RCLASS[id];
      if (tHit < 0.0) tHit = tEnter;
      vec3 hp = ro + rd * tEnter;

      if (rc == R_OPAQUE) {
        col += trans * shadeOpaque(cell, id, a, hp, n, rd);
        trans = vec3(0.0);
        break;
      } else if (rc == R_LIQUID || rc == R_GLASS) {
        if (id != prevId) {
          // interface: Fresnel reflection of sky + sun glint
          vec3 sn = rc == R_LIQUID ? liquidNormal(cell, n) : n;
          if (dot(sn, rd) > 0.0) sn = n;
          float cosi = clamp(-dot(sn, rd), 0.0, 1.0);
          float f0 = rc == R_LIQUID ? 0.02 : 0.045;
          bool fromAir = prevId == E_EMPTY || KIND[prevId] == K_GAS;
          float F = (f0 + (1.0 - f0) * pow(1.0 - cosi, 5.0)) * (fromAir ? 1.0 : 0.3);
          vec3 r = reflect(rd, sn);
          mediumLight = uShadows ? sunShadow(hp, n) : vec3(1.0);
          vec3 refl = skyColor(r) + SUN_COL * mediumLight * pow(max(dot(r, uSun), 0.0), 400.0) * 6.0;
          col += trans * F * refl;
          trans *= 1.0 - F;
        }
        vec3 ext = SIGMA[id];
        vec3 att = exp(-ext * seg);
        // in-scattering so deep liquid reads as its own colour, not black
        vec3 amb = vec3(0.3, 0.35, 0.42) + SUN_COL * mediumLight * max(uSun.y, 0.0) * 0.6
                 + sampleLight(hp) * uLightGain;
        vec3 sc = COLOR[id] * amb * (rc == R_LIQUID ? 0.55 : 0.15) + incandescence(a.y);
        col += trans * (1.0 - att) * sc;
        trans *= att;
      } else if (rc == R_GAS) {
        // render each gas voxel as a soft blob rather than a hard cube
        // Lone gas voxels read as faint wisps, dense plumes as thick cloud.
        float local = clamp(occ - 1.0, 0.0, 1.0);
        float dens = (id == E_SMOKE ? clamp(a.z, 0.0, 1.0) : 1.0) * softBlob(cell, ro, rd, tEnter, tExit)
                   * (0.3 + 3.0 * local);
        vec3 alb = COLOR[id];
        float alpha = 1.0 - exp(-SIGMA[id].x * seg * dens);
        vec3 light = vec3(0.3, 0.34, 0.4) + SUN_COL * 0.45 + sampleLight(hp) * uLightGain;
        col += trans * alpha * alb * light;
        trans *= 1.0 - alpha;
      } else if (rc == R_FIRE) {
        float T = a.y;
        vec3 e = blackbody(T) * pow(T / 1000.0, 2.0) * (0.4 + 0.6 * clamp(a.z, 0.0, 1.0)) * 2.2
               * softBlob(cell, ro, rd, tEnter, tExit);
        col += trans * e * seg;
        trans *= exp(-0.12 * seg);
      }
    }

    if (max(trans.x, max(trans.y, trans.z)) < 0.01) break;
    prevId = id;
    ax = argmin3(tMax);
    tEnter = tExit;
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }

  // floor of the box
  if (max(trans.x, max(trans.y, trans.z)) >= 0.01 && cell.y < 0 && rd.y < 0.0) {
    float tf = -ro.y / rd.y;
    vec3 hp = ro + rd * tf;
    if (tHit < 0.0) tHit = tf;
    col += trans * shadeFloor(hp, rd);
    trans = vec3(0.0);
  }

  if (tHit < 0.0) discard;
  float alpha = 1.0 - dot(trans, vec3(1.0 / 3.0));
  vec3 outc = aces(col * 1.1);
  outc = pow(outc, vec3(1.0 / 2.2));
  gl_FragColor = vec4(outc * (alpha > 0.0 ? 1.0 : 0.0), alpha);

  vec4 clip = projectionMatrix * viewMatrix * modelMatrix * vec4(ro + rd * tHit, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
}
`;
};

// Picking: march a single ray (the mouse ray) and report the first
// non-gas voxel it hits. Pixel 0 = (cell xyz, face), pixel 1 = (id, T, P, life).
export const pickFrag = (g) => /* glsl */ `
${lib(g)}
uniform sampler2D tB;
uniform vec3 uRo;
uniform vec3 uRd;
out vec4 oC;

void main() {
  vec3 ro = uRo;
  vec3 rd = safeDir(normalize(uRd));
  vec4 miss = vec4(0.0, 0.0, 0.0, -1.0);
  vec3 bh = boxHit(ro, rd);
  float t0 = max(bh.x, 0.0);
  if (bh.y <= t0) { oC = miss; return; }

  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t0 + 1e-4))), ivec3(0), GRID - 1);
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = t0;
  int ax = int(bh.z);
  ivec3 lastB = ivec3(-1);
  float occ = 0.0;

  for (int i = 0; i < ${g.maxSteps}; i++) {
    if (outside(cell)) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; occ = brickOcc(bc); }
    if (occ < 0.5) { ax = skipBrick(bc, ro, rd, istp, cell, tMax, tEnter); continue; }
    vec4 a = cellA(cell);
    int id = eid(a);
    if (id != E_EMPTY && KIND[id] != K_GAS) {
      int face = ax * 2 + (istp[ax] > 0 ? 1 : 0); // normal = -step
      if (gl_FragCoord.x < 1.0) oC = vec4(vec3(cell), float(face));
      else oC = vec4(float(id), a.y, texelFetch(tB, atlas(cell), 0).w, a.z);
      return;
    }
    ax = argmin3(tMax);
    tEnter = min(tMax.x, min(tMax.y, tMax.z));
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  if (cell.y < 0 && rd.y < 0.0) {
    // floor hit
    if (gl_FragCoord.x < 1.0) oC = vec4(float(cell.x), -1.0, float(cell.z), 2.0);
    else oC = vec4(-1.0, AMBIENT, 0.0, 0.0);
    return;
  }
  oC = miss;
}
`;

// Shadow map pass: one ray per texel, marching from the sun toward the box.
export const shadowFrag = (g) => /* glsl */ `
${lib(g)}
out vec4 oC;
void main() {
  vec3 c, u, v; float R;
  sunBasis(c, R, u, v);
  vec2 st = gl_FragCoord.xy / float(uShadowRes) * 2.0 - 1.0;
  vec3 ro = c + uSun * R + (u * st.x + v * st.y) * R;
  vec3 rd = safeDir(-uSun);
  oC = vec4(1e5, 1e5, 1e5, 0.0);
  vec3 bh = boxHit(ro, rd);
  float t = max(bh.x, 0.0);
  if (bh.y <= t) return;
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t + 1e-4))), ivec3(0), GRID - 1);
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = t;
  ivec3 lastB = ivec3(-1);
  float occ = 0.0;
  int tid = 0;
  float tau = 0.0;
  bool hit = false;
  for (int i = 0; i < ${g.maxSteps}; i++) {
    if (outside(cell)) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; occ = brickOcc(bc); }
    if (occ < 0.5) { skipBrick(bc, ro, rd, istp, cell, tMax, tEnter); continue; }
    int ax = argmin3(tMax);
    float tExit = tMax[ax];
    int id = eid(cellA(cell));
    if (id != E_EMPTY) {
      int rc = RCLASS[id];
      if (rc == R_OPAQUE) { oC.x = tEnter; hit = true; break; }
      if (rc == R_LIQUID || rc == R_GLASS || rc == R_GAS) {
        float k = dot(SIGMA[id], vec3(1.0 / 3.0)) * (rc == R_GAS ? 0.25 : 1.0);
        if (tid == 0) { oC.y = tEnter; tid = id; }
        else if (RCLASS[tid] == R_GAS && rc != R_GAS) tid = id; // liquids tint over gases
        tau += k * (tExit - tEnter);
        oC.z = tExit;
      }
    }
    tEnter = tExit;
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  if (!hit && rd.y < 0.0) oC.x = ro.y / -rd.y; // floor
  oC.w = float(tid) * 1000.0 + min(tau, 999.0);
}
`;

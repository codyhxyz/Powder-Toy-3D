import { prelude } from './common.js';
import { AIR_FLAGS } from './passes.js';
import { ELEMENTS } from '../elements.js';
import { COLORMAPS, VIEWS, xrayDensity } from '../views.js';
import { materialsGLSL } from '../gfx/materials.js';
import { coreGLSL } from './gfx/core.js';
import { noiseGLSL } from './gfx/noise.js';
import { lightingGLSL } from './gfx/lighting.js';
import { surfaceGLSL } from './gfx/surface.js';
import { liquidGLSL } from './gfx/liquid.js';
import { mediaGLSL } from './gfx/media.js';
import { plainGLSL } from './gfx/plain.js';


// Hybrid raymarcher. Rays walk the voxel grid with an Amanatides–Woo DDA
// (4×4×4 bricks skip empty space). What they hit depends on the element's look
// (gfx/materials.js):
// - crisp elements (wall, metal, glass, clone) are voxels;
// - liquids, lava, powders and organics are smooth surfaces: the 0.5
//   isosurface of blurred occupancy fields (shaders/fields.js), found by
//   root-finding inside each cell segment. Cells too isolated to form a
//   surface are drawn as droplets / grains;
// - liquids refract (real bent rays), absorb (Beer–Lambert) and reflect;
// - smoke, steam and fire are density volumes.
// Views 1-4 (heat, pressure, flow, X-ray) are false-colour data views with
// their own marches (below); view 0 is the realistic render.
export const lib = (g) => /* glsl */ `
${prelude(g)}
${materialsGLSL()}
${coreGLSL(g)}
${noiseGLSL}
${lightingGLSL}
`;

export const volumeVert = /* glsl */ `
out vec3 vGrid;
void main() {
  vGrid = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// ---- data views: GLSL generated from the colormaps in src/views.js ----

const GLSL_DIGITS = 7;   // significant digits of generated float literals (float32 holds ~7)
const glf = (x) => {
  const s = String(+(+x).toPrecision(GLSL_DIGITS));
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

// X-ray attenuation per cell from density, compressed (ρ^XRAY_DENSITY_POW)
// so light and heavy materials both read.
const XRAY_MU_PER_DENSITY = 0.035;   // attenuation per cell at density 1
const XRAY_DENSITY_POW = 0.6;
const XRAY_MU_DECIMALS = 5;          // rounding of the generated table
const xrayMu = () => `const float XRAY_MU[NE] = float[NE](${ELEMENTS.map((e) => glf(+(XRAY_MU_PER_DENSITY * Math.pow(xrayDensity(e), XRAY_DENSITY_POW)).toFixed(XRAY_MU_DECIMALS))).join(', ')});`;

// View ids (src/views.js) as GLSL names: VIEW_REALISTIC, VIEW_HEAT, ...
const viewIdsGLSL = () => VIEWS.map((v) => `#define VIEW_${v.key.toUpperCase()} ${v.id}`).join('\n');

// DDA steps the realistic march gets beyond g.maxSteps: each refraction
// restarts the ray, so its path can be longer than one crossing of the box.
const BEND_EXTRA_STEPS = 128;

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
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t0 + DDA_START_NUDGE))), ivec3(0), GRID - 1);
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
      if (tHit < 0.0 && trans < DATA_DEPTH_TRANS) tHit = tB0;
      if (trans < RAY_MIN_TRANS) break;
      continue;
    }
    float tExit = min(tMax.x, min(tMax.y, tMax.z));
    float seg = tExit - tEnter;
    vec4 a = fetchA(cell);
    int id = eid(a);
    vec3 n = vec3(0.0);
    n[ax] = -float(istp[ax]);
    vec3 hp = ro + rd * tEnter;
${flush}
${body}
    if (tHit < 0.0 && trans < DATA_DEPTH_TRANS) tHit = tEnter;
    if (trans < RAY_MIN_TRANS) break;
    prevId = id;
    ax = argmin3(tMax);
    tEnter = tExit;
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
${flush}
  if (trans >= RAY_MIN_TRANS && cell.y < 0 && rd.y < 0.0) {
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
${surfaceGLSL}
${liquidGLSL}
${mediaGLSL}
uniform vec3 uCam;
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
${viewIdsGLSL()}

// A ray stops once its transmittance is below this: nothing behind can show.
#define RAY_MIN_TRANS 0.01

// A gas cell as a soft ball: density from the ray's closest approach to the
// cell centre (cells), BLOB_PEAK within BLOB_R_IN, fading to 0 at BLOB_R_OUT.
#define BLOB_R_IN 0.1
#define BLOB_R_OUT 0.95
#define BLOB_PEAK 1.8
float softBlob(ivec3 cell, vec3 ro, vec3 rd, float t0, float t1) {
  vec3 cc = vec3(cell) + 0.5;
  float tm = clamp(dot(cc - ro, rd), t0, t1);
  return smoothstep(BLOB_R_OUT, BLOB_R_IN, length(ro + rd * tm - cc)) * BLOB_PEAK;
}

// ACES filmic curve, Narkowicz's fit: (x(Ax + B)) / (x(Cx + D) + E).
#define ACES_A 2.51
#define ACES_B 0.03
#define ACES_C 2.43
#define ACES_D 0.59
#define ACES_E 0.14
vec3 aces(vec3 x) {
  return clamp((x * (ACES_A * x + ACES_B)) / (x * (ACES_C * x + ACES_D) + ACES_E), 0.0, 1.0);
}

// =====================================================================
// Data views: heat (1), pressure (2), flow (3), X-ray (4).
// False-colour renderings with soft "clay" lighting (sun direction, sky fill,
// corner AO) and no shadows. Colours stay in linear RGB and are written
// without the filmic curve, so a fully lit surface shows exactly its legend
// colour. They share the DDA from march() in render.js.
// =====================================================================

float gPix;   // angular size of a pixel (radians), for anti-aliasing thin strokes

// Depth goes where the ray's transmittance first drops below this.
#define DATA_DEPTH_TRANS 0.5
// Colour maps are interpolated in sRGB, approximated here by a pure power.
#define DATA_GAMMA 2.2
vec3 toLinear(vec3 c) { return pow(c, vec3(DATA_GAMMA)); }
vec3 toSrgb(vec3 c) { return pow(c, vec3(1.0 / DATA_GAMMA)); }
float luma(vec3 c) { return dot(c, LUMA_W); }   // Rec. 709 weights (gfx/surface.js)

${colormapGLSL('heat', COLORMAPS.heat)}
${colormapGLSL('pressure', COLORMAPS.pressure)}
${colormapGLSL('flowDir', COLORMAPS.flowDir)}
${colormapGLSL('flowSpeed', COLORMAPS.flowSpeed)}
${xrayMu()}

// Bricks carry flags (see brickFrag) saying what the data views would draw in
// their air: 1 = warmer/colder than ambient, 2 = pressure, 4 = moving.
int brickFlags(float occ) {
  // the gas count and the bits are whole multiples of 1/BRICK_GAS_DIV: only the flags are left
  if (occ > 0.5) return int(fract((occ - 1.0) * BRICK_GAS_DIV) * (BRICK_FLAG_DIV / BRICK_GAS_DIV) + 0.5);
  return occ < -0.5 ? int((-occ - 1.0) * BRICK_AIR_DIV + 0.5) : 0;
}

// Clay lighting: ambient, plus sun by n·l, plus sky by how much the face
// looks up, darkened by corner AO down to CLAY_AO_MIN.
#define CLAY_AMBIENT 0.45
#define CLAY_SUN 0.41
#define CLAY_SKY 0.21
#define CLAY_AO_MIN 0.6
#define CLAY_AO_GAIN 0.4   // 1 - CLAY_AO_MIN
float clay(ivec3 cell, vec3 hp, vec3 n) {
  float ndl = max(dot(n, uSun), 0.0);
  float ao = faceAO(cell, ivec3(n), hp);
  return (CLAY_AMBIENT + CLAY_SUN * ndl + CLAY_SKY * (0.5 + 0.5 * n.y)) * (CLAY_AO_MIN + CLAY_AO_GAIN * ao);
}

// The floor: colour lo with grid lines of colour hi, darkened by corner AO.
#define DATA_FLOOR_GRID 8.0     // grid line spacing, cells
#define DATA_FLOOR_AO_MIN 0.5   // floor brightness where fully occluded
vec3 dataFloor(vec3 hp, vec3 lo, vec3 hi) {
  vec2 q = hp.xz / DATA_FLOOR_GRID;
  vec2 gq = abs(fract(q - 0.5) - 0.5) / max(fwidth(q) * uPixScale, vec2(1e-4));
  float line = 1.0 - min(min(gq.x, gq.y), 1.0);
  float ao = faceAO(ivec3(floor(hp.x), -1, floor(hp.z)), ivec3(0, 1, 0), hp);
  return mix(lo, hi, line) * (DATA_FLOOR_AO_MIN + (1.0 - DATA_FLOOR_AO_MIN) * ao);
}

// Neutral stand-in for a material: its own lightness, no hue.
#define NEUTRAL_BASE 0.05   // grey of a black material ...
#define NEUTRAL_GAIN 0.2    // ... plus this times sqrt(luma)
vec3 neutral(int id) { return vec3(NEUTRAL_BASE + NEUTRAL_GAIN * sqrt(luma(COLOR[id]))); }

// Gas in the heat and flow views: blob density times a base plus a share for
// how much of the brick is gas (brickGas), so a cloud's core reads denser.
#define GAS_VIEW_DENS 0.4
#define GAS_VIEW_DENS_LOCAL 2.0

// ---- heat ----
// Air glows faintly where it is warmer or colder than the room: from
// HEAT_AIR_MIN_DT off ambient, reaching full strength HEAT_AIR_OCTAVES
// doublings of that further out.
#define HEAT_AIR_MIN_DT 3.0    // °C
#define HEAT_AIR_OCTAVES 8.0
#define HEAT_AIR_EMIT 0.045    // emission per cell at full strength
#define HEAT_AIR_ABSORB 0.5    // absorption per unit of emission
void heatAir(float T, float ds, inout vec3 col, inout float trans) {
  float d = abs(T - AMBIENT);
  if (d <= HEAT_AIR_MIN_DT) return;
  float s = clamp(log2(d * (1.0 / HEAT_AIR_MIN_DT)) * (1.0 / HEAT_AIR_OCTAVES), 0.0, 1.0);   // 3 °C -> 0, 770 °C -> 1
  float e = HEAT_AIR_EMIT * s * s * ds;
  col += trans * heatColor(T) * e;
  trans *= exp(-HEAT_AIR_ABSORB * e);
}
#define HEAT_FIRE_K 0.6       // extinction per cell per unit blob density: fire ...
#define HEAT_GAS_K 0.3        // ... and the other gases
#define HEAT_GLASS_K 0.5      // extinction per cell of glass
#define HEAT_GLASS_GAIN 0.85  // brightness of its colour
#define HEAT_CLAY 0.7         // share of solids' colour that is clay-lit (the rest unlit)
#define HEAT_FLOOR_LO 0.3     // floor: ambient's colour times this ...
#define HEAT_FLOOR_HI 0.6     // ... and this on the grid lines
#define HEAT_AIR_SAMPLES 7    // most samples along an air-only brick (one per cell)

${march('marchHeat', AIR_FLAGS.HOT, /* glsl */ `
    if (id != E_EMPTY) {
      float T = a.y;
      if (KIND[id] == K_GAS) {
        // steam, smoke and flames: soft blobs coloured by their temperature
        float local = brickGas(occ);
        float dens = softBlob(cell, ro, rd, tEnter, tExit) * (GAS_VIEW_DENS + GAS_VIEW_DENS_LOCAL * local)
                   * (id == E_SMOKE ? clamp(a.z, 0.0, 1.0) : 1.0);
        float al = 1.0 - exp(-(id == E_FIRE ? HEAT_FIRE_K : HEAT_GAS_K) * seg * dens);
        col += trans * al * heatColor(T);
        trans *= 1.0 - al;
      } else if (id == E_GLASS) {
        // glass is opaque to a real thermal camera, but here a container
        // shouldn't hide what's inside: a thin pane showing its temperature
        float al = 1.0 - exp(-HEAT_GLASS_K * seg);
        col += trans * al * heatColor(T) * HEAT_GLASS_GAIN;
        trans *= 1.0 - al;
      } else {${solidHit('heatColor(T) * mix(1.0, clay(cell, hp, n), HEAT_CLAY)')}
      }
    } else {
      heatAir(a.y, seg, col, trans);
    }`, 'dataFloor(hp, heatColor(AMBIENT) * HEAT_FLOOR_LO, heatColor(AMBIENT) * HEAT_FLOOR_HI)', {
  airBrick: /* glsl */ `
      int ns = clamp(int(ceil(tB1 - tB0)), 1, HEAT_AIR_SAMPLES);
      float ds = (tB1 - tB0) / float(ns);
      for (int j = 0; j < HEAT_AIR_SAMPLES; j++) {
        if (j >= ns) break;
        vec3 p = ro + rd * (tB0 + (float(j) + 0.5) * ds);
        heatAir(fetchA(clamp(ivec3(floor(p)), ivec3(0), GRID - 1)).y, ds, col, trans);
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
    s += fetchB(clamp(i0 + o, ivec3(0), GRID - 1)).w * w.x * w.y * w.z;
  }
  return s;
}

// The pressure field as a cloud, denser the stronger it is. Strength s is the
// legend's distance from ambient (its middle), 0..1.
#define PRESSURE_CLOUD_MIN 0.15   // s below which air stays clear
#define PRESSURE_CLOUD_K 0.3      // extinction per cell at s = 1
void pressureCloud(float P, float ds, inout vec3 col, inout float trans) {
  float s = abs(pressurePos(P) - 0.5) * 2.0;   // 0 ambient, .25 at |P|=0.1, .5 at 1, 1 at 100
  if (s <= PRESSURE_CLOUD_MIN) return;
  float al = 1.0 - exp(-PRESSURE_CLOUD_K * s * s * sqrt(s) * ds);
  col += trans * al * pressureColor(P);
  trans *= 1.0 - al;
}
#define PRESSURE_GAS_K 0.06        // gas wisps: extinction per cell per unit blob density
#define PRESSURE_GAS_GREY vec3(0.12)
#define PRESSURE_GLASS_K 0.18      // extinction per cell: glass ...
#define PRESSURE_LIQUID_K 0.06     // ... liquids and ice
#define PRESSURE_CLEAR_GAIN 0.8    // brightness of their grey
#define PRESSURE_PAINT_LO 0.2      // strength where pressure paint starts to show ...
#define PRESSURE_PAINT_HI 0.6      // ... and has taken over
#define PRESSURE_FLOOR_LO vec3(0.012)
#define PRESSURE_FLOOR_HI vec3(0.03)
#define PRESSURE_AIR_RATE 0.8      // cloud samples per cell along an air-only brick ...
#define PRESSURE_AIR_SAMPLES 6     // ... and at most this many

${march('marchPressure', AIR_FLAGS.PRESSURE, /* glsl */ `
    int k = KIND[id];
    if (airOn && k != K_SOLID) pressureCloud(pressureAt(ro + rd * (tEnter + 0.5 * seg)), seg, col, trans);
    if (id != E_EMPTY) {
      if (k == K_GAS) {
        // smoke/steam/fire stay visible as faint grey wisps
        float al = 1.0 - exp(-PRESSURE_GAS_K * seg * softBlob(cell, ro, rd, tEnter, tExit));
        col += trans * al * PRESSURE_GAS_GREY;
        trans *= 1.0 - al;
      } else if (RCLASS[id] == R_LIQUID || RCLASS[id] == R_GLASS) {
        // liquids, glass and ice: translucent grey, so pressure inside shows
        // (a thin pane seen edge-on is longer along the ray, so it outlines itself)
        float al = 1.0 - exp(-(id == E_GLASS ? PRESSURE_GLASS_K : PRESSURE_LIQUID_K) * seg);
        col += trans * al * neutral(id) * PRESSURE_CLEAR_GAIN;
        trans *= 1.0 - al;
      } else {
        // pressure-sensitive paint: the face takes the colour of the
        // pressure pushing on it from the cell in front
        ivec3 f = cell + ivec3(n);
        float Pf = outside(f) ? 0.0 : fetchB(f).w;
        float Pc = k == K_SOLID ? 0.0 : fetchB(cell).w;
        float Pm = abs(Pf) > abs(Pc) ? Pf : Pc;
        float sm = abs(pressurePos(Pm) - 0.5) * 2.0;
        vec3 c = mix(neutral(id), pressureColor(Pm), smoothstep(PRESSURE_PAINT_LO, PRESSURE_PAINT_HI, sm));${solidHit('c * clay(cell, hp, n)')}
      }
    }`, 'dataFloor(hp, PRESSURE_FLOOR_LO, PRESSURE_FLOOR_HI)', {
  airBrick: /* glsl */ `
      int ns = clamp(int(ceil((tB1 - tB0) * PRESSURE_AIR_RATE)), 1, PRESSURE_AIR_SAMPLES);
      float ds = (tB1 - tB0) / float(ns);
      for (int j = 0; j < PRESSURE_AIR_SAMPLES; j++) {
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
#define FLOW_MIN_VEL 0.01   // velocity components below this (cells/step) don't move it
vec3 mobileVel(ivec3 c, int id, vec3 v) {
  if (KIND[id] == K_LIQUID && c.y > 0 && eid(fetchA(c - ivec3(0, 1, 0))) == id) v.xz = vec2(0.0);
  vec3 r = vec3(0.0);
  for (int k = 0; k < 3; k++) {
    if (abs(v[k]) < FLOW_MIN_VEL) continue;
    ivec3 q = c;
    q[k] += v[k] > 0.0 ? 1 : -1;
    int nb = outside(q) ? E_WALL : eid(fetchA(q));
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
#define FLOW_MIN_SPEED 0.06        // air slower than this (cells/step) draws nothing ...
#define FLOW_FULL_SPEED 0.2        // ... and is fully faded in by this
#define FLOW_STROKE_LEN 0.5        // stroke half-length (cells) at the slowest ...
#define FLOW_STROKE_LEN_GAIN 0.9   // ... plus this at the top of the speed legend
#define FLOW_STROKE_RADIUS 0.09    // stroke radius, cells ...
#define FLOW_STROKE_RADIUS_PX 0.8  // ... widened to at least this many pixels (and fainter for it)
#define FLOW_STROKE_EDGE_OUT 1.6   // coverage fades from 0 at this many radii ...
#define FLOW_STROKE_EDGE_IN 0.4    // ... to full at this many
#define FLOW_STROKE_TAIL 0.2       // brightness at the tail ...
#define FLOW_STROKE_HEAD_GAIN 0.8  // ... plus this at the head
float brickStroke(ivec3 bc, vec3 ro, vec3 rd, float ta, float tb, bool check, out vec3 v, out float gt) {
  uint hs = pcg(uint(bc.x) | uint(bc.y) << 10 | uint(bc.z) << 20);
  vec3 cc = vec3(bc * BS) + 0.5 * float(BS) + (vec3(uvec3(hs, hs >> 8, hs >> 16) & 255u) * (1.0 / 255.0) - 0.5);
  ivec3 c = ivec3(floor(cc));
  v = vec3(0.0);
  gt = ta;
  if (check && eid(fetchA(c)) != E_EMPTY) return 0.0;
  v = fetchB(c).xyz;
  float sp = length(v);
  if (sp < FLOW_MIN_SPEED) return 0.0;
  float w = flowSpeedPos(sp);
  float h = FLOW_STROKE_LEN + FLOW_STROKE_LEN_GAIN * w;   // half-length, cells
  vec3 d = v / sp, w0 = ro - cc;
  float b = dot(rd, d), dr = dot(rd, w0), dw = dot(d, w0);
  float sl = clamp((dw - b * dr) / max(1.0 - b * b, 1e-4), -h, h);
  gt = clamp(dot(cc + d * sl - ro, rd), ta, tb);
  float dist = length(ro + rd * gt - cc - d * sl);
  float r = max(FLOW_STROKE_RADIUS, gt * gPix * FLOW_STROKE_RADIUS_PX);
  return smoothstep(r * FLOW_STROKE_EDGE_OUT, r * FLOW_STROKE_EDGE_IN, dist) * min(1.0, FLOW_STROKE_RADIUS / r)
       * (FLOW_STROKE_TAIL + FLOW_STROKE_HEAD_GAIN * (sl / h * 0.5 + 0.5))
       * smoothstep(FLOW_MIN_SPEED, FLOW_FULL_SPEED, sp);
}
#define FLOW_STROKE_ALPHA 0.8      // a stroke's opacity at full coverage
#define FLOW_HAZE_K 0.006          // haze of moving air: emission per cell at full speed
#define FLOW_ABSORB 0.6            // haze and strokes absorb this per unit of emission
#define FLOW_GAS_K 0.25            // gas: extinction per cell per unit blob density
#define FLOW_GAS_STILL vec3(0.03)  // colour of still gas
#define FLOW_GLASS_K 0.18          // extinction per cell of glass
#define FLOW_GLASS_GREY vec3(0.05)
#define FLOW_STILL_SAT 0.35        // still matter keeps this much of its colour's saturation ...
#define FLOW_STILL_GAIN 0.35       // ... at this brightness
#define FLOW_FLOOR_LO vec3(0.01)
#define FLOW_FLOOR_HI vec3(0.028)

${march('marchFlow', AIR_FLAGS.FLOW, /* glsl */ `
    if (id == E_EMPTY) {
      // moving air: faint haze from the brick's sampled velocity
      if (hazeW > 0.0) {
        float al = hazeW * FLOW_HAZE_K * seg;
        col += trans * al * hazeCol;
        trans *= 1.0 - FLOW_ABSORB * al;
      }
    } else if (KIND[id] == K_GAS) {
      vec3 v = fetchB(cell).xyz;
      float local = brickGas(occ);
      float dens = softBlob(cell, ro, rd, tEnter, tExit) * (GAS_VIEW_DENS + GAS_VIEW_DENS_LOCAL * local)
                 * (id == E_SMOKE ? clamp(a.z, 0.0, 1.0) : 1.0);
      float al = 1.0 - exp(-FLOW_GAS_K * seg * dens);
      col += trans * al * flowTint(FLOW_GAS_STILL, v, flowSpeedPos(length(v)));
      trans *= 1.0 - al;
    } else if (id == E_GLASS) {
      float al = 1.0 - exp(-FLOW_GLASS_K * seg);
      col += trans * al * FLOW_GLASS_GREY;
      trans *= 1.0 - al;
    } else {
      vec3 v = mobileVel(cell, id, fetchB(cell).xyz);
      float w = flowSpeedPos(length(v));
      vec3 still = mix(vec3(luma(COLOR[id])), COLOR[id], FLOW_STILL_SAT) * FLOW_STILL_GAIN;${solidHit('flowTint(still, v, w) * clay(cell, hp, n)')}
    }`, 'dataFloor(hp, FLOW_FLOOR_LO, FLOW_FLOOR_HI)', {
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
        gAl = FLOW_STROKE_ALPHA * brickStroke(bc, ro, rd, tEnter, min(tb.x, min(tb.y, tb.z)), true, v, gT);
        float sp = length(v);
        hazeW = flowSpeedPos(sp) * smoothstep(FLOW_MIN_SPEED, FLOW_FULL_SPEED, sp);
        hazeCol = flowTint(vec3(0.0), v, 1.0);
      }`,
  flush: /* glsl */ `
    if (gAl > 0.0 && tEnter >= gT) {
      col += trans * gAl * hazeCol;
      trans *= 1.0 - FLOW_ABSORB * gAl;
      gAl = 0.0;
    }`,
  airBrick: /* glsl */ `
      vec3 v;
      float gt;
      float cov = brickStroke(bc, ro, rd, tB0, tB1, false, v, gt);
      float sp = length(v);
      if (sp > FLOW_MIN_SPEED) {
        float al = flowSpeedPos(sp) * smoothstep(FLOW_MIN_SPEED, FLOW_FULL_SPEED, sp) * FLOW_HAZE_K * (tB1 - tB0) + FLOW_STROKE_ALPHA * cov;
        col += trans * al * flowTint(vec3(0.0), v, 1.0);
        trans *= 1.0 - FLOW_ABSORB * al;
      }`,
})}

// ---- X-ray ----
// Element colour lifted toward a common lightness so dark materials still show.
#define XRAY_LIGHTNESS 0.4     // the common lightness ...
#define XRAY_LIFT 0.6          // ... and how far toward it
vec3 xrayColor(int id) {
  vec3 c = COLOR[id];
  float L = luma(c);
  return c * (mix(L, XRAY_LIGHTNESS, XRAY_LIFT) / max(L, 1e-3));
}
#define XRAY_DEPTH_CUE 0.004   // brightness 1 / (1 + this × cells of depth)
#define XRAY_SHEET_INNER 0.2   // boundary sheet strength between two materials ...
#define XRAY_SHEET_FACING 0.5  // ... times this when face-on (1 edge-on) ...
#define XRAY_SHEET_OUTER 0.05  // ... and at an outer surface
#define XRAY_SHEET_MU 16.0     // sheets scale with the material's XRAY_MU times this ...
#define XRAY_SHEET_MIN 0.2     // ... clamped to [this, 1]
#define XRAY_SHEET_GAIN 1.6    // sheet brightness
#define XRAY_SHEET_ABSORB 0.5  // sheet absorption per unit strength
#define XRAY_EMIT_GAIN 1.15    // emission relative to absorption
#define XRAY_FLOOR_LO vec3(0.006)
#define XRAY_FLOOR_HI vec3(0.022)
#define XRAY_SOFT_CLIP 1.25    // exposure k of the final soft clip 1 - exp(-k c)

${march('marchXray', 0, /* glsl */ `
    // nearer things a little brighter, so depth reads without lighting
    float cue = 1.0 / (1.0 + XRAY_DEPTH_CUE * (tEnter - t0));
    if (id != prevId) {
      // A boundary shows as a thin sheet. Borders between two materials (the
      // structure inside piles and containers) are emphasised; outer surfaces
      // stay faint, since a thin shell seen edge-on already outlines itself
      // (and a grazing ray crosses a voxel wall's faces many times).
      bool inner = id != E_EMPTY && prevId != E_EMPTY;
      int m = id != E_EMPTY ? id : prevId;
      float sheet = inner ? XRAY_SHEET_INNER * (XRAY_SHEET_FACING + (1.0 - XRAY_SHEET_FACING) * (1.0 - abs(dot(n, rd)))) : XRAY_SHEET_OUTER;
      sheet *= clamp(XRAY_MU[m] * XRAY_SHEET_MU, XRAY_SHEET_MIN, 1.0);
      col += trans * sheet * xrayColor(m) * XRAY_SHEET_GAIN * cue;
      trans *= 1.0 - XRAY_SHEET_ABSORB * sheet;
    }
    if (id != E_EMPTY) {
      // emission a little above absorption, so overlaps add up like a radiograph
      float al = 1.0 - exp(-XRAY_MU[id] * seg);
      col += trans * al * xrayColor(id) * XRAY_EMIT_GAIN * cue;
      trans *= 1.0 - al;
    }`, 'dataFloor(hp, XRAY_FLOOR_LO, XRAY_FLOOR_HI)')}

#define DATA_MIN_ALPHA 0.002   // pixels covered less than this are left empty
${plainGLSL(g)}

void dataView(vec3 ro, vec3 rd, float t0, vec3 bh) {
  vec3 col = vec3(0.0);
  float trans = 1.0, tHit = -1.0;
  int ax = int(bh.z);
  if (CUR_VIEW == VIEW_HEAT) marchHeat(ro, rd, t0, ax, col, trans, tHit);
  else if (CUR_VIEW == VIEW_PRESSURE) marchPressure(ro, rd, t0, ax, col, trans, tHit);
  else if (CUR_VIEW == VIEW_FLOW) marchFlow(ro, rd, t0, ax, col, trans, tHit);
  else marchXray(ro, rd, t0, ax, col, trans, tHit);
  float alpha = 1.0 - trans;
  if (alpha < DATA_MIN_ALPHA) discard;
  vec3 c = col / alpha;
  if (CUR_VIEW == VIEW_XRAY) c = 1.0 - exp(-XRAY_SOFT_CLIP * c);  // X-ray: soft clip, overlaps add up
  // linear; post (raw mode for data views) only encodes to sRGB, so a fully
  // lit surface still shows exactly its legend colour
  gl_FragColor = vec4(clamp(c, 0.0, 1.0) * alpha, alpha);
  // depth: where the ray became mostly opaque, else where it leaves the box
  float td = tHit >= 0.0 ? tHit : bh.y;
  vec4 clip = projectionMatrix * viewMatrix * modelMatrix * vec4(ro + rd * td, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
}

#define EV_NONE 0
#define EV_OPAQUE 1
#define EV_ENTER 2
#define EV_EXIT 3
#define MAX_BENDS 6
// Inside a liquid, sunlight fades with depth: the sun's visibility is read
// where the ray got in (shadow map) and then attenuated by the liquid between
// that height and the point, along the sun's slant (sun elevation floored at
// this sine, so a low sun doesn't black out everything).
#define LIQ_SUN_Y_MIN 0.2
// Where liquids of different kinds share a brick (ice in water, acid mixing
// in), which one a segment is in is read at a per-pixel random offset of up to
// half this many cells, so their boundary is dithered across a cell, which
// TAA blends, instead of showing voxel steps inside the smooth surface.
#define LIQ_ID_DITHER 1.0
// Leaving liquid, an opaque surface this close (cells) past the exit wins:
// sand under the water line is at both, and must not show a sliver of air.
#define OPAQUE_TIE 0.05
// Glass reflects less from inside liquid than from air (the index contrast is
// smaller); share of its Fresnel reflectance kept there.
#define GLASS_IN_LIQUID_F 0.3

void main() {
  vec3 ro = uCam;
  vec3 rd = safeDir(normalize(vGrid - uCam));
  if (CUR_VIEW == VIEW_FLOW) gPix = length(fwidth(rd)) * uPixScale;
  surfView(uCam, rd);   // pixel footprint for material LOD (needs uniform control flow)
  vec3 bh = boxHit(ro, rd);
  float t0 = max(bh.x, 0.0);
  if (bh.y <= t0) discard;
  if (CUR_VIEW == VIEW_PLAIN) { plainView(ro, rd, t0, bh); return; }
  if (CUR_VIEW != VIEW_REALISTIC) { dataView(ro, rd, t0, bh); return; }
  float jit = ign(gl_FragCoord.xy, float(uFrame));
  float mNext = jit * MEDIA_STEP;   // next media sample along the ray (gfx/media.js)
  float mOp = 0.0;                  // opacity of the media so far
  // hot air bends light (heat shimmer): perturb the ray once, up front
  rd = safeDir(hazeBend(uCam, rd, t0, bh.y));

  // ray (ro, rd) and its DDA state; refraction restarts both
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t0 + DDA_START_NUDGE))), ivec3(0), GRID - 1);
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = t0;
  int ax = int(bh.z);

  vec3 col = vec3(0.0), trans = vec3(1.0);
  bool anyHit = false;
  vec3 hitPos = vec3(0.0);
  int liq = E_EMPTY;          // smooth liquid the ray is inside (E_EMPTY = air)
  int prevCrisp = E_EMPTY;    // crisp transparent cell the ray just came through
  vec3 mediumLight = vec3(1.0);
  // sun visibility inside liquid: read at a reference point (where the ray
  // got in), then faded with depth below it
  vec3 lightRef = vec3(1.0);
  float lightY = 0.0;
  vec3 liqDither = (hash33(vec3(gl_FragCoord.xy, float(uFrame))) - 0.5) * LIQ_ID_DITHER;
  int bends = 0;
  bool stop = false;

  ivec3 lastB = ivec3(-1);
  int flags = 0;
  vec4 phiA = surfSample(ro + rd * tEnter);   // fields at the current segment start
  bool phiStale = false;

  // Entering the box inside a smooth material: the box wall cuts it open.
  {
    int ch = -1;
    float best = SURF_ISO;
    for (int c = 0; c < 4; c++) if (phiA[c] >= best) { best = phiA[c]; ch = c; }
    if (ch >= 0) {
      vec3 n0 = vec3(0.0);
      n0[ax] = -float(istp[ax]);
      vec3 hp = ro + rd * tEnter;
      anyHit = true; hitPos = hp;
      if (ch != CH_LIQUID) {
        col = shadeSurf(gatherSurf(hp, n0, ch), rd);
        trans = vec3(0.0);
        stop = true;
      } else {
        int lid = liquidIdAt(hp - n0 * IFACE_PROBE, E_WATER);
        if (liquidInterface(hp, n0, true, lid, false, ro, rd, col, trans, mediumLight)) liq = lid;
        lightRef = uShadows ? sunShadow(hp - n0 * IFACE_PROBE) : vec3(1.0);   // inside: the map carries the liquid above
        lightY = hp.y;
        rd = safeDir(rd); istp = ivec3(sign(rd)); tDelta = abs(1.0 / rd);
        cell = ivec3(floor(ro)); tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
        tEnter = 0.0; phiA = surfSample(ro);
      }
    }
  }

  for (int i = 0; i < ${g.maxSteps + BEND_EXTRA_STEPS}; i++) {
    if (stop || outside(cell)) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; flags = brickInfo(bc); gThin = brickThin(flags); }
    if (flags == 0) {
      ax = skipEmpty(bc, ro, rd, istp, cell, tMax, tEnter);
      prevCrisp = E_EMPTY;
      phiStale = true;
      continue;
    }
    float tExit = min(tMax.x, min(tMax.y, tMax.z));
    vec4 a = fetchA(cell);
    int id = eid(a);

    if (isCrisp(id)) {
      // ---- crisp voxel ----
      vec3 nFace = vec3(0.0);
      nFace[ax] = -float(istp[ax]);
      if (RCLASS[id] != R_GLASS) {
        // the voxel's shape may be smaller than the cell (bevels): it can miss
        float th = tEnter;
        vec3 nh = nFace;
        if (crispHit(cell, id, ro, rd, tEnter, tExit, th, nh)) {
          vec3 hp = ro + rd * th;
          if (!anyHit) { anyHit = true; hitPos = hp; }
          col += trans * shadeSurf(crispSurf(cell, id, a, hp, nh), rd);
          trans = vec3(0.0);
          break;
        }
        phiStale = true;
      } else {
      vec3 hp = ro + rd * tEnter;
      if (!anyHit) { anyHit = true; hitPos = hp; }
      if (id != prevCrisp) {
        // glass interface (flat faces: no bending)
        float F = fresnelSchlick(abs(dot(nFace, rd)), IOR[id]) * (liq == E_EMPTY ? 1.0 : GLASS_IN_LIQUID_F);
        mediumLight = uShadows ? sunShadow(hp + nFace * IFACE_PROBE) : vec3(1.0);
        col += trans * F * envReflect(hp, reflect(rd, nFace), mediumLight);
        trans *= 1.0 - F;
      }
      absorbSegment(id, hp, tExit - tEnter, mediumLight, a.y, col, trans);
      prevCrisp = id;
      phiStale = true;
      }
    } else {
      prevCrisp = E_EMPTY;
      // ---- smooth surfaces crossing this segment ----
      int ev = EV_NONE, evCh = -1;
      float tEv = tExit;
      vec3 evN = vec3(0.0);   // forced normal (else from the field)
      vec4 phiB = vec4(0.0);
      if (brickSurf(flags)) {
        if (phiStale) {
          phiA = surfSample(ro + rd * tEnter);
          // Already inside a smooth material at the start of this segment: we
          // came through glass (a tank of water), or the crossing was missed.
          if (liq == E_EMPTY) {
            int ic = -1;
            float best = SURF_ISO;
            for (int c = 0; c < 4; c++) if (phiA[c] >= best) { best = phiA[c]; ic = c; }
            if (ic == CH_LIQUID) {
              liq = liquidIdAt(ro + rd * (tEnter + IFACE_PROBE), E_WATER);
              vec3 p0 = ro + rd * tEnter;
              lightRef = uShadows ? sunShadow(p0) : vec3(1.0);   // inside: the map carries the liquid above
              lightY = p0.y;
            }
            else if (ic >= 0) { ev = EV_OPAQUE; evCh = ic; tEv = tEnter; evN = vec3(0.0); evN[ax] = -float(istp[ax]); }
          }
        }
        phiB = surfSample(ro + rd * tExit);
        // smooth matter in this cell may be a lone droplet or grain
        float tM = tExit;
        vec4 phiM = phiB;
        if (SURFCH[id] >= 0) {
          tM = tClosest(cell, ro, rd, tEnter, tExit);
          phiM = surfSample(ro + rd * tM);
        }
        if (ev != EV_NONE) {
          // handled below
        } else if (liq == E_EMPTY) {
          for (int c = 0; c < 4; c++) {
            float t = surfCross(ro, rd, c, true, tEnter, tM, tExit, phiA[c], phiM[c], phiB[c]);
            if (t < tEv) { tEv = t; evCh = c; ev = c == CH_LIQUID ? EV_ENTER : EV_OPAQUE; }
          }
        } else {
          float tx = surfCross(ro, rd, CH_LIQUID, false, tEnter, tM, tExit, phiA.x, phiM.x, phiB.x);
          if (tx < tEv) {
            tEv = tx; evCh = CH_LIQUID; ev = EV_EXIT;
          } else if (max(phiA.x, max(phiM.x, phiB.x)) < SURF_ISO) {
            liq = E_EMPTY;   // lost the surface (grazing ray): quietly back in air
          }
          for (int c = 1; c < 4; c++) {
            float t = surfCross(ro, rd, c, true, tEnter, tM, tExit, phiA[c], phiM[c], phiB[c]);
            if (t <= tEv + OPAQUE_TIE) { tEv = min(t, tEv); evCh = c; ev = EV_OPAQUE; }
          }
        }
        phiStale = false;
      } else {
        phiStale = true;
      }

      // ---- what lies along [tEnter, tEv] ----
      if (liq != E_EMPTY) {
        vec3 pm = ro + rd * (0.5 * (tEnter + tEv));
        int lj = id;
        if (brickMixed(flags)) {
          ivec3 cj = clamp(ivec3(floor(pm + liqDither)), ivec3(0), GRID - 1);
          if (cj != cell) lj = eid(fetchA(cj));
        }
        if (SURFCH[lj] == CH_LIQUID) liq = lj;
        else if (SURFCH[id] == CH_LIQUID) liq = id;
        mediumLight = lightRef * exp(-SIGMA[liq] * max(lightY - pm.y, 0.0) / max(uSun.y, LIQ_SUN_Y_MIN));
        absorbSegment(liq, ro + rd * tEnter, tEv - tEnter, mediumLight, SURFCH[id] == CH_LIQUID ? a.y : AMBIENT, col, trans);
      } else if (brickMedia(flags)) {
        float al = mediaSegment(ro, rd, tEnter, tEv, mNext, col, trans);
        // until something is hit, hitPos tracks the first gas, and the gas
        // that has become mostly opaque counts as a hit
        if (!anyHit && al > 0.0 && mOp == 0.0) hitPos = ro + rd * tEnter;
        mOp = 1.0 - (1.0 - mOp) * (1.0 - al);
        if (!anyHit && mOp > MEDIA_DEPTH_ALPHA) anyHit = true;
      }

      // ---- the event ----
      if (ev != EV_NONE) {
        vec3 hp = ro + rd * tEv;
        if (!anyHit) { anyHit = true; hitPos = hp; }
        if (ev == EV_OPAQUE) {
          vec3 n = dot(evN, evN) > 0.0 ? evN : surfNormal(hp, evCh, -rd);
          col += trans * shadeSurf(gatherSurf(hp, n, evCh), rd);
          trans = vec3(0.0);
          break;
        } else {
          // liquid surface: refract in or out
          vec3 n = liquidRipple(hp, surfNormal(hp, CH_LIQUID, ev == EV_ENTER ? -rd : rd));
          int lid = ev == EV_ENTER ? liquidIdAt(hp - n * IFACE_PROBE, E_WATER) : liq;
          if (bends < MAX_BENDS) {
            bends++;
            // the scene shows in the reflection only off the first surface the eye ray meets
            bool inside = liquidInterface(hp, n, ev == EV_ENTER, lid, bends == 1, ro, rd, col, trans, mediumLight);
            liq = inside ? lid : E_EMPTY;
            if (ev == EV_ENTER) { lightRef = mediumLight; lightY = hp.y; }
            rd = safeDir(rd); istp = ivec3(sign(rd)); tDelta = abs(1.0 / rd);
            cell = ivec3(floor(ro)); tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
            tEnter = 0.0; lastB = ivec3(-1); ax = 1;
            gThin = brickThin(brickInfo(clamp(cell, ivec3(0), GRID - 1) / BS));
            phiA = surfSample(ro); phiStale = false;
            // restarted inside something opaque (sand under the water line)
            int oc = -1;
            for (int c = 1; c < 4; c++) if (phiA[c] >= SURF_ISO) oc = c;
            if (oc > 0) {
              col += trans * shadeSurf(gatherSurf(ro, surfNormal(ro, oc, -rd), oc), rd);
              trans = vec3(0.0);
              break;
            }
            continue;
          }
          // out of bends: switch medium, keep straight
          liq = ev == EV_ENTER ? lid : E_EMPTY;
          if (ev == EV_ENTER) { lightRef = uShadows ? sunShadow(hp + n * IFACE_PROBE) : vec3(1.0); lightY = hp.y; }
        }
      }
      phiA = phiB;
    }

    if (max(trans.x, max(trans.y, trans.z)) < RAY_MIN_TRANS) break;
    ax = argmin3(tMax);
    tEnter = tExit;
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }

  // floor of the box
  if (max(trans.x, max(trans.y, trans.z)) >= RAY_MIN_TRANS && cell.y < 0 && rd.y < 0.0) {
    float tf = -ro.y / rd.y;
    vec3 hp = ro + rd * tf;
    if (!anyHit) { anyHit = true; hitPos = hp; }
    col += trans * shadeFloor(hp, rd);
    trans = vec3(0.0);
  }

  // only thin gas: keep it (and its glow), at its depth
  if (!anyHit && (mOp > MEDIA_KEEP_ALPHA || dot(col, vec3(1.0)) > MEDIA_KEEP_RADIANCE)) anyHit = true;
  if (!anyHit) discard;
  float alpha = 1.0 - dot(trans, vec3(1.0 / 3.0));
  // linear HDR radiance, premultiplied; tone mapping happens in post (src/gfx/post.js)
  gl_FragColor = vec4(col * (alpha > 0.0 ? 1.0 : 0.0), alpha);

  vec4 clip = projectionMatrix * viewMatrix * modelMatrix * vec4(hitPos, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
}
`;
};

// Picking: march a single ray (the mouse ray) and report the first
// non-gas voxel it hits. Pixel 0 = (cell xyz, face), pixel 1 = (id, T, P, life).
export const pickFrag = (g) => /* glsl */ `
${lib(g)}
// Face codes are axis * 2 + (1 if the ray steps +axis); the face's normal is
// minus that step. The floor is hit stepping down y.
#define PICK_FACE_FLOOR 2
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
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t0 + DDA_START_NUDGE))), ivec3(0), GRID - 1);
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = t0;
  int ax = int(bh.z);
  ivec3 lastB = ivec3(-1);
  int flags = 0;

  for (int i = 0; i < ${g.maxSteps}; i++) {
    if (outside(cell)) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; flags = brickInfo(bc); }
    if (flags == 0) { ax = skipEmpty(bc, ro, rd, istp, cell, tMax, tEnter); continue; }
    vec4 a = fetchA(cell);
    int id = eid(a);
    if (id != E_EMPTY && KIND[id] != K_GAS) {
      int face = ax * 2 + (istp[ax] > 0 ? 1 : 0); // normal = -step
      if (gl_FragCoord.x < 1.0) oC = vec4(vec3(cell), float(face));
      else oC = vec4(float(id), a.y, fetchB(cell).w, a.z);
      return;
    }
    ax = argmin3(tMax);
    tEnter = min(tMax.x, min(tMax.y, tMax.z));
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  if (cell.y < 0 && rd.y < 0.0) {
    // floor hit
    if (gl_FragCoord.x < 1.0) oC = vec4(float(cell.x), -1.0, float(cell.z), float(PICK_FACE_FLOOR));
    else oC = vec4(-1.0, AMBIENT, 0.0, 0.0);
    return;
  }
  oC = miss;
}
`;

// Shadow map pass: one ray per texel, marching from the sun toward the box.
// Opaque = crisp voxels and the smooth opaque surfaces (same root finding as
// the camera rays, so shadows line up with what is drawn). Liquids, glass and
// media add optical depth.
export const shadowFrag = (g) => /* glsl */ `
${lib(g)}
// Texel encoding, decoded by sunShadow (gfx/lighting.js, which defines
// SHADOW_TINT_ID_SCALE): w = tint element id * SHADOW_TINT_ID_SCALE + optical
// depth (capped below it).
#define SHADOW_TAU_MAX (SHADOW_TINT_ID_SCALE - 1.0)
#define SHADOW_NO_HIT 1e5       // depth stored where nothing is hit: past any receiver
#define SHADOW_MEDIA_MIN_K 1e-4  // gas with less transport extinction (1/cell) casts nothing
out vec4 oC;
void main() {
  vec3 c, u, v; float R;
  sunBasis(c, R, u, v);
  vec2 st = gl_FragCoord.xy / float(uShadowRes) * 2.0 - 1.0;
  vec3 ro = c + uSun * R + (u * st.x + v * st.y) * R;
  vec3 rd = safeDir(-uSun);
  oC = vec4(SHADOW_NO_HIT, SHADOW_NO_HIT, SHADOW_NO_HIT, 0.0);
  vec3 bh = boxHit(ro, rd);
  float t = max(bh.x, 0.0);
  if (bh.y <= t) return;
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = clamp(ivec3(floor(ro + rd * (t + DDA_START_NUDGE))), ivec3(0), GRID - 1);
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = t;
  ivec3 lastB = ivec3(-1);
  int flags = 0;
  int tid = 0;
  int lid = E_WATER;
  float tau = 0.0;
  bool hit = false;
  vec4 phiA = surfSample(ro + rd * tEnter);
  bool phiStale = false;
  if (max(phiA.y, max(phiA.z, phiA.w)) >= SURF_ISO) { oC.x = tEnter; hit = true; }
  for (int i = 0; i < ${g.maxSteps}; i++) {
    if (hit || outside(cell)) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; flags = brickInfo(bc); gThin = brickThin(flags); }
    if (flags == 0) { skipEmpty(bc, ro, rd, istp, cell, tMax, tEnter); phiStale = true; continue; }
    int ax = argmin3(tMax);
    float tExit = tMax[ax];
    int id = eid(fetchA(cell));
    if (isCrisp(id)) {
      if (RCLASS[id] != R_GLASS) { oC.x = tEnter; hit = true; break; }
      if (tid == 0 || RCLASS[tid] == R_GAS) { if (tid == 0) oC.y = tEnter; tid = id; }
      tau += dot(SIGMA[id], vec3(1.0 / 3.0)) * (tExit - tEnter);
      oC.z = tExit;
      phiStale = true;
    } else if (brickSurf(flags) || brickMedia(flags)) {
      if (phiStale) phiA = surfSample(ro + rd * tEnter);
      vec4 phiB = surfSample(ro + rd * tExit);
      float tM = tExit;
      vec4 phiM = phiB;
      if (SURFCH[id] >= 0) { tM = tClosest(cell, ro, rd, tEnter, tExit); phiM = surfSample(ro + rd * tM); }
      float tOp = NO_HIT;
      for (int c = 1; c < 4; c++)
        tOp = min(tOp, surfCross(ro, rd, c, true, tEnter, tM, tExit, phiA[c], phiM[c], phiB[c]));
      float tEnd = min(tOp, tExit);
      // path length inside liquid: trapezoid over the three samples
      vec3 inL = step(SURF_ISO, vec3(phiA.x, phiM.x, phiB.x));
      float lenL = 0.5 * ((inL.x + inL.y) * (tM - tEnter) + (inL.y + inL.z) * (tExit - tM));
      if (lenL > 0.0) {
        if (SURFCH[id] == CH_LIQUID) lid = id;
        if (tid == 0 || RCLASS[tid] == R_GAS) { if (tid == 0) oC.y = tEnter; tid = lid; }
        tau += dot(SIGMA[lid], vec3(1.0 / 3.0)) * lenL * (tEnd - tEnter) / max(tExit - tEnter, 1e-6);
        oC.z = tEnd;
      }
      if (brickMedia(flags)) {
        // smoke and steam (gfx/media.js), with transport extinction: light
        // scattered forward still gets through, so gas casts soft shadows
        vec4 m = mediaField(ro + rd * (0.5 * (tEnter + tEnd)));
        vec2 dm = max(m.xy - MEDIA_FLOOR, 0.0) * (1.0 / (1.0 - MEDIA_FLOOR));
        float k = dot(MD_EXT.xy * (1.0 - MD_ALBEDO.xy * MD_G.xy), dm);
        if (k > SHADOW_MEDIA_MIN_K) {
          if (tid == 0) { oC.y = tEnter; tid = m.x > m.y ? E_SMOKE : E_STEAM; }
          tau += k * (tEnd - tEnter);
          oC.z = tEnd;
        }
      }
      if (tOp < NO_HIT) { oC.x = tOp; hit = true; break; }
      phiA = phiB;
      phiStale = false;
    } else {
      phiStale = true;
    }
    tEnter = tExit;
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  if (!hit && rd.y < 0.0) oC.x = ro.y / -rd.y; // floor
  oC.w = float(tid) * SHADOW_TINT_ID_SCALE + min(tau, SHADOW_TAU_MAX);
}
`;

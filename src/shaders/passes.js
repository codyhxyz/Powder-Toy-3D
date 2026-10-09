import { prelude, stateOutGLSL, copyThroughMain } from './common.js';
import { materialsGLSL } from '../gfx/materials.js';

// What a brick holding matter carries (brickFrag): a = 1 + gas/BRICK_GAS_DIV +
// 2·bits + air flags/BRICK_FLAG_DIV. Decoded by gfx/core.js (brickInfo & co.)
// and the data views' brickFlags (render.js). float32 holds the sum exactly
// while it stays under 2^8, which leaves room for one more bit.
const BRICK_BITS = { MEDIA: 1, SURF: 2, OPAQUE: 4, THIN: 8, MIXED: 16 };
// Air flags (bits): air worth showing in the heat, pressure and flow views.
export const AIR_FLAGS = { HOT: 1, PRESSURE: 2, FLOW: 4 };
export const brickGLSL = [
  ...Object.entries(BRICK_BITS).map(([k, v]) => `#define BRICK_${k} ${v}`),
  ...Object.entries(AIR_FLAGS).map(([k, v]) => `#define AIR_${k} ${v}`),
  '#define BRICK_GAS_DIV 64.0       // gas fraction = steam/smoke cells / cells per brick',
  '#define BRICK_FLAG_DIV 65536.0   // air flags (1..7) sit below the gas fraction\'s steps',
  '#define BRICK_AIR_DIV 8.0        // air-only bricks: a = -(1 + flags/BRICK_AIR_DIV)',
].join('\n');

// Brush: spawns elements / applies tools inside a sphere or cube.
export const paintFrag = (g) => /* glsl */ `
${prelude(g)}
uniform uint uFrame;
uniform vec3 uCenter;
uniform float uRadius;
uniform int uShape;     // 0 sphere, 1 cube
#define PAINT_RNG_SALT 0xb7u      // salt that gives the brush its own random stream (seed3)
#define BRUSH_EDGE_EPS 0.001      // keeps smoothstep's edges apart at radius 0
uniform int uTool;      // element id, or negative tool id
uniform float uRate;    // spawn density multiplier
uniform bool uReplace;
${stateOutGLSL}

void brush(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 d = vec3(p) + 0.5 - uCenter;
  float r = uShape == 0 ? length(d) : max(abs(d.x), max(abs(d.y), abs(d.z)));
  if (r > uRadius) return;
  float falloff = 1.0 - smoothstep(uRadius * TOOL_FALLOFF, uRadius + BRUSH_EDGE_EPS, r);

  uint rs = seed3(p, uFrame, PAINT_RNG_SALT);
  int id = eid(a);

  if (uTool >= 0) {
    if (id == uTool) return;
    if (id != E_EMPTY && !uReplace) return;
    if (rnd(rs) > SPAWNDENS[uTool] * uRate) return;
    float T = SPAWNT[uTool];
    float ctype = uTool == E_LAVA ? float(E_STONE) : 0.0;
    oA = vec4(float(uTool), T, SPAWNLIFE[uTool], ctype + rnd(rs) * SEED_MAX);
    float vy = KIND[uTool] == K_POWDER || KIND[uTool] == K_LIQUID ? SPAWN_DROP_V : 0.0;
    oB = vec4(0.0, vy, 0.0, b.w);
  } else if (uTool == T_ERASE) {
    oA = vec4(float(E_EMPTY), AMBIENT, 0.0, rnd(rs) * SEED_MAX);
    oB = vec4(0.0, 0.0, 0.0, b.w);
  } else if (uTool == T_HEAT) {
    oA.y = min(a.y + TOOL_HEAT * falloff, CELL_TEMP_MAX);
  } else if (uTool == T_COOL) {
    oA.y = max(a.y - TOOL_HEAT * falloff, CELL_TEMP_MIN);
  } else if (uTool == T_BLAST) {
    oB.w = b.w + TOOL_PRESSURE * falloff;
  }
}
${copyThroughMain('brush')}`;

// Copy a state (uploaded data textures, an undo snapshot) into a target.
// Padding texels copy too: cellFromFrag and atlas() round-trip them.
export const copyFrag = (g) => /* glsl */ `
${prelude(g)}
${stateOutGLSL}
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  writeState(fetchA(p), fetchB(p));
}
`;

// Brick pass: one texel per 4×4×4 brick. rgb = average emitted light (lava,
// fire, glowing-hot metal), later blurred into a coarse light volume.
// a also carries what each brick holds, and flags for what the data views draw
// in air (1 warmer/colder than ambient, 2 pressure, 4 moving):
//   0                          empty
//   1 + gas/64 + 2·bits + flags/65536
//                              holds matter (gas = steam/smoke cells), or a
//                              smooth surface / media field reaches into it.
//                              The render fields are already blurred, so a brick
//                              next to a surface or plume sees them in its own
//                              cells: the skip map is dilated for free. The
//                              flags sit below the 1/64 step. bits (BRICK_BITS):
//                              1 media, 2 smooth surface, 4 opaque matter (crisp
//                              or an opaque surface field), 8 thin liquid (the
//                              tracer reads it cubic), 16 more than one liquid.
//   -(1 + flags/8)             only air, but air a data view draws; the
//                              realistic view, picking and the shadow map
//                              skip it like an empty brick (they test a < 0.5)
export const brickFrag = (g) => /* glsl */ `
${prelude(g)}
${materialsGLSL()}
${brickGLSL}
uniform sampler2D tFS;
uniform sampler2D tFM;
uniform sampler2D tFT;   // thin-feature mask (x: liquid)
out vec4 oC;
// Air worth flagging for the data views: off ambient by more than AIR_FLAG_T °C,
// pressure beyond AIR_FLAG_P, or moving faster than AIR_FLAG_V cells/step.
#define AIR_FLAG_T 3.0
#define AIR_FLAG_P 0.04
#define AIR_FLAG_V 0.05
// a fire cell's glow: blackbody colour × (BASE + T / T_SCALE) × GAIN
#define FIRE_GLOW_BASE 0.6
#define FIRE_GLOW_T 1500.0
#define FIRE_GLOW_GAIN 1.5

// A hot opaque cell lights its surroundings only through its open faces: buried
// lava or a conduit of hot rock casts no light. Per open face it counts as the
// brick-deep column under a flat surface did when every hot cell counted.
#define GLOW_FACE_GAIN float(BS)
float openFaces(ivec3 c) {
  float n = 0.0;
  for (int k = 0; k < 6; k++) {
    ivec3 q = c;
    q[k >> 1] += (k & 1) == 0 ? -1 : 1;
    if (q.y < 0) continue;                       // the floor
    if (!inGrid(q)) { n += 1.0; continue; }      // open sky past the box
    if (RCLASS[eid(fetchA(q))] != R_OPAQUE) n += 1.0;
  }
  return n;
}

void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  if (bc.y >= BY) { oC = vec4(0.0); return; }
  float occ = 0.0, gas = 0.0, surf = 0.0, media = 0.0, opaque = 0.0, thin = 0.0;
  int flags = 0;
  int liq0 = E_EMPTY;     // first liquid-channel element seen (liquids, ice)
  bool mixed = false;     // a second one too
  vec3 em = vec3(0.0);
  ivec3 o = bc * BS;
  for (int z = 0; z < BS; z++)
  for (int y = 0; y < BS; y++)
  for (int x = 0; x < BS; x++) {
    ivec3 c = o + ivec3(x, y, z);
    ivec2 t = atlas(c);   // the render fields share the state's atlas
    vec4 a = fetchA(c);
    vec4 s = texelFetch(tFS, t, 0);
    vec4 m = texelFetch(tFM, t, 0);
    int id = eid(a);
    if (id != E_EMPTY) occ = 1.0;
    else if (abs(a.y - AMBIENT) > AIR_FLAG_T) flags |= AIR_HOT;
    if (id == E_STEAM || id == E_SMOKE) gas += 1.0;
    surf = max(surf, max(max(s.x, s.y), max(s.z, s.w)));
    // something opaque (not liquid, glass or gas) here or in an opaque surface field
    if (id != E_EMPTY && KIND[id] != K_GAS && RCLASS[id] != R_LIQUID && RCLASS[id] != R_GLASS) opaque = 1.0;
    opaque = max(opaque, max(s.y, max(s.z, s.w)));
    thin = max(thin, texelFetch(tFT, t, 0).x);
    if (SURFCH[id] == CH_LIQUID) {
      if (liq0 == E_EMPTY) liq0 = id;
      else if (id != liq0) mixed = true;
    }
    media = max(media, max(m.x, max(m.y, m.z)));
    if (id == E_FIRE) em += blackbody(a.y) * (FIRE_GLOW_BASE + a.y / FIRE_GLOW_T) * FIRE_GLOW_GAIN;
    else if (id != E_EMPTY && KIND[id] != K_GAS && a.y > INCAND_T0) {
      // the light of the visible skin (metals have none to speak of)
      vec3 e = incandescence(a.y - (id == E_METAL ? 0.0 : INCAND_SKIN_DROP));
      if (dot(e, e) > 0.0) em += e * (RCLASS[id] == R_OPAQUE ? openFaces(c) * GLOW_FACE_GAIN : 1.0);
    }
  }
  // Pressure and air velocity are smooth fields, so the brick's 2×2×2 core is
  // a good enough sample (a full second pass over B would double this pass).
  float pm = 0.0, vm = 0.0;
  for (int z = 1; z < 3; z++)
  for (int y = 1; y < 3; y++)
  for (int x = 1; x < 3; x++) {
    vec4 b = fetchB(o + ivec3(x, y, z));
    pm = max(pm, abs(b.w));
    vm = max(vm, dot(b.xyz, b.xyz));
  }
  if (pm > AIR_FLAG_P) flags |= AIR_PRESSURE;
  if (vm > AIR_FLAG_V * AIR_FLAG_V) flags |= AIR_FLOW;
  const float FIELD_HERE = 0.03;   // a surface field this strong may hold a surface nearby
  bool hasSurf = surf > FIELD_HERE, hasMedia = media > MEDIA_FLOOR, hasOpaque = opaque > FIELD_HERE;
  int bits = (hasMedia ? BRICK_MEDIA : 0) | (hasSurf ? BRICK_SURF : 0) | (hasOpaque ? BRICK_OPAQUE : 0)
           | (thin > 0.0 ? BRICK_THIN : 0) | (mixed ? BRICK_MIXED : 0);
  float air = flags > 0 ? -1.0 - float(flags) / BRICK_AIR_DIV : 0.0;
  float matter = 1.0 + gas / BRICK_GAS_DIV + 2.0 * float(bits) + float(flags) / BRICK_FLAG_DIV;
  oC = vec4(em / float(BS * BS * BS), (occ > 0.0 || hasSurf || hasMedia) ? matter : air);
}
`;

// Separable 5-tap blur over the brick grid (axis 0/1/2).
export const blurFrag = (g) => /* glsl */ `
${prelude(g)}
// tent-ish 5-tap weights (sum 1), and a gain that makes up for light spread past the box
#define LIGHT_BLUR_W 0.10, 0.22, 0.36, 0.22, 0.10
#define LIGHT_BLUR_GAIN 1.15
uniform sampler2D tSrc;
uniform int uAxis;
out vec4 oC;
void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  if (bc.y >= BY) { oC = vec4(0.0); return; }
  ivec3 dir = uAxis == 0 ? ivec3(1, 0, 0) : (uAxis == 1 ? ivec3(0, 1, 0) : ivec3(0, 0, 1));
  ivec3 hi = ivec3(BX, BY, BZ) - 1;
  const float W[5] = float[5](LIGHT_BLUR_W);
  vec3 s = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    ivec3 q = bc + dir * (i - 2);
    if (any(lessThan(q, ivec3(0))) || any(greaterThan(q, hi))) continue;
    s += texelFetch(tSrc, brickAtlas(q), 0).rgb * W[i];
  }
  oC = vec4(s * LIGHT_BLUR_GAIN, 1.0);
}
`;

// Empty-space distance: for each brick, the Chebyshev distance (in bricks) to
// the nearest brick the realistic view must visit (brick alpha >= 0.5),
// capped at BRICK_DIST_MAX. Every brick within (distance - 1) of an empty one
// is empty too, so a ray can cross that whole cube in one step instead of
// brick by brick (gfx/core.js skipEmpty). L∞ distance is separable: three
// passes, each a min over a 1D window along one axis.
export const BRICK_DIST_MAX = 8;          // bricks; also the half-width of each pass's window
export const BRICK_DIST_SCALE = 255;      // stored as distance / this in an 8-bit channel
export const brickDistFrag = (g, axis = 0) => /* glsl */ `
${prelude(g)}
uniform sampler2D tSrc;   // axis 0: the brick map, else the distance so far
out vec4 oC;
#define DIST_MAX ${BRICK_DIST_MAX}
#define DIST_SCALE ${BRICK_DIST_SCALE.toFixed(1)}
void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  if (bc.y >= BY) { oC = vec4(0.0); return; }
  const ivec3 dir = ivec3(${['1, 0, 0', '0, 1, 0', '0, 0, 1'][axis]});
  ivec3 hi = ivec3(BX, BY, BZ) - 1;
  float d = float(DIST_MAX);
  for (int k = -DIST_MAX; k <= DIST_MAX; k++) {
    ivec3 q = bc + dir * k;
    if (any(lessThan(q, ivec3(0))) || any(greaterThan(q, hi))) continue;
    vec4 t = texelFetch(tSrc, brickAtlas(q), 0);
    float v = ${axis === 0 ? 't.a >= 0.5 ? 0.0 : float(DIST_MAX)' : 't.x * DIST_SCALE'};
    d = min(d, max(float(abs(k)), v));
  }
  oC = vec4(d / DIST_SCALE);
}
`;

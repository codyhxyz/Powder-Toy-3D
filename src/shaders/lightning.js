import { prelude, stateOutGLSL, copyThroughMain } from './common.js';
import { boltGLSL } from '../bolt.js';

// GPU passes for lightning (src/bolt.js has the rules, src/lightning.js runs them).

// The bolt: a full-grid ping-pong pass (sim.pass) that changes only cells
// inside uLo..uHi (the bolt's bounds; everything else copies through). Along
// the channel's segments, air and gas become plasma with the channel's
// overpressure, and matter takes BOLT_E of heat; around the strike point,
// matter takes STRIKE_E (full inside STRIKE_CORE of the radius) and the air
// STRIKE_P; cloud within uDischargeR of the origin loses its charge (ctype).
export const boltFrag = (g) => /* glsl */ `
${prelude(g)}
${boltGLSL()}
uniform uint uFrame;
uniform vec4 uSegA[BOLT_MAX_SEGS];   // segment start (cells); w: channel radius (cells)
uniform vec4 uSegB[BOLT_MAX_SEGS];   // segment end (cells)
uniform int uSegs;
uniform vec3 uStrike;                // where it lands (cells)
uniform float uStrikeR;
uniform vec3 uBoltFrom;                // where it left the cloud (cells)
uniform float uDischargeR;           // 0: a tool bolt (no cloud to discharge)
uniform vec3 uLo;                    // bounds of every cell it changes (cell centres)
uniform vec3 uHi;
${stateOutGLSL}

float segDist(vec3 c, vec3 a, vec3 b) {
  vec3 ab = b - a;
  float t = clamp(dot(c - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(c - a - ab * t);
}

void bolt(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  vec3 c = vec3(p) + 0.5;
  if (any(lessThan(c, uLo)) || any(greaterThan(c, uHi))) return;
  int id = eid(a);
  bool open = id == E_EMPTY || KIND[id] == K_GAS;
  bool channel = false;
  for (int i = 0; i < BOLT_MAX_SEGS; i++) {
    if (i >= uSegs) break;
    if (segDist(c, uSegA[i].xyz, uSegB[i].xyz) < uSegA[i].w) { channel = true; break; }
  }
  if (channel) {
    if (open) {
      uint rs = seed3(p, uFrame, BOLT_RNG_SALT);
      oA = vec4(float(E_PLASMA), SPAWNT[E_PLASMA], SPAWNLIFE[E_PLASMA], rnd(rs) * SEED_MAX);
      oB = vec4(0.0, 0.0, 0.0, min(b.w + BOLT_P, P_MAX));
    } else {
      oA.y = min(a.y + BOLT_E / CAP[id], CELL_TEMP_MAX);
    }
  }
  float r = length(c - uStrike);
  if (!open && r < uStrikeR) {
    float f = 1.0 - smoothstep(uStrikeR * STRIKE_CORE, uStrikeR, r);
    oA.y = min(oA.y + STRIKE_E * f / CAP[id], CELL_TEMP_MAX);
    // BOLT LANDS: the spot where a strike sparks what it hits.
    // TODO(el-elec, at merge): sparkCell(oA);   (the prelude's: a ready conductor takes a full spark)
  }
  if (open && r < uStrikeR + STRIKE_P_REACH) oB.w = min(max(oB.w, STRIKE_P), P_MAX);
  if (eid(oA) == E_CLOUD && length(c - uBoltFrom) < uDischargeR) oA.w = fract(a.w);   // charge spent
}
${copyThroughMain('bolt')}`;

// Storm: find a cloud cell charged to breakdown (react.js CHARGE_*), in three
// reductions so no fragment loops over much:
//   stormBrickFrag  brick resolution: the brick's most charged cloud cell at
//                   CHARGE_BREAKDOWN or past, as (cell centre, charge), or 0
//   stormRowsFrag   one texel per row of the brick atlas: its best
//   stormPickFrag   one texel: the best of the rows
export const stormBrickFrag = (g) => /* glsl */ `
${prelude(g)}
out vec4 oC;
void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  oC = vec4(0.0);
  if (bc.y >= BY) return;
  ivec3 o = bc * BS;
  for (int z = 0; z < BS; z++)
  for (int y = 0; y < BS; y++)
  for (int x = 0; x < BS; x++) {
    ivec3 c = o + ivec3(x, y, z);
    if (!inGrid(c)) continue;
    vec4 a = fetchA(c);
    float q = floor(a.w);
    if (eid(a) == E_CLOUD && q >= CHARGE_BREAKDOWN && q > oC.w) oC = vec4(vec3(c) + 0.5, q);
  }
}
`;
export const stormRowsFrag = (g) => /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tSrc;
out vec4 oC;
void main() {
  int v = int(gl_FragCoord.x);
  oC = vec4(0.0);
  for (int u = 0; u < ${g.bwidth}; u++) {
    vec4 t = texelFetch(tSrc, ivec2(u, v), 0);
    if (t.w > oC.w) oC = t;
  }
}
`;
export const stormPickFrag = (g) => /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tSrc;
out vec4 oC;
void main() {
  oC = vec4(0.0);
  for (int v = 0; v < ${g.bheight}; v++) {
    vec4 t = texelFetch(tSrc, ivec2(v, 0), 0);
    if (t.w > oC.w) oC = t;
  }
}
`;

// The leader's candidate columns (bolt.js stormColumns): one texel each, the
// highest matter cell (not air, not gas) below uFromY: (y, id, 1, 0), y = -1
// for the floor; (0, 0, 0, 0) for a column outside the box.
export const stormScanFrag = (g) => /* glsl */ `
${prelude(g)}
${boltGLSL()}
uniform vec2 uCols[STORM_CANDIDATES];
uniform int uCount;
uniform float uFromY;
out vec4 oC;
void main() {
  int k = int(gl_FragCoord.x);
  oC = vec4(0.0);
  if (k >= uCount) return;
  ivec2 xz = ivec2(uCols[k]);
  if (xz.x < 0 || xz.y < 0 || xz.x >= NX || xz.y >= NZ) return;
  oC = vec4(-1.0, -1.0, 1.0, 0.0);
  for (int y = min(int(uFromY) - 1, NY - 1); y >= 0; y--) {
    int id = eid(fetchA(ivec3(xz.x, y, xz.y)));
    if (id != E_EMPTY && KIND[id] != K_GAS) { oC = vec4(float(y), float(id), 1.0, 0.0); return; }
  }
}
`;

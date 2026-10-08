import { prelude } from './common.js';

// GPU side of the first-person body (src/pov/player.js).
//
// 1. Probe: copies a small box of cells around the body into an RGBA32F target
//    the player reads back asynchronously, one texel per cell:
//    (element id, temperature °C, air pressure, life). Cells outside the grid
//    read as PROBE_OUTSIDE.
// 2. Coupling: a full-grid pass that gives loose matter inside the body's box
//    the body's velocity plus an outward push, so wading leaves a wake, a body
//    landing in water throws it up and out, and grains that fall into the body
//    are shoved out of it. It only rewrites velocities: no cell is created,
//    removed or changed, solids are left alone, and air stays still.

// Size of the probed box, in cells. The body is BODY_WIDTH (1.6) wide, so its
// footprint touches at most 3 cells per axis; 2 more on each side cover the
// cells it can touch, collide with or step onto before the next readback lands.
// Height: 1 ground cell + up to 7 body cells + 1 head-clearance cell for a step
// up, plus margin. 6 × 12 × 6 = 432 texels.
export const PROBE = { X: 6, Y: 12, Z: 6 };
// Element id a probe texel reports for a cell outside the grid (the box walls).
export const PROBE_OUTSIDE = -1;

export const povProbeFrag = (g) => /* glsl */ `
${prelude(g)}
#define PROBE_Z ${PROBE.Z}
#define PROBE_OUTSIDE ${PROBE_OUTSIDE.toFixed(1)}
uniform sampler2D tA;
uniform sampler2D tB;
uniform ivec3 uOrigin;   // grid cell of the box's low corner
out vec4 oC;

// texel (x, y·PROBE_Z + z) holds box cell (x, y, z)
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec3 q = uOrigin + ivec3(f.x, f.y / PROBE_Z, f.y % PROBE_Z);
  if (!inGrid(q)) { oC = vec4(PROBE_OUTSIDE, AMBIENT, 0.0, 0.0); return; }
  vec4 a = texelFetch(tA, atlas(q), 0);
  oC = vec4(float(eid(a)), a.y, texelFetch(tB, atlas(q), 0).w, a.z);
}
`;

// A cell on the body's axis has no outward direction; under this distance
// (cells) it gets a random one.
const AXIS_EPS = 1e-3;

export const povCouplingFrag = (g) => /* glsl */ `
${prelude(g)}
#define POV_RNG_SALT 0x9du   // the coupling's own random stream (seed3)
#define AXIS_EPS ${AXIS_EPS}
uniform sampler2D tA;
uniform sampler2D tB;
uniform uint uFrame;
uniform vec3 uMin;          // body box, grid cells
uniform vec3 uMax;
uniform vec3 uVel;          // body velocity, cells/step
uniform float uPushFluid;   // outward push on liquids and gases, cells/step
uniform float uPushPowder;  // outward push on grains, cells/step
uniform float uLift;        // upward share of the push (a body moving down throws liquid up)
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;

void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(tA, f, 0);
  vec4 b = texelFetch(tB, f, 0);
  oA = a; oB = b;
  ivec3 p = cellFromFrag(f);
  if (p.y >= NY) return;
  vec3 c = vec3(p) + 0.5;
  if (any(lessThan(c, uMin)) || any(greaterThan(c, uMax))) return;
  int id = eid(a);
  if (id == E_EMPTY || KIND[id] == K_SOLID) return;

  vec2 r = c.xz - 0.5 * (uMin.xz + uMax.xz);
  vec2 out2;
  if (length(r) > AXIS_EPS) out2 = normalize(r);
  else {
    uint rs = seed3(p, uFrame, POV_RNG_SALT);
    float ang = rnd(rs) * 6.2831853;
    out2 = vec2(cos(ang), sin(ang));
  }
  float push = KIND[id] == K_POWDER ? uPushPowder : uPushFluid;
  vec3 v = uVel + normalize(vec3(out2, uLift)) * push;
  oB.xyz = clamp(v, -V_MAX, V_MAX);
}
`;

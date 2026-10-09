import { prelude, stateOutGLSL, copyThroughMain } from './common.js';

// GPU side of the first-person body (src/pov/player.js).
//
// 1. Probe: copies a small box of cells around the body into an RGBA32F target
//    the player reads back asynchronously, one texel per cell:
//    (element id, temperature °C, air pressure, life). Cells outside the grid
//    read as PROBE_OUTSIDE.
// 2. Coupling: a full-grid pass that gives loose matter inside the body's box
//    the body's velocity plus a push outward and ahead, so wading leaves a wake, a body
//    landing in water throws it up and out, and grains that fall into the body
//    are shoved out of it. It only rewrites velocities: no cell is created,
//    removed or changed, solids are left alone, and air stays still.

// Size of the probed box, in cells. The body is BODY_WIDTH (1.6) wide, so its
// footprint touches at most 3 cells per axis, and up to 7 cells in height.
// Around it the box needs the cells the body touches, collides with, steps onto
// (1 up, 1 down) and travels into before the next readback lands. player.js
// leads the box by velocity × latency, but the body must stay inside it until the
// readback lands, so the box must be larger than the body by the distance
// travelled in one latency. Noita's run (28 cells/s) and flight (47 cells/s) at
// ~10 fps with a few frames' latency is about 10 cells, so 16 × 32 × 16 = 8192
// texels (128 KB a readback). A box too small for the speed skips updates and
// freezes the body.
export const PROBE = { X: 16, Y: 32, Z: 16 };
// Element id a probe texel reports for a cell outside the grid (the box walls).
export const PROBE_OUTSIDE = -1;

export const povProbeFrag = (g) => /* glsl */ `
${prelude(g)}
#define PROBE_Z ${PROBE.Z}
#define PROBE_OUTSIDE ${PROBE_OUTSIDE.toFixed(1)}
uniform ivec3 uBoxLo;   // grid cell of the box's low corner
out vec4 oC;

// texel (x, y·PROBE_Z + z) holds box cell (x, y, z)
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec3 q = uBoxLo + ivec3(f.x, f.y / PROBE_Z, f.y % PROBE_Z);
  if (!inGrid(q)) { oC = vec4(PROBE_OUTSIDE, AMBIENT, 0.0, 0.0); return; }
  vec4 a = fetchA(q);
  oC = vec4(float(eid(a)), a.y, fetchB(q).w, a.z);
}
`;

// A cell on the body's axis has no outward direction; under this distance
// (cells) it gets a random one.
const AXIS_EPS = 1e-3;

export const povCouplingFrag = (g) => /* glsl */ `
${prelude(g)}
#define POV_RNG_SALT 0x9du   // the coupling's own random stream (seed3)
#define AXIS_EPS ${AXIS_EPS}
uniform uint uFrame;
uniform vec3 uMin;          // body box, grid cells
uniform vec3 uMax;
uniform vec3 uVel;          // body velocity, cells/step
uniform float uPushFluid;   // outward push on liquids and gases, cells/step
uniform float uPushPowder;  // outward push on grains, cells/step
uniform float uLift;        // upward share of the push (a body moving down throws liquid up)
uniform vec2 uAhead;        // forward share of the push, along the body's horizontal heading (xz)
${stateOutGLSL}

void couple(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
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
  vec3 v = uVel + normalize(vec3(out2 + uAhead, uLift)) * push;
  oB.xyz = clamp(v, -V_MAX, V_MAX);
}
${copyThroughMain('couple')}`;

import { prelude } from './common.js';

// Activity map: which 4×4×4 bricks the simulation may skip.
//
// Most of the box is quiet air or resting solid, and stepping it is pure cost:
// its update only reshuffles the brownian jitter of the air, which nothing can
// see. A brick is *inert* when every cell is
//   - air within INERT_T of ambient, with no pressure and no wind beyond the
//     air's own jitter, or
//   - a solid within INERT_T of ambient that spawns nothing (not clone).
// A brick is *quiet* (skipped) when it and its 26 neighbours are inert. Then
// anything that could change it is more than BS cells away, and a change
// travels at most INFLUENCE_PER_STEP cells per step (the move pass shifts a
// cell by one, then the react pass reads its neighbours), so the map holds for
// ACTIVITY_PERIOD steps. Skipped cells keep their state exactly; when matter
// or heat comes near, the brick wakes up before it can arrive.

// Cells a change can travel in one step: one by moving, one by the react pass's stencil.
export const INFLUENCE_PER_STEP = 2;
// Steps an activity map stays valid: its one-brick halo, crossed at the speed above.
export const activityPeriod = (brickSize) => Math.floor(brickSize / INFLUENCE_PER_STEP);

const INERT = /* glsl */ `
// Temperature within this of ambient counts as ambient (°C). Air relaxing
// toward ambient stalls a few 1e-4 °C off it in float32, so exact equality
// would keep it awake forever.
#define INERT_T 0.01
// Pressure this small counts as none (it decays geometrically and never quite reaches 0).
#define INERT_P 0.001
// Air's steady jitter speed: the react pass does v' = v·(1 - drag) + j with
// |j| ≤ jitter / 2, whose bound is this. Calmer than that is no wind (cells/step).
const float AIR_JITTER_V = 0.5 * JITTER[E_EMPTY] / DRAG[E_EMPTY];
// float slop on the jitter bound (cells/step)
#define INERT_V_SLOP 1e-4

bool inertCell(vec4 a, vec4 b) {
  int id = eid(a);
  if (abs(a.y - AMBIENT) > INERT_T) return false;
  if (id == E_EMPTY) {
    vec3 v = abs(b.xyz);
    return abs(b.w) <= INERT_P && max(v.x, max(v.y, v.z)) <= AIR_JITTER_V + INERT_V_SLOP;
  }
  return KIND[id] == K_SOLID && id != E_CLONE;
}
`;

// Brick resolution: 1 if every cell of the brick is inert.
export const inertFrag = (g) => /* glsl */ `
${prelude(g)}
${INERT}
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
    if (!inertCell(fetchA(c), fetchB(c))) return;
  }
  oC = vec4(1.0);
}
`;

// Brick resolution: 1 if the brick and its 26 neighbours are inert (outside
// the box counts as inert: the box walls are). uEnabled = false clears the map.
export const quietFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tInert;
uniform bool uEnabled;
out vec4 oC;
void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  oC = vec4(0.0);
  if (bc.y >= BY || !uEnabled) return;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    ivec3 b = bc + ivec3(x, y, z);
    if (any(lessThan(b, ivec3(0))) || any(greaterThanEqual(b, ivec3(BX, BY, BZ)))) continue;
    if (texelFetch(tInert, brickAtlas(b), 0).x < 0.5) return;
  }
  oC = vec4(1.0);
}
`;

// For the sim passes: is cell c in a quiet brick?
export const quietGLSL = /* glsl */ `
uniform sampler2D tQuiet;   // brick-resolution quiet map (shaders/activity.js)
bool quietCell(ivec3 c) {
  ivec3 b = clamp(c, ivec3(0), ivec3(NX, NY, NZ) - 1) / BS;
  return texelFetch(tQuiet, brickAtlas(b), 0).x > 0.5;
}
`;

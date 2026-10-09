import { prelude } from './common.js';

// Activity map: which 4×4×4 bricks the simulation may skip.
//
// Most of the box is quiet air or resting matter, and stepping it is pure
// cost. A cell is *inert* when stepping it would change nothing but drift
// below the tolerances in physics.js (rest states):
//   - air near ambient (AIR_REST_T), with no pressure and no wind beyond the
//     air's own jitter;
//   - a solid, or a powder or liquid at rest: velocity exactly 0 (react.js
//     holds resting matter still) and nowhere to go by the move pass's own
//     canMove, neither the cell below nor the lower ring it could topple
//     into, nor for a liquid its four sides;
//   - nothing that reacts: no gas, nothing burning or hot enough to light
//     the air, melting, setting, freezing, boiling or banking latent heat,
//     nothing next to acid, no plant by water, no clone by air;
//   - thermally quiet: within MATTER_REST_T of each matter face neighbour,
//     and within AIR_REST_T of ambient where it touches air.
// A change a neighbour sets off on its own (a flame catching in the air by
// burning wood) makes that neighbour non-inert instead.
// A brick is *quiet* (skipped) when it and its 26 neighbours are inert. Then
// anything that could change it is more than BS cells away, and a change
// travels at most INFLUENCE_PER_STEP cells per step (the move pass shifts a
// cell by one, then the react pass reads its neighbours), so the map holds for
// ACTIVITY_PERIOD steps. Skipped cells keep their state exactly; when matter
// or heat comes near, the brick wakes up before it can arrive. What skipping
// leaves out is the sub-tolerance drift: heat across faces within the
// tolerances (bounded in physics.js), the last of a pressure below REST_P
// decaying, the air's brownian shuffle.

// Cells a change can travel in one step: one by moving, one by the react pass's stencil.
export const INFLUENCE_PER_STEP = 2;
// Steps an activity map stays valid: its one-brick halo, crossed at the speed above.
export const activityPeriod = (brickSize) => Math.floor(brickSize / INFLUENCE_PER_STEP);

// Needs the state as uniforms tA, tB.
const INERT = /* glsl */ `
// Air's steady jitter speed: the react pass does v' = v·(1 - drag) + j with
// |j| ≤ jitter / 2, whose bound is this. Calmer than that is no wind (cells/step).
const float AIR_JITTER_V = 0.5 * JITTER[E_EMPTY] / DRAG[E_EMPTY];
const ivec3 FACES[6] = ivec3[6](ivec3(1,0,0), ivec3(-1,0,0), ivec3(0,1,0), ivec3(0,-1,0), ivec3(0,0,1), ivec3(0,0,-1));
#define MASK_WORDS ((BS * BS * BS + 31) / 32)   // uints for one bit per cell of a brick

// What acid eats (react.js): all but air, acid, walls, glass, water and gases.
bool acidEats(int j) {
  return j != E_EMPTY && j != E_ACID && j != E_WALL && j != E_GLASS && j != E_SHARDS && j != E_WATER
      && KIND[j] != K_GAS;
}

// Inert as far as the cell's own state can tell.
bool inertSelf(vec4 a, vec4 b) {
  int id = eid(a);
  float T = a.y;
  if (id == E_EMPTY) {
    vec3 v = abs(b.xyz);
    return abs(T - AMBIENT) <= AIR_REST_T && abs(b.w) <= REST_P && max(v.x, max(v.y, v.z)) <= AIR_JITTER_V + REST_V_SLOP;
  }
  int k = KIND[id];
  if (k == K_GAS) return false;   // smoke, steam and flames rise, fade and burn
  // moving, or pressure still settling (solids hold none)
  if (k != K_SOLID && (b.xyz != vec3(0.0) || abs(b.w) > REST_P)) return false;
  if (MELT[id] > 0.0 && T > MELT[id]) return false;
  if (IGNITE[id] > 0.0 && T >= IGNITE[id]) return false;   // burning, or hot enough to light the air
  // latent heat: water and ice at rest have nothing banked and sit within their phase
  if (id == E_WATER) return a.z == 0.0 && T >= 0.0 && T <= 100.0;
  if (id == E_ICE || id == E_SNOW) return a.z == 0.0 && T <= 0.0;
  if (id == E_LAVA) {
    int ct = int(floor(a.w));
    if (ct <= 0 || ct >= NE) ct = E_STONE;
    return T >= MELT[ct] - LAVA_FREEZE_BELOW;   // not cool enough to set
  }
  return true;
}

// The rest of the test, from its neighbours (outside the box is wall, which
// insulates, never reacts and can't be entered).
bool inertNear(ivec3 c, vec4 a) {
  int id = eid(a);
  if (id == E_EMPTY) return true;   // what changes air is a neighbour that isn't inert
  int k = KIND[id];
  float T = a.y, d = densityOf(id, T);
  for (int i = 0; i < 6; i++) {
    ivec3 q = c + FACES[i];
    if (!inGrid(q)) continue;
    vec4 n = texelFetch(tA, atlas(q), 0);
    int j = eid(n);
    // thermally quiet; a face touching air carries heat at air's conductance, so it takes air's tolerance
    if (j == E_EMPTY ? abs(T - AMBIENT) > AIR_REST_T : abs(T - n.y) > MATTER_REST_T) return false;
    if (j == E_ACID ? acidEats(id) : id == E_ACID && acidEats(j)) return false;
    if ((id == E_WATER && j == E_PLANT) || (id == E_PLANT && j == E_WATER)) return false;
    if (id == E_CLONE && (j == E_EMPTY || (a.w < 1.0 && j != E_WALL && j != E_CLONE))) return false;
    if (id == E_GUNPOWDER && !isGasLike(j) && n.y >= IGNITE[id]) return false;   // a hot touch sets it off
    // a powder or liquid: nowhere to fall, nor for a liquid to flow sideways
    bool way = FACES[i].y < 0 || (k == K_LIQUID && FACES[i].y == 0);
    if (k != K_SOLID && way && canMove(id, j, d, densityOf(j, n.y), FACES[i].y < 0 ? 0 : 2)) return false;
  }
  if (k == K_SOLID) return true;
  // ... nor to topple into, in the rest of the lower ring
  for (int z = -1; z <= 1; z++)
  for (int x = -1; x <= 1; x++) {
    ivec3 q = c + ivec3(x, -1, z);
    if ((x == 0 && z == 0) || !inGrid(q)) continue;
    vec4 n = texelFetch(tA, atlas(q), 0);
    int j = eid(n);
    if (canMove(id, j, d, densityOf(j, n.y), 0)) return false;
  }
  return true;
}
`;

// Brick resolution: 1 if every cell of the brick is inert.
export const inertFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tA;
uniform sampler2D tB;
${INERT}
out vec4 oC;
void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  oC = vec4(0.0);
  if (bc.y >= BY) return;
  ivec3 o = bc * BS;
  // every cell's own state first: it is cheap and rules out most awake
  // bricks. It also notes which cells hold matter, the only ones whose
  // neighbours matter (bit x + BS·(y + BS·z) of the mask).
  uint matter[MASK_WORDS];
  for (int w = 0; w < MASK_WORDS; w++) matter[w] = 0u;
  for (int z = 0; z < BS; z++)
  for (int y = 0; y < BS; y++)
  for (int x = 0; x < BS; x++) {
    ivec2 t = atlas(o + ivec3(x, y, z));
    vec4 a = texelFetch(tA, t, 0);
    if (!inertSelf(a, texelFetch(tB, t, 0))) return;
    int i = x + BS * (y + BS * z);
    if (eid(a) != E_EMPTY) matter[i >> 5] |= 1u << (i & 31);
  }
  for (int z = 0; z < BS; z++)
  for (int y = 0; y < BS; y++)
  for (int x = 0; x < BS; x++) {
    int i = x + BS * (y + BS * z);
    if ((matter[i >> 5] & (1u << (i & 31))) == 0u) continue;
    ivec3 c = o + ivec3(x, y, z);
    if (!inertNear(c, texelFetch(tA, atlas(c), 0))) return;
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

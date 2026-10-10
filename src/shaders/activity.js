import { prelude, inertSelfGLSL, SUPER, SUPER_TEX, BLOCK_TILE } from './common.js';

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
//
// The test has two halves: inertSelf, on the cell's own state
// (shaders/common.js), and inertNear, on its neighbours' states A. Rather than
// run both over the whole state per brick, the brick pass reduces the
// activity flags every state writer leaves beside a cell (common.js FLAG):
// SELF is always exact, and NEAR is the react pass's evaluation of inertNear,
// which may have seen a neighbour before the step changed it. So NEAR is
// trusted only where nothing a brick's neighbour tests read is DIRTY (changed
// since the last map in a way they read), and inertNear is rerun from the
// state where something is. A brick that was quiet all period has NEAR set by
// react (its cells were inert when the map was built, and are unchanged), so
// the result is the test above, exactly: inertRefFrag runs it the old way, for
// tools/activity-check.mjs to compare.

// Cells a change can travel in one step: one by moving, one by the react pass's stencil.
export const INFLUENCE_PER_STEP = 2;
// Steps an activity map stays valid: its one-brick halo, crossed at the speed above.
export const activityPeriod = (brickSize) => Math.floor(brickSize / INFLUENCE_PER_STEP);

// The neighbour half of the rest test, for cell c holding a, given its face
// neighbours' states A in FACES order (nA; those outside the box are skipped:
// the box walls insulate, never react and can't be entered). It reads the
// lower ring itself, from the pass's input state (fetchA).
export const inertNearGLSL = /* glsl */ `
const ivec3 FACES[6] = ivec3[6](ivec3(1,0,0), ivec3(-1,0,0), ivec3(0,1,0), ivec3(0,-1,0), ivec3(0,0,1), ivec3(0,0,-1));

// What acid eats (react.js): all matter that isn't acid-proof (elements.js
// acidProof: acid itself, walls, glass, water). Never air or gases.
bool acidEats(int j) { return KIND[j] != K_EMPTY && KIND[j] != K_GAS && !ACIDPROOF[j]; }

bool inertNear(ivec3 c, vec4 a, vec4 nA[6]) {
  int id = eid(a);
  if (id == E_EMPTY) return true;   // what changes air is a neighbour that isn't inert
  int k = KIND[id];
  float T = a.y, d = densityOf(id, T);
  for (int i = 0; i < 6; i++) {
    if (!inGrid(c + FACES[i])) continue;
    vec4 n = nA[i];
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
    vec4 n = fetchA(q);
    int j = eid(n);
    if (canMove(id, j, d, densityOf(j, n.y), 0)) return false;
  }
  return true;
}

// inertNear of cell c, its neighbours read from the pass's input state.
bool inertNearHere(ivec3 c) {
  vec4 nA[6];
  for (int i = 0; i < 6; i++) {
    ivec3 q = c + FACES[i];
    nA[i] = inGrid(q) ? fetchA(q) : vec4(0.0);
  }
  return inertNear(c, fetchA(c), nA);
}
`;

// The inert map takes three passes, so the re-tests run in parallel:
//   inertFrag      brick resolution: decides each brick from its flags where
//                  it can (r: inert), else marks it stale (g)
//   inertRowsFrag  BS × BS fragments per brick (target bwidth·BS × bheight·BS),
//                  each re-testing the BS cells along x of one row (y, z) of a
//                  stale brick: 1 if they all pass
//   inertJoinFrag  brick resolution: the decision, or the AND of the rows
// (A stale brick in one fragment would run up to BS³ neighbour tests in a row.)

// Brick pass (needs uniform tF): r = 1 if the brick is inert by its flags,
// g = 1 if they don't decide it (inertRowsFrag re-tests it).
export const inertFrag = (g) => /* glsl */ `
${prelude(g)}
out vec4 oC;

// Is anything the brick's neighbour tests read outside it (within a cell of
// it: its faces' cells and the lower rings) dirty?
bool haloDirty(ivec3 o) {
  for (int z = -1; z <= BS; z++)
  for (int y = -1; y <= BS; y++)
  for (int x = -1; x <= BS; x++) {
    ivec3 l = ivec3(x, y, z);
    if (all(greaterThanEqual(l, ivec3(0))) && all(lessThan(l, ivec3(BS)))) continue;   // the brick itself
    ivec3 q = o + l;
    if (inGrid(q) && (fetchF(q) & FLAG_DIRTY) != 0u) return true;
  }
  return false;
}

void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  oC = vec4(0.0);
  if (bc.y >= BY) return;
  ivec3 o = bc * BS;
  uint every = ~0u, some = 0u;   // AND and OR of the brick's flags
  for (int z = 0; z < BS; z++)
  for (int y = 0; y < BS; y++)
  for (int x = 0; x < BS; x++) {
    uint f = fetchF(o + ivec3(x, y, z));
    every &= f;
    some |= f;
  }
  if ((every & FLAG_SELF) == 0u) return;   // a cell moves, reacts, or is off its rest temperature
  // only air: nothing to test against the neighbours
  if ((some & FLAG_MATTER) == 0u) { oC = vec4(1.0); return; }
  // nothing the neighbour tests read changed since the last map: their NEAR stands
  if ((some & FLAG_DIRTY) == 0u && !haloDirty(o)) {
    if ((every & FLAG_NEAR) != 0u) oC = vec4(1.0);
    return;
  }
  oC = vec4(0.0, 1.0, 0.0, 0.0);   // else the rows redo them from the state
}
`;

// Row pass (needs tA, tF and tClass, the brick pass's output).
export const inertRowsFrag = (g) => /* glsl */ `
${prelude(g)}
${inertNearGLSL}
uniform sampler2D tClass;
out vec4 oC;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy), bf = f / BS, row = f - bf * BS;   // brick texel, and the row (y, z) in it
  oC = vec4(1.0);
  if (texelFetch(tClass, bf, 0).g < 0.5) return;   // decided by its flags
  ivec3 o = brickFromFrag(bf) * BS + ivec3(0, row.x, row.y);
  for (int x = 0; x < BS; x++) {
    ivec3 c = o + ivec3(x, 0, 0);
    if ((fetchF(c) & FLAG_MATTER) != 0u && !inertNearHere(c)) { oC = vec4(0.0); return; }
  }
}
`;

// Join pass (needs tClass and tRows): the inert map, 1 if the brick is inert.
export const inertJoinFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tClass;
uniform sampler2D tRows;
out vec4 oC;
void main() {
  ivec2 bf = ivec2(gl_FragCoord.xy);
  vec4 decided = texelFetch(tClass, bf, 0);
  oC = vec4(decided.r);
  if (decided.g < 0.5) return;
  for (int z = 0; z < BS; z++)
  for (int y = 0; y < BS; y++)
    if (texelFetch(tRows, bf * BS + ivec2(y, z), 0).r < 0.5) { oC = vec4(0.0); return; }
  oC = vec4(1.0);
}
`;

// The same map computed from the state alone, the way the brick pass did
// before the activity flags (needs tA, tB): the reference the flags must
// reproduce exactly (tools/activity-check.mjs).
export const inertRefFrag = (g) => /* glsl */ `
${prelude(g)}
${inertSelfGLSL}
${inertNearGLSL}
#define MASK_WORDS ((BS * BS * BS + 31) / 32)   // uints for one bit per cell of a brick
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
    ivec3 c0 = o + ivec3(x, y, z);
    vec4 a = fetchA(c0);
    if (!inertSelf(a, fetchB(c0))) return;
    int i = x + BS * (y + BS * z);
    if (eid(a) != E_EMPTY) matter[i >> 5] |= 1u << (i & 31);
  }
  for (int z = 0; z < BS; z++)
  for (int y = 0; y < BS; y++)
  for (int x = 0; x < BS; x++) {
    int i = x + BS * (y + BS * z);
    if ((matter[i >> 5] & (1u << (i & 31))) == 0u) continue;
    if (!inertNearHere(o + ivec3(x, y, z))) return;
  }
  oC = vec4(1.0);
}
`;

// Brick resolution: 1 if the brick and its 26 neighbours are inert (outside
// the box counts as inert: the box walls are). uEnabled = false clears the map.
// A brick holding a fast particle (raysLayer.js: tRays, when uRays) counts as
// not inert: a particle flies at most a brick in the steps a map lives
// (rays.js RAY_V_MAX), so every cell it can heat stays awake.
export const quietFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tInert;
uniform bool uEnabled;
uniform sampler2D tRays;
uniform bool uRays;
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
    if (uRays && texelFetch(tRays, brickAtlas(b), 0).x > 0.5) return;
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

// ---- sleeping supertiles (docs/scaling.md D8) ----
// The step passes draw one instanced quad per supertile of their target (4×2×2
// bricks: one SUPER_TEX square of the state atlas; gfx/regions.js), and the
// vertex shader drops the supertiles nothing can change, so their tiles are
// never loaded. Inside a drawn supertile, quiet bricks still take the passes'
// own early-outs. Built with every activity map, per supertile (superMapFrag;
// texel (i % STW, i / STW), its slot in the state atlas), a byte per channel:
//   AWAKE  this map's steps may change it: a brick in it is not quiet, or one
//          just below it along x, y or z (with the partition offset at 1 a
//          Margolus block belongs to the brick holding its base cell, and
//          reaches one cell past it along each axis: shaders/move.js)
//   STEPS  a brick in it is not quiet: the flow pass writes only such bricks'
//          cells, so it draws these supertiles
//   BLOCKS a brick in it is not quiet, or one just above it along x, y or z:
//          the block pass draws these. It solves the blocks based in bricks
//          that aren't quiet (the gather reads them), and gives a block based
//          in a quiet brick its identity slots, which the flow pass reads for
//          that block's cells in a brick that isn't quiet (shaders/move.js)
//   DRAWN  the gather and react passes draw it: AWAKE under this map or the
//          last one, or written since the last map by something other than a
//          step (Simulation.noteWrite)
// The two-map rule. Under a map that leaves a supertile asleep (not AWAKE),
// its steps leave its cells as they are: the gather copies them (no block
// reaching into it moves) and react writes each one back as quiet, with its
// flags settled: its own, NEAR, and DIRTY as the gather left it, which the
// map's first step clears. So once a map's steps have drawn a supertile that
// sleeps under it, the current state copy holds its cells with settled flags
// and the other copy the same cells; after a second step the same flags too.
// A write that isn't a step can end a map after one step, but it either copies
// the current state into both copies there (sim.pass copies through every cell
// outside the box it declared) or marks the supertile written
// (Simulation.noteWrite). If the supertile still sleeps under the next map,
// that map's steps would write exactly what both copies hold: they skip it. A
// map whose steps didn't settle what slept under it (none, or one with no
// write after it: a tool building maps by hand) passes its DRAWN on instead
// (uPrevSettled).
export const SUPER_MAP = { AWAKE: 0, STEPS: 1, DRAWN: 2, BLOCKS: 3 };
// Steps under one map that settle both copies of a supertile sleeping under it (above).
export const SUPER_SETTLE_STEPS = 2;
const superMapGLSL = Object.entries(SUPER_MAP).map(([k, v]) => `#define SUPER_${k} ${v}`).join('\n');

// Share of a step pass's supertiles above which it draws one full-screen quad
// instead of a quad per supertile (gfx/regions.js). Measured on an M5 (ANGLE
// Metal, 128³, steps alternating between the two at the same states): a quad
// per drawn supertile costs 0.75 of one full-screen quad with 32% drawn, 0.86
// at 49%, 0.91 at 73%, 0.98 at 87%, 1.02 at 97% and 1.06 at 100%. It reaches
// the vertex shaders as a uniform (uFullShare), so a tool can move it.
export const STEP_FULL_SHARE = 0.9;
const superCount = (g) => g.stx * g.sty * g.stz;

// The supertile map (target: one texel per supertile slot, STW × the atlas's
// rows of supertiles). Needs tQuiet (this map), tPrev (the last supertile map)
// and the uniforms below.
export const superMapFrag = (g) => /* glsl */ `
${prelude(g)}
${superMapGLSL}
uniform sampler2D tQuiet;
uniform sampler2D tPrev;
uniform bool uPrevSettled;   // the last map's steps settled what slept under it (else its DRAWN carries over)
uniform bool uForceAll;      // every supertile was written since the last map by something other than a step
uniform ivec3 uForceLo;      // ...or the ones in this box (supertiles, inclusive; none if lo > hi)
uniform ivec3 uForceHi;
out vec4 oC;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int i = f.x + STW * f.y;
  oC = vec4(0.0);
  if (i >= STX * STY * STZ) return;   // a slot past the last supertile
  ivec3 s = ivec3(i % STX, i / (STX * STZ), (i / STX) % STZ), b0 = s * SUPER_B;
  bool awake = false, steps = false, blocks = false;
  // its bricks; the ones just below it, whose blocks reach into it (the grid's
  // low margin has none: blocks there belong to brick 0); and the ones just
  // above it, which its blocks reach into
  for (int z = -1; z <= SBZ; z++)
  for (int y = -1; y <= SBY; y++)
  for (int x = -1; x <= SBX; x++) {
    ivec3 l = ivec3(x, y, z), b = b0 + l;
    if (any(lessThan(b, ivec3(0))) || any(greaterThanEqual(b, ivec3(BX, BY, BZ)))) continue;
    if (texelFetch(tQuiet, brickAtlas(b), 0).x > 0.5) continue;
    bool below = any(lessThan(l, ivec3(0))), above = any(greaterThanEqual(l, SUPER_B));
    awake = awake || !above;
    blocks = blocks || !below;
    steps = steps || (!below && !above);
  }
  bool forced = uForceAll || (all(greaterThanEqual(s, uForceLo)) && all(lessThanEqual(s, uForceHi)));
  vec4 prev = texelFetch(tPrev, f, 0);
  bool drawn = awake || forced || (uPrevSettled ? prev[SUPER_AWAKE] : prev[SUPER_DRAWN]) > 0.5;
  oC[SUPER_AWAKE] = awake ? 1.0 : 0.0;
  oC[SUPER_STEPS] = steps ? 1.0 : 0.0;
  oC[SUPER_DRAWN] = drawn ? 1.0 : 0.0;
  oC[SUPER_BLOCKS] = blocks ? 1.0 : 0.0;
}
`;

// The share of supertiles on in each channel of the supertile map, in two
// passes, so no fragment sums them all (one summing 2048 cost ~0.06 ms here):
//   superRowsFrag   one texel per row of supertile slots (target: rows × 1):
//                   the supertiles on in it, per channel
//   superShareFrag  one texel: those counts summed, over the supertiles
// (Counts are whole numbers far below 2^24: exact in floats.)
const superSumsGLSL = (g) => /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 oC;
#define STW ${g.stw}                   // supertile slots per row
#define STH ${g.height / SUPER_TEX}   // rows of supertile slots
#define NSUPER ${superCount(g)}
`;
export const superRowsFrag = (g) => /* glsl */ `
${superSumsGLSL(g)}
uniform sampler2D tSuper;
void main() {
  int v = int(gl_FragCoord.x);
  vec4 n = vec4(0.0);
  for (int u = 0; u < STW; u++) n += texelFetch(tSuper, ivec2(u, v), 0);
  oC = n;
}
`;
export const superShareFrag = (g) => /* glsl */ `
${superSumsGLSL(g)}
uniform sampler2D tRows;
void main() {
  vec4 n = vec4(0.0);
  for (int v = 0; v < STH; v++) n += texelFetch(tRows, ivec2(v, 0), 0);
  oC = n / float(NSUPER);
}
`;

// regionVert's GLSL (gfx/regions.js) for a step pass: region i < NSUPER is
// supertile i, drawn where channel `ch` of the supertile map is on, over the
// state atlas (its SUPER_TEX squares; the flow field shares that layout) or,
// with block, the block atlas (shaders/common.js BLOCK_TILE: a supertile's
// home blocks fill a SUPER.x·BLOCK_TILE.x × SUPER.z·SUPER.y·BLOCK_TILE.y
// rect). Region NSUPER is the block atlas's rows for the grid's low margin,
// whose blocks exist at partition offset 1 only (needs uParity).
export function stepRegionsGLSL(g, ch, block = false) {
  const size = block ? [SUPER.x * BLOCK_TILE.x, SUPER.z * SUPER.y * BLOCK_TILE.y] : [SUPER_TEX, SUPER_TEX];
  const [w, h] = block ? [g.mwidth, g.mheight] : [g.width, g.height];
  return /* glsl */ `
#define REGION_COUNT ${superCount(g) + 1}   // the supertiles, then the block atlas's low margin
#define NSUPER ${superCount(g)}
#define STW ${g.stw}            // supertiles per atlas row
#define SUPER_CH ${ch}          // the supertile map's channel that draws a supertile (SUPER_MAP)
const vec2 TARGET = vec2(${w}.0, ${h}.0);      // texels
const vec2 SUPER_RECT = vec2(${size[0]}.0, ${size[1]}.0);   // a supertile's rect in it
uniform sampler2D tSuper;        // supertile map (shaders/activity.js superMapFrag)
uniform sampler2D tSuperShare;   // share of supertiles on in each of its channels
uniform float uFullShare;        // above this share, one full-screen quad (STEP_FULL_SHARE)
${block ? 'uniform int uParity;      // the step\'s partition offset' : ''}
float superShare() { return texelFetch(tSuperShare, ivec2(0), 0)[SUPER_CH]; }
vec2 regionTarget() { return TARGET; }
bool regionsFull() { return superShare() > uFullShare; }
bool regionOn(int i) {
  if (i == NSUPER) return ${block ? 'uParity == 1 && superShare() > 0.0' : 'false'};
  return texelFetch(tSuper, ivec2(i % STW, i / STW), 0)[SUPER_CH] > 0.5;
}
vec4 regionRect(int i) {
  ${block ? `if (i == NSUPER) return vec4(0.0, ${g.mmainh}.0, TARGET);   // (below the home blocks)` : ''}
  vec2 lo = vec2(i % STW, i / STW) * SUPER_RECT;
  return vec4(lo, lo + SUPER_RECT);
}
`;
}

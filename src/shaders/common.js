import { elementsGLSL, ELEMENTS, K } from '../elements.js';
import { incandescenceGLSL } from '../gfx/incandescence.js';
import { physicsGLSL, PHYS } from '../physics.js';

// Shared GLSL prelude. The 3D grid (NX × NY × NZ) is stored in 2D atlases and
// every pass reads cells with texelFetch through the atlas functions below, so
// there is no filtering and no precision loss.
//
// The simulation state is two textures in a brick-major atlas (atlas(),
// cellFromFrag(); docs/scaling.md D6), read only through fetchA/fetchB and
// written only through writeState (stateOutGLSL), so the texel layout and
// format can change here alone (D5; tools/check-state-access.mjs enforces it):
//   A = (element id, temperature °C, life/latent/fuel, ctype + seed)
//   B = (velocity xyz in cells/step, air pressure)
// Beside them, in the same atlas, one byte of activity flags per cell (FLAG
// below, fetchF), which the activity map reduces per brick (shaders/activity.js).
// The render fields (shaders/fields.js) keep an atlas of horizontal Y-slices,
// FTX slices per row (fieldAtlas(), fieldCellFromFrag()): hardware bilinear
// filtering works inside a slice (gfx/core.js fieldTex).
// Edge of a brick, in cells: the unit of empty-space skipping, the light and
// GI volumes, and the simulation's activity map.
export const BRICK = 4;
// State atlas: a brick is one TILE × TILE-texel tile holding its BRICK y-layers
// as a 2×2 block (cell (x, y, z) at tile texel (x + BRICK·(y & 1), z + BRICK·(y >> 1))),
// and a supertile of SUPER bricks is one SUPER_TEX-texel square (the bricks'
// tiles at (x, z + SUPER.z·y) in it). Supertiles sit row-major in the atlas,
// numbered x fastest, then z, then y. Grid sizes are multiples of SUPER_CELLS.
export const TILE = 2 * BRICK;                    // texels per brick tile edge
export const SUPER = { x: 4, y: 2, z: 2 };       // bricks per supertile along x, y, z
export const SUPER_TEX = SUPER.x * TILE;          // texels per supertile edge (= SUPER.z · SUPER.y · TILE)
export const SUPER_CELLS = { x: SUPER.x * BRICK, y: SUPER.y * BRICK, z: SUPER.z * BRICK };   // 16×8×8 cells
// A cell's random seed is the fraction of state A's w, kept below 1 so it
// never carries into the integer ctype.
export const SEED_MAX = 0.999;

// Activity flags (docs/scaling.md D8): bits of the byte each state writer
// leaves beside a cell, so the activity map (shaders/activity.js) can tell
// whether a brick is inert from 1 byte per cell instead of re-running the
// rest test on the whole state:
//   SELF    the cell's own state passes the rest test (inertSelf). Always
//           exact: whoever writes a cell evaluates it on what it writes.
//   NEAR    its neighbour test (activity.js inertNear) passed when last
//           evaluated (air passes trivially). Trusted only while nothing it
//           reads is DIRTY; the activity map redoes it otherwise.
//   MATTER  the cell holds matter, not air (air's neighbour test is empty).
//   DIRTY   since the activity map was last built, the cell changed in a
//           way its neighbours' tests read (nearChange), or a writer gave it
//           a new state A: the NEAR around it may be stale. The first step
//           after a build clears it.
export const FLAG = { SELF: 1, NEAR: 2, MATTER: 4, DIRTY: 8 };
// A neighbour test reads an air cell's temperature only through canMove's
// density test, for a powder or liquid that might fall or flow into it. Air
// is at most 1 - AIR_DENS_LO dense (airDensity), so unless some loose element
// is that light, an air cell counts only as air there, and air that warms,
// cools or swaps with other air changes no neighbour's test.
const AIR_DENS_MAX = 1 - PHYS.AIR_DENS_LO;
const AIR_T_IN_NEAR = ELEMENTS.some((e) => (e.kind === K.POWDER || e.kind === K.LIQUID) && e.dens <= AIR_DENS_MAX);

export function prelude(g) {
  return /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

#define NX ${g.nx}
#define NY ${g.ny}
#define NZ ${g.nz}
#define BS ${BRICK}
#define TILE ${TILE}         // state atlas: texels per brick tile edge
#define SBX ${SUPER.x}          // bricks per supertile along x, y, z
#define SBY ${SUPER.y}
#define SBZ ${SUPER.z}
#define STEX ${SUPER_TEX}        // texels per supertile edge
#define STX ${g.stx}          // supertiles along x, y, z
#define STY ${g.sty}
#define STZ ${g.stz}
#define STW ${g.stw}          // supertiles per atlas row
#define FTX ${g.ftx}          // field atlas: Y-slices per row
#define BX ${g.nx / BRICK}
#define BY ${g.ny / BRICK}
#define BZ ${g.nz / BRICK}
#define BTX ${g.btx}
#define MX ${g.mx}
#define MY ${g.my}
#define MZ ${g.mz}
#define MTX ${g.mtx}
${physicsGLSL()}
#define SEED_MAX ${SEED_MAX}   // a cell's random seed (the fraction in state A's w) stays below this
${Object.entries(FLAG).map(([k, v]) => `#define FLAG_${k} ${v}u`).join('\n')}
#define AIR_T_IN_NEAR ${AIR_T_IN_NEAR}   // an air cell's temperature can decide a neighbour test (see AIR_T_IN_NEAR)

${elementsGLSL()}

// State atlas (see BRICK and SUPER in shaders/common.js). A texel past the
// last supertile holds no cell: cellFromFrag gives it one outside the grid
// (inGrid is false), and atlas() maps that back to the same texel.
const ivec3 SUPER_B = ivec3(SBX, SBY, SBZ);
ivec2 atlas(ivec3 p) {
  ivec3 b = p / BS, l = p - b * BS;          // brick, and the cell in it
  ivec3 s = b / SUPER_B, k = b - s * SUPER_B;  // supertile, and the brick in it
  int i = s.x + STX * (s.z + STZ * s.y);     // supertile number
  return ivec2(i % STW, i / STW) * STEX + ivec2(k.x, k.z + SBZ * k.y) * TILE
       + ivec2(l.x + BS * (l.y & 1), l.z + BS * (l.y >> 1));
}
ivec3 cellFromFrag(ivec2 f) {
  ivec2 st = f / STEX, t = f - st * STEX;    // supertile slot, and the texel in it
  int i = st.x + STW * st.y;
  ivec3 s = ivec3(i % STX, i / (STX * STZ), (i / STX) % STZ);
  ivec2 kt = t / TILE, lt = t - kt * TILE;   // brick tile, and the texel in it
  ivec3 k = ivec3(kt.x, kt.y / SBZ, kt.y % SBZ);
  ivec3 l = ivec3(lt.x % BS, (lt.x / BS) | ((lt.y / BS) << 1), lt.y % BS);
  return (s * SUPER_B + k) * BS + l;
}
// Field atlas: Y-slice y at slice (y % FTX, y / FTX); a texel past the last
// slice gives a cell above the grid.
ivec2 fieldAtlas(ivec3 p) {
  return ivec2((p.y % FTX) * NX + p.x, (p.y / FTX) * NZ + p.z);
}
ivec3 fieldCellFromFrag(ivec2 f) {
  int tx = f.x / NX, ty = f.y / NZ;
  return ivec3(f.x - tx * NX, ty * FTX + tx, f.y - ty * NZ);
}
ivec2 brickAtlas(ivec3 b) {
  return ivec2((b.y % BTX) * BX + b.x, (b.y / BTX) * BZ + b.z);
}
ivec3 brickFromFrag(ivec2 f) {
  int tx = f.x / BX, ty = f.y / BZ;
  return ivec3(f.x - tx * BX, ty * BTX + tx, f.y - ty * BZ);
}
ivec2 blockAtlas(ivec3 b) {
  return ivec2((b.y % MTX) * MX + b.x, (b.y / MTX) * MZ + b.z);
}
ivec3 blockFromFrag(ivec2 f) {
  int tx = f.x / MX, ty = f.y / MZ;
  return ivec3(f.x - tx * MX, ty * MTX + tx, f.y - ty * MZ);
}
bool inGrid(ivec3 p) {
  return all(greaterThanEqual(p, ivec3(0))) && all(lessThan(p, ivec3(NX, NY, NZ)));
}

// ---- the state (see the top of shaders/common.js) ----
uniform sampler2D tA;
uniform sampler2D tB;
uniform highp usampler2D tF;   // activity flags (FLAG_*)
vec4 fetchA(ivec3 c) { return texelFetch(tA, atlas(c), 0); }
vec4 fetchB(ivec3 c) { return texelFetch(tB, atlas(c), 0); }
uint fetchF(ivec3 c) { return texelFetch(tF, atlas(c), 0).r; }
int eid(vec4 a) { return int(floor(a.x + 0.5)); }

// PCG hash (Jarzynski & Olano 2020, "Hash Functions for GPU Rendering"); the
// numbers are the published constants.
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
#define LCG_MUL 1664525u   // Numerical Recipes' LCG multiplier: spreads frame numbers apart
uint seed3(ivec3 p, uint frame, uint salt) {
  return pcg(uint(p.x) + pcg(uint(p.y) + pcg(uint(p.z) + pcg(frame * LCG_MUL + salt))));
}
#define UINT_TO_UNIT (1.0 / 4294967296.0)   // 2^-32: a 32-bit hash to [0, 1)
float rnd(inout uint s) {
  s = pcg(s);
  return float(s) * UINT_TO_UNIT;
}

float airDensity(float T) { return 1.0 - clamp((T - AMBIENT) / AIR_DENS_SPAN, AIR_DENS_LO, AIR_DENS_HI); }
// Gases thin with heat the way air does (ideal gas): a gas's DENS is its density
// at its spawn temperature, so hot smoke rises through the hot air around a fire.
float densityOf(int id, float T) {
  if (id == E_EMPTY) return airDensity(T);
  return KIND[id] == K_GAS ? DENS[id] * airDensity(T) / airDensity(SPAWNT[id]) : DENS[id];
}
bool isGasLike(int id) { return KIND[id] == K_GAS || id == E_EMPTY; }
bool isFluid(int id) { return KIND[id] == K_LIQUID || isGasLike(id); }
bool movable(int id) { return KIND[id] != K_SOLID; }

// Can a particle (id a, density da) move into the place of (b, db), travelling
// in direction dir (0 = down, 1 = up, 2 = sideways)? The move pass's rule;
// the react pass and the activity map ask it too, so all three agree on what
// is blocked.
bool canMove(int a, int b, float da, float db, int dir) {
  if (!movable(a) || !movable(b)) return false;
  if (a == b && a != E_EMPTY) return false;
  if (isGasLike(a) && isGasLike(b)) {
    if (dir == 0) return da > db - GAS_DENS_TOL;
    if (dir == 1) return da < db + GAS_DENS_TOL;
    return true;
  }
  if (!isFluid(a) && !isFluid(b)) return false; // grains don't sink into grains
  if (dir == 0) return da > db;
  if (dir == 1) return da != db;               // buoyant rise, or thrown upward
  return db < da;
}

// Rough blackbody colour (normalised) for a temperature in °C: Tanner Helland's
// fit (2012), in hundreds of kelvin with its knee at 6600 K; the numbers are the
// fit's coefficients.
#define C_TO_K KELVIN   // (physics.js)
vec3 blackbody(float tC) {
  float t = (tC + C_TO_K) / 100.0;
  float r = t <= 66.0 ? 1.0 : clamp(1.292936 * pow(t - 60.0, -0.1332047), 0.0, 1.0);
  float g = t <= 66.0 ? clamp(0.3900816 * log(t) - 0.6318414, 0.0, 1.0)
                      : clamp(1.1298909 * pow(t - 60.0, -0.0755148), 0.0, 1.0);
  float b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.5432068 * log(t - 10.0) - 1.1962541, 0.0, 1.0));
  return vec3(r, g * g, b * b);
}
${incandescenceGLSL()}
`;
}

// The rest test on a cell's own state (docs/scaling.md D2; the half that reads
// its neighbours is shaders/activity.js inertNear). Every state writer
// evaluates it on what it writes (FLAG_SELF); see activity.js for the rules.
export const inertSelfGLSL = /* glsl */ `
// Air's steady jitter speed: the react pass does v' = v·(1 - drag) + j with
// |j| ≤ jitter / 2, whose bound is this. Calmer than that is no wind (cells/step).
const float AIR_JITTER_V = 0.5 * JITTER[E_EMPTY] / DRAG[E_EMPTY];
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
// FLAG_SELF and FLAG_MATTER of a cell holding (a, b).
uint ownFlags(vec4 a, vec4 b) {
  return (inertSelf(a, b) ? FLAG_SELF : 0u) | (eid(a) != E_EMPTY ? FLAG_MATTER : 0u);
}
// Does a cell going from state A a0 to a1 change what its neighbours' tests
// (activity.js inertNear) read of it? Its element, and its temperature unless
// it is air (AIR_T_IN_NEAR). Its life and ctype + seed they don't read.
bool nearChange(vec4 a0, vec4 a1) {
  int i1 = eid(a1);
  return eid(a0) != i1 || (a0.y != a1.y && (i1 != E_EMPTY || AIR_T_IN_NEAR));
}
`;

// The outputs of a pass that writes the state (MRT attachments 0, 1 and 2),
// and the one way to write them: a and b in the fetchA/fetchB layout, and the
// cell's activity flags (FLAG). A pass that rewrites cells without testing
// them leaves writtenFlags (or freshFlags) for them.
export const stateOutGLSL = /* glsl */ `
layout(location = 0) out vec4 outStateA;
layout(location = 1) out vec4 outStateB;
layout(location = 2) out uint outFlags;
void writeState(vec4 a, vec4 b, uint flags) { outStateA = a; outStateB = b; outFlags = flags; }
${inertSelfGLSL}
// A cell given the state (a, b) with no neighbour test: FLAG_DIRTY has the
// activity map run the neighbour tests around it (its own included).
uint freshFlags(vec4 a, vec4 b) { return ownFlags(a, b) | FLAG_DIRTY; }
// The flags a writer leaves on a cell that held (a, b) with flags f and now
// holds (oA, oB): an untouched cell keeps its flags; a new element,
// temperature or ctype + seed is fresh (freshFlags: the cell's own neighbour
// test reads them too); a new life or state B (velocity, pressure) only
// redoes its own test, since no neighbour test reads them.
uint writtenFlags(uint f, vec4 a, vec4 b, vec4 oA, vec4 oB) {
  if (oA.xyw != a.xyw) return freshFlags(oA, oB);
  if (oA != a || oB != b) return inertSelf(oA, oB) ? f | FLAG_SELF : f & ~FLAG_SELF;
  return f;
}
`;

// main() of a pass that changes a few cells of the state and copies the rest
// through (the brush, stamps, transfers, the POV body and tools). update names
// the pass's GLSL function
//   void update(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB)
// which gets cell p's state (a, b) and leaves its new state in oA, oB (they
// start as a copy of a, b). Padding texels, which hold no cell, copy through.
// The activity flags follow (writtenFlags): the update needn't know about them.
export const copyThroughMain = (update) => /* glsl */ `
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  vec4 a = fetchA(p), b = fetchB(p);
  vec4 oA = a, oB = b;
  if (inGrid(p)) ${update}(p, a, b, oA, oB);
  writeState(oA, oB, writtenFlags(fetchF(p), a, b, oA, oB));
}
`;

// The uniforms of a pass that reads the state through the accessors above
// (fetchA, fetchB, fetchF). A pass that writes it (sim.pass) needs all three:
// it carries the activity flags through.
export const stateUniforms = () => ({ tA: { value: null }, tB: { value: null }, tF: { value: null } });

export const quadVert = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

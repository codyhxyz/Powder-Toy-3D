import { elementsGLSL, ELEMENTS, K, REACTIONS } from '../elements.js';
import { electricityGLSL, packSpark, SPARK_BORN, ELEC } from '../electricity.js';
import { incandescenceGLSL } from '../gfx/incandescence.js';
import { physicsGLSL, PHYS } from '../physics.js';
import { CELL_M } from '../scale.js';

// Shared GLSL prelude. The 3D grid (NX × NY × NZ) is stored in 2D atlases and
// every pass reads cells with texelFetch through the atlas functions below, so
// there is no filtering and no precision loss.
//
// The simulation state is one RGBA32UI texture in a brick-major atlas
// (atlas(), cellFromFrag(); docs/scaling.md D6), 16 bytes per cell packed as
// PACK below says (D7). It is read only through fetchA/fetchB, which decode it
// to two floats vectors, and written only through writeState (stateOutGLSL),
// so the texel layout and format can change here alone (D5;
// tools/check-state-access.mjs enforces it):
//   A = (element id, temperature °C, life/latent/fuel, ctype + seed)
//   B = (velocity xyz in cells/step, air pressure)
// Beside it, in the same atlas, one byte of activity flags per cell (FLAG
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
// Block atlas (the move's block results, shaders/move.js): a step's block j
// (its block coordinate less the partition offset, so its base cell is
// 2j + parity) belongs to its home brick, the one holding its base cell
// (j >> 1). A brick's 2×2×2 home blocks fill a BLOCK_TILE texel tile (block
// k = j & 1 at (k.x + 2·k.y, k.z)), and the tiles sit as the state's brick
// tiles do, supertile by supertile (blockAtlas()), so the block pass and the
// passes reading its results walk memory in the state's order. At parity 1 the
// blocks of the grid's low margin (base cell -1 on some axis) have no home
// brick: they follow in rows below, slab x = -1, then y = -1, then z = -1.
export const BLOCK_TILE = { x: 4, y: 2 };   // texels: a brick's 8 home blocks
// A cell's random seed is the fraction of state A's w, kept below 1 so it
// never carries into the integer ctype.
export const SEED_MAX = 0.999;

// The packed state (docs/scaling.md D7), one RGBA32UI texel per cell:
//   x  element id (ID_BITS) | ctype (CTYPE_BITS) | SPARE_BITS free bits |
//      seed (SEED_BITS). Ids get 8 bits (256 elements, docs/elements.md); the
//      ctype 12, since a conductor keeps its spark there (electricity.js:
//      phase + SPARK_CYCLE · level, up to SPARK_CTYPE_MAX). A block-pass slot
//      keeps its source index in the free bits (shaders/move.js). The seed
//      only varies the look (grain shapes and shades, hashed), so 9 bits
//      (512 kinds) do; main's float A.w kept 11 of them on a sparked wire.
//   y  temperature, the f32 bits: conduction's tiny fluxes must not round away
//   z  life (f16, low half) | pressure (f16, high half)
//   w  velocity, its three components sharing one exponent: a magnitude code
//      m of VEL_MANT_BITS each (x, y, z from bit 0), their signs, then the
//      exponent code e (VEL_EXP_BITS); a component is worth ±m·2^(e + VEL_KMIN)
//      (unpackVel). The exponent is the smallest whose steps hold the largest
//      component within VEL_MANT_MAX of them, so that one keeps 8 significant
//      bits (steps of 0.4–0.8% of it) at any speed from V_MAX down to 1e-9
//      cells/step, and the others take its steps. Codes evenly spaced over
//      [-V_MAX, V_MAX] (10 bits a component, as first planned) stepped 0.002,
//      coarser than REST_V, and liquids measurably spread further; a magnitude
//      quadratic in a 10-bit code (steps ~12% of the speed around REST_V)
//      still let a falling sand pile settle measurably sooner, since a held
//      cell's creep stops dead below REST_V (react.js) and rounding noise that
//      size stopped it early. Here the steps around REST_V are under 1% of it.
// The seed is the fraction of A.w in steps of 2^-SEED_BITS (exact while the
// ctype stays under 2^(24 - SEED_BITS): a float's 24 significant bits hold
// both), so a code stored as code / 2^SEED_BITS survives whole.
// Writers round life, pressure and velocity stochastically: unbiased, so
// gravity, drag, friction, heat banked as latent heat and pressure decay
// integrate without drift, where round-to-nearest would stall small
// increments (latent heat banked toward 540 in steps of 0.1 against an f16
// step of 0.25). A value already on the grid, as a reader decoded it, is kept
// exactly; so is zero, which rest states rely on. Every cell of a pass rounds
// with the same random numbers (stateOutGLSL packHere), so cells in the same
// state stay in the same state: grains falling in lockstep keep exactly equal
// velocities, as in f32, where the move pass's collision rule (which stops a
// follower closing in at any speed up to COLLIDE_V) would otherwise catch them
// on every rounding difference. Rounding each cell from its own stream slowed
// lava-frozen stone sinking in columns by 4% (tools/physics-stats.mjs).
export const PACK = {
  ID_BITS: 8,        // element id: 256 elements (docs/elements.md)
  CTYPE_BITS: 12,    // ctype: an element id, a cloud's charge, a moss's damp, or a conductor's spark (electricity.js, up to SPARK_CTYPE_MAX)
  SPARE_BITS: 3,     // free (a slot's source index: shaders/move.js)
  SEED_SHIFT: 23,    // the seed's first bit (after the spare bits)
  SEED_BITS: 9,      // the look's per-cell variety (grain shapes, shades): 512 kinds
  VEL_MANT_BITS: 8,  // a velocity component's magnitude code
  VEL_EXP_BITS: 5,   // the components' shared exponent code
};
const SEED_SCALE = 2 ** PACK.SEED_BITS;              // seed steps per unit of A.w's fraction
const VEL_MANT_MAX = 2 ** PACK.VEL_MANT_BITS - 1;    // a component's largest magnitude code
const VEL_SIGN_SHIFT = 3 * PACK.VEL_MANT_BITS;       // the x, y and z sign bits follow the magnitudes
const VEL_EXP_SHIFT = VEL_SIGN_SHIFT + 3;            // then the exponent code
// Exponent code e scales the magnitude codes by 2^(e + VEL_KMIN): the top code
// is the finest scale that still holds V_MAX within VEL_MANT_MAX steps.
const VEL_KMAX = Math.ceil(Math.log2(PHYS.V_MAX / VEL_MANT_MAX));
const VEL_KMIN = VEL_KMAX - (2 ** PACK.VEL_EXP_BITS - 1);
// Velocity rounding keeps a component on its side of REST_V while the steps
// are at most REST_V / VEL_GUARD_STEPS (packVel): exponents up to VEL_GUARD_KMAX.
const VEL_GUARD_STEPS = 16;
export const VEL_GUARD_KMAX = Math.floor(Math.log2(PHYS.REST_V / VEL_GUARD_STEPS));
const HALF_BITS = 16;   // z holds two halves: life in the low HALF_BITS, pressure above
const UINT_BITS = 32;
const FLOAT_SIGNIFICAND_BITS = 24;   // of an f32, which holds A.w = ctype + seed
const FLOAT_EXP_BIAS = 127, FLOAT_EXP_SHIFT = 23, FLOAT_EXP_MIN = -126;   // an f32's exponent field (pow2i)
if (PACK.ID_BITS + PACK.CTYPE_BITS + PACK.SPARE_BITS !== PACK.SEED_SHIFT || PACK.SEED_SHIFT + PACK.SEED_BITS !== UINT_BITS) throw new Error("PACK: x's fields must fill its 32 bits");
if (VEL_EXP_SHIFT + PACK.VEL_EXP_BITS !== UINT_BITS) throw new Error("PACK: w's fields must fill its 32 bits");
if (VEL_KMIN < FLOAT_EXP_MIN) throw new Error('PACK: the finest velocity step is no longer a normal float');
if (PACK.CTYPE_BITS + PACK.SEED_BITS > FLOAT_SIGNIFICAND_BITS) throw new Error('A.w = ctype + seed no longer fits a float exactly');
if (ELEMENTS.length > 2 ** Math.min(PACK.ID_BITS, PACK.CTYPE_BITS)) throw new Error('PACK: element ids no longer fit their fields');
// the largest ctype any rule writes: a fresh full spark (electricity.js), a cloud's charge
export const SPARK_CTYPE_MAX = packSpark(SPARK_BORN, ELEC.SPARK_V);
if (Math.max(SPARK_CTYPE_MAX, PHYS.CHARGE_MAX) >= 2 ** PACK.CTYPE_BITS) throw new Error('PACK: a ctype no longer fits its field');

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
// A reaction with air (elements.js REACTIONS naming EMPTY) reads its temperature too (its gate).
const AIR_T_IN_NEAR = ELEMENTS.some((e) => (e.kind === K.POWDER || e.kind === K.LIQUID) && e.dens <= AIR_DENS_MAX)
  || REACTIONS.some((r) => r.a === 'EMPTY' || r.b === 'EMPTY');

export function prelude(g) {
  return /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

#define NX ${g.nx}
#define NY ${g.ny}
#define NZ ${g.nz}
#define CELL_M ${CELL_M.toFixed(4)}   // metres per cell (src/scale.js)
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
#define BLK_TW ${BLOCK_TILE.x}       // block atlas: texels per brick tile, across and down
#define BLK_TH ${BLOCK_TILE.y}
#define BLK_W ${g.mwidth}       // block atlas width, and the height of its home-brick region
#define BLK_MAIN_H ${g.mmainh}
${physicsGLSL()}
#define SEED_MAX ${SEED_MAX}   // a cell's random seed (the fraction in state A's w) stays below this
${Object.entries(FLAG).map(([k, v]) => `#define FLAG_${k} ${v}u`).join('\n')}
${Object.entries(PACK).map(([k, v]) => `#define PACK_${k} ${v}u`).join('\n')}
#define SEED_SCALE ${SEED_SCALE.toFixed(1)}   // seed steps per unit of A.w's fraction
#define VEL_MANT_MASK ${VEL_MANT_MAX}u   // packed velocity (see PACK): a component's magnitude code
#define VEL_MANT_MAX ${VEL_MANT_MAX.toFixed(1)}
#define VEL_SIGN_SHIFT ${VEL_SIGN_SHIFT}u    // the sign bits, x first
#define VEL_EXP_SHIFT ${VEL_EXP_SHIFT}u     // the exponent code
#define VEL_KMIN ${VEL_KMIN}       // exponent code 0 scales by 2^VEL_KMIN
#define VEL_GUARD_KMAX ${VEL_GUARD_KMAX}   // packVel keeps components on their side of REST_V up to this exponent
#define VEL_KMAX ${VEL_KMAX}
#define FLOAT_EXP_BIAS ${FLOAT_EXP_BIAS}   // an f32's exponent field (pow2i)
#define FLOAT_EXP_SHIFT ${FLOAT_EXP_SHIFT}u
#define HALF_BITS ${HALF_BITS}u        // packed z: life in the low half, pressure in the high one
#define HALF_MASK ${2 ** HALF_BITS - 1}u
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
// Block atlas (see BLOCK_TILE in shaders/common.js): the texel of block j,
// and back (valid is false for a texel holding no block).
const ivec2 BLK_SUPER = ivec2(SBX * BLK_TW, SBZ * SBY * BLK_TH);   // texels per supertile of home blocks
const ivec3 BLK_HALF = ivec3(NX, NY, NZ) / 2;                     // home blocks per axis
ivec2 blockAtlas(ivec3 j) {
  if (all(greaterThanEqual(j, ivec3(0)))) {
    ivec3 b = j >> 1, k = j & 1;                // home brick, and the block's place in it
    ivec3 s = b / SUPER_B, kb = b - s * SUPER_B;  // supertile, and the brick in it
    int i = s.x + STX * (s.z + STZ * s.y);
    return ivec2(i % STW, i / STW) * BLK_SUPER + ivec2(kb.x, kb.z + SBZ * kb.y) * ivec2(BLK_TW, BLK_TH)
         + ivec2(k.x + 2 * k.y, k.z);
  }
  ivec3 h = BLK_HALF;
  int m = j.x < 0 ? (j.y + 1) + (h.y + 1) * (j.z + 1)
        : j.y < 0 ? (h.y + 1) * (h.z + 1) + j.x + h.x * (j.z + 1)
        : (h.y + 1) * (h.z + 1) + h.x * (h.z + 1) + j.x + h.x * j.y;
  return ivec2(m % BLK_W, BLK_MAIN_H + m / BLK_W);
}
ivec3 blockFromFrag(ivec2 f, out bool valid) {
  valid = true;
  if (f.y < BLK_MAIN_H) {
    ivec2 st = f / BLK_SUPER, t = f - st * BLK_SUPER;   // supertile slot, and the texel in it
    int i = st.x + STW * st.y;
    valid = i < STX * STY * STZ;                        // (past the last supertile: none)
    ivec3 s = ivec3(i % STX, i / (STX * STZ), (i / STX) % STZ);
    ivec2 kt = t / ivec2(BLK_TW, BLK_TH), lt = t - kt * ivec2(BLK_TW, BLK_TH);
    return (s * SUPER_B + ivec3(kt.x, kt.y / SBZ, kt.y % SBZ)) * 2 + ivec3(lt.x & 1, lt.x >> 1, lt.y);
  }
  ivec3 h = BLK_HALF;
  int m = (f.y - BLK_MAIN_H) * BLK_W + f.x, sx = (h.y + 1) * (h.z + 1), sy = h.x * (h.z + 1);
  if (m < sx) return ivec3(-1, m % (h.y + 1) - 1, m / (h.y + 1) - 1);
  m -= sx;
  if (m < sy) return ivec3(m % h.x, -1, m / h.x - 1);
  m -= sy;
  valid = m < h.x * h.y;
  return ivec3(m % h.x, m / h.x, -1);
}
bool inGrid(ivec3 p) {
  return all(greaterThanEqual(p, ivec3(0))) && all(lessThan(p, ivec3(NX, NY, NZ)));
}

// The grid is a window of the world (docs/scaling.md D11): uOrigin is the world
// cell of grid cell (0, 0, 0). Every pass works in grid cells; whatever must
// not depend on where the window is (random streams, the look) adds uOrigin.
// A grid that is its whole world sits at 0. Simulation.run sets it on every pass.
uniform ivec3 uOrigin;

// ---- the state (see the top of shaders/common.js and PACK) ----
uniform highp usampler2D tA;   // the packed state
uniform highp usampler2D tF;   // activity flags (FLAG_*)
#define ID_MASK ((1u << PACK_ID_BITS) - 1u)
#define CTYPE_MASK ((1u << PACK_CTYPE_BITS) - 1u)
vec4 unpackA(uvec4 s) {
  return vec4(float(s.x & ID_MASK), uintBitsToFloat(s.y), unpackHalf2x16(s.z).x,
              float((s.x >> PACK_ID_BITS) & CTYPE_MASK) + float(s.x >> PACK_SEED_SHIFT) / SEED_SCALE);
}
// A.w as the state stores it: the seed truncated to its SEED_BITS grid, as
// packState does. For comparing a stored cell with one computed in floats.
float storedW(float w) { float ct = floor(w); return ct + floor((w - ct) * SEED_SCALE) / SEED_SCALE; }
// 2^k, exactly (built from its bits; k must be a normal float's exponent)
float pow2i(int k) { return uintBitsToFloat(uint(k + FLOAT_EXP_BIAS) << FLOAT_EXP_SHIFT); }
// the velocity of code w (see PACK): ±m·2^(e + VEL_KMIN) a component
vec3 unpackVel(uint w) {
  vec3 m = vec3(uvec3(w, w >> PACK_VEL_MANT_BITS, w >> (2u * PACK_VEL_MANT_BITS)) & VEL_MANT_MASK);
  vec3 neg = vec3((uvec3(w) >> (VEL_SIGN_SHIFT + uvec3(0u, 1u, 2u))) & 1u);
  return (1.0 - 2.0 * neg) * m * pow2i(int(w >> VEL_EXP_SHIFT) + VEL_KMIN);
}
vec4 unpackB(uvec4 s) { return vec4(unpackVel(s.w), unpackHalf2x16(s.z).y); }
uvec4 fetchRaw(ivec3 c) { return texelFetch(tA, atlas(c), 0); }   // the packed texel, for writers to copy
vec4 fetchA(ivec3 c) { return unpackA(fetchRaw(c)); }
vec4 fetchB(ivec3 c) { return unpackB(fetchRaw(c)); }
uint fetchF(ivec3 c) { return texelFetch(tF, atlas(c), 0).r; }
int eid(vec4 a) { return int(floor(a.x + 0.5)); }
${electricityGLSL()}

// PCG hash (Jarzynski & Olano 2020, "Hash Functions for GPU Rendering"); the
// numbers are the published constants.
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
#define LCG_MUL 1664525u   // Numerical Recipes' LCG multiplier: spreads frame numbers apart
// A random stream for world cell w (seed3 for a grid cell).
uint seedWorld(ivec3 w, uint frame, uint salt) {
  return pcg(uint(w.x) + pcg(uint(w.y) + pcg(uint(w.z) + pcg(frame * LCG_MUL + salt))));
}
// ...for grid cell p: hashed at its world cell, so results don't depend on where the window is
uint seed3(ivec3 p, uint frame, uint salt) { return seedWorld(p + uOrigin, frame, salt); }
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
// The kinetic energy a hit between two cells closing at speed u dissipates:
// ½·μ·u², μ their reduced mass; against a solid (jSolid), the mover's mass.
float hitKE(float mi, float mj, bool jSolid, float u) {
  return 0.5 * (jSolid ? mi : mi * mj / (mi + mj)) * u * u;
}
// Would a hit with kinetic energy ke between cells of elements i and j set
// off an explosive on either side (elements.js blast.shock)? Cells of one
// element don't set each other off: a pool's own flow isn't a hit.
bool shockActs(int i, int j, float ke) {
  return i != j && ((BLAST[i].z > 0.0 && ke >= BLAST[i].z) || (BLAST[j].z > 0.0 && ke >= BLAST[j].z));
}
// Does a hit carrying kinetic energy ke, by a cell of element i on a solid
// of element j, do anything: break j (elements.js hard, breakInto) or set off
// an explosive? The move pass leaves such a projectile unbounced (and a
// shockActs hit between two loose cells uncollided), so the react pass sees
// the hit (react.js).
bool impactActs(int i, int j, float ke) {
  return (BREAKINTO[j] >= 0 && ke >= HARD[j]) || shockActs(i, j, ke);
}

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
  if (!electricQuiet(id, a)) return false;   // a spark, a switch turning off, a firing sensor (src/electricity.js)
  // moving, or pressure still settling (solids hold none)
  if (k != K_SOLID && (b.xyz != vec3(0.0) || abs(b.w) > REST_P)) return false;
  if (MELT[id] > 0.0 && T > MELT[id]) return false;
  if (IGNITE[id] > 0.0 && T >= IGNITE[id]) return false;   // burning, or hot enough to light the air
  // a phase change from the table (elements.js cold/hot): past its point, at
  // it with no latent heat to bank (instant), or with some banked
  if (INTO[id][PH_HOT] >= 0 && (T > HOT[id].x || (T == HOT[id].x && HOT[id].y == 0.0))) return false;
  if (INTO[id][PH_COLD] >= 0 && (T < COLD[id].x || (T == COLD[id].x && COLD[id].y == 0.0))) return false;
  if (LIFE_BANK[id] && (HOT[id].y > 0.0 || COLD[id].y > 0.0) && a.z != 0.0) return false;
  // latent heat: water and ice at rest have nothing banked and sit within their phase
  if (id == E_WATER) return a.z == 0.0 && T >= 0.0 && T <= 100.0;
  if (id == E_ICE || id == E_SNOW) return a.z == 0.0 && T <= 0.0;
  if (id == E_FUSE) return a.z >= 1.0;   // lit: burning down (react.js)
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
// it is air (AIR_T_IN_NEAR). Its ctype + seed they don't read, nor its life,
// but for a switch or powered clone going on or off (electricQuietNear, and
// the air beside a powered clone, which copies it while it is on), a fuse
// being lit (a fuse beside it reads that), and a moss or fungus cell's ctype
// (its damp).
bool nearChange(vec4 a0, vec4 a1) {
  int i1 = eid(a1);
  return eid(a0) != i1 || (a0.y != a1.y && (i1 != E_EMPTY || AIR_T_IN_NEAR))
      || (powered(i1) && (a0.z >= SWITCH_ON) != (a1.z >= SWITCH_ON))
      || (i1 == E_FUSE && (a0.z < 1.0) != (a1.z < 1.0))
      || ((i1 == E_MOSS || i1 == E_FUNGUS) && floor(a0.w) != floor(a1.w));
}
`;

// The outputs of a pass that writes the state (MRT attachments 0 and 1), and
// the ways to write them: writeState packs (a, b), in the fetchA/fetchB
// layout, rounding stochastically (PACK), and stores the cell's activity flags
// (FLAG) with FLAG_SELF taken on what it stored; writeStateRaw stores a packed
// texel as it is (a cell copied, or packed with packHere). A pass that rewrites
// cells without testing them leaves writtenFlags (or freshFlags) for them.
// uRound picks the pass's rounding stream (Simulation counts them), one for
// all its cells (see PACK).
// Packing a cell (see PACK): packState(a, b, rs) rounds stochastically from
// the random stream rs. For writers (stateOutGLSL) and the block pass, whose
// slots hold packed cells (shaders/move.js).
export const packGLSL = /* glsl */ `
// x to half precision, rounded stochastically (r uniform in [0, 1)) between
// its two neighbouring halves: the expected value is x. Returns the bits.
uint packHalfSR(float x, float r) {
  uint h = packHalf2x16(vec2(x, 0.0)) & HALF_MASK;
  float y = unpackHalf2x16(h).x;
  if (y == x) return h;
  // the neighbour on x's other side: a half's bits order its magnitude
  uint h2 = (y < x) == (x >= 0.0) ? h + 1u : h - 1u;
  return r < (x - y) / (unpackHalf2x16(h2).x - y) ? h2 : h;
}
// The velocity's code (see PACK). The exponent is the smallest whose steps
// hold the largest component within VEL_MANT_MAX of them; each component
// rounds to one of the two steps around it, the upper with probability equal
// to how far it lies toward it, so its expected value is itself. Except at
// creeping speeds (steps no coarser than REST_V / VEL_GUARD_STEPS: the largest
// component under ~0.016 cells/step), where a component stays on its side of
// REST_V: a held cell's component below REST_V stops dead (react.js), so
// rounding noise across it stopped creeping grains early (a collapsing sand
// heap's last movers, tools/physics-stats.mjs heap). In the one step that
// straddles REST_V it takes the step on its own side, a bias under
// REST_V / VEL_GUARD_STEPS, so the rest test reads as in f32. Faster cells
// round unbiased: a guard there (steps up to 4·REST_V) moved liquids measurably. Zero packs
// to 0, and a velocity on the grid to itself (as values: if rounding left the
// largest magnitude code at half the range or less, it re-packs exactly at a
// finer exponent).
uint packVel(vec3 v, inout uint rs) {
  vec3 a = min(abs(v), vec3(V_MAX));
  float top = max(a.x, max(a.y, a.z));
  if (top == 0.0) return 0u;
  int k = clamp(int(ceil(log2(top / VEL_MANT_MAX))), VEL_KMIN, VEL_KMAX);
  if (k > VEL_KMIN && top <= VEL_MANT_MAX * pow2i(k - 1)) k--;   // (log2 is approximate)
  else if (top > VEL_MANT_MAX * pow2i(k)) k++;
  uint w = uint(k - VEL_KMIN) << VEL_EXP_SHIFT;
  float s = pow2i(-k);
  for (int i = 0; i < 3; i++) {
    float x = a[i] * s, m = floor(x);   // (exact: a power-of-two scale)
    if (rnd(rs) < x - m) m += 1.0;
    // at creeping speeds, never across REST_V (see above)
    if (k <= VEL_GUARD_KMAX && (a[i] >= REST_V) != (m >= REST_V * s)) m = a[i] >= REST_V ? ceil(x) : floor(x);
    w |= uint(m) << (uint(i) * PACK_VEL_MANT_BITS);
    if (v[i] < 0.0 && m > 0.0) w |= 1u << (VEL_SIGN_SHIFT + uint(i));
  }
  return w;
}
uvec4 packState(vec4 a, vec4 b, inout uint rs) {
  float ct = floor(a.w);
  uint x = uint(eid(a)) | (uint(ct) << PACK_ID_BITS) | (uint((a.w - ct) * SEED_SCALE) << PACK_SEED_SHIFT);
  float rl = rnd(rs), rp = rnd(rs);
  return uvec4(x, floatBitsToUint(a.y), packHalfSR(a.z, rl) | (packHalfSR(b.w, rp) << HALF_BITS), packVel(b.xyz, rs));
}
`;

export const stateOutGLSL = /* glsl */ `
layout(location = 0) out uvec4 outState;
layout(location = 1) out uint outFlags;
uniform uint uRound;
#define ROUND_SALT 0x3du   // the rounding stream's salt (one stream per pass)
${inertSelfGLSL}
${packGLSL}
// (a, b) packed for this fragment's cell, from the pass's rounding stream
uvec4 packHere(vec4 a, vec4 b) {
  uint rs = pcg(uRound * LCG_MUL + ROUND_SALT);
  return packState(a, b, rs);
}
void writeStateRaw(uvec4 s, uint flags) { outState = s; outFlags = flags; }
// writeState rounding from the stream rs instead of the pass's: for a state
// that must pack the same whenever it is written (the world generator's, from
// a stream of the world cell: shaders/generate.js)
void writeStateFrom(vec4 a, vec4 b, uint flags, uint rs) {
  uvec4 s = packState(a, b, rs);
  writeStateRaw(s, (flags & ~FLAG_SELF) | (inertSelf(unpackA(s), unpackB(s)) ? FLAG_SELF : 0u));
}
void writeState(vec4 a, vec4 b, uint flags) { writeStateFrom(a, b, flags, pcg(uRound * LCG_MUL + ROUND_SALT)); }
// A cell given the state (a, b) with no neighbour test: FLAG_DIRTY has the
// activity map run the neighbour tests around it (its own included).
uint freshFlags(vec4 a, vec4 b) { return ownFlags(a, b) | FLAG_DIRTY; }
// The flags a writer leaves on a cell that held (a, b) with flags f and now
// holds (oA, oB), as stored: an untouched cell keeps its flags; a new element,
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
// An untouched cell is copied bit for bit.
export const copyThroughMain = (update) => /* glsl */ `
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  uvec4 raw = fetchRaw(p);
  vec4 a = unpackA(raw), b = unpackB(raw);
  vec4 oA = a, oB = b;
  if (inGrid(p)) ${update}(p, a, b, oA, oB);
  uint f = fetchF(p);
  if (oA == a && oB == b) { writeStateRaw(raw, f); return; }
  uvec4 s = packHere(oA, oB);
  writeStateRaw(s, writtenFlags(f, a, b, unpackA(s), unpackB(s)));
}
`;

// The uniforms of a pass that reads the state through the accessors above
// (fetchA, fetchB: tA, the packed state; fetchF: tF). A pass that writes it
// (sim.pass) needs them all and uRound (stateOutGLSL): it carries the
// activity flags through, and rounds what it writes. (tB, where the state's
// second texture was, stays for the callers that still set it.)
export const stateUniforms = () => ({ tA: { value: null }, tB: { value: null }, tF: { value: null }, uRound: { value: 0 } });

export const quadVert = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

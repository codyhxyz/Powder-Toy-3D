import { elementsGLSL } from '../elements.js';
import { incandescenceGLSL, KELVIN } from '../gfx/incandescence.js';

// Shared GLSL prelude. The 3D grid (NX × NY × NZ) is stored as a 2D atlas of
// horizontal Y-slices, TX slices per atlas row. Every pass reads cells with
// texelFetch through atlas(), so there is no filtering and no precision loss.
//
// State texture A: (element id, temperature °C, life/latent/fuel, ctype + seed)
// State texture B: (velocity xyz in cells/step, air pressure)
// Edge of a brick, in cells: the unit of empty-space skipping, the light and
// GI volumes, and the simulation's activity map.
export const BRICK = 4;
// A cell's random seed is the fraction of state A's w, kept below 1 so it
// never carries into the integer ctype.
export const SEED_MAX = 0.999;

export function prelude(g) {
  return /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

#define NX ${g.nx}
#define NY ${g.ny}
#define NZ ${g.nz}
#define TX ${g.tx}
#define BS ${BRICK}
#define BX ${g.nx / BRICK}
#define BY ${g.ny / BRICK}
#define BZ ${g.nz / BRICK}
#define BTX ${g.btx}
#define MX ${g.mx}
#define MY ${g.my}
#define MZ ${g.mz}
#define MTX ${g.mtx}
#define AMBIENT 20.0
// lava freezes back into what it melted from this far below that element's melting point (°C)
#define LAVA_FREEZE_DROP 150.0
#define TAU 6.2831853   // a full turn, radians
#define V_MAX 1.0       // cells/step: the automaton moves a cell at most one cell per step
#define TEMP_MAX 6000.0 // °C: hottest a cell can get (coldest is absolute zero, -C_TO_K)
#define SPAWN_FALL_SPEED 0.3   // cells/step: new powder or liquid (brush, clone) starts out falling
#define SEED_MAX ${SEED_MAX}   // a cell's random seed (the fraction in state A's w) stays below this

${elementsGLSL()}

ivec2 atlas(ivec3 p) {
  int s = p.y;
  return ivec2((s % TX) * NX + p.x, (s / TX) * NZ + p.z);
}
ivec3 cellFromFrag(ivec2 f) {
  int tx = f.x / NX, ty = f.y / NZ;
  return ivec3(f.x - tx * NX, ty * TX + tx, f.y - ty * NZ);
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

// Air gets lighter as it warms: density 1 at AMBIENT, changing by 1 per
// AIR_DENSITY_T °C, at most AIR_DENSER_MAX denser (cold) or AIR_LIGHTER_MAX lighter (hot).
#define AIR_DENSITY_T 2000.0
#define AIR_DENSER_MAX 0.2
#define AIR_LIGHTER_MAX 0.45
float airDensity(float T) { return 1.0 - clamp((T - AMBIENT) / AIR_DENSITY_T, -AIR_DENSER_MAX, AIR_LIGHTER_MAX); }
float densityOf(int id, float T) { return id == E_EMPTY ? airDensity(T) : DENS[id]; }
bool isGasLike(int id) { return KIND[id] == K_GAS || id == E_EMPTY; }
bool isFluid(int id) { return KIND[id] == K_LIQUID || isGasLike(id); }
bool movable(int id) { return KIND[id] != K_SOLID; }

// Rough blackbody colour (normalised) for a temperature in °C: Tanner Helland's
// fit (2012), in hundreds of kelvin with its knee at 6600 K; the numbers are the
// fit's coefficients.
#define C_TO_K ${KELVIN}
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

export const quadVert = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

import { elementsGLSL } from '../elements.js';
import { incandescenceGLSL } from '../gfx/incandescence.js';
import { physicsGLSL } from '../physics.js';

// Shared GLSL prelude. The 3D grid (NX × NY × NZ) is stored as a 2D atlas of
// horizontal Y-slices, TX slices per atlas row. Every pass reads cells with
// texelFetch through atlas(), so there is no filtering and no precision loss.
//
// State texture A: (element id, temperature °C, life/latent/fuel, ctype + seed)
// State texture B: (velocity xyz in cells/step, air pressure)
export function prelude(g) {
  return /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

#define NX ${g.nx}
#define NY ${g.ny}
#define NZ ${g.nz}
#define TX ${g.tx}
#define BS 4
#define BX ${g.nx / 4}
#define BY ${g.ny / 4}
#define BZ ${g.nz / 4}
#define BTX ${g.btx}
#define MX ${g.mx}
#define MY ${g.my}
#define MZ ${g.mz}
#define MTX ${g.mtx}
${physicsGLSL()}

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

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
uint seed3(ivec3 p, uint frame, uint salt) {
  return pcg(uint(p.x) + pcg(uint(p.y) + pcg(uint(p.z) + pcg(frame * 1664525u + salt))));
}
float rnd(inout uint s) {
  s = pcg(s);
  return float(s) * (1.0 / 4294967296.0);
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

// Rough blackbody colour (normalised) for a temperature in °C.
vec3 blackbody(float tC) {
  float t = (tC + 273.15) / 100.0;
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

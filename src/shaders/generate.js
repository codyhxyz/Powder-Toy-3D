import { prelude, stateOutGLSL } from './common.js';
import { genGLSL } from '../world/generator.js';

// Procedural world generator (docs/scaling.md D11, "Generator"): the GPU half.
// Its parameters, the stability rules it keeps and a JS twin of the height
// function live in world/generator.js; keep the two in step.
//
// Everything here is a pure function of world position and the world's
// uniforms, so any region (a window slab) generates seamlessly next to any
// other. It comes in three steps because the expensive part depends on x and
// z only:
//   - genColumn(world column): the terrain height (fBm gradient noise, domain
//     warped, under a noisy island mask) and two band noises. The column pass
//     evaluates it once per column of a region plus a COLUMN_MARGIN margin.
//   - genLayers(the heights of the column, its 8 neighbours and the columns
//     two away along each axis): which layers the column holds (sand, snow,
//     plant cover). The margin makes it the same wherever a region's edge falls.
//   - genCell(layers, world cell): the cell's state in today's layout,
//     A = (id, °C, life, ctype + seed), B = (velocity, pressure).
// generate(world cell) chains the three for a single cell, without the column
// pass (13 height evaluations: fine for a few cells, not a grid). It matches
// the fill pass in id, life and seed, and in temperature to float rounding
// (two programs may fold the frost ramp differently, ~1e-5 °C).

// Uniforms, noise, height, layers and cells: included by every pass below.
export const generatorGLSL = /* glsl */ `
${genGLSL()}
uniform uint uGenSeed;       // the world seed
uniform float uGenSea;       // sea level: cells y < this are sea where they aren't ground
uniform float uGenRelief;    // cells from sea level to the highest ground
uniform float uGenFloor;     // rock under even the deepest sea, cells
uniform vec2 uGenCenter;     // the island's centre (world cells, x and z)
uniform float uGenRadius;    // the island's radius, cells
uniform vec2 uGenAxis;       // the island's long axis (unit, x and z)
uniform float uGenStretch;   // long / wide = stretch²
uniform float uGenFeature;   // cells per feature length: the unit of every noise frequency

#define GEN_TAU 6.28318530718

// a noise field's random stream: the world seed and the field's salt
uint genStream(uint salt) { return pcg(uGenSeed + salt); }

// Gradient noise with its analytic derivatives: (value, d/dx, d/dz), value
// about ±1. Gradients are unit vectors at a hashed angle per lattice point; the
// fade is Perlin's quintic 6t⁵ - 15t⁴ + 10t³ (its published coefficients, and
// its derivative's: 30t²(t - 1)²).
vec2 genGrad(ivec2 c, uint s) {
  float a = float(pcg(uint(c.x) + pcg(uint(c.y) + s))) * UINT_TO_UNIT * GEN_TAU;
  return vec2(cos(a), sin(a));
}
vec3 genNoised(vec2 p, uint s) {
  vec2 i = floor(p), f = p - i;
  ivec2 c = ivec2(i);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = genGrad(c, s), gb = genGrad(c + ivec2(1, 0), s);
  vec2 gc = genGrad(c + ivec2(0, 1), s), gd = genGrad(c + ivec2(1, 1), s);
  float va = dot(ga, f), vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0)), vd = dot(gd, f - vec2(1.0));
  float k = va - vb - vc + vd;
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k;
  vec2 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
         + du * (u.yx * k + vec2(vb, vc) - va);
  return vec3(v, d) * GEN_NOISE_NORM;
}
// the next octave's point: turned (so the lattices never line up) and scaled
vec2 genOctave(vec2 p) {
  return GEN_LACUNARITY * (mat2(GEN_OCT_ROT_C, GEN_OCT_ROT_S, -GEN_OCT_ROT_S, GEN_OCT_ROT_C) * p);
}
// fBm, normalised to about ±1 (each octave its own stream)
float genFbm(vec2 p, uint s, int oct) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int i = 0; i < oct; i++) {
    sum += amp * genNoised(p, s + uint(i)).x;
    norm += amp; amp *= GEN_GAIN;
    p = genOctave(p);
  }
  return sum / norm;
}
// gradient-damped fBm (Quilez): an octave counts less where the ones before it
// are steep, so valleys come out smooth and crests sharp
float genErodedFbm(vec2 p, uint s, int oct) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  vec2 d = vec2(0.0);
  for (int i = 0; i < oct; i++) {
    vec3 n = genNoised(p, s + uint(i));
    d += n.yz;
    sum += amp * n.x / (1.0 + GEN_HILL_EROSION * dot(d, d));
    norm += amp; amp *= GEN_GAIN;
    p = genOctave(p);
  }
  return sum / norm;
}
// ridged fBm in [0, 1]: sharp crests where the noise crosses zero
float genRidgedFbm(vec2 p, uint s, int oct) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int i = 0; i < oct; i++) {
    float r = 1.0 - abs(genNoised(p, s + uint(i)).x);
    sum += amp * r * r;
    norm += amp; amp *= GEN_GAIN;
    p = genOctave(p);
  }
  return sum / norm;
}

// The terrain's height at world column col, in cells: the column is ground
// below it. (world/generator.js heightAt is its twin.)
float genHeight(vec2 col) {
  vec2 q = (col + 0.5) / uGenFeature;   // the column's centre, in feature lengths
  // domain warp: everything below is looked up at a displaced point
  vec2 qw = q + GEN_WARP_AMP * vec2(genFbm(q * GEN_WARP_FREQ, genStream(GEN_SALT_WARP_X), GEN_WARP_OCT),
                                    genFbm(q * GEN_WARP_FREQ, genStream(GEN_SALT_WARP_Z), GEN_WARP_OCT));
  // island mask: distance from the centre in island radii, along the long
  // axis and across it, plus coast noise
  vec2 dp = qw * uGenFeature - uGenCenter;
  vec2 ax = vec2(dot(dp, uGenAxis) / uGenStretch, (dp.y * uGenAxis.x - dp.x * uGenAxis.y) * uGenStretch);
  float r = length(ax) / uGenRadius
          + GEN_COAST_AMP * genFbm(qw * GEN_COAST_FREQ, genStream(GEN_SALT_COAST), GEN_COAST_OCT);
  float land = 1.0 - r * r + GEN_HILL_AMP * genErodedFbm(qw, genStream(GEN_SALT_HILLS), GEN_HILL_OCT);
  // cliffs: where this noise is high the shore rises (and the sea floor falls) steeply
  float cliff = smoothstep(GEN_CLIFF_EDGE_LO, GEN_CLIFF_EDGE_HI,
                           genFbm(qw * GEN_CLIFF_FREQ, genStream(GEN_SALT_CLIFF), GEN_CLIFF_OCT));
  if (land <= 0.0) return max(uGenFloor, uGenSea + land * GEN_SEA_SLOPE * (1.0 + GEN_CLIFF_SEA * cliff) * uGenRelief);
  float t = min(land / GEN_LAND_SPAN, 1.0);
  float shore = pow(t, mix(GEN_SHORE_EXP, GEN_CLIFF_EXP, cliff));
  float ridge = genRidgedFbm(qw * GEN_RIDGE_FREQ, genStream(GEN_SALT_RIDGE), GEN_RIDGE_OCT);
  float detail = genFbm(qw * GEN_DETAIL_FREQ, genStream(GEN_SALT_DETAIL), GEN_DETAIL_OCT);
  float h = (1.0 - GEN_RIDGE_AMP) * shore + GEN_RIDGE_AMP * ridge * pow(t, GEN_RIDGE_EXP);
  return uGenSea + h * uGenRelief + GEN_DETAIL_AMP * detail * t;
}

// A world column's data: x = height (cells), y = band edge noise, z = meadow
// patch noise (both about ±1), w unused.
vec4 genColumn(ivec2 col) {
  vec2 c = vec2(col);
  vec2 q = (c + 0.5) / uGenFeature;
  return vec4(genHeight(c), genFbm(q * GEN_BAND_FREQ, genStream(GEN_SALT_BAND), GEN_BAND_OCT),
              genFbm(q * GEN_PLANT_PATCH_FREQ, genStream(GEN_SALT_PATCH), GEN_PATCH_OCT), 0.0);
}

// The lowest snow (the snow line less its jitter). (world/generator.js frostLine)
float genFrostLine() { return uGenSea + GEN_SNOW_LINE * uGenRelief - GEN_SNOW_JITTER; }

// What a column holds, top down: ground is the number of ground cells (y <
// ground), of which the top sand (or snow) cells are sand (snow), and the top
// one is plant cover if plant.
struct GenLayers { int ground; int sand; int snow; bool plant; };

// h[i]: heights of the columns (x + i % 3 - 1, z + i / 3 - 1), so h[4] is the
// column itself; far: heights two columns away, at x - 2, x + 2, z - 2, z + 2;
// band, meadow: its band and meadow patch noise (genColumn y, z).
GenLayers genLayers(float h[9], vec4 far, float band, float meadow) {
  int G[9];
  for (int i = 0; i < 9; i++) G[i] = int(floor(h[i] + 0.5));
  GenLayers L;
  L.ground = G[4];
  L.sand = 0; L.snow = 0; L.plant = false;
  // powders stay put only on columns at most a step above each neighbour (the angle of repose)
  int drop = 0;
  for (int i = 0; i < 9; i++) drop = max(drop, L.ground - G[i]);
  bool stable = drop <= GEN_POWDER_STEP_MAX;
  // The sea's flow knocks a grain in the water from the side, away from the
  // water beside it (move.js collisions are along an axis). It moves if there
  // is water beyond it, or shoves the grain next to it (only that one: the
  // shove dies there) into water beyond that. So no sand in the water where a
  // lower column on one side faces one on the other within two columns.
  ivec4 F = ivec4(floor(far + 0.5));
  bvec4 lowFar = lessThan(F, ivec4(L.ground));
  bool lxm = G[3] < L.ground, lxp = G[5] < L.ground, lzm = G[1] < L.ground, lzp = G[7] < L.ground;
  bool knocked = float(L.ground) <= uGenSea
              && ((lxm && (lxp || lowFar.y)) || (lxp && lowFar.x) || (lzm && (lzp || lowFar.w)) || (lzp && lowFar.z));
  float slope = 0.5 * length(vec2(h[5] - h[3], h[7] - h[1]));   // cells per cell
  float g = float(L.ground), sea = uGenSea;
  bool beach = g >= sea - GEN_BEACH_BELOW && g <= sea + GEN_BEACH_ABOVE + GEN_BEACH_JITTER * band
            && slope < GEN_BEACH_SLOPE_MAX && !knocked;
  bool snow = g >= genFrostLine() + GEN_SNOW_JITTER * (1.0 + band) && slope < GEN_SNOW_SLOPE_MAX;
  if (stable && beach) L.sand = GEN_SAND_DEPTH;
  else if (stable && snow) L.snow = GEN_SNOW_DEPTH;
  else L.plant = g >= sea + GEN_PLANT_ABOVE && g <= genFrostLine() - GEN_PLANT_SNOW_GAP - GEN_PLANT_JITTER * (1.0 + band) * 0.5
              && slope < GEN_PLANT_SLOPE_MAX && meadow > GEN_PLANT_PATCH_CUT;
  return L;
}

// Rock is frozen to the snow's temperature from FROST_DEPTH cells below the
// lowest snow up, and warms to ambient over FROST_SPAN cells below that, so
// snow lies on a cold slab that the warm rock under it takes long to reach:
// 0 warm, 1 frozen.
float genFrost(int y) {
  return clamp((float(y) - genFrostLine() + GEN_FROST_DEPTH + GEN_FROST_SPAN) / GEN_FROST_SPAN, 0.0, 1.0);
}

// The element at world height y of a column.
int genId(GenLayers L, int y) {
  if (y >= L.ground) return float(y) < uGenSea ? E_WATER : E_EMPTY;
  int depth = L.ground - 1 - y;   // 0: the top ground cell
  if (depth < L.sand) return E_SAND;
  if (depth < L.snow) return E_SNOW;
  if (depth == 0 && L.plant) return E_PLANT;
  return E_ROCK;
}

// The state of world cell w in a column with layers L: its element at its
// spawn temperature and life (rock frozen near the snow), at rest, with a
// colour seed hashed from its world position.
void genCell(GenLayers L, ivec3 w, out vec4 A, out vec4 B) {
  int id = genId(L, w.y);
  float T = id == E_ROCK ? mix(SPAWNT[E_ROCK], SPAWNT[E_SNOW], genFrost(w.y)) : SPAWNT[id];
  float seed = float(seedWorld(w, uGenSeed, GEN_SALT_CELL)) * UINT_TO_UNIT * SEED_MAX;
  A = vec4(float(id), T, SPAWNLIFE[id], seed);
  B = vec4(0.0);
}

// One cell from scratch, without the column pass.
void generate(ivec3 w, out vec4 A, out vec4 B) {
  float h[9];
  for (int i = 0; i < 9; i++) h[i] = genHeight(vec2(w.x + i % 3 - 1, w.z + i / 3 - 1));
  vec4 far = vec4(genHeight(vec2(w.x - 2, w.z)), genHeight(vec2(w.x + 2, w.z)),
                  genHeight(vec2(w.x, w.z - 2)), genHeight(vec2(w.x, w.z + 2)));
  vec4 c = genColumn(w.xz);
  genCell(genLayers(h, far, c.y, c.z), w, A, B);
}
`;

// Columns around a column that genLayers reads, on each side.
export const COLUMN_MARGIN = 2;

// Column pass: genColumn for one region of world columns, one texel each
// (RGBA32F): texel (i, j) is world column uColOrigin + (i, j). The fill and
// summary passes read a grid's columns plus COLUMN_MARGIN on every side, so
// their target is (NX + 2·margin) × (NZ + 2·margin), with uColOrigin = the
// grid's origin less the margin.
export const columnFrag = (g) => /* glsl */ `
${prelude(g)}
${generatorGLSL}
uniform ivec2 uColOrigin;
out vec4 oC;
void main() {
  oC = genColumn(uColOrigin + ivec2(gl_FragCoord.xy));
}
`;

// Reads the layers of grid column c (window-local x, z) from the column
// texture (tCol: the grid's columns plus the margin).
const layersGLSL = /* glsl */ `
uniform sampler2D tCol;
#define COLUMN_MARGIN ${COLUMN_MARGIN}
float colHeight(ivec2 c) { return texelFetch(tCol, c + COLUMN_MARGIN, 0).x; }
GenLayers columnLayers(ivec2 c) {
  float h[9];
  for (int i = 0; i < 9; i++) h[i] = colHeight(c + ivec2(i % 3 - 1, i / 3 - 1));
  vec4 far = vec4(colHeight(c - ivec2(2, 0)), colHeight(c + ivec2(2, 0)),
                  colHeight(c - ivec2(0, 2)), colHeight(c + ivec2(0, 2)));
  vec4 col = texelFetch(tCol, c + COLUMN_MARGIN, 0);
  return genLayers(h, far, col.y, col.z);
}
`;

// Fill pass: writes the generated state of every cell of the grid inside
// [uFillMin, uFillMax) (window-local cells) and keeps the rest, so it can
// fill the slab a window shift uncovers as well as the whole grid. uOrigin
// (the prelude's) is the world cell of the grid's cell (0, 0, 0).
export const fillFrag = (g) => /* glsl */ `
${prelude(g)}
${generatorGLSL}
${layersGLSL}
uniform ivec3 uFillMin;
uniform ivec3 uFillMax;
${stateOutGLSL}

void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  vec4 a = fetchA(p), b = fetchB(p);
  uint f = fetchF(p);
  // padding texels (no cell) and cells outside the fill region copy through
  if (!inGrid(p) || any(lessThan(p, uFillMin)) || any(greaterThanEqual(p, uFillMax))) { writeState(a, b, f); return; }
  vec4 A, B;
  genCell(columnLayers(p.xz), uOrigin + p, A, B);
  writeState(A, B, writtenFlags(f, a, b, A, B));
}
`;

// Brick summary, for the far field (docs/scaling.md D11, "Far field": its
// world-sized brick grid is built from this). One RGBA8 texel per 4³ brick of
// the grid, laid out like the other brick targets (brickAtlas):
//   r  dominant element id / 255: the most common matter (not air or gas),
//      a cell open to the air above counting SUMMARY_SURFACE_W times, so a
//      brick reads as its surface (grass on rock reads as grass)
//   g  solid fraction: cells of solids and powders, which stop a ray
//   b  liquid fraction
//   a  glow: 0 (the generator makes nothing hot; leaving slabs fill it in)
export const SUMMARY_SURFACE_W = 8;
export const summaryFrag = (g) => /* glsl */ `
${prelude(g)}
${generatorGLSL}
${layersGLSL}
out vec4 oC;
#define SUMMARY_SURFACE_W ${SUMMARY_SURFACE_W.toFixed(1)}
#define ID_SCALE 255.0   // an element id in an 8-bit channel
void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  oC = vec4(0.0);
  if (bc.y >= BY) return;
  float weight[NE];
  for (int i = 0; i < NE; i++) weight[i] = 0.0;
  float solid = 0.0, liquid = 0.0;
  ivec3 o = bc * BS;
  for (int z = 0; z < BS; z++)
  for (int x = 0; x < BS; x++) {
    GenLayers L = columnLayers(o.xz + ivec2(x, z));
    int above = genId(L, uOrigin.y + o.y + BS);   // the cell over the brick's top layer
    for (int y = BS - 1; y >= 0; y--) {
      int id = genId(L, uOrigin.y + o.y + y);
      int k = KIND[id];
      if (k == K_SOLID || k == K_POWDER) solid += 1.0;
      else if (k == K_LIQUID) liquid += 1.0;
      if (id != E_EMPTY && k != K_GAS) weight[id] += above == E_EMPTY ? SUMMARY_SURFACE_W : 1.0;
      above = id;
    }
  }
  int best = E_EMPTY;
  for (int i = 0; i < NE; i++) if (weight[i] > weight[best]) best = i;
  float cells = float(BS * BS * BS);
  oC = vec4(float(best) / ID_SCALE, solid / cells, liquid / cells, 0.0);
}
`;

// Diff pass, over a slab about to leave the window (docs/scaling.md D11,
// "Leaving slabs"): one texel per brick of grid cells [uLo, uLo + 4·uBricks),
// DIFF_W per row in slab-brick order (shaders/window.js), r = 1 where the brick
// differs from what the generator makes there, so world/window.js keeps it.
// Air counts as unchanged while it is still air within AIR_REST_T of the
// generator's temperature: its seed, velocity and pressure don't matter.
// Matter needs the same element, ctype and seed (state A's w holds both),
// life within STORE_LIFE_TOL and temperature within STORE_MATTER_T; its
// velocity and pressure are ignored too. uOrigin (the prelude's) is the
// window's, and tCol its columns.
export const STORE_MATTER_T = 0.5;   // °C: drift a regenerated brick may lose (it is still quiet: well under AIR_REST_T)
export const STORE_LIFE_TOL = 1e-4;  // life/latent/fuel units: float slop only (life changes by reactions)
export const DIFF_W = 64;            // texels per row of the diff target
export const diffFrag = (g) => /* glsl */ `
${prelude(g)}
${generatorGLSL}
${layersGLSL}
uniform ivec3 uLo;       // the slab's low corner, grid cells (brick-aligned)
uniform ivec3 uBricks;   // the slab's size in bricks
out vec4 oC;
#define DIFF_W ${DIFF_W}
#define STORE_MATTER_T ${STORE_MATTER_T}
#define STORE_LIFE_TOL ${STORE_LIFE_TOL}
bool cellDiffers(vec4 a, vec4 gen) {
  int id = eid(a);
  if (id != eid(gen)) return true;
  if (id == E_EMPTY) return abs(a.y - gen.y) > AIR_REST_T;
  return a.w != gen.w || abs(a.y - gen.y) > STORE_MATTER_T || abs(a.z - gen.z) > STORE_LIFE_TOL;
}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int i = f.x + DIFF_W * f.y;
  ivec3 b = ivec3(i % uBricks.x, (i / uBricks.x) % uBricks.y, i / (uBricks.x * uBricks.y));
  oC = vec4(0.0);
  if (b.z >= uBricks.z) return;
  ivec3 o = uLo + b * BS;
  bool diff = false;
  for (int z = 0; z < BS && !diff; z++)
  for (int x = 0; x < BS && !diff; x++) {
    GenLayers L = columnLayers(o.xz + ivec2(x, z));
    for (int y = 0; y < BS; y++) {
      ivec3 p = o + ivec3(x, y, z);
      vec4 gA, gB;
      genCell(L, uOrigin + p, gA, gB);
      if (cellDiffers(fetchA(p), gA)) { diff = true; break; }
    }
  }
  oC = vec4(diff ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}
`;

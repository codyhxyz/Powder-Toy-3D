import * as THREE from 'three';
import { rawMat, makeFieldTarget, gridLayout } from '../../sim.js';
import { prelude, SUPER_CELLS } from '../../shaders/common.js';
import { helpersGLSL, groundScan } from './themedShared.js';
import {
  worldParams, heightAt, islandTwin, islandParamValues, islandDefinesGLSL, treesIn,
  ISLAND_COLUMN_SRC, ISLAND_CELL_SRC, ISLAND_HEAD_GLSL, COLUMN_MARGIN,
} from '../generator.js';

// The island: the generator's own world (world/generator.js), an ordinary
// scene. Its source is written once (generator.js ISLAND_COLUMN_SRC and
// ISLAND_CELL_SRC, with the hooks in world/island); here are its GPU parts:
//   - the column bake (IslandColumns): the column stage over every world
//     column plus COLUMN_MARGIN, into a texture (RGBA32F: height, band noise,
//     meadow noise, water level), once per world, in prepare;
//   - sceneCell: the cell stage reading that texture, then the cell's state;
//   - its trees (scene.trees): treesIn on the CPU, which the window stamps as
//     constructions, and the far field's GPU twin of its candidates.
// The box's Island preset is the same scene over a world the size of the box,
// with snow (world/gpu.js IslandGenerator).

// It starts where the most is going on: on the shore the god view looks from
// (app.js WORLD_VIEW_DIR, across x and z), the sea in front, then beach,
// meadows and trees, and the hills behind. Found by walking from the island's
// centre toward the camera to the waterline, START_STEP at a time, then this
// share of the window's width back inland.
export const ISLAND_VIEW_XZ = [11, 13];   // the god view's direction across the ground (app.js WORLD_VIEW_DIR's x, z)
const START_STEP = 16;                    // cells per step of the walk (a window step, world/window.js WIN_STEP)
const START_INLAND = 0.25;                // share of the window's width inland from the waterline
// Far field chunks a frame while it builds (world/far.js): the island's cells
// cost a texel fetch or a few, so its 256 chunks (~0.3–0.6 ms of GPU each, M5)
// go in 4 frames, the far field complete about as soon after load as when it
// was built in one pass.
const FAR_CHUNKS_PER_FRAME = 64;

// ---------------------------------------------------------------- GLSL
// The world's parameters (generator.js islandParamValues) and seed.
const paramsGLSL = /* glsl */ `
uniform float uGenSea;       // sea level: cells y < this are sea where they aren't ground
uniform float uGenRelief;    // cells from sea level to the highest ground
uniform float uGenFloor;     // rock under even the deepest sea, cells
uniform float uGenCenterX;   // the island's centre (world cells)
uniform float uGenCenterZ;
uniform float uGenRadius;    // the island's radius, cells
uniform float uGenAxisX;     // the island's long axis (unit)
uniform float uGenAxisZ;
uniform float uGenStretch;   // long / wide = stretch²
uniform float uGenFeature;   // cells per feature length: the unit of every noise frequency
uniform bool uGenSnow;       // snow caps on frozen rock (false: bare rock peaks, nothing frozen)
#define GEN_COLUMN_MARGIN ${COLUMN_MARGIN}   // the baked columns reach this far past the world's edge
`;
// (helpersGLSL declares uSceneSeed, the world seed; ISLAND_HEAD_GLSL the hooks' uniforms)
const sourceHead = () => `${islandDefinesGLSL()}\n${helpersGLSL}\n${paramsGLSL}\n${ISLAND_HEAD_GLSL}`;

// The column bake: texel (i, j) is world column (i, j) less the margin. Its
// program needs no grid; the prelude's constants are a supertile's.
const BAKE_GRID = gridLayout(SUPER_CELLS.x, SUPER_CELLS.y, SUPER_CELLS.z);
export const islandColumnFrag = () => /* glsl */ `
${prelude(BAKE_GRID)}
${sourceHead()}
${ISLAND_COLUMN_SRC}
out vec4 oC;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) - GEN_COLUMN_MARGIN;
  float x = float(c.x), z = float(c.y), h = genColumnHeight(x, z);
  oC = vec4(h, genBand(x, z), genMeadow(x, z, h), genWater(x, z, h));
}
`;

// The scene's GLSL: the cell stage over the baked columns (tIslandCol), and sceneCell.
export const islandGLSL = () => /* glsl */ `
${sourceHead()}
uniform sampler2D tIslandCol;   // the world's columns (IslandColumns): height, band, meadow, water level
vec4 genCol(int x, int z) {
  return texelFetch(tIslandCol, clamp(ivec2(x, z) + GEN_COLUMN_MARGIN, ivec2(0), textureSize(tIslandCol, 0) - 1), 0);
}
float genColHeight(int x, int z) { return genCol(x, z).x; }
float genColBand(int x, int z) { return genCol(x, z).y; }
float genColMeadow(int x, int z) { return genCol(x, z).z; }
float genColWater(int x, int z) { return genCol(x, z).w; }
${ISLAND_CELL_SRC}
// World cell w's element at its spawn temperature and life, at rest, with a
// colour seed hashed from its world position. Under snow the ground's solids
// (but plant cover) are frozen near the snow line (genFrost).
void sceneCell(ivec3 w, out vec4 A, out vec4 B) {
  int id = islandCell(w.x, w.y, w.z);
  float T = uGenSnow && KIND[id] == K_SOLID && id != E_PLANT ? mix(SPAWNT[id], SPAWNT[E_SNOW], genFrost(w.y)) : SPAWNT[id];
  float seed = float(seedWorld(w, uSceneSeed, GEN_SALT_CELL)) * UINT_TO_UNIT * SEED_MAX;
  A = vec4(float(id), T, SPAWNLIFE[id], seed);
  B = vec4(0.0);
}
`;

// The far field's twin of treesIn's candidates (scene.trees.glsl: after the
// scene's GLSL and shaders/far.js treeGLSL). The hash chain is treeCandidate's
// (world/generator.js), the ground check the source's genTreeZone.
const islandTreesGLSL = /* glsl */ `
uint islandTreeHash(ivec2 bc) { return pcg(uint(bc.x) + pcg(uint(bc.y) + pcg(uSceneSeed + GEN_SALT_TREE))); }
vec4 sceneTreeCandidate(ivec2 bc) {
  uint h = islandTreeHash(bc);
  if (float(h & 0xffffu) * TREE_UNIT16 >= TREE_CHANCE) return vec4(0.0);
  uint h2 = pcg(h), h3 = pcg(h2);
  ivec2 o = ivec2(int(h2 & uint(BS - 1)), int((h2 >> 2u) & uint(BS - 1)));
  ivec2 col = bc * BS + o;
  int zone = genTreeZone(col.x, col.y);
  if (zone == GEN_ZONE_NONE) return vec4(0.0);
  int variant = treeVariant(zone == GEN_ZONE_PALM, zone == GEN_ZONE_HIGH, float(h3 & 0xffffu) * TREE_UNIT16);
  int size = int((h3 >> 16u) % uint(TREE_SIZES));
  return vec4(float(1 + o.x + BS * o.y + BS * BS * (variant + TREE_VARIANTS * size)), float(genTop(col.x, col.y)),
              float(h2 >> 8u), 0.0);
}
uint sceneTreeKey(ivec2 bc) { return pcg(pcg(islandTreeHash(bc))); }
`;

// ---------------------------------------------------------------- uniforms
// The island's uniforms for world P, its columns' texture tex (null until baked).
export function islandUniforms(P, tex = null) {
  const u = { uSceneSeed: { value: 0 }, tIslandCol: { value: null } };
  for (const k of Object.keys(islandParamValues(P))) u[k] = { value: 0 };
  return setIslandUniforms(u, P, tex);
}
export function setIslandUniforms(u, P, tex) {
  u.uSceneSeed.value = P.seed;
  for (const [k, v] of Object.entries(islandParamValues(P))) u[k].value = v;
  u.tIslandCol.value = tex;
  return u;
}

// ---------------------------------------------------------------- the column bake
// A world's columns baked on the GPU (islandColumnFrag), kept for one world
// at a time (bake again for another). P: a world, for the uniforms' first values.
export class IslandColumns {
  constructor(P) {
    this.target = null;
    this.key = '';
    this.mat = rawMat(islandColumnFrag(), islandUniforms(P));
    this.mat.name = 'islandColumns';
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  // The texture world P's columns are baked in (null if they aren't).
  textureFor(P) { return this.key === JSON.stringify(P) ? this.target.texture : null; }

  // Compile the bake's program without stalling (KHR_parallel_shader_compile where there is one).
  compile(renderer) { return renderer.compileAsync(this.scene, this.camera); }

  // Bake world P's columns (synchronous GPU work; the program compiles now if
  // compile hasn't). Leaves the render target and autoClear as they were.
  bake(renderer, P) {
    const key = JSON.stringify(P);
    if (key === this.key) return this.target.texture;
    const w = P.size[0] + 2 * COLUMN_MARGIN, h = P.size[2] + 2 * COLUMN_MARGIN;
    if (!this.target || this.target.width !== w || this.target.height !== h) {
      this.target?.dispose();
      this.target = makeFieldTarget(w, h, 1, THREE.FloatType, THREE.NearestFilter);
    }
    setIslandUniforms(this.mat.uniforms, P, null);
    const before = renderer.getRenderTarget(), autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(before);
    renderer.autoClear = autoClear;
    this.key = key;
    return this.target.texture;
  }

  dispose() {
    this.target?.dispose();
    this.target = null;
    this.key = '';
    this.mat.dispose();
    this.quad.geometry.dispose();
  }
}

// The world's baked columns (prepare), for one world at a time.
let worldColumns = null;

// ---------------------------------------------------------------- the scene
export const island = {
  key: 'island',
  label: 'Island',
  params: ({ size, seed }) => worldParams({ size, seed, snow: false }),
  glsl: () => islandGLSL(),
  uniforms: (P) => islandUniforms(P, worldColumns?.textureFor(P) ?? null),
  prepare: async (renderer, P) => {
    worldColumns ??= new IslandColumns(P);
    const cols = worldColumns;
    await cols.compile(renderer);
    if (cols === worldColumns) cols.bake(renderer, P);   // (not if disposed meanwhile)
  },
  dispose() {
    worldColumns?.dispose();
    worldColumns = null;
  },
  start(P, win) {
    const len = Math.hypot(...ISLAND_VIEW_XZ), d = ISLAND_VIEW_XZ.map((v) => v / len);
    const at = (r) => [P.center[0] + d[0] * r, P.center[1] + d[1] * r];
    let r = 0;
    while (r < Math.max(P.size[0], P.size[2]) / 2 && heightAt(...at(r), P) >= P.sea) r += START_STEP;
    return at(r - START_INLAND * Math.max(...win));
  },
  // the top of the topmost ground or water in the column, as islandCell makes it
  ground(x, z, P) {
    const T = islandTwin(P), xi = Math.floor(x), zi = Math.floor(z);
    return groundScan(T.islandCell, xi, zi, Math.max(T.genTop(xi, zi), Math.ceil(T.column(xi, zi)[3])));
  },
  trees: { treesIn, glsl: islandTreesGLSL },
  farChunksPerFrame: FAR_CHUNKS_PER_FRAME,
};

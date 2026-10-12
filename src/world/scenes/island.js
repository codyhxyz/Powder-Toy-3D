import { prelude, SUPER_CELLS } from '../../shaders/common.js';
import { gridLayout } from '../../sim.js';
import { helpersGLSL, groundScan } from './themedShared.js';
import { toWgsl } from './subsetWgsl.js';
import { sceneStruct, sceneHeadWGSL, vec4s, preMainWGSL, preReadWGSL, PRE_MARGIN } from './sceneGpu.js';
import { MAX_FOOT } from '../../constructions/runtime.js';
import {
  worldParams, heightAt, islandTwin, WORLD_SEED, islandParamValues, islandDefinesGLSL, islandDefinesTypes, treesIn,
  ISLAND_COLUMN_SRC, ISLAND_CELL_SRC, ISLAND_HEAD_GLSL, COLUMN_MARGIN,
} from '../generator.js';
import { landforms } from '../island/landforms.js';
import { STRUCT_GLSL, STRUCT_FIELDS, structureWords, disposeStructureTextures, structuresReady } from '../structures.js';
import { bakeFor } from '../bake.js';

// The island: the generator's own world (world/generator.js), an ordinary
// scene. Its source is written once (generator.js ISLAND_COLUMN_SRC and
// ISLAND_CELL_SRC, with the hooks in world/island); here are its GPU parts
// (WGSL from the same source: scenes/subsetWgsl.js):
//   - the column bake (scene.bake): the column stage over every world column
//     plus COLUMN_MARGIN, into the start of the scene's data
//     (scenes/sceneGpu.js SD: height, band noise, meadow noise, water level),
//     once per world, before its first fill (world/gpu.js SceneGpu);
//   - the prepass (scene.pre): the island before nature (islandCellBare,
//     the caves in it) over the region a sceneCell kernel covers, into the
//     data, so nature and the structures' footings read it there instead of
//     inlining the caves at each of their calls (scenes/sceneGpu.js);
//   - sceneCell: the cell stage reading those columns and that prepass, then
//     the cell's state;
//   - its trees (scene.trees): treesIn on the CPU, which the window stamps as
//     constructions, and the far field's GPU twin of its candidates;
//   - its structures (world/structures.js): houses, villages, docks, towers,
//     placed from the seed and drawn by sceneCell over its own cells (the
//     World's island has them, P.structures; the box's Island preset doesn't),
//     from the scene's data after the columns.
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
const START_WIN = [128, 128];             // the World's window, x and z (app.js WORLDS.world.win): its shrine is placed near its start
// Far field chunks a frame while it builds (world/far.js): the island's cells
// cost a texel fetch or a few, so its 256 chunks (~0.3–0.6 ms of GPU each, M5)
// go in 4 frames, the far field complete about as soon after load as when it
// was built in one pass.
const FAR_CHUNKS_PER_FRAME = 64;

// ---------------------------------------------------------------- WGSL
// The world's parameters (generator.js islandParamValues), its baked columns'
// extent, its structures' data and its landforms' sites: the scene's uniform
// struct (scenes/sceneGpu.js), the world seed first.
const ISLAND_FIELDS = {
  uGenSea: 'f32',        // sea level: cells y < this are sea where they aren't ground
  uGenRelief: 'f32',     // cells from sea level to the highest ground
  uGenFloor: 'f32',      // rock under even the deepest sea, cells
  uGenCenterX: 'f32',    // the island's centre (world cells)
  uGenCenterZ: 'f32',
  uGenRadius: 'f32',     // the island's radius, cells
  uGenAxisX: 'f32',      // the island's long axis (unit)
  uGenAxisZ: 'f32',
  uGenStretch: 'f32',    // long / wide = stretch²
  uGenFeature: 'f32',    // cells per feature length: the unit of every noise frequency
  uGenSnow: 'bool',      // snow caps on frozen rock (false: bare rock peaks, nothing frozen)
  uColW: 'i32',          // the baked columns (from SD's start): world x and z plus the margin on both sides
  uColH: 'i32',
  uPreAt: 'u32',         // the prepass region's first vec4 in SD (world/gpu.js SceneGpu sets it)
  ...STRUCT_FIELDS,
  ...landforms.fields,
};
export const ISLAND_U = sceneStruct(ISLAND_FIELDS);
// what the subset reads besides itself: the constants, the uniforms, the hooks' accessors and the columns
const SUBSET_ENV = () => ({
  consts: { ...islandDefinesTypes(), GEN_COLUMN_MARGIN: 'i32' },
  uniforms: ISLAND_U.sceneTypes,
  externs: {
    ...landforms.externs,
    genColHeight: ['f32', true], genColBand: ['f32', true], genColMeadow: ['f32', true], genColWater: ['f32', true],
  },
});
// The columns' extent for world P: its columns plus COLUMN_MARGIN on every side.
const columnsSize = (P) => [P.size[0] + 2 * COLUMN_MARGIN, P.size[2] + 2 * COLUMN_MARGIN];
// (helpersGLSL reads the world seed from SU; ISLAND_HEAD_GLSL holds the hooks' accessors)
const sourceHead = () => `${islandDefinesGLSL()}
const GEN_COLUMN_MARGIN: i32 = ${COLUMN_MARGIN};   // the baked columns reach this far past the world's edge
${helpersGLSL}
${ISLAND_HEAD_GLSL}`;
let columnWgsl = null, cellWgsl = null;   // (the source's WGSL, made once)

// The column bake, a compute kernel: column (i, j) of the scene's columns
// (SD's first vec4s, written here) is world column (i, j) less the margin.
// It needs no grid; the prelude's constants are a supertile's.
const BAKE_GRID = gridLayout(SUPER_CELLS.x, SUPER_CELLS.y, SUPER_CELLS.z);
export const ISLAND_BAKE_WORKGROUP = 8;   // threads along x and z (64 a workgroup: W22)
export const islandColumnFrag = () => /* wgsl */ `
${prelude(BAKE_GRID, { state: false })}
${sceneHeadWGSL(ISLAND_U, { data: true, access: 'read_write' })}
${sourceHead()}
${columnWgsl ??= toWgsl(ISLAND_COLUMN_SRC, SUBSET_ENV())}
@compute @workgroup_size(${ISLAND_BAKE_WORKGROUP}, ${ISLAND_BAKE_WORKGROUP}, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (i32(id.x) >= SU.uColW || i32(id.y) >= SU.uColH) { return; }
  let c = vec2i(id.xy) - GEN_COLUMN_MARGIN;
  let x = f32(c.x);
  let z = f32(c.y);
  let h = genColumnHeight(x, z);
  SD[id.x + u32(SU.uColW) * id.y] = bitcast<vec4u>(vec4f(h, genBand(x, z), genMeadow(x, z, h), genWater(x, z, h)));
}
`;

// The cell stage's WGSL, reading the baked columns: with the island before
// nature computed here (direct: the prepass, the far field's tree
// candidates) or read from the prepass (every sceneCell kernel).
const cellPartWGSL = (direct) => {
  cellWgsl ??= toWgsl(ISLAND_CELL_SRC, SUBSET_ENV());
  return /* wgsl */ `
// world column (x, z)'s baked column (height, band, meadow, water level), held to the baked extent
fn genCol(x: i32, z: i32) -> vec4f {
  let c = clamp(vec2i(x, z) + GEN_COLUMN_MARGIN, vec2i(0), vec2i(SU.uColW, SU.uColH) - 1);
  return bitcast<vec4f>(SD[c.x + SU.uColW * c.y]);
}
fn genColHeight(x: i32, z: i32) -> f32 { return genCol(x, z).x; }
fn genColBand(x: i32, z: i32) -> f32 { return genCol(x, z).y; }
fn genColMeadow(x: i32, z: i32) -> f32 { return genCol(x, z).z; }
fn genColWater(x: i32, z: i32) -> f32 { return genCol(x, z).w; }
${direct ? cellWgsl : `${cellWgsl.replace('fn islandCellBare(', 'fn islandCellBareDirect(')}
// (the island before nature, from the prepass)
${preReadWGSL('islandCellBare')}`}
${STRUCT_GLSL}
// (the island before nature.js: what it changes bears weight before and after)
fn structureGround(w: vec3i) -> i32 { return islandCellBare(w.x, w.y, w.z); }`;
};

// The prepass (scene.pre): the island before nature at each cell of the region.
export const islandPreFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${sceneHeadWGSL(ISLAND_U, { data: true, access: 'read_write' })}
${sourceHead()}
${cellPartWGSL(false)}
${preMainWGSL('islandCellBareDirect')}`;

// The scene's WGSL: the cell stage over the baked columns and the prepass, and sceneCell.
export const islandGLSL = () => /* wgsl */ `
${sceneHeadWGSL(ISLAND_U, { data: true })}
${sourceHead()}
${cellPartWGSL(false)}
// World cell w's element at its spawn temperature and life, at rest, with a
// colour seed hashed from its world position and, for moss and fungus, their
// settled damp in the ctype (world/island/nature.js islandDamp). Under snow the
// ground's solids (but plant cover) are frozen near the snow line (genFrost).
fn sceneCell(w: vec3i) -> SceneCell {
  let id = structureCell(w, islandCell(w.x, w.y, w.z));
  var T = SPAWNT(id);
  if (SU.uGenSnow != 0u && KIND(id) == K_SOLID && id != E_PLANT) { T = mix(SPAWNT(id), SPAWNT(E_SNOW), genFrost(w.y)); }
  let seed = u32ToF32(seedWorld(w, SU.uSceneSeed, GEN_SALT_CELL)) * UINT_TO_UNIT * SEED_MAX;
  return SceneCell(vec4f(f32(id), T, SPAWNLIFE(id), islandDamp(w.y, id) + seed), vec4f(0.0));
}
`;

// The far field's twin of treesIn's candidates (scene.trees.glsl(): the
// island's head and its cell stage, direct, then these, with shaders/far.js
// treeGLSL in the same module). The hash chain is treeCandidate's
// (world/generator.js), the ground check the source's genTreeZone.
const islandTreesGLSL = () => /* wgsl */ `
${sceneHeadWGSL(ISLAND_U, { data: true })}
${sourceHead()}
${cellPartWGSL(true)}
fn islandTreeHash(bc: vec2i) -> u32 { return pcg(u32(bc.x) + pcg(u32(bc.y) + pcg(SU.uSceneSeed + GEN_SALT_TREE))); }
fn sceneTreeCandidate(bc: vec2i) -> vec4f {
  let h = islandTreeHash(bc);
  if (f32(h & 0xffffu) * TREE_UNIT16 >= TREE_CHANCE) { return vec4f(0.0); }
  if (structureClears(bc)) { return vec4f(0.0); }   // trees give way to structures (generator.js treeCandidate)
  let h2 = pcg(h);
  let h3 = pcg(h2);
  let o = vec2i(i32(h2 & u32(BS - 1)), i32((h2 >> 2u) & u32(BS - 1)));
  let col = bc * BS + o;
  let zone = genTreeZone(col.x, col.y);
  if (zone == GEN_ZONE_NONE) { return vec4f(0.0); }
  let variant = treeVariant(zone == GEN_ZONE_PALM, zone == GEN_ZONE_HIGH, f32(h3 & 0xffffu) * TREE_UNIT16);
  let size = i32((h3 >> 16u) % u32(TREE_SIZES));
  return vec4f(f32(1 + o.x + BS * o.y + BS * BS * (variant + TREE_VARIANTS * size)), f32(genTop(col.x, col.y)),
               f32(h2 >> 8u), 0.0);
}
fn sceneTreeKey(bc: vec2i) -> u32 { return pcg(pcg(islandTreeHash(bc))); }
`;

// ---------------------------------------------------------------- uniforms
// The values of the island's uniform struct for world P (generator.js
// islandParamValues, its landforms' sites, its structures' data).
export function islandUniforms(P) {
  const v = islandParamValues(P), [w, h] = columnsSize(P);
  return {
    ...v,
    uSceneSeed: P.seed,
    uLandLake: vec4s(v.uLandLake, landforms.tables.ints.LAKES_MAX),
    uLandStack: vec4s(v.uLandStack, landforms.tables.ints.STACKS_MAX),
    uColW: w, uColH: h,
    ...structureWords(P).values,
    uStructAt: 4 * w * h,   // (the structures after the columns: data)
  };
}

// ---------------------------------------------------------------- the scene
export const island = {
  key: 'island',
  label: 'Island',
  // structures (world/structures.js), the shrine among them near where the world starts
  // (the default World's sites and start come from the build's bake: world/bake.js)
  params({ size, seed = WORLD_SEED }) {
    const b = bakeFor(size, seed);
    const P = worldParams({ size, seed, snow: false, sites: b?.landforms });
    return { ...P, structures: { start: b?.start ?? island.start(P, START_WIN) } };
  },
  glsl: () => islandGLSL(),
  uniformStruct: ISLAND_U,
  uniforms: (P) => islandUniforms(P),
  // its data: the columns (baked on the GPU before the first fill: bake), then
  // the structures (placed by then: prepare); the prepass's region after them
  data: (P) => { const [w, h] = columnsSize(P); return { at: 4 * w * h, words: structureWords(P).data }; },
  bake: { size: columnsSize, code: islandColumnFrag, workgroup: ISLAND_BAKE_WORKGROUP },
  // (nature reads a cell's neighbours; a structure's footing the island up to
  // MAX_FOOT cells above and below the cell it decides)
  pre: { code: islandPreFrag, margin: (P) => [PRE_MARGIN, P.structures ? Math.max(PRE_MARGIN, MAX_FOOT) : PRE_MARGIN, PRE_MARGIN] },
  // the structures, off the main thread where there's a worker
  prepare: (P) => structuresReady(P),
  dispose() { disposeStructureTextures(); },
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

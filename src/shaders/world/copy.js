// The world copy (docs/seamless-world.md, "W — world copy"): the whole map at full cell detail, resident on
// the GPU from load, as sparse 4³ bricks. This file holds its WGSL: the readers every render kernel includes
// (worldCopyWGSL, group 1) and the writers world/worldCopy.js runs (the build's chunk kernels, physics'
// writeback, the brick info and the occupancy levels). The cell word and the brick-table entry are
// shaders/world/cellWord.js's (the shared ABI); the JS twins of everything here are world/worldCopyTwin.js's
// (tools/world-copy-cpu-check.mjs runs them). A sparse brick map: Laine & Karras 2010, "Efficient Sparse Voxel
// Octrees", at one level, as Teardown and Minecraft's palette chunks keep uniform sections as one value.
//
// Buffers, all indexed in world bricks b = (x, y, z), bi = x + BX (y + BY z):
//   wcTable  u32 per brick: a uniform brick's cell word, or WC_MIXED | its pool slot
//   wcPool   64 u32 per slot: the brick's cells x + 4 (y + 4 z)
//   wcMeta   (one buffer: the render kernels' storage budget, the lead's contract change of 2026-10-24)
//            words 0 .. bricks: a u32 per brick, the BRICK_INFO bits of shaders/bindings.js (bits 0-16), derived
//            from cells (no field textures: the world copy comes before them), then the brick's own bits
//            (WC_OWN_*, bits 24-30) the dilation derives the low bits from;
//            from word WC.occ1At: the occupancy levels, a bit per 16³-cell node (level 1), then from WC.occ2At a
//            bit per 64³-cell node (level 2), x fastest, set where a brick in it has BRICK_MATTER
// Writers only: wcAlloc (the allocator's counters, then its free list) and wcScratch (the jobs' ring, then the
// chunk's cells or a writeback's words). A writer binds at most 8 storage buffers a stage: the decode, with the
// tables and V2's two, takes five of these (no occupancy).
import { prelude, STATE_OPTS, stateLayout } from '../common.js';
import { cellWordWGSL, WC_BRICK, WC_BRICK_CELLS, WC_AUX_MAX } from './cellWord.js';
import { BRICK_INFO, AIR } from '../bindings.js';
import { FIELDS_DILATE } from '../fields.js';
import { uniformStruct } from '../../gpu/params.js';
import { STAGE, fold } from '../../gpu/kernels.js';
import { ELEMENTS, E } from '../../elements.js';
import { CHANNELS } from '../../gfx/materials.js';
import { ELEC, powered } from '../../electricity.js';
import { SCENE_BINDING } from '../../world/scenes/sceneGpu.js';
import { glf } from '../../glsl.js';

// ---------------------------------------------------------------- numbers
export const WC_NODE1 = 4;            // bricks a level-1 node spans per axis (16³ cells)
export const WC_NODE2 = 4;            // level-1 nodes a level-2 node spans per axis (64³ cells)
export const WC_CHUNK = 64;           // cells along a build chunk's x and z (16 brick columns), every height
export const WC_AIR_SNAP = 3;         // °C: air this close to the scene's ambient is stored at it (passes.js AIR_FLAG_T:
                                      // the heat view's threshold), so still air stays one uniform brick
export const WC_GAS_IDS = [E.STEAM, E.CLOUD, E.SMOKE];   // the brick info's gas count (passes.js wgGas)
// A brick's own bits (wcInfo bits 24-30), what the dilation reads of its neighbours:
export const WC_OWN = {
  SURF: 1 << 24,          // a cell of a smooth-surface element (SURFCH ≥ 0): its field reaches FIELD_REACH cells out
  MEDIA: 1 << 25,         // a cell of a medium (MEDIACH ≥ 0: smoke, steam, fire...)
  OPAQUE_SURF: 1 << 26,   // a cell of an opaque smooth-surface channel (molten, granular, organic): opaque fields
  LIQ_WHOLE: 1 << 27,     // every cell a whole cell of a liquid-channel liquid, nothing opaque
  MATTER: 1 << 28,        // a cell that isn't air
  OPAQUE: 1 << 29,        // a cell that stops light (not gas, liquid or glass)
};
// The low bits only a brick's own cells decide: kept as they are by the dilation.
export const WC_OWN_ONLY = BRICK_INFO.THIN | BRICK_INFO.MIXED | (7 << BRICK_INFO.AIR_SHIFT) | (127 << BRICK_INFO.GAS_SHIFT);
export const WC_DILATE = FIELDS_DILATE;   // bricks: how far a brick's smooth-surface and media fields reach (shaders/fields.js)
const CH_LIQUID = CHANNELS.findIndex((c) => c.key === 'LIQUID');
// A cell word's aux for matter is its life over this (cellWord.js "matter's life fraction"): an element's full
// life (its spawn life; a switch's SWITCH_ON), 1 at least.
export const wcLifeFull = (id) => {
  const e = ELEMENTS[id];
  if (!e) return 1;
  if (powered(id)) return Math.max(1, ELEC.SWITCH_ON);
  return Math.max(1, e.life ?? 0);
};

/** The world's layout in bricks and occupancy nodes, for world size [x, y, z] in cells. */
export function wcLayout(size) {
  const bricks = size.map((n) => Math.ceil(n / WC_BRICK));
  const n1 = bricks.map((n) => Math.ceil(n / WC_NODE1));
  const n2 = n1.map((n) => Math.ceil(n / WC_NODE2));
  const count = (v) => v[0] * v[1] * v[2];
  const occ1Words = Math.ceil(count(n1) / 32), occ2Words = Math.ceil(count(n2) / 32);
  const nBricks = count(bricks);
  // occ2Rel: level 2's first word among the occupancy's; occ1At, occ2At: their words in wcMeta (after the info)
  return { size: [...size], bricks, n1, n2, nBricks, occ1Words, occ2Rel: occ1Words, occWords: occ1Words + occ2Words,
    occ1At: nBricks, occ2At: nBricks + occ1Words, metaWords: nBricks + occ1Words + occ2Words };
}

// ---------------------------------------------------------------- group 1 of render kernels
// The WC uniform: the world's size in cells and bricks, the air word outside it, the occupancy's layout.
export const WorldCopyUniforms = uniformStruct('WorldCopyUniforms', {
  size: 'vec3i', air: 'u32',          // cells; the cell word wcCell returns outside the world
  bricks: 'vec3i', capacity: 'u32',   // bricks; pool slots (tools)
  n1: 'vec3i', occ1At: 'u32',         // level-1 nodes; the word of wcMeta level 1 starts at
  n2: 'vec3i', occ2At: 'u32',         // level-2 nodes; the word level 2 starts at
  revision: 'u32',                    // the copy's revision (tools)
});
const READ = STAGE.FRAGMENT | STAGE.COMPUTE;
/** Group 1's layout entries (gpu.layout('WORLD_COPY', WORLD_COPY_LAYOUT)): 0 WC, 1 wcTable, 2 wcPool, 3 wcMeta (info, then occupancy). */
export const WORLD_COPY_LAYOUT = [
  { binding: 0, visibility: READ, buffer: { type: 'uniform' } },
  ...[1, 2, 3].map((binding) => ({ binding, visibility: READ, buffer: { type: 'read-only-storage' } })),
];
export const WORLD_COPY_GROUP = 1;

const lifeFullWGSL = () => `const WC_LIFE_FULL = array<f32, ${ELEMENTS.length}>(${ELEMENTS.map((e) => glf(wcLifeFull(e.id))).join(', ')});`;

// What every reader shares: the decoders, the brick index, the life table.
const wcCommonWGSL = /* wgsl */ `
${cellWordWGSL}
${lifeFullWGSL()}
const WC_AUX_WHOLE: u32 = ${WC_AUX_MAX}u;
const WC_FULL_Q: u32 = 65536u;            // a whole cell's fill (v2/layout.js FULL): the dither's scale
const WC_INFO_MATTER: u32 = ${BRICK_INFO.MATTER}u;
`;

/**
 * WGSL for render kernels (after prelude(g, { state: false }): it uses KIND, seedWorld, SEED_MAX): group 1's
 * declarations and the world copy's readers, in world cells (the world's corner at 0, y up):
 *   wcCell(c) -> u32          the cell word; air (WC.air) outside the world
 *   wcA(c) -> vec4f           shaders/compact.js volumeA's meaning: (id, °C, life, ctype + seed), an empty cell's
 *                             (or a dithered-out liquid's) seed 0; the seed seedWorld(c, 0, 991)'s, the liquid
 *                             dither seedWorld(c, 0, 4243)'s against the fill, as compactA's
 *   wcInfo(b) -> u32          brick b's BRICK_INFO bits (0 outside)
 *   wcOccupied(level, c)      level 0: c's brick has matter; 1: its 16³ node; 2: its 64³ node (false outside)
 */
export const worldCopyWGSL = () => /* wgsl */ `
${wcCommonWGSL}
${WorldCopyUniforms.wgsl}
@group(1) @binding(0) var<uniform> WC: WorldCopyUniforms;
@group(1) @binding(1) var<storage, read> wcTable: array<u32>;
@group(1) @binding(2) var<storage, read> wcPool: array<u32>;
@group(1) @binding(3) var<storage, read> wcMeta: array<u32>;   // the info a brick, then the occupancy (WC.occ1At, WC.occ2At)
fn wcInWorld(c: vec3i) -> bool { return all(c >= vec3i(0)) && all(c < WC.size); }
fn wcBrickIndex(b: vec3i) -> u32 { return u32(b.x + WC.bricks.x * (b.y + WC.bricks.y * b.z)); }
fn wcCell(c: vec3i) -> u32 {
  if (!wcInWorld(c)) { return WC.air; }
  let e = wcTable[wcBrickIndex(c >> vec3u(2u))];
  if ((e & WC_MIXED) == 0u) { return e; }
  return wcPool[(e & ~WC_MIXED) * WC_BRICK_CELLS + wcLocal(c & vec3i(3))];
}
fn wcA(c: vec3i) -> vec4f {
  let w = wcCell(c);
  let id = wcId(w);
  let T = wcTemp(w);
  if (id == E_EMPTY) { return vec4f(0.0, T, 0.0, 0.0); }
  let k = KIND(id);
  if (k == K_EMPTY) { return vec4f(0.0, T, 0.0, 0.0); }
  let a = (w >> 24u) & 127u;
  if (k == K_LIQUID && a < WC_AUX_WHOLE && a * WC_FULL_Q / WC_AUX_WHOLE <= (seedWorld(c, 0u, 4243u) >> 16u)) { return vec4f(0.0, T, 0.0, 0.0); }
  let seed = f32(seedWorld(c, 0u, 991u) >> 16u) * (SEED_MAX / 65536.0);
  // a liquid's aux is its fill: its life isn't kept (Intentional (cell word ABI): the picture reads no liquid's life)
  let life = select(wcAux(w) * WC_LIFE_FULL[u32(id)], 0.0, k == K_LIQUID);
  return vec4f(f32(id), T, life, f32(wcCtype(w)) + seed);
}
fn wcInfo(b: vec3i) -> u32 {
  if (any(b < vec3i(0)) || any(b >= WC.bricks)) { return 0u; }
  return wcMeta[wcBrickIndex(b)];
}
// bit i of the occupancy level starting at word at
fn wcOccBit(at: u32, i: u32) -> bool { return ((wcMeta[at + (i >> 5u)] >> (i & 31u)) & 1u) != 0u; }
fn wcOccupied(level: u32, c: vec3i) -> bool {
  if (!wcInWorld(c)) { return false; }
  if (level == 0u) { return (wcInfo(c >> vec3u(2u)) & WC_INFO_MATTER) != 0u; }
  if (level == 1u) { let n = c >> vec3u(4u); return wcOccBit(WC.occ1At, u32(n.x + WC.n1.x * (n.y + WC.n1.y * n.z))); }
  let n = c >> vec3u(6u);
  return wcOccBit(WC.occ2At, u32(n.x + WC.n2.x * (n.y + WC.n2.y * n.z)));
}
`;

// ---------------------------------------------------------------- the writers
// Their group 2 (one layout for every writer, a dummy where a kernel binds nothing): the copy's buffers read_write.
export const WC_WRITE = { table: 0, pool: 1, meta: 2, alloc: 3, scratch: 4 };
export const WC_WRITE_LAYOUT = Object.values(WC_WRITE).map((binding) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }));
export const WC_DECODE_LAYOUT = WC_WRITE_LAYOUT;   // (the decode binds the tables and V2's two besides: 8)
export const WC_JOB_RING = 1 << 19;   // wcScratch's first words: the jobs (world/worldCopy.js writes them a writeback at a time)
// wcAlloc's words: the bump (slots ever handed out), the free list's length, slots that didn't fit (never, by
// world/worldCopy.js's capacity rule: a nonzero count is a bug the tools report), a spare; then the free list.
export const WC_CTRL = { BUMP: 0, FREE: 1, OVER: 2, CAP: 3, WORDS: 4 };
export const WcWriteParams = uniformStruct('WcWriteParams', {
  origin: 'vec3i', count: 'u32',      // world cells of the window's corner (writeback) or the chunk's; jobs
  chunk: 'vec3i', first: 'u32',       // the chunk's size in cells (build); the first job of the dispatch
  airT: 'f32', capacity: 'u32', dilate: 'i32', level: 'u32',
});
const writerDecls = (L) => /* wgsl */ `
${wcCommonWGSL}
${WcWriteParams.wgsl}
@group(3) @binding(1) var<uniform> P: WcWriteParams;
@group(2) @binding(${WC_WRITE.table}) var<storage, read_write> wcTable: array<u32>;
@group(2) @binding(${WC_WRITE.pool}) var<storage, read_write> wcPool: array<u32>;
@group(2) @binding(${WC_WRITE.meta}) var<storage, read_write> wcMeta: array<atomic<u32>>;   // info, then occupancy
fn wcInfoGet(bi: u32) -> u32 { return atomicLoad(&wcMeta[bi]); }
fn wcInfoPut(bi: u32, v: u32) { atomicStore(&wcMeta[bi], v); }
@group(2) @binding(${WC_WRITE.alloc}) var<storage, read_write> wcAlloc: array<atomic<u32>>;
@group(2) @binding(${WC_WRITE.scratch}) var<storage, read_write> wcScratchBuf: array<u32>;
const WC_SCRATCH_AT: u32 = ${WC_JOB_RING}u;
const WC_FREE_AT: u32 = ${WC_CTRL.WORDS}u;
fn wcJob(i: u32) -> u32 { return wcScratchBuf[i]; }
fn wcScratchGet(i: u32) -> u32 { return wcScratchBuf[WC_SCRATCH_AT + i]; }
fn wcScratchSet(i: u32, v: u32) { wcScratchBuf[WC_SCRATCH_AT + i] = v; }
const WC_B: vec3i = vec3i(${L.bricks.join(', ')});
const WC_N1: vec3i = vec3i(${L.n1.join(', ')});
const WC_N2: vec3i = vec3i(${L.n2.join(', ')});
const WC_OCC1_AT: u32 = ${L.occ1At}u;
const WC_OCC2_AT: u32 = ${L.occ2At}u;
const WC_CH_LIQUID: i32 = ${CH_LIQUID};
const WC_AIR_SNAP: f32 = ${glf(WC_AIR_SNAP)};
const WC_GAS_A: i32 = ${WC_GAS_IDS[0]};
const WC_GAS_B: i32 = ${WC_GAS_IDS[1]};
const WC_GAS_C: i32 = ${WC_GAS_IDS[2]};
${Object.entries(WC_OWN).map(([k, v]) => `const WC_OWN_${k}: u32 = ${v >>> 0}u;`).join('\n')}
const WC_OWN_ONLY: u32 = ${WC_OWN_ONLY}u;
const WC_I_MEDIA: u32 = ${BRICK_INFO.MEDIA}u;
const WC_I_SURF: u32 = ${BRICK_INFO.SURF}u;
const WC_I_OPAQUE: u32 = ${BRICK_INFO.OPAQUE}u;
const WC_I_THIN: u32 = ${BRICK_INFO.THIN}u;
const WC_I_MIXED: u32 = ${BRICK_INFO.MIXED}u;
const WC_I_LIQUID_INTERIOR: u32 = ${BRICK_INFO.LIQUID_INTERIOR}u;
const WC_I_AIR_SHIFT: u32 = ${BRICK_INFO.AIR_SHIFT}u;
const WC_I_GAS_SHIFT: u32 = ${BRICK_INFO.GAS_SHIFT}u;
const WC_AIR_HOT: u32 = ${AIR.HOT}u;
fn wcBi(b: vec3i) -> u32 { return u32(b.x + WC_B.x * (b.y + WC_B.y * b.z)); }
fn wcBrickOf(bi: u32) -> vec3i { let i = i32(bi); return vec3i(i % WC_B.x, (i / WC_B.x) % WC_B.y, i / (WC_B.x * WC_B.y)); }
// A cell's word from its decoded state (world/worldCopyTwin.js wcWordOf): air (and what reads as air) at the
// scene's ambient when within WC_AIR_SNAP of it, a liquid's aux its fill, matter's its life fraction.
${wcWordOfOnly}
// A cell word's own info bits: [low bits, own bits] (a brick's: their OR, but LIQ_WHOLE's AND)
fn wcCellOwn(w: u32) -> vec2u {
  let id = wcId(w);
  var low = 0u;
  var own = 0u;
  if (id == E_EMPTY) {
    if (abs(wcTemp(w) - P.airT) > WC_AIR_SNAP) { low |= WC_AIR_HOT << WC_I_AIR_SHIFT; }
    return vec2u(low, own);
  }
  own |= WC_OWN_MATTER;
  let ch = SURFCH(id);
  let r = RCLASS(id);
  if (ch >= 0) { own |= WC_OWN_SURF; }
  if (ch >= 0 && ch != WC_CH_LIQUID) { own |= WC_OWN_OPAQUE_SURF; }
  if (MEDIACH(id) >= 0) { own |= WC_OWN_MEDIA; }
  if (!isGasLike(id) && r != R_LIQUID && r != R_GLASS) { own |= WC_OWN_OPAQUE; }
  if (ch == WC_CH_LIQUID && ((w >> 24u) & 127u) == WC_AUX_WHOLE && (own & WC_OWN_OPAQUE) == 0u) { own |= WC_OWN_LIQ_WHOLE; }
  if (id == WC_GAS_A || id == WC_GAS_B || id == WC_GAS_C) { low |= 1u << WC_I_GAS_SHIFT; }
  return vec2u(low, own);
}

// The brick commit both the build and the writeback run, a workgroup a brick, thread li its cell
// x + 4 (y + 4 z): the 64 words reduced to uniform or mixed, and the brick's own info.
var<workgroup> wgW: array<u32, 64>;
var<workgroup> wgDiff: atomic<u32>;      // cells whose word differs from cell 0's
var<workgroup> wgLow: atomic<u32>;       // OR of the cells' low bits (gas cells summed: + not |)
var<workgroup> wgOwn: atomic<u32>;       // OR of their own bits, LIQ_WHOLE aside
var<workgroup> wgNotWhole: atomic<u32>;  // a cell that isn't a whole liquid cell
var<workgroup> wgLiqHi: atomic<u32>;     // 1 + the highest liquid-channel id (0: none), as passes.js's
var<workgroup> wgLiqLo: atomic<u32>;     // NE - the lowest
var<workgroup> wgSlot: u32;
fn wcGather(li: u32, w: u32) {
  if (li == 0u) {
    atomicStore(&wgDiff, 0u); atomicStore(&wgLow, 0u); atomicStore(&wgOwn, 0u); atomicStore(&wgNotWhole, 0u);
    atomicStore(&wgLiqHi, 0u); atomicStore(&wgLiqLo, 0u);
  }
  workgroupBarrier();
  wgW[li] = w;
  let o = wcCellOwn(w);
  let gas = o.x >> WC_I_GAS_SHIFT;
  if (gas != 0u) { atomicAdd(&wgLow, 1u << WC_I_GAS_SHIFT); }
  atomicOr(&wgLow, o.x & ~(127u << WC_I_GAS_SHIFT));
  atomicOr(&wgOwn, o.y & ~WC_OWN_LIQ_WHOLE);
  if ((o.y & WC_OWN_LIQ_WHOLE) == 0u) { atomicOr(&wgNotWhole, 1u); }
  let id = wcId(w);
  if (SURFCH(id) == WC_CH_LIQUID) { atomicMax(&wgLiqHi, u32(id) + 1u); atomicMax(&wgLiqLo, u32(NE - id)); }
  workgroupBarrier();
  if (w != wgW[0]) { atomicAdd(&wgDiff, 1u); }
  workgroupBarrier();
}
// the brick's info word before the dilation: its own low bits (THIN, MIXED, air, gas) and own bits
fn wcOwnInfo() -> u32 {
  var own = atomicLoad(&wgOwn);
  if (atomicLoad(&wgNotWhole) == 0u) { own |= WC_OWN_LIQ_WHOLE; }
  var low = atomicLoad(&wgLow);
  let hi = atomicLoad(&wgLiqHi);
  if (hi != 0u && hi - 1u != u32(NE) - atomicLoad(&wgLiqLo)) { low |= WC_I_MIXED; }
  // a liquid's free surface or stream: the thin-feature pass may find thin liquid here (conservative)
  if (hi != 0u && (own & WC_OWN_LIQ_WHOLE) == 0u) { low |= WC_I_THIN; }
  return (low & WC_OWN_ONLY) | own;
}
// pop a free slot, else bump one (no push runs in the same dispatch: see wcRelease); ~0u when none fits
fn wcAllocSlot() -> u32 {
  let n = i32(atomicSub(&wcAlloc[${WC_CTRL.FREE}], 1u));
  if (n > 0) { return atomicLoad(&wcAlloc[WC_FREE_AT + u32(n - 1)]); }
  atomicAdd(&wcAlloc[${WC_CTRL.FREE}], 1u);
  let s = atomicAdd(&wcAlloc[${WC_CTRL.BUMP}], 1u);
  if (s >= P.capacity) { atomicAdd(&wcAlloc[${WC_CTRL.OVER}], 1u); return 0xffffffffu; }
  return s;
}
// give slot s back (no pop runs in the same dispatch)
fn wcRelease(s: u32) { atomicStore(&wcAlloc[WC_FREE_AT + atomicAdd(&wcAlloc[${WC_CTRL.FREE}], 1u)], s); }
`;

// One thread per job of a 1-D job list (fold), x jobs at P.first on.
const jobThread = (body) => /* wgsl */ `
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let j = foldThread(wg, nwg, li);
  if (j >= P.count) { return; }
  let job = P.first + j;
${body}
}`;
// One workgroup per job (a brick), thread li its cell.
const brickWorkgroup = (body) => /* wgsl */ `
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let j = foldId(wg, nwg);
  if (j >= P.count) { return; }
  let job = P.first + j;
  let l = vec3i(i32(li & 3u), i32((li >> 2u) & 3u), i32(li >> 4u));
${body}
}`;
export const jobDispatch = (n) => fold(Math.ceil(n / 64));
export const brickDispatch = (n) => fold(n);

// ---- the build: a chunk of WC_CHUNK² columns, every height, cell x + CW (y + H z) of its scratch.
// The scene's cells (its sceneCell, after its prepass over the chunk: world/gpu.js SceneGpu.prepassFor). The
// scene's group 2 comes first; the chunk's cells after it (SCENE_BINDING.next).
export const WC_SCENE_CELLS_BINDING = SCENE_BINDING.next;
export const wcSceneFrag = (g, L, sceneGLSL) => /* wgsl */ `
${prelude(g, { state: false })}
${sceneGLSL}
${cellWordWGSL}
${lifeFullWGSL()}
${WcWriteParams.wgsl}
@group(3) @binding(1) var<uniform> P: WcWriteParams;
@group(2) @binding(${WC_SCENE_CELLS_BINDING}) var<storage, read_write> cells: array<u32>;
const WC_AIR_SNAP: f32 = ${glf(WC_AIR_SNAP)};
${wcWordOfOnly}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldThread(wg, nwg, li);
  let n = P.chunk;
  if (i >= u32(n.x * n.y * n.z)) { return; }
  let c = vec3i(i32(i) % n.x, (i32(i) / n.x) % n.y, i32(i) / (n.x * n.y));
  let A = sceneCell(P.origin + c).A;
  let id = eid(A);
  cells[i] = wcWordOf(id, A.y, A.z, u32(max(floor(A.w), 0.0)), 1.0);
}`;
// wcWordOf alone, for kernels without the writers' declarations (the scene's, the stamps')
const wcWordOfOnly = /* wgsl */ `
fn wcWordOf(id: i32, T: f32, life: f32, ctype: u32, fill: f32) -> u32 {
  let k = KIND(id);
  let a = clamp(round(fill * ${glf(WC_AUX_MAX)}), 0.0, ${glf(WC_AUX_MAX)});
  if (id == E_EMPTY || k == K_EMPTY || (k == K_LIQUID && a < 1.0)) {
    return wcWord(0, 0u, select(T, P.airT, abs(T - P.airT) <= WC_AIR_SNAP), 0.0);
  }
  if (k == K_LIQUID) { return wcWord(id, ctype, T, a / ${glf(WC_AUX_MAX)}); }
  return wcWord(id, ctype, T, life / WC_LIFE_FULL[u32(id)]);
}`;

// The chunk's trees (and any stamp of a baked construction: constructions/runtime.js bake), a thread per
// column of the chunk, each stamping every tree over its column in order, so later trees win as the window's
// stamps do (shaders/stamp.js): a footing reads only its own column (stampLib's rule), so one thread owns it.
// A stamp: 8 words (at.xyz, foot, size.xyz, base) in wcStamps; its voxels one word each in wcVoxels, x fastest,
// then y, then z: id + 1 (bits 0-7, 0 leaves the cell, 1 carves air), ctype (8-15), temperature code (16-23),
// base flag (24: the cell may grow a footing). Their life is the element's spawn life (stampPut's SPAWNLIFE).
export const WC_STAMP_WORDS = 8;
export const WC_STAMP_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
  { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
];
export const wcStampFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${cellWordWGSL}
${lifeFullWGSL()}
${WcWriteParams.wgsl}
@group(3) @binding(1) var<uniform> P: WcWriteParams;
@group(2) @binding(0) var<storage, read_write> cells: array<u32>;
@group(2) @binding(1) var<storage, read> wcStamps: array<i32>;
@group(2) @binding(2) var<storage, read> wcVoxels: array<u32>;
const WC_AIR_SNAP: f32 = ${glf(WC_AIR_SNAP)};
const WC_NO_GROUND: i32 = -2147483647;
${wcWordOfOnly}
fn wcCellIndex(c: vec3i) -> u32 { return u32(c.x + P.chunk.x * (c.y + P.chunk.y * c.z)); }
// does chunk cell c bear weight (not air, gas or liquid)? (shaders/stamp.js bearsWeight)
fn wcBears(c: vec3i) -> bool { return c.y >= 0 && c.y < P.chunk.y && !isFluid(wcId(cells[wcCellIndex(c)])); }
fn wcPut(c: vec3i, v: u32) {
  let id = i32(v & 255u) - 1;
  let T = wcTemp(v & 0x00ff0000u);
  cells[wcCellIndex(c)] = wcWordOf(id, T, SPAWNLIFE(id), (v >> 8u) & 255u, 1.0);
}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldThread(wg, nwg, li);
  if (i >= u32(P.chunk.x * P.chunk.z)) { return; }
  let col = vec2i(i32(i) % P.chunk.x, i32(i) / P.chunk.x);
  for (var t = 0u; t < P.count; t++) {
    let o = t * ${WC_STAMP_WORDS}u;
    let at = vec3i(wcStamps[o], wcStamps[o + 1u], wcStamps[o + 2u]);
    let foot = wcStamps[o + 3u];
    let size = vec3i(wcStamps[o + 4u], wcStamps[o + 5u], wcStamps[o + 6u]);
    let base = u32(wcStamps[o + 7u]);
    let q = col - at.xz;
    if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.z) { continue; }
    // the footing first, decided on the column as it was before this stamp (shaders/stamp.js footing: ground,
    // or the world's floor, within foot cells below the base, and every cell between it and the base open)
    let v0 = wcVoxels[base + u32(q.x + size.x * size.y * q.y)];
    if ((v0 & 255u) != 0u && ((v0 >> 24u) & 1u) != 0u) {
      var ground = WC_NO_GROUND;
      for (var i = 1; i <= foot; i++) {
        let y = at.y - i;
        if (y < 0 || wcBears(vec3i(col.x, y, col.y))) { ground = y; break; }
      }
      if (ground != WC_NO_GROUND) { for (var y = max(ground + 1, 0); y < min(at.y, P.chunk.y); y++) { wcPut(vec3i(col.x, y, col.y), v0); } }
    }
    for (var y = 0; y < size.y; y++) {
      let p = vec3i(col.x, at.y + y, col.y);
      if (p.y < 0 || p.y >= P.chunk.y) { continue; }
      let v = wcVoxels[base + u32(q.x + size.x * (y + size.y * q.y))];
      if ((v & 255u) != 0u) { wcPut(p, v); }
    }
  }
}`;

// The chunk's saved bricks (the window's stores: exact cells decoded on the CPU, worldCopyTwin.js
// wcWordOfCore): per brick a word of its chunk brick (x + CBX (y + CBY z)), then its 64 cell words.
export const WC_OVERLAY_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
];
export const wcOverlayFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${WcWriteParams.wgsl}
@group(3) @binding(1) var<uniform> P: WcWriteParams;
@group(2) @binding(0) var<storage, read_write> cells: array<u32>;
@group(2) @binding(1) var<storage, read> wcSaved: array<u32>;
${brickWorkgroup(/* wgsl */ `
  let o = job * 65u;
  let cb = vec3i(P.chunk / BS);
  let k = i32(wcSaved[o]);
  let b = vec3i(k % cb.x, (k / cb.x) % cb.y, k / (cb.x * cb.y));
  let c = b * BS + l;
  cells[u32(c.x + P.chunk.x * (c.y + P.chunk.y * c.z))] = wcSaved[o + 1u + li];`)}
`;

// The chunk's bricks committed (bump-only: the build frees nothing), each brick's own info written.
// The chunk's cells are the scratch's (after the jobs' ring).
export const wcCommitChunkFrag = (g, L) => /* wgsl */ `
${prelude(g, { state: false })}
${writerDecls(L)}
${brickWorkgroup(/* wgsl */ `
  let cb = P.chunk / BS;
  let k = i32(job);
  let lb = vec3i(k % cb.x, (k / cb.x) % cb.y, k / (cb.x * cb.y));
  let c = lb * BS + l;
  let w = wcScratchGet(u32(c.x + P.chunk.x * (c.y + P.chunk.y * c.z)));
  wcGather(li, w);
  let b = (P.origin >> vec3u(2u)) + lb;
  if (any(b >= WC_B)) { return; }
  let bi = wcBi(b);
  if (li == 0u) {
    wcInfoPut(bi, wcOwnInfo());
    if (atomicLoad(&wgDiff) == 0u) { wcTable[bi] = wgW[0]; wgSlot = 0xffffffffu; }
    else {
      wgSlot = wcAllocSlot();
      // never dropped: world/worldCopy.js keeps capacity ahead of every job it records (OVER counts a breach)
      if (wgSlot != 0xffffffffu) { wcTable[bi] = WC_MIXED | wgSlot; }
    }
  }
  let s = workgroupUniformLoad(&wgSlot);
  if (s != 0xffffffffu) { wcPool[s * WC_BRICK_CELLS + li] = w; }`)}
`;

// ---- physics' writeback (world/worldCopy.js recordWriteback): jobs are window bricks, packed
// x | y << 10 | z << 20, their world brick the window's origin's plus it.
// Pass 1: decode the cores (V2's native cells, shaders/compact.js's decode, through the sim's read group),
// commit uniform bricks, release the slots of bricks that became uniform, keep the slot of a brick that stays
// mixed, and leave the words of a brick that needs a slot in the scratch (64 a job, then a flag a job:
// wcScratch[count · 64 + job], 1 where it needs one).
const unpackJob = /* wgsl */ `
  let jw = wcJob(job);
  let wb = vec3i(i32(jw & 1023u), i32((jw >> 10u) & 1023u), i32(jw >> 20u));`;
export const wcDecodeFrag = (g, L) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${writerDecls(L)}
// cell p of the window: its word (compactA's fields, undithered, at full precision: shaders/compact.js)
fn wcCoreWord(p: vec3i) -> u32 {
  let c = fetchNativeCore(p);
  let id = i32(c.x & 255u);
  let T = f32(compactTq(c)) * 0.25 - 273.25;
  let k = KIND(id);
  let cond = COMPACT_CONDUCTS[u32(id)];
  if (k == K_LIQUID) {
    let ct = select((c.y >> 24u) & COMPACT_CTYPE_MASK[u32(id)], (c.w >> 16u) & 4095u, cond);
    return wcWordOf(id, T, 0.0, ct & 255u, min(f32(c.y & 0xffffffu) / f32(WC_FULL_Q), 1.0));
  }
  let ct = select((c.y >> 16u) & 255u, c.w & 4095u, cond);
  return wcWordOf(id, T, f32(c.y & 65535u) / COMPACT_LIFE_SCALE[u32(id)], ct & 255u, 1.0);
}
${brickWorkgroup(/* wgsl */ `${unpackJob}
  let w = wcCoreWord(wb * BS + l);
  wcGather(li, w);
  let bi = wcBi((P.origin >> vec3u(2u)) + wb);
  let flag = P.count * 64u + j;
  if (li == 0u) {
    wcInfoPut(bi, wcOwnInfo());
    let old = wcTable[bi];
    if (atomicLoad(&wgDiff) == 0u) {
      wcTable[bi] = wgW[0];
      if ((old & WC_MIXED) != 0u) { wcRelease(old & ~WC_MIXED); }
      wcScratchSet(flag, 0u);
      wgSlot = 0xffffffffu;
    } else if ((old & WC_MIXED) != 0u) {
      wcScratchSet(flag, 0u);
      wgSlot = old & ~WC_MIXED;
    } else {
      wcScratchSet(flag, 1u);
      wgSlot = 0xffffffffu;
    }
  }
  let s = workgroupUniformLoad(&wgSlot);
  if (s != 0xffffffffu) { wcPool[s * WC_BRICK_CELLS + li] = w; }
  wcScratchSet(j * 64u + li, w);`)}
`;
// Pass 2: a slot for each brick that became mixed (pops only), its words from the scratch.
export const wcAllocFrag = (g, L) => /* wgsl */ `
${prelude(g, { state: false })}
${writerDecls(L)}
${brickWorkgroup(/* wgsl */ `${unpackJob}
  let bi = wcBi((P.origin >> vec3u(2u)) + wb);
  if (li == 0u) {
    wgSlot = 0xffffffffu;
    if (wcScratchGet(P.count * 64u + j) != 0u) {
      wgSlot = wcAllocSlot();
      if (wgSlot != 0xffffffffu) { wcTable[bi] = WC_MIXED | wgSlot; }
    }
  }
  let s = workgroupUniformLoad(&wgSlot);
  if (s != 0xffffffffu) { wcPool[s * WC_BRICK_CELLS + li] = wcScratchGet(j * 64u + li); }`)}
`;

// ---- the info's dilation: a brick's SURF, MEDIA, OPAQUE and LIQUID_INTERIOR from its own bits and its
// neighbours' within P.dilate bricks (their fields reach it: shaders/fields.js FIELD_REACH), BRICK_MATTER where
// it holds matter or a field (passes.js: occ || hasSurf || hasMedia). Idempotent: it reads only own bits.
// Jobs: world brick indices (P.count of them from P.first), or with P.level == 1 every brick from P.first.
export const wcDilateFrag = (g, L) => /* wgsl */ `
${prelude(g, { state: false })}
${writerDecls(L)}
${jobThread(/* wgsl */ `
  var bi = job;
  if (P.level != 1u) { bi = wcJob(job); }
  let b = wcBrickOf(bi);
  let me = wcInfoGet(bi);
  var near = 0u;
  var whole = (me & WC_OWN_LIQ_WHOLE) != 0u;
  for (var dz = -P.dilate; dz <= P.dilate; dz++) {
    for (var dy = -P.dilate; dy <= P.dilate; dy++) {
      for (var dx = -P.dilate; dx <= P.dilate; dx++) {
        let q = b + vec3i(dx, dy, dz);
        if (any(q < vec3i(0)) || any(q >= WC_B)) { continue; }   // past the world: nothing there (whole stays: the edge sea)
        let o = wcInfoGet(wcBi(q));
        near |= o;
        if ((o & WC_OWN_LIQ_WHOLE) == 0u) { whole = false; }
      }
    }
  }
  var low = me & WC_OWN_ONLY;
  let surf = (near & WC_OWN_SURF) != 0u;
  let media = (near & WC_OWN_MEDIA) != 0u;
  if (surf) { low |= WC_I_SURF; }
  if (media) { low |= WC_I_MEDIA; }
  if ((me & WC_OWN_OPAQUE) != 0u || (near & WC_OWN_OPAQUE_SURF) != 0u) { low |= WC_I_OPAQUE; }
  if (whole) { low |= WC_I_LIQUID_INTERIOR; }
  if ((me & WC_OWN_MATTER) != 0u || surf || media) { low |= WC_INFO_MATTER; }
  else { low &= (7u << WC_I_AIR_SHIFT); }   // an empty brick: its air flags only (passes.js)
  wcInfoPut(bi, (me & ~0x00ffffffu) | low);`)}
`;

// ---- the occupancy: level 1 nodes (P.level 1) from their bricks' BRICK_MATTER, level 2 (P.level 2) from
// their level-1 nodes. Jobs: node indices (P.count from P.first); with P.dilate == -1 every node from P.first.
export const wcOccFrag = (g, L) => /* wgsl */ `
${prelude(g, { state: false })}
${writerDecls(L)}
// bit i of the level starting at word at of wcMeta
fn wcOccGet(at: u32, i: u32) -> bool { return ((atomicLoad(&wcMeta[at + (i >> 5u)]) >> (i & 31u)) & 1u) != 0u; }
fn wcOccSet(at: u32, i: u32, on: bool) {
  let bit = 1u << (i & 31u);
  if (on) { atomicOr(&wcMeta[at + (i >> 5u)], bit); } else { atomicAnd(&wcMeta[at + (i >> 5u)], ~bit); }
}
${jobThread(/* wgsl */ `
  var ni = job;
  if (P.dilate != -1) { ni = wcJob(job); }
  var on = false;
  if (P.level == 1u) {
    let n = vec3i(i32(ni) % WC_N1.x, (i32(ni) / WC_N1.x) % WC_N1.y, i32(ni) / (WC_N1.x * WC_N1.y));
    if (n.z >= WC_N1.z) { return; }
    let lo = n * ${WC_NODE1};
    let hi = min(lo + ${WC_NODE1}, WC_B);
    for (var z = lo.z; z < hi.z && !on; z++) { for (var y = lo.y; y < hi.y && !on; y++) { for (var x = lo.x; x < hi.x; x++) {
      if ((wcInfoGet(wcBi(vec3i(x, y, z))) & WC_INFO_MATTER) != 0u) { on = true; break; }
    } } }
    wcOccSet(WC_OCC1_AT, ni, on);
  } else {
    let n = vec3i(i32(ni) % WC_N2.x, (i32(ni) / WC_N2.x) % WC_N2.y, i32(ni) / (WC_N2.x * WC_N2.y));
    if (n.z >= WC_N2.z) { return; }
    let lo = n * ${WC_NODE2};
    let hi = min(lo + ${WC_NODE2}, WC_N1);
    for (var z = lo.z; z < hi.z && !on; z++) { for (var y = lo.y; y < hi.y && !on; y++) { for (var x = lo.x; x < hi.x; x++) {
      if (wcOccGet(WC_OCC1_AT, u32(x + WC_N1.x * (y + WC_N1.y * z)))) { on = true; break; }
    } } }
    wcOccSet(WC_OCC2_AT, ni, on);
  }`)}
`;

// Every writer, for a small world (tools/world-copy-cpu-check.mjs runs naga on them; tools/check-wgsl.mjs and
// tools/check-wgsl-operators.mjs find them here). Built on entering a world: the warm-up leaves them out.
export const WC_KERNELS = { wcCommitChunkFrag, wcDecodeFrag, wcAllocFrag, wcDilateFrag, wcOccFrag, wcStampFrag, wcOverlayFrag };
const CHECK_WORLD = wcLayout([256, 128, 256]);
const CHECK_STATE = { wcDecodeFrag: 'STATE_RO' };
const CHECK_GROUP2 = { wcStampFrag: WC_STAMP_LAYOUT, wcOverlayFrag: WC_OVERLAY_LAYOUT, wcDecodeFrag: WC_DECODE_LAYOUT };
export const WGSL_CHECK = () => Object.entries(WC_KERNELS).map(([name, frag]) => ({
  name: `world copy ${name}`, kind: 'compute', grids: ['128'], warm: false, code: (g) => frag(g, CHECK_WORLD), params: WcWriteParams,
  layouts: () => [[{ binding: 0, visibility: READ, buffer: { type: 'read-only-storage' } }], CHECK_STATE[name] ? stateLayoutOf(CHECK_STATE[name]) : 'EMPTY', CHECK_GROUP2[name] ?? WC_WRITE_LAYOUT],
  dispatch: () => [1, 1, 1],
})).concat([{
  // the readers, as a render kernel includes them
  name: 'world copy readers', kind: 'compute', grids: ['128'], warm: false, layouts: () => [[{ binding: 0, visibility: READ, buffer: { type: 'read-only-storage' } }], WORLD_COPY_LAYOUT, [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }]],
  code: (g) => `${prelude(g, { state: false })}\n${worldCopyWGSL()}\n@group(2) @binding(0) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(1) fn main() { let c = vec3i(1); out[0] = wcA(c).x + f32(wcCell(c) + wcInfo(c) + u32(wcOccupied(2u, c))); }`,
  dispatch: () => [1, 1, 1],
}]);
const stateLayoutOf = (k) => stateLayout(STATE_OPTS[k]);

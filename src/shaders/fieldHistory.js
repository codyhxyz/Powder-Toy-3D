// The World field history's page copies (world/fieldHistory.js): one dispatch
// moves a list of owners' pages between a pool slab and the scratch EMA.
//
// A pool page is one owner brick's EMA, 768 contiguous bytes: its three packed
// planes, 64 words each, plane p at word p * 64, in the brick's own cell order
// (a scratch brick's 64 slots, shaders/common.js cellSlot). The scratch keeps
// the planes apart, plane p at word p * SLOTS. A job is three words:
//   0  the brick's first scratch slot (its brick id * 64)
//   1  its page's first word in its slab
//   2  its slab (the pool's index of it)
// A dispatch binds one slab and copies the jobs of its range that are in that
// slab, all 192 words each, every bit as stored (no conversion); the others
// return at once, so a range spanning slabs takes a dispatch a slab and needs
// no sorting.
import { uniformStruct } from '../gpu/params.js';
import { STAGE } from './common.js';

/** Words a page plane: a brick's cells. */
export const FIELD_HISTORY_PLANE_WORDS = 64;
/** Threads a job: one a word of each plane. */
export const FIELD_HISTORY_WORKGROUP = FIELD_HISTORY_PLANE_WORDS;
/** Planes a page: the EMA's packed planes (gfx/fieldDeriver.js FIELD_RESOURCES.ema). */
export const FIELD_HISTORY_PLANES = 3;
/** u32 words a job in the list: (scratch slot, page word, slab). */
export const FIELD_HISTORY_JOB_WORDS = 3;

// scatter: 0 copies pages into the scratch (a gather), 1 the scratch into pages;
// slab: the bound slab's index (job word 2).
export const FieldHistoryParams = uniformStruct('FieldHistoryParams', { first: 'u32', count: 'u32', scatter: 'bool', slab: 'u32' });
// 0 the job list, 1 one pool slab, 2 the scratch EMA.
export const FIELD_HISTORY_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
  { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
];

/** @param {{ slots: number }} g the scratch grid (gridDims) */
export const fieldHistoryWGSL = (g) => /* wgsl */ `
${FieldHistoryParams.wgsl}
@group(3) @binding(1) var<uniform> P: FieldHistoryParams;
@group(0) @binding(0) var<storage, read> jobs: array<u32>;
@group(0) @binding(1) var<storage, read_write> pool: array<u32>;
@group(0) @binding(2) var<storage, read_write> ema: array<u32>;
const SLOTS: u32 = ${g.slots}u;
const PLANES: u32 = ${FIELD_HISTORY_PLANES}u;
const PLANE_WORDS: u32 = ${FIELD_HISTORY_PLANE_WORDS}u;
const JOB_WORDS: u32 = ${FIELD_HISTORY_JOB_WORDS}u;
// One workgroup a job, folded 1-D (gpu/kernels.js fold): past the count, or
// for a job in another slab, it returns.
@compute @workgroup_size(${FIELD_HISTORY_WORKGROUP})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) n: vec3u, @builtin(local_invocation_index) i: u32) {
  let j = wg.x + wg.y * n.x;
  if (j >= P.count) { return; }
  let at = (P.first + j) * JOB_WORDS;
  if (jobs[at + 2u] != P.slab) { return; }
  let slot = jobs[at];
  let word = jobs[at + 1u];
  for (var plane = 0u; plane < PLANES; plane++) {
    let s = plane * SLOTS + slot + i;
    let q = word + plane * PLANE_WORDS + i;
    if (P.scatter != 0u) { pool[q] = ema[s]; } else { ema[s] = pool[q]; }
  }
}
`;

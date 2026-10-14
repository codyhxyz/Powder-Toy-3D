import { prelude, STATE_OPTS, LAYOUT, gridDims } from './common.js';
import { DIRTY, FIELD_LAYOUT, dirtyListsWGSL } from './fields.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { ELEMENTS } from '../elements.js';

// The march's occupancy (docs/webgpu.md K3, "compact id volume"): per 4³
// brick a 64-bit mask of the cells that hold anything (2 × u32) and the
// cells' element ids, a byte each, four to a u32 (16 words). The tracers
// (shaders/render.js: the realistic view's march and the sun's shadow map)
// load a brick's mask once on entering it, then step through its empty cells
// without reading the state at all, and read a non-empty cell's id from one
// byte instead of state A's 16 (and slotOf's integer work). It is the
// 64-bit-mask brick of dubiousconst282's "Voxel ray tracing" (2024-10-03),
// and Minecraft's rule for its chunk meshes: rebuilt only where the world
// changed.
//
// Where: the brickDist buffer (shaders/bindings.js binding 17), after its
// NBRICKS distances. Every render pipeline already binds that buffer, and the
// volume's fragment stage is at the 8 storage buffers every WebGPU device
// allows (tools/check-sampler-budget.mjs), so the occupancy rides in it
// instead of taking a binding of its own:
//   [0, NBRICKS)                 brickDist (shaders/passes.js brickDistFrag)
//   [NBRICKS, 3·NBRICKS)         the masks: brick b's at NBRICKS + 2b (cells 0-31, 32-63)
//   [3·NBRICKS, 19·NBRICKS)      the ids: brick b's at 3·NBRICKS + 16b
// A cell's place in its brick is x + 4y + 16z (its coordinates mod 4): bit k
// of the mask, byte k & 3 of id word k >> 2.
//
// When: with the brick map, over the same list of bricks (the derived frame's
// FIELDS list, src/derived.js updateBricks), so the march's id and the brick
// map it already trusts are as fresh as each other; and over every brick
// after a window shift, which moves the brick map but not these words.
export const OCC = { MASK_WORDS: 2, ID_WORDS: 16 };
/** u32 words of the brickDist buffer with the occupancy after the distances. */
export const occupancyWords = (g) => (1 + OCC.MASK_WORDS + OCC.ID_WORDS) * gridDims(g).nbricks;

// An id is a byte here: more elements than that need wider words.
const ID_MAX = 255;
if (ELEMENTS.some((e) => e.id > ID_MAX)) throw new Error(`occupancy: element ids above ${ID_MAX} don't fit a byte`);

/**
 * The tracers' reads, for a kernel with the lighting group (its `brickDist`
 * buffer, shaders/bindings.js) after the prelude (NBRICKS, brickId, E_EMPTY).
 * shaders/gfx/core.js pastes it.
 */
export const occupancyReadWGSL = /* wgsl */ `
// ---- the march's occupancy (shaders/occupancy.js) ----
const OCC_MASKS: u32 = NBRICKS;        // brickDist words: brick b's mask at OCC_MASKS + 2b
const OCC_IDS: u32 = 3u * NBRICKS;     // ... its 64 id bytes at OCC_IDS + 16b
// Brick id's occupancy mask: bit k is set where cell k holds anything.
fn occMaskOf(id: u32) -> vec2u { return vec2u(brickDist[OCC_MASKS + 2u * id], brickDist[OCC_MASKS + 2u * id + 1u]); }
// Cell c's place in its brick (its bit in the mask, its byte in the ids).
fn occBitOf(c: vec3i) -> u32 {
  let l = vec3u(c & vec3i(3));
  return l.x | (l.y << 2u) | (l.z << 4u);
}
// Whether mask m has cell k.
fn occHas(m: vec2u, k: u32) -> bool { return ((select(m.x, m.y, k >= 32u) >> (k & 31u)) & 1u) != 0u; }
// The element id of cell k of brick id: what eid(fetchA(cell)) reads.
fn occIdOf(id: u32, k: u32) -> i32 { return i32((brickDist[OCC_IDS + 16u * id + (k >> 2u)] >> ((k & 3u) * 8u)) & 255u); }
// Cell c's element id, in brick id with mask m: E_EMPTY without reading anything when its bit is clear.
fn occCellId(m: vec2u, id: u32, c: vec3i) -> i32 {
  let k = occBitOf(c);
  if (!occHas(m, k)) { return E_EMPTY; }
  return occIdOf(id, k);
}`;

export const OccParams = uniformStruct('OccParams', { all: 'u32' });

// The kernel: a workgroup per brick, a thread per cell. all = 0: the bricks
// of the FIELDS list (indirect, as the brick map); 1: every brick (fold()ed).
// Its group 2 is the derived passes' PAIR: the lists (read) and the brickDist
// buffer (written past the distances only).
export const occupancyFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${dirtyListsWGSL(g)}
${OccParams.wgsl}
@group(3) @binding(1) var<uniform> P: OccParams;
@group(2) @binding(0) var<storage, read> dlist: array<u32>;
@group(2) @binding(1) var<storage, read_write> occ: array<u32>;   // the brickDist buffer
const OCC_MASKS: u32 = NBRICKS;
const OCC_IDS: u32 = 3u * NBRICKS;
var<workgroup> wgWords: array<atomic<u32>, ${OCC.MASK_WORDS + OCC.ID_WORDS}>;   // the mask, then the ids
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let e = foldId(wg, nwg);
  var b = e;
  if (P.all == 0u) {
    if (e >= dlist[DL_LAST + LIST_FIELDS]) { return; }
    b = dlist[LIST_FIELDS * NBRICKS + e];
  } else if (e >= NBRICKS) { return; }
  if (li < ${OCC.MASK_WORDS + OCC.ID_WORDS}u) { atomicStore(&wgWords[li], 0u); }
  workgroupBarrier();
  let s = b * 64u + li;
  let id = eid(fetchAs(s));
  if (id != E_EMPTY) {
    let l = vec3u(cellOf(s) & vec3i(3));
    let k = l.x | (l.y << 2u) | (l.z << 4u);
    atomicOr(&wgWords[k >> 5u], 1u << (k & 31u));
    atomicOr(&wgWords[${OCC.MASK_WORDS}u + (k >> 2u)], (u32(id) & 255u) << ((k & 3u) * 8u));
  }
  workgroupBarrier();
  if (li < ${OCC.MASK_WORDS}u) { occ[OCC_MASKS + ${OCC.MASK_WORDS}u * b + li] = atomicLoad(&wgWords[li]); }
  else if (li < ${OCC.MASK_WORDS + OCC.ID_WORDS}u) { occ[OCC_IDS + ${OCC.ID_WORDS}u * b + li - ${OCC.MASK_WORDS}u] = atomicLoad(&wgWords[li]); }
}
`;

/**
 * The occupancy's upkeep for a Derived (src/derived.js), whose brickDist
 * buffer holds it (occupancyWords): its kernel (in derived.kernels, so
 * derived.ready waits for it), update() over the brick map's list each
 * derived frame, and a rebuild of every brick at a window shift.
 */
export class Occupancy {
  /** @param {import('../derived.js').Derived} derived */
  constructor(derived) {
    const { gpu, sim, g } = derived;
    this.derived = derived;
    this.kernel = derived.kernels.occupancy = gpu.kernel({
      name: 'occupancy', code: occupancyFrag(g), layouts: [sim.L.TABLES, sim.L.STATE_RO, derived.L.PAIR],
      params: OccParams, workgroupSize: [64, 1, 1],
    });
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    this.group = gpu.bindGroup(derived.L.PAIR, [b(0, derived.dlist), b(1, derived.brickDist)], 'occupancy');
    // (the state has moved by whole bricks; the brick map moves with it, these words are rebuilt)
    this._off = sim.onShift(() => { if (sim.derived === derived) this.update(true); });
  }

  /** Records the rebuild: the FIELDS list's bricks, or every brick. */
  update(all = false) {
    const d = this.derived, sim = d.sim;
    d._dispatch(this.kernel, all ? fold(d.g.nbricks) : d._over(DIRTY.FIELDS), {
      bind: [sim.tables, sim.bindRO, this.group], header: sim.header(), params: { all: all ? 1 : 0 },
    });
  }

  dispose() { this._off?.(); }
}

// tools/check-wgsl.mjs and tools/check-sampler-budget.mjs
export const WGSL_CHECK = [
  { name: 'occupancy', kind: 'compute', code: occupancyFrag, dispatch: (g) => fold(gridDims(g).nbricks),
    layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RO, FIELD_LAYOUT.PAIR] },
];

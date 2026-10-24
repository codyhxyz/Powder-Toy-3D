import { prelude, STATE_OPTS, LAYOUT, STAGE, gridDims } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';

// Passes that move the window over the world (docs/scaling.md D11; driven by
// world/window.js through Simulation.shift and the store). Every shift runs
// out of place (docs/webgpu.md D8.12): it reads the source at p + shift and
// writes the other copy or a scratch, since in place a thread would overwrite
// a cell another thread still has to read. The leaving slab is one kernel of
// shaders/generate.js (sceneDiffFrag, G1); the stored bricks coming back are
// an edit over the entering slab (editFrag, below); the GI probes' shift is
// the derived passes' (U4).
//
// Slab layout. A slab (the cells about to leave the window, or a set of stored
// bricks coming back) is exchanged with the CPU brick by brick, in the D5
// float layout: brick i's 64 cells are entries 64·i .. 64·i + 63, its cells x
// fastest, then y, then z (SLAB_CELL). world/store.js keeps bricks in the same
// order.
export const BRICK_CELLS = 64;                         // cells per 4³ brick

// A slab's cell order, for the kernels that exchange slabs with the store (the
// world's stage and edit, U10; the decoration's, U17): local cell l of a brick
// (x fastest, then y, then z) and back. WGSL, for a module with the prelude
// (BS); the name is the GLSL version's (docs/webgpu.md W2).
export const slabGLSL = /* wgsl */ `
const BRICK_CELLS: i32 = ${BRICK_CELLS};
fn slabCell(l: i32) -> vec3i { return vec3i(l % BS, (l / BS) % BS, l / (BS * BS)); }
fn slabIndex(c: vec3i) -> i32 { return c.x + BS * (c.y + BS * c.z); }
`;

export const ShiftParams = uniformStruct('ShiftParams', { shift: 'vec3i' });
const perSlot = (g) => fold(Math.ceil(gridDims(g).slots / 64));
const slotMain = /* wgsl */ `${ShiftParams.wgsl}
@group(3) @binding(1) var<uniform> P: ShiftParams;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let s = foldThread(wg, nwg, li);
  if (s >= SLOTS) { return; }
  let p = cellOf(s);
  let q = p + P.shift;`;

// Shift: cell p of the copy H.dst takes the state of p + shift in H.src, so
// the content moves by -shift as the window moves by +shift over the world.
// Cells whose source is outside the grid were uncovered: they become still
// air at ambient until the generator fills them. A moved cell keeps its state
// but not its neighbours, so its flags start over (freshFlags: the next
// activity map redoes its neighbour tests).
export const shiftFrag = (g, { debug = false } = {}) => /* wgsl */ `
${prelude(g, { ...STATE_OPTS.STATE_RW, debug })}
${slotMain}
  var a = vec4f(f32(E_EMPTY), airT(), 0.0, 0.0);
  var b = vec4f(0.0);
  if (inGrid(q)) { a = fetchAs(heldSlot(q, s)); b = fetchBs(heldSlot(q, s)); }
  writeStateS(s, a, b, freshFlags(a, b));
}
`;

// Undo after the window moved (docs/scaling.md D10, D11): cell p of the
// current copy takes the snapshot's cell p + shift (the snapshot holds the
// window where it was when it was taken: its A and B in slot order, group 2).
// Cells the snapshot doesn't hold keep what they hold. Restored cells redo
// their neighbour tests (freshFlags). With no shift it is the plain undo.
export const UNDO_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
];
export const undoShiftFrag = (g, { debug = false } = {}) => /* wgsl */ `
${prelude(g, { ...STATE_OPTS.STATE_RW, debug })}
@group(2) @binding(0) var<storage, read> snapA: array<vec4f>;   // the snapshot, slot order
@group(2) @binding(1) var<storage, read> snapB: array<vec4f>;
${slotMain}
  if (!inGrid(q)) { return; }
  let a = snapA[heldSlot(q, s)];
  let b = snapB[heldSlot(q, s)];
  writeStateS(s, a, b, freshFlags(a, b));
}
`;

// The flow field (shaders/move.js) follows the cells like the state: slot s
// of dst takes the flow of cell p + shift in src; cells shifted in from
// outside are still. Any field of two words per slot shifts this way
// (whitewater's aeration too).
export const FLOW_SHIFT_LAYOUT = [
  { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
  { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } },
];
export const flowShiftFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
@group(2) @binding(0) var<storage, read> src: array<vec2u>;
@group(2) @binding(1) var<storage, read_write> dst: array<vec2u>;
${slotMain}
  var w = vec2u(0u);
  if (inGrid(q)) { w = src[heldSlot(q, s)]; }
  dst[s] = w;
}
`;

// (Stored bricks come back natively: v2/integration.js restoreBricks; V1's restore edit went with V1.)
// A ringed grid's move (src/sim.js _shiftRing; common.js ringOf): words a slot of a slot-ordered buffer
// (`words` u32s from word `base`: the flow, the decoration's plane) zeroed over the slab the move uncovered,
// grid cells [lo, lo + 4·bricks) under the new ring, as the shift zeroes a cell from outside the window.
export const SlabZeroParams = uniformStruct('SlabZeroParams', { lo: 'vec3i', bricks: 'vec3i', count: 'u32', base: 'u32', words: 'u32' });
export const SLAB_ZERO_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];
export const slabZeroFrag = (g) => /* wgsl */ `
${prelude(g, { state: false })}
${SlabZeroParams.wgsl}
@group(3) @binding(1) var<uniform> P: SlabZeroParams;
@group(2) @binding(0) var<storage, read_write> buf: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldThread(wg, nwg, li);
  if (i >= P.count) { return; }
  let b = i32(i / 64u); let l = i32(i % 64u);
  let bc = vec3i(b % P.bricks.x, (b / P.bricks.x) % P.bricks.y, b / (P.bricks.x * P.bricks.y));
  let s = slotOf(P.lo + bc * 4 + vec3i(l % 4, (l / 4) % 4, l / 16));
  for (var k = 0u; k < P.words; k++) { buf[P.base + s * P.words + k] = 0u; }
}
`;

const rw = () => [LAYOUT.TABLES, LAYOUT.STATE_RW];
/**
 * tools/check-wgsl.mjs, and the pipelines a grid needs (B5): undoShift every
 * grid (undo is it with no shift), shift, flowShift and the stored bricks'
 * restore a world's grid only.
 */
export const WGSL_CHECK = [
  { name: 'shift', kind: 'compute', code: (g) => shiftFrag(g), layouts: rw, dispatch: perSlot, windowed: true },
  { name: 'undoShift', kind: 'compute', code: (g) => undoShiftFrag(g), layouts: () => [...rw(), UNDO_LAYOUT], dispatch: perSlot },
  { name: 'flowShift', kind: 'compute', code: flowShiftFrag, layouts: () => [LAYOUT.TABLES, 'EMPTY', FLOW_SHIFT_LAYOUT], dispatch: perSlot, windowed: true },
  { name: 'slabZero', kind: 'compute', code: slabZeroFrag, params: SlabZeroParams, layouts: () => [LAYOUT.TABLES, 'EMPTY', SLAB_ZERO_LAYOUT], dispatch: perSlot, windowed: true },
  // slabGLSL on its own (its kernels are U10's and U17's): validated, never warmed
  { name: 'slabProbe', kind: 'compute', tool: true, layouts: () => [LAYOUT.TABLES], dispatch: () => [1, 1, 1],
    code: (g) => `${prelude(g, { state: false })}
${slabGLSL}
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) li: u32) {
  _ = slabIndex(slabCell(i32(li) % BRICK_CELLS));
}` },
];

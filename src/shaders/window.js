import { prelude, STATE_OPTS, LAYOUT, STAGE, gridDims } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';

// Passes that move the window over the world (docs/scaling.md D11; driven by
// world/window.js through Simulation.shift and the store). Every one runs out
// of place (docs/webgpu.md D8.12): it reads the source at p + shift and writes
// the other copy or a scratch, since in place a thread would overwrite a cell
// another thread still has to read. The slab passes (stage, edit, gather) and
// the GI probes' shift are U10's and U4's.
//
// Slab layout. A slab (the cells about to leave the window, or a set of stored
// bricks coming back) is exchanged with the CPU brick by brick, in the D5
// float layout: brick i's 64 cells are entries 64·i .. 64·i + 63, its cells x
// fastest, then y, then z (SLAB_CELL). world/store.js keeps bricks in the same
// order.
export const BRICK_CELLS = 64;                         // cells per 4³ brick
export const STAGE_BRICKS_PER_ROW = 16;                // bricks per staging-texture row (WebGL; U10)
export const STAGE_W = BRICK_CELLS * STAGE_BRICKS_PER_ROW;
export const SLOT_W = 64;                              // slots per row of the slot list (WebGL; U10)

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
  var a = vec4f(f32(E_EMPTY), AMBIENT, 0.0, 0.0);
  var b = vec4f(0.0);
  if (inGrid(q)) { a = fetchA(q); b = fetchB(q); }
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
  let a = snapA[slotOf(q)];
  let b = snapB[slotOf(q)];
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
  if (inGrid(q)) { w = src[slotOf(q)]; }
  dst[s] = w;
}
`;

const stub = (name, unit) => () => { throw new Error(`${name} removed in the WebGPU port: docs/webgpu.md G1 (${unit})`); };
// WEBGPU-STUB (docs/webgpu.md J3): the leaving slab is one kernel (U10, G1)
export const stageFrag = stub('stageFrag', 'U10');
// WEBGPU-STUB (docs/webgpu.md J3): stored bricks are an edit over the slab (U10, G1)
export const editFrag = stub('editFrag', 'U10');
// WEBGPU-STUB (docs/webgpu.md J3)
export const gatherFrag = stub('gatherFrag', 'U10');
// WEBGPU-STUB (docs/webgpu.md J3): the GI probes' shift is the derived passes' (U4, E)
export const giShiftFrag = stub('giShiftFrag', 'U4');

const rw = () => [LAYOUT.TABLES, LAYOUT.STATE_RW];
/** tools/check-wgsl.mjs; a windowed grid's pipelines (built on its first shift). */
export const WGSL_CHECK = [
  { name: 'shift', kind: 'compute', code: (g) => shiftFrag(g), layouts: rw, dispatch: perSlot },
  { name: 'undoShift', kind: 'compute', code: (g) => undoShiftFrag(g), layouts: () => [...rw(), UNDO_LAYOUT], dispatch: perSlot },
  { name: 'flowShift', kind: 'compute', code: flowShiftFrag, layouts: () => [LAYOUT.TABLES, 'EMPTY', FLOW_SHIFT_LAYOUT], dispatch: perSlot },
];

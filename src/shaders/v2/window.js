import { prelude, gridDims, STAGE, LAYOUT } from '../common.js';
import { uniformStruct } from '../../gpu/params.js';
import { fold } from '../../gpu/kernels.js';
import { v2ActLayout, LEGACY_WORD } from '../v2.js';

// Native residency operations are deliberately independent of the physics rule
// layout. Four storage buffers, raw bits throughout: no renderer projection; a
// fifth, the owner's activity, where the scatter notes the bricks it wrote.
export const NativeWindowParams = uniformStruct('NativeWindowParams', {
  shift: 'vec3i', lo: 'vec3i', bricks: 'vec3i', count: 'u32', preserve: 'u32',
});
export const NATIVE_WINDOW_LAYOUT = [0, 1, 2, 3, 4].map(binding => ({
  binding, visibility: STAGE.COMPUTE, buffer: { type: 'storage' },
}));
const declarations = g => `${prelude(g, { state: false })}
${NativeWindowParams.wgsl}
@group(3) @binding(1) var<uniform> P: NativeWindowParams;
@group(2) @binding(0) var<storage, read_write> cores: array<vec4u>;
@group(2) @binding(1) var<storage, read_write> banks: array<i32>;
@group(2) @binding(2) var<storage, read_write> other: array<vec4u>;
@group(2) @binding(3) var<storage, read_write> otherBanks: array<i32>;
@group(2) @binding(4) var<storage, read_write> act: array<u32>;
fn slabSlot(i: u32) -> u32 {
  let b = i / 64u; let l = i % 64u;
  let bc = vec3i(i32(b) % P.bricks.x, (i32(b) / P.bricks.x) % P.bricks.y, i32(b) / (P.bricks.x * P.bricks.y));
  return slotOf(P.lo + bc * 4 + vec3i(i32(l % 4u), i32((l / 4u) % 4u), i32(l / 16u)));
}
`;
export const nativeShiftWGSL = g => `${declarations(g)}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let s = foldThread(wg, nwg, li); if (s >= SLOTS) { return; }
  let q = cellOf(s) + P.shift;
  var c = vec4u(u32(clamp(round((airT() + 273.25) * 4.0), 0.0, 65535.0)) << 8u, 0u, 0u, 0u);
  var bank = 0;
  if (P.preserve != 0u) { c = other[s]; bank = otherBanks[s]; }
  if (inGrid(q)) { let source = slotOf(q); c = cores[source]; bank = banks[source]; }
  other[s] = c; otherBanks[s] = bank;
}
`;
export const nativeGatherWGSL = g => `${declarations(g)}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldThread(wg, nwg, li); if (i >= P.count) { return; }
  let s = slabSlot(i); other[i] = cores[s]; otherBanks[i] = banks[s];
}
`;
export const nativeScatterWGSL = (g, a = v2ActLayout(g)) => `${declarations(g)}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = foldThread(wg, nwg, li); if (i >= P.count) { return; }
  var j = i;
  if (P.preserve != 0u) { j = u32(otherBanks[P.count + i / 64u]) * 64u + i % 64u; }
  let s = slabSlot(j); cores[s] = other[i]; banks[s] = otherBanks[i];
  // the bricks it wrote, and only those (PhysicsV2.noteAllCells' notes, a brick each): their projection
  // is stale, they wake, and the air source reads their cells again with their summaries unknown
  if (i % 64u == 0u) {
    let b = s / 64u;
    act[${a.legacy}u + b] = ${LEGACY_WORD.STALE}u; act[${a.busy0}u + b] = 1u; act[${a.busy1}u + b] = 1u;
    act[${a.state}u + b] = 1u; act[${a.air}u + b] = 1u; act[${a.summary}u + b] = 0u;
  }
}
`;
// A World window move's per-brick words (v2/integration.js shift), carried with their bricks as the cells are, the
// way the derived passes carry their history across a move (shaders/passes.js brickShiftFrag): a brick that stays
// in the window keeps its activity and its air source's cache, so only the bricks the move uncovers and the face
// it bares wake and are read again, never the whole window (each move used to wake and relight all of it).
// [offset, words a brick] runs, each placed at `at` in the move's scratch, run after run: the activity's
// (shaders/v2.js v2ActLayout: both busy words, the quiet run, awake, the drawn-projection, cell, request and air
// notes, the summary, the tick's change, the support's occupancy bits), then the air source's cache (the
// dynamics' faces, shaders/v2/air.js: its open faces, then its vacuum, a vec4f a brick each). The legacy word
// moves with the dynamics' (shaders/v2/windowMove.js); the rest of the activity (the per-tick lists and counts,
// the energy ledger) starts over, as a restore's does (v2/physics.js restore).
export function nativeMovedRuns(g, a = v2ActLayout(g)) {
  const nb = gridDims(g).nbricks;
  let at = 0;
  const place = ([offset, words]) => { const run = { offset, words, at }; at += words * nb; return run; };
  const act = [a.busy0, a.busy1, a.quiet, a.awake, a.visible, a.state, a.events, a.air, a.summary, a.changed, a.moveQuiet].map(o => [o, 1]).concat([[a.occ, 2]]).map(place);
  const faces = [[0, 4], [4 * nb, 4]].map(place);
  return { act, faces, words: at };
}
// A thread a brick: brick b takes the moved words of the brick at b + shift (P.shift, cells: whole bricks) from
// the scratch (`moved`, nativeMovedRuns' order), into the cleared activity and the faces. A brick the move uncovers
// is noted as a restore notes every brick (busy, its cells, requests and air live, summary and occupancy unknown)
// and its change reported (the tick's change word: World's renderer reads its slab again, the slab alone). The face
// the move bares (the moving axis's first or last bricks, held from inside the window) wakes and its air source
// reads it again: the grid's edge reaches it now. Their neighbours wake by the activity scan (a busy brick's 3³)
// and re-read their faces by the air source's (a face neighbour's note).
// the statements carrying runs into `into`, brick src's words to brick b's
const carry = (into, runs) => runs.flatMap(({ offset, words, at }) => Array.from({ length: words }, (_, k) => words === 1
  ? `    ${into}[${offset}u + b] = moved[${at}u + src];`
  : `    ${into}[${offset + k}u + ${words}u * b] = moved[${at + k}u + ${words}u * src];`)).join('\n');
export const nativeActShiftWGSL = (g, a = v2ActLayout(g), r = nativeMovedRuns(g, a)) => `${prelude(g, { state: false })}
${NativeWindowParams.wgsl}
@group(3) @binding(1) var<uniform> P: NativeWindowParams;
@group(2) @binding(0) var<storage, read_write> faces: array<u32>;
@group(2) @binding(2) var<storage, read_write> moved: array<u32>;
@group(2) @binding(4) var<storage, read_write> act: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = foldThread(wg, nwg, li);
  // the particle pool's live bits: every one set, as a restore sets them (PhysicsV2.noteAllCells)
  for (var w = b; w < ${a.liveWords}u; w += NBRICKS) { act[${a.plive}u + w] = 0xffffffffu; }
  if (b >= NBRICKS) { return; }
  let bc = brickCoord(b);
  let q = bc + P.shift / BS;
  if (all(q >= vec3i(0)) && all(q < vec3i(BX, BY, BZ))) {
    let src = brickId(q);
${carry('act', r.act)}
${carry('faces', r.faces)}
    let bared = ((P.shift > vec3i(0)) & (bc == vec3i(0))) | ((P.shift < vec3i(0)) & (bc == vec3i(BX, BY, BZ) - 1));
    if (!any(bared)) { return; }
  } else {
    act[${a.events}u + b] = 1u; act[${a.changed}u + b] = 1u;
  }
  act[${a.busy0}u + b] = 1u; act[${a.busy1}u + b] = 1u; act[${a.quiet}u + b] = 0u;
  act[${a.state}u + b] = 1u; act[${a.air}u + b] = 1u;
}
`;
export const WGSL_CHECK = [
  ['nativeShift', nativeShiftWGSL], ['nativeGather', nativeGatherWGSL], ['nativeScatter', nativeScatterWGSL],
].map(([name, code]) => ({ name, code, kind: 'compute', params: NativeWindowParams, warm: false,
  layouts: () => [LAYOUT.TABLES, 'EMPTY', NATIVE_WINDOW_LAYOUT], dispatch: g => fold(Math.ceil(g.slots / 64)) })).concat([
  { name: 'nativeActShift', code: nativeActShiftWGSL, kind: 'compute', params: NativeWindowParams, warm: false,
    layouts: () => [LAYOUT.TABLES, 'EMPTY', NATIVE_WINDOW_LAYOUT], dispatch: g => fold(Math.ceil(gridDims(g).nbricks / 64)) },
]);

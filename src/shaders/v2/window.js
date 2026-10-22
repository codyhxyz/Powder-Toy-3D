import { prelude, STAGE, LAYOUT } from '../common.js';
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
export const WGSL_CHECK = [
  ['nativeShift', nativeShiftWGSL], ['nativeGather', nativeGatherWGSL], ['nativeScatter', nativeScatterWGSL],
].map(([name, code]) => ({ name, code, kind: 'compute', params: NativeWindowParams, warm: false,
  layouts: () => [LAYOUT.TABLES, 'EMPTY', NATIVE_WINDOW_LAYOUT], dispatch: g => fold(Math.ceil(g.slots / 64)) }));

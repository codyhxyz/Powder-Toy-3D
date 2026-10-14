import { prelude, LAYOUT, STAGE } from '../common.js';
import { compactDecodeWGSL } from '../compact.js';
import { TransferParams, TRANSFER_SLOTS } from '../transfer.js';
import { machineGuardWGSL } from '../industry.js';

export const NATIVE_TRANSFER_LAYOUT = [0, 1, 2, 3].map(binding => ({ binding, visibility: STAGE.COMPUTE,
  buffer: { type: binding === 3 ? 'read-only-storage' : 'storage' } }));
export const nativeTransferWGSL = g => `${prelude(g, { state: false })}
${compactDecodeWGSL}
${TransferParams.wgsl}
@group(3) @binding(1) var<uniform> P: TransferParams;
@group(2) @binding(0) var<storage, read_write> cores: array<vec4u>;
@group(2) @binding(1) var<storage, read_write> banks: array<i32>;
@group(2) @binding(2) var<storage, read_write> result: array<u32>;
@group(2) @binding(3) var<storage, read> items: array<vec4u>;
fn fetchA(p: vec3i) -> vec4f { if (!inGrid(p)) { return vec4f(-1.0, 0.0, 0.0, 0.0); } return compactProbeA(p, cores[slotOf(p)]); }
${machineGuardWGSL}
var<workgroup> ranks: array<u32, ${TRANSFER_SLOTS}>;
fn qualifies(i: u32, a: vec4f) -> bool {
  if (!machineEnabled(P.guardBase, P.guardMaterial, P.guardPort, P.guardPowered)) { return false; }
  let id = eid(a);
  if (P.mode == 1u) { return id == E_EMPTY; }
  let want = i32(floor(P.cells[i].w + 0.5));
  if (id == E_EMPTY || a.y > P.maxTemperature || (want >= 0 && id != want)) { return false; }
  if ((P.kinds & (1u << u32(KIND(id)))) == 0u) { return false; }
  if (P.only != 0u) { let u = u32(id); if (((P.allow[u >> 7u][(u >> 5u) & 3u] >> (u & 31u)) & 1u) == 0u) { return false; } }
  if (P.breaks == 0u || KIND(id) != K_SOLID) { return true; }
  return BREAKINTO(id) >= 0 && HARD(id) <= P.maxHard;
}
fn fromLegacy(a: vec4f) -> vec4u {
  let id = u32(eid(a)); let tq = u32(clamp(round((a.y + 273.25) * 4.0), 0.0, 65535.0));
  let ct = u32(max(0.0, floor(a.w))) & 255u;
  if (KIND(i32(id)) == K_LIQUID) { return vec4u(id | (tq << 8u), 65536u | (ct << 24u), 0u, 0u); }
  return vec4u(id | (tq << 8u), u32(clamp(a.z, 0.0, 65535.0)) | (ct << 16u), 0u, u32(fract(a.w) * 65536.0) << 16u);
}
@compute @workgroup_size(${TRANSFER_SLOTS})
fn main(@builtin(local_invocation_index) i: u32) {
  var q = 0u; var s = 0u; var c = vec4u(0u); var bank = 0; var a = vec4f(0.0);
  if (i < P.count) {
    let p = vec3i(floor(P.cells[i].xyz + 0.5));
    if (inGrid(p)) { s = slotOf(p); c = cores[s]; bank = banks[s]; a = compactProbeA(p, c); if (qualifies(i, a)) { q = 1u; } }
  }
  ranks[i] = q;
  for (var off = 1u; off < ${TRANSFER_SLOTS}u; off <<= 1u) {
    workgroupBarrier(); var v = ranks[i]; if (i >= off) { v += ranks[i - off]; }
    workgroupBarrier(); ranks[i] = v;
  }
  workgroupBarrier();
  // Every guard/neighbour read completes before any material write.
  storageBarrier();
  let rank = ranks[i] - q;
  var out = vec4f(-1.0, 0.0, 0.0, 0.0); var carried = vec4u(0u); var carriedBank = 0;
  if (q == 1u && rank < P.limit) {
    if (P.mode == 1u) {
      out.x = f32(rank);
      var put = items[2u * rank]; let extra = items[2u * rank + 1u];
      if (extra.y == 0u) { put = fromLegacy(P.items[rank]); }
      cores[s] = put; banks[s] = bitcast<i32>(extra.x);
    } else {
      var got = eid(a);
      if (P.breaks != 0u && KIND(got) == K_SOLID) { got = BREAKINTO(got); }
      carried = vec4u((c.x & 0xffffff00u) | u32(got), c.yzw); carriedBank = bank;
      out = vec4f(f32(got), a.yzw);
      cores[s] = vec4u(u32(clamp(round((airT() + 273.25) * 4.0), 0.0, 65535.0)) << 8u, 0u, 0u, 0u);
      banks[s] = 0;
    }
  }
  if (i < P.count) {
    let at = i * 9u; let legacy = bitcast<vec4u>(out);
    for (var w = 0u; w < 4u; w++) { result[at + w] = legacy[w]; result[at + 4u + w] = carried[w]; }
    result[at + 8u] = bitcast<u32>(carriedBank);
  }
}
`;
export const WGSL_CHECK = [{ name: 'nativeTransfer', code: nativeTransferWGSL, kind: 'compute', params: TransferParams,
  warm: false, layouts: () => [LAYOUT.TABLES, 'EMPTY', NATIVE_TRANSFER_LAYOUT], dispatch: () => [1, 1, 1] }];

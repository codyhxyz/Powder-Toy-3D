import { prelude, BRICK } from '../common.js';
import { slabGLSL, BRICK_CELLS } from '../window.js';
import { LeaveParams, LEAVE_BINDING } from '../generate.js';
import { v2ImportWGSL, v2Rows, V2, FULL, T_OFFSET } from '../v2.js';
import { ELEMENTS } from '../../elements.js';
import { lifeScale } from '../../v2/layout.js';

// Physics V2's leaving slab (world/window.js readBack): which bricks a native
// world's store must keep.
//
// V1 keeps a leaving brick only while it differs from what the generator makes
// there (shaders/generate.js sceneDiffFrag + cellDiffers: any A or B word not
// bit-equal to sceneCell's; world/window.js readBack drops the rest), because a
// brick that comes back into the window is generated again first: a matching
// brick costs nothing to forget. V2's cells are not V1's words, so V1's diff of
// V2's projection matches almost nothing (its air and liquid seeds are per
// window cell, compact.js compactA) and V2's store kept every brick.
//
// A brick entering a V2 window is the generator's fill imported: v2import's
// owned path (shaders/v2.js importA, bank 0; the fill owns every cell of its
// slab, generate.js FILL_UPDATE ownLegacy). So V2 keeps a leaving brick only
// while its cores differ from importA of the generator's cell, bit for bit;
// world/window.js readBack also keeps any with a nonzero energy bank (the
// import's is 0). Everything else regenerates exactly. importA is the import
// kernel's own text, taken from its generated module, so the two can't drift;
// the helpers it calls are restated over the same element rows.

// The prelude's readers with V2's cells bound (Simulation.bindRO under V2:
// PhysicsV2.groups.read), the format fixed at native: fetchNativeCore reads the core.
const NATIVE_LEAVE_STATE = { state: 'read', fixedReadFormat: 2 };
const IMPORT_A = /fn importA\(a: vec4f\) -> vec4u \{\n[\s\S]*?\n\}\n/;

/** importA's WGSL, as the import kernel compiles it. */
export function importAWGSL(g) {
  const m = v2ImportWGSL(g).match(IMPORT_A);
  if (!m) throw new Error('v2 leave: the import kernel has no importA');
  return m[0];
}

// What importA calls (shaders/v2.js v2Head and v2/state.js), restated over the
// same JS rows: the element's v2 class, its gas fade, life scale and conduction.
const rows = v2Rows();
export const nativeImportHelpersWGSL = /* wgsl */ `
const FULLU: u32 = ${FULL}u;
const T_OFFSET: f32 = ${T_OFFSET};
const C_AIR: u32 = ${V2.AIR}u;
const C_LIQUID: u32 = ${V2.LIQUID}u;
const C_GAS: u32 = ${V2.GAS}u;
const LEAVE_ID_MASK: u32 = 255u;         // core x: the element id's byte (v2/layout.js cid)
const LEAVE_PAYLOAD_MAX: f32 = 65535.0;  // a 16-bit life/fuel payload (v2/layout.js withPayload)
const LEAVE_SPARK_MASK: u32 = 4095u;     // a conductor's 12-bit spark code (v2/state.js withSpark)
const LEAVE_CLASS = array<u32, ${rows.length}>(${rows.map(r => `${r.cls}u`).join(',')});
const LEAVE_FADES = array<bool, ${rows.length}>(${rows.map(r => String(r.fade > 0)).join(',')});
const LEAVE_LIFE_SCALE = array<f32, ${ELEMENTS.length}>(${ELEMENTS.map(e => `${lifeScale(e.id)}.0`).join(',')});
const LEAVE_CONDUCTS = array<bool, ${ELEMENTS.length}>(${ELEMENTS.map(e => String(e.elec > 0)).join(',')});
fn cls(id: u32) -> u32 { return LEAVE_CLASS[id]; }
fn fadeOf(id: u32) -> f32 { return select(0.0, 1.0, LEAVE_FADES[id]); }
fn conductsNative(id: u32) -> bool { return LEAVE_CONDUCTS[id]; }
fn leaveLiquid(c: vec4u) -> bool { return LEAVE_CLASS[c.x & LEAVE_ID_MASK] == C_LIQUID; }
fn withLife(c: vec4u, v: f32) -> vec4u {
  let payload = u32(clamp(round(v * LEAVE_LIFE_SCALE[c.x & LEAVE_ID_MASK]), 0.0, LEAVE_PAYLOAD_MAX));
  var o = c;
  if (leaveLiquid(c)) { o.w = (c.w & 0xffffu) | (payload << 16u); } else { o.y = (c.y & 0xffff0000u) | payload; }
  return o;
}
fn withSpark(c: vec4u, code: u32) -> vec4u {
  var o = c;
  if (leaveLiquid(c)) { o.w = (c.w & ~(LEAVE_SPARK_MASK << 16u)) | ((code & LEAVE_SPARK_MASK) << 16u); }
  else { o.w = (c.w & ~LEAVE_SPARK_MASK) | (code & LEAVE_SPARK_MASK); }
  return o;
}
`;

/**
 * The native leaving slab's kernel for a scene: sceneDiffFrag's workgroup a
 * brick, head and gathered projection (the legacy store's bytes), with V2's
 * test of a differing cell. Same layouts, params and dispatch as sceneDiffFrag.
 */
export const sceneNativeDiffFrag = (g, sceneGLSL) => /* wgsl */ `
${prelude(g, NATIVE_LEAVE_STATE)}
${sceneGLSL}
${slabGLSL}
${nativeImportHelpersWGSL}
${importAWGSL(g)}
${LeaveParams.wgsl}
@group(3) @binding(1) var<uniform> P: LeaveParams;
struct LeaveHead { count: atomic<u32>, keys: array<u32> }
@group(2) @binding(${LEAVE_BINDING.head}) var<storage, read_write> head: LeaveHead;
@group(2) @binding(${LEAVE_BINDING.cells}) var<storage, read_write> slab: array<vec4f>;
var<workgroup> wgDiffers: atomic<u32>;
var<workgroup> wgFlag: u32;
var<workgroup> wgSlot: u32;
@compute @workgroup_size(${BRICK}, ${BRICK}, ${BRICK})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u,
        @builtin(local_invocation_id) lid: vec3u, @builtin(local_invocation_index) li: u32) {
  let k = foldId(wg, nwg);
  let nb = vec3u(P.bricks);
  let live = k < nb.x * nb.y * nb.z;   // (the same for the whole workgroup: a brick each)
  let b = vec3i(vec3u(k % nb.x, (k / nb.x) % nb.y, k / max(nb.x * nb.y, 1u)));
  let p = P.lo + b * BS + vec3i(lid);
  var a = vec4f(0.0);
  var bb = vec4f(0.0);
  if (live && inGrid(p)) {
    a = fetchA(p);
    bb = fetchB(p);
    let generated = sceneCell(H.origin + p);
    if (any(fetchNativeCore(p) != importA(generated.A))) { atomicOr(&wgDiffers, 1u); }
  }
  workgroupBarrier();
  if (li == 0u) { wgFlag = atomicLoad(&wgDiffers); }
  if (workgroupUniformLoad(&wgFlag) == 0u) { return; }
  if (li == 0u) {
    let slot = atomicAdd(&head.count, 1u);
    let w = P.wlo + b;
    head.keys[slot] = u32((w.z * P.wb.y + w.y) * P.wb.x + w.x);
    wgSlot = slot;
  }
  let slot = workgroupUniformLoad(&wgSlot);
  let l = u32(slabIndex(vec3i(lid)));
  slab[slot * ${2 * BRICK_CELLS}u + l] = a;
  slab[slot * ${2 * BRICK_CELLS}u + ${BRICK_CELLS}u + l] = bb;
}
`;

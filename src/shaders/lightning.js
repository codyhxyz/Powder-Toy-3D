import { prelude, STATE_OPTS, LAYOUT, STAGE, EDIT_FIELDS, editKernelWGSL } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { boltGLSL, BOLT, STORM } from '../bolt.js';

// GPU kernels for lightning (src/bolt.js has the rules, src/lightning.js runs
// them; docs/webgpu.md G4).

// The bolt: an edit (docs/webgpu.md D6) over the bolt's bounds, which changes
// only cells whose centres lie inside lo..hi and reads only its own cell, so
// it writes in place. Along the channel's segments, air and gas become plasma
// with the channel's overpressure, and matter takes BOLT_E of heat; around
// the strike point, matter takes STRIKE_E (full inside STRIKE_CORE of the
// radius), a conductor there a spark (sparkCell), and the air STRIKE_P; cloud
// within dischargeR of the origin loses its charge (ctype).
export const BoltParams = uniformStruct('BoltParams', {
  ...EDIT_FIELDS,
  segA: `array<vec4f, ${BOLT.MAX_SEGS}>`,   // segment start (cells); w: channel radius (cells)
  segB: `array<vec4f, ${BOLT.MAX_SEGS}>`,   // segment end (cells)
  strike: 'vec3f',      // where it lands (cells)
  strikeR: 'f32',
  boltFrom: 'vec3f',    // where it left the cloud (cells)
  dischargeR: 'f32',    // 0: a tool bolt (no cloud to discharge)
  lo: 'vec3f',          // bounds of every cell it changes (cell centres)
  segs: 'i32',
  hi: 'vec3f',
  frame: 'u32',         // the bolt's own count (its random stream)
});
// The edit's update (sim.editKernel's `update` and `decls`): fn update(p, a, b, oA, oB).
export const boltDeclsWGSL = boltGLSL();
export const boltUpdateWGSL = /* wgsl */ `
fn segDist(c: vec3f, a: vec3f, b: vec3f) -> f32 {
  let ab = b - a;
  let t = clamp(dot(c - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(c - a - ab * t);
}
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let c = vec3f(p) + 0.5;
  if (any(c < P.lo) || any(c > P.hi)) { return; }
  let id = eid(a);
  let open = id == E_EMPTY || KIND(id) == K_GAS;
  var channel = false;
  for (var i = 0; i < BOLT_MAX_SEGS; i++) {
    if (i >= P.segs) { break; }
    if (segDist(c, P.segA[i].xyz, P.segB[i].xyz) < P.segA[i].w) { channel = true; break; }
  }
  if (channel) {
    if (open) {
      var rs = seed3(p, P.frame, BOLT_RNG_SALT);
      *oA = vec4f(f32(E_PLASMA), SPAWNT(E_PLASMA), SPAWNLIFE(E_PLASMA), rnd(&rs) * SEED_MAX);
      *oB = vec4f(0.0, 0.0, 0.0, min(b.w + BOLT_P, P_MAX));
    } else {
      (*oA).y = min(a.y + BOLT_E / CAP(id), CELL_TEMP_MAX);
    }
  }
  let r = length(c - P.strike);
  if (!open && r < P.strikeR) {
    let f = 1.0 - smoothstep(P.strikeR * STRIKE_CORE, P.strikeR, r);
    (*oA).y = min((*oA).y + STRIKE_E * f / CAP(id), CELL_TEMP_MAX);
    _ = sparkCell(oA);   // the bolt lands: a ready conductor it hits takes a full spark (src/electricity.js)
  }
  if (open && r < P.strikeR + STRIKE_P_REACH) { (*oB).w = min(max((*oB).w, STRIKE_P), P_MAX); }
  if (eid(*oA) == E_CLOUD && length(c - P.boltFrom) < P.dischargeR) { (*oA).w = fract(a.w); }   // charge spent
}
`;
// The whole module, as sim.editKernel('bolt', …) builds it (check-wgsl).
export const boltFrag = (g, { debug = false } = {}) => editKernelWGSL(g, {
  update: boltUpdateWGSL, params: BoltParams, reads: 'own', decls: boltDeclsWGSL, debug,
});

// Storms: find a cloud cell charged to breakdown (react.js CHARGE_*) in one
// dispatch, a workgroup per brick and a thread per cell: each cell's key is
// its charge above the slot it holds (charge · 2²³ + (2²³ − 1 − slot); 0 for
// no cloud at CHARGE_BREAKDOWN), the workgroup takes the largest, and its
// first thread folds that into the result's word with atomicMax. The result
// is the most charged cell, the lowest slot of those most charged: a pure
// function of the state, whatever order the workgroups run in. One u32 in a
// slot of the storm's result ring (src/lightning.js), cleared before.
export const STORM_KEY = { CHARGE_SHIFT: 23, SLOT_MAX: (1 << 23) - 1 };
export const StormParams = uniformStruct('StormParams', { slot: 'u32' });   // the ring slot, in its words: slot · 4
export const STORM_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];
// the name is the WebGL brick pass's (W2): it reduced bricks, then rows, then one texel
export const stormBrickFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${StormParams.wgsl}
@group(3) @binding(1) var<uniform> P: StormParams;
@group(2) @binding(0) var<storage, read_write> result: array<atomic<u32>>;
const CHARGE_SHIFT: u32 = ${STORM_KEY.CHARGE_SHIFT}u;
const SLOT_MAX: u32 = ${STORM_KEY.SLOT_MAX}u;
const CHARGE_KEY_MAX: f32 = ${(1 << (32 - STORM_KEY.CHARGE_SHIFT)) - 1}.0;
var<workgroup> best: atomic<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = foldId(wg, nwg);
  if (b < NBRICKS) {
    let s = b * 64u + li;
    let a = fetchAs(s);
    let q = floor(a.w);
    if (eid(a) == E_CLOUD && q >= CHARGE_BREAKDOWN) {
      atomicMax(&best, (u32(min(q, CHARGE_KEY_MAX)) << CHARGE_SHIFT) | (SLOT_MAX - s));
    }
  }
  workgroupBarrier();
  if (li == 0u) {
    let k = atomicLoad(&best);
    if (k != 0u) { atomicMax(&result[P.slot * 4u], k); }
  }
}
`;

// The leader's candidate columns (bolt.js stormColumns): a thread each, the
// highest matter cell (not air, not gas) below fromY: (y, id, 1, 0), y = -1
// for the floor; (0, 0, 0, 0) for a column outside the box. Into a slot of
// the scan's result ring, STORM_CANDIDATES vec4f.
export const ScanParams = uniformStruct('ScanParams', {
  cols: `array<vec4f, ${STORM.CANDIDATES}>`,   // the columns, (x, z) in xy
  count: 'i32',
  fromY: 'f32',
  slot: 'u32',
});
export const stormScanFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RO)}
${boltGLSL()}
${ScanParams.wgsl}
@group(3) @binding(1) var<uniform> P: ScanParams;
@group(2) @binding(0) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(${STORM.CANDIDATES})
fn main(@builtin(local_invocation_index) k: u32) {
  var o = vec4f(0.0);
  let xz = vec2i(P.cols[k].xy);
  if (i32(k) < P.count && xz.x >= 0 && xz.y >= 0 && xz.x < NX && xz.y < NZ) {
    o = vec4f(-1.0, -1.0, 1.0, 0.0);
    for (var y = min(i32(P.fromY) - 1, NY - 1); y >= 0; y--) {
      let id = eid(fetchA(vec3i(xz.x, y, xz.y)));
      if (id != E_EMPTY && KIND(id) != K_GAS) { o = vec4f(f32(y), f32(id), 1.0, 0.0); break; }
    }
  }
  result[P.slot * u32(STORM_CANDIDATES) + k] = o;
}
`;

/** tools/check-wgsl.mjs (docs/webgpu.md I1) */
const stormLayouts = () => [LAYOUT.TABLES, LAYOUT.STATE_RO, STORM_LAYOUT];
export const WGSL_CHECK = [
  { name: 'bolt', kind: 'compute', code: boltFrag, params: BoltParams, warm: false, workgroupSize: [4, 4, 4],
    layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW], dispatch: (g) => fold(g.nbricks) },
  { name: 'stormSearch', kind: 'compute', code: stormBrickFrag, params: StormParams, warm: false, layouts: stormLayouts, dispatch: (g) => fold(g.nbricks) },
  { name: 'stormScan', kind: 'compute', code: stormScanFrag, params: ScanParams, warm: false, layouts: stormLayouts, dispatch: () => [1, 1, 1] },
];

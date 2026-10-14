import { prelude, LAYOUT, STATE_OPTS } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { RING_LAYOUT, ringWGSL } from './povBody.js';
import { MACHINE_GUARD_FIELDS, machineGuardWGSL } from './industry.js';

// Exact cell transfer (src/pov/tools/transfer.js): taking cells out of the grid
// and putting them back with nothing lost or duplicated.
//
// A transfer is a short list of slots (cells), in its params:
//   cells[i] = (cell xyz, wanted element id or -1 for any)
//   items[r] = the r-th cell's contents to place (state A), puts only
// A slot qualifies when its cell passes the transfer's filter: for a take, the
// cell holds a wanted element of an allowed kind (and, when breaking, a solid
// comes out only if it can break and its hardness is at most maxHard: what
// the blows so far have beaten; loose kinds come out as they are; with `only`,
// just the elements whose bit is set in `allow`: a tool's own materials); for a put,
// the cell is empty air. Of the qualifying slots
// only the first `limit` act, in slot order, so the caller decides which cells
// go first (nearest the aim) and how many at most (what the load can hold).
//
// One dispatch of one workgroup, a thread per slot (docs/webgpu.md D7, W18):
// every thread tests its slot against the state, the workgroup ranks the
// qualifying slots (an exclusive prefix sum over the slot order), and only
// then does each acting thread write its own cell: the acting cells become air
// at the ambient temperature (take) or the placed item (put), and the answer
// for the CPU, per slot, goes into a ring slot (B7): what was taken (state A,
// the debris id when breaking) or the rank of the item placed there, else
// id/rank -1. Every test reads the state before any write, and the CPU never
// lists a cell twice, so the CPU learns exactly what the grid gained or lost,
// however the world moves while the readback is in flight.

export const TRANSFER_SLOTS = 256;      // cells one transfer can touch (= vec4s read back)
export const TRANSFER_TAKE = 0;         // mode
export const TRANSFER_PUT = 1;
export const TRANSFER_BYTES = TRANSFER_SLOTS * 16;   // one transfer's answer (a ring slot)
export const ALLOW_IDS = 256;           // element ids an `allow` mask covers (ids stay ≤ 255: the far field's bytes)
const ALLOW_VEC4S = ALLOW_IDS / 128;    // 128 bits a vec4u

export const TransferParams = uniformStruct('TransferParams', {
  count: 'u32',       // slots in use
  limit: 'u32',       // at most this many qualifying slots act (in slot order)
  mode: 'u32',        // TRANSFER_TAKE or TRANSFER_PUT
  kinds: 'u32',       // take: bit (1 << kind) for each element kind it may take
  vel: 'vec3f',       // put: velocity of the placed cells, cells/step
  breaks: 'u32',      // take: solids come out as their debris (BREAKINTO)
  maxHard: 'f32',     // take, breaking: the hardest solid that comes out (HARD units)
  only: 'u32',        // take: 1 = only the elements in `allow`
  allow: `array<vec4u, ${ALLOW_VEC4S}>`,   // take: a bit per element id (id >> 5 picks the u32, id & 31 the bit)
  maxTemperature: 'f32', // take: exclusive upper bound; defaults to unbounded
  ...MACHINE_GUARD_FIELDS, // optional atomic machine interlock (material -1 disables)
  slot: 'u32',        // the ring slot the answer goes to
  cells: `array<vec4f, ${TRANSFER_SLOTS}>`,
  items: `array<vec4f, ${TRANSFER_SLOTS}>`,
});

export const transferFrag = (g) => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RW)}
${TransferParams.wgsl}
@group(3) @binding(1) var<uniform> P: TransferParams;
${ringWGSL()}
${machineGuardWGSL}
const TRANSFER_SLOTS: u32 = ${TRANSFER_SLOTS}u;
const MODE_PUT: u32 = ${TRANSFER_PUT}u;
var<workgroup> ranks: array<u32, ${TRANSFER_SLOTS}>;   // qualifying slots up to each one (inclusive)

// Does slot i's cell, holding a, pass the transfer's filter?
fn qualifies(i: u32, a: vec4f) -> bool {
  let id = eid(a);
  if (!machineEnabled(P.guardBase, P.guardMaterial, P.guardPort, P.guardPowered)) { return false; }
  if (P.mode == MODE_PUT) { return id == E_EMPTY; }
  if (a.y >= P.maxTemperature) { return false; }
  let want = i32(floor(P.cells[i].w + 0.5));
  if (id == E_EMPTY || (want >= 0 && id != want)) { return false; }
  if ((P.kinds & (1u << u32(KIND(id)))) == 0u) { return false; }
  if (P.only != 0u) {
    let u = u32(id);
    if (((P.allow[u >> 7u][(u >> 5u) & 3u] >> (u & 31u)) & 1u) == 0u) { return false; }
  }
  if (P.breaks == 0u || KIND(id) != K_SOLID) { return true; }
  return BREAKINTO(id) >= 0 && HARD(id) <= P.maxHard;
}

@compute @workgroup_size(${TRANSFER_SLOTS})
fn main(@builtin(local_invocation_index) i: u32) {
  // 1. the test, on the state before the transfer
  var q = 0u;
  var c = vec3i(0);
  var a = vec4f(0.0);
  var b = vec4f(0.0);
  if (i < P.count) {
    c = vec3i(floor(P.cells[i].xyz + 0.5));
    if (inGrid(c)) {
      a = fetchA(c);
      b = fetchB(c);
      if (qualifies(i, a)) { q = 1u; }
    }
  }
  // 2. the ranks: an inclusive prefix sum over the slots (Hillis & Steele)
  ranks[i] = q;
  for (var off = 1u; off < TRANSFER_SLOTS; off <<= 1u) {
    workgroupBarrier();
    var v = ranks[i];
    if (i >= off) { v += ranks[i - off]; }
    workgroupBarrier();
    ranks[i] = v;
  }
  workgroupBarrier();
  let rank = ranks[i] - q;
  // 3. the acting slots write their own cells (no two slots share one)
  var out = vec4f(-1.0, 0.0, 0.0, 0.0);
  if (q == 1u && rank < P.limit) {
    var oA: vec4f;
    var oB: vec4f;
    if (P.mode == MODE_PUT) {
      out = vec4f(f32(rank), 0.0, 0.0, 0.0);
      oA = P.items[rank];
      oB = vec4f(P.vel, b.w);
    } else {
      let id = eid(a);
      var got = id;
      if (P.breaks != 0u && KIND(id) == K_SOLID) { got = BREAKINTO(id); }
      out = vec4f(f32(got), a.yzw);
      // air at ambient, keeping the cell's random seed and the air pressure
      oA = vec4f(f32(E_EMPTY), airT(), 0.0, fract(a.w));
      oB = vec4f(0.0, 0.0, 0.0, b.w);
    }
    if (writeCell(c, a, b, fetchF(c), oA, oB)) { markBrick(brickId(c >> vec3u(2u))); }
  }
  if (i < P.count) { ringOut[P.slot * TRANSFER_SLOTS + i] = out; }
}
`;

/** tools/check-wgsl.mjs (docs/webgpu.md I1) */
export const WGSL_CHECK = [
  { name: 'povTransfer', kind: 'compute', code: (g) => transferFrag(g), layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, RING_LAYOUT], dispatch: () => [1, 1, 1] },
];

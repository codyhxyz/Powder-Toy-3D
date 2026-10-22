import { prelude } from '../common.js';
import { v2ActLayout, LEGACY_WORD } from '../v2.js';
import { DynamicParams, storageLayout, shockBase, heldBase, setOffBase } from './particles.js';
import { auxLayout } from './state.js';
import { PARTICLE_CAP } from '../../v2/dynamics-reference.js';

// V2's dynamics across a World window move, recorded into the frame's encoder
// like V1's (src/sim.js shift: one out-of-place pass, then the cells are where
// they belong before the next step) and never awaited. The particles keep
// their world coordinates; what is laid out by window cell moves with the
// cells: each cell's material requests (events), each brick's air, its shocks
// and its legacy word (shaders/v2.js LEGACY_WORD: the brick's A/B projection
// moves with it in V1's shift, so only the bricks the move uncovers are
// stale). The slab that leaves is gathered into `work` and read back without
// a wait: its air goes to the dynamics' world-keyed archive, its requests to
// the outside obligations (src/v2/dynamics.js). The slab that comes in is
// uploaded from them before the move.
//
// The same pass, with `preserve`, merges an undo snapshot over the current
// state across a move (src/sim.js undo, V1's undoShift): cells the snapshot's
// window shares with this one are restored, the rest keep what they hold.
//
// One pipeline, its modes in P.mode. DynamicParams' fields carry the move (no
// new uniform field): shift, boxStart (the slab's lo, cells), boxSize (the
// slab's bricks), substep (an entry count), blastBounded (preserve),
// blastLo/blastHi (the shared world box, PARTICLES).
export const WINDOW_LAYOUT = storageLayout(5);   // events, air (the source copy), control, work, particles
export const WINDOW_STAGES = ['move'];
export const WINDOW_MODE = Object.freeze({ SHIFT: 0, GATHER: 1, EVENTS: 2, PARTICLES: 3 });

// `work`'s regions, u32 words: the moved copies (written whole by SHIFT, then
// copied back), then the slab's io (incoming air, leaving requests, leaving
// air, incoming request list), or for PARTICLES the snapshot's pool records,
// set-off marks and decoration.
export function windowWork(g) {
  const events = 0, air = g.slots, legacy = air + 8 * g.nbricks, shocks = legacy + g.nbricks, io = shocks + g.nbricks;
  const slab = n => ({ incoming: io, leaveEvents: io + 8 * n, leaveAir: io + 72 * n, list: io + 80 * n });
  const pool = { particles: io, setOff: io + 12 * PARTICLE_CAP, deco: io + 13 * PARTICLE_CAP };
  return { events, air, legacy, shocks, io, slab, pool,
    words: (n, entries) => io + Math.max(80 * n + 2 * entries, 14 * PARTICLE_CAP) };
}

function head(g) {
  const common = prelude(g, { state: false });
  const grid = common.slice(0, common.indexOf('// ---- the element tables'));
  const layout = common.slice(common.indexOf('// ---- the header and the state'), common.indexOf('// ---- the state\'s accessors'));
  const a = v2ActLayout(g), w = windowWork(g);
  return /* wgsl */ `${grid}
${layout}
${DynamicParams.wgsl}
@group(3) @binding(1) var<uniform> P: DynamicParams;
@group(0) @binding(1) var<storage, read_write> aux: array<u32>;
@group(0) @binding(2) var<storage, read_write> act2: array<atomic<u32>>;
@group(1) @binding(0) var<storage, read_write> events: array<u32>;
@group(1) @binding(1) var<storage, read_write> air: array<u32>;
@group(1) @binding(2) var<storage, read_write> control: array<atomic<u32>>;
@group(1) @binding(3) var<storage, read_write> work: array<u32>;
@group(1) @binding(4) var<storage, read_write> particles: array<u32>;
const W_LEGACY_AT: u32 = ${a.legacy}u;
const W_STALE: u32 = ${LEGACY_WORD.STALE}u;
const W_SHOCK: u32 = ${shockBase(g)}u;
const W_HELD: u32 = ${heldBase(g)}u;
const W_SET_OFF: u32 = ${setOffBase(g)}u;
const W_PDECO: u32 = ${auxLayout(g.slots, PARTICLE_CAP).particleDeco}u;
const W_CAP: u32 = ${PARTICLE_CAP}u;
const W_EVENTS: u32 = ${w.events}u;
const W_AIR: u32 = ${w.air}u;
const W_LEGACY: u32 = ${w.legacy}u;
const W_SHOCKS: u32 = ${w.shocks}u;
const W_IO: u32 = ${w.io}u;
const W_POOL_SET_OFF: u32 = ${w.pool.setOff}u;
const W_POOL_DECO: u32 = ${w.pool.deco}u;
// the slab: its bricks, and brick i's cell in the window (x fastest, as the native window's slabs: shaders/v2/window.js)
fn wSlabBricks() -> u32 { return P.boxSize.x * P.boxSize.y * P.boxSize.z; }
fn wSlabCell(i: u32) -> vec3i {
  let b = i32(i / 64u); let l = i % 64u; let n = vec3i(P.boxSize);
  let bc = vec3i(b % n.x, (b / n.x) % n.y, b / (n.x * n.y));
  return P.boxStart + bc * 4 + vec3i(i32(l % 4u), i32((l / 4u) % 4u), i32(l / 16u));
}
// a pool record's world cell, and whether it lies in the shared box [blastLo, blastHi)
fn wInside(at: u32) -> bool {
  let p = vec3i(floor(vec3f(bitcast<f32>(particles[at]), bitcast<f32>(particles[at + 1u]), bitcast<f32>(particles[at + 2u]))));
  return all(p >= P.blastLo) && all(p < P.blastHi);
}
fn wInsideSnapshot(at: u32) -> bool {
  let p = vec3i(floor(vec3f(bitcast<f32>(work[at]), bitcast<f32>(work[at + 1u]), bitcast<f32>(work[at + 2u]))));
  return all(p >= P.blastLo) && all(p < P.blastHi);
}
`;
}

export function windowWGSL(g, _nativeHead, stage) {
  if (stage !== 'move') throw new Error(`window stage ${stage}?`);
  return `${head(g)}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let t = foldThread(wg, nwg, li);
  let preserve = P.blastBounded != 0u;
  if (P.mode == ${WINDOW_MODE.SHIFT}u) {
    // cell t of the moved window takes the cell its world cell was at: t + shift in the source
    if (t >= SLOTS) { return; }
    let q = cellOf(t) + P.shift; let held = inGrid(q);
    if (held) { work[W_EVENTS + t] = events[slotOf(q)]; } else if (!preserve) { work[W_EVENTS + t] = 0u; }
    if (t % 64u != 0u) { return; }
    let b = t / 64u;
    if (held) {
      let source = slotOf(q) / 64u;
      for (var k = 0u; k < 8u; k++) { work[W_AIR + b * 8u + k] = air[source * 8u + k]; }
      // a restored brick's cells changed: its projection is stale; a moved one's moved with it
      if (preserve) { work[W_LEGACY + b] = W_STALE; }
      else { work[W_LEGACY + b] = atomicLoad(&act2[W_LEGACY_AT + source]); work[W_SHOCKS + b] = atomicLoad(&control[W_SHOCK + source]); }
    } else if (!preserve) {
      // a brick the move uncovers: its archived air (or quiet), uploaded in the slab's order
      let r = (cellOf(t) - P.boxStart) / 4; let n = vec3i(P.boxSize);
      let e = u32(r.x + n.x * (r.y + n.y * r.z));
      for (var k = 0u; k < 8u; k++) { work[W_AIR + b * 8u + k] = work[W_IO + e * 8u + k]; }
      work[W_LEGACY + b] = W_STALE; work[W_SHOCKS + b] = 0u;
    }
    return;
  }
  if (P.mode == ${WINDOW_MODE.GATHER}u) {
    // the slab that leaves, before the move: its requests a cell, its air a brick
    let n = wSlabBricks(); if (t >= n * 64u) { return; }
    let s = slotOf(wSlabCell(t));
    work[W_IO + 8u * n + t] = events[s];
    if (t % 64u == 0u) { for (var k = 0u; k < 8u; k++) { work[W_IO + 72u * n + (t / 64u) * 8u + k] = air[(s / 64u) * 8u + k]; } }
    return;
  }
  if (P.mode == ${WINDOW_MODE.EVENTS}u) {
    // the outside obligations the move brings in: [slot, bits] pairs (distinct slots)
    if (t >= P.substep) { return; }
    let at = W_IO + 80u * wSlabBricks() + 2u * t;
    events[work[at]] = events[work[at]] | work[at + 1u];
    return;
  }
  if (P.mode == ${WINDOW_MODE.PARTICLES}u) {
    // An undo across a move: the flying matter over the cells it restores is the snapshot's
    // (V1's moving cells are cells, restored with them), everywhere else the current pool's.
    if (t >= W_CAP) { return; }
    let at = t * 12u; let snap = W_IO + at;
    let live = particles[at + 3u] != 0u;
    if (!(live && !wInside(at))) {
      if (work[snap + 3u] != 0u && wInsideSnapshot(snap)) {
        for (var k = 0u; k < 12u; k++) { particles[at + k] = work[snap + k]; }
        atomicStore(&control[W_HELD + t], 0u);
        atomicStore(&control[W_SET_OFF + t], work[W_POOL_SET_OFF + t]);
        aux[W_PDECO + t] = work[W_POOL_DECO + t];
      } else if (live) {
        for (var k = 0u; k < 12u; k++) { particles[at + k] = 0u; }
        atomicStore(&control[W_HELD + t], 0u); atomicStore(&control[W_SET_OFF + t], 0u); aux[W_PDECO + t] = 0u;
      }
    }
    // pool sweeps skip an empty pool: the live count matches the records (restoreDynamicState's recount)
    if (particles[at + 3u] != 0u) { atomicAdd(&control[0], 1u); }
  }
}
`;
}

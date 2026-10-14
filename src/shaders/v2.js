import { compactDecodeWGSL } from './compact.js';
import { prelude, gridDims, LAYOUT, stateLayout, SEED_MAX, STAGE } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { ELEMENTS, K } from '../elements.js';
import { CELL_M } from '../scale.js';

// Physics v2, the fast version (docs/v2.md 2, 4.1, 5.1-5.6; the rules are
// tools/v2/lean-sim.mjs's, the CPU prototype that validated them, ported to
// WGSL here). Behind ?physics=v2 (src/v2/physics.js drives it); nothing
// imports this module with the flag off.
//
// One fixed 60 Hz tick at 2 g. One copy of the state, 16 bytes a cell,
// updated in place, in the same slot order as today's state (brick-major,
// shaders/common.js slotOf), so the bridge to today's renderer is slot for
// slot. Presentation decodes compact cells directly; legacy edits/readbacks export lazily.
// Every v2 kernel reaches a cell through loadCell/storeCell (or the
// cells[slot] twin where a workgroup walks a brick's own run of 64 slots):
//
//   word0  id u8 · T u16 (¼ K steps from -273.25 °C, so whole °C are exact) · age u8
//          (age: a falling powder's ticks of fall; a gas's ticks since it moved; a liquid, while the
//          flux runs: which face carries its remainder, and how much, when its outflow is limited)
//   word1  liquid: fill u24 (1.0 = 2¹⁶, above it compressed) · ctype u8
//          air:    the claim, while the flux runs: the liquid id (u8) and T (u16) it would take
//          others: life f16 · ctype u8 · spare u8
//   word2  liquid and air: the flux on the +x and +y faces (2 × f16, fill units a substep)
//          powder: the sub-cell fall fraction (f32)
//   word3  liquid and air: the flux on the +z face (f16) · liquid: its outflow limit K (u16, of 65,535)
//          others: spare u16 · seed u16 (the colour variation today's renderer reads)
//
// The tick (5.4, minus the passes this version leaves out):
//   import    cells today's writers changed (the brush, presets, undo) into v2's state
//   activity  busy bricks (a rule was *possible* in them) → AWAKE bricks: busy in their 3³
//             neighbourhood within the last QUIET_TICKS ticks; the lists and indirect args
//   column    R1: vertical runs of powder fall together at g, capped at their run speed
//   support   the solid-or-powder bit of every awake cell, for the block pass's look below
//   block     R2 topple (2×2×2 blocks at one of 8 offsets, slope by element), R3 sink and
//             float (density swaps), R4 gas: rise, sink, diffuse while young, fade
//   flux ×3   R13: per-face flux from head differences, the outflow limit, the integer gather
//   invalidate  awake-brick presentation marks and persistent compatibility-dirty bits
//   bridge    only at legacy editing/readback boundaries, never a normal tick
// Rest: a settled box has no awake brick, and the driver then dispatches nothing at all.

// ---------------------------------------------------------------- clock and units
export const TICK_HZ = 60;                         // docs/v2.md 5.1: Minecraft's fixed game tick
// 2 g: TF2's sv_gravity 800 units/s² at 1 unit = 1 inch is ≈ 20 m/s² (docs/v2.md 5.1)
export const G_MS2 = 19.6;
export const G_TICK = G_MS2 / CELL_M / TICK_HZ ** 2;   // cells/tick²
export const G_CELLS = G_MS2 / CELL_M;                 // cells/s²
// liquid (lean-sim's numbers: the prototype's U-tube, pool, puddle and pipe pass on them)
export const FULL = 1 << 16;                       // a full cell's fill
export const SUB = 3;                              // flux substeps a tick (180 Hz)
const DT_SUB = 1 / (TICK_HZ * SUB);
const ACC = G_CELLS * DT_SUB * DT_SUB * FULL;      // flux gained a substep per cell of head
// weakly compressible: stable iff COMP ≥ 3·g·dt² (the highest 3-D mode); 33 % margin (lean-sim)
const COMP = 4 * G_CELLS * DT_SUB * DT_SUB;
const QMIN = 0.5;                                  // a face flux under this snaps to 0
export const FILM = FULL >> 3;                     // no sideways spill onto dry ground under ⅛ full (4.1)
const DEADQ = 2;                                   // dead band, in fill quanta of the stiffer side
// a face's flux at most (under f16's 65,504): its integer share times the 16-bit K stays under 2³², and a
// cell's six faces under 2¹⁸ (118 cells/s through a face, 35 m/s)
const Q_MAX = 43000;
// rest: a brick sleeps once neither it nor any of its 26 neighbours was busy for one offset cycle (5.6)
export const QUIET_TICKS = 8;
// gases diffuse by random swaps only this long after they last moved (R4: diffusionAge, so a still pool rests)
const DIFFUSE_AGE = 120;
// ¼ K steps from -273.25 °C: 20 °C is 1173 exactly
const T_OFFSET = 273.25;

// ---------------------------------------------------------------- element classes
export const V2 = { AIR: 0, SOLID: 1, POWDER: 2, LIQUID: 3, GAS: 4 };
const KIND_CLASS = { [K.EMPTY]: V2.AIR, [K.SOLID]: V2.SOLID, [K.POWDER]: V2.POWDER, [K.LIQUID]: V2.LIQUID, [K.GAS]: V2.GAS };

// R2's repose classes: drop 1 = 45° (free-flowing), 2 = 63° (cohesive), 3 = 72° (clay, snow). The
// measured angle of repose, quantised to the nearest class (Wikipedia, "Angle of repose", its table of
// materials: dry sand 34°, crushed gravel 45°, ashes 40°, wheat flour 45° poured but cohesive and standing
// far steeper once settled, wet clay and packed snow holding near-vertical faces). Noita's sand piles at
// 45° from the same one-cell-down, one-across rule, our drop 1. Elements not listed are drop 1.
const REPOSE = {
  SAND: 34, STONE: 40, GUNPOWDER: 35, SHARDS: 40, SCRAP: 40, CRYSTAL_DUST: 38, BROKENCOAL: 38, URANIUM: 35,
  PLUTONIUM: 35, RUBBLE: 42, NUGGETS: 35, SALT: 32, LITHIUM: 40, ANTIMATTER: 35, THERMITE: 35, SINGULARITY: 30,
  ASH: 55, SAWDUST: 55, DUST: 58, MEAT: 60, COOKED_MEAT: 60,
  SNOW: 72, CLAY: 72,
};
const dropOf = (deg) => (deg <= 50 ? 1 : deg <= 67 ? 2 : 3);

// Terminal run speed, m/s (5.1: "dust and ash drift, grains and debris fall fast"): a bulk run of grains
// 12 m/s (lean-sim's VT_SAND); flakes drift down at 3 m/s (a snowflake's ~1 m/s, read from the god view's
// 30 m away at 2 g: Minecraft's snow and Noita's ash fall slow enough to watch).
const RUN_MS = { ASH: 3, SNOW: 3, SAWDUST: 4 };
const RUN_DEFAULT_MS = 12;

// Liquids: yield (5.4: "rest and yield are one knob") as a dead band in cells of head, so mud, slime and
// lava hold a slope; viscosity as the flux damping, from today's rows' drag (water 0.01: lean-sim's DAMP).
// Mud is a Bingham plastic of tens of Pa (Coussot, Mudflow Rheology and Dynamics, 1997: today's MUD row),
// a game multiplier on which holds a mound you can see from the god view.
const YIELD = { MUD: 0.4, LAVA: 0.3, SLIME: 0.25 };

// Gases that fade (R4, R8): life spent in this many seconds. FIRE lives ~0.5-1 s (R8; TPT's FIRE 120-169
// frames at 60 fps is 2-3 s, faster here so a flame doesn't outlast its fuel, which this version doesn't
// burn); smoke thins away; steam stands in for condensing (no heat yet). The rest persist and come to rest.
const FADE_S = { FIRE: 0.75, PLASMA: 0.5, SMOKE: 6, STEAM: 10, CAUSTIC_GAS: 10 };

/** The v2 row of every element: { cls, drop, vt (cells/tick), dens, yieldHead, damp, fade (life a tick) }. */
export function v2Rows() {
  return ELEMENTS.map((e) => {
    const cls = KIND_CLASS[e.kind] ?? V2.SOLID;
    return {
      key: e.key, cls,
      drop: cls === V2.POWDER ? dropOf(REPOSE[e.key] ?? 34) : 0,
      vt: cls === V2.POWDER ? (RUN_MS[e.key] ?? RUN_DEFAULT_MS) / CELL_M / TICK_HZ : 0,
      dens: e.dens,
      yieldHead: cls === V2.LIQUID ? YIELD[e.key] ?? 0 : 0,
      damp: cls === V2.LIQUID ? Math.min(Math.max(e.drag ?? 0.01, 0.005), 0.3) : 0,
      fade: cls === V2.GAS && FADE_S[e.key] ? 1 / (FADE_S[e.key] * TICK_HZ) : 0,
    };
  });
}

/** The rows as the EV buffer holds them: two vec4f per element. */
export function v2Table() {
  const rows = v2Rows(), out = new Float32Array(rows.length * 8);
  rows.forEach((r, i) => out.set([r.cls, r.drop, r.vt, r.dens, r.yieldHead, r.damp, r.fade, 0], i * 8));
  return out;
}

/** cells fallen from rest in `ticks` ticks by an element's column-fall law (the column pass's, in f64). */
export function fallCells(id, ticks) {
  const vt = v2Rows()[id]?.vt ?? 0;
  let f = 0;
  for (let n = 1; n <= ticks; n++) f += Math.min(n * G_TICK, vt);
  return f;
}

// ---------------------------------------------------------------- buffers
// v2's activity words (u32), one run per brick each, then the brick columns and the counts.
export function v2ActLayout(g) {
  const { nbricks: nb, bx, bz } = gridDims(g);
  return { busy0: 0, busy1: nb, quiet: 2 * nb, awake: 3 * nb, list: 4 * nb, occ: 5 * nb, cols: 7 * nb, legacy: 7 * nb + bx * bz + 8, count: 7 * nb + bx * bz, words: 8 * nb + bx * bz + 8 };
}
// count words: appends (awake, cols), busy bricks last tick, the lengths this tick's passes use
const CNT = { AWAKE: 0, COLS: 1, BUSY: 2, USE_AWAKE: 3, USE_COLS: 4 };
// the indirect args and the stats the driver reads back (u32 words)
export const ARGS2 = { COLS: 0, BRICKS: 3, BLOCKS: 6, STATS: 12, words: 32 };
// stats: [tick, awake bricks, busy bricks the tick before, quiet ticks in a row, last busy tick, columns]
export const STATS = { TICK: 0, AWAKE: 1, BUSY: 2, QUIET: 3, LAST_BUSY: 4, COLS: 5, words: 8 };

export const V2Params = uniformStruct('V2Params', { tick: 'u32', busyIn: 'u32', busyOut: 'u32', full: 'u32', offset: 'vec3i' });

const buf = (binding, type) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type } });
// group 2 of every v2 kernel: the cells, the activity words, the element rows (and for args, the args)
export const V2_LAYOUT = [buf(0, 'storage'), buf(1, 'storage'), buf(2, 'read-only-storage')];
export const V2_ARGS_LAYOUT = [...V2_LAYOUT, buf(3, 'storage')];
// group 1 of the import and the bridge: today's state, its flags and marks (no activity arrays)
export const V2_STATE_OPTS = { state: 'read_write', flags: true, marks: true };
export const V2_STATE_LAYOUT = stateLayout(V2_STATE_OPTS);

// ---------------------------------------------------------------- WGSL
const f = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));

function v2Head(g, opts = { state: false }) {
  const a = v2ActLayout(g);
  return /* wgsl */ `
${prelude(g, opts)}
${V2Params.wgsl}
@group(3) @binding(1) var<uniform> P: V2Params;
@group(2) @binding(0) var<storage, read_write> cells: array<vec4u>;
@group(2) @binding(1) var<storage, read_write> act2: array<atomic<u32>>;
@group(2) @binding(2) var<storage, read> EV: array<vec4f>;

const V2_BUSY0: u32 = ${a.busy0}u;
const V2_QUIET: u32 = ${a.quiet}u;
const V2_AWAKE: u32 = ${a.awake}u;
const V2_LIST: u32 = ${a.list}u;
const V2_OCC: u32 = ${a.occ}u;
const V2_COLS: u32 = ${a.cols}u;
const V2_COUNT: u32 = ${a.count}u;
const V2_LEGACY: u32 = ${a.legacy}u;
const CNT_AWAKE: u32 = ${CNT.AWAKE}u;
const CNT_COLS: u32 = ${CNT.COLS}u;
const CNT_BUSY: u32 = ${CNT.BUSY}u;
const CNT_USE_AWAKE: u32 = ${CNT.USE_AWAKE}u;
const CNT_USE_COLS: u32 = ${CNT.USE_COLS}u;
const QUIET_TICKS: u32 = ${QUIET_TICKS}u;
const DIFFUSE_AGE: u32 = ${DIFFUSE_AGE}u;
const G_TICK: f32 = ${G_TICK};
const FULLU: u32 = ${FULL}u;
const FULLF: f32 = ${f(FULL)};
const ACC: f32 = ${ACC};
const COMP: f32 = ${COMP};
const QMIN: f32 = ${f(QMIN)};
const FILM: u32 = ${FILM}u;
const DEADQ: f32 = ${f(DEADQ)};
const Q_MAX: f32 = ${f(Q_MAX)};
const T_OFFSET: f32 = ${T_OFFSET};
const C_AIR: u32 = ${V2.AIR}u;
const C_SOLID: u32 = ${V2.SOLID}u;
const C_POWDER: u32 = ${V2.POWDER}u;
const C_LIQUID: u32 = ${V2.LIQUID}u;
const C_GAS: u32 = ${V2.GAS}u;
// outside the grid: the box's walls (WALL's id)
const WALL_CELL: vec4u = vec4u(${ELEMENTS.find((e) => e.key === 'WALL').id}u, 0u, 0u, 0u);

// ---- the cell (the layout is this module's header comment) ----
fn loadCell(p: vec3i) -> vec4u { return cells[slotOf(p)]; }
fn storeCell(p: vec3i, c: vec4u) { cells[slotOf(p)] = c; }
fn cellAt(p: vec3i) -> vec4u { if (!inGrid(p)) { return WALL_CELL; } return loadCell(p); }
fn cid(c: vec4u) -> u32 { return c.x & 255u; }
fn cTq(c: vec4u) -> u32 { return (c.x >> 8u) & 0xffffu; }
fn cAge(c: vec4u) -> u32 { return c.x >> 24u; }
fn withAge(c: vec4u, age: u32) -> vec4u { var o = c; o.x = (c.x & 0x00ffffffu) | (min(age, 255u) << 24u); return o; }
fn cFill(c: vec4u) -> u32 { return c.y & 0xffffffu; }
fn qOf(c: vec4u) -> vec3f { return vec3f(unpack2x16float(c.z), unpack2x16float(c.w & 0xffffu).x); }
// a moved air or liquid cell's face fluxes belong to where it was
fn zeroQ(c: vec4u) -> vec4u {
  let k = clsOf(c);
  if (k != C_AIR && k != C_LIQUID) { return c; }
  return vec4u(c.x, c.y, 0u, c.w & 0xffff0000u);
}
// a powder's fall state: its age and sub-cell fraction
fn setFall(c: vec4u, age: u32, frac: f32) -> vec4u { var o = withAge(c, age); o.z = bitcast<u32>(frac); return o; }
fn lifeOf(c: vec4u) -> f32 { return unpack2x16float(c.y).x; }
fn withLife(c: vec4u, life: f32) -> vec4u { var o = c; o.y = (c.y & 0xffff0000u) | (pack2x16float(vec2f(life, 0.0)) & 0xffffu); return o; }

// ---- the element rows (EV: shaders/v2.js v2Table) ----
fn cls(id: u32) -> u32 { return u32(EV[2u * id].x); }
fn clsOf(c: vec4u) -> u32 { return cls(cid(c)); }
fn dropOfE(id: u32) -> u32 { return u32(EV[2u * id].y); }
fn vtOf(id: u32) -> f32 { return EV[2u * id].z; }
fn densOfE(id: u32) -> f32 { return EV[2u * id].w; }
fn yieldOf(id: u32) -> f32 { return EV[2u * id + 1u].x; }
fn dampOf(id: u32) -> f32 { return EV[2u * id + 1u].y; }
fn fadeOf(id: u32) -> f32 { return EV[2u * id + 1u].z; }
fn isLiq(c: vec4u) -> bool { return clsOf(c) == C_LIQUID; }
fn isOpenC(c: vec4u) -> bool { let k = clsOf(c); return k == C_AIR || k == C_LIQUID; }
fn fluidC(c: vec4u) -> bool { let k = clsOf(c); return k == C_AIR || k == C_GAS || k == C_LIQUID; }

// ---- activity ----
fn brickOfCell(p: vec3i) -> u32 { return brickId(p >> vec3u(2u)); }
fn markBusy(p: vec3i) { atomicStore(&act2[P.busyOut + brickOfCell(p)], 1u); }
fn awakeCell(p: vec3i) -> bool { return atomicLoad(&act2[V2_AWAKE + brickOfCell(p)]) != 0u; }
fn useAwake() -> u32 { return atomicLoad(&act2[V2_COUNT + CNT_USE_AWAKE]); }
fn axisV(a: i32) -> vec3i { var d = vec3i(0); d[a] = 1; return d; }
fn face6(i: i32) -> vec3i { var d = vec3i(0); d[i >> 1u] = 1 - 2 * (i & 1); return d; }
`;
}

// The bridge's view of a cell, as today's state A holds it: (id, °C, life, ctype + seed). A liquid shows
// in today's whole-cell renderer where its fill beats a fixed per-cell threshold (so a half-full layer
// shows half its cells, and a thin film a speckle: volume kept on average); air and liquids get a seed
// from their position (theirs isn't kept).
const bridgeWGSL = /* wgsl */ `
${compactDecodeWGSL}
// a cell of today's state A as v2 holds it: a liquid full, everything still
fn importA(a: vec4f) -> vec4u {
  let id = u32(clamp(eid(a), 0, NE - 1));
  let k = cls(id);
  let tq = u32(clamp(round((a.y + T_OFFSET) * 4.0), 0.0, 65535.0));
  let ct = u32(clamp(floor(a.w), 0.0, 255.0));
  let seed = u32(clamp(fract(a.w) / SEED_MAX * 65536.0, 0.0, 65535.0));
  var c = vec4u(id | (tq << 8u), 0u, 0u, 0u);
  if (k == C_LIQUID) {
    c.y = FULLU | (ct << 24u);
  } else if (k != C_AIR) {
    var life = a.z;
    if (k == C_GAS && fadeOf(id) > 0.0 && life <= 0.0) { life = 1.0; }
    c.y = (pack2x16float(vec2f(life, 0.0)) & 0xffffu) | (ct << 16u);
    c.w = seed << 16u;
  }
  return c;
}
`;

const MAIN = '@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32)';

// ---- import: the bricks today's writers marked, cell by cell where today's state A isn't what the
// bridge last wrote there; or after a whole write (a load, an undo, the flag turned on: P.full), every
// cell, since A is then the truth: a part-filled liquid cell the bridge shows as air would otherwise
// match an air cell written there and outlive the write. The bricks where it changed something other
// than air's temperature or seed are busy for the activity pass
export const v2ImportWGSL = (g) => /* wgsl */ `
${v2Head(g, V2_STATE_OPTS)}
${bridgeWGSL}
var<workgroup> wgMarked: u32;
var<workgroup> wgChanged: atomic<u32>;
${MAIN} {
  let b = foldId(wg, nwg);
  if (b >= NBRICKS) { return; }
  if (li == 0u) {
    let w = atomicLoad(&marks[MARK_ACT + (b >> 5u)]);
    wgMarked = select(0u, 1u, P.full != 0u || (w & (1u << (b & 31u))) != 0u);
  }
  if (workgroupUniformLoad(&wgMarked) == 0u) { return; }
  let s = b * 64u + li;
  let p = cellOf(s);
  let a = fetchAs(s);
  let c = cells[s];
  if (P.full != 0u || any(a != compactA(p, c))) {
    let n = importA(a);
    if (any(n != c)) {
      cells[s] = n;
      // (air that stays air, at another temperature or seed, makes no rule possible: a load of an
      // empty box wakes nothing)
      if (clsOf(n) != C_AIR || clsOf(c) != C_AIR) { atomicOr(&wgChanged, 1u); }
    }
  }
  workgroupBarrier();
  if (li == 0u) {
    atomicStore(&act2[V2_LEGACY + b], 1u);
    atomicAnd(&marks[MARK_ACT + (b >> 5u)], ~(1u << (b & 31u)));
    if (atomicLoad(&wgChanged) != 0u) { atomicStore(&act2[P.busyIn + b], 1u); }
  }
}
`;

// ---- activity: a thread a brick. Busy in its 3³ neighbourhood last tick → its quiet run starts over;
// awake while the run is under QUIET_TICKS (one offset cycle); awake bricks into the list
export const v2ActivityWGSL = (g) => /* wgsl */ `
${v2Head(g)}
${MAIN} {
  let b = foldThread(wg, nwg, li);
  if (b >= NBRICKS) { return; }
  let bc = brickCoord(b);
  var near = false;
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let n = bc + vec3i(dx, dy, dz);
        if (all(n >= vec3i(0)) && all(n < vec3i(BX, BY, BZ)) && atomicLoad(&act2[P.busyIn + brickId(n)]) != 0u) { near = true; }
      }
    }
  }
  if (atomicLoad(&act2[P.busyIn + b]) != 0u) { atomicAdd(&act2[V2_COUNT + CNT_BUSY], 1u); }
  var q = atomicLoad(&act2[V2_QUIET + b]);
  if (near) { q = 0u; } else { q = min(q + 1u, 255u); }
  atomicStore(&act2[V2_QUIET + b], q);
  let awake = q < QUIET_TICKS;
  atomicStore(&act2[V2_AWAKE + b], select(0u, 1u, awake));
  if (awake) { atomicStore(&act2[V2_LIST + atomicAdd(&act2[V2_COUNT + CNT_AWAKE], 1u)], b); }
  atomicStore(&act2[P.busyOut + b], 0u);
}
`;

// ---- columns: a thread a brick column; one with an awake brick goes into the column list
export const v2ColsWGSL = (g) => /* wgsl */ `
${v2Head(g)}
${MAIN} {
  let col = foldThread(wg, nwg, li);
  if (col >= u32(BX * BZ)) { return; }
  let bx = i32(col % u32(BX));
  let bz = i32(col / u32(BX));
  var any_ = false;
  for (var by = 0; by < BY; by++) { if (atomicLoad(&act2[V2_AWAKE + brickId(vec3i(bx, by, bz))]) != 0u) { any_ = true; } }
  if (any_) { atomicStore(&act2[V2_COLS + atomicAdd(&act2[V2_COUNT + CNT_COLS], 1u)], col); }
}
`;

// ---- args: one thread. The passes' indirect args, the lengths they use, the stats; appends start over
export const v2ArgsWGSL = (g) => /* wgsl */ `
${v2Head(g)}
@group(2) @binding(3) var<storage, read_write> args: array<u32>;
const MAX_WG: u32 = 65535u;
fn writeFold(at: u32, n: u32) {
  let y = max(1u, (n + MAX_WG - 1u) / MAX_WG);
  args[at] = (n + y - 1u) / y;
  args[at + 1u] = y;
  args[at + 2u] = 1u;
}
@compute @workgroup_size(1)
fn main() {
  let n = atomicLoad(&act2[V2_COUNT + CNT_AWAKE]);
  let nc = atomicLoad(&act2[V2_COUNT + CNT_COLS]);
  let nb = atomicLoad(&act2[V2_COUNT + CNT_BUSY]);
  atomicStore(&act2[V2_COUNT + CNT_USE_AWAKE], n);
  atomicStore(&act2[V2_COUNT + CNT_USE_COLS], nc);
  atomicStore(&act2[V2_COUNT + CNT_AWAKE], 0u);
  atomicStore(&act2[V2_COUNT + CNT_COLS], 0u);
  atomicStore(&act2[V2_COUNT + CNT_BUSY], 0u);
  writeFold(${ARGS2.COLS}u, (nc * 16u + 63u) / 64u);
  writeFold(${ARGS2.BRICKS}u, n);
  writeFold(${ARGS2.BLOCKS}u, (n + 7u) / 8u);
  let s = ${ARGS2.STATS}u;
  args[s + ${STATS.TICK}u] = P.tick;
  args[s + ${STATS.AWAKE}u] = n;
  args[s + ${STATS.BUSY}u] = nb;
  args[s + ${STATS.COLS}u] = nc;
  if (nb > 0u) {
    args[s + ${STATS.QUIET}u] = 0u;
    args[s + ${STATS.LAST_BUSY}u] = P.tick - 1u;
  } else {
    args[s + ${STATS.QUIET}u] = args[s + ${STATS.QUIET}u] + 1u;
  }
}
`;

// ---- R1 column fall: a thread a column of an awake brick column, bottom up (lean-sim columnFall).
// Everything in [fl, y) is air or gas. A powder with nothing under it falls ⌊s(age)⌋ − ⌊s(age−1)⌋ cells
// a tick (s: the fall from rest at g, capped at its run speed), swapping places with the air or gas it
// falls into; it lands on the run below; overshooting onto a falling run it takes that run's age, so the
// two move as one (5.3). Liquids and solids are floors (powders sink into liquids in the block pass).
export const v2ColumnWGSL = (g) => /* wgsl */ `
${v2Head(g)}
${MAIN} {
  let k = foldThread(wg, nwg, li);
  if (k >= atomicLoad(&act2[V2_COUNT + CNT_USE_COLS]) * 16u) { return; }
  let col = atomicLoad(&act2[V2_COLS + k / 16u]);
  let t = k % 16u;
  let x = i32(col % u32(BX)) * BS + i32(t & 3u);
  let z = i32(col / u32(BX)) * BS + i32(t >> 2u);
  var fl = 0;
  var runFalling = false;
  var runAge = 0u;
  var runFrac = 0.0;
  for (var y = 0; y < NY; y++) {
    let p = vec3i(x, y, z);
    var c = loadCell(p);
    let kc = clsOf(c);
    if (kc == C_AIR || kc == C_GAS) { continue; }
    if (kc != C_POWDER) { fl = y + 1; runFalling = false; continue; }
    if (y == fl) {
      // supported: a landing ends its fall
      if (cAge(c) != 0u || c.z != 0u) { storeCell(p, setFall(c, 0u, 0.0)); markBusy(p); }
      fl = y + 1;
      runFalling = false;
      continue;
    }
    markBusy(p);
    let age = min(cAge(c) + 1u, 255u);
    let v = min(f32(age) * G_TICK, vtOf(cid(c)));
    var a = bitcast<f32>(c.z) + v;
    let d = i32(floor(a));
    a = a - f32(d);
    var to = y - d;
    var nAge = age;
    if (to <= fl) {
      if (to < fl) {
        if (runFalling) { nAge = runAge; a = runFrac; } else { nAge = 0u; a = 0.0; }
      }
      to = fl;
    }
    c = setFall(c, nAge, a);
    if (to != y) {
      let q = vec3i(x, to, z);
      let o = zeroQ(loadCell(q));
      storeCell(q, c);
      storeCell(p, o);
      markBusy(q);
    } else {
      storeCell(p, c);
    }
    fl = to + 1;
    runFalling = nAge != 0u;
    runAge = nAge;
    runFrac = a;
  }
}
`;

// ---- support: a workgroup an awake brick; the solid-or-powder bit of each of its cells (the block
// pass reads the cells under a block from this snapshot, never from a block another thread is moving)
export const v2SupportWGSL = (g) => /* wgsl */ `
${v2Head(g)}
var<workgroup> wgN: u32;
var<workgroup> occW: array<atomic<u32>, 2>;
${MAIN} {
  let e = foldId(wg, nwg);
  if (li == 0u) { wgN = useAwake(); }
  if (e >= workgroupUniformLoad(&wgN)) { return; }
  let b = atomicLoad(&act2[V2_LIST + e]);
  let kc = clsOf(cells[b * 64u + li]);
  if (kc == C_SOLID || kc == C_POWDER) { atomicOr(&occW[li >> 5u], 1u << (li & 31u)); }
  workgroupBarrier();
  if (li < 2u) { atomicStore(&act2[V2_OCC + 2u * b + li], atomicLoad(&occW[li])); }
}
`;

// ---- the block pass: a thread a 2×2×2 block at this tick's offset, 8 blocks an awake brick (the
// blocks whose upper corner lies in it). In order: R2 topple (lean-sim blockTopple: a supported powder
// in the top layer moves into a lower in-block cell of air or fluid if the cell above that is too, with
// its element's drop test read from the support snapshot; diagonals for half the positions, hashed, so
// heaps come out round), R3 sink and float (a denser movable over a lighter fluid swaps down), R4 gas
// (lateral random swaps while young; a fading gas spends its life and leaves air).
export const v2BlockWGSL = (g) => /* wgsl */ `
${v2Head(g)}
// share of positions whose grains may topple diagonally (lean-sim MOORE 0.5: an octagon, not a square or diamond)
const MOORE_U: u32 = 0x80000000u;
// powder sinking through a fluid: this share of (1 - ρ_fluid/ρ_powder) a tick its pair is in one block
const SINK_RATE: f32 = 0.6;
const LIQ_SWAP: f32 = 0.3;   // a denser liquid over a lighter one
const GAS_SWAP: f32 = 0.5;   // gas rising or sinking through air or gas, or bubbling up through a liquid
const DIFFUSE: f32 = 0.25;   // a young gas's lateral swap with air
fn off8(i: u32) -> vec3i { return vec3i(i32(i & 1u), i32(i >> 2u), i32((i >> 1u) & 1u)); }
fn supportAt(p: vec3i) -> bool {
  if (!inGrid(p)) { return true; }
  let s = slotOf(p);
  let l = s & 63u;
  return ((atomicLoad(&act2[V2_OCC + 2u * (s >> 6u) + (l >> 5u)]) >> (l & 31u)) & 1u) != 0u;
}
${MAIN} {
  let e = foldId(wg, nwg) * 8u + li / 8u;
  if (e >= useAwake()) { return; }
  let b = atomicLoad(&act2[V2_LIST + e]);
  let j = li % 8u;
  let u = brickCoord(b) * BS + P.offset + 2 * vec3i(i32(j & 1u), i32((j >> 1u) & 1u), i32(j >> 2u));
  let c0 = u - vec3i(1);
  if (c0.y < 0) { return; }
  var cs: array<vec4u, 8>;
  var orig: array<vec4u, 8>;
  for (var i = 0u; i < 8u; i++) { cs[i] = cellAt(c0 + off8(i)); orig[i] = cs[i]; }
  // R2 topple
  for (var c = 0u; c < 4u; c++) {
    let ti = 4u + c;
    let gr = cs[ti];
    if (clsOf(gr) != C_POWDER) { continue; }
    let kb = clsOf(cs[c]);
    if (kb != C_SOLID && kb != C_POWDER) { continue; }   // falling or sinking belong to other rules
    let pTop = c0 + off8(ti);
    let drop = dropOfE(cid(gr));
    var cand = array<u32, 3>(0u, 0u, 0u);
    var w = array<f32, 3>(0.0, 0.0, 0.0);
    var nc = 0u;
    var wsum = 0.0;
    for (var c2 = 0u; c2 < 4u; c2++) {
      if (c2 == c || !fluidC(cs[c2]) || !fluidC(cs[4u + c2])) { continue; }
      let diag = (c2 ^ c) == 3u;
      if (diag) {
        if (seed3(pTop, 0u, 4242u) >= MOORE_U) { continue; }
        // no squeezing between corners: one of the two top cells beside the diagonal is open
        if (!fluidC(cs[4u + (c2 & 1u) + (c & 2u)]) && !fluidC(cs[4u + (c & 1u) + (c2 & 2u)])) { continue; }
      }
      // cohesion: drop − 1 more empty cells under the target
      let pt = c0 + off8(c2);
      var ok = true;
      for (var dd = 1u; dd < drop; dd++) {
        let yy = pt.y - i32(dd);
        if (yy < 0 || supportAt(vec3i(pt.x, yy, pt.z))) { ok = false; }
      }
      if (!ok) { continue; }
      cand[nc] = c2;
      w[nc] = select(1.0, 0.7, diag);
      wsum += w[nc];
      nc++;
    }
    if (nc == 0u) { continue; }
    markBusy(pTop);
    var rs = seed3(pTop, P.tick, 77u);
    var r = rnd(&rs) * wsum;
    var pick = cand[0];
    for (var m = 0u; m < nc; m++) { r -= w[m]; if (r <= 0.0) { pick = cand[m]; break; } }
    let moved = cs[pick];
    cs[pick] = setFall(gr, 0u, 0.0);
    cs[ti] = zeroQ(moved);
    markBusy(c0 + off8(pick));
  }
  // R3 sink and float, R4 buoyancy: a denser movable over a lighter fluid swaps down
  for (var c = 0u; c < 4u; c++) {
    let lo = cs[c];
    let hi = cs[4u + c];
    let kL = clsOf(lo);
    let kU = clsOf(hi);
    if (kU == C_SOLID || cid(lo) == cid(hi) || !fluidC(lo)) { continue; }
    if ((kU == C_POWDER || kU == C_LIQUID) && kL == C_AIR) { continue; }   // a fall: the column pass, the flux
    let dU = densOfE(cid(hi));
    let dL = densOfE(cid(lo));
    if (dU <= dL) { continue; }
    let pU = c0 + off8(4u + c);
    markBusy(pU);
    var chance = GAS_SWAP;
    if (kU == C_POWDER) { chance = SINK_RATE * (1.0 - dL / dU); } else if (kU == C_LIQUID && kL == C_LIQUID) { chance = LIQ_SWAP; }
    var rs = seed3(pU, P.tick, 78u);
    if (rnd(&rs) < chance) {
      cs[c] = withAge(zeroQ(hi), 0u);
      cs[4u + c] = withAge(zeroQ(lo), 0u);
      markBusy(c0 + off8(c));
    }
  }
  // R4 gas: lateral swaps with air while young (x pairs, then z pairs)
  for (var m = 0u; m < 8u; m++) {
    var i0 = 0u;
    var i1 = 0u;
    if (m < 4u) { i0 = 2u * m; i1 = i0 + 1u; } else { i0 = (m - 4u) + ((m - 4u) & 2u); i1 = i0 + 2u; }
    let a0 = cs[i0];
    let a1 = cs[i1];
    let k0 = clsOf(a0);
    let k1 = clsOf(a1);
    var young = false;
    if (k0 == C_GAS && k1 == C_AIR && cAge(a0) < DIFFUSE_AGE) { young = true; }
    if (k1 == C_GAS && k0 == C_AIR && cAge(a1) < DIFFUSE_AGE) { young = true; }
    if (!young) { continue; }
    let p0 = c0 + off8(i0);
    markBusy(p0);
    var rs = seed3(p0, P.tick, 79u + m);
    if (rnd(&rs) < DIFFUSE) {
      cs[i0] = zeroQ(a1);
      cs[i1] = zeroQ(a0);
      markBusy(c0 + off8(i1));
    }
  }
  // R4 gas ageing and fading
  for (var i = 0u; i < 8u; i++) {
    let gc = cs[i];
    if (clsOf(gc) != C_GAS) { continue; }
    let fade = fadeOf(cid(gc));
    let age = cAge(gc);
    if (fade <= 0.0 && age >= DIFFUSE_AGE) { continue; }
    let p = c0 + off8(i);
    markBusy(p);
    var o = withAge(gc, age + 1u);
    if (fade > 0.0) {
      let life = lifeOf(gc) - fade;
      if (life <= 0.0) { o = vec4u(gc.x & 0x00ffff00u, 0u, 0u, 0u); } else { o = withLife(o, life); }
    }
    cs[i] = o;
  }
  for (var i = 0u; i < 8u; i++) {
    let p = c0 + off8(i);
    if (inGrid(p) && any(cs[i] != orig[i])) { storeCell(p, cs[i]); }
  }
}
`;

// ---- R13 liquid flux (docs/v2.md 4.1; lean-sim flux): three passes a substep, a workgroup an awake brick.
// faceFlux is the rule for the face between i and j = i + axis a, from i's stored flux on it: the drive
// is the head difference (less one for a vertical face: the weight), under a dead band it drives nothing
// and the flow decays; only a wet cell sends; no sideways spill onto dry ground from under a film's
// depth; damped by the liquid's viscosity. Two liquids never share a face; air takes one liquid (the
// highest id around it, its claim) so a cell never holds two.
const fluxWGSL = /* wgsl */ `
fn headOf(c: vec4u) -> f32 {
  if (!isLiq(c)) { return 0.0; }
  let fl = f32(cFill(c));
  if (fl <= FULLF) { return fl / FULLF; }
  return 1.0 + (fl - FULLF) / (COMP * FULLF);
}
fn stiffOf(c: vec4u) -> f32 { if (isLiq(c) && cFill(c) > FULLU) { return 1.0 / COMP; } return 1.0; }
fn wetAt(p: vec3i) -> bool { return inGrid(p) && isLiq(loadCell(p)); }
// the liquid an air cell would take this substep, and its temperature: the highest liquid id among its faces
fn claimOf(p: vec3i) -> vec2u {
  var best = 0u;
  var bt = 0u;
  for (var i = 0; i < 6; i++) {
    let q = p + face6(i);
    if (!inGrid(q)) { continue; }
    let c = loadCell(q);
    if (isLiq(c) && cid(c) > best) { best = cid(c); bt = cTq(c); }
  }
  return vec2u(best, bt);
}
fn faceFlux(pi: vec3i, ci: vec4u, pj: vec3i, cj: vec4u, a: i32, qold: f32) -> f32 {
  let wi = isLiq(ci);
  let wj = isLiq(cj);
  if (!wi && !wj) { return 0.0; }
  var liq = cid(ci);
  if (!wi) { liq = cid(cj); }
  if (wi && wj && cid(ci) != cid(cj)) { return 0.0; }
  if (!wi && claimOf(pi).x != liq) { return 0.0; }
  if (!wj && claimOf(pj).x != liq) { return 0.0; }
  var drive = headOf(ci) - headOf(cj);
  if (a == 1) { drive -= 1.0; }
  let damp = dampOf(liq);
  let band = max(max(DEADQ * max(stiffOf(ci), stiffOf(cj)) / FULLF, 1.5 * damp / ACC), yieldOf(liq));
  if (abs(drive) < band) { drive = 0.0; }
  // a dry side's stale outflow (it dried since) is dropped
  var q = qold;
  if (!wi) { q = min(q, 0.0); }
  if (!wj) { q = max(q, 0.0); }
  var v = q + ACC * drive;
  if (drive == 0.0) { v *= 0.5; }
  if ((v > 0.0 && !wi) || (v < 0.0 && !wj)) { v = 0.0; }
  if (a != 1) {
    if (v > 0.0 && !wj && cFill(ci) < FILM && !wetAt(pj - vec3i(0, 1, 0))) { v = 0.0; }
    if (v < 0.0 && !wi && cFill(cj) < FILM && !wetAt(pi - vec3i(0, 1, 0))) { v = 0.0; }
  }
  v *= 1.0 - damp;
  if (abs(v) < QMIN) { v = 0.0; }
  return clamp(v, -Q_MAX, Q_MAX);
}
`;
const brickCell = /* wgsl */ `
  let e = foldId(wg, nwg);
  if (e >= useAwake()) { return; }
  let s = atomicLoad(&act2[V2_LIST + e]) * 64u + li;
  let p = cellOf(s);`;

// pass 1: each open cell's +x, +y, +z faces; a face into a sleeping brick stays shut this tick and wakes
// it, and a −face whose owner sleeps wakes the owner if it would flow
export const v2FluxWGSL = (g) => /* wgsl */ `
${v2Head(g)}
${fluxWGSL}
${MAIN} {
${brickCell}
  let c = cells[s];
  if (!isOpenC(c)) { return; }
  let q0 = qOf(c);
  var q = vec3f(0.0);
  for (var a = 0; a < 3; a++) {
    let pj = p + axisV(a);
    if (!inGrid(pj)) { continue; }
    let cj = loadCell(pj);
    if (!isOpenC(cj)) { continue; }
    var v = faceFlux(p, c, pj, cj, a, q0[a]);
    if (v != 0.0 && !awakeCell(pj)) { markBusy(p); markBusy(pj); v = 0.0; }
    q[a] = v;
  }
  cells[s].z = pack2x16float(q.xy);
  cells[s].w = (c.w & 0xffff0000u) | (pack2x16float(vec2f(q.z, 0.0)) & 0xffffu);
  for (var a = 0; a < 3; a++) {
    let ph = p - axisV(a);
    if (!inGrid(ph) || awakeCell(ph)) { continue; }
    let ch = loadCell(ph);
    if (isOpenC(ch) && faceFlux(ph, ch, p, c, a, qOf(ch)[a]) != 0.0) { markBusy(ph); markBusy(p); }
  }
}
`;

// pass 2: a liquid's outflow limit (never send more than it holds). Each face out of it carries the
// integer share a·K / 65535 of its integer flux a, K rounded down, so the shares never add up to more than
// its fill; when it is limited, the remainder (< 32 quanta) goes out through its largest outflow face, so
// it drains to exactly 0 (lean-sim's exact f64 K does the same; a 16-bit K alone strands the last quanta).
// The face and the remainder go in its age byte. An air cell gets its claim.
export const v2LimitWGSL = (g) => /* wgsl */ `
${v2Head(g)}
${fluxWGSL}
${MAIN} {
${brickCell}
  let c = cells[s];
  let kc = clsOf(c);
  if (kc == C_LIQUID) {
    let q = qOf(c);
    var a6 = array<u32, 6>(0u, 0u, 0u, 0u, 0u, 0u);   // its integer outflow through each face, in face6 order
    var out = 0u;
    for (var a = 0; a < 3; a++) {
      if (q[a] > 0.0) { a6[2 * a] = u32(trunc(q[a])); }
      let ph = p - axisV(a);
      if (inGrid(ph)) {
        let ch = loadCell(ph);
        if (isOpenC(ch)) { let qh = qOf(ch)[a]; if (qh < 0.0) { a6[2 * a + 1] = u32(trunc(-qh)); } }
      }
      out += a6[2 * a] + a6[2 * a + 1];
    }
    let fl = cFill(c);
    var kq = 65535u;
    var tag = 0u;
    if (out > fl) {
      kq = u32(max(floor(f32(fl) / f32(out) * 65535.0), 1.0)) - 1u;
      var sum = 0u;
      var best = 0u;
      var mx = 0u;
      for (var i = 0u; i < 6u; i++) {
        sum += (a6[i] * kq) / 65535u;
        if (a6[i] > best) { best = a6[i]; mx = i; }
      }
      tag = mx | (min(fl - sum, 31u) << 3u);
    }
    cells[s].w = (c.w & 0xffffu) | (kq << 16u);
    cells[s].x = (c.x & 0x00ffffffu) | (tag << 24u);
  } else if (kc == C_AIR) {
    let cl = claimOf(p);
    cells[s].y = cl.x | (cl.y << 8u);
  }
}
`;

// pass 3: integer transfers, each face's computed alike by its two cells from the source's limit, so mass
// is exact. A cell writes only its own id, temperature and fill here (a drying cell keeps its age byte:
// its receivers read its remainder there)
export const v2GatherWGSL = (g) => /* wgsl */ `
${v2Head(g)}
// what a face carries out of src (|v| its flux; face its index in src's face6 order)
fn sendOf(v: f32, src: vec4u, face: u32) -> i32 {
  let kq = src.w >> 16u;
  var t = (u32(trunc(abs(v))) * kq) / 65535u;
  let tag = cAge(src);
  if (kq < 65535u && (tag & 7u) == face) { t += tag >> 3u; }
  return i32(t);
}
${MAIN} {
${brickCell}
  let c = cells[s];
  if (!isOpenC(c)) { return; }
  let q = qOf(c);
  var dF = 0;
  var poss = false;
  for (var a = 0; a < 3; a++) {
    let v = q[a];
    let fa = u32(2 * a);
    if (v != 0.0) {
      poss = true;
      if (v > 0.0) { dF -= sendOf(v, c, fa); } else { dF += sendOf(v, loadCell(p + axisV(a)), fa + 1u); }
    }
    let ph = p - axisV(a);
    if (!inGrid(ph)) { continue; }
    let ch = loadCell(ph);
    if (!isOpenC(ch)) { continue; }
    let vh = qOf(ch)[a];
    if (vh != 0.0) {
      poss = true;
      if (vh > 0.0) { dF += sendOf(vh, ch, fa); } else { dF -= sendOf(vh, c, fa + 1u); }
    }
  }
  if (poss) { markBusy(p); }
  if (isLiq(c)) {
    if (dF != 0) {
      let fl = i32(cFill(c)) + dF;
      if (fl > 0) {
        cells[s].y = (c.y & 0xff000000u) | u32(fl);
      } else {
        cells[s].x = c.x & 0xffffff00u;   // dry: air, at its temperature (its age byte stays: see above)
        cells[s].y = 0u;
      }
    }
  } else if (dF > 0) {
    cells[s].x = (c.y & 255u) | (((c.y >> 8u) & 0xffffu) << 8u);   // the claim's liquid at its temperature
    cells[s].y = u32(dF);
  } else {
    cells[s].y = 0u;
  }
}
`;

// Mark potentially changed bricks without reading or converting their cells.
// Include busyOut: the column pass can touch distant bricks in an awake column,
// and offset blocks can write neighbours outside the original awake list.
// Compatibility dirtiness is independent of presentation marks and survives sleep.
export const v2InvalidateWGSL = (g) => /* wgsl */ `
${v2Head(g, { state: false, marks: true })}
${MAIN} {
  let b = foldThread(wg, nwg, li);
  if (b >= NBRICKS) { return; }
  if (atomicLoad(&act2[V2_AWAKE + b]) == 0u && atomicLoad(&act2[P.busyOut + b]) == 0u) { return; }
  atomicStore(&act2[V2_LEGACY + b], 1u);
  atomicOr(&marks[MARK_DERIVED + (b >> 5u)], 1u << (b & 31u));
  atomicStore(&marks[MARK_FOAMS + b], 1u);
}
`;
export const V2_INVALIDATE_LAYOUT = stateLayout({ state: false, marks: true });

// Lazy boundary export. Scan brick flags, never the current awake list: a brick
// can have changed and gone to sleep long before a legacy reader/writer arrives.
export const v2BridgeWGSL = (g) => /* wgsl */ `
${v2Head(g, V2_STATE_OPTS)}
${bridgeWGSL}
var<workgroup> wgPending: u32;
${MAIN} {
  let b = foldId(wg, nwg);
  if (b >= NBRICKS) { return; }
  if (li == 0u) { wgPending = atomicLoad(&act2[V2_LEGACY + b]); }
  if (workgroupUniformLoad(&wgPending) == 0u) { return; }
  let s = b * 64u + li;
  let p = cellOf(s);
  writeCell(p, fetchAs(s), fetchBs(s), fetchFs(s), compactA(p, cells[s]), vec4f(0.0));
  workgroupBarrier();
  if (li == 0u) { atomicStore(&act2[V2_LEGACY + b], 0u); }
}
`;

// ---------------------------------------------------------------- the kernels
const perBrick = (g) => fold(Math.ceil(gridDims(g).nbricks / 64));
const own = () => [LAYOUT.TABLES, 'EMPTY', V2_LAYOUT];
const withState = () => [LAYOUT.TABLES, V2_STATE_LAYOUT, V2_LAYOUT];
/** Every v2 kernel: name, WGSL, group layouts (as WGSL_CHECK lists them), a sample dispatch. */
export const V2_KERNELS = [
  { name: 'v2import', code: v2ImportWGSL, layouts: withState, dispatch: (g) => fold(gridDims(g).nbricks) },
  { name: 'v2activity', code: v2ActivityWGSL, layouts: own, dispatch: perBrick },
  { name: 'v2cols', code: v2ColsWGSL, layouts: own, dispatch: (g) => fold(Math.ceil((g.nx / 4) * (g.nz / 4) / 64)) },
  { name: 'v2args', code: v2ArgsWGSL, layouts: () => [LAYOUT.TABLES, 'EMPTY', V2_ARGS_LAYOUT], dispatch: () => [1, 1, 1], workgroupSize: [1, 1, 1] },
  { name: 'v2column', code: v2ColumnWGSL, layouts: own, dispatch: perBrick },
  { name: 'v2support', code: v2SupportWGSL, layouts: own, dispatch: perBrick },
  { name: 'v2block', code: v2BlockWGSL, layouts: own, dispatch: perBrick },
  { name: 'v2flux', code: v2FluxWGSL, layouts: own, dispatch: perBrick },
  { name: 'v2limit', code: v2LimitWGSL, layouts: own, dispatch: perBrick },
  { name: 'v2gather', code: v2GatherWGSL, layouts: own, dispatch: perBrick },
  { name: 'v2invalidate', code: v2InvalidateWGSL, layouts: () => [LAYOUT.TABLES, V2_INVALIDATE_LAYOUT, V2_LAYOUT], dispatch: perBrick },
  { name: 'v2bridge', code: v2BridgeWGSL, layouts: withState, dispatch: perBrick },
];

/** tools/check-wgsl.mjs, tools/check-sampler-budget.mjs (src/gpu/checks.js): built only with ?physics=v2. */
export const WGSL_CHECK = V2_KERNELS.map(({ name, code, layouts, dispatch }) => ({ name, kind: 'compute', code, layouts, dispatch, tool: true }));

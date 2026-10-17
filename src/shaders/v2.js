import { fallTerminal } from '../v2/fall.js';
import { fallWGSL } from './v2/fall.js';
import { FOAM_ROWS } from '../v2/foam.js';
import { nativeStateWGSL, materialStorageWGSL } from './v2/state.js';
import { compactDecodeWGSL } from './compact.js';
import { prelude, gridDims, LAYOUT, stateLayout, SEED_MAX, STAGE, BRICK } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { E, ELEMENTS, K } from '../elements.js';
import { CELL_M } from '../scale.js';
import { MODE_FIELDS } from '../v2/modes.js';
import { modeWGSL } from './v2/modes.js';
import { CONTACT_ROWS, CONTACT_REACTIONS } from '../v2/contact.js';
import { appendContactTable } from '../v2/contactTable.js';
import { contactWGSL as productionContactWGSL } from './v2/contact.js';

// Physics v2, the fast version (docs/v2.md 2, 4.1, 5.1-5.6; the rules are
// tools/v2/lean-sim.mjs's, the CPU prototype that validated them, ported to
// WGSL here). Behind ?physics=v2 (src/v2/physics.js drives it); nothing
// imports this module with the flag off.
//
// Core format 2: 16-byte cells + signed 4-byte energy bank; transient liquid
// snapshots 16 bytes and material requests 4 bytes. See docs/v2/native-contract.md.
// Neither the upper liquid payload nor foam is temporary limiter storage.
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
// a brick's quiet run stops counting here (one byte); a brick at it, with nothing busy near, is unchanged
export const QUIET_CAP = 255;
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
      vt: cls === V2.POWDER ? fallTerminal(e.id) / CELL_M / TICK_HZ : 0,
      dens: e.dens,
      yieldHead: cls === V2.LIQUID ? YIELD[e.key] ?? 0 : 0,
      damp: cls === V2.LIQUID ? Math.min(Math.max(e.drag ?? 0.01, 0.005), 0.3) : 0,
      fade: cls === V2.GAS && FADE_S[e.key] ? 1 / (FADE_S[e.key] * TICK_HZ) : 0,
    };
  });
}

/** EV: unchanged two-vec4f element prefix, then immutable contact metadata. */
export function v2Table() {
  const rows = v2Rows(), out = new Float32Array(rows.length * 8);
  rows.forEach((r, i) => out.set([r.cls, r.drop, r.vt, r.dens, r.yieldHead, r.damp, r.fade, 0], i * 8));
  return appendContactTable(out, CONTACT_ROWS, CONTACT_REACTIONS);
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
// state: a brick's cells changed since the air reach pass last cleared it (noteState).
// events: after the saved words (`words`), so saves keep their length: a brick may hold a
// nonzero material request (noteEvents); clear means every request word in it is zero.
// air: unsaved too. Clear means the brick's air ended its last air tick settled and unchanged,
// in both ping-pong copies (the air source clears it); every other writer sets it (noteAir).
// near, plist: the activity scan's words (unsaved): bit 0 a busy brick in the 3³ neighbourhood,
// bit 1 listed; then the list [count, use, bricks]. Zero again after every activity pass.
export function v2ActLayout(g) {
  const { nbricks: nb, bx, bz } = gridDims(g);
  const ledger = 10 * nb + bx * bz + 8;
  return { busy0: 0, busy1: nb, quiet: 2 * nb, awake: 3 * nb, list: 4 * nb, occ: 5 * nb, cols: 7 * nb, legacy: 7 * nb + bx * bz + 8, visible: 8 * nb + bx * bz + 8, count: 7 * nb + bx * bz, state: 9 * nb + bx * bz + 8, energySource: ledger, energySink: ledger + 3, boundaryMass: 7 * nb + bx * bz + 6, words: ledger + 6, events: ledger + 6, air: ledger + 6 + nb, near: ledger + 6 + 2 * nb, plist: ledger + 6 + 3 * nb, allocated: ledger + 8 + 4 * nb };
}
// count words: appends (awake, cols), busy bricks last tick, the lengths this tick's passes use
const CNT = { AWAKE: 0, COLS: 1, BUSY: 2, USE_AWAKE: 3, USE_COLS: 4 };
// the indirect args and the stats the driver reads back (u32 words)
// ACT, the activity pass's (v2actArgs), follows the saved words.
export const ARGS2 = { COLS: 0, BRICKS: 3, BLOCKS: 6, COMPACT: 9, STATS: 12, LIQUID: 20, words: 32, ACT: 32, allocated: 36 };
// The liquid list, in jetMask's tail (transient like the masks; restores clear it): its length as the
// tick's first flux appends and as the later passes use it, a membership bit per brick, the bricks.
// Liquid moves one cell a substep, so it stays inside a listed brick's one-brick halo all tick.
if (SUB >= BRICK) throw new Error('v2 liquid list: a tick of substeps must not cross a whole brick');
export function v2LiquidListLayout(g) {
  const { slots, nbricks } = gridDims(g);
  const bits = slots + 4, list = bits + Math.ceil(nbricks / 32);
  return { count: slots, use: slots + 1, bits, list, words: Math.ceil((list + nbricks) / 4) * 4 };
}
// Scratch's original slots*16 bytes are ALL live (including support atmosphere).
// The production-only tail is a 16-byte counter header, then original u32 IDs.
export function v2BlockCompactLayout(g, limits = {}) {
  const { slots, nbricks } = gridDims(g);
  const capacity = 8 * nbricks, header = slots * 16, list = header + 16;
  const bytes = list + capacity * 4;
  if (![slots, nbricks, capacity, header, bytes].every(Number.isSafeInteger) ||
      slots <= 0 || slots % 64 !== 0 || capacity !== slots / 8 ||
      bytes % 16 !== 0 || bytes / 4 > 0xffffffff ||
      bytes > (limits.maxStorageBufferBindingSize ?? Number.MAX_SAFE_INTEGER) ||
      bytes > (limits.maxBufferSize ?? Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('v2 block compaction scratch exceeds aligned device/u32 bounds');
  }
  return { capacity, header, list, bytes };
}
// stats: [tick, awake bricks, busy bricks the tick before, quiet ticks in a row, last busy tick, columns]
export const STATS = { TICK: 0, AWAKE: 1, BUSY: 2, QUIET: 3, LAST_BUSY: 4, COLS: 5, words: 8 };

// liquidList: flux runs over the liquid list (1), not the awake list it builds that list from (0)
export const V2Params = uniformStruct('V2Params', { tick: 'u32', busyIn: 'u32', busyOut: 'u32', full: 'u32', offset: 'vec3i', preserveLegacyMarks: 'u32', liquidList: 'u32', ...MODE_FIELDS });

const buf = (binding, type) => ({ binding, visibility: STAGE.COMPUTE, buffer: { type } });
// group 2 of every v2 kernel: the cells, the activity words, the element rows (and for args, the args)
export const V2_LAYOUT = [buf(0, 'storage'), buf(1, 'storage'), buf(2, 'read-only-storage')];
export const V2_ARGS_LAYOUT = [...V2_LAYOUT, buf(3, 'storage')];
export const V2_MATERIAL_LAYOUT = [...V2_LAYOUT, buf(4, 'storage')];
export const V2_LIQUID_LAYOUT = [...V2_MATERIAL_LAYOUT, buf(5, 'storage'), buf(6, 'storage'), buf(7, 'storage')];
export const V2_CONTACT_LAYOUT = [...V2_MATERIAL_LAYOUT, buf(5, 'storage'), buf(6, 'storage')];
export const V2_BLOCK_FINALIZE_LAYOUT = [buf(0, 'storage'), buf(1, 'storage')];
// group 1 of the import and the bridge: today's state, its flags and marks (no activity arrays)
export const V2_STATE_OPTS = { state: 'read_write', flags: true, marks: true };
export const V2_STATE_LAYOUT = stateLayout(V2_STATE_OPTS);
export const V2_IMPORT_OPTS = { state: 'read', flags: false, marks: true };
export const V2_IMPORT_LAYOUT = stateLayout(V2_IMPORT_OPTS);

// ---------------------------------------------------------------- WGSL
const f = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));

// The liquid list's words (v2LiquidListLayout), for kernels binding jetMask as atomics.
export function liquidListWGSL(g) {
  const l = v2LiquidListLayout(g);
  return /* wgsl */ `
const LIQ_COUNT: u32 = ${l.count}u;
const LIQ_USE: u32 = ${l.use}u;
const LIQ_BITS: u32 = ${l.bits}u;
const LIQ_LIST: u32 = ${l.list}u;
fn liquidListed(p: vec3i) -> bool { let b = brickOfCell(p); return (atomicLoad(&jetMask[LIQ_BITS + (b >> 5u)]) & (1u << (b & 31u))) != 0u; }`;
}
// Gather and the jets read neighbours' snapshots, which only listed bricks refresh: there an unlisted
// awake brick counts as asleep. Exact: its cells and their awake neighbours stay dry all tick, so every
// face they share carries nothing, as it would awake (see v2FluxWGSL).
const AWAKE_CELL = 'fn awakeCell(p: vec3i) -> bool { return atomicLoad(&act2[V2_AWAKE + brickOfCell(p)]) != 0u; }';
export function listedAwake(code) {
  if (!code.includes(AWAKE_CELL)) throw new Error('v2 liquid list: awakeCell is not the shared definition');
  return code.replace(AWAKE_CELL, 'fn awakeCell(p: vec3i) -> bool { return liquidListed(p); }');
}

export function v2Head(g, opts = { state: false }, family = 'base') {
  const a = v2ActLayout(g);
  return /* wgsl */ `
${prelude(g, opts).replace(/\bMaterial\b/g, 'LegacyMaterial')}
${opts.state === 'read' ? '' : compactDecodeWGSL}
${nativeStateWGSL}
${family !== 'base' ? materialStorageWGSL : ''}
${family === 'contact' || family === 'liquid' ? '@group(2) @binding(5) var<storage, read_write> liquidScratch: array<vec4u>;' : ''}
${family === 'liquid' ? `@group(2) @binding(7) var<storage, read_write> jetMask: array<atomic<u32>>;\n${liquidListWGSL(g)}` : ''}
${family === 'contact' || family === 'liquid' ? '@group(2) @binding(6) var<storage, read_write> events: array<u32>;' : ''}
${V2Params.wgsl}
@group(3) @binding(1) var<uniform> P: V2Params;
@group(2) @binding(0) var<storage, read_write> cells: array<vec4u>;
@group(2) @binding(1) var<storage, read_write> act2: array<atomic<u32>>;
@group(2) @binding(2) var<storage, read> EV: array<vec4u>;

const V2_BUSY0: u32 = ${a.busy0}u;
${modeWGSL}
const V2_QUIET: u32 = ${a.quiet}u;
const V2_AWAKE: u32 = ${a.awake}u;
const V2_LIST: u32 = ${a.list}u;
const V2_OCC: u32 = ${a.occ}u;
const V2_COLS: u32 = ${a.cols}u;
const V2_COUNT: u32 = ${a.count}u;
const V2_LEGACY: u32 = ${a.legacy}u;
const V2_VISIBLE: u32 = ${a.visible}u;
const V2_STATE_DIRTY: u32 = ${a.state}u;
const V2_EVENTS: u32 = ${a.events}u;
const V2_AIR_LIVE: u32 = ${a.air}u;
const V2_NEAR: u32 = ${a.near}u;
const V2_PLIST: u32 = ${a.plist}u;
const QUIET_CAP: u32 = ${QUIET_CAP}u;
const V2_ENERGY_SOURCE: u32 = ${a.energySource}u;
const V2_ENERGY_SINK: u32 = ${a.energySink}u;
const V2_BOUNDARY_MASS: u32 = ${a.boundaryMass}u;
const CNT_AWAKE: u32 = ${CNT.AWAKE}u;
const CNT_COLS: u32 = ${CNT.COLS}u;
const CNT_BUSY: u32 = ${CNT.BUSY}u;
const CNT_USE_AWAKE: u32 = ${CNT.USE_AWAKE}u;
const CNT_USE_COLS: u32 = ${CNT.USE_COLS}u;
const QUIET_TICKS: u32 = ${QUIET_TICKS}u;
const FOAM_GAIN = array<f32, ${FOAM_ROWS.length}>(${FOAM_ROWS.map(r => `${r.gain}.0`).join(',')});
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
fn loadCore(s: u32) -> vec4u { return cells[s]; }
fn storeCore(s: u32, c: vec4u) { cells[s] = c; }
fn loadCell(p: vec3i) -> vec4u { return loadCore(slotOf(p)); }
// Keep redraws separate from activity: fall fractions, gas ages and sub-threshold
// liquid flux can keep a rule busy without changing a pixel or the legacy cache.
fn noteVisible(p: vec3i, before: vec4u, after: vec4u) {
  if (all(compactA(p, before) == compactA(p, after)) && (!isLiq(after) || cAge(before) == cAge(after))) { return; }
  let b = brickOfCell(p);
  atomicStore(&act2[V2_VISIBLE + b], 1u);
  atomicStore(&act2[V2_LEGACY + b], 1u);
}
// Every write that can change a cell's core goes through here (the air source
// caches what it derives from a brick's cells until it or a face neighbour is noted).
fn noteState(s: u32) { atomicStore(&act2[V2_STATE_DIRTY + s / 64u], 1u); }
// Every store of a nonzero material request: whole-grid request scans visit noted bricks only.
fn noteEvents(s: u32, request: u32) { if (request != 0u) { atomicStore(&act2[V2_EVENTS + s / 64u], 1u); } }
// Every write of a brick's air outside the air tick's source and substeps.
fn noteAir(b: u32) { atomicStore(&act2[V2_AIR_LIVE + b], 1u); }
// Explicit chemical/removed-material energy, separate from conservative transfers.
// Three atomic words retain carries across concurrent additions (96-bit totals).
fn noteEnergyCounter(index: u32, amount: vec2u) {
  if (all(amount == vec2u(0u))) { return; }
  let low = atomicAdd(&act2[index], amount.x);
  let carry = select(0u, 1u, low > 0xffffffffu - amount.x);
  let increment = amount.y + carry;
  let high = atomicAdd(&act2[index + 1u], increment);
  if (high > 0xffffffffu - increment) { atomicAdd(&act2[index + 2u], 1u); }
}
fn noteEnergySource(position: vec3i, amount: vec2u) {
  if ((amount.y & 0x80000000u) != 0u) { noteEnergyCounter(V2_ENERGY_SINK, energyNeg(amount)); }
  else { noteEnergyCounter(V2_ENERGY_SOURCE, amount); }
}
fn noteBoundaryMass(amount: u32) {
  let old=atomicAdd(&act2[V2_BOUNDARY_MASS],amount);
  if (old>0xffffffffu-amount) { atomicAdd(&act2[V2_BOUNDARY_MASS+1u],1u); }
}
fn noteEnergySink(position: vec3i, amount: vec2u) {
  if ((amount.y & 0x80000000u) != 0u) { noteEnergyCounter(V2_ENERGY_SOURCE, energyNeg(amount)); }
  else { noteEnergyCounter(V2_ENERGY_SINK, amount); }
}
fn storeCell(p: vec3i, c: vec4u) {
  let s = slotOf(p);
  if (any(loadCore(s) != c)) { noteState(s); }
  noteVisible(p, loadCore(s), c);
  storeCore(s, c);
}
fn cellAt(p: vec3i) -> vec4u { let q=mEdge(p); if (!inGrid(q)) { return WALL_CELL; } return loadCell(q); }
fn cid(c: vec4u) -> u32 { return c.x & 255u; }
fn cRawTq(c: vec4u) -> u32 { return (c.x >> 8u) & 0xffffu; }
fn cTq(c: vec4u) -> u32 { return phaseTq(cid(c), cRawTq(c)); }
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
${fallWGSL}
fn resetMotionAge(c: vec4u) -> vec4u { if (isLiq(c)) { return c; } if (clsOf(c) == C_POWDER) { return setFall(c, 0.0, 0.0); } return withAge(c, 0u); }
// ---- the element rows (EV: shaders/v2.js v2Table) ----
fn e0(id: u32) -> vec4f { return bitcast<vec4f>(EV[2u * id]); }
fn e1(id: u32) -> vec4f { return bitcast<vec4f>(EV[2u * id + 1u]); }
fn cls(id: u32) -> u32 { return u32(e0(id).x); }
fn clsOf(c: vec4u) -> u32 { return cls(cid(c)); }
fn dropOfE(id: u32) -> u32 { return u32(e0(id).y); }
fn vtOf(id: u32) -> f32 { return e0(id).z; }
fn densOfE(id: u32) -> f32 { return e0(id).w; }
fn yieldOf(id: u32) -> f32 { return e1(id).x; }
fn dampOf(id: u32) -> f32 { return e1(id).y; }
fn fadeOf(id: u32) -> f32 { return e1(id).z; }
fn isLiq(c: vec4u) -> bool { return clsOf(c) == C_LIQUID; }
fn isOpenC(c: vec4u) -> bool { let k = clsOf(c); return k == C_AIR || k == C_LIQUID; }
fn fluidC(c: vec4u) -> bool { let k = clsOf(c); return k == C_AIR || k == C_GAS || k == C_LIQUID; }

// ---- activity ----
fn brickOfCell(p: vec3i) -> u32 { return brickId(p >> vec3u(2u)); }
fn markBusy(p: vec3i) { let q=mEdge(p); if (inGrid(q)) { atomicStore(&act2[P.busyOut + brickOfCell(q)], 1u); } }
${AWAKE_CELL}
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
// a cell of today's state A as v2 holds it: a liquid full, everything still
fn importA(a: vec4f) -> vec4u {
  let id = u32(clamp(eid(a), 0, NE - 1));
  let k = cls(id);
  let tq = u32(clamp(round((a.y + T_OFFSET) * 4.0), 0.0, 41093.0));
  let legacyCtype = u32(max(floor(a.w), 0.0));
  let ct = select(legacyCtype & 255u, 0u, conductsNative(id));
  let seed = u32(clamp(fract(a.w) / SEED_MAX * 65536.0, 0.0, 65535.0));
  var c = vec4u(id | (tq << 8u), 0u, 0u, 0u);
  if (k == C_LIQUID) {
    c.y = FULLU | (ct << 24u);
    c = withLife(c, a.z);
  } else if (k != C_AIR) {
    var life = a.z;
    if (k == C_GAS && fadeOf(id) > 0.0 && life <= 0.0) { life = 1.0; }
    c.y = ct << 16u;
    c = withLife(c, life);
    c.w = seed << 16u;
  }
  if (conductsNative(id)) { c = withSpark(c, legacyCtype); }
  return c;
}
// Native editing projection is non-dithered. Merge only changed properties;
// neither pressure/momentum nor a seed-only change owns material quantities.
fn importProperties(p: vec3i, m: Material, a: vec4f) -> Material {
  let before = compactProbeA(p, m.core);
  var out = m;
  if (a.z != before.z && !(isLiq(m.core) && conductsNative(cid(m.core)))) {
    out.core = withLife(out.core, a.z);
  }
  if (floor(a.w) != floor(before.w)) {
    let ct = u32(max(floor(a.w), 0.0));
    if (conductsNative(cid(m.core))) { out.core = withSpark(out.core, ct); }
    else { out.core = withCtype(out.core, ct); }
  }
  if (a.y != before.y) {
    // Add sensible heat to the existing phase/bank, retaining latent residual.
    let dq = i32(round(clamp((a.y + T_OFFSET) * 4.0, 0.0, 41093.0))) - i32(cTq(m.core));
    let heat = energyMul(capacityQ(m.core), u32(abs(dq)));
    let editedEnergy = energyAdd(energyOf(out), select(heat, energyNeg(heat), dq < 0));
    if (energyFits(out, editedEnergy)) { out = withEnergy(out, editedEnergy); }
  }
  return out;
}
`;

const MAIN = '@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32)';

// ---- import: sticky positional ownership survives v1 activity rebuilds and ping-pong copies.
// Only actual v1 writes or eligible explicit replacement intents replace compact cells. Comparing the final
// projection is insufficient: a hidden film looks like air, and a cell may change away and back.
// A whole replacement (load/undo: P.full) owns every cell. Changed non-air wakes its brick.
export const v2ImportWGSL = (g) => /* wgsl */ `
${v2Head(g, V2_IMPORT_OPTS, 'material')}
${bridgeWGSL}
var<workgroup> wgMarked: u32;
var<workgroup> wgChanged: atomic<u32>;
${MAIN} {
  let b = foldId(wg, nwg);
  if (b >= NBRICKS) { return; }
  if (li == 0u) {
    let w = atomicLoad(&marks[MARK_ACT + (b >> 5u)]);
    let owned = atomicLoad(&marks[MARK_OWNED + b * 2u]) | atomicLoad(&marks[MARK_OWNED + b * 2u + 1u]);
    wgMarked = select(0u, 1u, P.full != 0u || owned != 0u || (w & (1u << (b & 31u))) != 0u);
  }
  if (workgroupUniformLoad(&wgMarked) == 0u) { return; }
  let s = b * 64u + li;
  let p = cellOf(s);
  let a = fetchAs(s);
  let c = cells[s];
  let mask = 1u << (s & 31u);
  let owned = atomicAnd(&marks[MARK_OWNED + (s >> 5u)], ~mask) & mask;
  if (P.full != 0u || owned != 0u) {
    let n = importA(a);
    let oldBank = banks[s];
    banks[s] = 0; // explicit ownership resets even when the imported core compares equal
    if (any(n != c) || oldBank != 0) {
      cells[s] = n; noteState(s);
      // (air that stays air, at another temperature or seed, makes no rule possible: a load of an
      // empty box wakes nothing)
      if (clsOf(n) != C_AIR || clsOf(c) != C_AIR || oldBank != 0) { atomicOr(&wgChanged, 1u); }
    }
  } else if (H.capture == 2u) {
    let next = importProperties(p, Material(c, banks[s]), a);
    if (any(next.core != c) || next.bank != banks[s]) {
      cells[s] = next.core; banks[s] = next.bank; noteState(s);
      atomicOr(&wgChanged, 1u);
    }
  }
  workgroupBarrier();
  if (li == 0u) {
    atomicStore(&act2[V2_LEGACY + b], 1u);
    if (P.preserveLegacyMarks == 0u) { atomicAnd(&marks[MARK_ACT + (b >> 5u)], ~(1u << (b & 31u))); }
    if (atomicLoad(&wgChanged) != 0u) { atomicStore(&act2[P.busyIn + b], 1u); }
  }
}
`;

// Retire requests only for explicitly replaced external slots, before import
// consumes ownership bits. Native requests elsewhere survive paused edits.
export const v2ExternalEventsWGSL = (g) => /* wgsl */ `
${v2Head(g, { state: false, marks: true }, 'contact')}
${MAIN} {
  let s = foldThread(wg, nwg, li); if (s >= SLOTS) { return; }
  let owned = atomicLoad(&marks[MARK_OWNED + (s >> 5u)]) & (1u << (s & 31u));
  if (P.full != 0u || owned != 0u) { events[s] = 0u; }
}
`;

// ---- activity scan: a thread a brick. Only a brick near a busy one (its quiet run starts over) or
// still counting its run changes in the activity pass; any other is at QUIET_CAP, asleep, with a
// busy word already clear (busy two ticks ago means near one last tick). Each busy brick marks its
// 3³ neighbourhood near, scattered (mEdge's loop wrap is symmetric), and each such brick is listed
// once (tools/v2/activity-list-check.mjs).
export const v2ActScanWGSL = (g) => /* wgsl */ `
${v2Head(g)}
fn actClaim(b: u32, bits: u32) {
  if ((atomicOr(&act2[V2_NEAR + b], bits) & 2u) == 0u) { atomicStore(&act2[V2_PLIST + 2u + atomicAdd(&act2[V2_PLIST], 1u)], b); }
}
${MAIN} {
  let b = foldThread(wg, nwg, li);
  if (b >= NBRICKS) { return; }
  if (atomicLoad(&act2[P.busyIn + b]) != 0u) {
    let bc = brickCoord(b);
    for (var dz = -1; dz <= 1; dz++) {
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let n = mEdge((bc + vec3i(-dx, -dy, -dz))*BS)/BS;
          if (all(n >= vec3i(0)) && all(n < vec3i(BX, BY, BZ))) { actClaim(brickId(n), 3u); }
        }
      }
    }
  }
  if (atomicLoad(&act2[V2_QUIET + b]) < QUIET_CAP) { actClaim(b, 2u); }
}
`;

// One thread: the scan is done; publish its list and its args, start it over.
export const v2ActArgsWGSL = (g) => /* wgsl */ `
${v2Head(g)}
@group(2) @binding(3) var<storage, read_write> args: array<u32>;
@compute @workgroup_size(1)
fn main() {
  let n = atomicLoad(&act2[V2_PLIST]);
  atomicStore(&act2[V2_PLIST + 1u], n); atomicStore(&act2[V2_PLIST], 0u);
  let groups = (n + 63u) / 64u; let y = max(1u, (groups + 65534u) / 65535u);
  args[${ARGS2.ACT}u] = (groups + y - 1u) / y; args[${ARGS2.ACT + 1}u] = y; args[${ARGS2.ACT + 2}u] = 1u;
}
`;

// ---- activity: a thread a listed brick. Busy in its 3³ neighbourhood last tick → its quiet run starts over;
// awake while the run is under QUIET_TICKS (one offset cycle); awake bricks into the list
export const v2ActivityWGSL = (g) => /* wgsl */ `
${v2Head(g)}
${MAIN} {
  let i = foldThread(wg, nwg, li);
  if (i >= atomicLoad(&act2[V2_PLIST + 1u])) { return; }
  let b = atomicLoad(&act2[V2_PLIST + 2u + i]);
  let near = (atomicExchange(&act2[V2_NEAR + b], 0u) & 1u) != 0u;
  if (atomicLoad(&act2[P.busyIn + b]) != 0u) { atomicAdd(&act2[V2_COUNT + CNT_BUSY], 1u); }
  var q = atomicLoad(&act2[V2_QUIET + b]);
  if (near) { q = 0u; } else { q = min(q + 1u, QUIET_CAP); }
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
// Everything in [fl, y) is air or gas. Integrate stored SI velocity, then its
// sub-cell displacement; gravity changes acceleration, never prior momentum.
// Landing on a falling run inherits its velocity and fraction, so the
// two move as one (5.3). Liquids and solids are floors (powders sink into liquids in the block pass).
export const v2ColumnWGSL = (g) => /* wgsl */ `
${v2Head(g, { state: false }, 'contact')}
${MAIN} {
  if (P.gravMode == 2u || P.edge != 0u) { return; }
  let k = foldThread(wg, nwg, li);
  if (k >= atomicLoad(&act2[V2_COUNT + CNT_USE_COLS]) * 16u) { return; }
  let col = atomicLoad(&act2[V2_COLS + k / 16u]);
  let t = k % 16u;
  let x = i32(col % u32(BX)) * BS + i32(t & 3u);
  let z = i32(col / u32(BX)) * BS + i32(t >> 2u);
  var fl = 0;
  var runFalling = false;
  var runVelocity = 0.0;
  var runFrac = 0.0;
  for (var y = 0; y < NY; y++) {
    let p = vec3i(x, y, z);
    var c = loadCell(p);
    let kc = clsOf(c);
    if (kc == C_AIR || kc == C_GAS) { continue; }
    if (kc != C_POWDER) { fl = y + 1; runFalling = false; continue; }
    if (y == fl) {
      // supported: a landing ends its fall
      if (fallVelocity(c) != 0.0 || fallFraction(c) != 0.0) { storeCell(p, setFall(c, 0.0, 0.0)); markBusy(p); }
      fl = y + 1;
      runFalling = false;
      continue;
    }
    let gravity = select(P.gravity, 0.0, P.gravMode == 1u);
    let v = nextFallVelocity(c, gravity);
    if (v == 0.0) { fl = y + 1; runFalling = false; continue; }
    markBusy(p);
    var a = fallDistance(c, v);
    let d = i32(floor(a));
    a = a - f32(d);
    var to = y - d;
    var velocity = v;
    if (to <= fl) {
      if (to < fl) {
        if (runFalling) { velocity = runVelocity; a = runFrac; } else { velocity = 0.0; a = 0.0; }
      }
      to = fl;
    }
    c = setFall(c, velocity, a);
    if (to != y) {
      let q = vec3i(x, to, z);
      let o = zeroQ(loadCell(q));
      let request = events[slotOf(p)]; events[slotOf(p)] = events[slotOf(q)]; events[slotOf(q)] = request;
      noteEvents(slotOf(p), events[slotOf(p)]); noteEvents(slotOf(q), request);
      let source = loadMaterial(slotOf(p));
      let destination = loadMaterial(slotOf(q));
      storeMaterial(slotOf(q), destination, Material(c, source.bank));
      storeMaterial(slotOf(p), source, Material(o, destination.bank));
      markBusy(q);
    } else {
      storeCell(p, c);
    }
    fl = to + 1;
    runFalling = velocity != 0.0;
    runVelocity = velocity;
    runFrac = a;
  }
}
`;

// Open faces alone are sinks. The retained empty carrier owns its energy;
// only removed material enthalpy/bank and fill enter the existing exact ledger.
export const v2BoundaryWGSL = (g) => /* wgsl */ `
${v2Head(g, { state: false }, 'contact')}
${MAIN} {
  if (P.edge!=1u) { return; }
  let e=foldId(wg,nwg); if (e>=useAwake()) { return; }
  let s=atomicLoad(&act2[V2_LIST+e])*64u+li; let p=cellOf(s);
  let before=loadMaterial(s); let c=before.core; let k=clsOf(c);
  if (k!=C_LIQUID && k!=C_GAS) { return; }
  if ((events[s]&1u)!=0u) { return; }
  var drive=0.0;
  for (var a=0;a<3;a++) { for (var side=-1;side<=1;side+=2) {
    if (inGrid(p+axisV(a)*side)) { continue; }
    let force=f32(side)*mGravity(vec3f(p)+0.5)[a]/19.6;
    if (k==C_LIQUID) { drive+=max(0.0,f32(cFill(c))/FULLF+force); }
    else if (k==C_GAS) { drive+=0.25; }
    else { drive+=max(0.0,force); }
  } }
  if (drive<=0.0) { return; } markBusy(p);
  let carrier=makeMaterial(0u,f32(cTq(c))*0.25-273.25,0u,0u);
  var after=carrier; var amount=FULLU;
  if (k==C_LIQUID) {
    amount=min(cFill(c),max(1u,u32(ACC*drive)));
    let carried=energySub(energyOf(before),energyOf(carrier));
    let heat=energyShare(carried,0u,amount,cFill(c));
    var core=c; let left=cFill(c)-amount;
    if (left==0u) { core=carrier.core; }
    else { core.y=(core.y&0xff000000u)|left;
      let fuel=energyDiv(energyMul(payloadOf(c),left),cFill(c)).x;
      if (!conductsNative(cid(c))) { core.w=(core.w&65535u)|(fuel<<16u); }
    }
    after=withEnergy(Material(core,before.bank),energySub(energyOf(before),heat));
  } else {
    // Only gas reaches this branch; powder outflow belongs to dynamics.
    if (drive<1.0) { var rng=seed3(p,P.tick,971u); if (rnd(&rng)>=drive) { return; } }
  }
  noteBoundaryMass(amount); noteEnergySink(p,energySub(energyOf(before),energyOf(after)));
  storeMaterial(s,before,after); if (cid(after.core)==0u) { events[s]=0u; }
}
`;

// ---- support: a workgroup an awake brick; the solid-or-powder bit of each of its cells (the block
// pass reads the cells under a block from this snapshot, never from a block another thread is moving)
export const v2SupportWGSL = (g) => /* wgsl */ `
${v2Head(g, { state: false }, 'contact')}
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
  // Same cube SET as R5, including its one-cell halo outside the awake brick.
  // mBlockOffset only permutes corners, so no gravity-dependent ownership.
  let j=li/8u; let i=li%8u;
  let c0=brickCoord(b)*BS+P.offset+2*vec3i(i32(j&1u),i32((j>>1u)&1u),i32(j>>2u))-vec3i(1);
  let local=vec3i(i32(i&1u),i32(i>>2u),i32((i>>1u)&1u));
  let p=mEdge(c0+local);
  if (!inGrid(p)) { return; }
  var air=0u; var oxygen=0u; var co2=0u; var gas=0u;
  for(var axis=0;axis<3;axis++) {
    let sign=select(-1,1,local[axis]!=0);
    let n=cellAt(mEdge(p+axisV(axis)*sign)); let id=cid(n); let kind=clsOf(n);
    if(id==${E.EMPTY}u){air++;}
    if(id==${E.OXYGEN}u || (id==${E.FIRE}u && ctypeOf(n)==${E.OXYGEN}u)){oxygen++;}
    if(id==${E.CO2}u){co2++;}
    if(kind==C_AIR || kind==C_GAS){gas++;}
  }
  // Transient low byte only; Limit fully overwrites active cells before jets
  // or gather. Sleeping faces are rejected before reading limiter bits.
  let s=slotOf(p);
  liquidScratch[s].x=(liquidScratch[s].x&0xffffff00u)|air|(oxygen<<2u)|(co2<<4u)|(gas<<6u);
}
`;

// ---- the block pass: a thread a 2×2×2 block at this tick's offset, 8 blocks an awake brick (the
// blocks whose upper corner lies in it). In order: R2 topple (lean-sim blockTopple: a supported powder
// in the top layer moves into a lower in-block cell of air or fluid if the cell above that is too, with
// its element's drop test read from the support snapshot; diagonals for half the positions, hashed, so
// heaps come out round), R3 sink and float (a denser movable over a lighter fluid swaps down), R4 gas
// (lateral random swaps while young; a fading gas spends its life and leaves air).
const blockIdentityWGSL = /* wgsl */ `
  // Canonical full WATER at matching 20 C is also an exact identity. Flux
  // belongs to the later liquid passes: preserve all 48 packed bits verbatim.
  // Test the first word so ordinary AIR pays no extra scan.
  if (cs[0].x == ((1173u << 8u) | ${E.WATER}u) && P.ambient == 20.0) {
    var zeroWater = blockCount == 8u;
    for (var k = 0u; k < blockCount; k++) {
      if (!inGrid(positions[k]) || cs[k].x != ((1173u << 8u) | ${E.WATER}u) || cs[k].y != ${FULL}u ||
          (cs[k].w & 0xffff0000u) != 0u || bs[k] != 0 || pending[k] != 0u) { zeroWater = false; }
    }
    if (zeroWater) { return; }
  }
  // Proven zero-work domain, NOT a generic all-AIR skip. Custom contact
  // injections (including the ABI probe) have no such no-op guarantee.
  let rawTq = (cs[0].x >> 8u) & 65535u;
  let canonicalAir = vec4u(rawTq << 8u, 0u, 0u, 0u);
  var zeroWork = blockCount == 8u && rawTq <= 41093u;
  for (var k = 0u; k < blockCount; k++) {
    if (!inGrid(positions[k]) || any(cs[k] != canonicalAir) || bs[k] != 0 || pending[k] != 0u) { zeroWork = false; }
  }
  // Match the boundary wrapper's exact f32 round/clamp encoding. Even an
  // interior open-edge block conservatively requires ambient equality.
  if (P.edge == 1u && mAirHeat() && rawTq != u32(clamp(round((P.ambient+273.25)*4.0),0.0,65535.0))) { zeroWork = false; }
  // AIR cannot topple, equal-density AIR cannot swap, AIR is not ageing gas.
  // Uniform normal AIR emits no contact/boundary heat, requests or ledgers;
  // equal storeMaterial values would only rewrite identical cells/banks.
  // Support still snapshots ALL targets, including AIR that may move later.
  if (zeroWork) { return; }
  `;

export const v2BlockWGSL = (g, contactWGSL = '', compact = false) => {
  // Only exact production contact has the disjoint/frozen-read identity proof.
  compact = compact && contactWGSL === productionContactWGSL;
  const tail = compact ? v2BlockCompactLayout(g) : null;
  return /* wgsl */ `
${v2Head(g, { state: false }, 'contact')}
${contactWGSL}
fn motionDensity(c: vec4u) -> f32 {
  return ${/\bfn\s+contactDensity\s*\(/.test(contactWGSL) ? 'contactDensity(c)' : 'densOfE(cid(c))'};
}
// share of positions whose grains may topple diagonally (lean-sim MOORE 0.5: an octagon, not a square or diamond)
const MOORE_U: u32 = 0x80000000u;
// powder sinking through a fluid: this share of (1 - ρ_fluid/ρ_powder) a tick its pair is in one block
const SINK_RATE: f32 = 0.6;
const LIQ_SWAP: f32 = 0.3;   // a denser liquid over a lighter one
const GAS_SWAP: f32 = 0.5;   // gas rising or sinking through air or gas, or bubbling up through a liquid
const DIFFUSE: f32 = 0.25;   // a young gas's lateral swap with air
fn off8(i: u32) -> vec3i { return vec3i(i32(i & 1u), i32(i >> 2u), i32((i >> 1u) & 1u)); }
fn supportAt(position: vec3i) -> bool {
  let p=mEdge(position);
  if (!inGrid(p)) { return P.edge != 1u; }
  let s = slotOf(p);
  let l = s & 63u;
  return ((atomicLoad(&act2[V2_OCC + 2u * (s >> 6u) + (l >> 5u)]) >> (l & 31u)) & 1u) != 0u;
}
${MAIN} {
  ${compact ? `let index = foldId(wg, nwg) * 64u + li;
  if (index >= liquidScratch[${tail.header / 16}u].x) { return; }
  let t = liquidScratch[${tail.list / 16}u + index / 4u][index % 4u];
  let e = t / 8u;` : 'let e = foldId(wg, nwg) * 8u + li / 8u;'}
  if (e >= useAwake()) { return; }
  let b = atomicLoad(&act2[V2_LIST + e]);
  let j = ${compact ? 't' : 'li'} % 8u;
  let u = brickCoord(b) * BS + P.offset + 2 * vec3i(i32(j & 1u), i32((j >> 1u) & 1u), i32(j >> 2u));
  let c0 = u - vec3i(1);
  let down=mDown(vec3f(c0)+1.0);
  let gravityOn=any(down!=vec3i(0));
  // Every valid grid has at least eight event slots. Runtime bounds prevent
  // backend expansion of eight copies of the large thermal/contact helpers.
  let blockCount=min(8u,arrayLength(&events));
  let columnCount=blockCount/2u;
  var cs: array<vec4u, 8>;
  var orig: array<vec4u, 8>;
  var bs: array<i32, 8>; var oldBanks: array<i32, 8>;
  var positions: array<vec3i, 8>; var requests: array<u32, 8>; var pending: array<u32, 8>;
  for (var i = 0u; i < blockCount; i++) {
    let p = mEdge(c0 + mBlockOffset(off8(i),down)); positions[i] = p;
    cs[i] = cellAt(p); orig[i] = cs[i];
    if (inGrid(p)) { bs[i] = banks[slotOf(p)]; pending[i] = events[slotOf(p)]; }
    oldBanks[i] = bs[i];
  }
  ${contactWGSL === productionContactWGSL && !compact ? blockIdentityWGSL : ''}
  // R2 topple
  for (var c = 0u; c < columnCount && gravityOn; c++) {
    let ti = 4u + c;
    let gr = cs[ti];
    if (!inGrid(positions[ti])) { continue; }
    if (clsOf(gr) != C_POWDER) { continue; }
    let kb = clsOf(cs[c]);
    if (kb != C_SOLID && kb != C_POWDER) { continue; }   // falling or sinking belong to other rules
    let pTop = positions[ti];
    let drop = dropOfE(cid(gr));
    var cand = array<u32, 3>(0u, 0u, 0u);
    var w = array<f32, 3>(0.0, 0.0, 0.0);
    var nc = 0u;
    var wsum = 0.0;
    for (var c2 = 0u; c2 < columnCount; c2++) {
      if (c2 == c || !inGrid(positions[c2]) || !fluidC(cs[c2]) || !fluidC(cs[4u + c2])) { continue; }
      let diag = (c2 ^ c) == 3u;
      if (diag) {
        if (seed3(pTop, 0u, 4242u) >= MOORE_U) { continue; }
        // no squeezing between corners: one of the two top cells beside the diagonal is open
        if (!fluidC(cs[4u + (c2 & 1u) + (c & 2u)]) && !fluidC(cs[4u + (c & 1u) + (c2 & 2u)])) { continue; }
      }
      // cohesion: drop − 1 more empty cells under the target
      let pt = positions[c2];
      var ok = true;
      for (var dd = 1u; dd < drop; dd++) {
        if (supportAt(pt + down*i32(dd))) { ok = false; }
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
    cs[pick] = setFall(gr, 0.0, 0.0);
    cs[ti] = zeroQ(moved);
    let bank = bs[pick]; bs[pick] = bs[ti]; bs[ti] = bank;
    let request = pending[pick]; pending[pick] = pending[ti]; pending[ti] = request;
    markBusy(positions[pick]);
  }
  // R3 sink and float, R4 buoyancy: a denser movable over a lighter fluid swaps down
  for (var c = 0u; c < columnCount && gravityOn; c++) {
    let lo = cs[c];
    let hi = cs[4u + c];
    let kL = clsOf(lo);
    let kU = clsOf(hi);
    if (!inGrid(positions[c]) || !inGrid(positions[4u + c]) || kU == C_SOLID || !fluidC(lo)) { continue; }
    if ((kU == C_POWDER || kU == C_LIQUID) && kL == C_AIR) { continue; }   // a fall: the column pass, the flux
    let dU = motionDensity(hi);
    let dL = motionDensity(lo);
    if (dU <= dL) { continue; }
    let pU = positions[4u + c];
    markBusy(pU);
    var chance = GAS_SWAP;
    if (kU == C_POWDER) { chance = SINK_RATE * (1.0 - dL / dU); } else if (kU == C_LIQUID && kL == C_LIQUID) { chance = LIQ_SWAP; }
    var rs = seed3(pU, P.tick, 78u);
    if (rnd(&rs) < chance) {
      cs[c] = resetMotionAge(zeroQ(hi));
      cs[4u + c] = resetMotionAge(zeroQ(lo));
      let bank = bs[c]; bs[c] = bs[4u + c]; bs[4u + c] = bank;
      let request = pending[c]; pending[c] = pending[4u + c]; pending[4u + c] = request;
      markBusy(positions[c]);
    }
  }
  // R4 gas: lateral swaps with air while young (x pairs, then z pairs)
  for (var m = 0u; m < blockCount; m++) {
    var i0 = 0u;
    var i1 = 0u;
    if (m < 4u) { i0 = 2u * m; i1 = i0 + 1u; } else { i0 = (m - 4u) + ((m - 4u) & 2u); i1 = i0 + 2u; }
    if (!inGrid(positions[i0]) || !inGrid(positions[i1])) { continue; }
    let a0 = cs[i0];
    let a1 = cs[i1];
    let k0 = clsOf(a0);
    let k1 = clsOf(a1);
    var young = false;
    if (k0 == C_GAS && k1 == C_AIR && cAge(a0) < DIFFUSE_AGE) { young = true; }
    if (k1 == C_GAS && k0 == C_AIR && cAge(a1) < DIFFUSE_AGE) { young = true; }
    if (!young) { continue; }
    let p0 = positions[i0];
    markBusy(p0);
    var rs = seed3(p0, P.tick, 79u + m);
    if (rnd(&rs) < DIFFUSE) {
      cs[i0] = zeroQ(a1);
      cs[i1] = zeroQ(a0);
      let bank = bs[i0]; bs[i0] = bs[i1]; bs[i1] = bank;
      let request = pending[i0]; pending[i0] = pending[i1]; pending[i1] = request;
      markBusy(positions[i1]);
    }
  }
  // Gas ageing is motion state; reaction/lifetime changes belong to contact.
  for (var i = 0u; i < blockCount; i++) {
    if (clsOf(cs[i]) == C_GAS && cAge(cs[i]) < DIFFUSE_AGE) {
      cs[i] = withAge(cs[i], cAge(cs[i]) + 1u); markBusy(positions[i]);
    }
  }
  // Obligations follow the moved material, not its old position. Loading these
  // before swaps would duplicate an event at both the old and new locations.
  for (var i = 0u; i < blockCount; i++) { requests[i] = pending[i]; }
  ${contactWGSL ? 'contactBlock(&cs, &bs, positions, &requests);' : '// Contact module not installed: no reaction capability advertised.'}
  ${contactWGSL.includes('fn contactBoundary(') ? `
  if (P.edge==1u && mAirHeat()) {
    for (var i=0u;i<blockCount;i++) {
      let p=positions[i]; if (!inGrid(p)) { continue; }
      // R5 exposed sides and top, never the floor, solid walls or loop seams.
      let open=u32(p.x==0)+u32(p.x==NX-1)+u32(p.z==0)+u32(p.z==NZ-1)+u32(p.y==NY-1);
      if (open!=0u) {
        let m=contactBoundary(Material(cs[i],bs[i]),open,u32(clamp(round((P.ambient+273.25)*4.0),0.0,65535.0)),p);
        cs[i]=m.core; bs[i]=m.bank;
      }
    }
  }` : ''}
  for (var i = 0u; i < blockCount; i++) {
    let p = positions[i];
    if (inGrid(p)) {
      let slot = slotOf(p);
      storeMaterial(slot, Material(orig[i], oldBanks[i]), Material(cs[i], bs[i]));
      events[slot] = pending[i] | requests[i]; noteEvents(slot, pending[i] | requests[i]);
    }
  }
}
`;
};

// No production contact helpers/private contact frame in this small scan. The
// atomic word view avoids vec4 component RMW races between adjacent appends.
export const v2BlockClassifyWGSL = g => {
  const tail = v2BlockCompactLayout(g);
  return /* wgsl */ `
${v2Head(g, { state: false }, 'contact').replace('liquidScratch: array<vec4u>', 'liquidScratch: array<atomic<u32>>')}
fn off8(i: u32) -> vec3i { return vec3i(i32(i & 1u), i32(i >> 2u), i32((i >> 1u) & 1u)); }
${MAIN} {
  let t = foldId(wg, nwg) * 64u + li;
  let e = t / 8u;
  if (e >= useAwake()) { return; }
  let b = atomicLoad(&act2[V2_LIST + e]);
  let j = t % 8u;
  let u = brickCoord(b) * BS + P.offset + 2 * vec3i(i32(j & 1u), i32((j >> 1u) & 1u), i32(j >> 2u));
  let c0 = u - vec3i(1);
  let down=mDown(vec3f(c0)+1.0);
  let blockCount=min(8u,arrayLength(&events));
  var cs: array<vec4u, 8>;
  var bs: array<i32, 8>;
  var positions: array<vec3i, 8>; var pending: array<u32, 8>;
  for (var i = 0u; i < blockCount; i++) {
    let p = mEdge(c0 + mBlockOffset(off8(i),down)); positions[i] = p;
    cs[i] = cellAt(p);
    if (inGrid(p)) { bs[i] = banks[slotOf(p)]; pending[i] = events[slotOf(p)]; }
  }
${blockIdentityWGSL}
  let index = atomicAdd(&liquidScratch[${tail.header / 4}u], 1u);
  atomicStore(&liquidScratch[${tail.list / 4}u + index], t);
}
`;
};

// Direct dispatch only: never writable-bind args while using it indirectly.
export const v2BlockFinalizeWGSL = g => {
  const tail = v2BlockCompactLayout(g);
  return /* wgsl */ `
@group(2) @binding(0) var<storage, read_write> scratch: array<u32>;
@group(2) @binding(1) var<storage, read_write> args: array<u32>;
@compute @workgroup_size(1) fn main() {
  let count = scratch[${tail.header / 4}u];
  let groups = (count + 63u) / 64u;
  let y = max(1u, (groups + 65534u) / 65535u);
  args[${ARGS2.COMPACT}u] = (groups + y - 1u) / y;
  args[${ARGS2.COMPACT + 1}u] = y;
  args[${ARGS2.COMPACT + 2}u] = 1u;
}
`;
};

// The same direct dispatch for the liquid list the first flux appended: its length for the later
// passes, its count back to zero, a workgroup a brick (folded like writeFold).
export const v2LiquidFinalizeWGSL = g => {
  const l = v2LiquidListLayout(g);
  return /* wgsl */ `
@group(2) @binding(0) var<storage, read_write> jetMask: array<u32>;
@group(2) @binding(1) var<storage, read_write> args: array<u32>;
@compute @workgroup_size(1) fn main() {
  let n = jetMask[${l.count}u];
  jetMask[${l.use}u] = n;
  jetMask[${l.count}u] = 0u;
  let y = max(1u, (n + 65534u) / 65535u);
  args[${ARGS2.LIQUID}u] = (n + y - 1u) / y;
  args[${ARGS2.LIQUID + 1}u] = y;
  args[${ARGS2.LIQUID + 2}u] = 1u;
}
`;
};

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
fn flowCell(p: vec3i) -> vec4u { let s = slotOf(p); return vec4u(cells[s].x, cells[s].y, 0u, 0u); }
fn wetAt(p: vec3i) -> bool { return inGrid(p) && isLiq(flowCell(p)); }
// Dry cells choose one material and one lava subtype for the whole substep.
// Different formation energies cannot be merged into a single subtype tag.
fn claimOf(p: vec3i) -> vec2u {
  var best = 0u;
  var bt = 0u;
  for (var i = 0; i < 6; i++) {
    let q = mEdge(p + face6(i));
    if (!inGrid(q)) { continue; }
    let c = flowCell(q);
    let subtype = select(0u, ctypeOf(c), cid(c) == ${E.LAVA}u);
    if (isLiq(c) && (cid(c) > best || (cid(c) == best && subtype > bt))) { best = cid(c); bt = subtype; }
  }
  return vec2u(best, bt);
}
fn faceFlux(pi: vec3i, ci: vec4u, pj: vec3i, cj: vec4u, a: i32, qold: f32) -> f32 {
  // An unallocated detonation must retain its one source for deterministic
  // retry, not split that source into several liquid cells after the consumer.
  if (((events[slotOf(pi)] | events[slotOf(pj)]) & 1u) != 0u) { markBusy(pi); markBusy(pj); return 0.0; }
  let wi = isLiq(ci);
  let wj = isLiq(cj);
  if (!wi && !wj) { return 0.0; }
  var liq = cid(ci);
  if (!wi) { liq = cid(cj); }
  if (wi && wj && cid(ci) != cid(cj)) { return 0.0; }
  if (liq == ${E.LAVA}u) {
    if (wi && wj && ctypeOf(ci) != ctypeOf(cj)) { return 0.0; }
    if (!wi && claimOf(pi).y != ctypeOf(cj)) { return 0.0; }
    if (!wj && claimOf(pj).y != ctypeOf(ci)) { return 0.0; }
  }
  if (!wi && claimOf(pi).x != liq) { return 0.0; }
  if (!wj && claimOf(pj).x != liq) { return 0.0; }
  var drive = headOf(ci) - headOf(cj);
  drive += mFaceDrive(pi, a);
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
  if (mDown(vec3f(pi)+0.5)[a] == 0) {
    if (v > 0.0 && !wj && cFill(ci) < FILM && !wetAt(mEdge(pj + mDown(vec3f(pj)+0.5)))) { v = 0.0; }
    if (v < 0.0 && !wi && cFill(cj) < FILM && !wetAt(mEdge(pi + mDown(vec3f(pi)+0.5)))) { v = 0.0; }
  }
  v *= 1.0 - damp;
  if (abs(v) < QMIN) { v = 0.0; }
  // Six faces share conservative headroom. Outgoing mass can only add space;
  // no destination can exceed the sixteen-cell persistent-payload bound.
  var room = MAX_FILL;
  if (v > 0.0 && wj) { room -= cFill(cj); }
  if (v < 0.0 && wi) { room -= cFill(ci); }
  let rawCap = min(Q_MAX, f32(room / 6u));
  // f16 rounds to nearest; leave one ulp of headroom before packing.
  let cap = max(0.0, rawCap - max(1.0, rawCap / 1024.0));
  return clamp(v, -cap, cap);
}
`;
// limit, gather and foam: a workgroup a brick of the liquid list
const brickCell = /* wgsl */ `
  let e = foldId(wg, nwg);
  if (e >= atomicLoad(&jetMask[LIQ_USE])) { return; }
  let s = atomicLoad(&jetMask[LIQ_LIST + e]) * 64u + li;
  let p = cellOf(s);`;

// pass 1: each open cell's +x, +y, +z faces; a face into a sleeping brick stays shut this tick and wakes
// it, and a −face whose owner sleeps wakes the owner if it would flow.
// The tick's first flux (P.liquidList 0) runs over every awake brick and lists every awake brick in the
// 3³ neighbourhood (the activity pass's) of one holding liquid work: a liquid, or AIR other than
// canonical rest (gather-identity-check's: no flux, age, payload, bank or out-of-range code). Liquid
// moves at most a cell a substep, SUB < BRICK cells a tick, so an unlisted brick's cells and their
// awake neighbours stay dry all tick: its flux after the first rewrites the same zeros and repeats the
// same sleeping-face and detonation marks (nothing they read changes), limit's snapshots of it are
// never read, the jets find no candidate in it, gather is the identity and foam has nothing to decay.
export const v2FluxWGSL = (g) => /* wgsl */ `
${v2Head(g, { state: false }, 'liquid')}
${fluxWGSL}
var<workgroup> wgN: u32;
var<workgroup> wgWork: atomic<u32>;
fn liquidWork(c: vec4u, s: u32) -> bool {
  let k = clsOf(c);
  if (k == C_LIQUID) { return true; }
  return k == C_AIR && ((c.x & 0xff0000ffu) != 0u || cRawTq(c) > 41093u || any(c.yzw != vec3u(0u)) || banks[s] != 0);
}
${MAIN} {
  let e = foldId(wg, nwg);
  let listed = P.liquidList != 0u;
  if (li == 0u) { wgN = select(useAwake(), atomicLoad(&jetMask[LIQ_USE]), listed); }
  if (e >= workgroupUniformLoad(&wgN)) { return; }
  var b = 0u;
  if (listed) { b = atomicLoad(&jetMask[LIQ_LIST + e]); } else { b = atomicLoad(&act2[V2_LIST + e]); }
  let s = b * 64u + li;
  let c = cells[s];
  // The barrier in uniform control flow, before flux's early returns.
  if (!listed) {
    if (liquidWork(c, s)) { atomicOr(&wgWork, 1u); }
    workgroupBarrier();
  }
  flux(s, cellOf(s), c);
  if (listed || li >= 27u || atomicLoad(&wgWork) == 0u) { return; }
  let n = mEdge((brickCoord(b) + vec3i(i32(li % 3u), i32(li / 3u % 3u), i32(li / 9u)) - vec3i(1)) * BS) / BS;
  if (any(n < vec3i(0)) || any(n >= vec3i(BX, BY, BZ))) { return; }
  let nb = brickId(n);
  let bit = 1u << (nb & 31u);
  if (atomicLoad(&act2[V2_AWAKE + nb]) == 0u || (atomicOr(&jetMask[LIQ_BITS + (nb >> 5u)], bit) & bit) != 0u) { return; }
  atomicStore(&jetMask[LIQ_LIST + atomicAdd(&jetMask[LIQ_COUNT], 1u)], nb);
}
fn flux(s: u32, p: vec3i, c: vec4u) {
  if (!isOpenC(c)) { return; }
  let q0 = qOf(c);
  var q = vec3f(0.0);
  for (var a = 0; a < 3; a++) {
    let pj = mEdge(p + axisV(a));
    if (!inGrid(pj)) { continue; }
    let cj = flowCell(pj);
    if (!isOpenC(cj)) { continue; }
    var v = faceFlux(p, c, pj, cj, a, q0[a]);
    if (v != 0.0 && !awakeCell(pj)) { markBusy(p); markBusy(pj); v = 0.0; }
    q[a] = v;
  }
  if (any(q != q0)) { noteState(s); }
  cells[s].z = pack2x16float(q.xy);
  cells[s].w = (c.w & 0xffff0000u) | (pack2x16float(vec2f(q.z, 0.0)) & 0xffffu);
  for (var a = 0; a < 3; a++) {
    let ph = mEdge(p - axisV(a));
    if (!inGrid(ph) || awakeCell(ph)) { continue; }
    let ch = loadCell(ph);
    if (isOpenC(ch) && faceFlux(ph, ch, p, c, a, qOf(ch)[a]) != 0.0) { markBusy(ph); markBusy(p); }
  }
}
`;

// Exact floor(q*K/65535) from the complete active f16 q (zero or >= 1/2).
// q=a+b/2048: a*K <= 65504*65535; the residual numerator is < 2^28.
// Full K keeps the ordinary gather/identity hot path to one conversion.
const liquidAcceptedWGSL = /* wgsl */ `
fn acceptedAmount(q: f32, k: u32) -> u32 {
  let a = u32(max(q, 0.0));
  if (k == 65535u) { return a; }
  if (k == 0u) { return 0u; }
  let b = u32((max(q, 0.0) - f32(a)) * 2048.0);
  let p = a * k;
  return p / 65535u + ((p % 65535u) * 2048u + b * k) / 134215680u;
}
`;

// pass 2: retain complete f16 weights until AFTER scaling; limited sources drain
// exactly through a deterministic largest face. The five-bit tail is proved in
// liquid-limiter-order-check: < 6 + 2*6*65504/65535 + f32 error < 19.
// The face and remainder use the existing snapshot tag byte; no new storage.
export const v2LimitWGSL = (g) => /* wgsl */ `
${v2Head(g, { state: false }, 'liquid')}
${fluxWGSL}
${liquidAcceptedWGSL}
${MAIN} {
${brickCell}
  let c = cells[s];
  atomicStore(&jetMask[s], c.x & 0xff000000u);
  let kc = clsOf(c);
  if (kc == C_LIQUID) {
    let q = qOf(c);
    var a6 = array<u32, 6>(0u, 0u, 0u, 0u, 0u, 0u);   // exact q*2048 weights, in face6 order
    var out = 0u;
    for (var a = 0; a < 3; a++) {
      if (q[a] > 0.0) { a6[2 * a] = u32(q[a] * 2048.0); }
      let ph = mEdge(p - axisV(a));
      if (inGrid(ph) && awakeCell(ph)) {
        let ch = loadCell(ph);
        if (isOpenC(ch)) { let qh = qOf(ch)[a]; if (qh < 0.0) { a6[2 * a + 1] = u32(-qh * 2048.0); } }
      }
      out += a6[2 * a] + a6[2 * a + 1];
    }
    let fl = cFill(c);
    var kq = 65535u;
    var tag = 0u;
    if (out > fl * 2048u) {
      // Three f32 roundings err by < .012 in K; subtracting one is
      // conservative even across floor boundaries. Weight totals < 2^30.
      kq = u32(max(floor(f32(fl * 2048u) / f32(out) * 65535.0), 1.0)) - 1u;
      var sum = 0u;
      var best = 0u;
      var mx = 0u;
      for (var i = 0u; i < 6u; i++) {
        sum += acceptedAmount(f32(a6[i]) / 2048.0, kq);
        if (a6[i] > best) { best = a6[i]; mx = i; }
      }
      tag = mx | ((fl - sum) << 3u);
    }
    let payload = payloadOf(c);
    liquidScratch[s] = vec4u(kq | (tag << 16u) | (c.y & 0xff000000u),
      (c.x & 0xffffffu) | ((payload & 255u) << 24u), cFill(c) | ((payload >> 8u) << 24u), bitcast<u32>(banks[s]));
  } else {
    liquidScratch[s] = vec4u(65535u, c.x & 0xffffffu, 0u, bitcast<u32>(banks[s]));
  }
}
`;

// Gather's w lane is atomic: payload and z-flux share a physical word. Every
// write preserves the flux bits; neighboring reads are atomic too. x/y, banks
// are destination-only, all source material comes from immutable scratch.
function gatherHead(g) {
  return listedAwake(v2Head(g, { state: false }, 'liquid'))
    .replace('var<storage, read_write> cells: array<vec4u>;', 'var<storage, read_write> cells: array<GatherCore>;\nstruct GatherCore { x: u32, y: u32, z: u32, w: atomic<u32> }')
    .replace('fn loadCore(s: u32) -> vec4u { return cells[s]; }', 'fn loadCore(s: u32) -> vec4u { return vec4u(cells[s].x, cells[s].y, cells[s].z, atomicLoad(&cells[s].w)); }')
    .replace('fn storeCore(s: u32, c: vec4u) { cells[s] = c; }', 'fn storeCore(s: u32, c: vec4u) { cells[s].x = c.x; cells[s].y = c.y; cells[s].z = c.z; atomicStore(&cells[s].w, c.w); }');
}
// One canonical accepted-face packet contract shared with native jets.
export const liquidTransportWGSL = /* wgsl */ `
${liquidAcceptedWGSL}
fn snapshot(s: u32) -> Material {
  let a = liquidScratch[s];
  let payload = (a.y >> 24u) | ((a.z >> 24u) << 8u);
  var c = vec4u((a.y & 0xffffffu) | (atomicLoad(&jetMask[s]) & 0xff000000u), (a.z & 0xffffffu) | (a.x & 0xff000000u), 0u, payload << 16u);
  if (cid(c) == 0u) { c.y = 0u; }
  return Material(c, bitcast<i32>(a.w));
}
fn faceQ(p: vec3i, face: u32) -> f32 {
  let axis = i32(face / 2u); var owner = p;
  if ((face & 1u) != 0u) { owner = mEdge(owner - axisV(axis)); }
  if (!inGrid(owner) || !inGrid(mEdge(p + face6(i32(face))))) { return 0.0; }
  if (!awakeCell(p) || !awakeCell(mEdge(p + face6(i32(face))))) { return 0.0; }
  if (!isOpenC(snapshot(slotOf(p)).core) || !isOpenC(snapshot(slotOf(mEdge(p + face6(i32(face))))).core)) { return 0.0; }
  let s = slotOf(owner); let q = liquidFlux(s)[axis];
  return select(q, -q, (face & 1u) != 0u);
}
fn rawSendOf(p: vec3i, face: u32) -> u32 {
  if (!isLiq(snapshot(slotOf(p)).core)) { return 0u; }
  let a = liquidScratch[slotOf(p)]; let kq = a.x & 65535u;
  let tag = (a.x >> 16u) & 255u;
  var n = acceptedAmount(faceQ(p, face), kq);
  if (kq < 65535u && (tag & 7u) == face) { n += tag >> 3u; }
  return n;
}
fn prefixOf(p: vec3i, face: u32) -> u32 {
  var n = 0u; for (var f = 0u; f < face; f++) { n += rawSendOf(p, f); } return n;
}
fn shareUnsigned(total: u32, prefix: u32, n: u32, fill: u32) -> u32 {
  if (fill == 0u || total == 0u || n == 0u) { return 0u; }
  return energyDiv(energyMul(total, prefix + n), fill).x - energyDiv(energyMul(total, prefix), fill).x;
}
fn shareBank(bank: i32, prefix: u32, n: u32, fill: u32) -> i32 {
  let magnitude = select(bitcast<u32>(bank), 0u - bitcast<u32>(bank), bank < 0);
  let value = shareUnsigned(magnitude, prefix, n, fill);
  return select(i32(value), -i32(value), bank < 0);
}
fn transportedEnergy(src: Material, prefix: u32, n: u32) -> vec2u {
  let carried = energySub(energyOf(src), energyMul(FULLU, cTq(src.core)));
  return energyShare(carried, prefix, n, cFill(src.core));
}
// Invocation-local packet: gating and gather consume the exact same heat/fuel.
// No per-face storage, new scratch allocation or additional binding.
struct TransportPacket { amount: u32, heat: vec2u, fuel: u32 }
fn sendOf(p: vec3i, face: u32) -> TransportPacket {
  let empty = TransportPacket(0u, vec2u(0u), 0u);
  let n = rawSendOf(p, face); if (n == 0u) { return empty; }
  let src = snapshot(slotOf(p)); let dst = snapshot(slotOf(mEdge(p + face6(i32(face)))));
  // A largest-face tail can exceed that face's flux cap. Admit against frozen
  // receiver headroom too, independent of gravity or other incoming packets.
  let room = MAX_FILL - min(MAX_FILL, cFill(dst.core));
  if (n > room / 6u) { markBusy(p); return empty; }
  let prefix = prefixOf(p, face);
  let heat = transportedEnergy(src, prefix, n);
  if (!energyPacketFits(src, dst, heat, n)) { markBusy(p); return empty; }
  var fuel = 0u;
  if (!conductsNative(cid(src.core)) && payloadOf(src.core) != 0u) {
    fuel = shareUnsigned(payloadOf(src.core), prefix, n, cFill(src.core));
    // Payload concentration can grow through integer apportionment. Reserve an
    // equal share of actual u16 headroom, rather than assuming fresh full fuel.
    if (fuel > (65535u - payloadOf(dst.core)) / 6u) { markBusy(p); return empty; }
  }
  return TransportPacket(n, heat, fuel);
}
`;
export const v2GatherWGSL = (g) => /* wgsl */ `
${gatherHead(g)}
fn liquidFlux(s: u32) -> vec3f { return vec3f(unpack2x16float(cells[s].z), unpack2x16float(atomicLoad(&cells[s].w) & 65535u).x); }
${liquidTransportWGSL}

// 0: full gather; 1: identical storage; 2: identical storage, retain motion wake.
// Only immutable snapshots/masks and the immutable flux lanes describe neighbors.
fn gatherIdentity(p: vec3i, s: u32, before: vec4u, src: Material) -> u32 {
  let raw = cRawTq(src.core); let id = cid(src.core);
  if (raw > 41093u || src.bank != 0 || banks[s] != 0 ||
      src.core.w != 0u || cAge(src.core) != 0u ||
      any(before.xy != src.core.xy) || (before.w >> 16u) != 0u) { return 0u; }
  if (id == 0u) {
    for (var face = 0u; face < 6u; face++) {
      let q = mEdge(p + face6(i32(face)));
      if (inGrid(q) && awakeCell(q)) {
        if (isLiq(snapshot(slotOf(q)).core)) { return 0u; }
      }
      if (faceQ(p, face) != 0.0) { return 0u; }
    }
    return 1u;
  }
  if (!isLiq(src.core) || cFill(src.core) == 0u ||
      (MATERIAL_BURNS[id] && (src.core.y & 0x80000000u) != 0u)) { return 0u; }
  // Normal codes at latent endpoints are NOT canonical: re-encoding can tag them.
  if (phaseHotLatent(id) > 0 && i32(raw) >= phaseHotQ(id)) { return 0u; }
  if (phaseColdLatent(id) > 0 && i32(raw) <= phaseColdQ(id)) { return 0u; }
  let frozen = liquidScratch[s];
  if ((frozen.x & 0xffffffu) != 65535u || atomicLoad(&jetMask[s]) != 0u) { return 0u; }
  for (var face = 0u; face < 6u; face++) {
    let q = mEdge(p + face6(i32(face)));
    if (!inGrid(q) || !awakeCell(q)) { return 0u; }
    let other = slotOf(q);
    if (any(liquidScratch[other] != frozen) || atomicLoad(&jetMask[other]) != 0u) { return 0u; }
  }
  var moving = false;
  for (var axis = 0u; axis < 3u; axis++) {
    let positive = faceQ(p, axis * 2u); let negative = faceQ(p, axis * 2u + 1u);
    if (positive + negative != 0.0) { return 0u; }
    moving = moving || positive != 0.0;
  }
  // Equal accepted amounts carry n*(offsetPerQuantum + capacityPerQuantum*raw).
  // Admission cannot reject normal, equal-temperature packets; heat and mass
  // cancel pairwise. Zero payload/age and zero divergence leave no other writes.
  return select(1u, 2u, moving);
}

${MAIN} {
${brickCell}
  let before = loadCore(s); let src = snapshot(s);
  if (!isOpenC(src.core)) { return; }
  let identity = gatherIdentity(p, s, before, src);
  if (identity != 0u) {
    if (identity == 2u) { markBusy(p); }
    return;
  }
  var fill = i32(cFill(src.core)); var energy = energyOf(src);
  var payload = i32(payloadOf(src.core)); var id = cid(src.core); var ct = ctypeOf(src.core);
  var strongest = 0u; var code = payloadOf(src.core);
  var sent = 0u; var burning = 0u;
  var foamMass = energyMul(cAge(src.core), cFill(src.core));
  var agitation = 0.0;
  for (var face = 0u; face < 6u; face++) {
    let q = mEdge(p + face6(i32(face))); if (!inGrid(q) || !awakeCell(q)) { continue; }
    let out = sendOf(p, face);
    var incoming = TransportPacket(0u, vec2u(0u), 0u);
    if ((atomicLoad(&jetMask[slotOf(q)]) & (1u << (face ^ 1u))) == 0u) { incoming = sendOf(q, face ^ 1u); }
    if (out.amount != 0u) {
      sent += out.amount;
      foamMass = energySub(foamMass, energyMul(cAge(src.core), out.amount));
      fill -= i32(out.amount); energy = energySub(energy, out.heat);
      if (!conductsNative(cid(src.core))) { payload -= i32(out.fuel); }
    }
    if (incoming.amount != 0u) {
      let other = snapshot(slotOf(q));
      foamMass = energyAdd(foamMass, energyMul(cAge(other.core), incoming.amount));
      if (MATERIAL_BURNS[cid(other.core)]) { burning |= other.core.y & 0x80000000u; }
      fill += i32(incoming.amount); energy = energyAdd(energy, incoming.heat);
      if (id == 0u) { id = cid(other.core); }
      if (incoming.amount > strongest && cid(src.core) == 0u) { ct = ctypeOf(other.core); strongest = incoming.amount; }
      if (!conductsNative(id)) { payload += i32(incoming.fuel); }
      else { code = max(code, payloadOf(other.core)); }
    }
    agitation += abs(faceQ(p, face) + faceQ(p, face ^ 1u));
    if (out.amount != 0u || incoming.amount != 0u || faceQ(p, face) != 0.0) { markBusy(p); }
  }
  var next = before;
  if (fill == 0) { next.x &= 0x00ffff00u; next.y = 0u; next.w &= 65535u; }
  else {
    next.x = (next.x & 0xffffff00u) | id;
    if (cFill(src.core) > sent && MATERIAL_BURNS[cid(src.core)]) { burning |= src.core.y & 0x80000000u; }
    next.y = u32(fill) | (ct << 24u) | burning;
    // TPT-style local agitation; §4.3 shear/divergence generation, every liquid.
    let generated = u32(clamp(agitation / FULLF * 16.0 * FOAM_GAIN[id], 0.0, 32.0));
    next = withAge(next, min(255u, energyDiv(foamMass, u32(fill)).x + generated));
    next.w = (next.w & 65535u) | (select(u32(payload), code, conductsNative(id)) << 16u);
  }
  let after = withEnergy(Material(next, src.bank), energy);
  // z and the low16 w face flux are immutable throughout gather.
  cells[s].x = after.core.x; cells[s].y = after.core.y;
  atomicStore(&cells[s].w, after.core.w); banks[s] = after.bank;
  noteVisible(p, before, after.core);
  if (any(before != after.core) || src.bank != after.bank) { noteState(s); }
}
`;

// Monahan lifetime, byte-quantized deterministic decay at native60Hz, not frame rate.
// The tick's last listed pass: it hands the list's membership bits back clear for the next first flux.
export const v2FoamWGSL = g => `${v2Head(g, { state: false }, 'liquid')}
${MAIN} {
${brickCell}
  if (li == 0u) { let b = s >> 6u; atomicAnd(&jetMask[LIQ_BITS + (b >> 5u)], ~(1u << (b & 31u))); }
  let before = loadCore(s); if (!isLiq(before)) { return; }
  let foam = cAge(before); if (foam == 0u) { return; }
  let period = select(152u, 231u, cid(before) == ${E.SALTWATER}u);
  let phase = (P.tick + s) % period;
  let loss = ((phase + 1u) * foam) / period - (phase * foam) / period;
  let after = withAge(before, foam - loss);
  storeCell(p, after);
  if (cAge(after) != 0u) { markBusy(p); }
}
`;

// The writers report changed projections, including distant column destinations
// and offset-block neighbours. An awake halo alone must not invalidate the view.
// Compatibility dirtiness is independent of presentation marks and survives sleep.
export const v2InvalidateWGSL = (g) => /* wgsl */ `
${v2Head(g, { state: false, marks: true })}
${MAIN} {
  let b = foldThread(wg, nwg, li);
  if (b >= NBRICKS) { return; }
  // Read first: a clean brick's word stays untouched (no write of the zero it holds).
  if (atomicLoad(&act2[V2_VISIBLE + b]) == 0u || atomicExchange(&act2[V2_VISIBLE + b], 0u) == 0u) { return; }
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
  if (li == 0u) { wgPending = P.full | atomicLoad(&act2[V2_LEGACY + b]); }
  if (workgroupUniformLoad(&wgPending) == 0u) { return; }
  let s = b * 64u + li;
  let p = cellOf(s);
  writeCell(p, fetchAs(s), fetchBs(s), fetchFs(s), select(compactA(p, cells[s]), compactProbeA(p, cells[s]), H.format == 3u), vec4f(0.0));
  workgroupBarrier();
  if (li == 0u) { atomicStore(&act2[V2_LEGACY + b], 0u); }
}
`;

// ---------------------------------------------------------------- the kernels
const perBrick = (g) => fold(Math.ceil(gridDims(g).nbricks / 64));
const own = () => [LAYOUT.TABLES, 'EMPTY', V2_LAYOUT];
const withState = () => [LAYOUT.TABLES, V2_STATE_LAYOUT, V2_LAYOUT];
const material = () => [LAYOUT.TABLES, 'EMPTY', V2_MATERIAL_LAYOUT];
const liquid = () => [LAYOUT.TABLES, 'EMPTY', V2_LIQUID_LAYOUT];
const contact = () => [LAYOUT.TABLES, 'EMPTY', V2_CONTACT_LAYOUT];
/** Every v2 kernel: name, WGSL, group layouts (as WGSL_CHECK lists them), a sample dispatch. */
export const V2_KERNELS = [
  { name: 'v2externalEvents', code: v2ExternalEventsWGSL, layouts: () => [LAYOUT.TABLES, V2_INVALIDATE_LAYOUT, V2_CONTACT_LAYOUT], dispatch: (g) => fold(gridDims(g).nbricks) },
  { name: 'v2import', code: v2ImportWGSL, layouts: () => [LAYOUT.TABLES, V2_IMPORT_LAYOUT, V2_MATERIAL_LAYOUT], dispatch: (g) => fold(gridDims(g).nbricks) },
  { name: 'v2actScan', code: v2ActScanWGSL, layouts: own, dispatch: perBrick },
  { name: 'v2actArgs', code: v2ActArgsWGSL, layouts: () => [LAYOUT.TABLES, 'EMPTY', V2_ARGS_LAYOUT], dispatch: () => [1, 1, 1], workgroupSize: [1, 1, 1] },
  { name: 'v2activity', code: v2ActivityWGSL, layouts: own, dispatch: perBrick },
  { name: 'v2cols', code: v2ColsWGSL, layouts: own, dispatch: (g) => fold(Math.ceil((g.nx / 4) * (g.nz / 4) / 64)) },
  { name: 'v2args', code: v2ArgsWGSL, layouts: () => [LAYOUT.TABLES, 'EMPTY', V2_ARGS_LAYOUT], dispatch: () => [1, 1, 1], workgroupSize: [1, 1, 1] },
  { name: 'v2boundary', code: v2BoundaryWGSL, layouts: contact, dispatch: perBrick },
  { name: 'v2column', code: v2ColumnWGSL, layouts: contact, dispatch: perBrick },
  { name: 'v2support', code: v2SupportWGSL, layouts: contact, dispatch: perBrick },
  { name: 'v2block', code: v2BlockWGSL, layouts: contact, dispatch: perBrick },
  { name: 'v2flux', code: v2FluxWGSL, layouts: liquid, dispatch: perBrick },
  { name: 'v2limit', code: v2LimitWGSL, layouts: liquid, dispatch: perBrick },
  { name: 'v2gather', code: v2GatherWGSL, layouts: liquid, dispatch: perBrick },
  { name: 'v2foam', code: v2FoamWGSL, layouts: liquid, dispatch: perBrick },
  { name: 'v2liquidFinalize', code: v2LiquidFinalizeWGSL, layouts: () => ['EMPTY', 'EMPTY', V2_BLOCK_FINALIZE_LAYOUT], dispatch: () => [1, 1, 1], workgroupSize: [1, 1, 1] },
  { name: 'v2invalidate', code: v2InvalidateWGSL, layouts: () => [LAYOUT.TABLES, V2_INVALIDATE_LAYOUT, V2_LAYOUT], dispatch: perBrick },
  { name: 'v2bridge', code: v2BridgeWGSL, layouts: withState, dispatch: perBrick },
];

/** tools/check-wgsl.mjs, tools/check-sampler-budget.mjs (src/gpu/checks.js): built only with ?physics=v2. */
export const WGSL_CHECK = V2_KERNELS.map(({ name, code, layouts, dispatch }) => ({ name, kind: 'compute', code, layouts, dispatch, tool: true }));

// Dynamics owns group1 (up to five family buffers). This adapter has exactly
// three storage bindings and no legacy element buffer, leaving the device's
// guaranteed eight-buffer budget intact. P is supplied by the family module.
export const V2_DYNAMICS_LAYOUT = [buf(0, 'storage'), buf(1, 'storage'), buf(2, 'storage')];
// A wake must land in the busy words the NEXT activity pass reads. DynamicParams
// carries them as busyOut, taken at recording time (NativeDynamics._params), so
// in-tick stages and tools between ticks agree. Heads without that field number
// P.tick as the tick about to run (weather, forcing: owner.tick + 1) and wake
// its busyIn, as the import does (tools/v2/wake-parity-check.mjs).
export function nativeDynamicsHead(g, { busyOut = false } = {}) {
  const common = prelude(g, { state: false });
  const grid = common.slice(0, common.indexOf('// ---- the element tables'));
  const layout = common.slice(common.indexOf('// ---- the header and the state'), common.indexOf('// ---- the state\'s accessors'));
  const random = common.slice(common.indexOf('// ---- random streams'), common.indexOf('// ---- the shared physics tests'));
  let shared = v2Head(g).slice(v2Head(g).indexOf('const V2_BUSY0:'));
  shared = shared.replace('if (all(compactA(p, before) == compactA(p, after)) && (!isLiq(after) || cAge(before) == cAge(after)))', 'if (all(before == after))');
  if (!busyOut) shared = shared.replace('P.busyOut', 'select(V2_BUSY0, V2_BUSY0 + NBRICKS, (P.tick & 1u) == 0u)');
  // Dynamics needs only the original finite-f32 prefix, never the contact tail.
  const rows = new Uint32Array(v2Table().buffer, 0, ELEMENTS.length * 8);
  const ev = Array.from({ length: rows.length / 4 }, (_, i) => `vec4u(${Array.from(rows.subarray(i * 4, i * 4 + 4), word => `${word}u`).join(',')})`);
  return `${grid}\n${layout}\n${random}
@group(0) @binding(0) var<storage, read_write> cells: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> act2: array<atomic<u32>>;
const EV = array<vec4u, ${ev.length}>(${ev.join(',')});
${shared}
${nativeStateWGSL}
${materialStorageWGSL.replace('@group(2) @binding(4)', '@group(0) @binding(1)')}`;
}

// CPU validators exercise the injection ABI, not just the empty default seam.
const CONTACT_ABI_PROBE = `fn contactBlock(cores: ptr<function, array<vec4u, 8>>, banksIn: ptr<function, array<i32, 8>>, positions: array<vec3i, 8>, requests: ptr<function, array<u32, 8>>) {
  let m = Material((*cores)[0], (*banksIn)[0]);
  let n = withEnergy(m, energyAdd(energyOf(m), energySigned(-1)));
  (*cores)[0] = n.core; (*banksIn)[0] = n.bank;
  if (inGrid(positions[0])) { markBusy(positions[0]); (*requests)[0] |= 1u; }
}`;
WGSL_CHECK.push({ name: 'v2contactABI', kind: 'compute', code: g => v2BlockWGSL(g, CONTACT_ABI_PROBE), layouts: contact, dispatch: perBrick, tool: true });
WGSL_CHECK.push({ name: 'v2dynamicsABI', kind: 'compute', code: g => `${nativeDynamicsHead(g)}
${V2Params.wgsl}
@group(3) @binding(1) var<uniform> P: V2Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= SLOTS) { return; }
  let m = loadMaterial(gid.x); storeMaterial(gid.x, m, withEnergy(m, energyOf(m))); markBusy(cellOf(gid.x));
}`, layouts: () => [V2_DYNAMICS_LAYOUT, 'EMPTY', 'EMPTY'], dispatch: perBrick, tool: true });

WGSL_CHECK.push(
  { name: 'v2blockClassify', kind: 'compute', code: v2BlockClassifyWGSL, layouts: contact, dispatch: perBrick, tool: true },
  { name: 'v2blockFinalize', kind: 'compute', code: v2BlockFinalizeWGSL, layouts: () => ['EMPTY', 'EMPTY', V2_BLOCK_FINALIZE_LAYOUT], dispatch: () => [1, 1, 1], tool: true },
  { name: 'v2blockCompact', kind: 'compute', code: g => v2BlockWGSL(g, productionContactWGSL, true), layouts: contact, dispatch: perBrick, tool: true },
);

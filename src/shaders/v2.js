import { fallTerminal, stepFall, setFall, fallFraction, fallVelocity, FALL_GRAVITY, FALL_G_PER_MS2 } from '../v2/fall.js';
import { GRAVITY_MS2, STEPS_PER_TICK, V1_STEP_MS } from '../v2/gravity.js';
import { PHYS } from '../physics.js';
import { LEGACY_STEPS_PER_TICK } from '../v2/host.js';
import { fallWGSL, fallStepWGSL } from './v2/fall.js';
import { FOAM_ROWS } from '../v2/foam.js';
import { nativeStateWGSL, materialStorageWGSL, decoStorageWGSL } from './v2/state.js';
import { compactDecodeWGSL } from './compact.js';
import { prelude, gridDims, LAYOUT, stateLayout, SEED_MAX, STAGE, BRICK } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { E, ELEMENTS, K } from '../elements.js';
import { ELEC } from '../electricity.js';
import { lifeScale } from '../v2/layout.js';
import { CELL_M } from '../scale.js';
import { MODE_FIELDS } from '../v2/modes.js';
import { modeWGSL } from './v2/modes.js';
import { CONTACT_ROWS, CONTACT_REACTIONS } from '../v2/contact.js';
import { appendContactTable } from '../v2/contactTable.js';
import { contactWGSL as productionContactWGSL, requestMergeWGSL, outsideFacesWGSL, outsideSiteWGSL } from './v2/contact.js';
import { v2RunsKernel, v2PairsKernel, COLUMN } from './v2/columns.js';
import { PARTICLE_CAP, SHOCK_LANDINGS, v1GrainOddsTable } from '../v2/dynamics-reference.js';

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
//   runs      liquids as column runs: pack, fall, foam, domain records (src/shaders/v2/columns.js)
//   pairs     R13 as shallow-water face segments: one flux stage, four transfer stages
//   invalidate  awake-brick presentation marks and persistent compatibility-dirty bits
//   bridge    only at legacy editing/readback boundaries, never a normal tick
// Rest: a settled box has no awake brick, and the driver then dispatches nothing at all.

// ---------------------------------------------------------------- clock and units
export const TICK_HZ = 60;                         // docs/v2.md 5.1: Minecraft's fixed game tick
// the reference pull: V1's gravity in m/s² (v2/gravity.js; user decision 2026-10-21: V2 falls as V1 does)
export const G_MS2 = GRAVITY_MS2;
export const G_TICK = G_MS2 / CELL_M / TICK_HZ ** 2;   // cells/tick²
export const G_CELLS = G_MS2 / CELL_M;                 // cells/s²
// liquid (lean-sim's numbers: the prototype's U-tube, pool, puddle and pipe pass on them)
export const FULL = 1 << 16;                       // a full cell's fill
// The face lanes hold a segment's depth-averaged flux in quanta a tick (src/shaders/v2/columns.js): this
// many updates a second, for readers that turn a lane into a speed.
export const LANE_HZ = TICK_HZ;
// rest: a brick sleeps once neither it nor any of its 26 neighbours was busy for one offset cycle (5.6)
export const QUIET_TICKS = 8;
// a brick's quiet run stops counting here (one byte); a brick at it, with nothing busy near, is unchanged
export const QUIET_CAP = 255;
// a brick summary's codes (v2ActLayout summary): a liquid's code carries its id and lava subtype above it
export const SUMMARY = { CLOSED: 1, AIR: 2, LIQUID: 3 };
// ¼ K steps from -273.25 °C: 20 °C is 1173 exactly
export const T_OFFSET = 273.25;

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
// Only the import reads it now (a fading gas comes in with life): contact owns the lives (v2/contact.js), and
// plasma has none in V1 (react.js: it leaves only by cooling), so it isn't one. Nor is STEAM: V1 spawns it at
// life 0, its latent bank (elements.js mechanisms lifeBank), so the import's life-1 floor never applies to it.
const FADE_S = { FIRE: 0.75, SMOKE: 6, CAUSTIC_GAS: 10 };

// V1's drift: the terminal speed (cells/step) a cell reaches per m/s² of P.gravity, signed along the pull (+ down).
// V1 react.js forces add SIM_GRAVITY·GRAV a step at the reference pull (fall.js FALL_G_PER_MS2 of P.gravity) and
// take DRAG of the velocity, so it settles at g·GRAV·(1 - DRAG)/DRAG (move.js caps it at V_MAX). Air and cloud
// have no GRAV: they rise or sink by their temperature (react.js lift), so their rows hold a unit GRAV's drift
// and the block pass scales it (v1Drift). A cell with no drag never settles: V1 caps it at V_MAX.
const DRIFT_UNBOUNDED = 1e6;
const BUOYANT_BY_HEAT = new Set(['EMPTY', 'CLOUD']);
export function v1DriftPerMS2(e) {
  const keep = 1 - (e.drag ?? 0), grav = BUOYANT_BY_HEAT.has(e.key) ? 1 : (e.grav ?? 0);
  if (!(keep < 1)) return Math.sign(grav) * DRIFT_UNBOUNDED;
  return FALL_G_PER_MS2 * grav * keep / (1 - keep);
}
// V1's Brownian jitter (react.js: JITTER added a step, uniform in ±JITTER/2 on each axis, then DRAG takes its
// share): the velocity settles to a spread σ² = keep²·(JITTER²/12)/(1 - keep²) over a correlation of 1/DRAG
// steps, and a cell trading places on a share |v| of its pairings (move.js horizontal) spreads by σ²/DRAG cells² a
// step on each axis (the tiles' CPU port of move.js and react.js, src/ui/tiles/engine.js, measures CO2 0.91 cells²
// a tick, this law 0.89). V2 trades a pair at most once a tick, a ±1 step: its chance a tick is that spread.
export function v1JitterChance(e) {
  const keep = 1 - (e.drag ?? 0), j = e.jitter ?? 0;
  if (!(j > 0) || !(keep < 1)) return 0;
  const sigma2 = keep * keep * (j * j / 12) / (1 - keep * keep);
  return Math.min(1, STEPS_PER_TICK * sigma2 / (1 - keep));
}

/** The v2 row of every element: { cls, drop, jitter (V1's lateral trade chance a tick), dens, yieldHead, damp,
 * fade (life a tick), drift (V1's terminal cells/step per m/s² of pull, + down) }. */
export function v2Rows() {
  return ELEMENTS.map((e) => {
    const cls = KIND_CLASS[e.kind] ?? V2.SOLID;
    return {
      key: e.key, cls,
      drop: cls === V2.POWDER ? dropOf(REPOSE[e.key] ?? 34) : 0,
      jitter: cls === V2.GAS || cls === V2.AIR ? v1JitterChance(e) : 0,
      dens: e.dens,
      yieldHead: cls === V2.LIQUID ? YIELD[e.key] ?? 0 : 0,
      damp: cls === V2.LIQUID ? Math.min(Math.max(e.drag ?? 0.01, 0.005), 0.3) : 0,
      fade: cls === V2.GAS && FADE_S[e.key] ? 1 / (FADE_S[e.key] * TICK_HZ) : 0,
      drift: cls === V2.SOLID ? 0 : v1DriftPerMS2(e),
    };
  });
}

/** EV: unchanged two-vec4f element prefix, then immutable contact metadata. */
export function v2Table() {
  const rows = v2Rows(), out = new Float32Array(rows.length * 8);
  rows.forEach((r, i) => out.set([r.cls, r.drop, r.jitter, r.dens, r.yieldHead, r.damp, r.fade, r.drift], i * 8));
  return appendContactTable(out, CONTACT_ROWS, CONTACT_REACTIONS);
}

/** cells fallen from rest in `ticks` ticks by an element's column-fall law (the column pass's: fall.js stepFall). */
export function fallCells(id, ticks) {
  if (!(fallTerminal(id) > 0)) return 0;
  let core = setFall(new Uint32Array([id, 0, 0, 0]), 0, 0), f = 0;
  for (let n = 1; n <= ticks; n++) { const s = stepFall(core, FALL_GRAVITY); core = s.core; f += s.cells; }
  return f + fallFraction(core);
}

// ---------------------------------------------------------------- buffers
// The shared allocator's per-brick prefixes (shaders/v2/blasts.js count, jets.js count) are local to
// groups of this many bricks, a workgroup each. A count that knows a group holds no requests skips
// all of it: the jets' marks note their group (v2ActLayout jetGroups), windList notes the wind list's.
export const BRICK_GROUP = 64;
export function brickGroups(g) { return Math.ceil(gridDims(g).nbricks / BRICK_GROUP); }
// Their WGSL, declared only in the stages that read or write the group words (the liquid passes' marks,
// windList, the jets' and the couple run's counts): every other module's text stays as it was.
export function brickGroupWGSL(g) {
  return /* wgsl */ `
const BRICK_GROUP: u32 = ${BRICK_GROUP}u;
const BRICK_GROUPS: u32 = ${brickGroups(g)}u;
const V2_JET_GROUPS: u32 = ${v2ActLayout(g).jetGroups}u;`;
}
// v2's activity words (u32), one run per brick each, then the brick columns and the counts.
// state: a brick's cells changed since the air reach pass last cleared it (noteState).
// events: after the saved words (`words`), so saves keep their length: a brick may hold a
// nonzero material request (noteEvents); clear means every request word in it is zero.
// air: unsaved too. Clear means the brick's air ended its last air tick settled and unchanged,
// in both ping-pong copies (the air source clears it); every other writer sets it (noteAir).
// colAwake: unsaved; a brick column holds an awake brick this tick (v2cols writes every one).
// summary: unsaved; what every cell of a brick is, for the runs pass's scan (columns.js colProbe): 0 unknown,
// else written by support from its cells and cleared by noteState at any change since.
// jets: unsaved; a brick holds a deposited cell marked to launch (columns.js colMarkJet; the jets pass clears it).
// near, plist: the activity scan's words (unsaved): bit 0 a busy brick in the 3³ neighbourhood,
// bit 1 listed; then the list [count, use, bricks]. Zero again after every activity pass.
// plive: a bit a particle-pool slot (unsaved, liveWords of them), set wherever a slot may be live:
// every spawn sets it, retirements and the pool preparation clear it, restores set every bit. Pool
// sweeps read only slots whose bit is set (a clear bit means the slot's record has ID 0).
// jetGroups: unsaved; a word a group of BRICK_GROUP bricks, set with any of its bricks' jets words
// (noteJet); the jets' count reads and clears it instead of the bricks' words. Zero between ticks, like them.
// elecCount, elecFlag, elecList, elecScratch: unsaved, last; the electric pass's (shaders/v2/electric.js):
// its list's [count, use], a brick's listed bit, the list, then a word a cell for a step's pending change.
// All zero between ticks but the list itself and its use (the pass's last step clears the bits, every
// step's commit its scratch words).
export function v2ActLayout(g) {
  const { nbricks: nb, bx, bz } = gridDims(g);
  const ledger = 10 * nb + bx * bz + 8, plive = ledger + 8 + 6 * nb + bx * bz, liveWords = PARTICLE_CAP / 32, jetGroups = plive + liveWords;
  const elecCount = jetGroups + brickGroups(g), elecFlag = elecCount + 2, elecList = elecFlag + nb, elecScratch = elecList + nb;
  return { busy0: 0, busy1: nb, quiet: 2 * nb, awake: 3 * nb, list: 4 * nb, occ: 5 * nb, cols: 7 * nb, legacy: 7 * nb + bx * bz + 8, visible: 8 * nb + bx * bz + 8, count: 7 * nb + bx * bz, state: 9 * nb + bx * bz + 8, energySource: ledger, energySink: ledger + 3, boundaryMass: 7 * nb + bx * bz + 6, words: ledger + 6, events: ledger + 6, air: ledger + 6 + nb, near: ledger + 6 + 2 * nb, plist: ledger + 6 + 3 * nb, jets: ledger + 8 + 4 * nb, colAwake: ledger + 8 + 5 * nb, summary: ledger + 8 + 5 * nb + bx * bz, plive, liveWords, jetGroups, elecCount, elecFlag, elecList, elecScratch, allocated: elecScratch + 64 * nb };
}
// count words: appends (awake, cols), busy bricks last tick, the lengths this tick's passes use
export const CNT = { AWAKE: 0, COLS: 1, BUSY: 2, USE_AWAKE: 3, USE_COLS: 4 };
// the indirect args and the stats the driver reads back (u32 words)
// ACT, the activity pass's (v2actArgs), follows the saved words. Words 20-31 are reserved (the
// retired liquid list's args): saves keep their length.
// ELEC, the electric pass's (v2elecArgs), follows it.
export const ARGS2 = { COLS: 0, BRICKS: 3, BLOCKS: 6, COMPACT: 9, STATS: 12, words: 32, ACT: 32, ELEC: 36, allocated: 40 };
// jetMask: the pair stages' face demands, two words a cell (x, z)
export const v2DemandWords = (g) => 2 * gridDims(g).slots;
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

// pairAxis, pairStage, pairParity: which of a tick's pair stages a v2pairs dispatch is (columns.js pairOrder)
// deco: the moves carry the decoration plane (src/deco.js; V1's MoveParams deco: only while the layer may hold paint)
// elecStep: which of a tick's electric steps a v2elecGather/v2elecCommit dispatch is (shaders/v2/electric.js)
export const V2Params = uniformStruct('V2Params', { tick: 'u32', busyIn: 'u32', busyOut: 'u32', full: 'u32', offset: 'vec3i', preserveLegacyMarks: 'u32', pairAxis: 'u32', pairStage: 'u32', pairParity: 'u32', ...MODE_FIELDS, deco: 'u32', elecStep: 'u32' });

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

// The legacy word of a brick (act2[V2_LEGACY + b]). STALE: its A/B are behind its cells (every writer
// of the cells sets it: noteVisible, the import, whole-grid writes). DIFFERS: set by the export, the
// brick holds a cell the two projections show differently (a liquid's partial fill the drawn dither
// hides: compact.js compactA against compactProbeA), so a switch of projection converts it again. A
// writer's STALE drops DIFFERS: the next export converts the brick whole and finds it again.
export const LEGACY_WORD = { STALE: 1, DIFFERS: 2 };
// An export's scope (the bridge's P.full): the stale bricks; every brick (before the first export, when
// the cache holds no projection yet); on a switch of projection, the stale bricks and the differing ones.
export const BRIDGE = { CHANGED: 0, ALL: 1, FLIP: 2 };

// With a store's drawn projection unchanged, whether its edit projection is too: they part only where
// compactProbeCore lifts a partial liquid fill (noteVisible). Above V2_BUSY0: dynamics heads leave it out.
const compactProbeHoldsWGSL = /* wgsl */ `
fn compactProbeHolds(p: vec3i, before: vec4u, after: vec4u) -> bool {
  let pb = compactProbeCore(before);
  let pa = compactProbeCore(after);
  if (all(pb == before) && all(pa == after)) { return true; }
  return all(compactA(p, pb) == compactA(p, pa));
}`;
// noteVisible's early out: a store that changes neither the drawn projection nor a liquid's age redraws
// nothing; one that still changes the edit projection (a partial fill the dither hides comes, goes or
// changes) changes the legacy cache alone. nativeDynamicsHead replaces it whole (its stores note any change).
const NOTE_UNSEEN = `if (all(compactA(p, before) == compactA(p, after)) && (!isLiq(after) || cAge(before) == cAge(after))) {
    if (compactProbeHolds(p, before, after)) { return; }
    atomicStore(&act2[V2_LEGACY + brickOfCell(p)], 1u);
    return;
  }`;

export function v2Head(g, opts = { state: false }, family = 'base') {
  const a = v2ActLayout(g);
  return /* wgsl */ `
${prelude(g, opts).replace(/\bMaterial\b/g, 'LegacyMaterial')}
${opts.state === 'read' ? '' : compactDecodeWGSL}
${compactProbeHoldsWGSL}
${nativeStateWGSL}
${family !== 'base' ? materialStorageWGSL + decoStorageWGSL : ''}
${family === 'contact' || family === 'liquid' ? '@group(2) @binding(5) var<storage, read_write> liquidScratch: array<vec4u>;' : ''}
${family === 'liquid' ? '@group(2) @binding(7) var<storage, read_write> jetMask: array<atomic<u32>>;' : ''}
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
const V2_PLIVE: u32 = ${a.plive}u;
const V2_NEAR: u32 = ${a.near}u;
const V2_PLIST: u32 = ${a.plist}u;
const V2_JETS: u32 = ${a.jets}u;
const V2_COL_AWAKE: u32 = ${a.colAwake}u;
const V2_SUMMARY: u32 = ${a.summary}u;
const V2_ELEC_COUNT: u32 = ${a.elecCount}u;
const V2_ELEC_FLAG: u32 = ${a.elecFlag}u;
const V2_ELEC_LIST: u32 = ${a.elecList}u;
const V2_ELEC_SCRATCH: u32 = ${a.elecScratch}u;
// a brick summary's codes: all closed (solid, powder or gas), all air, all one liquid full and still
const SUM_CLOSED: u32 = ${SUMMARY.CLOSED}u;
const SUM_AIR: u32 = ${SUMMARY.AIR}u;
const SUM_LIQUID: u32 = ${SUMMARY.LIQUID}u;
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
const G_TICK: f32 = ${G_TICK};
const FULLU: u32 = ${FULL}u;
const FULLF: f32 = ${f(FULL)};
// a face lane at most (columns.js COLUMN.Q_MAX: under f16's 65,504), for writers of lanes outside the column passes
const Q_MAX: f32 = ${f(COLUMN.Q_MAX)};
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
  ${NOTE_UNSEEN}
  let b = brickOfCell(p);
  atomicStore(&act2[V2_VISIBLE + b], 1u);
  atomicStore(&act2[V2_LEGACY + b], 1u);
}
// Every write that can change a cell's core goes through here (the air source
// caches what it derives from a brick's cells until it or a face neighbour is noted).
fn noteState(s: u32) { atomicStore(&act2[V2_STATE_DIRTY + s / 64u], 1u); atomicStore(&act2[V2_SUMMARY + s / 64u], 0u); }
// Every store of a nonzero material request: whole-grid request scans visit noted bricks only.
fn noteEvents(s: u32, request: u32) { if (request != 0u) { atomicStore(&act2[V2_EVENTS + s / 64u], 1u); } }
// Every write of a brick's air outside the air tick's source and substeps.
fn noteAir(b: u32) { atomicStore(&act2[V2_AIR_LIVE + b], 1u); }${family === 'liquid' ? `${brickGroupWGSL(g)}
// Every mark of a cell to launch (columns.js colMarkJet, colMarkCrown): its brick's jets word and its
// group's (v2ActLayout jetGroups), which the jets' count reads instead of the bricks' words.
fn noteJet(b: u32) { atomicStore(&act2[V2_JETS + b], 1u); atomicStore(&act2[V2_JET_GROUPS + b / BRICK_GROUP], 1u); }` : ''}
// The particle pool's live bits (v2ActLayout plive): every spawn notes its slot; a retirement may clear it.
fn noteLive(slot: u32) { atomicOr(&act2[V2_PLIVE + (slot >> 5u)], 1u << (slot & 31u)); }
fn noteDead(slot: u32) { atomicAnd(&act2[V2_PLIVE + (slot >> 5u)], ~(1u << (slot & 31u))); }
fn slotLive(slot: u32) -> bool { return (atomicLoad(&act2[V2_PLIVE + (slot >> 5u)]) & (1u << (slot & 31u))) != 0u; }
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
fn jitterOf(id: u32) -> f32 { return e0(id).z; }
fn densOfE(id: u32) -> f32 { return e0(id).w; }
fn yieldOf(id: u32) -> f32 { return e1(id).x; }
fn dampOf(id: u32) -> f32 { return e1(id).y; }
fn fadeOf(id: u32) -> f32 { return e1(id).z; }
fn driftOf(id: u32) -> f32 { return e1(id).w; }
fn isLiq(c: vec4u) -> bool { return clsOf(c) == C_LIQUID; }
fn isOpenC(c: vec4u) -> bool { let k = clsOf(c); return k == C_AIR || k == C_LIQUID; }
fn fluidC(c: vec4u) -> bool { let k = clsOf(c); return k == C_AIR || k == C_GAS || k == C_LIQUID; }

// ---- activity ----
fn brickOfCell(p: vec3i) -> u32 { return brickId(p >> vec3u(2u)); }
fn markBusy(p: vec3i) { let q=mEdge(p); if (inGrid(q)) { atomicStore(&act2[P.busyOut + brickOfCell(q)], 1u); } }
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
    var n = importA(a);
    // V1's velocity along the pull, where it has one: a painted grain starts falling (passes.js: the brush gives
    // loose matter B.y = SPAWN_DROP_V), and a loaded one keeps its fall (react.js forces read B)
    let vy = fetchBs(s).y;
    if (clsOf(n) == C_POWDER && vy < 0.0) { n = setFall(n, min(-vy, ${f(PHYS.V_MAX)}) * ${V1_STEP_MS}, 0.0); }
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
// once. An awake brick (its run under QUIET_TICKS) is listed: the pass counts it on and lists it
// awake. An asleep brick still counting toward QUIET_CAP counts on here instead, with no claim and
// no pass: it stays asleep and its busy word is clear, and a near claim above starts its run over
// in the pass whatever it counted to here. After a load or a restore every brick counts for ~4 s;
// a claim each would contend on the list's one count (tools/v2/activity-list-check.mjs).
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
  let q = atomicLoad(&act2[V2_QUIET + b]);
  if (q < QUIET_TICKS) { actClaim(b, 2u); } else if (q < QUIET_CAP) { atomicStore(&act2[V2_QUIET + b], q + 1u); }
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
  // the column water's one-word test of it (columns.js colAwake); written only when it changes
  let flag = select(0u, 1u, any_);
  if (atomicLoad(&act2[V2_COL_AWAKE + col]) != flag) { atomicStore(&act2[V2_COL_AWAKE + col], flag); }
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
// A grain's landing (grainLands), V1's three outcomes of a hit on what is under it:
//   - BL-7: on a charge, its own odds of setting it off, by its fall (dynamics-reference.js v1GrainOddsTable: V1's
//     random stream, react.js shock), a roll a grain; its fall is the cells it had fallen before this tick (from rest,
//     on the powder law: GRAIN_FALLS) plus this tick's to its floor;
//   - BL-8: on a breakable solid, past V1's hardness (react.js breaking: ½·dens·u² ≥ hard, u its speed in V1's
//     cells/step to V_MAX), the solid becomes its debris, which takes the fracture work as heat (KE_TO_HEAT
//     cap·°C per unit of hardness, a declared source, as packets' fracture: particles.js);
//   - TH-10: on a solid it doesn't break, faster than COLLIDE_V, the kinetic energy it loses (½·dens·u²) becomes
//     heat shared by capacity, so both warm alike (move.js impactHeat: ΔT = E·KE_TO_HEAT/cap; the box's floor is a
//     wall cell, whose share leaves).
// In V1 a hit that sets a charge off neither breaks nor heats (move.js leaves it to the react pass).
const GRAIN_LANDINGS = SHOCK_LANDINGS.filter(r => ELEMENTS[r.faller].kind === K.POWDER).map(r => ({ ...r, odds: v1GrainOddsTable(r.faller, r.charge) }));
const GRAIN_FALLS = [...new Set(GRAIN_LANDINGS.map(r => r.faller))].map(id => {
  // (speed before a tick, cells fallen by then) from rest at the reference pull, to its terminal speed
  const seq = []; let core = setFall(new Uint32Array([id, 0, 0, 0]), 0, 0), cells = 0;
  for (let n = 0; n < 400; n++) {
    const u = fallVelocity(core); seq.push([Math.fround(u), cells]);
    const st = stepFall(core, FALL_GRAVITY); if (fallVelocity(st.core) === u) break; core = st.core; cells += st.cells;
  }
  return { id, seq };
});
// one legacy cap·°C in native energy units (particles.js dHeatEnergy: FULL·64·4)
const LEGACY_HEAT_UNIT = 256;
const grainLandWGSL = () => {
  let at = 0;
  const pairs = GRAIN_LANDINGS.map(r => { const o = { ...r, at }; at += r.odds.length; return o; });
  return /* wgsl */ `
const V1_GRAIN_ODDS = array<f32, ${Math.max(1, at)}>(${pairs.flatMap(r => r.odds.map(o => f(Math.fround(o)))).join(',') || '0.0'});
const V1_BREAK_INTO = array<i32, ${ELEMENTS.length}>(${ELEMENTS.map(e => (e.breakInto ? E[e.breakInto] : -1)).join(',')});
const V1_HARD = array<f32, ${ELEMENTS.length}>(${ELEMENTS.map(e => f(e.hard ?? 0)).join(',')});
const V1_CAP = array<f32, ${ELEMENTS.length}>(${ELEMENTS.map(e => f(e.cap ?? 0)).join(',')});
const V1_KE_TO_HEAT: f32 = ${f(PHYS.KE_TO_HEAT)};
const V1_COLLIDE_V: f32 = ${PHYS.COLLIDE_V};
// the cells a grain of id fell before a tick it starts at speed u (m/s), from rest on the powder law (GRAIN_FALLS)
fn grainFallen(id: u32, u: f32) -> i32 {
  var cells = 0;
${GRAIN_FALLS.map(g => `  if (id == ${g.id}u) {
    cells = ${g.seq.at(-1)[1]};
${g.seq.map(([u, c], n) => `    ${n ? 'else ' : ''}if (u <= ${f(u)} * 1.0001 + 0.000001) { cells = ${c}; }`).join('\n')}
  }`).join('\n')}
  return cells;
}
// V1's odds a grain of faller landing on charge after h cells sets it off (V1_GRAIN_ODDS; past its table, its last)
fn grainOdds(faller: u32, charge: u32, h: i32) -> f32 {
  var at = -1;
  var n = 0;
${pairs.map(r => `  if (faller == ${r.faller}u && charge == ${r.charge}u) { at = ${r.at}; n = ${r.odds.length}; }`).join('\n')}
  var odds = 0.0;
  if (at >= 0 && h >= 1) { odds = V1_GRAIN_ODDS[at + min(h, n) - 1]; }
  return odds;
}
fn grainHeat(heat: f32) -> vec2u { return energyMul(u32(round(heat * ${LEGACY_HEAT_UNIT}.0)), FULLU); }
// a grain (its core before the tick) landing at speed v (m/s) on the cell at q after a fall of h cells: the charge
// it sets off, the solid it breaks, or the heat it makes there; returns its own share of the heat (legacy cap·°C)
fn grainLands(q: vec3i, grain: vec4u, v: f32, h: i32) -> f32 {
  let faller = cid(grain);
  let u = min(v / V1_STEP_MS, V1_V_MAX);
  let ke = 0.5 * densOfE(faller) * u * u;
  var under = ${E.WALL}u;
  var hits = true;
  if (inGrid(q)) {
    let s = slotOf(q);
    let before = loadMaterial(s);
    under = cid(before.core);
    let odds = grainOdds(faller, under, h);
    var rs = seed3(q, P.tick, 83u);
    if (odds > 0.0 && rnd(&rs) < odds) { events[s] = events[s] | 1u; noteEvents(s, events[s]); markBusy(q); hits = false; }
    let into = V1_BREAK_INTO[under];
    if (hits && into >= 0 && ke >= V1_HARD[under]) {
      hits = false;
      let after = Material(setFall(vec4u((before.core.x & 0xffffff00u) | u32(into), before.core.y, before.core.z, before.core.w), 0.0, 0.0), before.bank);
      let warm = energyAdd(energyOf(before), grainHeat(V1_HARD[under] * V1_KE_TO_HEAT));
      if (energyFits(after, warm)) {
        storeMaterial(s, before, withEnergy(after, warm)); noteEnergySource(q, energySub(warm, energyOf(before))); markBusy(q);
      }
    }
    if (cls(under) != C_SOLID) { hits = false; }
    if (hits && u > V1_COLLIDE_V) {
      let heat = ke * V1_KE_TO_HEAT * V1_CAP[under] / max(V1_CAP[faller] + V1_CAP[under], 0.000001);
      let warm = energyAdd(energyOf(before), grainHeat(heat));
      if (energyFits(before, warm)) { storeMaterial(s, before, withEnergy(before, warm)); noteEnergySource(q, energySub(warm, energyOf(before))); }
    }
  }
  var mine = 0.0;
  if (hits && u > V1_COLLIDE_V) { mine = ke * V1_KE_TO_HEAT * V1_CAP[faller] / max(V1_CAP[faller] + V1_CAP[under], 0.000001); }
  return mine;
}
`;
};
// ---- R1b: V1's fast movers, past the block pass's reach. The block pass trades a pair at most once a paired tick
// (BLOCK_PACE: A + B cells a tick at chance 1, ~34 cells/s); V1 moves a cell whose drift through its medium is
// faster up to a cell a step (240 cells/s: uranium through water, hydrogen rising, fire and steam plumes, sand
// in water at 77). The column pass moves such a cell the rest of V1's rate, a column at a time: sinkers bottom up
// (a grain into a lighter liquid, a full liquid cell into a lighter full one, a gas into lighter gas or air), then
// risers top down (a buoyant gas into anything V1's canMove lets it rise into). The cells it passes shift one
// cell back, order kept, each with its bank, request and paint (the swaps' carry, shaders/move.js). Air rises by
// its warmth in the air field and the block pass, not here.
const colMoverWGSL = () => /* wgsl */ `
${blockExchangeWGSL}
const BLOCK_CAP: f32 = ${f(BLOCK_PACE.A + BLOCK_PACE.B)};
const V1_AIR_DENS_SPAN: f32 = ${f(PHYS.AIR_DENS_SPAN)};
const V1_AIR_DENS_LO: f32 = ${PHYS.AIR_DENS_LO};
const V1_AIR_DENS_HI: f32 = ${PHYS.AIR_DENS_HI};
// a gas's spawn temperature (°C), as the contact rows' ¼ K codes hold it (v2/contact.js contactDensity)
const V1_SPAWN_C = array<f32, ${ELEMENTS.length}>(${ELEMENTS.map(e => f(Math.round((e.temp + T_OFFSET) * 4) * 0.25 - T_OFFSET)).join(',')});
fn colTemp(c: vec4u) -> f32 { return f32(cTq(c)) * 0.25 - T_OFFSET; }
fn colAirDensity(t: f32) -> f32 { return 1.0 - clamp((t - P.ambient) / V1_AIR_DENS_SPAN, V1_AIR_DENS_LO, V1_AIR_DENS_HI); }
// V1 common.js densityOf (the block pass's motionDensity: v2/contact.js contactDensity)
fn colDensity(c: vec4u) -> f32 {
  let k = clsOf(c);
  var d = densOfE(cid(c));
  if (k == C_AIR) { d = colAirDensity(colTemp(c)); }
  if (k == C_GAS) { d = d * colAirDensity(colTemp(c)) / colAirDensity(V1_SPAWN_C[cid(c)]); }
  return d;
}
fn colGasLike(k: u32) -> bool { return k == C_AIR || k == C_GAS; }
// V1's share of steps mover m falls into n under it (0 where this pass doesn't move it)
fn colSinkP(m: vec4u, n: vec4u) -> f32 {
  let km = clsOf(m);
  let kn = clsOf(n);
  let g = v1Drift(cid(m), colTemp(m));
  if (g <= 0.0 || cid(m) == cid(n)) { return 0.0; }
  let dm = colDensity(m);
  let dn = colDensity(n);
  var p = 0.0;
  if (km == C_POWDER && kn == C_LIQUID && dm > dn) { p = g * v1DragF(km, kn, dm, dn); }
  if (km == C_LIQUID && kn == C_LIQUID && dm > dn && cFill(m) == FULLU && cFill(n) == FULLU) { p = g * v1DragF(km, kn, dm, dn); }
  if (km == C_GAS && colGasLike(kn) && dm > dn - V1_GAS_TOL) { p = g; }
  return min(p, V1_V_MAX);
}
// V1's share of steps a buoyant gas m rises into n over it (canMove up: within the gas tolerance, else any fluid
// or grain of another density; dragF is 1 beside a gas)
fn colRiseP(m: vec4u, n: vec4u) -> f32 {
  let kn = clsOf(n);
  let g = v1Drift(cid(m), colTemp(m));
  if (clsOf(m) != C_GAS || g >= 0.0 || kn == C_SOLID || cid(m) == cid(n)) { return 0.0; }
  let dm = colDensity(m);
  let dn = colDensity(n);
  if (colGasLike(kn) && !(dm < dn + V1_GAS_TOL)) { return 0.0; }
  if (!colGasLike(kn) && dm == dn) { return 0.0; }
  if (kn == C_LIQUID && cFill(n) != FULLU) { return 0.0; }
  return min(-g, V1_V_MAX);
}
// the cells a tick past the block pass's reach at V1's share p (gravity.js v1PaceRate, LEGACY_STEPS_PER_TICK steps)
fn colExcess(p: f32) -> f32 { return max(V1_STEPS * p / (2.0 - p) - BLOCK_CAP, 0.0); }
// whole cells of an excess this tick: its integer part and its fraction's chance
fn colCells(excess: f32, p: vec3i, salt: u32) -> i32 {
  var rs = seed3(p, P.tick, salt);
  return i32(floor(excess)) + select(0, 1, rnd(&rs) < fract(excess));
}
// The content of (x, fromY, z) moves to (x, toY, z); the cells between move one cell back toward it, order kept,
// each with its bank, request and paint; a moved air or liquid cell's face fluxes stay where they were (zeroQ)
fn colShift(x: i32, z: i32, fromY: i32, toY: i32) {
  let step = select(-1, 1, toY > fromY);
  let s0 = slotOf(vec3i(x, fromY, z));
  let mover = loadMaterial(s0);
  let moverEvents = events[s0];
  var moverDeco = 0u;
  if (P.deco != 0u) { moverDeco = decoOf(s0); }
  var y = fromY;
  for (var n = 0; n < NY && y != toY; n++) {
    let a = slotOf(vec3i(x, y, z));
    let b = slotOf(vec3i(x, y + step, z));
    let next = loadMaterial(b);
    storeMaterial(a, loadMaterial(a), Material(zeroQ(next.core), next.bank));
    events[a] = events[b]; noteEvents(a, events[a]);
    if (P.deco != 0u) { setDeco(a, select(decoOf(b), 0u, cid(next.core) == 0u)); }
    markBusy(vec3i(x, y, z));
    y += step;
  }
  let st = slotOf(vec3i(x, toY, z));
  storeMaterial(st, loadMaterial(st), Material(zeroQ(mover.core), mover.bank));
  events[st] = moverEvents; noteEvents(st, moverEvents);
  if (P.deco != 0u) { setDeco(st, moverDeco); }
  markBusy(vec3i(x, toY, z));
}
`;
export const v2ColumnWGSL = (g) => /* wgsl */ `
${v2Head(g, { state: false }, 'contact')}
${fallStepWGSL}
${colMoverWGSL()}
${grainLandWGSL()}
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
    // A brick summarised all air (each cell a continue) or all one still, full liquid (each a
    // floor) moves nothing here: skip its four cells. Support wrote the summary from the cells and
    // noteState clears it at any change since; other lanes' moves touch only their own cells.
    if ((y & 3) == 0) {
      let code = atomicLoad(&act2[V2_SUMMARY + brickOfCell(vec3i(x, y, z))]) & 255u;
      if (code == SUM_AIR) { y += 3; continue; }
      if (code == SUM_LIQUID) { fl = y + 4; runFalling = false; y += 3; continue; }
    }
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
    let fall = fallStep(c, gravity);
    let v = fall.x;
    if (v == 0.0) { fl = y + 1; runFalling = false; continue; }
    markBusy(p);
    var a = fall.y;
    let d = i32(floor(a));
    a = a - f32(d);
    var to = y - d;
    var velocity = v;
    var landHeat = 0.0;
    if (to <= fl) {
      // it lands on its floor at v (a falling run under it is no floor it hits): grainLands
      if (!runFalling) { landHeat = grainLands(vec3i(x, fl - 1, z), c, v, grainFallen(cid(c), fallVelocity(c)) + y - fl); }
      if (to < fl) {
        if (runFalling) { velocity = runVelocity; a = runFrac; } else { velocity = 0.0; a = 0.0; }
      }
      // on a solid (or the box's floor) it keeps its landing speed for this tick: the block pass scatters it (R2b)
      if (!runFalling && (fl == 0 || clsOf(loadCell(vec3i(x, fl - 1, z))) == C_SOLID)) { velocity = v; a = 0.0; }
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
      // the decoration rides with the content, as the bank does; air holds none (shaders/move.js)
      if (P.deco != 0u) { let d = decoOf(slotOf(p)); setDeco(slotOf(p), select(decoOf(slotOf(q)), 0u, cid(o) == 0u)); setDeco(slotOf(q), d); }
      storeMaterial(slotOf(q), destination, Material(c, source.bank));
      storeMaterial(slotOf(p), source, Material(o, destination.bank));
      markBusy(q);
    } else {
      storeCell(p, c);
    }
    if (landHeat > 0.0) {
      // (its share of its landing's heat, where it rests: TH-10)
      let r = vec3i(x, to, z);
      let m = loadMaterial(slotOf(r));
      let warm = energyAdd(energyOf(m), grainHeat(landHeat));
      if (energyFits(m, warm)) { storeMaterial(slotOf(r), m, withEnergy(m, warm)); noteEnergySource(r, energySub(warm, energyOf(m))); }
    }
    fl = to + 1;
    runFalling = velocity != 0.0;
    runVelocity = velocity;
    runFrac = a;
  }
  // R1b sinkers, bottom up (colMoverWGSL): a brick all air or all one still liquid holds none
  for (var y = 1; y < NY; y++) {
    if ((y & 3) == 0) {
      let code = atomicLoad(&act2[V2_SUMMARY + brickOfCell(vec3i(x, y, z))]) & 255u;
      if (code == SUM_AIR || code == SUM_LIQUID) { y += 3; continue; }
    }
    let m = loadCell(vec3i(x, y, z));
    let km = clsOf(m);
    if (km != C_POWDER && km != C_LIQUID && km != C_GAS) { continue; }
    let excess = colExcess(colSinkP(m, loadCell(vec3i(x, y - 1, z))));
    if (excess <= 0.0) { continue; }
    let n = colCells(excess, vec3i(x, y, z), 81u);
    var to = y;
    for (var j = 1; j <= n && to == y - j + 1 && y - j >= 0; j++) {
      if (colSinkP(m, loadCell(vec3i(x, y - j, z))) > 0.0) { to = y - j; }
    }
    if (to != y) { colShift(x, z, y, to); }
  }
  // R1b risers, top down
  for (var y = NY - 2; y >= 0; y--) {
    if ((y & 3) == 3) {
      let code = atomicLoad(&act2[V2_SUMMARY + brickOfCell(vec3i(x, y, z))]) & 255u;
      if (code == SUM_AIR || code == SUM_LIQUID) { y -= 3; continue; }
    }
    let m = loadCell(vec3i(x, y, z));
    if (clsOf(m) != C_GAS) { continue; }
    let excess = colExcess(colRiseP(m, loadCell(vec3i(x, y + 1, z))));
    if (excess <= 0.0) { continue; }
    let n = colCells(excess, vec3i(x, y, z), 82u);
    var to = y;
    for (var j = 1; j <= n && to == y + j - 1 && y + j < NY; j++) {
      if (colRiseP(m, loadCell(vec3i(x, y + j, z))) > 0.0) { to = y + j; }
    }
    if (to != y) { colShift(x, z, y, to); }
  }
}
`;

// Open faces alone are sinks for gas. The retained empty carrier owns its energy; only removed material
// enthalpy/bank enters the existing exact ledger. Liquids leave through the column passes' open edges
// (columns.js colEdges, colDrain), into the same ledger.
export const v2BoundaryWGSL = (g) => /* wgsl */ `
${v2Head(g, { state: false }, 'contact')}
${MAIN} {
  if (P.edge!=1u) { return; }
  let e=foldId(wg,nwg); if (e>=useAwake()) { return; }
  let s=atomicLoad(&act2[V2_LIST+e])*64u+li; let p=cellOf(s);
  let before=loadMaterial(s); let c=before.core; let k=clsOf(c);
  if (k!=C_GAS) { return; }
  if ((events[s]&1u)!=0u) { return; }
  var drive=0.0;
  for (var a=0;a<3;a++) { for (var side=-1;side<=1;side+=2) {
    if (!inGrid(p+axisV(a)*side)) { drive+=0.25; }
  } }
  if (drive<=0.0) { return; } markBusy(p);
  let carrier=makeMaterial(0u,f32(cTq(c))*0.25-273.25,0u,0u);
  let after=carrier; let amount=FULLU;
  if (drive<1.0) { var rng=seed3(p,P.tick,971u); if (rnd(&rng)>=drive) { return; } }
  noteBoundaryMass(amount); noteEnergySink(p,energySub(energyOf(before),energyOf(after)));
  setDeco(s,0u); // the air a gas leaves holds no decoration (shaders/move.js)
  storeMaterial(s,before,after); if (cid(after.core)==0u) { events[s]=0u; }
}
`;

// ---- support: a workgroup an awake brick; the solid-or-powder bit of each of its cells (the block
// pass reads the cells under a block from this snapshot, never from a block another thread is moving)
export const v2SupportWGSL = (g) => /* wgsl */ `
${v2Head(g, { state: false }, 'contact')}
${outsideFacesWGSL}var<workgroup> wgN: u32;
var<workgroup> occW: array<atomic<u32>, 2>;
var<workgroup> wgFirst: u32;
var<workgroup> wgMixed: atomic<u32>;
${MAIN} {
  let e = foldId(wg, nwg);
  if (li == 0u) { wgN = useAwake(); }
  if (e >= workgroupUniformLoad(&wgN)) { return; }
  let b = atomicLoad(&act2[V2_LIST + e]);
  let cell = cells[b * 64u + li];
  let kc = clsOf(cell);
  if (kc == C_SOLID || kc == C_POWDER) { atomicOr(&occW[li >> 5u], 1u << (li & 31u)); }
  // the brick's summary for the column water's scan: one code if every cell has it
  var code = SUM_CLOSED;
  if (kc == C_AIR) { code = SUM_AIR; }
  if (kc == C_LIQUID) {
    code = 0u;
    if (cFill(cell) == FULLU && cAge(cell) == 0u) { code = SUM_LIQUID | (cid(cell) << 8u) | (select(0u, ctypeOf(cell), cid(cell) == ${E.LAVA}u) << 16u); }
  }
  if (li == 0u) { wgFirst = code; }
  workgroupBarrier();
  if (code != wgFirst) { atomicStore(&wgMixed, 1u); }
  if (li < 2u) { atomicStore(&act2[V2_OCC + 2u * b + li], atomicLoad(&occW[li])); }
  workgroupBarrier();
  if (li == 0u) { atomicStore(&act2[V2_SUMMARY + b], select(wgFirst, 0u, atomicLoad(&wgMixed) != 0u)); }
  // Same cube SET as R5, including its one-cell halo outside the awake brick.
  // mBlockOffset only permutes corners, so no gravity-dependent ownership.
  let j=li/8u; let i=li%8u;
  let c0=brickCoord(b)*BS+P.offset+2*vec3i(i32(j&1u),i32((j>>1u)&1u),i32(j>>2u))-vec3i(1);
  let local=vec3i(i32(i&1u),i32(i>>2u),i32((i>>1u)&1u));
  let p=mEdge(c0+local);
  if (!inGrid(p)) { return; }
  var air=0u; var oxygen=0u; var co2=0u; var gas=0u; var clone=0u; var faces=0u;
  for(var axis=0;axis<3;axis++) {
    let sign=select(-1,1,local[axis]!=0);
    let q=mEdge(p+axisV(axis)*sign); let n=cellAt(q); let id=cid(n); let kind=clsOf(n);
    // the rest V1 react.js reads on all six faces (contact.js CT_OUT_*: surface, flames, air, cloud, dust, damp, moss site)
    faces=ctOutsideFace(faces,n,inGrid(q),u32(axis));
    // V1 react.js: a flame is burning air to a fuel (oxygen when it burns in it).
    if(id==${E.EMPTY}u || (id==${E.FIRE}u && ctypeOf(n)!=${E.OXYGEN}u)){air++;}
    if(id==${E.OXYGEN}u || (id==${E.FIRE}u && ctypeOf(n)==${E.OXYGEN}u)){oxygen++;}
    if(id==${E.CO2}u){co2++;}
    if(kind==C_AIR || kind==C_GAS){gas++;}
    // a clone with an element (or a powered one: V1 react.js cloneOf), for the clone rule's share (contact.js CT_CLONE_MISS_LOG)
    if((id==${E.CLONE}u || (id==${E.PCLN}u && payloadOf(n)==${ELEC.SWITCH_ON * lifeScale(E.PCLN)}u)) && ctypeOf(n)>0u){clone++;}
  }
  // Transient low bits only (the clone count in bits 8-9, as the low byte the runs' records rebuild
  // before any read); Limit fully overwrites active cells before jets
  // or gather. Sleeping faces are rejected before reading limiter bits.
  let s=slotOf(p);
  liquidScratch[s].x=(liquidScratch[s].x&0xfffffc00u)|air|(oxygen<<2u)|(co2<<4u)|(gas<<6u)|(clone<<8u);
  // The outside word in .y, whole: like the low bits above, no consumer reads .y between here and the block
  // pass, and the runs rebuild their records (and the radial demand words) from the cells after it.
  liquidScratch[s].y=faces;
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
  // Match the boundary wrapper's exact f32 round/clamp encoding. Air away from
  // ambient relaxes to it everywhere (V1's pull, ctAmbient), whatever the edge.
  if (rawTq != u32(clamp(round((P.ambient+273.25)*4.0),0.0,65535.0))) { zeroWork = false; }
  // V1 react.js moss creeps into air on a mossSite: an air cell whose outside faces (the support pass's word)
  // hold damp moss and a bed on different axes is not zero work (its partners are air: no site of theirs).
  if (zeroWork) { for (var k = 0u; k < blockCount; k++) { if (ctOutsideMossSite(ctOutsideAt(slotOf(positions[k])))) { zeroWork = false; } } }
  // AIR cannot topple, equal-density AIR cannot swap, AIR is not ageing gas.
  // Uniform normal AIR emits no contact/boundary heat, requests or ledgers;
  // equal storeMaterial values would only rewrite identical cells/banks.
  // Support still snapshots ALL targets, including AIR that may move later.
  if (zeroWork) { return; }
  `;

// ---- R3/R4: V1's exchange (move.js vertical and horizontal, on react.js forces and JITTER), a tick at a time.
// V1 trades a pair on a share p of the steps they share a block: p the larger of the upper cell's fall and the
// lower's rise, each where canMove lets it (common.js: a gas pair within GAS_DENS_TOL of each other's density,
// else the denser over the lighter; grains never into grains), times dragF (through a liquid, slower by its
// density contrast). A falling cell falls at its drift (v1DriftPerMS2: GRAV against DRAG, at P.gravity), which it
// keeps as it trades places; two exceptions: a liquid over gas falls free (react.js `flying`: no drag, to V_MAX),
// and a liquid over a lighter powder (the grains float up) starts from rest at every trade, which V1 runs at
// V1_FLOAT_CELLS_S (measured on the tiles' CPU port of move.js and react.js, src/ui/tiles/engine.js: sawdust and
// dust in water 4.2-4.3 cells/s, sawdust and sand in mercury 4.6-4.7, ash and sawdust in oil 6.7-6.8), a fall
// from rest's, so as the pull's square root. Below REST_V (physics.js: V1's creep that stops dead) nothing moves.
// V1's pairs share a block every other step (its partition shifts each step), so p moves a cell p/(2-p) a step
// (gravity.js v1PaceRate). V2's pairs share one on half the ticks in a shuffled order (physics.js offsetOf), which
// moves a cell PACE_A·c + PACE_B·c² a tick at a chance c (tools/v2/exchange-check.mjs replays offsetOf): the
// chance is the root that gives V1's rate, at most 1 (a cell at most a cell a tick, PACE_A + PACE_B).
export const V1_FLOAT_CELLS_S = 4.5;
export const BLOCK_PACE = { A: 0.52, B: 0.045 };
const v1FloatP = (() => { const r = V1_FLOAT_CELLS_S / (TICK_HZ * STEPS_PER_TICK); return 2 * r / (1 + r); })();
const blockExchangeWGSL = /* wgsl */ `
const V1_STEPS: f32 = ${f(STEPS_PER_TICK)};
const V1_STEP_MS: f32 = ${f(V1_STEP_MS)};
const V1_G_REF: f32 = ${f(GRAVITY_MS2)};
const V1_V_MAX: f32 = ${f(PHYS.V_MAX)};
const V1_REST_V: f32 = ${PHYS.REST_V};
const V1_FLOAT: f32 = ${v1FloatP};
const V1_KELVIN: f32 = ${PHYS.KELVIN};
const V1_GAS_TOL: f32 = ${PHYS.GAS_DENS_TOL};
const V1_DRAG_LIQUID_MIN: f32 = ${PHYS.DRAG_LIQUID_MIN};
const V1_DRAG_LIQUID_SPAN: f32 = ${PHYS.DRAG_LIQUID_SPAN};
const V1_DRAG_LIQUID_DENS: f32 = ${f(PHYS.DRAG_LIQUID_DENS)};
const V1_AIR_BUOY_LO: f32 = ${PHYS.AIR_BUOY_LO};
const V1_AIR_BUOY_HI: f32 = ${f(PHYS.AIR_BUOY_HI)};
const PACE_A: f32 = ${BLOCK_PACE.A};
const PACE_B: f32 = ${BLOCK_PACE.B};
// V1's drift (cells/step, + down) of a cell of id at temperature t (°C): react.js forces, air and cloud by heat (lift)
fn v1Drift(id: u32, t: f32) -> f32 {
  var grav = 1.0;
  if (id == ${E.EMPTY}u || id == ${E.CLOUD}u) { grav = -clamp((t - P.ambient) / (P.ambient + V1_KELVIN), V1_AIR_BUOY_LO, V1_AIR_BUOY_HI); }
  return clamp(driftOf(id) * grav * P.gravity, -V1_V_MAX, V1_V_MAX);
}
// move.js dragF: moving through a liquid is slower than through air
fn v1DragF(kU: u32, kL: u32, dU: f32, dL: f32) -> f32 {
  let gasU = kU == C_AIR || kU == C_GAS;
  let gasL = kL == C_AIR || kL == C_GAS;
  var drag = 1.0;
  if ((kU == C_LIQUID && !gasL) || (kL == C_LIQUID && !gasU)) {
    drag = V1_DRAG_LIQUID_MIN + V1_DRAG_LIQUID_SPAN * clamp(V1_DRAG_LIQUID_DENS * abs(dU - dL) / max(dU, dL), 0.0, 1.0);
  }
  return drag;
}
// V1's share of steps an upper cell U and the lower L under it trade places (above), from classes, densities, drifts
fn v1Exchange(kU: u32, kL: u32, dU: f32, dL: f32, gU: f32, gL: f32) -> f32 {
  let gasU = kU == C_AIR || kU == C_GAS;
  let gasL = kL == C_AIR || kL == C_GAS;
  var p = 0.0;
  if (gasU && gasL) {
    if (gU > 0.0 && dU > dL - V1_GAS_TOL) { p = gU; }
    if (gL < 0.0 && dL < dU + V1_GAS_TOL) { p = max(p, -gL); }
  } else if (kU != C_POWDER || kL != C_POWDER) {
    var fall = gU;
    if (kU == C_LIQUID && gasL) { fall = V1_V_MAX; }
    if (kU == C_LIQUID && kL == C_POWDER) { fall = V1_FLOAT * sqrt(max(P.gravity, 0.0) / V1_G_REF); }
    if (fall > 0.0 && dU > dL) { p = fall; }
    if (gL < 0.0 && dL != dU) { p = max(p, -gL); }
    p = min(p * v1DragF(kU, kL, dU, dL), V1_V_MAX);
  }
  return select(p, 0.0, p < V1_REST_V);
}
// the chance a tick that moves a pair at V1's rate for its share of steps p (above)
fn v2Chance(p: f32) -> f32 {
  let rate = V1_STEPS * p / (2.0 - p);
  return min(1.0, (sqrt(PACE_A * PACE_A + 4.0 * PACE_B * rate) - PACE_A) / (2.0 * PACE_B));
}
`;
// V1's landing scatter (move.js land, react.js friction and drag): a grain landing at u cells/step goes sideways at
// LAND_POWDER_SCATTER·u, which each step's friction and drag keep r = (1 - FRICTION)(1 - DRAG) of, moving on a share
// of about half its speed's steps (gravity.js v1PaceRate): u·SCATTER/(2(1 - r)) cells in all.
export const v1ScatterPerSpeed = e => (e.kind === K.POWDER ? PHYS.LAND_POWDER_SCATTER / (2 * (1 - (1 - (e.friction ?? 0)) * (1 - (e.drag ?? 0)))) : 0);
const blockScatterWGSL = `const V1_SCATTER = array<f32, ${ELEMENTS.length}>(${ELEMENTS.map(e => f(Math.fround(v1ScatterPerSpeed(e)))).join(',')});`;
export const v2BlockWGSL = (g, contactWGSL = '', compact = false) => {
  // Only exact production contact has the disjoint/frozen-read identity proof.
  compact = compact && contactWGSL === productionContactWGSL;
  const tail = compact ? v2BlockCompactLayout(g) : null;
  return /* wgsl */ `
${v2Head(g, { state: false }, 'contact')}
${contactWGSL}
${/\bfn\s+ctMergeRequest\s*\(/.test(contactWGSL) ? '' : requestMergeWGSL}
${contactWGSL === productionContactWGSL && !compact ? `${outsideSiteWGSL}fn ctOutsideAt(s: u32) -> u32 { return liquidScratch[s].y; }` : ''}
fn motionDensity(c: vec4u) -> f32 {
  return ${/\bfn\s+contactDensity\s*\(/.test(contactWGSL) ? 'contactDensity(c)' : 'densOfE(cid(c))'};
}
// share of positions whose grains may topple diagonally (lean-sim MOORE 0.5: an octagon, not a square or diamond)
const MOORE_U: u32 = 0x80000000u;
// The renderer's flow field (v2/flow.js): a topple is a one-cell jump that leaves no fall speed, so it
// is written where the grain lands, in V1's units (cells per V1 step: the jump over the tick's
// LEGACY_STEPS_PER_TICK steps, as V1's move.js blendFlow takes a hop's displacement), with
// FLOW_TOPPLE_MARK in the slot's spare half: v2flow keeps it for this tick, then the grain's own motion.
@group(1) @binding(0) var<storage, read_write> flow: array<vec2u>;
const FLOW_TOPPLE_STEPS: f32 = ${Number(LEGACY_STEPS_PER_TICK).toFixed(6)};
const FLOW_TOPPLE_MARK: f32 = 1.0;
fn noteTopple(to: vec3i, top: u32, into: u32, down: vec3i) {
  let moveD = vec3f(mBlockOffset(off8(into), down) - mBlockOffset(off8(top), down)) / FLOW_TOPPLE_STEPS;
  flow[slotOf(to)] = vec2u(pack2x16float(moveD.xy), pack2x16float(vec2f(moveD.z, FLOW_TOPPLE_MARK)));
}
${blockExchangeWGSL}
${blockScatterWGSL}
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
  if (index >= liquidScratch[${tail.header / 16}u].y) { return; }
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
  // which of the block's cells each one's content came from (the decoration rides with it: shaders/move.js)
  var fromCell = array<u32, 8>(0u, 1u, 2u, 3u, 4u, 5u, 6u, 7u);
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
    let came = fromCell[pick]; fromCell[pick] = fromCell[ti]; fromCell[ti] = came;
    markBusy(positions[pick]);
    noteTopple(positions[pick], ti, pick, down);
  }
  // R2b: V1's landing scatter (move.js land): a grain landing on a solid keeps LAND_POWDER_SCATTER of its impact
  // speed sideways, which friction and drag then spend (V1_SCATTER: the cells it travels per V1 cell/step of landing
  // speed, on average). The column pass leaves such a grain its landing speed for the tick; this pass sees it where
  // it tops its block, over the solid in it (half the ticks: twice the chance), and moves it a cell sideways, x or z,
  // into a lighter fluid (canMove sideways), all within the block.
  for (var c = 0u; c < columnCount && gravityOn; c++) {
    let gr = cs[4u + c];
    if (clsOf(gr) != C_POWDER || clsOf(cs[c]) != C_SOLID || fromCell[4u + c] != 4u + c || !inGrid(positions[4u + c])) { continue; }
    let landed = fallVelocity(gr);
    if (landed <= 0.0) { continue; }
    let pTop = positions[4u + c];
    markBusy(pTop);
    var rs = seed3(pTop, P.tick, 84u);
    let side = 4u + (c ^ (1u + u32(rnd(&rs) * 2.0)));
    let t = cs[side];
    let chance = min(1.0, 2.0 * V1_SCATTER[cid(gr)] * min(landed / V1_STEP_MS, V1_V_MAX));
    if (rnd(&rs) < chance && inGrid(positions[side]) && fromCell[side] == side && fluidC(t) && motionDensity(t) < motionDensity(gr)) {
      cs[side] = setFall(gr, 0.0, 0.0);
      cs[4u + c] = zeroQ(t);
      let bank = bs[side]; bs[side] = bs[4u + c]; bs[4u + c] = bank;
      let request = pending[side]; pending[side] = pending[4u + c]; pending[4u + c] = request;
      let came = fromCell[side]; fromCell[side] = fromCell[4u + c]; fromCell[4u + c] = came;
      markBusy(positions[side]);
    }
  }
  // R3: V1's vertical exchange (blockExchangeWGSL): sinking, floating up, buoyant rise, and Brownian jitter
  // across gas pairs (react.js JITTER). A fall into air (and a grain's
  // into gas, while the column pass runs) is the column pass's, or the runs' flux.
  let columnFalls = P.gravMode != 2u && P.edge == 0u;
  for (var c = 0u; c < columnCount && gravityOn; c++) {
    let lo = cs[c];
    let hi = cs[4u + c];
    let kL = clsOf(lo);
    let kU = clsOf(hi);
    if (!inGrid(positions[c]) || !inGrid(positions[4u + c]) || kU == C_SOLID || kL == C_SOLID) { continue; }
    if ((kU == C_POWDER || kU == C_LIQUID) && kL == C_AIR) { continue; }
    if (kU == C_POWDER && kL == C_GAS && columnFalls) { continue; }
    if (cid(lo) == cid(hi) && cid(lo) != 0u) { continue; }   // (V1 canMove: never one element with itself)
    let dU = motionDensity(hi);
    let dL = motionDensity(lo);
    var chance = v2Chance(v1Exchange(kU, kL, dU, dL, v1Drift(cid(hi), f32(cTq(hi)) * 0.25 - T_OFFSET), v1Drift(cid(lo), f32(cTq(lo)) * 0.25 - T_OFFSET)));
    // (jitter: a random walk only between gases canMove lets past each other both ways, within its tolerance;
    // past it, V1's noise only rounds the drift off, E[(drift + noise)+] ≈ drift)
    if ((kU == C_GAS || kL == C_GAS) && kU != C_LIQUID && kU != C_POWDER && kL != C_LIQUID && kL != C_POWDER && abs(dU - dL) < V1_GAS_TOL) {
      chance = max(chance, max(jitterOf(cid(hi)), jitterOf(cid(lo))));
    }
    if (chance <= 0.0) { continue; }
    let pU = positions[4u + c];
    markBusy(pU);
    var rs = seed3(pU, P.tick, 78u);
    if (rnd(&rs) < chance) {
      cs[c] = resetMotionAge(zeroQ(hi));
      cs[4u + c] = resetMotionAge(zeroQ(lo));
      let bank = bs[c]; bs[c] = bs[4u + c]; bs[4u + c] = bank;
      let request = pending[c]; pending[c] = pending[4u + c]; pending[4u + c] = request;
      let came = fromCell[c]; fromCell[c] = fromCell[4u + c]; fromCell[4u + c] = came;
      markBusy(positions[c]);
    }
  }
  // R4a: V1's diagonal escape (move.js diagonal): a buoyant gas held under what it can't rise into slides up a
  // diagonal of its block where the cell beside it is fluid and the one above that takes it (canMove up)
  for (var c = 0u; c < columnCount && gravityOn; c++) {
    let gs = cs[c];
    if (clsOf(gs) != C_GAS || fromCell[c] != c || !inGrid(positions[c])) { continue; }
    let dG = motionDensity(gs);
    if (v1Drift(cid(gs), f32(cTq(gs)) * 0.25 - T_OFFSET) >= 0.0) { continue; }
    let above = cs[4u + c];
    let kA = clsOf(above);
    var held = kA == C_SOLID || !inGrid(positions[4u + c]) || cid(above) == cid(gs) || fromCell[4u + c] != 4u + c;
    if ((kA == C_AIR || kA == C_GAS) && !(dG < motionDensity(above) + V1_GAS_TOL)) { held = true; }
    if (!held) { continue; }
    var rs = seed3(positions[c], P.tick, 80u);
    let first = u32(rnd(&rs) * 3.0);
    var pick = 4u;
    for (var n = 0u; n < 3u; n++) {
      let c2 = c ^ (1u + (first + n) % 3u);
      let side = cs[c2];
      let t = cs[4u + c2];
      let kS = clsOf(side);
      let kT = clsOf(t);
      if (pick != 4u || !inGrid(positions[c2]) || !inGrid(positions[4u + c2]) || fromCell[4u + c2] != 4u + c2) { continue; }
      if (kS == C_SOLID || kS == C_POWDER || kT == C_SOLID || cid(t) == cid(gs)) { continue; }
      if ((kT == C_AIR || kT == C_GAS) && !(dG < motionDensity(t) + V1_GAS_TOL)) { continue; }
      if (kT != C_AIR && kT != C_GAS && dG == motionDensity(t)) { continue; }
      pick = c2;
    }
    if (pick == 4u) { continue; }
    let ti = 4u + pick;
    markBusy(positions[c]);
    let moved = cs[ti];
    cs[ti] = zeroQ(gs);
    cs[c] = resetMotionAge(zeroQ(moved));
    let bank = bs[c]; bs[c] = bs[ti]; bs[ti] = bank;
    let request = pending[c]; pending[c] = pending[ti]; pending[ti] = request;
    let came = fromCell[c]; fromCell[c] = fromCell[ti]; fromCell[ti] = came;
    markBusy(positions[ti]);
  }
  // R4b: V1's jitter mixes gases sideways with air and with each other, without end (react.js JITTER, move.js
  // horizontal: canMove lets any two gas-like cells trade sideways), at the faster of the pair's jitter chances
  for (var m = 0u; m < blockCount; m++) {
    var i0 = 0u;
    var i1 = 0u;
    if (m < 4u) { i0 = 2u * m; i1 = i0 + 1u; } else { i0 = (m - 4u) + ((m - 4u) & 2u); i1 = i0 + 2u; }
    if (!inGrid(positions[i0]) || !inGrid(positions[i1])) { continue; }
    let a0 = cs[i0];
    let a1 = cs[i1];
    let k0 = clsOf(a0);
    let k1 = clsOf(a1);
    if ((k0 != C_GAS && k0 != C_AIR) || (k1 != C_GAS && k1 != C_AIR) || cid(a0) == cid(a1)) { continue; }
    let chance = max(jitterOf(cid(a0)), jitterOf(cid(a1)));
    if (chance <= 0.0) { continue; }
    let p0 = positions[i0];
    markBusy(p0);
    var rs = seed3(p0, P.tick, 79u + m);
    if (rnd(&rs) < chance) {
      cs[i0] = zeroQ(a1);
      cs[i1] = zeroQ(a0);
      let bank = bs[i0]; bs[i0] = bs[i1]; bs[i1] = bank;
      let request = pending[i0]; pending[i0] = pending[i1]; pending[i1] = request;
      let came = fromCell[i0]; fromCell[i0] = fromCell[i1]; fromCell[i1] = came;
      markBusy(positions[i1]);
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
      // R5 faces past the void edge, the floor's too (V1 react.js VOID_AIR_A: every face beyond the grid);
      // never solid walls or loop seams (P.edge 1 only).
      let open=u32(p.x==0)+u32(p.x==NX-1)+u32(p.z==0)+u32(p.z==NZ-1)+u32(p.y==0)+u32(p.y==NY-1);
      if (open!=0u) {
        let m=contactBoundary(Material(cs[i],bs[i]),open,u32(clamp(round((P.ambient+273.25)*4.0),0.0,65535.0)),p);
        cs[i]=m.core; bs[i]=m.bank;
      }
    }
  }` : ''}
  // V1's move over a running block (shaders/move.js): every cell takes its content's source's paint,
  // all 8 read before any is written, and air (what a swap or a reaction left) holds none, nor does
  // matter a reaction made in air (V1's move left that cell 0 the step before its react pass ran)
  if (P.deco != 0u) {
    var dc: array<u32, 8>;
    for (var i = 0u; i < blockCount; i++) { if (inGrid(positions[i])) { dc[i] = decoOf(slotOf(positions[i])); } }
    for (var i = 0u; i < blockCount; i++) {
      if (!inGrid(positions[i])) { continue; }
      let d = select(dc[fromCell[i]], 0u, cid(cs[i]) == 0u || cid(orig[fromCell[i]]) == 0u || !inGrid(positions[fromCell[i]]));
      if (d != dc[i]) { setDeco(slotOf(positions[i]), d); }
    }
  }
  for (var i = 0u; i < blockCount; i++) {
    let p = positions[i];
    if (inGrid(p)) {
      let slot = slotOf(p);
      storeMaterial(slot, Material(orig[i], oldBanks[i]), Material(cs[i], bs[i]));
      events[slot] = ctMergeRequest(pending[i], requests[i]); noteEvents(slot, events[slot]);
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
${outsideSiteWGSL}// (the support pass's outside word: a slot's .y, in this kernel's word view)
fn ctOutsideAt(s: u32) -> u32 { return atomicLoad(&liquidScratch[4u * s + 1u]); }
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
  // classify's count: published to block (header .y) and restarted for the next tick's classify,
  // so no clear splits the tick's compute pass.
  let count = scratch[${tail.header / 4}u];
  scratch[${tail.header / 4 + 1}u] = count; scratch[${tail.header / 4}u] = 0u;
  let groups = (count + 63u) / 64u;
  let y = max(1u, (groups + 65534u) / 65535u);
  args[${ARGS2.COMPACT}u] = (groups + y - 1u) / y;
  args[${ARGS2.COMPACT + 1}u] = y;
  args[${ARGS2.COMPACT + 2}u] = 1u;
}
`;
};

// ---- column-run water (src/shaders/v2/columns.js): the runs pass and the pair stages
export const v2RunsWGSL = (g) => v2RunsKernel(v2Head(g, { state: false }, 'liquid'), MAIN);
export const v2PairsWGSL = (g) => v2PairsKernel(v2Head(g, { state: false }, 'liquid'), MAIN);

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
// A switch of projection (the edit's, then the World copy's, every frame of a stroke) converts only
// the stale bricks and those holding a cell the two projections show differently (LEGACY_WORD): in
// every other brick the two are the same, so its A/B hold the new one already.
export const v2BridgeWGSL = (g) => /* wgsl */ `
${v2Head(g, V2_STATE_OPTS)}
${bridgeWGSL}
const LEGACY_STALE: u32 = ${LEGACY_WORD.STALE}u;
const LEGACY_DIFFERS: u32 = ${LEGACY_WORD.DIFFERS}u;
const BRIDGE_ALL: u32 = ${BRIDGE.ALL}u;
const BRIDGE_FLIP: u32 = ${BRIDGE.FLIP}u;
// Whether this export (its scope: P.full, BRIDGE) converts the brick whose legacy word this is.
fn bridgeConverts(word: u32) -> bool {
  return P.full == BRIDGE_ALL || (word & LEGACY_STALE) != 0u || (P.full == BRIDGE_FLIP && (word & LEGACY_DIFFERS) != 0u);
}
// Converts cell s into the projection H.format names (3: the edit projection, else the drawn one);
// returns whether the two show it differently.
fn bridgeCell(s: u32) -> bool {
  let p = cellOf(s);
  let c = cells[s];
  let drawn = compactA(p, c);
  var edit = drawn;
  if (any(compactProbeCore(c) != c)) { edit = compactProbeA(p, c); }
  writeCell(p, fetchAs(s), fetchBs(s), fetchFs(s), select(drawn, edit, H.format == 3u), vec4f(0.0));
  return any(drawn != edit);
}
var<workgroup> wgConverts: u32;
var<workgroup> wgDiffers: atomic<u32>;
${MAIN} {
  let b = foldId(wg, nwg);
  if (b >= NBRICKS) { return; }
  if (li == 0u) { wgConverts = select(0u, 1u, bridgeConverts(atomicLoad(&act2[V2_LEGACY + b]))); }
  if (workgroupUniformLoad(&wgConverts) == 0u) { return; }
  if (bridgeCell(b * 64u + li)) { atomicOr(&wgDiffers, 1u); }
  workgroupBarrier();
  if (li == 0u) { atomicStore(&act2[V2_LEGACY + b], select(0u, LEGACY_DIFFERS, atomicLoad(&wgDiffers) != 0u)); }
}
`;

// ---------------------------------------------------------------- the kernels
const perBrick = (g) => fold(Math.ceil(gridDims(g).nbricks / 64));
const own = () => [LAYOUT.TABLES, 'EMPTY', V2_LAYOUT];
const withState = () => [LAYOUT.TABLES, V2_STATE_LAYOUT, V2_LAYOUT];
const material = () => [LAYOUT.TABLES, 'EMPTY', V2_MATERIAL_LAYOUT];
const liquid = () => [LAYOUT.TABLES, 'EMPTY', V2_LIQUID_LAYOUT];
const contact = () => [LAYOUT.TABLES, 'EMPTY', V2_CONTACT_LAYOUT];
// the block pass's group 1: the renderer's flow field (v2/flow.js FLOW_LAYOUT, gpu.layout 'V2_FLOW'), for topples
export const V2_BLOCK_FLOW_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }];
const block = () => [LAYOUT.TABLES, V2_BLOCK_FLOW_LAYOUT, V2_CONTACT_LAYOUT];
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
  { name: 'v2block', code: v2BlockWGSL, layouts: block, dispatch: perBrick },
  { name: 'v2runs', code: v2RunsWGSL, layouts: liquid, dispatch: perBrick },
  { name: 'v2pairs', code: v2PairsWGSL, layouts: liquid, dispatch: perBrick },
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
  if (!shared.includes(NOTE_UNSEEN)) throw new Error('nativeDynamicsHead: noteVisible has no early out to replace');
  shared = shared.replace(NOTE_UNSEEN, 'if (all(before == after)) { return; }');
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
${materialStorageWGSL.replace('@group(2) @binding(4)', '@group(0) @binding(1)')}
${decoStorageWGSL}`;
}

// CPU validators exercise the injection ABI, not just the empty default seam.
const CONTACT_ABI_PROBE = `fn contactBlock(cores: ptr<function, array<vec4u, 8>>, banksIn: ptr<function, array<i32, 8>>, positions: array<vec3i, 8>, requests: ptr<function, array<u32, 8>>) {
  let m = Material((*cores)[0], (*banksIn)[0]);
  let n = withEnergy(m, energyAdd(energyOf(m), energySigned(-1)));
  (*cores)[0] = n.core; (*banksIn)[0] = n.bank;
  if (inGrid(positions[0])) { markBusy(positions[0]); (*requests)[0] |= 1u; }
}`;
WGSL_CHECK.push({ name: 'v2contactABI', kind: 'compute', code: g => v2BlockWGSL(g, CONTACT_ABI_PROBE), layouts: block, dispatch: perBrick, tool: true });
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
  { name: 'v2blockCompact', kind: 'compute', code: g => v2BlockWGSL(g, productionContactWGSL, true), layouts: block, dispatch: perBrick, tool: true },
);

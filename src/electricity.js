// Electricity (docs/electricity.md): The Powder Toy's spark automaton, in 3D.
//
// A spark is not an element. It is a state of the conductor cell it is on,
// kept in that cell's ctype (state A's w = ctype + seed):
//   ctype = phase + SPARK_CYCLE · level
//   phase  SPARK_BORN when sparked, then one less per step: live while it is
//          above SPARK_REST (TPT's SPRK, SPARK_LIFE steps), then resting down
//          to 1 (TPT's conductor life after a spark: it can't be sparked
//          again, so the front moves on and doesn't bounce back), and ready at 0
//   level  while live, the spark's strength: what is left of a full spark
//          (SPARK_V) after the cells it crossed. 0 otherwise.
// So the conductor keeps its own physics (heat, melting, breaking, flowing)
// while it carries a spark, and its life stays free for latent heat (water)
// and fuel.
//
// The rules (react.js electric, mirrored in ui/tiles/engine.js), over the six
// face neighbours, one hop per step:
//   - A ready conductor next to a live one (or a battery, or a firing
//     temperature sensor) sparks, at the strongest neighbour's level less its
//     own crossing cost, SPARK_DROP / σ levels (σ: elements.js elec, S/m). A
//     metal costs nothing, saltwater one level a cell, fresh water a quarter
//     of a full spark: a spark reaches far through metal and saltwater and a
//     few cells into a pond. Nothing sparks at level 0.
//   - The levels a spark spends crossing a cell heat it (Joule heating, below).
//   - P- and N-type silicon (TPT PSCN, NSCN) conduct like any conductor, but
//     N never sparks P: a p-n junction, conducting from P to N only.
//   - A switch (TPT SWCH) takes and passes sparks only while on (life
//     SWITCH_ON). A live P beside it switches it on, a live N off; on and off
//     spread through touching switches. P and N control it rather than spark it,
//     and it doesn't spark them (or water) back.
//   - A powered clone (TPT PCLN) goes on and off as a switch does, and while
//     on copies what it holds (its ctype, as CLONE's) into the air beside it.
//   - A temperature sensor (TPT TSNS) fires (life 1) while a neighbour other
//     than air, a wire or another sensor is hotter than itself, and a firing
//     sensor sparks its conductors like a battery. It holds no heat of its own
//     (cond 0, as TPT's), so its temperature is the threshold you set with
//     the Heat and Cool tools.
import { ELEMENTS, E } from './elements.js';
import { accessorsWGSL } from './shaders/hostStruct.js';

const SPARK_REST_STEPS = 4;   // ELEC.SPARK_REST, named here so LAMP_HOLD can build on it
export const ELEC = {
  SPARK_LIFE: 4,         // steps a spark stays live (TPT SPRK's life)
  SPARK_REST: SPARK_REST_STEPS, // steps a conductor rests after one (TPT gives it life 4)
  // Levels in a full spark: what a battery, a sensor and the Spark tool give.
  // With SPARK_DROP, fresh water (σ = 0.05 S/m) costs a quarter of it per cell.
  SPARK_V: 400,
  // Crossing a cell of conductivity σ (S/m) costs SPARK_DROP / σ levels: the
  // voltage drop across it, ∝ its resistance ρ·L/A = 1/(σ·L) for a cube of
  // edge L. Fresh water 0.05 S/m → 100 (a spark reaches 3 cells into a pond),
  // seawater ~5 S/m → 1 (399 cells), steel ~7·10⁶ → 7·10⁻⁷ (never, in effect).
  // Fractions are spent at random: a cost of 0.3 is 1 level on 30% of hops.
  SPARK_DROP: 5,
  // Joule heating: the levels a spark spends crossing a cell become heat in
  // it, JOULE_PER_LEVEL cap·°C each. The power dissipated in a cell is ΔV²/R
  // = ΔV²·σ·L, and with ΔV = SPARK_DROP/σ that is ∝ 1/σ, ∝ the cost: so heat
  // ∝ the levels spent. A full spark spent in one cell warms water 0.8 °C;
  // metal, which spends nothing, stays cold however long it carries current.
  JOULE_PER_LEVEL: 0.002,
  // σ (S/m) at or above which a conductor is a wire (metals, doped silicon):
  // a temperature sensor ignores its wires, as TPT's ignores METL.
  WIRE_SIGMA: 1e3,
  SWITCH_ON: 10,         // a switch's (or powered clone's) life while on (TPT SWCH's); below it, it is turning off, one a step, to 0
  TSNS_FIRE: 1,          // a temperature sensor's life while firing (TPT TSNS's)
  // Steps a lamp stays lit after a spark leaves it: Minecraft's redstone lamp
  // goes dark 2 redstone ticks after its power. Long enough to bridge the
  // rest and the ready step before the next spark down a powered wire, so a
  // wired lamp shines steadily; short enough that cutting its wire puts it out.
  LAMP_HOLD: SPARK_REST_STEPS + 4,
};
// A conductor's phase when sparked, and the number of phases (ready = 0).
export const SPARK_BORN = ELEC.SPARK_LIFE + ELEC.SPARK_REST;
export const SPARK_CYCLE = SPARK_BORN + 1;
// A lamp touching a battery is on direct current: lit and still, its ctype
// LAMP_DC (phase 0, a level no spark leaves), so it never churns (a loaded
// world's lamps stay as generated: docs/structures.md, Stability). It passes
// no sparks on. Its battery gone, it runs down from LAMP_HOLD like any lamp.
const LAMP_DC_LEVEL = ELEC.LAMP_HOLD + 1;
export const LAMP_DC = LAMP_DC_LEVEL * SPARK_CYCLE;

// ---- per element (elements.js elec: electrical conductivity σ, S/m) ----
export const CONDUCTS = ELEMENTS.map((e) => e.elec > 0);
export const SPARK_COST = ELEMENTS.map((e) => (e.elec > 0 ? ELEC.SPARK_DROP / e.elec : 0));
export const WIRE = ELEMENTS.map((e) => e.elec >= ELEC.WIRE_SIGMA);

// ---- a cell's spark, from its ctype (the integer part of state A's w) ----
export const sparkPhase = (ctype) => ctype % SPARK_CYCLE;
export const sparkLevel = (ctype) => Math.floor(ctype / SPARK_CYCLE);
export const packSpark = (phase, level) => phase + SPARK_CYCLE * level;
// Is a cell of element id with ctype + seed w live (carrying a spark)?
export const isLive = (id, w) => CONDUCTS[id] && sparkPhase(Math.floor(w)) > ELEC.SPARK_REST;
// Its spark as a share of a full one: 0 when it isn't live, else (0, 1].
export const sparkOf = (id, w) => (isLive(id, w) ? sparkLevel(Math.floor(w)) / ELEC.SPARK_V : 0);
// Can a cell of element id with life `life` take a spark at all (a switch only while on)?
export const takesSpark = (id, life) => CONDUCTS[id] && (id !== E.SWITCH || life === ELEC.SWITCH_ON);
// May a live `from` spark a ready `to`? (P-N junction; switches)
export function conductsInto(from, to) {
  if (to === E.PSCN && from === E.NSCN) return false;   // reverse bias: N never sparks P
  if (to === E.SWITCH && (from === E.PSCN || from === E.NSCN)) return false;   // they switch it instead
  if (from === E.SWITCH && (to === E.PSCN || to === E.NSCN || to === E.WATER)) return false;
  return true;
}
// Does a temperature sensor read a neighbour of element j? Not air, wires or sensors.
export const tsnsSenses = (j) => j !== E.EMPTY && j !== E.TSNS && !WIRE[j];
// Elements switched on by P and off by N, with life SWITCH_ON while on (TPT's PROP_PTOGGLE family).
export const powered = (id) => id === E.SWITCH || id === E.PCLN;
// What a clone (CLONE, PCLN) takes as its ctype from a neighbour: not air, walls, clones or the silicon that powers them.
export const cloneable = (j) => j !== E.EMPTY && j !== E.WALL && j !== E.CLONE && j !== E.PCLN && j !== E.PSCN && j !== E.NSCN;

// Its table fields (the element tables' struct, shaders/common.js tablesWGSL;
// shaders/hostStruct.js): CONDUCTS(id), WIRE(id) and SPARK_COST(id) in WGSL.
// SPARK_COST at the 6 significant digits its GLSL literal had.
export const ELEC_FIELDS = [
  { name: 'sparkCost', type: 'f32', fn: 'SPARK_COST', get: (e) => +SPARK_COST[e.id].toPrecision(6) },
  { name: 'conducts', type: 'u32', fn: 'CONDUCTS', ret: 'bool', get: (e) => +CONDUCTS[e.id] },
  { name: 'wire', type: 'u32', fn: 'WIRE', ret: 'bool', get: (e) => +WIRE[e.id] },
];

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

// WGSL for the shared prelude (shaders/common.js; the name is the GLSL
// version's, docs/webgpu.md W2): the constants, the tests above, and
// sparkCell, the entry point for anything that sparks a cell from outside (the
// Spark tool, a lightning bolt). Needs eid() and the element tables.
export function electricityGLSL() {
  return /* wgsl */ `
const SPARK_LIFE: i32 = ${ELEC.SPARK_LIFE};
const SPARK_REST: i32 = ${ELEC.SPARK_REST};
const SPARK_BORN: i32 = ${SPARK_BORN};
const SPARK_CYCLE: i32 = ${SPARK_CYCLE};
const SPARK_V: i32 = ${ELEC.SPARK_V};
const JOULE_PER_LEVEL: f32 = ${f(ELEC.JOULE_PER_LEVEL)};
const SWITCH_ON: f32 = ${f(ELEC.SWITCH_ON)};
const TSNS_FIRE: f32 = ${f(ELEC.TSNS_FIRE)};
const LAMP_HOLD: i32 = ${ELEC.LAMP_HOLD};
const LAMP_DC_LEVEL: i32 = ${LAMP_DC_LEVEL};
${accessorsWGSL('TB.elem', ELEC_FIELDS)}
fn sparkPhase(ctype: f32) -> i32 { return i32(ctype) % SPARK_CYCLE; }
fn sparkLevel(ctype: f32) -> i32 { return i32(ctype) / SPARK_CYCLE; }
fn packSpark(phase: i32, level: i32) -> f32 { return f32(phase + SPARK_CYCLE * level); }
fn sparkLive(id: i32, ctype: f32) -> bool { return CONDUCTS(id) && sparkPhase(ctype) > SPARK_REST; }
// A cell's spark (state A a) as a share of a full one: 0 when it isn't live.
fn cellSpark(a: vec4f) -> f32 {
  let id = eid(a);
  let ct = floor(a.w);
  if (!sparkLive(id, ct)) { return 0.0; }
  return f32(sparkLevel(ct)) / f32(SPARK_V);
}
fn takesSpark(id: i32, life: f32) -> bool { return CONDUCTS(id) && (id != E_SWITCH || life == SWITCH_ON); }
fn conductsInto(from_: i32, to: i32) -> bool {
  if (to == E_PSCN && from_ == E_NSCN) { return false; }
  if (to == E_SWITCH && (from_ == E_PSCN || from_ == E_NSCN)) { return false; }
  if (from_ == E_SWITCH && (to == E_PSCN || to == E_NSCN || to == E_WATER)) { return false; }
  return true;
}
fn tsnsSenses(j: i32) -> bool { return j != E_EMPTY && j != E_TSNS && !WIRE(j); }
fn powered(id: i32) -> bool { return id == E_SWITCH || id == E_PCLN; }
fn cloneable(j: i32) -> bool { return j != E_EMPTY && j != E_WALL && j != E_CLONE && j != E_PCLN && j != E_PSCN && j != E_NSCN; }
// Spark cell state a (in place) with a full spark, if it conducts, can take a
// spark and is ready. For a writer (shaders/common.js editMain): call it on
// oA (the activity flags follow).
fn sparkCell(a: ptr<function, vec4f>) -> bool {
  let id = eid(*a);
  let ct = floor((*a).w);
  if (!takesSpark(id, (*a).z) || sparkPhase(ct) != 0) { return false; }
  (*a).w = packSpark(SPARK_BORN, SPARK_V) + fract((*a).w);
  return true;
}
// The rest test's electric half (shaders/common.js inertSelf): a conductor
// sparking or resting, a switch turning off and a firing sensor all change.
fn electricQuiet(id: i32, a: vec4f) -> bool {
  if (CONDUCTS(id) && sparkPhase(floor(a.w)) != 0) { return false; }
  if (id == E_LAMP && sparkLevel(floor(a.w)) > 0 && sparkLevel(floor(a.w)) != LAMP_DC_LEVEL) { return false; }   // a lamp's light running down
  if (powered(id) && a.z > 0.0 && a.z != SWITCH_ON) { return false; }
  if (id == E_TSNS && a.z > 0.0) { return false; }
  return true;
}
// ...and per face neighbour (j holding n; shaders/activity.js inertNear): a
// ready conductor by a battery sparks, an off switch by an on one turns on, a
// powered clone that is on copies into air (and one with nothing to copy yet
// takes what touches it), a sensor by something hotter fires. (A live
// neighbour isn't inert itself.)
fn electricQuietNear(id: i32, a: vec4f, j: i32, n: vec4f) -> bool {
  if (j == E_BATTERY && takesSpark(id, a.z) && sparkPhase(floor(a.w)) == 0 && !(id == E_LAMP && sparkLevel(floor(a.w)) == LAMP_DC_LEVEL)) { return false; }
  if (powered(id) && a.z == 0.0 && j == id && n.z >= SWITCH_ON) { return false; }
  if (id == E_PCLN && ((a.z == SWITCH_ON && j == E_EMPTY) || (a.w < 1.0 && cloneable(j)))) { return false; }
  if (id == E_TSNS && tsnsSenses(j) && n.y > a.y + MATTER_REST_T) { return false; }
  return true;
}
`;
}

// The react pass's step for one cell (shaders/react.js; ui/tiles/engine.js is
// its twin): id's temperature T, life and ctype, given its face neighbours'
// states A (na) and ids (nid), from the pass's input state. faces is the face
// count the loops run to (react's P.faces, the GLSL's uFaces: a runtime bound,
// so the loops stay loops, docs/webgpu.md D3); rs the cell's random stream.
export const electricReactGLSL = /* wgsl */ `
fn electric(id: i32, T: ptr<function, f32>, life: ptr<function, f32>, ctype: ptr<function, f32>,
            na: ptr<function, array<vec4f, 6>>, nid: ptr<function, array<i32, 6>>, faces: i32, rs: ptr<function, u32>) {
  let life0 = *life;
  if (powered(id)) {
    // TPT SWCH and PCLN: turning off counts down; on and off spread through
    // touching cells of the same element (off wins); a live P beside it
    // switches it on, a live N off
    if (*life > 0.0 && *life != SWITCH_ON) { *life -= 1.0; }
    var offNb = false;
    var onNb = false;
    var pOn = false;
    var nOff = false;
    for (var i = 0; i < faces; i++) {
      let j = (*nid)[i];
      if (j == id) {
        if ((*na)[i].z > 0.0 && (*na)[i].z < SWITCH_ON) { offNb = true; }
        if ((*na)[i].z >= SWITCH_ON) { onNb = true; }
      }
      if (sparkLive(j, floor((*na)[i].w))) { pOn = pOn || j == E_PSCN; nOff = nOff || j == E_NSCN; }
    }
    if (life0 == SWITCH_ON && offNb) { *life = SWITCH_ON - 1.0; }
    else if (life0 == 0.0 && onNb) { *life = SWITCH_ON; }
    if (pOn && life0 < SWITCH_ON) { *life = SWITCH_ON; }
    if (nOff) { *life = SWITCH_ON - 1.0; }
  } else if (id == E_TSNS) {
    var hot = false;
    for (var i = 0; i < faces; i++) { hot = hot || (tsnsSenses((*nid)[i]) && (*na)[i].y > *T + MATTER_REST_T); }
    *life = select(0.0, TSNS_FIRE, hot);
  }
  if (!CONDUCTS(id)) { return; }
  var ph = sparkPhase(*ctype);
  var lv = sparkLevel(*ctype);
  if (id == E_LAMP) {
    var dc = false;   // on a battery's direct current (LAMP_DC)
    for (var i = 0; i < faces; i++) { dc = dc || (*nid)[i] == E_BATTERY; }
    if (dc) { *ctype = packSpark(0, LAMP_DC_LEVEL); return; }
    if (lv == LAMP_DC_LEVEL) { lv = LAMP_HOLD; }   // its battery is gone: it runs down
  }
  if (ph > 0) {
    ph--;
    // the level only matters while live; a lamp keeps it as its light's hold (LAMP_HOLD)
    if (ph <= SPARK_REST) {
      if (id != E_LAMP) { lv = 0; } else if (ph == SPARK_REST) { lv = LAMP_HOLD; } else { lv = max(lv - 1, 0); }
    }
  } else if (takesSpark(id, life0)) {
    if (id == E_LAMP) { lv = max(lv - 1, 0); }
    var best = 0;   // the strongest spark offered
    for (var i = 0; i < faces; i++) {
      let j = (*nid)[i];
      if (j == E_BATTERY || (j == E_TSNS && (*na)[i].z >= TSNS_FIRE)) { best = SPARK_V; }
      else if (sparkLive(j, floor((*na)[i].w)) && conductsInto(j, id)) { best = max(best, sparkLevel(floor((*na)[i].w))); }
    }
    if (best > 0) {
      let c = SPARK_COST(id);
      let r = rnd(rs);   // drawn whatever fract(c) is, as the GLSL's ?: drew it
      let spent = min(i32(c) + select(0, 1, r < fract(c)), best);
      *T += f32(spent) * JOULE_PER_LEVEL / CAP(id);
      if (best > spent) { ph = SPARK_BORN; lv = best - spent; }
    }
  }
  *ctype = packSpark(ph, lv);
}
`;

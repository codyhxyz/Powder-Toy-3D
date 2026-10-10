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

export const ELEC = {
  SPARK_LIFE: 4,         // steps a spark stays live (TPT SPRK's life)
  SPARK_REST: 4,         // steps a conductor rests after one (TPT gives it life 4)
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
};
// A conductor's phase when sparked, and the number of phases (ready = 0).
export const SPARK_BORN = ELEC.SPARK_LIFE + ELEC.SPARK_REST;
export const SPARK_CYCLE = SPARK_BORN + 1;

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

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const boolArr = (name, a) => `const bool ${name}[NE] = bool[NE](${a.join(', ')});`;

// GLSL for the shared prelude (shaders/common.js): the constants, the tests
// above, and sparkCell, the entry point for anything that sparks a cell from
// outside (the Spark tool, a lightning bolt). Needs eid() and the element arrays.
export function electricityGLSL() {
  return /* glsl */ `
#define SPARK_LIFE ${ELEC.SPARK_LIFE}
#define SPARK_REST ${ELEC.SPARK_REST}
#define SPARK_BORN ${SPARK_BORN}
#define SPARK_CYCLE ${SPARK_CYCLE}
#define SPARK_V ${ELEC.SPARK_V}
#define JOULE_PER_LEVEL ${f(ELEC.JOULE_PER_LEVEL)}
#define SWITCH_ON ${f(ELEC.SWITCH_ON)}
#define TSNS_FIRE ${f(ELEC.TSNS_FIRE)}
${boolArr('CONDUCTS', CONDUCTS)}
${boolArr('WIRE', WIRE)}
const float SPARK_COST[NE] = float[NE](${SPARK_COST.map((c) => f(+c.toPrecision(6))).join(', ')});
int sparkPhase(float ctype) { return int(ctype) % SPARK_CYCLE; }
int sparkLevel(float ctype) { return int(ctype) / SPARK_CYCLE; }
float packSpark(int phase, int level) { return float(phase + SPARK_CYCLE * level); }
bool sparkLive(int id, float ctype) { return CONDUCTS[id] && sparkPhase(ctype) > SPARK_REST; }
// A cell's spark (state A a) as a share of a full one: 0 when it isn't live.
float cellSpark(vec4 a) {
  int id = eid(a);
  float ct = floor(a.w);
  return sparkLive(id, ct) ? float(sparkLevel(ct)) / float(SPARK_V) : 0.0;
}
bool takesSpark(int id, float life) { return CONDUCTS[id] && (id != E_SWITCH || life == SWITCH_ON); }
bool conductsInto(int from, int to) {
  if (to == E_PSCN && from == E_NSCN) return false;
  if (to == E_SWITCH && (from == E_PSCN || from == E_NSCN)) return false;
  if (from == E_SWITCH && (to == E_PSCN || to == E_NSCN || to == E_WATER)) return false;
  return true;
}
bool tsnsSenses(int j) { return j != E_EMPTY && j != E_TSNS && !WIRE[j]; }
bool powered(int id) { return id == E_SWITCH || id == E_PCLN; }
bool cloneable(int j) { return j != E_EMPTY && j != E_WALL && j != E_CLONE && j != E_PCLN && j != E_PSCN && j != E_NSCN; }
// Spark cell state a (in place) with a full spark, if it conducts, can take a
// spark and is ready. For a pass that writes the state through copyThroughMain:
// call it on oA (the activity flags follow).
bool sparkCell(inout vec4 a) {
  int id = eid(a);
  float ct = floor(a.w);
  if (!takesSpark(id, a.z) || sparkPhase(ct) != 0) return false;
  a.w = packSpark(SPARK_BORN, SPARK_V) + fract(a.w);
  return true;
}
// The rest test's electric half (shaders/common.js inertSelf): a conductor
// sparking or resting, a switch turning off and a firing sensor all change.
bool electricQuiet(int id, vec4 a) {
  if (CONDUCTS[id] && sparkPhase(floor(a.w)) != 0) return false;
  if (powered(id) && a.z > 0.0 && a.z != SWITCH_ON) return false;
  if (id == E_TSNS && a.z > 0.0) return false;
  return true;
}
// ...and per face neighbour (j holding n; shaders/activity.js inertNear): a
// ready conductor by a battery sparks, an off switch by an on one turns on, a
// powered clone that is on copies into air (and one with nothing to copy yet
// takes what touches it), a sensor by something hotter fires. (A live
// neighbour isn't inert itself.)
bool electricQuietNear(int id, vec4 a, int j, vec4 n) {
  if (j == E_BATTERY && takesSpark(id, a.z) && sparkPhase(floor(a.w)) == 0) return false;
  if (powered(id) && a.z == 0.0 && j == id && n.z >= SWITCH_ON) return false;
  if (id == E_PCLN && ((a.z == SWITCH_ON && j == E_EMPTY) || (a.w < 1.0 && cloneable(j)))) return false;
  if (id == E_TSNS && tsnsSenses(j) && n.y > a.y + MATTER_REST_T) return false;
  return true;
}
`;
}

// The react pass's step for one cell (shaders/react.js; ui/tiles/engine.js is
// its twin): id's temperature T, life and ctype, given its face neighbours'
// states A (na) and ids (nid), from the pass's input state.
export const electricReactGLSL = /* glsl */ `
void electric(int id, inout float T, inout float life, inout float ctype, vec4 na[6], int nid[6], inout uint rs) {
  float life0 = life;
  if (powered(id)) {
    // TPT SWCH and PCLN: turning off counts down; on and off spread through
    // touching cells of the same element (off wins); a live P beside it
    // switches it on, a live N off
    if (life > 0.0 && life != SWITCH_ON) life -= 1.0;
    bool offNb = false, onNb = false, pOn = false, nOff = false;
    for (int i = 0; i < 6; i++) {
      int j = nid[i];
      if (j == id) {
        if (na[i].z > 0.0 && na[i].z < SWITCH_ON) offNb = true;
        if (na[i].z >= SWITCH_ON) onNb = true;
      }
      if (sparkLive(j, floor(na[i].w))) { pOn = pOn || j == E_PSCN; nOff = nOff || j == E_NSCN; }
    }
    if (life0 == SWITCH_ON && offNb) life = SWITCH_ON - 1.0;
    else if (life0 == 0.0 && onNb) life = SWITCH_ON;
    if (pOn && life0 < SWITCH_ON) life = SWITCH_ON;
    if (nOff) life = SWITCH_ON - 1.0;
  } else if (id == E_TSNS) {
    bool hot = false;
    for (int i = 0; i < 6; i++) hot = hot || (tsnsSenses(nid[i]) && na[i].y > T + MATTER_REST_T);
    life = hot ? TSNS_FIRE : 0.0;
  }
  if (!CONDUCTS[id]) return;
  int ph = sparkPhase(ctype), lv = sparkLevel(ctype);
  if (ph > 0) {
    ph--;
    if (ph <= SPARK_REST) lv = 0;   // the level only matters while live
  } else if (takesSpark(id, life0)) {
    int best = 0;   // the strongest spark offered
    for (int i = 0; i < 6; i++) {
      int j = nid[i];
      if (j == E_BATTERY || (j == E_TSNS && na[i].z >= TSNS_FIRE)) best = SPARK_V;
      else if (sparkLive(j, floor(na[i].w)) && conductsInto(j, id)) best = max(best, sparkLevel(floor(na[i].w)));
    }
    if (best > 0) {
      float c = SPARK_COST[id];
      int spent = min(int(c) + (rnd(rs) < fract(c) ? 1 : 0), best);
      T += float(spent) * JOULE_PER_LEVEL / CAP[id];
      if (best > spent) { ph = SPARK_BORN; lv = best - spent; }
    }
  }
  ctype = packSpark(ph, lv);
}
`;

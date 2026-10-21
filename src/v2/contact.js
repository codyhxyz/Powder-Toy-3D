// Native R5–R8/R11 contact rules. Content remains elements.js/electricity.js.
// A restricted scalar JS kernel is emitted as WGSL (shaders/v2/contact.js), so
// CPU tests exercise the same branches, not an independently drifting port.
import { ELEMENTS, E, K, REACTIONS, mechanisms } from '../elements.js';
import { SPARK_COST, WIRE, CONDUCTS, ELEC, SPARK_BORN, SPARK_CYCLE, LAMP_DC } from '../electricity.js';
import { PHYS, NOMINAL_STEP_RATE } from '../physics.js';
import { fallVelocity } from './fall.js';
import { CELL_M } from '../scale.js';
import { EMITTERS } from '../rays.js';
import { CEDAR_BASE } from '../appearance.js';
import { legacyPressureToPa } from './pressure.js';
import { EDGE } from '../simModes.js';
const EDGE_SOLID = EDGE.SOLID;

import { FUEL_Q } from './layout.js';
import { PHASE_ROWS, phaseTemperatureQ, phaseOffsetEnergy, phaseLatentEnergy, encodePhaseEnergy } from './phase.js';
const CONTACT_FULL = 65536;
export const CONTACT_ELEMENT_COUNT = ELEMENTS.length;
const LIFE_SCALE = FUEL_Q;
export const CONTACT_HZ = 60;
// Historical age constants remain for old fixtures; contacts use stored speed
// in cells/tick, never age times the currently configured gravity.
export const CONTACT_G_TICK = 19.6 / CELL_M / CONTACT_HZ ** 2;
export const DUST_MIN_FALL_SPEED = PHYS.DUST_LIFT_V * NOMINAL_STEP_RATE / CONTACT_HZ; // cells/tick
export const DUST_MIN_FALL_AGE = Math.ceil(PHYS.DUST_LIFT_V * NOMINAL_STEP_RATE / CONTACT_HZ / CONTACT_G_TICK);
const q = T => Math.round((T + 273.25) * 4);
const cap = ELEMENTS.map(e => Math.max(1, Math.round(e.cap * 64)));
const offsets = PHASE_ROWS.map(r => r.offset);
// V1's moss and fungus damp (physics.js DAMP_REACH, DAMP_DRY_T; shaders/activity.js
// dampOf): DAMP_REACH beside liquid water, else one less than the dampest
// grower beside it, 0 at or above DAMP_DRY_T. Cedar-leaf moss keeps its look
// and carries that damp as CEDAR_BASE + damp (appearance.js appearanceCtype).
export const CONTACT_DAMP_REACH = PHYS.DAMP_REACH;
export const CONTACT_DAMP_DRY_Q = q(PHYS.DAMP_DRY_T);
export const CONTACT_CEDAR_BASE = CEDAR_BASE;
// V1's dust cloud (physics.js DUST_MEC_NB, DUST_RICH_AIR; react.js "dust clouds"):
// the dust faces and air faces of six that a suspended dust cell needs.
export const CONTACT_DUST_MEC_NB = PHYS.DUST_MEC_NB;
export const CONTACT_DUST_RICH_AIR = PHYS.DUST_RICH_AIR;
// V1's temperature sensor fires on a neighbour hotter than it by more than
// MATTER_REST_T (electricity.js electric, TSNS), here in 1/4 K.
export const CONTACT_TSNS_MARGIN_Q = PHYS.MATTER_REST_T * 4;
// A request's puff: V1's pressure from gas set free (react.js puffP, Pr += ...),
// in Pa (pressure.js legacyPressureToPa), above the request's flag byte. It
// rides with the GAS request (2) and the air source adds it once.
export const CONTACT_PUFF_UNIT = 256;
// V1 clamps a cell's pressure at P_MAX (react.js clamp(Pr, P_MIN, P_MAX)).
export const CONTACT_PUFF_MAX_PA = Math.round(legacyPressureToPa(PHYS.P_MAX));
// Any puff at all moves at least one Pa: zero is the plain GAS request's default.
const puffPa = legacyP => legacyP > 0 ? Math.max(1, Math.round(legacyPressureToPa(Math.min(PHYS.P_MAX, legacyP)))) : 0;
// react.js puffP: puff volumes at ambient per volume, scaled from water flashing to steam.
const puffP = puff => PHYS.STEAM_BOIL_PUFF * puff / PHYS.STEAM_EXPANSION;

// V1's per-step rules (shaders/react.js, physics.js) on the contact clock. V1
// steps NOMINAL_STEP_RATE times a second, so one tick is STEPS_PER_TICK steps.
// A rule V1 reads on every face reaches one of a cell's three block partners on
// half the ticks: per partner and tick it is PARTNER_STEPS steps' worth (the
// reactions' `** 8` correction below).
const STEPS_PER_TICK = NOMINAL_STEP_RATE / CONTACT_HZ;
const PARTNER_STEPS = 2 * STEPS_PER_TICK;
// A per-step relaxation share r compounds to 1 - (1 - r)^STEPS_PER_TICK a tick.
const perTick = r => 1 - (1 - r) ** STEPS_PER_TICK;
// ln of the per-partner chance a per-step chance p does NOT fire in a tick, so
// n partners fire with 1 - exp(n·log). p ≥ 1 is certain: a log far under f32's.
const missLog = p => PARTNER_STEPS * Math.log(Math.max(1e-30, 1 - Math.min(1, p)));
const CONTACT_CAP_UNITS = 64;   // ctCapacity's units of a cap (CONTACT_ROWS capacity: cap·64)
const CONTACT_Q_PER_C = 4;      // the ¼ K temperature code
export const CT_ENERGY_PER_CAP_C = CONTACT_Q_PER_C * CONTACT_FULL * CONTACT_CAP_UNITS;
const JOULE_ENERGY = ELEC.JOULE_PER_LEVEL * CT_ENERGY_PER_CAP_C;
const JOULE_MILLI = 1000;
const ELEC_PENDING = 1 << 30;
const ELEC_LIFE_UNIT = 4096;    // above the 12-bit spark (unpackContact)
const ELEC_LIFE_MAX = 31;
const ELEC_SPENT_MAX = 511;
if (Math.abs(JOULE_ENERGY * JOULE_MILLI - Math.round(JOULE_ENERGY * JOULE_MILLI)) > 1e-6) throw Error('Joule energy is not a whole number of thousandths');
// V1's fuse countdown as V1 runs it (life in f32, as the GPU's and the tiles engine's Float32Array
// hold it): the step on which a lit cell's life first reaches FUSE_HANDOFF, and 0.
function fuseCountdown() {
  let life = Math.fround(1 - PHYS.FUSE_BURN), n = 1, handoff = 0;
  for (; life > 0; n++) {
    if (!handoff && life <= PHYS.FUSE_HANDOFF) handoff = n;
    life = Math.fround(life - Math.fround(PHYS.FUSE_BURN));
  }
  return { handoff: handoff || n, out: n };
}
const FUSE_STEPS = fuseCountdown();
const FUSE_UNLIT = 2048;   // ctLife's scale: V1's life 1
// FUSE_BURN · FUSE_UNLIT as an exact fraction: (1 - FUSE_HANDOFF) · FUSE_UNLIT / FUSE_STEPS_PER_CELL
const FUSE_HANDOFF_DEN = 100;
const FUSE_BURN_NUM = Math.round((1 - PHYS.FUSE_HANDOFF) * FUSE_HANDOFF_DEN) * FUSE_UNLIT;
const FUSE_BURN_DEN = FUSE_HANDOFF_DEN * PHYS.FUSE_STEPS_PER_CELL;
if (Math.abs(FUSE_BURN_NUM / FUSE_BURN_DEN - PHYS.FUSE_BURN * FUSE_UNLIT) > 1e-9 || FUSE_BURN_NUM <= FUSE_BURN_DEN) throw Error('fuse burn is not an exact fraction above a unit a step');
if (FUSE_STEPS.out * FUSE_BURN_NUM > 2147483647) throw Error('fuse countdown overflows i32');
if (ELEC.SPARK_V > ELEC_SPENT_MAX || SPARK_BORN + SPARK_CYCLE * ELEC.SPARK_V >= ELEC_LIFE_UNIT || ELEC.SWITCH_ON > ELEC_LIFE_MAX) throw Error('electric scratch word fields overflow');
// Named rule constants, shared verbatim by the scalar kernel and its WGSL
// (shaders/v2/contact.js emits each as a typed const).
export const CONTACT_CONSTANTS = Object.freeze({
  // the default scene's ambient (physics.js AMBIENT) for ctStep's standalone patch
  CT_AMBIENT_Q: ['i32', q(PHYS.AMBIENT)],
  CT_CODE_ZERO_C: ['f32', 273.25],   // the native ¼ K code's zero (q above)
  // V1 react.js: evaporating cloud cools its air by CLOUD_EVAP_COOL °C (¼ K codes)
  CT_CLOUD_EVAP_COOL_Q: ['i32', Math.round(PHYS.CLOUD_EVAP_COOL * 4)],
  // Magnus saturation (physics.js CT_MAGNUS_A/B), against the scene's ambient as V1's airT()
  CT_MAGNUS_A: ['f32', PHYS.MAGNUS_A],
  CT_MAGNUS_B: ['f32', PHYS.MAGNUS_B],
  // V1 react.js flames into air: FLAME_SPREAD per burning neighbour a step, into
  // oxygen O2_PER_AIR times as often, at flameT·(CT_FLAME_T_MIN + CT_FLAME_T_SPREAD·rnd) °C
  // (oxyFlameT in kelvin by CT_OXY_FLAME_GAIN, all oxygen).
  CT_FLAME_MISS_LOG: ['f32', missLog(PHYS.FLAME_SPREAD)],
  CT_OXY_FLAME_MISS_LOG: ['f32', missLog(PHYS.FLAME_SPREAD * PHYS.O2_PER_AIR)],
  CT_FLAME_T_MIN: ['f32', PHYS.FLAME_T_MIN],
  CT_FLAME_T_SPREAD: ['f32', PHYS.FLAME_T_SPREAD],
  CT_OXY_FLAME_GAIN: ['f32', PHYS.OXY_FLAME_GAIN],
  CT_KELVIN: ['f32', PHYS.KELVIN],
  // V1 react.js flame life: FIRE_LIFE_MIN + FIRE_LIFE_SPREAD·rnd at birth, less
  // FIRE_BURN + FIRE_BURN_SPREAD·rnd a step; smoke fades SMOKE_FADE a step.
  // In native life units (FUEL_Q per 1.0) and per tick.
  CT_FIRE_LIFE_MIN_Q: ['f32', PHYS.FIRE_LIFE_MIN * LIFE_SCALE],
  CT_FIRE_LIFE_SPREAD_Q: ['f32', PHYS.FIRE_LIFE_SPREAD * LIFE_SCALE],
  CT_FIRE_BURN_TICK: ['f32', PHYS.FIRE_BURN * STEPS_PER_TICK * LIFE_SCALE],
  CT_FIRE_BURN_SPREAD_TICK: ['f32', PHYS.FIRE_BURN_SPREAD * STEPS_PER_TICK * LIFE_SCALE],
  CT_SMOKE_FADE_TICK: ['f32', PHYS.SMOKE_FADE * STEPS_PER_TICK * LIFE_SCALE],
  CT_FIRE_TO_SMOKE: ['f32', PHYS.FIRE_TO_SMOKE],   // share of dying flames that leave smoke
  CT_FIRE_MIN_Q: ['i32', q(PHYS.FIRE_MIN_T)],      // flames cooler than FIRE_MIN_T go out
  CT_BURNT_MIN_Q: ['i32', q(PHYS.BURNT_MIN_T)],    // a burnt-out cell is at least this hot
  CT_ASH_SHARE: ['f32', PHYS.ASH_SHARE],
  // V1's spark automaton (electricity.js ELEC, electricReactGLSL electric), per
  // step: the electric pass (shaders/v2/electric.js) runs CT_ELEC_STEPS of them
  // a tick, so every number here is V1's own, never rescaled to the tick.
  CT_ELEC_STEPS: ['i32', STEPS_PER_TICK],
  CT_SPARK_REST: ['i32', ELEC.SPARK_REST],
  CT_SPARK_BORN: ['i32', SPARK_BORN],
  CT_SPARK_CYCLE: ['i32', SPARK_CYCLE],
  CT_SPARK_V: ['i32', ELEC.SPARK_V],
  CT_SWITCH_ON: ['f32', ELEC.SWITCH_ON],
  CT_TSNS_FIRE: ['f32', ELEC.TSNS_FIRE],
  CT_LAMP_HOLD: ['i32', ELEC.LAMP_HOLD],
  CT_LAMP_DC_LEVEL: ['i32', LAMP_DC / SPARK_CYCLE],
  // V1's Joule heat, JOULE_PER_LEVEL cap·°C a level spent, as native energy:
  // CT_ENERGY_PER_CAP_C a cap·°C (ctCapacity: 1/64 cap units of a full cell's
  // 65536, in ¼ K codes). It is not a whole number, so it is split into whole
  // energy and thousandths, and spent·JOULE is floored in exact integers (the
  // same on the CPU and in WGSL, where an f32 product would round).
  CT_JOULE_WHOLE: ['i32', Math.floor(JOULE_ENERGY)],
  CT_JOULE_MILLI: ['i32', Math.round((JOULE_ENERGY - Math.floor(JOULE_ENERGY)) * JOULE_MILLI)],
  CT_JOULE_MILLI_UNIT: ['i32', JOULE_MILLI],
  // The electric pass's scratch word for a cell whose state a step changes:
  // CT_ELEC_PENDING, the new spark (below CT_ELEC_LIFE_UNIT), a powered element's
  // or sensor's new life (V1 units, at most CT_ELEC_LIFE_MAX) and the levels the
  // step spent in it (at most SPARK_V, under CT_ELEC_SPENT_MAX).
  CT_ELEC_PENDING: ['i32', ELEC_PENDING],
  CT_ELEC_LIFE_UNIT: ['i32', ELEC_LIFE_UNIT],
  CT_ELEC_LIFE_MAX: ['i32', ELEC_LIFE_MAX],
  CT_ELEC_SPENT_UNIT: ['i32', ELEC_LIFE_UNIT * (ELEC_LIFE_MAX + 1)],
  CT_ELEC_SPENT_MAX: ['i32', ELEC_SPENT_MAX],
  // ctRoll's salt for a step's spark-cost draw (CT_ELEC_SALT + the step)
  CT_ELEC_SALT: ['i32', 40],
  // V1's safety fuse (react.js FUSE; physics.js FUSE_*), the pass's too: its front's speed is a
  // per-step rule on six faces. Its life in ctLife's 2048ths: CT_FUSE_UNLIT unlit (V1's 1); lit
  // n steps, CT_FUSE_UNLIT - floor(n·CT_FUSE_BURN_NUM / CT_FUSE_BURN_DEN) (V1's 1 - n·FUSE_BURN, in
  // exact integers), which is at most CT_FUSE_HANDOFF_Q from V1's handoff step on and 0 from its
  // burnout step on (both found by V1's own f32 countdown: fuseCountdown).
  CT_FUSE_UNLIT: ['i32', FUSE_UNLIT],
  CT_FUSE_BURN_NUM: ['i32', FUSE_BURN_NUM],
  CT_FUSE_BURN_DEN: ['i32', FUSE_BURN_DEN],
  CT_FUSE_HANDOFF_Q: ['i32', FUSE_UNLIT - Math.floor(FUSE_STEPS.handoff * FUSE_BURN_NUM / FUSE_BURN_DEN)],
  CT_FUSE_OUT_STEPS: ['i32', FUSE_STEPS.out],
  // V1: a flame beside it lights it at gunpowder's blast.flame a step; its end spits as hot as gunpowder burns
  CT_FUSE_FLAME_LIGHT: ['f32', ELEMENTS[E.GUNPOWDER].blast.flame],
  CT_FUSE_SPIT_Q: ['i32', q(ELEMENTS[E.GUNPOWDER].blast.T)],
  // a fuse's scratch word: its new life below CT_ELEC_LIFE_UNIT, and this bit when it is the end
  CT_FUSE_END: ['i32', ELEC_LIFE_UNIT],
  // V1 react.js clone: an empty cell beside a clone (or a powered clone, on) becomes its element with
  // chance CLONE_RATE a step, one draw a step however many clones touch it, so 1 - (1 - CLONE_RATE)^4
  // a tick. A clone face is a block partner half the ticks: when it is, the chance is the two ticks'
  // worth, 1 - (1 - CLONE_RATE)^PARTNER_STEPS, the reactions' correction (CONTACT_REACTIONS chance).
  CT_CLONE_CHANCE: ['f32', 1 - (1 - PHYS.CLONE_RATE) ** PARTNER_STEPS],
  // V1 react.js growers, each a chance per step per neighbour (rnd < RATE * n): water beside plant
  // becomes plant (PLANT_GROW), air on a mossSite beside damp moss becomes moss (MOSS_GROW), a fungus
  // food beside damp fungus rots to fungus (FUNGUS_GROW). Per present partner, PARTNER_STEPS steps'
  // worth compounded, as the flames' CT_FLAME_MISS_LOG: n partners fire with 1 - exp(n * missLog).
  CT_PLANT_MISS_LOG: ['f32', missLog(PHYS.PLANT_GROW)],
  CT_MOSS_MISS_LOG: ['f32', missLog(PHYS.MOSS_GROW)],
  CT_FUNGUS_MISS_LOG: ['f32', missLog(PHYS.FUNGUS_GROW)],
  // V1 react.js acid: what it eats dissolves with chance ACID_USE a step per acid neighbour; per
  // present partner pair, PARTNER_STEPS steps' worth compounded.
  CT_ACID_EAT: ['f32', 1 - (1 - PHYS.ACID_USE) ** PARTNER_STEPS],
  // V1 react.js cloud: it rains with chance CLOUD_RAIN a step per cloud neighbour past CLOUD_RAIN_NB,
  // and evaporates with CLOUD_EVAP a step per air neighbour past CLOUD_EVAP_NB (times its saturation).
  // Its own rule, run every tick on its six faces' counts as twice its three partners' (an unbiased
  // estimate), so a tick is STEPS_PER_TICK of V1's steps, compounded (ctPerTick).
  CT_CLOUD_RAIN: ['f32', PHYS.CLOUD_RAIN],
  CT_CLOUD_RAIN_NB: ['i32', PHYS.CLOUD_RAIN_NB],
  CT_CLOUD_EVAP: ['f32', PHYS.CLOUD_EVAP],
  CT_CLOUD_EVAP_NB: ['i32', PHYS.CLOUD_EVAP_NB],
  CT_STEPS_PER_TICK: ['i32', STEPS_PER_TICK],
});
for (const key of Object.keys(CONTACT_CONSTANTS)) if (key.slice(3) in E) throw Error(`contact constant ${key} shadows an element id`);
const { CT_AMBIENT_Q, CT_CODE_ZERO_C, CT_CLOUD_EVAP_COOL_Q, CT_MAGNUS_A, CT_MAGNUS_B, CT_FLAME_MISS_LOG, CT_OXY_FLAME_MISS_LOG, CT_FLAME_T_MIN, CT_FLAME_T_SPREAD,
  CT_OXY_FLAME_GAIN, CT_KELVIN, CT_FIRE_LIFE_MIN_Q, CT_FIRE_LIFE_SPREAD_Q, CT_FIRE_BURN_TICK, CT_FIRE_BURN_SPREAD_TICK, CT_SMOKE_FADE_TICK,
  CT_FIRE_TO_SMOKE, CT_FIRE_MIN_Q, CT_BURNT_MIN_Q, CT_ASH_SHARE, CT_SPARK_REST, CT_SPARK_BORN, CT_SPARK_CYCLE, CT_SPARK_V, CT_SWITCH_ON, CT_TSNS_FIRE,
  CT_LAMP_HOLD, CT_LAMP_DC_LEVEL, CT_JOULE_WHOLE, CT_JOULE_MILLI, CT_JOULE_MILLI_UNIT, CT_ELEC_PENDING, CT_ELEC_LIFE_UNIT, CT_ELEC_LIFE_MAX,
  CT_ELEC_SPENT_UNIT, CT_ELEC_SPENT_MAX, CT_ELEC_STEPS, CT_ELEC_SALT, CT_FUSE_UNLIT, CT_FUSE_BURN_NUM, CT_FUSE_BURN_DEN, CT_FUSE_HANDOFF_Q,
  CT_FUSE_OUT_STEPS, CT_FUSE_FLAME_LIGHT, CT_FUSE_SPIT_Q, CT_FUSE_END, CT_CLONE_CHANCE, CT_PLANT_MISS_LOG, CT_MOSS_MISS_LOG, CT_FUNGUS_MISS_LOG,
  CT_ACID_EAT, CT_CLOUD_RAIN, CT_CLOUD_RAIN_NB, CT_CLOUD_EVAP, CT_CLOUD_EVAP_NB, CT_STEPS_PER_TICK } = Object.fromEntries(Object.entries(CONTACT_CONSTANTS).map(([k, [, v]]) => [k, Math.fround(v)]));

const outSpecs = [];
function spec(into = 'FIRE') {
  const choices = typeof into === 'string' ? [[into, 1]] : into;
  const at = outSpecs.length, total = choices.reduce((n, [,weight]) => n + weight, 0);
  let sum = 0;
  for (const [key, weight] of choices) outSpecs.push({ id: key === 'SAME' ? -1 : E[key], limit: sum += weight / total });
  outSpecs[outSpecs.length - 1].limit = 1;
  return at;
}
export function validateContactMaterials(elements = ELEMENTS) {
  for (const e of elements) if (e.kind === K.LIQUID && (e.elec > 0 || e.conducts) && (e.burnRate > 0 || e.life > 0 || e.burn || e.fuel)) {
    throw Error(`${e.key}: conductive/fuel-life liquid payload conflict`);
  }
}
validateContactMaterials();
// V1 react.js phase puffs (Pr += ...), in Pa as a reaction's: water boiling to
// steam STEAM_BOIL_PUFF (its own branch), cloud boiling none (its branch adds
// nothing), and every table hot/cold change puffP(HOT/COLD.z) (elements.js
// hot/cold puff; mercury, dry ice, liquid nitrogen...). 0: no gas set free.
const phasePuffPa = t => t?.puff ? puffPa(puffP(t.puff)) : 0;
export const CONTACT_ROWS = ELEMENTS.map(e => {
  let hot = e.hot, cold = e.cold;
  if (e.key === 'WATER' || e.key === 'CLOUD') {
    // STEAM_EXPANSION volumes puff STEAM_BOIL_PUFF exactly (react.js puffP).
    hot = { T: 100, into: 'STEAM', latent: PHYS.L_BOIL, puff: e.key === 'WATER' ? PHYS.STEAM_EXPANSION : 0 };
    cold = { T: 0, into: e.key === 'CLOUD' ? 'SNOW' : 'ICE', latent: PHYS.L_FUSE };
  }
  if (e.key === 'ICE' || e.key === 'SNOW') hot = { T: 0, into: 'WATER', latent: PHYS.L_FUSE };
  if (e.key === 'STEAM') cold = { T: 100, into: 'WATER', latent: PHYS.L_BOIL };
  return {
    kind: e.kind, capacity: cap[e.id], offset: offsets[e.id], cond: e.cond,
    density: e.dens, spawnQ: q(e.temp), spawnLife: e.id === E.SINGULARITY ? Math.round(e.life * 256) : Math.min(65535, Math.round(e.life * LIFE_SCALE)),
    hotQ: hot ? q(hot.T) : 65536, hotOut: hot ? spec(hot.into) : -1,
    // hotGas: the hot change's puff (Pa, phasePuffPa), with its GAS request; 0 none.
    hotL: PHASE_ROWS[e.id].hotLatent, hotGas: phasePuffPa(hot), hotOf: E[hot?.of] ?? e.id,
    coldQ: cold ? q(cold.T) : -1, coldOut: cold ? spec(cold.into) : -1,
    coldL: PHASE_ROWS[e.id].coldLatent, coldOf: E[cold?.of] ?? e.id,
    meltQ: e.melt ? q(e.melt) : 65536, meltInto: E[e.meltInto] ?? e.id,
    igniteQ: e.ignite ? q(e.ignite) : 65536, flashQ: e.flash ? q(e.flash) : 65536,
    burn: Math.round(e.burnRate * LIFE_SCALE * 4), heat: Math.round(e.burnHeat * 256 * 4), flameQ: q(e.flameT),
    ash: +e.ash, blast: +!!e.blast, blastAir: +!!e.blast?.air, blastChance: 1 - (1 - (e.blast?.flame ?? 0)) ** 8,
    acid: +e.acid, edible: +(e.kind !== K.EMPTY && e.kind !== K.GAS && !e.acidProof),
    fizz: +(e.fizz > 0), bed: +e.mossBed, rots: +e.rots, singFood: +(e.id !== E.EMPTY && !e.singProof),
    // V1's spark cost at its table's 6 significant digits (electricity.js ELEC_FIELDS sparkCost)
    conductor: +CONDUCTS[e.id], cost: +SPARK_COST[e.id].toPrecision(6), wire: +WIRE[e.id],
    emitter: (EMITTERS[e.key] ?? 0) * 4,
    // V1 react.js explosives: lit, it becomes pickOut(INTO[PH_BLAST]) at blast.T
    // with blast.P on its cell. A blast whose product is matter (thermite's
    // LAVA of METAL) is that conversion and puff, not a charge for the blast pass.
    blastInto: e.blast?.into ? E[e.blast.into] : -1, blastOf: E[e.blast?.of] ?? 0,
    blastQ: e.blast ? q(e.blast.T) : 0, blastPuff: e.blast ? puffPa(e.blast.P) : 0,
    // V1 react.js: air relaxes to ambient by AIR_AMBIENT_PULL a step, gases by their rad
    cool: Math.fround(perTick(e.id === E.EMPTY ? PHYS.AIR_AMBIENT_PULL : e.rad)),
    // the cold change's puff (Pa) as hotGas (react.js puffP(COLD(id).z)); 0 none.
    coldGas: phasePuffPa(cold),
  };
});
export const CONTACT_PRODUCTS = outSpecs;
export const CONTACT_REACTIONS = REACTIONS.map(r => ({
  a: E[r.a], b: E[r.b] ?? -1, aOut: spec(r.into[0]), bOut: spec(r.into[1]),
  // Legacy probabilities per 240 Hz tick → hazard/second, corrected for a
  // face present half the 60 Hz ticks. Never multiply the heat by pairing.
  chance: 1 - (1 - (r.chance ?? 1)) ** 8, minQ: q(r.minT ?? -273.25), maxQ: q(r.maxT ?? 10000),
  heat: Math.round((r.heat ?? 0) * 256), gas: +(!!r.puff),
  // Hydrogen's adiabatic oxygen flame: existing elements.js reaction content.
  ceiling: q(r.a === 'HYDROGEN' ? (r.b === 'OXYGEN' ? 2800 : 2254) : 10000),
  // V1 react.js: each cell of the pair takes half the puff's pressure (rxP).
  puff: puffPa(0.5 * puffP(r.puff ?? 0)),
}));
const mech = mechanisms();
export const CONTACT_RX_INDEX = mech.lookup;

const ctI = value => Math.trunc(value) + 0;
export const ctF = Math.fround;
export const ctDiv = (a, b) => Math.trunc(a / b) + 0;
export const ctCopy = c => ({ ...c });
export const ctRow = id => CONTACT_ROWS[id];
export const ctProduct = (at, r) => {
  for (let i = at; i < CONTACT_PRODUCTS.length; i++) if (r < CONTACT_PRODUCTS[i].limit) return CONTACT_PRODUCTS[i].id;
  throw Error('invalid product spec');
};
export const ctRoll = (seed, salt) => {
  let h = (seed ^ Math.imul(salt, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16;
  return (h >>> 8) / 16777216;
};
export function ctNew(id, tq, fill) {
  const r = ctRow(id), life = r.kind === K.LIQUID ? Math.trunc(r.spawnLife * fill / 65536) : r.spawnLife;
  if (life > 65535) throw Error('contact fuel payload overflow');
  return { id, tq, raw: tq, fill, life, ctype: id === E.LAVA ? E.STONE : 0, spark: 0, age: 0, fallSpeed: 0, burning: 0, valid: 1, bank: 0, state: 0, request: 0, busy: 0, done: 0, pending: -1, pendingOf: 0, pendingGas: 0, source: 0n, sink: 0n };
}
export function ctFits(c, energy) {
  const phase = encodePhaseEnergy(c.id, ctAmount(c), energy);
  if (phase) return true;
  const en = energy - ctOffset(c), cp = BigInt(ctCapacity(c));
  const tq = en < 0n ? 0n : en / cp > 41093n ? 41093n : en / cp;
  const bank = en - tq * cp;
  return bank >= -2147483648n && bank <= 2147483647n;
}
export function ctInherit(input, original) {
  let c = ctCopy(input);
  c.source = original.source; c.sink = original.sink; c.request = original.request;
  c.busy = original.busy; c.done = original.done;
  if (ctRow(c.id).kind === 4 && ctRow(original.id).kind !== 4) c.request = c.request | 2;
  return c;
}
export function ctRecordChange(input, before) {
  let c = ctCopy(input);
  const after = ctEnergy(c);
  if (ctLess(before, after)) c.source = ctAdd(c.source, ctSub(after, before));
  else c.sink = ctAdd(c.sink, ctSub(before, after));
  return c;
}
export function ctDecay(input, id) {
  let c = ctInherit(ctNew(id, input.tq, 65536), input);
  // A fading gas removes material, not its persistent air carrier. The removed
  // enthalpy is a declared sink; retain actual T and the signed residual.
  c.bank = input.bank;
  c.busy = 1;
  return ctRecordChange(c, ctEnergy(input));
}
// V1 react.js: burnt out, a fuel leaves ash (CT_ASH_SHARE, if it leaves any) or a
// flame, at least BURNT_MIN_T hot (a declared source).
export function ctExhaust(input, seed) {
  let id = E.FIRE;
  if (ctRow(input.id).ash !== 0 && ctRoll(seed, 1) < CT_ASH_SHARE) id = E.ASH;
  let candidate = ctNew(id, input.tq, 65536);
  candidate.bank = input.bank;
  // A sub-cell fuel parcel cannot create a full-cell residue at the expense
  // of free heat. Below that mass/enthalpy budget it leaves carrier air.
  if (ctLess(ctEnergy(input), ctEnergy(candidate))) id = E.EMPTY;
  let out = ctDecay(input, id);
  if (id !== E.EMPTY && out.tq < CT_BURNT_MIN_Q) {
    const before = ctEnergy(out);
    const warm = ctAdd(ctMul(ctCapacity(out), CT_BURNT_MIN_Q), ctOffset(out));
    out = ctRecordChange(ctSetEnergy(out, warm), before);
  }
  if (id === E.FIRE) out.life = ctFlameLife(seed);
  out.request = out.request | 2;
  return out;
}
// V1 react.js: a new flame's life, FIRE_LIFE_MIN + FIRE_LIFE_SPREAD·rnd.
export function ctFlameLife(seed) { return ctI(CT_FIRE_LIFE_MIN_Q + CT_FIRE_LIFE_SPREAD_Q * ctRoll(seed, 20)); }
export function ctCreate(input, id, tq) {
  let c = ctInherit(ctNew(id, tq, 65536), input);
  c.busy = 1;
  return ctRecordChange(c, ctEnergy(input));
}


// Keep scalar kernel bodies within this deliberately small JS/WGSL subset:
// numeric locals, structs copied with ctCopy, fixed arrays, explicit casts and
// integer division. Checked Naga compilation rejects other syntax.
export function ctDensity(c) {
  const row = ctRow(c.id);
  if (row.kind === 0 || row.kind === 4) return row.density * ctF(row.spawnQ) / Math.max(4, ctF(c.tq));
  return row.density;
}
export function ctCapacity(c) { return 65536 + ctAmount(c) * ctRow(c.id).capacity; }
export function ctAmount(c) { if (c.id === E.EMPTY) return 0; if (ctRow(c.id).kind === 3) return c.fill; return 65536; }
export function ctOffset(c) { return phaseOffsetEnergy(c.id, ctAmount(c), c.ctype); }
export function ctEnergy(c) { return BigInt(ctCapacity(c)) * BigInt(c.tq) + ctOffset(c) + phaseLatentEnergy(c.id, c.raw, ctAmount(c)) + BigInt(c.bank); }
export const ctAdd = (a, b) => a + b;
export const ctSub = (a, b) => a - b;
export const ctSigned = n => BigInt(n);
export const ctMul = (a, b) => BigInt(a) * BigInt(b);
export const ctLess = (a, b) => a < b;
// An energy difference known to fit an i32 (|d| ≤ a heat step).
export const ctSmall = d => Number(d);
export function ctSetEnergy(input, energy) {
  const c = ctCopy(input), phase = encodePhaseEnergy(c.id, ctAmount(c), energy);
  if (phase) { c.raw = phase.raw; c.tq = phaseTemperatureQ(c.id, c.raw); c.bank = phase.bank; return c; }
  const sensible = energy - ctOffset(c), cp = BigInt(ctCapacity(c));
  c.tq = Math.max(0, Math.min(41093, Number(sensible / cp)));
  c.raw = c.tq; c.bank = Number(sensible - BigInt(c.tq) * cp);
  if (c.bank < -2147483648 || c.bank > 2147483647) throw Error(`unrepresentable contact energy: ${ELEMENTS[c.id].key}`);
  return c;
}
export function ctPastPhase(c, hot) {
  const r = ctRow(c.id), amount = ctAmount(c);
  const baseline = ctMul(ctCapacity(c), hot ? r.hotQ : r.coldQ) + ctOffset(c);
  const latent = ctMul(hot ? r.hotL : r.coldL, amount);
  return hot ? ctEnergy(c) >= baseline + latent : ctEnergy(c) <= baseline - latent;
}
export function ctHeat(input, gain) { return ctSetEnergy(input, ctAdd(ctEnergy(input), ctSigned(gain))); }
export function ctHeatTo(input, ceilingQ, amount) {
  const gain = Math.max(0, Math.min(ctI(Math.min(2147483000, Math.max(0, ctF(ctCapacity(input)) * ctF(ceilingQ - input.tq)))), amount));
  return ctHeat(input, gain);
}
export function ctConvert(input, id, of) {
  let amount = 65536;
  if (ctRow(id).kind === 3 && ctRow(input.id).kind === 3) amount = input.fill;
  let c = ctNew(id, input.tq, amount);
  c.ctype = 0;
  if (id === E.LAVA) c.ctype = of;
  c = ctInherit(c, input);
  if (!ctFits(c, ctEnergy(input))) {
    let wait = ctCopy(input); wait.pending = id; wait.pendingOf = of; wait.busy = 1; return wait;
  }
  c.busy = 1;
  return ctSetEnergy(c, ctEnergy(input));
}
export function ctTemperatureRemainder(c) {
  const cp = ctCapacity(c);
  // Only a sensible quantization remainder changes sub-quarter temperature.
  // A tagged latent bank is an isothermal reservoir, not extra sensible heat.
  if (c.raw > 41093 || c.bank < 0 || c.bank >= cp) return 0.0;
  return ctF(ctF(c.bank) / ctF(cp));
}
export function ctFlux(a, b) {
  const ra = ctRow(a.id);
  const rb = ctRow(b.id);
  if (ra.cond + rb.cond === 0) return 0;
  const dt = ctF(ctF(b.tq - a.tq) + ctTemperatureRemainder(b) - ctTemperatureRemainder(a));
  // Harmonic mean, 4 legacy steps/native tick and each face present 1/2
  // ticks. Sequential conservative pair exchange is stable at this limiter.
  const k = 2 * ra.cond * rb.cond / (ra.cond + rb.cond);
  const lim = ctI(Math.min(2147483000, Math.abs(dt) * ctF(Math.min(ctCapacity(a), ctCapacity(b))) / 6));
  const flux = ctI(Math.max(-2147483000, Math.min(2147483000, k * dt * 33554432)));
  return Math.max(-lim, Math.min(lim, flux));
}
// The branches only pick what the cell becomes; one ctConvert and one ctProduct call do it. Every
// call site is a copy of the helper once Metal inlines the contact rules into the block and
// airborne kernels, and a copy a branch made them slow to compile cold (docs/webgpu.md B5).
export function ctPhase(input, surface, random) {
  const empty = ctRow(input.id).kind === 3 && input.fill === 0;
  let c = input;
  if (!empty) c = ctSetEnergy(input, ctEnergy(input));
  const r = ctRow(c.id);
  let subject = c;
  let into = 0;
  let intoOf = 0;
  let convert = false;
  let cold = false;
  let product = -1;
  let gas = 0;
  // V1 react.js: a change that sets gas free puffs its own pressure on the cell
  // (the row's hotGas/coldGas, Pa): a GAS request carrying it (ctPuff), or, for a
  // change waiting on its partner's heat, pendingGas (ctResolvePhase).
  if (empty) { subject = input; into = E.EMPTY; convert = true; }
  else if (r.hotOut >= 0 && ctPastPhase(c, true)) { product = r.hotOut; intoOf = r.hotOf; gas = r.hotGas; convert = true; }
  else if (r.coldOut >= 0 && ctPastPhase(c, false)) { product = r.coldOut; intoOf = r.coldOf; gas = r.coldGas; cold = true; convert = true; }
  else if (c.tq > r.meltQ) { into = E.LAVA; intoOf = r.meltInto; convert = true; }
  else if (c.id === E.LAVA) {
    let of = c.ctype;
    if (of <= 0 || of >= CONTACT_ELEMENT_COUNT) of = E.STONE;
    if (c.tq < ctRow(of).meltQ - 600) { into = of; convert = true; }
  }
  if (!convert) return c;
  if (product >= 0) {
    into = ctProduct(product, random);
    if (cold && c.id === E.STEAM && surface === 0) into = E.CLOUD;
  }
  const next = ctConvert(subject, into, intoOf);
  if (gas !== 0) {
    if (next.id !== input.id) next.request = ctPuff(next.request, gas);
    else if (next.pending >= 0) next.pendingGas = gas;
  }
  return next;
}
export const ctLife = c => c.life / (c.id === E.SINGULARITY ? 256 : 2048);
export function ctWithLife(c, value) { return { ...c, life: Math.round(value * (c.id === E.SINGULARITY ? 256 : 2048)) }; }
export function ctNuclearId(c) {
  if (c.id === E.LAVA && c.ctype > 0 && c.ctype < CONTACT_ELEMENT_COUNT) return c.ctype;
  return c.id;
}
export function ctLive(c) { return ctRow(c.id).conductor !== 0 && c.spark % CT_SPARK_CYCLE > CT_SPARK_REST; }
export function ctConductsInto(from, to) {
  if (from === E.NSCN && to === E.PSCN) return false;
  if (to === E.SWITCH && (from === E.PSCN || from === E.NSCN)) return false;
  if (from === E.SWITCH && (to === E.PSCN || to === E.NSCN || to === E.WATER)) return false;
  return true;
}
export function ctCloneable(id) { return id !== E.EMPTY && id !== E.WALL && id !== E.CLONE && id !== E.PCLN && id !== E.PSCN && id !== E.NSCN; }
// What V1's electric step can change: a conductor's spark, a powered element's
// (switch, powered clone: electricity.js powered) or a sensor's life.
export function ctElecMaterial(id) { return ctRow(id).conductor !== 0 || id === E.SWITCH || id === E.PCLN || id === E.TSNS || id === E.FUSE; }
// A lit fuse's life n steps in, and the steps in a lit life (CONTACT_CONSTANTS CT_FUSE_*).
export function ctFuseLife(n) {
  if (n >= CT_FUSE_OUT_STEPS) return 0;
  return Math.max(1, CT_FUSE_UNLIT - ctDiv(n * CT_FUSE_BURN_NUM, CT_FUSE_BURN_DEN));
}
export function ctFuseSteps(life) { return ctDiv((CT_FUSE_UNLIT - life) * CT_FUSE_BURN_DEN + CT_FUSE_BURN_NUM - 1, CT_FUSE_BURN_NUM); }
// V1's fuse step (react.js FUSE): unlit, it lights at its ignition point, beside a fuse handing
// on its front or anything not gas at its ignition point, or at CT_FUSE_FLAME_LIGHT beside a
// flame; lit, it burns down a step, and it is the end while no fuse beside it burns longer.
export function ctFuseStep(c, ns, random) {
  const ignite = ctRow(c.id).igniteQ;
  let light = c.tq >= ignite;
  let fire = false;
  let end = true;
  for (let k = 0; k < 6; k++) {
    const b = ns[k];
    if (b.valid === 0) continue;
    const kind = ctRow(b.id).kind;
    fire = fire || b.id === E.FIRE;
    light = light || (b.id === E.FUSE && b.life <= CT_FUSE_HANDOFF_Q) || (kind !== 0 && kind !== 4 && b.tq >= ignite);
    end = end && !(b.id === E.FUSE && b.life > c.life);
  }
  if (c.life >= CT_FUSE_UNLIT) {
    if (fire && random < CT_FUSE_FLAME_LIGHT) light = true;
    if (!light) return 0;
    return CT_ELEC_PENDING + ctFuseLife(1);
  }
  let word = CT_ELEC_PENDING + ctFuseLife(ctFuseSteps(c.life) + 1);
  if (end) word = word + CT_FUSE_END;
  return word;
}
// One step of V1's spark automaton (electricity.js electricReactGLSL electric;
// react.js runs it every step on all six faces, ui/tiles/engine.js is its CPU
// twin), from the last step's states of the cell and its six face neighbours
// (valid 0: past the box, which V1 shows as air or wall: neither conducts nor
// is sensed). The electric pass (shaders/v2/electric.js) runs CT_ELEC_STEPS of
// these a tick. Returns 0 when the step changes nothing, else the scratch word
// (CT_ELEC_PENDING + spark + life + spent: CONTACT_CONSTANTS) ctElecApply writes.
export function ctElecStep(c, ns, random) {
  if (c.id === E.FUSE) return ctFuseStep(c, ns, random);
  const r = ctRow(c.id);
  const life0 = ctLife(c);
  let life = life0;
  let offNb = false;
  let onNb = false;
  let pOn = false;
  let nOff = false;
  let hot = false;
  let dc = false;
  let best = 0;
  for (let k = 0; k < 6; k++) {
    const b = ns[k];
    if (b.valid === 0) continue;
    // electricity.js powered: on and off spread through touching cells
    // with the same element (off wins), a live P switches on, a live N off
    if (b.id === c.id) { offNb = offNb || (ctLife(b) > 0 && ctLife(b) < CT_SWITCH_ON); onNb = onNb || ctLife(b) >= CT_SWITCH_ON; }
    if (ctLive(b)) { pOn = pOn || b.id === E.PSCN; nOff = nOff || b.id === E.NSCN; }
    // a sensor reads neighbours but air, wires and sensors (tsnsSenses), hotter by MATTER_REST_T
    hot = hot || (b.id !== E.EMPTY && b.id !== E.TSNS && ctRow(b.id).wire === 0 && ctF(b.tq - c.tq) + ctTemperatureRemainder(b) - ctTemperatureRemainder(c) > CONTACT_TSNS_MARGIN_Q);
    dc = dc || b.id === E.BATTERY;
    if (b.id === E.BATTERY || (b.id === E.TSNS && ctLife(b) >= CT_TSNS_FIRE)) best = CT_SPARK_V;
    else if (ctLive(b) && ctConductsInto(b.id, c.id)) best = Math.max(best, ctDiv(b.spark, CT_SPARK_CYCLE));
  }
  const switched = c.id === E.SWITCH || c.id === E.PCLN;
  if (switched) {
    if (life > 0 && life !== CT_SWITCH_ON) life = life - 1;
    if (life0 === CT_SWITCH_ON && offNb) life = CT_SWITCH_ON - 1;
    else if (life0 === 0 && onNb) life = CT_SWITCH_ON;
    if (pOn && life0 < CT_SWITCH_ON) life = CT_SWITCH_ON;
    if (nOff) life = CT_SWITCH_ON - 1;
  }
  if (c.id === E.TSNS) { life = 0; if (hot) life = CT_TSNS_FIRE; }
  let spark = c.spark;
  let spent = 0;
  if (r.conductor !== 0) {
    let ph = c.spark % CT_SPARK_CYCLE;
    let level = ctDiv(c.spark, CT_SPARK_CYCLE);
    if (c.id === E.LAMP && dc) {
      // on a battery's direct current: lit and still (LAMP_DC)
      ph = 0; level = CT_LAMP_DC_LEVEL;
    } else {
      if (c.id === E.LAMP && level === CT_LAMP_DC_LEVEL) level = CT_LAMP_HOLD;
      if (ph > 0) {
        ph--;
        // the level only matters while live; a lamp keeps it as its light's hold
        if (ph <= CT_SPARK_REST) {
          if (c.id !== E.LAMP) level = 0;
          else if (ph === CT_SPARK_REST) level = CT_LAMP_HOLD;
          else level = Math.max(0, level - 1);
        }
      } else if (c.id !== E.SWITCH || life0 === CT_SWITCH_ON) {
        if (c.id === E.LAMP) level = Math.max(0, level - 1);
        if (best > 0) {
          // the cost's fraction is spent at random (electricity.js SPARK_DROP)
          let cost = ctI(r.cost);
          if (random < r.cost - ctF(cost)) cost++;
          spent = Math.min(cost, best);
          if (best > spent) { ph = CT_SPARK_BORN; level = best - spent; }
        }
      }
    }
    spark = ph + CT_SPARK_CYCLE * level;
  }
  let lifeCode = 0;
  if (switched || c.id === E.TSNS) lifeCode = Math.max(0, Math.min(CT_ELEC_LIFE_MAX, ctI(life)));
  if (spark === c.spark && spent === 0 && (lifeCode === ctI(life0) || !(switched || c.id === E.TSNS))) return 0;
  return CT_ELEC_PENDING + spark + CT_ELEC_LIFE_UNIT * lifeCode + CT_ELEC_SPENT_UNIT * spent;
}
// A step's scratch word (ctElecStep) on its cell: the spark, the life, and the
// levels spent as V1's Joule heat (JOULE_PER_LEVEL cap·°C each), a declared
// source, as much of it as the cell can hold short of a phase edge (ctHeatRoom:
// the contact block converts it there next tick).
export function ctElecApply(input, word, seed) {
  let c = ctCopy(input);
  if (c.id === E.FUSE) return ctFuseApply(c, word, seed);
  const spark = word % CT_ELEC_LIFE_UNIT;
  const lifeCode = ctDiv(word, CT_ELEC_LIFE_UNIT) % (CT_ELEC_LIFE_MAX + 1);
  const spent = ctDiv(word, CT_ELEC_SPENT_UNIT) % (CT_ELEC_SPENT_MAX + 1);
  if (ctRow(c.id).conductor !== 0) c.spark = spark;
  if (c.id === E.SWITCH || c.id === E.PCLN || c.id === E.TSNS) c = ctWithLife(c, ctF(lifeCode));
  if (spent > 0) {
    const joule = ctHeatRoom(c, spent * CT_JOULE_WHOLE + ctDiv(spent * CT_JOULE_MILLI, CT_JOULE_MILLI_UNIT));
    c = ctHeat(c, joule);
    c.source = ctAdd(c.source, ctSigned(joule));
  }
  c.busy = 1;
  return c;
}

// A fuse's step: its life; at its end from the handoff on, gunpowder's heat (V1: T = max(T,
// BLAST(GUNPOWDER).T), a declared source); burnt out, smoke, or at its end a flame. A product
// that can't hold the fuse's energy yet (ctConvert's pending) waits for the next step.
export function ctFuseApply(input, word, seed) {
  let c = ctCopy(input);
  const life = word % CT_ELEC_LIFE_UNIT;
  const end = ctDiv(word, CT_FUSE_END) % 2 !== 0;
  c.life = life;
  c.busy = 1;
  if (end && life <= CT_FUSE_HANDOFF_Q && c.tq < CT_FUSE_SPIT_Q) {
    const before = ctEnergy(c);
    const spit = ctAdd(ctMul(ctCapacity(c), CT_FUSE_SPIT_Q), ctOffset(c));
    if (ctFits(c, spit)) c = ctRecordChange(ctSetEnergy(c, spit), before);
  }
  if (life === 0) {
    let id = E.SMOKE;
    if (end) id = E.FIRE;
    const out = ctConvert(c, id, 0);
    if (out.pending < 0) {
      c = out;
      if (id === E.FIRE) c.life = ctFlameLife(seed);
    }
  }
  return c;
}
// A flying packet's electricity (v2/airborne.js): V1's CT_ELEC_STEPS steps a tick, its host its
// one neighbour (ns: the host and five absent faces).
export function ctElecAirborne(input, ns, seed) {
  let c = ctCopy(input);
  if (!ctElecMaterial(c.id)) return c;
  for (let step = 0; step < CT_ELEC_STEPS; step++) {
    if (c.id !== input.id) return c;
    const word = ctElecStep(c, ns, ctRoll(seed, CT_ELEC_SALT + step));
    if (word !== 0) c = ctElecApply(c, word, seed);
  }
  return c;
}

// appearance.js physicalCtype for the growers: cedar-leaf moss holds its damp
// as CONTACT_CEDAR_BASE + damp; fungus and plain moss hold the damp itself.
export function ctGrowerDamp(id, ctype) {
  if (id === E.MOSS && ctype >= CONTACT_CEDAR_BASE && ctype <= CONTACT_CEDAR_BASE + CONTACT_DAMP_REACH) return ctype - CONTACT_CEDAR_BASE;
  return ctype;
}
// A GAS request with its puff (Pa), keeping the larger of two unconsumed puffs.
export function ctPuff(request, pressure) {
  const held = ctDiv(request, CONTACT_PUFF_UNIT);
  return (request - held * CONTACT_PUFF_UNIT) | 2 | (Math.max(held, pressure) * CONTACT_PUFF_UNIT);
}

// A per-step chance p of V1's, run on each of a tick's CT_STEPS_PER_TICK steps: the tick's chance.
export function ctPerTick(p) {
  let keep = 1.0;
  for (let step = 0; step < CT_STEPS_PER_TICK; step++) { keep = keep * (1.0 - p); }
  return 1.0 - keep;
}
export function ctStep(input, ns, seed) {
  return ctStepAtmosphere(input, ns, seed, 0, 0, 0, 0, 0, CT_AMBIENT_Q);
}

// Only atmosphere/exposure uses all six faces. Heat, reactions, phase and
// sampled contacts retain the three owned partners and their calibration.
// onFloor: the cell lies on the box's solid floor, which V1 react.js counts as a
// surface to condense onto (its sides and lid don't). ambientQ: the scene's
// ambient air (V1 airT()).
// V1 react.js nBurning: a fuel at its ignition point (explosives go off instead).
export function ctHotFuel(b) {
  const br = ctRow(b.id);
  return br.igniteQ < 65536 && br.blast === 0 && b.tq >= br.igniteQ;
}
// V1 react.js: CO2 at 30% of the gas around it puts flames out.
export function ctSmothered(co2, gas) { return co2 > 0 && ctF(co2) >= 0.3 * ctF(gas); }
// V1 react.js: flames lick out of anything burning into the air (or oxygen)
// beside it, on every face; oxygen catches O2_PER_AIR times as often, hotter.
// hotFuel: the burning fuels touching it (ctHotFuel), flameQ: their hottest flame.
export function ctLick(input, hotFuel, flameQ, smothered, seed) {
  let c = ctCopy(input);
  if ((c.id === E.EMPTY || c.id === E.OXYGEN) && hotFuel > 0 && !smothered) {
    c.busy = 1;
    let miss = CT_FLAME_MISS_LOG;
    if (c.id === E.OXYGEN) miss = CT_OXY_FLAME_MISS_LOG;
    if (ctRoll(seed, 18) < 1.0 - Math.exp(ctF(hotFuel) * miss)) {
      let flameC = ctF(flameQ) * 0.25 - CT_CODE_ZERO_C;
      if (c.id === E.OXYGEN) flameC = (flameC + CT_KELVIN) * CT_OXY_FLAME_GAIN - CT_KELVIN;
      const tq = Math.max(c.tq, ctI(Math.floor((flameC * (CT_FLAME_T_MIN + CT_FLAME_T_SPREAD * ctRoll(seed, 19)) + CT_CODE_ZERO_C) * 4.0 + 0.5)));
      let flame = ctCreate(c, E.FIRE, tq);
      // Air catching is not new gas: no puff (V1 burning's own BURN_P is the fuel's).
      flame.request = c.request;
      flame.life = ctFlameLife(seed);
      if (c.id === E.OXYGEN) flame.ctype = E.OXYGEN;
      return flame;
    }
  }
  return c;
}
export function ctStepAtmosphere(input, ns, seed, outAir, outOxygen, outCo2, outGas, onFloor, ambientQ) {
  let c = ctCopy(input);
  if (c.done !== 0) return c;
  let air = 0;
  let burnAir = 0;
  let oxygen = 0;
  let fire = 0;
  let flames = 0;
  let hotFuel = 0;
  let flashFuel = 0;
  let flameQ = 0;
  let flashFlameQ = 0;
  let gas = 0;
  let co2 = 0;
  let surface = 0;
  let cloud = 0;
  let plant = 0;
  let fungus = 0;
  let moss = 0;
  let bed = 0;
  let damp = 0;
  let dust = 0;
  let hotTouch = false;
  let hotFront = false;
  let clone = 0;
  let growOf = 0;
  let voidTouch = false;
  const r = ctRow(c.id);
  for (let k = 0; k < 3; k++) {
    const b = ns[k];
    if (b.valid === 0) continue;
    const br = ctRow(b.id);
    if (b.id === E.EMPTY) air++;
    if (b.id === E.OXYGEN || (b.id === E.FIRE && b.ctype === E.OXYGEN)) oxygen++;
    // V1 react.js: a flame is burning air to the fuel beside it (oxyShare,
    // and a fuel burns touching air, oxygen or fire), oxygen when it burns in it.
    if (b.id === E.EMPTY || (b.id === E.FIRE && b.ctype !== E.OXYGEN)) burnAir++;
    if (b.id === E.FIRE || (br.burn > 0 && b.burning !== 0)) fire++;
    if (b.id === E.FIRE) flames++;
    // V1 react.js nBurning: a fuel at its ignition point (explosives go off
    // instead), and past its flash point one whose vapour carries a flame.
    if (ctHotFuel(b)) { hotFuel++; flameQ = Math.max(flameQ, br.flameQ); }
    else if (br.flashQ < br.igniteQ && br.blast === 0 && b.tq >= br.flashQ) { flashFuel++; flashFlameQ = Math.max(flashFlameQ, br.flameQ); }
    // TPT FIRE.cpp separates contact ignition from bulk thermal transition
    // (upstream uses Flammable/1000). Our hot front uses existing igniteQ,
    // not a new rate; tq is decoded, post-pair/pre-self snapshot temperature.
    hotFront = hotFront || (b.done === 0 && b.pending < 0 && (b.request & 5) === 0 && b.tq >= r.igniteQ && b.life > 0 && ((b.id === E.FIRE && b.tq >= 2493) || (br.burn > 0 && b.burning !== 0)));
    if (br.kind === 0 || br.kind === 4) gas++;
    else surface++;
    if (b.id === E.CO2) co2++;
    if (b.id === E.CLOUD) cloud++;
    if (b.id === E.PLANT) plant++;
    if (b.id === E.FUNGUS && ctGrowerDamp(b.id, b.ctype) > 0) fungus++;
    if (b.id === E.MOSS && ctGrowerDamp(b.id, b.ctype) > 0) moss++;
    if (br.bed !== 0) bed++;
    // V1 dampOf: liquid water wets a grower (saltwater does not); a grower passes one less on.
    if (b.id === E.WATER) damp = CONTACT_DAMP_REACH;
    if (b.id === E.MOSS || b.id === E.FUNGUS) damp = Math.max(damp, ctGrowerDamp(b.id, b.ctype) - 1);
    if (b.id === E.DUST) dust++;
    hotTouch = hotTouch || (br.kind !== 0 && br.kind !== 4 && b.tq >= r.igniteQ);
    if (b.id === E.CLONE || (b.id === E.PCLN && ctLife(b) === 10)) clone = Math.max(clone, b.ctype);
    if (ctCloneable(b.id)) growOf = b.id;
    voidTouch = voidTouch || b.id === E.VOID;
  }
  // V1 react.js: past its flash point a fuel's vapour carries a flame along it,
  // so air touching a flame and such a fuel catches as if the fuel burned.
  if (flames > 0 && flashFuel > 0) { hotFuel = hotFuel + flashFuel; flameQ = Math.max(flameQ, flashFlameQ); }
  const fullAir = burnAir + outAir;
  const fullOxygen = oxygen + outOxygen;
  const fullCo2 = co2 + outCo2;
  const fullGas = gas + outGas;
  const smothered = ctSmothered(fullCo2, fullGas);
  const exposed = fullAir + fullOxygen > 0;
  const random = ctRoll(seed, 1);
  // Electricity is the electric pass's (shaders/v2/electric.js: V1's step, four a tick, six faces).
  c = ctPhase(c, surface + onFloor, ctRoll(seed, 3));
  if (c.id !== input.id || c.pending >= 0) return c;
  if (voidTouch && c.id !== E.EMPTY && r.kind !== 1) return ctDecay(c, E.EMPTY);
  const emitter = ctRow(ctNuclearId(c)).emitter;
  if (emitter > 0) { c.busy = 1; if (ctRoll(seed, 4) < emitter) c.request = c.request | 4; }
  if (r.blast !== 0) {
    const canBlast = r.blastAir === 0 || exposed || fire > 0;
    if (canBlast && (c.tq >= r.igniteQ || hotTouch || (fire > 0 && r.blastChance > 0))) {
      c.busy = 1;
      if (c.tq >= r.igniteQ || hotTouch || random < r.blastChance) {
        if (r.blastInto < 0) { c.request = c.request | 1; return c; }
        // V1: the product at blast.T, its ctype blast.of, and blast.P on the cell.
        let out = ctInherit(ctNew(r.blastInto, r.blastQ, 65536), c);
        out.ctype = r.blastOf;
        out.busy = 1;
        out = ctRecordChange(out, ctEnergy(c));
        out.request = ctPuff(out.request, r.blastPuff);
        return out;
      }
    }
    return c;
  }
  if (c.id === E.FIRE || c.id === E.SMOKE || c.id === E.PLASMA) {
    // V1 react.js lives (CONTACT_CONSTANTS); plasma keeps its native fade.
    let fade = 69.0;
    if (c.id === E.FIRE) fade = CT_FIRE_BURN_TICK + CT_FIRE_BURN_SPREAD_TICK * ctRoll(seed, 5);
    if (c.id === E.SMOKE) fade = CT_SMOKE_FADE_TICK;
    // Whole life units: the fraction is a draw, so the mean fade is exact.
    c.life = Math.max(0, c.life - ctI(Math.floor(fade + ctRoll(seed, 6))));
    c.busy = 1;
    // V1: a flame goes out spent, cooled under FIRE_MIN_T or smothered, and
    // leaves smoke CT_FIRE_TO_SMOKE of the time; it needs no air face (it is
    // burning gas: a fireball's core keeps burning).
    if (c.life === 0 || (c.id === E.FIRE && (smothered || c.tq < CT_FIRE_MIN_Q))) {
      let id = E.EMPTY;
      if (c.id === E.FIRE && ctRoll(seed, 7) < CT_FIRE_TO_SMOKE) id = E.SMOKE;
      return ctDecay(c, id);
    }
  }
  if (r.burn > 0 && c.id !== E.FUSE) {
    if (!exposed || smothered) c.burning = 0;
    else {
      const canLight = c.burning !== 0 || c.tq >= r.igniteQ || fire > 0;
      if (canLight) {
        c.busy = 1;
        // Noita/TPT flammability: 0.5/s per flame, at 60 Hz, face correction 2.
        if (c.burning !== 0 || c.tq >= r.igniteQ || (r.flashQ < r.igniteQ && c.tq >= r.flashQ && fire > 0) || (hotFront && (r.flashQ >= r.igniteQ || c.tq >= r.flashQ)) || random < ctF(fire) / 60) {
          c.burning = 1;
          if (c.life === 0) return ctExhaust(c, seed);
          let oxy = 1.0;
          if (fullAir + fullOxygen > 0) oxy = (ctF(fullAir) + 4.77327 * ctF(fullOxygen)) / ctF(fullAir + fullOxygen);
          const spend = Math.min(c.life, Math.max(1, ctI(ctF(r.burn) * oxy * ctF(ctAmount(c)) / 65536)));
          c.life = c.life - spend;
          const ceiling = ctI(ctF(r.flameQ) * (1 + 0.32 * ctF(fullOxygen) / ctF(Math.max(1, fullAir + fullOxygen))));
          const perFuel = ctDiv(r.heat * 65536, Math.max(1, r.burn));
          const gain = ctI(Math.min(2147483000, ctF(perFuel) * ctF(spend)));
          const beforeHeat = ctEnergy(c);
          c = ctHeatTo(c, ceiling, gain);
          c.source = ctAdd(c.source, ctSub(ctEnergy(c), beforeHeat));
          c.request = c.request | 2;
          if (c.life === 0) return ctExhaust(c, seed);
        }
      }
    }
  }
  // The fuse is the electric pass's (ctFuseStep: V1's step, four a tick, six faces).
  if (c.id === E.WATER && plant > 0) { c.busy = 1; if (random < 1.0 - Math.exp(ctF(plant) * CT_PLANT_MISS_LOG)) return ctCreate(c, E.PLANT, c.tq); }
  if (r.rots !== 0 && fungus > 0 && c.tq < CONTACT_DAMP_DRY_Q) { c.busy = 1; if (random < 1.0 - Math.exp(ctF(fungus) * CT_FUNGUS_MISS_LOG)) return ctCreate(c, E.FUNGUS, c.tq); }
  if (c.id === E.MOSS || c.id === E.FUNGUS) {
    const previous = c.ctype;
    let own = 0;
    if (c.tq < CONTACT_DAMP_DRY_Q) own = Math.max(0, damp);
    // appearance.js appearanceCtype: cedar-leaf moss keeps its look.
    if (ctGrowerDamp(c.id, previous) !== previous) own = own + CONTACT_CEDAR_BASE;
    c.ctype = own;
    if (c.ctype !== previous) c.busy = 1;
  }
  if ((c.id === E.CLONE || c.id === E.PCLN) && c.ctype === 0 && growOf > 0) { c.ctype = growOf; c.busy = 1; }
  const lit = ctLick(c, hotFuel, flameQ, smothered, seed);
  if (lit.id !== c.id) return lit;
  c = lit;
  if (c.id === E.EMPTY) {
    if (clone > 0 && clone < CONTACT_ELEMENT_COUNT) { c.busy = 1; if (random < CT_CLONE_CHANCE) return ctCreate(c, clone, ctRow(clone).spawnQ); }
    if (moss > 0 && bed > 0) { c.busy = 1; if (random < 1.0 - Math.exp(ctF(moss) * CT_MOSS_MISS_LOG)) return ctCreate(c, E.MOSS, c.tq); }
  }
  if (c.id === E.CLOUD) {
    if (cloud >= 2 || air >= 2) {
      c.busy = 1;
      if (cloud >= 2 && random < ctPerTick(CT_CLOUD_RAIN * ctF(cloud * 2 - CT_CLOUD_RAIN_NB))) return ctConvert(c, E.WATER, 0);
      const temp = ctF(c.tq) * 0.25 - CT_CODE_ZERO_C;
      const ambient = ctF(ambientQ) * 0.25 - CT_CODE_ZERO_C;
      const es = Math.exp(CT_MAGNUS_A * (temp / Math.max(1, temp + CT_MAGNUS_B) - ambient / Math.max(1, ambient + CT_MAGNUS_B)));
      if (air >= 2 && random < ctPerTick(CT_CLOUD_EVAP * ctF(air * 2 - CT_CLOUD_EVAP_NB) * es)) {
        // V1 react.js: the evaporating cell's air cools by CLOUD_EVAP_COOL (a declared sink).
        let gone = ctDecay(c, E.EMPTY);
        const before = ctEnergy(gone);
        gone = ctHeat(gone, -(ctCapacity(gone) * Math.min(CT_CLOUD_EVAP_COOL_Q, gone.tq)));
        return ctRecordChange(gone, before);
      }
    }
    // Use real stored speed: gravity changes must not rewrite contact inertia.
    for (let k = 0; k < 3; k++) {
      if (c.tq <= 1093 && ns[k].valid !== 0 && ns[k].id === E.SNOW && ns[k].fallSpeed > 0.0) {
        c.busy = 1;
        if (random < Math.min(ns[k].fallSpeed, 1.0 / 6.0)) c.ctype = Math.min(60, c.ctype + 1);
      }
    }
  }
  if (c.id === E.DUST && c.fallSpeed >= DUST_MIN_FALL_SPEED && dust >= CONTACT_DUST_MEC_NB && fullAir >= CONTACT_DUST_RICH_AIR && (c.tq >= r.igniteQ || hotTouch || fire > 0)) { c.request = c.request | 1; c.busy = 1; }
  if (c.id === E.SINGULARITY) {
    // Mass has 1/256 cell units; unlike normalized fuel it reaches 200 cells.
    c.busy = 1;
    if (c.life >= 51200) { c.request = c.request | 1; return c; }
    const mass = ctF(c.life) / 256;
    c.life = Math.max(0, c.life - Math.max(1, ctI(614.4 / Math.max(1, mass * mass))));
    if (c.life < 256 || c.life >= 51200) c.request = c.request | 1;
  }
  return c;
}

// Function signatures are part of the checked JS→WGSL kernel ABI.
export const CONTACT_KERNEL = [
  [ctInherit, ['CTCell', 'CTCell'], 'CTCell'], [ctRecordChange, ['CTCell', 'vec2u'], 'CTCell'],
  [ctDecay, ['CTCell', 'i32'], 'CTCell'], [ctExhaust, ['CTCell', 'i32'], 'CTCell'], [ctFlameLife, ['i32'], 'i32'], [ctCreate, ['CTCell', 'i32', 'i32'], 'CTCell'],
  [ctDensity, ['CTCell'], 'f32'], [ctAmount, ['CTCell'], 'i32'], [ctCapacity, ['CTCell'], 'i32'], [ctHeat, ['CTCell', 'i32'], 'CTCell'], [ctHeatTo, ['CTCell', 'i32', 'i32'], 'CTCell'], [ctConvert, ['CTCell', 'i32', 'i32'], 'CTCell'],
  [ctTemperatureRemainder, ['CTCell'], 'f32'], [ctFlux, ['CTCell', 'CTCell'], 'i32'], [ctPhase, ['CTCell', 'i32', 'f32'], 'CTCell'],
  [ctNuclearId, ['CTCell'], 'i32'], [ctLive, ['CTCell'], 'bool'], [ctConductsInto, ['i32', 'i32'], 'bool'], [ctCloneable, ['i32'], 'bool'],
  [ctGrowerDamp, ['i32', 'i32'], 'i32'], [ctPuff, ['i32', 'i32'], 'i32'], [ctPerTick, ['f32'], 'f32'],
  [ctHotFuel, ['CTCell'], 'bool'], [ctSmothered, ['i32', 'i32'], 'bool'], [ctLick, ['CTCell', 'i32', 'i32', 'bool', 'i32'], 'CTCell'],
  [ctStepAtmosphere, ['CTCell', 'array<CTCell, 3>', 'i32', 'i32', 'i32', 'i32', 'i32', 'i32', 'i32'], 'CTCell'],
  [ctStep, ['CTCell', 'array<CTCell, 3>', 'i32'], 'CTCell'],
];

export function unpackContact(core, bank = 0) {
  const id = core[0] & 255, liquid = ELEMENTS[id].kind === K.LIQUID;
  return { id, tq: phaseTemperatureQ(id, (core[0] >>> 8) & 65535), raw: (core[0] >>> 8) & 65535, age: liquid ? 0 : core[0] >>> 24, burning: liquid ? ((core[1] >>> 31) & 1) : ((core[1] >>> 24) & 1),
    fill: liquid ? core[1] & 0xffffff : CONTACT_FULL,
    life: liquid ? (CONDUCTS[id] ? 0 : core[3] >>> 16) : core[1] & 65535,
    ctype: liquid ? (core[1] >>> 24) & (ELEMENTS[id].burnRate > 0 ? 127 : 255) : (core[1] >>> 16) & 255,
    spark: CONDUCTS[id] ? (liquid ? (core[3] >>> 16) & 4095 : core[3] & 4095) : 0,
    fallSpeed: fallVelocity(core) / (CELL_M * CONTACT_HZ), state: core[2] | 0, valid: 1, bank, request: 0, busy: 0, done: 0, pending: -1, pendingOf: 0, pendingGas: 0, source: 0n, sink: 0n };
}
export function packContact(c, original = new Uint32Array(4)) {
  const core = new Uint32Array(original), liquid = ELEMENTS[c.id].kind === K.LIQUID;
  const changed = c.id !== (original[0] & 255);
  if (changed) core.fill(0);
  core[0] = c.id | (c.raw << 8) | ((liquid || ELEMENTS[c.id].kind === K.POWDER ? (core[0] >>> 24) : c.age) << 24);
  if (liquid) {
    core[1] = c.fill | (c.ctype << 24);
    if (ELEMENTS[c.id].burnRate > 0 && c.burning !== 0) core[1] |= 0x80000000;
    if (CONDUCTS[c.id]) core[3] = (core[3] & 0xf000ffff) | ((c.spark & 4095) << 16);
    else core[3] = (core[3] & 65535) | (c.life << 16);
  } else {
    core[1] = (core[1] & 0xfe000000) | (c.burning << 24) | c.life | (c.ctype << 16);
    if (CONDUCTS[c.id]) core[3] = (core[3] & 0xfffff000) | c.spark;
  }
  return { core, bank: c.bank };
}
export const materialEnergy = (core, bank = 0) => ctEnergy(unpackContact(core, bank));
export function contactDensity(id, temperatureQ) {
  const e = ELEMENTS[id];
  return e.kind === K.GAS || e.kind === K.EMPTY ? e.dens * (e.temp + 273.25) / Math.max(1, temperatureQ / 4) : e.dens;
}

export const ctPairValue = (a, b, changed) => ({ a, b, changed });
export const ctRxAt = (a, b) => CONTACT_RX_INDEX[a * ELEMENTS.length + b];
export const ctRx = index => CONTACT_REACTIONS[index];
export const ctCeilEnergy = (energy, divisor) => Number((energy + BigInt(divisor) - 1n) / BigInt(divisor));
export const ctCommonQ = (energy, a, b) => Number((energy - ctOffset(a) - ctOffset(b)) / BigInt(ctCapacity(a) + ctCapacity(b)));
export const ctRemainder = (energy, a, b) => energy - ctEnergy(a) - ctEnergy(b);
export function ctBalance(a0, b0, energy, ceiling) {
  let a = ctCopy(a0);
  let b = ctCopy(b0);
  const tq = Math.max(0, Math.min(ceiling, ctCommonQ(energy, a, b)));
  a.tq = tq; a.raw = tq; a.bank = 0;
  b.tq = tq; b.raw = tq; b.bank = 0;
  // Remaining integer quanta stay with the larger capacity. No f32 energy
  // average and no independent rounded shares (which lose heat).
  const remainder = ctRemainder(energy, a, b);
  if (ctCapacity(a) >= ctCapacity(b)) {
    const targetEnergy = ctAdd(ctEnergy(a), remainder);
    if (!ctFits(a, targetEnergy)) return ctPairValue(a0, b0, 0);
    a = ctSetEnergy(a, targetEnergy);
  } else {
    const targetEnergy = ctAdd(ctEnergy(b), remainder);
    if (!ctFits(b, targetEnergy)) return ctPairValue(a0, b0, 0);
    b = ctSetEnergy(b, targetEnergy);
  }
  if (a.tq > ceiling || b.tq > ceiling) return ctPairValue(a0, b0, 0);
  a.done = 1; b.done = 1; a.busy = 1; b.busy = 1;
  return ctPairValue(a, b, 1);
}
export function ctResolvePhase(a0, b0) {
  if (a0.pending < 0 || b0.done !== 0 || b0.pending >= 0 || (b0.request & 5) !== 0) return ctPairValue(a0, b0, 0);
  let amount = 65536;
  if (ctRow(a0.pending).kind === 3 && ctRow(a0.id).kind === 3) amount = a0.fill;
  let a = ctInherit(ctNew(a0.pending, a0.tq, amount), a0);
  if (a.id === E.LAVA) a.ctype = a0.pendingOf;
  const before = ctAdd(ctEnergy(a0), ctEnergy(b0));
  let pair = ctBalance(a, b0, before, 41093);
  if (pair.changed === 0) return ctPairValue(a0, b0, 0);
  if (a0.pendingGas !== 0) pair.a.request = ctPuff(pair.a.request, a0.pendingGas);
  return pair;
}
export function ctReaction(a0, b0, seed) {
  let a = ctCopy(a0);
  let b = ctCopy(b0);
  const code = ctRxAt(a.id, b.id);
  if (code === 0 || a.done !== 0 || b.done !== 0) return ctPairValue(a, b, 0);
  const row = ctRx(ctDiv(code - 1, 2));
  const temperature = Math.max(a.tq, b.tq);
  if (temperature < row.minQ || temperature > row.maxQ) return ctPairValue(a, b, 0);
  a.busy = 1; b.busy = 1;
  if (ctRoll(seed, 10) >= row.chance) return ctPairValue(a, b, 0);
  let ao = ctProduct(row.aOut, ctRoll(seed, 11));
  let bo = ctProduct(row.bOut, ctRoll(seed, 12));
  if ((code - 1) % 2 !== 0) { const temp = ao; ao = bo; bo = temp; }
  if (ao < 0) ao = a.id;
  if (bo < 0) bo = b.id;
  let amountA = 65536; let amountB = 65536;
  if (ctRow(ao).kind === 3 && ctRow(a.id).kind === 3) amountA = a.fill;
  if (ctRow(bo).kind === 3 && ctRow(b.id).kind === 3) amountB = b.fill;
  let na = ctInherit(ctNew(ao, a.tq, amountA), a);
  let nb = ctInherit(ctNew(bo, b.tq, amountB), b);
  if (ao === a.id) na = ctCopy(a);
  if (bo === b.id) nb = ctCopy(b);
  const initial = ctAdd(ctEnergy(a), ctEnergy(b));
  let gain = ctMul(Math.abs(row.heat), 65536);
  if (row.heat < 0) gain = ctSub(ctSigned(0), gain);
  let energy = ctAdd(initial, gain);
  // Cap released chemical energy at the products' flame temperature, not
  // temperature after adding an unbounded legacy dT to the reactants.
  const upper = ctAdd(ctAdd(ctMul(ctCapacity(na), row.ceiling), ctMul(ctCapacity(nb), row.ceiling)), ctAdd(ctOffset(na), ctOffset(nb)));
  if (row.heat > 0 && !ctLess(energy, upper)) {
    energy = initial;
    if (ctLess(initial, upper)) energy = upper;
  }
  let pair = ctBalance(na, nb, energy, row.ceiling);
  if (pair.changed === 0) return ctPairValue(a, b, 0);
  const delta = ctSub(energy, initial);
  if (ctLess(delta, ctSigned(0))) pair.a.sink = ctAdd(pair.a.sink, ctSub(ctSigned(0), delta));
  else pair.a.source = ctAdd(pair.a.source, delta);
  if (row.gas !== 0) { pair.a.request = ctPuff(pair.a.request, row.puff); pair.b.request = ctPuff(pair.b.request, row.puff); }
  return pair;
}
export function ctAcid(a0, b0, seed) {
  let a = ctCopy(a0);
  let b = ctCopy(b0);
  if (ctRow(a.id).acid === 0 || ctRow(b.id).edible === 0 || a.done !== 0 || b.done !== 0) return ctPairValue(a, b, 0);
  a.busy = 1; b.busy = 1;
  if (ctRoll(seed, 13) >= CT_ACID_EAT) return ctPairValue(a, b, 0);
  const energy = ctAdd(ctEnergy(a), ctEnergy(b));
  const fizz = ctRow(b.id).fizz;
  a.life = Math.max(0, a.life - 246);
  let product = E.EMPTY;
  if (ctRoll(seed, 14) < 0.3) product = E.SMOKE;
  b = ctInherit(ctNew(product, b.tq, 65536), b);
  if (a.life === 0) a = ctInherit(ctNew(product, a.tq, 65536), a);
  let pair = ctBalance(a, b, energy, 41093);
  if (pair.changed === 0) return ctPairValue(a0, b0, 0);
  if (fizz !== 0) pair.b.request = pair.b.request | 2;
  return pair;
}
export function ctSwallow(a0, b0, seed) {
  let a = ctCopy(a0);
  let b = ctCopy(b0);
  if (a.id !== E.SINGULARITY || (ctRow(b.id).singFood === 0 && b.id !== E.SINGULARITY) || a.done !== 0 || b.done !== 0) return ctPairValue(a, b, 0);
  if (b.id === E.SINGULARITY && b.life > a.life) return ctPairValue(a, b, 0);
  a.busy = 1; b.busy = 1;
  if (b.id !== E.SINGULARITY && ctRoll(seed, 15) >= 1) return ctPairValue(a, b, 0);
  let mass = ctI(ctDensity(b) * 25.6);
  if (b.id === E.SINGULARITY) mass = b.life;
  a.life = Math.min(65535, a.life + mass);
  const energy = ctAdd(ctEnergy(a), ctEnergy(b));
  b = ctInherit(ctNew(E.EMPTY, 1173, 65536), b);
  const pair = ctBalance(a, b, energy, 41093);
  if (pair.changed === 0) return ctPairValue(a0, b0, 0);
  return pair;
}
CONTACT_KERNEL.push(
  [ctBalance, ['CTCell', 'CTCell', 'vec2u', 'i32'], 'CTPair'],
  [ctResolvePhase, ['CTCell', 'CTCell'], 'CTPair'],
  [ctReaction, ['CTCell', 'CTCell', 'i32'], 'CTPair'],
  [ctAcid, ['CTCell', 'CTCell', 'i32'], 'CTPair'],
  [ctSwallow, ['CTCell', 'CTCell', 'i32'], 'CTPair'],
);

export const CONTACT_FACES = Array.from({ length: 8 }, (_, i) => [i ^ 1, i ^ 2, i ^ 4]);
export const CONTACT_PAIRS = CONTACT_FACES.flatMap((ns, i) => ns.filter(j => j > i).map(j => [i, j]));
export const CONTACT_POSITIONS = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1]);
// Optional per-cell [air, oxygen, CO2, gas] counts must be frozen before any
// block writes. The standalone eight-cell patch defaults to a closed outside.
// modes: the dispatch's ambient (°C), ambient heat and edge (simModes.js EDGE),
// as the block pass reads them from its params.
export const CONTACT_DEFAULT_MODES = Object.freeze({ ambient: PHYS.AMBIENT, ambientHeat: 1, edge: 0 });
export function contactReference(cores, banks, tick = 0, positions = CONTACT_POSITIONS, pending = new Uint32Array(8), valid = Array(8).fill(true), outside = Array.from({ length: 8 }, () => [0, 0, 0, 0]), modes = CONTACT_DEFAULT_MODES) {
  const ambientQ = contactAmbientQ(modes.ambient), airHeat = +!!modes.ambientHeat;
  let cells = cores.map((core, i) => {
    const c = unpackContact(core, banks[i]); c.request = pending[i]; c.valid = +!!valid[i];
    if (c.request & 5) { c.done = 1; c.busy = 1; }
    return c;
  });
  const requests = new Uint32Array(pending), busy = [];
  const seedAt = i => (Math.imul(positions[i][0], 73856093) ^ Math.imul(positions[i][1], 19349663) ^ Math.imul(positions[i][2], 83492791) ^ Math.imul(tick, 2654435761)) | 0;
  for (const [i, j] of CONTACT_PAIRS) {
    if (!valid[i] || !valid[j]) continue;
    let flux = ctConducts(cells[i], cells[j], airHeat) ? ctFlux(cells[i], cells[j]) : 0;
    if (flux) flux = -ctHeatRoom(cells[j], -ctHeatRoom(cells[i], flux));
    if (flux) { cells[i] = ctHeat(cells[i], flux); cells[j] = ctHeat(cells[j], -flux); cells[i].busy = 1; cells[j].busy = 1; }
    let pair = ctReaction(cells[i], cells[j], seedAt(i) ^ j);
    if (!pair.changed) pair = ctAcid(pair.a, pair.b, seedAt(i) ^ j);
    if (!pair.changed) { const reverse = ctAcid(pair.b, pair.a, seedAt(i) ^ j); pair = ctPairValue(reverse.b, reverse.a, reverse.changed); }
    if (!pair.changed) pair = ctSwallow(pair.a, pair.b, seedAt(i) ^ j);
    if (!pair.changed) { const reverse = ctSwallow(pair.b, pair.a, seedAt(i) ^ j); pair = ctPairValue(reverse.b, reverse.a, reverse.changed); }
    cells[i] = pair.a; cells[j] = pair.b;
  }
  const snapshot = cells.map(ctCopy);
  // V1 react.js counts the box's solid floor as a surface (its sides and lid don't).
  const floorAt = i => +(positions[i][1] === 0 && modes.edge === EDGE_SOLID);
  cells = cells.map((c, i) => valid[i] ? ctStepAtmosphere(c, CONTACT_FACES[i].map(j => snapshot[j]), seedAt(i), ...outside[i], floorAt(i), ambientQ) : c);
  for (const [i, j] of CONTACT_PAIRS) {
    if (!valid[i] || !valid[j]) continue;
    let pair = ctResolvePhase(cells[i], cells[j]);
    if (!pair.changed) { const reverse = ctResolvePhase(pair.b, pair.a); pair = ctPairValue(reverse.b, reverse.a, reverse.changed); }
    cells[i] = pair.a; cells[j] = pair.b;
  }
  for (let i = 0; i < 8; i++) {
    if (!valid[i]) continue;
    cells[i] = ctAmbient(cells[i], ambientQ, airHeat);
    const out = packContact(cells[i], cores[i]);
    cores[i] = out.core; banks[i] = out.bank; requests[i] = cells[i].request;
    if (cells[i].busy) busy.push(i);
  }
  return { cores, banks, requests, busy, sources: cells.map(c => c.source), sinks: cells.map(c => c.sink) };
}

// V1 react.js: with ambient heat off, matter trades no heat with the air.
export function ctConducts(a, b, airHeat) { return airHeat !== 0 || (a.id !== E.EMPTY && b.id !== E.EMPTY); }
// V1 react.js: the open world above the box pulls air back to ambient
// (AIR_AMBIENT_PULL) and gases radiate toward it by their rad, every cell, a
// step: the row's `cool` per tick. Integer energy with the sensible remainder,
// so a cell within a quantum of ambient moves nothing and rests. With ambient
// heat off V1 holds air at ambient. Both are declared sources/sinks.
export function ctAmbient(input, ambientQ, airHeat) {
  let c = ctCopy(input);
  if (c.id === E.EMPTY && airHeat === 0) {
    if (c.raw === ambientQ && c.bank === 0) return c;
    const before = ctEnergy(c);
    c.tq = ambientQ; c.raw = ambientQ; c.bank = 0; c.busy = 1;
    return ctRecordChange(c, before);
  }
  const cool = ctRow(c.id).cool;
  if (cool <= 0.0) return c;
  const dt = ctF(ctF(ambientQ - c.tq) - ctTemperatureRemainder(c));
  const transfer = ctI(Math.max(-2147483000, Math.min(2147483000, ctF(ctCapacity(c)) * dt * cool)));
  if (transfer === 0) return c;
  const room = ctHeatRoom(c, transfer);
  if (room === 0) return c;
  const before = ctEnergy(c);
  c = ctHeat(c, room);
  c.busy = 1;
  return ctRecordChange(c, before);
}
// The part of `gain` (signed) c can take without stepping a latent bank (steam
// at 100 °C) past its transition, which it can't represent: it stops exactly
// on the transition, and the next tick's phase rule converts it there.
export function ctHeatRoom(c, gain) {
  const now = ctEnergy(c);
  if (ctFits(c, ctAdd(now, ctSigned(gain)))) return gain;
  const r = ctRow(c.id);
  const amount = ctAmount(c);
  let edge = ctAdd(ctAdd(ctMul(ctCapacity(c), r.hotQ), ctOffset(c)), ctMul(r.hotL, amount));
  if (gain < 0) edge = ctSub(ctAdd(ctMul(ctCapacity(c), r.coldQ), ctOffset(c)), ctMul(r.coldL, amount));
  if (!ctFits(c, edge)) return 0;
  return ctSmall(ctSub(edge, now));
}
// The ambient's ¼ K code, as the block pass encodes P.ambient.
export const contactAmbientQ = ambient => Math.min(65535, Math.max(0, Math.round(Math.fround((Math.fround(ambient) + 273.25) * 4))));
CONTACT_KERNEL.push([ctConducts, ['CTCell', 'CTCell', 'i32'], 'bool'], [ctAmbient, ['CTCell', 'i32', 'i32'], 'CTCell'], [ctHeatRoom, ['CTCell', 'i32'], 'i32']);
CONTACT_KERNEL.push([ctElecMaterial, ['i32'], 'bool'], [ctFuseLife, ['i32'], 'i32'], [ctFuseSteps, ['i32'], 'i32'], [ctFuseStep, ['CTCell', 'array<CTCell, 6>', 'f32'], 'i32'],
  [ctElecStep, ['CTCell', 'array<CTCell, 6>', 'f32'], 'i32'], [ctFuseApply, ['CTCell', 'i32', 'i32'], 'CTCell'], [ctElecApply, ['CTCell', 'i32', 'i32'], 'CTCell'],
  [ctElecAirborne, ['CTCell', 'array<CTCell, 6>', 'i32'], 'CTCell']);

// R5 ambient exchange at the open box's faces. The owner counts exposed open
// side/top faces (not the floor or closed/periodic edges).
export function ctBoundary(input, openFaces, ambientQ) {
  let c = ctCopy(input);
  const perFace = ctDiv(ctFlux(c, ctNew(E.EMPTY, ambientQ, 65536)), 2);
  const transfer = perFace * Math.max(0, Math.min(5, openFaces));
  if (transfer === 0) return c;
  const before = ctEnergy(c);
  c = ctHeat(c, transfer);
  c.busy = 1;
  return ctRecordChange(c, before);
}
CONTACT_KERNEL.push([ctBoundary, ['CTCell', 'i32', 'i32'], 'CTCell']);

// Pressure execution belongs to the air owner; SING's life is mass*256.
export function contactVacuum(core) {
  return (core[0] & 255) === E.SINGULARITY ? Math.max(PHYS.P_MIN, -PHYS.SING_P_PER_MASS * (core[1] & 65535) / 256) : 0;
}

// Special event consumers use the same pressure/energy calibration as the
// existing gunpowder content, not an invented TNT charge. Acoustic energy is
// proportional to p² (the dynamics air-compression equation).
export function specialExplosion(core, gunpowderEnergyJ) {
  if (!Number.isFinite(gunpowderEnergyJ) || gunpowderEnergyJ < 0) throw Error('invalid gunpowder energy calibration');
  const id = core[0] & 255;
  if (id !== E.DUST && id !== E.SINGULARITY) return null;
  const temperature = phaseTemperatureQ(id, (core[0] >>> 8) & 65535) / 4 - 273.25;
  const mass = (core[1] & 65535) / 256;
  const pressure = id === E.DUST ? PHYS.DUST_P : Math.max(0, mass) * PHYS.SING_BURST_P_PER_MASS;
  const ratio = Math.min(PHYS.P_MAX, pressure) / ELEMENTS[E.GUNPOWDER].blast.P;
  const gone = id === E.SINGULARITY && mass === 0;
  return { energyJ: gunpowderEnergyJ * ratio * ratio, product: gone ? E.EMPTY : E.FIRE,
    productT: gone ? temperature : id === E.DUST ? Math.max(temperature, PHYS.DUST_FLAME_T) : PHYS.SING_BURST_T,
    productCtype: 0, pressure: Math.min(PHYS.P_MAX, pressure) };
}

// Mirrors legacy rays.matOf: molten fissile metal retains its nuclear identity.
export function contactNuclearMaterial(core) {
  const id = core[0] & 255, ctype = core[1] >>> 24;
  return id === E.LAVA && ctype > 0 && ctype < ELEMENTS.length ? ctype : id;
}

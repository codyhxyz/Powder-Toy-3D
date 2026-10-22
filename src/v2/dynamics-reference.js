// CPU specification and shared constants for native dynamics. Units: world cells,
// seconds, m/s, J and Pa. No legacy state is read by the native kernels.
import { ELEMENTS, E, K } from '../elements.js';
import { CELL_M } from '../scale.js';
import { PHYS, SIM_GRAVITY, NOMINAL_STEP_RATE } from '../physics.js';
import { contactVacuum, specialExplosion } from './contact.js';
import { impactFoam } from './foam.js';
import { PACE } from '../shaders/move.js';
import { energyOf, withEnergy, energyFits, makeMaterial, cTq, withPayload, payloadOf, share, packetOwnedEnergy, withPacketEnergy, packetEnergyFits } from './layout.js';
import { AIR, V1_AIR, BLAST_SCALE, GUNPOWDER_ENERGY_J, GUNPOWDER_PRESSURE, LEGACY_PRESSURE_PA, legacyPressureToPa, specialBlastEnergy } from './pressure.js';
export { AIR, V1_AIR, BLAST_SCALE, GUNPOWDER_ENERGY_J, GUNPOWDER_PRESSURE, LEGACY_PRESSURE_PA, legacyPressureToPa, specialBlastEnergy };
export { CELL_M };
export const PARTICLE_CAP = 65536;
export const PARTICLE_BYTES = 48;
export const DT = 1 / 60;
export const GRAVITY = 19.6; // TF2's ~2 g, docs/v2.md §5.1.
export const singularityVacuumPa = core => legacyPressureToPa(contactVacuum(core));
export const EVENT = Object.freeze({ DETONATE: 1, GAS: 2, NEUTRON: 4 });
export const PHOTON_TAG = 254;
export const NEUTRON_TAG = 255; // Particle-only, never a grid element.
if (ELEMENTS.length >= PHOTON_TAG) throw new Error('Native neutron tag collides with a material');
const SPECIFIC_J = { TNT: 4.184e6, C4: 5.858e6, NITRO: 6.28e6, GUNPOWDER: 3e6,
  THERMITE: 3.9e6, PROPANE: 46.4e6 };
// V1 react.js crush (elements.js crush { P, into, of }): past P of air pressure on it (the
// highest of its own, none for a solid, and its open neighbours') a cell becomes pickOut(into),
// keeping its temperature, with its product's spawn life; a LAVA product's ctype is `of` (or the
// cell's own element: react.js ctypeOf). pa: P in Pa; outs: [id, cumulative share] as
// elements.js mechanisms() draws them ('SAME' stays itself); null without a crush.
function crushPhaseOf(e) {
  if (!e.crush) return null;
  const list = typeof e.crush.into === 'string' ? [[e.crush.into, 1]] : e.crush.into;
  const total = list.reduce((sum, [, w]) => sum + w, 0);
  let at = 0;
  const outs = list.map(([key, w]) => [key === 'SAME' ? e.id : E[key], at += w / total]);
  outs[outs.length - 1][1] = 1;
  if (outs.some(([id]) => !Number.isInteger(id))) throw new Error(`${e.key}.crush: unknown product`);
  return { pa: e.crush.P * LEGACY_PRESSURE_PA, outs, of: e.crush.of ? E[e.crush.of] : e.id };
}
// A cell's mass (kg) per unit of V1's density (elements.js dens: water 10, g/cm³ × 10): mass below.
export const MASS_PER_DENS = 100 * CELL_M ** 3;
export const dynamicsRows = ELEMENTS.map(e => ({
  id: e.id, kind: e.kind, mass: Math.max(e.dens * 100 * CELL_M ** 3, 0.001),
  // TPT hardness is retained as the gameplay fracture energy, now explicitly J.
  toughness: e.breakInto ? e.hard : 1e30, breakInto: e.breakInto ? E[e.breakInto] : -1,
  // V1 react.js breaking: the air pressure difference across a solid past
  // hard·P_BREAK_PER_HARD (legacy pressure, here in Pa) breaks it.
  strength: e.breakInto ? e.hard * PHYS.P_BREAK_PER_HARD * LEGACY_PRESSURE_PA : 1e30,
  // V1 react.js: an explosive goes off under more than blast.crushP air pressure (Pa here).
  crush: e.blast?.crushP ? e.blast.crushP * LEGACY_PRESSURE_PA : 0,
  crushPhase: crushPhaseOf(e),
  terminal: ({ ASH: 3, SNOW: 3, SAWDUST: 4, DUST: 3 })[e.key] ?? 55,
  lift: ({ ASH: 1, DUST: 1, SNOW: 2, SAWDUST: 2 })[e.key] ?? 12,
  energy: e.key==='DUST' ? specialBlastEnergy(PHYS.DUST_P) : e.blast ? Math.max(e.dens * 100 * CELL_M ** 3, 0.001) * (SPECIFIC_J[e.key] ?? 3e6) * BLAST_SCALE : 0,
  product: e.key==='DUST' ? E.FIRE : e.key==='SINGULARITY' ? E.FIRE : e.blast ? E[e.blast.into ?? 'FIRE'] : 0,
  productCtype: e.blast?.of ? E[e.blast.of] : 0,
  productT: e.key==='DUST' ? PHYS.DUST_FLAME_T : e.key==='SINGULARITY' ? PHYS.SING_BURST_T : e.blast?.T ?? 20,
}));
/**
 * The speed (m/s) a packet reaches falling h metres from rest in still air at reference gravity, on
 * the particle lane's own step (particles.js integrate: implicit quadratic drag toward the element's
 * terminal speed, then the tick's gravity), stepped as V1's fallKE steps V1's (elements.js fallKE).
 */
export function particleFallSpeed(id, h) {
  const drag = GRAVITY / dynamicsRows[id].terminal ** 2;
  let v = 0, y = 0;
  while (y < h) { v = v / (1 + drag * v * DT); y += v * DT + 0.5 * GRAVITY * DT * DT; v += GRAVITY * DT; }
  return v;
}
// V1's shock (elements.js blast.shock: react.js sets an explosive off under a hit of at least that
// kinetic energy, ½·μ·u², common.js hitKE and shockActs), on a packet's hit (particles.js dShockHit) in
// V1's own units: V1's densities a cell each (dMass is dens·MASS_PER_DENS, so shockKE is blast.shock in
// dMass's units) and V1's speeds, cells/step, capped at PHYS.V_MAX. A packet's closing speed u (m/s, along
// the face it hits) is the V1 speed the same motion had:
//   a throw      the speed V2's throws give V1's (v2/tools.js legacyVelocityToMS, shaders/v2/transfer.js:
//                SHOCK_THROW_MS m/s for each cell/step), so u / SHOCK_THROW_MS, to V1's cap
//   a landing    (along the pull, onto the cell's upper face) a fall, as the column passes calibrate it:
//                a packet of matter landing on a charge at past the speed a packet reaches over V1's fall
//                for that pair (SHOCK_LANDINGS) sets it off (packetShockLandings); a charge landing on
//                matter maps its speed by its own fall, SHOCK_FALL_CELLS (V1's own fall to its shock on a
//                solid, v1OwnShockFall), so shockFall (V1 cells/step per m/s) is that fall's V1 speed over a
//                packet's speed after it (particleLandingSpeed), to V1's cap.
//                A solid has no V1 fall (V1's solids never move): its landing is a throw.
// A shock V2 has no derivation for is an error here, never a silent zero.
export const SHOCK_THROW_MS = NOMINAL_STEP_RATE * CELL_M;
// ---- V1's fall, as V1 runs it (react.js forces, move.js vertical) ----
// react.js forces: a step adds gravity·GRAV (SIM_GRAVITY cells/step²), then drag takes DRAG of it, except from a
// liquid in free fall (nothing but air under it: `flying`), and V_MAX caps it. move.js (a Margolus block pass)
// moves a cell down only from a 2×2×2 block's top half, and the partition shifts a cell every step (P.parity):
// a cell that moved down is on a top half again the next step, one that did not is on a bottom half (it cannot
// move) for a step. It moves when its draw falls under its speed: a liquid into air on the R3 sequence at its
// fall age (move.js draw, PACE.Y, fallAge: speed/g steps), a grain on its block's random stream. So V1's fall
// is slower than its speed: a cell lands faster than the speed a fall of that height would give it.
// The landing then hits twice (react.js shock, common.js impactActs): the react after the move that brought it
// over what it lands on sees its free-fall speed (u1), and a hit that acts is left unlanded by the next move, so
// the react after that sees it again, after its drag (u2): V1's hit is the larger.
// Measured on V1 (2026-10-22, tools/outcomes/engine-v1.js, a lone water cell in a fresh 64×48×64 box, its
// speed the step before it lands, which is u2): 2 → 0.297, 4 → 0.5445, 6 → 0.6435, 8 → 0.693, 10 → 0.792, 12 →
// 0.8415, 14 → 0.9405, 16 → 0.99, 18 on → 1.0 cells/step: v1LiquidArrival's law to the digit (tools/v2/shock-check.mjs).
// A liquid's fall is deterministic: its arrival depends on the fall h and its phase, its start row's parity
// against the step's ((y0 + frame) & 1: phase 0 starts on a block's top half). The game steps V1 four times a
// frame and the outcome bench's box starts at frame 0, so matter placed at row y0 falls at phase y0 & 1. A fall
// at phase 1 is phase 0's a cell shorter (V1 loses its first step to the partition).
const V1_FALL_STEPS_MAX = 100000;
const f32 = Math.fround;
// V1 common.js u32ToF32 · UINT_TO_UNIT: move.js draw's paced value at step n of the sequence
const v1PaceDraw = (n, pace) => { const s = Math.imul(n, pace) >>> 0; return f32(f32(f32((s >>> 8) * 256) + (s & 255)) * f32(2 ** -32)); };
/** V1's lone liquid cell (grav its GRAV) falling h cells from rest at `phase`: the steps of free fall it has
 * when the move brings it over what it lands on (its speed then is that many steps of gravity, to V_MAX). */
export function v1LiquidArrival(h, phase, grav = 1) {
  const g = f32(SIM_GRAVITY * grav);
  // (rows from the cell it lands in; a block's top half holds the rows odd against the step's parity, and the
  // step before its first has the parity that puts row h on a top half at phase 0)
  let y = h, v = 0, parity = (phase + h) & 1;
  for (let n = 0; n < V1_FALL_STEPS_MAX; n++) {
    parity ^= 1;
    if (v > 0 && ((y - parity) & 1) === 1) {
      const age = v < PHYS.V_MAX ? Math.floor(f32(f32(v / g) + 0.5)) : 0;
      // (past V_MAX move.js draws at the frame, but the draw is then under 1 always)
      if (v >= PHYS.V_MAX || v1PaceDraw(age, PACE.Y) < v) { y -= 1; if (y === 0) return Math.round(v / g); }
    }
    v = Math.min(PHYS.V_MAX, f32(v + g));
  }
  throw new Error('v1LiquidArrival: no landing');
}
/** V1's hit (cells/step) of a cell of element j landing after `steps` steps of free fall: max(u1, u2), above. */
export function v1LandingHit(j, steps) {
  const g = SIM_GRAVITY * j.grav, u1 = Math.min(PHYS.V_MAX, steps * g);
  return Math.max(u1, Math.min(PHYS.V_MAX, (u1 + g) * (1 - (j.drag ?? 0))));
}
/** V1's hit (cells/step) of a lone liquid cell of element j landing after a fall of h cells at phase 0. */
export const v1LiquidHit = (j, h) => h <= 0 ? 0 : v1LandingHit(j, v1LiquidArrival(h, 0, j.grav));
// V1's fall is at V_MAX from V1_FALL_CELLS_MAX cells (the hit no longer grows): V1's falls are tables to it
export const V1_FALL_CELLS_MAX = (() => { let h = 1; while (v1LiquidArrival(h, 0) * SIM_GRAVITY < PHYS.V_MAX) h++; return h; })();
// A liquid's landing law: the fall `fall` (cells, at phase 0) from which a cell of j lands with ½·mu·u² of at least
// shock (V1 sets it off from there at phase 0, from a cell more at phase 1), or null where no fall carries it.
function v1LiquidFall(j, mu, shock) {
  for (let h = 1; h <= V1_FALL_CELLS_MAX; h++) if (0.5 * mu * v1LiquidHit(j, h) ** 2 >= shock) return h;
  return null;
}
// A grain falls on V1's random stream: at a height it sets a charge off at some odds (the arrival's spread over
// its draws, computed exactly over the draws' states), from V1_GRAIN_ODDS on. Its fall is the first height V1's
// odds reach it (a grain from there goes off more often than not); its phase is no matter at those odds.
export const V1_GRAIN_ODDS = 0.5;
const V1_GRAIN_FALL_MAX = 200;
/** V1's odds that a grain of j landing after h cells from rest (either phase, half each) hits with ½·mu·u² ≥ shock. */
export function v1GrainOdds(j, mu, shock, h) {
  const g = f32(SIM_GRAVITY * j.grav), keep = f32(1 - (j.drag ?? 0)), ustar2 = 2 * shock / mu;
  let odds = 0;
  for (const phase of [0, 1]) {
    // the chance it is h - i cells up on a top half (top) or a bottom half (bottom) before the step's move
    let top = new Float64Array(h + 1), bottom = new Float64Array(h + 1), v = 0;
    (phase === 0 ? top : bottom)[h] = 1;
    for (let n = 0; n < V1_FALL_STEPS_MAX && (top.some(p => p > 1e-12) || bottom.some(p => p > 1e-12)); n++) {
      const after = Math.min(PHYS.V_MAX, f32(f32(v + g) * keep));
      const nextTop = new Float64Array(h + 1), nextBottom = new Float64Array(h + 1), p = Math.min(1, v);
      for (let y = 1; y <= h; y++) {
        nextTop[y] += bottom[y];
        if (!top[y]) continue;
        if (y === 1) { if (Math.max(v, after) ** 2 >= ustar2) odds += 0.5 * top[y] * p; }
        else nextTop[y - 1] += top[y] * p;
        nextBottom[y] += top[y] * (1 - p);
      }
      top = nextTop; bottom = nextBottom; v = after;
    }
  }
  return odds;
}
function v1GrainFall(j, mu, shock) {
  const keep = 1 - (j.drag ?? 0), vt = Math.min(PHYS.V_MAX, SIM_GRAVITY * j.grav * keep / (1 - keep));
  if (0.5 * mu * vt * vt < shock) return null;
  for (let h = 1; h <= V1_GRAIN_FALL_MAX; h++) if (v1GrainOdds(j, mu, shock, h) >= V1_GRAIN_ODDS) return h;
  return null;
}
// A landing law { fall, phased, cells }: V1 sets the charge off from `fall` cells, at phase 0 and from a cell
// more at phase 1 where `phased` (a liquid's law), at any phase otherwise; `cells`, the fall a continuous fall
// (a packet's, a grain's in V2) is held to, the middle of V1's step between resting and going off.
const landingLaw = (fall, phased) => fall === null ? null : { fall, phased, cells: phased ? fall : fall - 0.5 };
function v1FallLaw(j, mu, shock) {
  if (j.kind === K.LIQUID) return landingLaw(v1LiquidFall(j, mu, shock), true);
  return landingLaw(v1GrainFall(j, mu, shock), false);
}
// A loose charge's own landing on a solid (V1 react.js: ½·m·u², its own mass against a solid, common.js hitKE):
// V1's law for it. Nitroglycerin's: from 9 cells at phase 0, 10 at phase 1 (2.7-3.0 m; measured on V1, a lone
// cell and a one-layer slab in a fresh box: rests from 8, and from 9 at phase 1, goes off from 9 at phase 0 and
// from 10), not elements.js NITRO_FALL_M: that derived its shock with a drag (fallKE) V1's falling liquid never feels.
export function v1OwnShockLaw(id) {
  const e = ELEMENTS[id];
  if (!(e.blast?.shock > 0) || (e.kind !== K.POWDER && e.kind !== K.LIQUID) || !(e.grav > 0)) return null;
  return v1FallLaw(e, e.dens, e.blast.shock);
}
export const v1OwnShockFall = id => v1OwnShockLaw(id)?.cells ?? null;
export const SHOCK_FALL_CELLS = Object.freeze(Object.fromEntries(ELEMENTS.filter(e => e.blast?.shock && e.kind !== K.SOLID)
  .map(e => [e.id, v1OwnShockFall(e.id)])));
for (const e of ELEMENTS) {
  const row = dynamicsRows[e.id];
  row.shockKE = 0; row.shockFall = 0;
  if (!e.blast?.shock) continue;
  // the impact stage reads no air faces (react.js blastAir): a shock charge that needs air would need them
  if (e.blast.air) throw new Error(`dynamics-reference: ${e.key}'s shock needs air faces the impact stage does not read`);
  if (!(e.dens > 0)) throw new Error(`dynamics-reference: ${e.key}'s shock has no V1 density to take it`);
  row.shockKE = e.blast.shock * MASS_PER_DENS;
  if (e.kind === K.SOLID) continue;
  if (!(SHOCK_FALL_CELLS[e.id] > 0)) throw new Error(`dynamics-reference: no V2 derivation of ${e.key}'s blast.shock on landing`);
  row.shockFall = Math.sqrt(2 * e.blast.shock / e.dens) / particleLandingSpeed(e.id, SHOCK_FALL_CELLS[e.id] * CELL_M);
}
/** V1 common.js hitKE: closing at speed² u2, the mover i's mass against a solid j, else the reduced mass. */
export const hitKE = (mi, mj, jSolid, u2) => 0.5 * (jSolid ? mi : mi * mj / (mi + mj)) * u2;
// V1's shock on a grid landing. V1 react.js sets an explosive off when matter closes on it with ½·μ·u²
// of at least its blast.shock, a cell landing on it included (the move pass leaves the lander's speed for
// the react pass to see: common.js impactActs, shockActs), μ the lander's own mass on a solid charge and
// the reduced mass on a loose one (common.js hitKE: each a cell of its density), never by its own element
// or a gas (shockActs, isGasLike). The lander's hit is its fall on V1's own law (v1LiquidArrival, v1GrainOdds
// above), so the rule is a landing law (landingLaw: from which fall a cell of `faller` landing on `charge`
// sets it off), or null where V1's fall never carries that much. In V1 that is the very heavy powders (scrap,
// uranium, plutonium, gold nuggets, singularity) and the liquids heavy enough near V1's terminal speed
// (mercury on C-4; mercury, lava and mud on nitroglycerin). Sand, stone, water never do.
// A liquid heavier than a liquid charge sinks into it (move.js vertical: it trades places on its draws, on the
// block's random stream), and while it presses on the charge unmoved it keeps its fall's speed and gains on it
// (react.js forces: nothing holds a cell that is moving down), so V1 sets the charge off from shorter falls than
// a lone landing's hit; that is no law of a step, so it is V1's measured fall (V1_SINKING_FALLS).
// (A packet's landings are packetShockLandings', from the same laws.)
// V1_SINKING_FALLS: measured on V1 (2026-10-22, tools/outcomes/engine-v1.js, each drop a 2×2 slab onto a 4×4×2
// pool in a fresh 64×48×64 box, both phases): mercury on nitroglycerin goes off from 2 cells, the least fall
// measured (2-9 cells all go off); mud from 15 at phase 0 and 16 at phase 1 (14 rests at both, 15 at phase 1).
// Lava sets nitroglycerin off by its heat wherever it touches it (react.js heat, nitroglycerin's ignite); its
// landing law is its own fall's.
const V1_SINKING_FALLS = Object.freeze({ MERCURY: { NITRO: { fall: 2, phased: false } }, MUD: { NITRO: { fall: 15, phased: true } } });
export function v1ShockLaw(faller, charge) {
  const j = ELEMENTS[faller], k = ELEMENTS[charge], shock = k.blast?.shock ?? 0;
  if (!(shock > 0) || faller === charge || (j.kind !== K.POWDER && j.kind !== K.LIQUID) || !(j.grav > 0)) return null;
  const sinking = V1_SINKING_FALLS[j.key]?.[k.key];
  if (sinking) return landingLaw(sinking.fall, sinking.phased);
  return v1FallLaw(j, k.kind === K.SOLID ? j.dens : j.dens * k.dens / (j.dens + k.dens), shock);
}
/** The fall (cells) a continuous fall onto the charge is held to (landingLaw cells), or null: v1ShockLaw's. */
export const v1ShockFall = (faller, charge) => v1ShockLaw(faller, charge)?.cells ?? null;
/** Every V1 shock trigger a grid landing can make: { faller, charge, fall, phased, cells } (v1ShockLaw), for the
 * column passes (shaders/v2.js v2ColumnWGSL for powders, shaders/v2/columns.js colShockLand for liquids). */
export const SHOCK_LANDINGS = Object.freeze(ELEMENTS.filter(k => k.blast?.shock).flatMap(k => ELEMENTS
  .map(j => ({ faller: j.id, charge: k.id, ...v1ShockLaw(j.id, k.id) })).filter(r => r.fall !== undefined)));
/**
 * The speed (m/s) a packet dropped from rest in still air at reference gravity has when it has fallen h
 * metres, as the particle lane's integrate steps it (implicit quadratic drag to the element's terminal
 * speed, then the tick's gravity) and its sweep reads a hit within a tick (the velocity at the hit's
 * share of the tick: v + g·DT·share). The pull's strength drops out of a fall's speed at a height, on
 * both laws (V1's and this), so these speeds hold at any gravity.
 */
export function particleLandingSpeed(id, h) {
  const drag = GRAVITY / dynamicsRows[id].terminal ** 2;
  let v = 0, y = 0;
  for (;;) {
    v = v / (1 + drag * v * DT);
    const step = v * DT + 0.5 * GRAVITY * DT * DT;
    if (y + step >= h) {
      // the share of the tick at which it has fallen h: y + v·DT·s + ½·g·DT²·s² = h
      const a = 0.5 * GRAVITY * DT * DT, b = v * DT, c = y - h;
      const share = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
      return v + GRAVITY * DT * share;
    }
    y += step; v += GRAVITY * DT;
  }
}
// PACKET_SHOCK_SLACK: the GPU's f32 sums of a fall's ticks may land a quantum under the f64 law's speed.
export const PACKET_SHOCK_SLACK = 1 - 2 ** -16;
/** A packet of matter landing on a charge (SHOCK_LANDINGS, packets' law): { faller, charge, cells, speed },
 * speed the m/s past which it sets the charge off, a packet's landing speed after V1's fall (particles.js dShockLand). */
export const PACKET_SHOCK_LANDINGS = Object.freeze(SHOCK_LANDINGS.map(r =>
  ({ ...r, speed: Math.fround(particleLandingSpeed(r.faller, r.cells * CELL_M) * PACKET_SHOCK_SLACK) })));
/** V1's shock on a packet's hit, as particles.js dShockHit reads it (CPU twin of its decision). mover: the
 * packet's element, target: the grid cell's; u: the closing speed (m/s) along the face; landing: along the
 * pull onto its upper face. Returns { target, mover }: whether each, a charge, goes off. */
export function packetShock(mover, target, u, landing) {
  const out = { target: false, mover: false };
  const kind = id => ELEMENTS[id].kind, gasLike = id => kind(id) === K.GAS || kind(id) === K.EMPTY;
  if (mover === target || gasLike(mover) || gasLike(target)) return out;
  // V1 react.js from the charge's side (me): common.js hitKE, a cell each of V1's densities
  const acts = (me, j, v) => {
    const m = dynamicsRows[me].mass, mj = dynamicsRows[j].mass;
    const ke = kind(me) === K.SOLID ? hitKE(mj, m, true, v * v) : hitKE(m, mj, kind(j) === K.SOLID, v * v);
    return ke >= dynamicsRows[me].shockKE;
  };
  const thrown = Math.min(PHYS.V_MAX, u / SHOCK_THROW_MS);
  if (dynamicsRows[target].shockKE > 0) {
    if (landing && (kind(mover) === K.POWDER || kind(mover) === K.LIQUID)) {
      const on = PACKET_SHOCK_LANDINGS.find(r => r.faller === mover && r.charge === target)?.speed ?? 0;
      out.target = on > 0 && u >= on;
    } else out.target = acts(target, mover, thrown);
  }
  if (dynamicsRows[mover].shockKE > 0) {
    const fall = dynamicsRows[mover].shockFall;
    out.mover = acts(mover, target, landing && fall > 0 ? Math.min(PHYS.V_MAX, u * fall) : thrown);
  }
  return out;
}
// V1's pressure front (react.js air pressure): each open cell takes at least P_FRONT of its strongest open
// neighbour's pressure, and all of it P_DECAY, a step, so a charge's pressure travels a cell a step through open
// cells (a solid holds none: walls block it), KEEP of it a cell, by taxicab steps. A charge going off adds its
// blast.P to what its cell held (V1's spread), to P_MAX (react.js lit: Pr += BLAST.x, clamped). An explosive
// goes off under more than its crushP (setOff), the highest of its own and its open neighbours' (pOn), so one
// `steps` cells from the charge reads the front a step short. V2's air is an acoustic field per 4³ brick, which
// spreads a charge's pressure over the bricks within a tick and reaches a third as far (nitroglycerin on
// nitroglycerin: ~5 cells, V1's 15), so the batch's damage reads V1's front from its own charges as well
// (shaders/v2/blasts.js dChargeFrontOver).
export const V1_FRONT = Object.freeze({ KEEP: PHYS.P_FRONT * PHYS.P_DECAY, P_MAX: PHYS.P_MAX });
/** V1's front, legacy pressure, on a cell `steps` taxicab cells from a charge that went off holding source. */
export const v1FrontOn = (source, steps) => Math.min(source, V1_FRONT.P_MAX) * V1_FRONT.KEEP ** Math.max(0, steps - 1);
/** A charge's V1 blast.P per √J of its energy (dChargeEnergy): its blast.P for a whole cell, a liquid's share of a
 * cell by its fill as V2's pressure takes it (p² ∝ J); DUST's and SINGULARITY's legacy pressure, as their energy
 * derives from it (contact.js specialExplosion: GUNPOWDER's energy per its blast.P²). 0 for no charge. */
export function frontPerRootJ(id) {
  if (id === E.DUST || id === E.SINGULARITY) return GUNPOWDER_PRESSURE / Math.sqrt(GUNPOWDER_ENERGY_J);
  return dynamicsRows[id].energy > 0 && ELEMENTS[id].blast ? ELEMENTS[id].blast.P / Math.sqrt(dynamicsRows[id].energy) : 0;
}
/** The legacy pressure a charge of energyJ goes off with: its blast.P on what its brick held besides it (spread). */
export const v1FrontSource = (id, energyJ, spread) => Math.min(V1_FRONT.P_MAX, frontPerRootJ(id) * Math.sqrt(energyJ) + Math.max(0, spread));
export function hash32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
export function stableId(position, tick, rule = 0) {
  return hash32((Math.imul(position[0] | 0, 73856093) ^ Math.imul(position[1] | 0, 19349663) ^
    Math.imul(position[2] | 0, 83492791) ^ Math.imul(tick, 2654435761) ^ rule) >>> 0) || 1;
}
export const claimKey = (id, tick) => hash32((id ^ Math.imul(tick, 2654435761)) >>> 0);
export function packParticle({ position, velocity, id, core, bank }) {
  const bytes = new ArrayBuffer(PARTICLE_BYTES), v = new DataView(bytes);
  for (let a = 0; a < 3; a++) { v.setFloat32(a * 4, position[a], true); v.setFloat32(16 + a * 4, velocity[a], true); }
  v.setUint32(12, id, true);
  for (let a = 0; a < 4; a++) v.setUint32(28 + a * 4, core[a], true);
  v.setInt32(44, bank, true);
  return bytes;
}
export function unpackParticle(bytes) {
  const v = new DataView(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, PARTICLE_BYTES);
  return { position: [0, 4, 8].map(i => v.getFloat32(i, true)), id: v.getUint32(12, true),
    velocity: [16, 20, 24].map(i => v.getFloat32(i, true)),
    core: [28, 32, 36, 40].map(i => v.getUint32(i, true)), bank: v.getInt32(44, true) };
}
export function ballistic(position, velocity, dt = DT, gravity = GRAVITY) {
  return { position: position.map((p, a) => p + (velocity[a] * dt - (a === 1 ? 0.5 * gravity * dt * dt : 0)) / CELL_M),
    velocity: velocity.map((v, a) => v - (a === 1 ? gravity * dt : 0)) };
}
// Amanatides/Woo, including all crossed voxels, irrespective of speed. Ties
// walk one face at a time in x,y,z order (the WGSL uses the same convention).
export function sweep(from, to, occupied) {
  const d = to.map((x, a) => x - from[a]), cell = from.map(Math.floor), step = d.map(Math.sign);
  const inv = d.map(x => x ? Math.abs(1 / x) : Infinity);
  const next = d.map((x, a) => x ? ((cell[a] + (x > 0 ? 1 : 0) - from[a]) / x) : Infinity);
  let t = 0, previous = [...cell];
  for (;;) {
    if (occupied(cell)) return { cell: [...cell], previous, t };
    let axis = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
    if (next[axis] > 1) return null;
    previous = [...cell]; t = next[axis]; cell[axis] += step[axis]; next[axis] += inv[axis];
  }
}
function canonicalParticleBefore(a,b) {
  const words=p=>new Uint32Array(packParticle({...p,position:p.position??p.target.map(x=>x+0.5),velocity:p.velocity??[0,0,0]}));
  const aw=words(a),bw=words(b);
  for(let i=0;i<12;i++) if(aw[i]!==bw[i]) return aw[i]<bw[i];return false;
}
export function resolveDeposits(particles, tick, empty, deposit) {
  const claims = new Map();
  for (const p of particles) {
    if (!empty(p.target)) continue;
    const key = p.target.join(','), prev = claims.get(key);
    if (!prev || claimKey(p.id, tick) < claimKey(prev.id, tick) ||
      (claimKey(p.id, tick) === claimKey(prev.id, tick) && canonicalParticleBefore(p,prev))) claims.set(key, p);
  }
  for (const p of claims.values()) deposit(p.target, { core: [...p.core], bank: p.bank });
  return particles.filter(p => claims.get(p.target.join(',')) !== p);
}
export function allocateSources(sources, pool, capacity = PARTICLE_CAP) {
  // Canonical source order, not dispatch/list order. At capacity leave the
  // authoritative source intact; an event producer must retain its request.
  let free = 0;
  for (const source of [...sources].sort((a, b) => a.slot - b.slot)) {
    while (free < capacity && pool[free]?.id) free++;
    if (free === capacity) { source.retry = true; continue; }
    pool[free++] = { ...source.particle, core: [...source.particle.core] };
    source.material = null; source.retry = false;
  }
}
export function impact(core, velocity, target, amount = 1) {
  const row = dynamicsRows[core[0] & 255], t = dynamicsRows[target[0] & 255];
  const energy = 0.5 * row.mass * amount * velocity.reduce((s, v) => s + v * v, 0);
  const broken = row.kind !== K.LIQUID && t.breakInto >= 0 && energy >= t.toughness;
  return { energy, broken, remaining: energy - (broken ? t.toughness : 0) };
}
export function blastPlan(source, targets, solidAt, energy) {
  const plans = targets.map(target => {
    const hit = sweep(source.map(x => x + 0.5), target.map(x => x + 0.5), p =>
      !p.every((x, a) => x === source[a]) && !p.every((x, a) => x === target[a]) && solidAt(p));
    const r2 = Math.max(0.25, target.reduce((s, x, a) => s + (x - source[a]) ** 2, 0));
    return { target, energy: hit ? 0 : energy * 0.5 / (4 * Math.PI * r2) };
  });
  const sum = plans.reduce((s, p) => s + p.energy, 0), scale = Math.min(1, energy * 0.5 / Math.max(sum, 1e-30));
  return plans.map(p => ({ ...p, energy: p.energy * scale }));
}
// Finite-volume one-axis scalar reference. Each face is evaluated ONCE and
// exchanged with opposite signs: neither diffusion nor upwind advection
// creates heat or gas. Closed domain by default.
export function exchangeScalar(values, velocities, dt, { diffusion = AIR.diffusion, edge = AIR.edge } = {}) {
  const out = [...values];
  for (let i = 0; i + 1 < values.length; i++) {
    const adv = Math.max(-1 / 12, Math.min(1 / 12, (velocities[i] + velocities[i + 1]) * 0.5 * dt / edge));
    const gradient = values[i] - values[i + 1];
    const flux = (Math.abs(gradient) < AIR.scalarQuantum ? 0 : diffusion * dt / edge ** 2 * gradient) +
      adv * (adv >= 0 ? values[i] : values[i + 1]);
    out[i] -= flux; out[i + 1] += flux;
  }
  return out;
}
export function airSource(state, count) {
  return { ...state, pressure: state.pressure + count * AIR.gasPressure, gas: state.gas + count / 64, quiet: 0 };
}
export function airQuiet(state, neighbors = []) {
  return [state, ...neighbors].every(s => Math.abs(s.pressure) < AIR.pQuantum &&
    s.velocity.every(v => Math.abs(v) < AIR.vQuantum)) ? Math.min(AIR.quietTicks, state.quiet + 1) : 0;
}

// Exact native energy twins of the WGSL handoff. The stationary grid's air
// carrier is NOT part of a flying material packet; its bank still is.
export const particleEnergy = packetOwnedEnergy;
export function extractPacket(m) {
  return { packet:{core:new Uint32Array(m.core),bank:m.bank},
    source:makeMaterial(0,cTq(m.core)*0.25-273.25,0,0) };
}
export function extractPartialPacket(source,amount) {
  const total=source.core[1]&0xffffff;
  if(!Number.isInteger(amount) || amount<1 || amount>total) throw new RangeError('particle extraction amount');
  if(amount===total) return extractPacket(source);
  let packet={core:new Uint32Array(source.core),bank:source.bank},rest={core:new Uint32Array(source.core),bank:source.bank};
  packet.core[1]=(packet.core[1]&0xff000000)|amount;rest.core[1]=(rest.core[1]&0xff000000)|(total-amount);
  if(!(ELEMENTS[source.core[0]&255].elec>0)) {
    const fuel=Number(share(payloadOf(source.core),0,amount,total));
    packet=withPayload(packet,fuel);rest=withPayload(rest,payloadOf(source.core)-fuel);
  }
  const e=share(particleEnergy(source),0,amount,total);
  if(!packetEnergyFits(packet,e)) return null;packet=withPacketEnergy(packet,e);
  const remaining=energyOf(source)-particleEnergy(packet);if(!energyFits(rest,remaining)) return null;
  return {packet,source:withEnergy(rest,remaining)};
}
export function depositPacket(packet, destination, {speed2=0}={}) {
  const energy=particleEnergy(packet)+energyOf(destination);if(!energyFits(packet,energy)) return null;
  const after=withEnergy(packet,energy);
  if(dynamicsRows[packet.core[0]&255].kind===K.LIQUID) {
    const foam=impactFoam({incoming:packet.core[0]>>>24,resident:0,amount:packet.core[1]&0xffffff,fill:0,speed2});
    after.core[0]=(after.core[0]&0xffffff)|(foam<<24);
  }
  return after;
}
export function fractureMaterial(material, product) {
  const after={core:new Uint32Array(material.core),bank:material.bank};
  after.core[0]=(after.core[0]&0xffffff00)|product;
  return energyFits(after,energyOf(material)) ? withEnergy(after,energyOf(material)) : null;
}
export function chargeEnergy(material) {
  const id=material.core[0]&255,row=dynamicsRows[id];
  const special=specialExplosion(material.core,GUNPOWDER_ENERGY_J);if(special) return special.energyJ;
  return row.energy*(row.kind===K.LIQUID ? (material.core[1]&0xffffff)/65536 : 1);
}
export const pressureEnergy = p => p*p*AIR.edge**3/(2*AIR.rho*AIR.sound**2);
export const addBlastPressure = (p,energy) => Math.sqrt(p*p+2*AIR.rho*AIR.sound**2*energy*0.25/AIR.edge**3);
export function refractDirection(direction,normal,ratio) {
  const dot=direction.reduce((s,x,i)=>s+x*normal[i],0),k=1-ratio*ratio*(1-dot*dot);
  if(k<0) return direction.map((x,i)=>x-2*dot*normal[i]);
  return direction.map((x,i)=>ratio*x-(ratio*dot+Math.sqrt(k))*normal[i]);
}

export function holdVelocities(particles, destination, strength=12, dt=DT) {
  let mass=0;const offset=[0,0,0],mean=[0,0,0];
  for(const p of particles) {
    const m=p.mass;mass+=m;
    for(let a=0;a<3;a++) { offset[a]+=(p.position[a]-destination[a])*m;mean[a]+=p.velocity[a]*m; }
  }
  if(!mass) return [];
  const omega=Math.max(1,Math.min(60,strength)),step=Math.max(0,Math.min(.1,dt)),decay=Math.exp(-omega*step);
  for(let a=0;a<3;a++) mean[a]/=mass;
  const desired=mean.map((v,a)=>(v-omega*(v+omega*offset[a]/mass*CELL_M)*step)*decay);
  return particles.map(p=>desired.map((v,a)=>v+(p.velocity[a]-mean[a])*Math.exp(-2*omega*step)));
}

// Scalar/pressure/velocity twin of one air substep in a closed rectangular
// fixture (air.js step, one V1 step a substep: pressure.js V1_AIR). Faces are
// evaluated in canonical order, as air.js aFlux. substep 0 runs V1's pressure
// spread for the tick. No buoyancy (no gravity in the fixture).
export function airStepReference(cells,dims,{airMode=0,ambientHeat=true,substep=0}={}) {
  const [nx,ny,nz]=dims,dt=DT/AIR.substeps,dx=AIR.edge;
  const vOn=[0,1,4].includes(airMode),pOn=[0,2,4].includes(airMode);
  const input=cells.map(a=>({...a,velocity:vOn?[...a.velocity]:[0,0,0],pressure:pOn?a.pressure:0,heat:ambientHeat?a.heat:0}));
  const idx=(x,y,z)=>x+nx*(z+nz*y);
  const flux=(l,r,axis)=>{
    const courant=Math.max(-1/12,Math.min(1/12,(l.velocity[axis]+r.velocity[axis])*0.5*dt/dx));
    const donor=courant>=0?l:r;
    const vp=[0,1,2].map(i=>donor.velocity[i]*courant);
    const scalars=['heat','gas'].map((field,i)=>{
      if(i===0&&!ambientHeat || i===1&&!pOn&&!vOn) return 0;
      const gradient=r[field]-l[field];
      return courant*donor[field]-(Math.abs(gradient)<AIR.scalarQuantum?0:AIR.diffusion*dt/dx**2*gradient);
    });return {vp,scalars};
  };
  const out=input.map(a=>({...a,velocity:[...a.velocity]}));
  for(let y=0;y<ny;y++)for(let z=0;z<nz;z++)for(let x=0;x<nx;x++) {
    const i=idx(x,y,z),before=input[i],v=[...before.velocity],scalar=[before.heat,before.gas];
    const own=before.pressure,pn=[own,own,own,own,own,own];let lap=0,front=own;
    for(let axis=0;axis<3;axis++)for(const sign of [-1,1]) {
      const q=[x,y,z];q[axis]+=sign;if(q.some((c,a)=>c<0||c>=dims[a]))continue;
      const other=input[idx(...q)],f=sign>0?flux(before,other,axis):flux(other,before,axis);
      for(let a=0;a<3;a++)v[a]-=sign*f.vp[a];
      for(let a=0;a<2;a++)scalar[a]-=sign*f.scalars[a];
      pn[axis*2+(sign>0?0:1)]=other.pressure;lap+=other.pressure-own;front=Math.max(front,other.pressure);
    }
    let pressure=own;
    if(substep===0&&pOn) pressure=Math.min(V1_AIR.pMax,Math.max(V1_AIR.pMin,Math.max(own+V1_AIR.diffuse*lap,front*V1_AIR.front)*V1_AIR.decay));
    for(let a=0;a<3;a++) v[a]=Math.min(V1_AIR.vMax,Math.max(-V1_AIR.vMax,(v[a]-(pn[a*2]-pn[a*2+1])*V1_AIR.accel)*V1_AIR.keep));
    out[i].velocity=vOn?(airMode===4?[...before.velocity]:v):[0,0,0];
    out[i].pressure=pOn?(airMode===4?before.pressure:pressure):0;
    out[i].heat=ambientHeat?scalar[0]:0;out[i].gas=scalar[1];
  }return out;
}

export function bodyCoupledVelocity(request,position,id,tick=0) {
  const row=dynamicsRows[id];if(!row || id===0 || row.kind===K.SOLID || (request.only>=0 && request.only!==id) ||
    position.some((x,a)=>x<request.lo[a] || x>request.hi[a])) return null;
  const radial=[position[0]-(request.lo[0]+request.hi[0])/2,position[2]-(request.lo[2]+request.hi[2])/2];
  const len=Math.hypot(...radial);let outward;
  if(len>1e-6) outward=radial.map(x=>x/len);
  else { const id=stableId(position.map(Math.floor),tick,0x424f4459),r=(hash32(id^Math.imul(tick,2654435761)^31)>>>8)/16777216;
    outward=[Math.cos(r*2*Math.PI),Math.sin(r*2*Math.PI)]; }
  const ahead=request.ahead??[0,0],direction=[outward[0]+ahead[0],request.lift??0,outward[1]+ahead[1]];
  const norm=Math.max(1e-6,Math.hypot(...direction)),push=row.kind===K.POWDER?request.pushPowder:request.pushFluid;
  return request.velocity.map((v,a)=>v+direction[a]/norm*push);
}

// Native R5–R8/R11 contact rules. Content remains elements.js/electricity.js.
// A restricted scalar JS kernel is emitted as WGSL (shaders/v2/contact.js), so
// CPU tests exercise the same branches, not an independently drifting port.
import { ELEMENTS, E, K, REACTIONS, mechanisms } from '../elements.js';
import { SPARK_COST, WIRE, CONDUCTS } from '../electricity.js';
import { PHYS, NOMINAL_STEP_RATE } from '../physics.js';
import { fallVelocity } from './fall.js';
import { CELL_M } from '../scale.js';
import { EMITTERS } from '../rays.js';

import { FUEL_Q } from './layout.js';
import { PHASE_ROWS, phaseTemperatureQ, phaseOffsetEnergy, phaseLatentEnergy, encodePhaseEnergy } from './phase.js';
export const ENERGY_SCALE = 256 * 65536;
export const CONTACT_FULL = 65536;
export const CONTACT_ELEMENT_COUNT = ELEMENTS.length;
export const LIFE_SCALE = FUEL_Q;
export const CONTACT_HZ = 60;
// Historical age constants remain for old fixtures; contacts use stored speed
// in cells/tick, never age times the currently configured gravity.
export const CONTACT_G_TICK = 19.6 / CELL_M / CONTACT_HZ ** 2;
export const DUST_MIN_FALL_SPEED = PHYS.DUST_LIFT_V * NOMINAL_STEP_RATE / CONTACT_HZ; // cells/tick
export const DUST_MIN_FALL_AGE = Math.ceil(PHYS.DUST_LIFT_V * NOMINAL_STEP_RATE / CONTACT_HZ / CONTACT_G_TICK);
export const CONTACT_REQUEST = { DETONATE: 1, GAS: 2, NEUTRON: 4 };
const q = T => Math.round((T + 273.25) * 4);
const cap = ELEMENTS.map(e => Math.max(1, Math.round(e.cap * 64)));
const offsets = PHASE_ROWS.map(r => r.offset);

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
export const CONTACT_ROWS = ELEMENTS.map(e => {
  let hot = e.hot, cold = e.cold;
  if (e.key === 'WATER' || e.key === 'CLOUD') {
    hot = { T: 100, into: 'STEAM', latent: PHYS.L_BOIL, puff: 1700 };
    cold = { T: 0, into: e.key === 'CLOUD' ? 'SNOW' : 'ICE', latent: PHYS.L_FUSE };
  }
  if (e.key === 'ICE' || e.key === 'SNOW') hot = { T: 0, into: 'WATER', latent: PHYS.L_FUSE };
  if (e.key === 'STEAM') cold = { T: 100, into: 'WATER', latent: PHYS.L_BOIL };
  return {
    kind: e.kind, capacity: cap[e.id], offset: offsets[e.id], cond: e.cond,
    density: e.dens, spawnQ: q(e.temp), spawnLife: e.id === E.SINGULARITY ? Math.round(e.life * 256) : Math.min(65535, Math.round(e.life * LIFE_SCALE)),
    hotQ: hot ? q(hot.T) : 65536, hotOut: hot ? spec(hot.into) : -1,
    hotL: PHASE_ROWS[e.id].hotLatent, hotGas: +(!!hot?.puff), hotOf: E[hot?.of] ?? e.id,
    coldQ: cold ? q(cold.T) : -1, coldOut: cold ? spec(cold.into) : -1,
    coldL: PHASE_ROWS[e.id].coldLatent, coldOf: E[cold?.of] ?? e.id,
    meltQ: e.melt ? q(e.melt) : 65536, meltInto: E[e.meltInto] ?? e.id,
    igniteQ: e.ignite ? q(e.ignite) : 65536, flashQ: e.flash ? q(e.flash) : 65536,
    burn: Math.round(e.burnRate * LIFE_SCALE * 4), heat: Math.round(e.burnHeat * 256 * 4), flameQ: q(e.flameT),
    ash: +e.ash, blast: +!!e.blast, blastAir: +!!e.blast?.air, blastChance: 1 - (1 - (e.blast?.flame ?? 0)) ** 8,
    acid: +e.acid, edible: +(e.kind !== K.EMPTY && e.kind !== K.GAS && !e.acidProof),
    fizz: +(e.fizz > 0), bed: +e.mossBed, rots: +e.rots, singFood: +(e.id !== E.EMPTY && !e.singProof),
    conductor: +CONDUCTS[e.id], cost: SPARK_COST[e.id], wire: +WIRE[e.id],
    emitter: (EMITTERS[e.key] ?? 0) * 4,
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
}));
const mech = mechanisms();
export const CONTACT_RX_INDEX = mech.lookup;

export const ctI = value => Math.trunc(value) + 0;
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
export function ctExhaust(input, random) {
  let id = E.CO2;
  if (ctRow(input.id).ash !== 0 && random < 0.5) id = E.ASH;
  let candidate = ctNew(id, input.tq, 65536);
  candidate.bank = input.bank;
  // A sub-cell fuel parcel cannot create a full-cell residue at the expense
  // of free heat. Below that mass/enthalpy budget it leaves carrier air.
  if (ctLess(ctEnergy(input), ctEnergy(candidate))) id = E.EMPTY;
  let out = ctDecay(input, id);
  out.request = out.request | 2;
  return out;
}
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
export function ctPhase(input, surface, random) {
  if (ctRow(input.id).kind === 3 && input.fill === 0) return ctConvert(input, E.EMPTY, 0);
  let c = ctSetEnergy(input, ctEnergy(input));
  const r = ctRow(c.id);
  if (r.hotOut >= 0 && ctPastPhase(c, true)) {
    c = ctConvert(c, ctProduct(r.hotOut, random), r.hotOf);
    if (r.hotGas !== 0) {
      if (c.id !== input.id) c.request = c.request | 2;
      else if (c.pending >= 0) c.pendingGas = 1;
    }
    return c;
  }
  if (r.coldOut >= 0 && ctPastPhase(c, false)) {
    let id = ctProduct(r.coldOut, random);
    if (c.id === E.STEAM && surface === 0) id = E.CLOUD;
    return ctConvert(c, id, r.coldOf);
  }
  if (c.tq > r.meltQ) return ctConvert(c, E.LAVA, r.meltInto);
  if (c.id === E.LAVA) {
    let of = c.ctype;
    if (of <= 0 || of >= CONTACT_ELEMENT_COUNT) of = E.STONE;
    if (c.tq < ctRow(of).meltQ - 600) return ctConvert(c, of, 0);
  }
  return c;
}
export const ctLife = c => c.life / (c.id === E.SINGULARITY ? 256 : 2048);
export function ctWithLife(c, value) { return { ...c, life: Math.round(value * (c.id === E.SINGULARITY ? 256 : 2048)) }; }
export function ctNuclearId(c) {
  if (c.id === E.LAVA && c.ctype > 0 && c.ctype < CONTACT_ELEMENT_COUNT) return c.ctype;
  return c.id;
}
export function ctLive(c) { return ctRow(c.id).conductor !== 0 && c.spark % 9 > 4; }
export function ctConductsInto(from, to) {
  if (from === E.NSCN && to === E.PSCN) return false;
  if (to === E.SWITCH && (from === E.PSCN || from === E.NSCN)) return false;
  if (from === E.SWITCH && (to === E.PSCN || to === E.NSCN || to === E.WATER)) return false;
  return true;
}
export function ctCloneable(id) { return id !== E.EMPTY && id !== E.WALL && id !== E.CLONE && id !== E.PCLN && id !== E.PSCN && id !== E.NSCN; }
export function ctElectric(input, ns, random) {
  let c = ctCopy(input);
  const r = ctRow(c.id);
  const life0 = ctLife(c);
  let off = false;
  let on = false;
  let p = false;
  let n = false;
  let hot = false;
  let dc = false;
  let best = 0;
  for (let k = 0; k < 3; k++) {
    const b = ns[k];
    if (b.valid === 0) continue;
    if (b.id === c.id) { off = off || (ctLife(b) > 0 && ctLife(b) < 10); on = on || ctLife(b) >= 10; }
    if (ctLive(b)) { p = p || b.id === E.PSCN; n = n || b.id === E.NSCN; }
    hot = hot || (b.id !== E.EMPTY && b.id !== E.TSNS && ctRow(b.id).wire === 0 && b.tq > c.tq);
    dc = dc || b.id === E.BATTERY;
    if (b.id === E.BATTERY || (b.id === E.TSNS && ctLife(b) >= 1)) best = 400;
    else if (ctLive(b) && ctConductsInto(b.id, c.id)) best = Math.max(best, ctDiv(b.spark, 9));
  }
  if (c.id === E.SWITCH || c.id === E.PCLN) {
    if (ctLife(c) > 0 && ctLife(c) !== 10) c = ctWithLife(c, ctLife(c) - 1);
    if (life0 === 10 && off) c = ctWithLife(c, 9);
    else if (life0 === 0 && on) c = ctWithLife(c, 10);
    if (p && life0 < 10) c = ctWithLife(c, 10);
    if (n) c = ctWithLife(c, 9);
    if (ctLife(c) > 0 && ctLife(c) !== 10) c.busy = 1;
  }
  if (c.id === E.TSNS) { c = ctWithLife(c, 0); if (hot) c = ctWithLife(c, 1); if (ctLife(c) !== life0) c.busy = 1; }
  if (r.conductor === 0) return c;
  let ph = c.spark % 9;
  let level = ctDiv(c.spark, 9);
  if (c.id === E.LAMP) {
    if (dc) { c.spark = 81; return c; }
    if (level === 9) level = 8;
  }
  if (ph > 0) {
    ph--;
    if (ph <= 4) {
      if (c.id !== E.LAMP) level = 0;
      else if (ph === 4) level = 8;
      else level = Math.max(0, level - 1);
    }
  } else if (c.id !== E.SWITCH || life0 === 10) {
    if (c.id === E.LAMP) level = Math.max(0, level - 1);
    if (best > 0) {
      let cost = ctI(r.cost);
      if (random < r.cost - ctF(cost)) cost++;
      cost = Math.min(cost, best);
      const joule = ctI(ctF(cost) * 33554.432);
      c = ctHeat(c, joule);
      c.source = ctAdd(c.source, ctSigned(joule));
      if (best > cost) { ph = 8; level = best - cost; }
    }
  }
  c.spark = ph + 9 * level;
  if (ph > 0 || (c.id === E.LAMP && level > 0)) c.busy = 1;
  return c;
}

export function ctStep(input, ns, seed) {
  return ctStepAtmosphere(input, ns, seed, 0, 0, 0, 0);
}

// Only atmosphere/exposure uses all six faces. Heat, reactions, phase and
// sampled contacts retain the three owned partners and their calibration.
export function ctStepAtmosphere(input, ns, seed, outAir, outOxygen, outCo2, outGas) {
  let c = ctCopy(input);
  if (c.done !== 0) return c;
  let air = 0;
  let oxygen = 0;
  let fire = 0;
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
  let fuseTouch = false;
  let fuseEnd = true;
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
    if (b.id === E.FIRE || (br.burn > 0 && b.burning !== 0)) fire++;
    // TPT FIRE.cpp separates contact ignition from bulk thermal transition
    // (upstream uses Flammable/1000). Our hot front uses existing igniteQ,
    // not a new rate; tq is decoded, post-pair/pre-self snapshot temperature.
    hotFront = hotFront || (b.done === 0 && b.pending < 0 && (b.request & 5) === 0 && b.tq >= r.igniteQ && b.life > 0 && ((b.id === E.FIRE && b.tq >= 2493) || (br.burn > 0 && b.burning !== 0)));
    if (br.kind === 0 || br.kind === 4) gas++;
    else surface++;
    if (b.id === E.CO2) co2++;
    if (b.id === E.CLOUD) cloud++;
    if (b.id === E.PLANT) plant++;
    if (b.id === E.FUNGUS && b.ctype > 0) fungus++;
    if (b.id === E.MOSS && b.ctype > 0) moss++;
    if (br.bed !== 0) bed++;
    if (b.id === E.WATER || b.id === E.SALTWATER) damp = 4;
    if (b.id === E.MOSS || b.id === E.FUNGUS) damp = Math.max(damp, b.ctype - 1);
    if (b.id === E.DUST) dust++;
    hotTouch = hotTouch || (br.kind !== 0 && br.kind !== 4 && b.tq >= r.igniteQ);
    fuseTouch = fuseTouch || (b.id === E.FUSE && b.life <= 102);
    fuseEnd = fuseEnd && !(b.id === E.FUSE && b.life > c.life);
    if (b.id === E.CLONE || (b.id === E.PCLN && ctLife(b) === 10)) clone = Math.max(clone, b.ctype);
    if (ctCloneable(b.id)) growOf = b.id;
    voidTouch = voidTouch || b.id === E.VOID;
  }
  const fullAir = air + outAir;
  const fullOxygen = oxygen + outOxygen;
  const fullCo2 = co2 + outCo2;
  const fullGas = gas + outGas;
  const smothered = fullCo2 > 0 && ctF(fullCo2) >= 0.3 * ctF(fullGas);
  const exposed = fullAir + fullOxygen > 0;
  const random = ctRoll(seed, 1);
  c = ctElectric(c, ns, ctRoll(seed, 2));
  c = ctPhase(c, surface, ctRoll(seed, 3));
  if (c.id !== input.id || c.pending >= 0) return c;
  if (voidTouch && c.id !== E.EMPTY && r.kind !== 1) return ctDecay(c, E.EMPTY);
  const emitter = ctRow(ctNuclearId(c)).emitter;
  if (emitter > 0) { c.busy = 1; if (ctRoll(seed, 4) < emitter) c.request = c.request | 4; }
  if (r.blast !== 0) {
    const canBlast = r.blastAir === 0 || exposed || fire > 0;
    if (canBlast && (c.tq >= r.igniteQ || hotTouch || (fire > 0 && r.blastChance > 0))) {
      c.busy = 1;
      if (c.tq >= r.igniteQ || hotTouch || random < r.blastChance) c.request = c.request | 1;
    }
    return c;
  }
  if (c.id === E.FIRE || c.id === E.SMOKE || c.id === E.PLASMA) {
    let decrement = 6;
    if (c.id === E.FIRE) decrement = 46;
    if (c.id === E.PLASMA) decrement = 69;
    c.life = Math.max(0, c.life - decrement);
    c.busy = 1;
    if (c.life === 0 || (c.id === E.FIRE && (smothered || !exposed || c.tq < 2493))) {
      let id = E.EMPTY;
      if (c.id === E.FIRE) id = E.SMOKE;
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
          if (c.life === 0) return ctExhaust(c, random);
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
          if (c.life === 0) return ctExhaust(c, random);
        }
      }
    }
  }
  if (c.id === E.FUSE) {
    if (c.life >= 2048 && (c.tq >= r.igniteQ || hotTouch || fuseTouch || fire > 0)) c.life = 2047;
    if (c.life < 2048) {
      c.busy = 1;
      c.life = Math.max(0, c.life - 7);
      if (fuseEnd && c.life <= 102) {
        const beforeHeat = ctEnergy(c);
        c = ctHeatTo(c, 9893, 2147483000);
        c.source = ctAdd(c.source, ctSub(ctEnergy(c), beforeHeat));
      }
      if (c.life === 0) {
        let id = E.SMOKE;
        if (fuseEnd) id = E.FIRE;
        return ctConvert(c, id, 0);
      }
    }
  }
  if (c.id === E.WATER && plant > 0) { c.busy = 1; if (random < 0.048 * ctF(plant)) return ctCreate(c, E.PLANT, c.tq); }
  if (r.rots !== 0 && fungus > 0 && c.tq < 1493) { c.busy = 1; if (random < 0.0008 * ctF(fungus)) return ctCreate(c, E.FUNGUS, c.tq); }
  if (c.id === E.MOSS || c.id === E.FUNGUS) {
    const previous = c.ctype;
    c.ctype = 0;
    if (c.tq < 1493) c.ctype = Math.max(0, damp);
    if (c.ctype !== previous) c.busy = 1;
  }
  if ((c.id === E.CLONE || c.id === E.PCLN) && c.ctype === 0 && growOf > 0) { c.ctype = growOf; c.busy = 1; }
  if (c.id === E.EMPTY) {
    if (clone > 0 && clone < CONTACT_ELEMENT_COUNT) { c.busy = 1; if (random < 0.48) return ctCreate(c, clone, ctRow(clone).spawnQ); }
    if (moss > 0 && bed > 0) { c.busy = 1; if (random < 0.0008 * ctF(moss)) return ctCreate(c, E.MOSS, c.tq); }
  }
  if (c.id === E.CLOUD) {
    if (cloud >= 2 || air >= 2) {
      c.busy = 1;
      if (cloud >= 2 && random < 0.00032 * ctF(cloud * 2 - 3)) return ctConvert(c, E.WATER, 0);
      const temp = ctF(c.tq) * 0.25 - 273.25;
      const es = Math.exp(17.625 * (temp / Math.max(1, temp + 243.04) - 20 / 263.04));
      if (air >= 2 && random < 0.00024 * ctF(air * 2 - 3) * es) return ctDecay(c, E.EMPTY);
    }
    // Use real stored speed: gravity changes must not rewrite contact inertia.
    for (let k = 0; k < 3; k++) {
      if (c.tq <= 1093 && ns[k].valid !== 0 && ns[k].id === E.SNOW && ns[k].fallSpeed > 0.0) {
        c.busy = 1;
        if (random < Math.min(ns[k].fallSpeed, 1.0 / 6.0)) c.ctype = Math.min(60, c.ctype + 1);
      }
    }
  }
  if (c.id === E.DUST && c.fallSpeed >= DUST_MIN_FALL_SPEED && dust > 0 && air > 0 && (c.tq >= r.igniteQ || hotTouch || fire > 0)) { c.request = c.request | 1; c.busy = 1; }
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
  [ctDecay, ['CTCell', 'i32'], 'CTCell'], [ctExhaust, ['CTCell', 'f32'], 'CTCell'], [ctCreate, ['CTCell', 'i32', 'i32'], 'CTCell'],
  [ctDensity, ['CTCell'], 'f32'], [ctAmount, ['CTCell'], 'i32'], [ctCapacity, ['CTCell'], 'i32'], [ctHeat, ['CTCell', 'i32'], 'CTCell'], [ctHeatTo, ['CTCell', 'i32', 'i32'], 'CTCell'], [ctConvert, ['CTCell', 'i32', 'i32'], 'CTCell'],
  [ctTemperatureRemainder, ['CTCell'], 'f32'], [ctFlux, ['CTCell', 'CTCell'], 'i32'], [ctPhase, ['CTCell', 'i32', 'f32'], 'CTCell'],
  [ctNuclearId, ['CTCell'], 'i32'], [ctLive, ['CTCell'], 'bool'], [ctConductsInto, ['i32', 'i32'], 'bool'], [ctCloneable, ['i32'], 'bool'],
  [ctElectric, ['CTCell', 'array<CTCell, 3>', 'f32'], 'CTCell'],
  [ctStepAtmosphere, ['CTCell', 'array<CTCell, 3>', 'i32', 'i32', 'i32', 'i32', 'i32'], 'CTCell'],
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
export const energyCapacity = (id, fill = CONTACT_FULL) => ctCapacity(ctNew(id, 0, fill));
export const energyOffset = (id, fill = CONTACT_FULL) => ctOffset(ctNew(id, 0, fill));
export const materialEnergy = (core, bank = 0) => ctEnergy(unpackContact(core, bank));
export const setMaterialEnergy = (core, energy) => packContact(ctSetEnergy(unpackContact(core), energy), core);
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
  if (a0.pendingGas !== 0) pair.a.request = pair.a.request | 2;
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
  if (row.gas !== 0) { pair.a.request = pair.a.request | 2; pair.b.request = pair.b.request | 2; }
  return pair;
}
export function ctAcid(a0, b0, seed) {
  let a = ctCopy(a0);
  let b = ctCopy(b0);
  if (ctRow(a.id).acid === 0 || ctRow(b.id).edible === 0 || a.done !== 0 || b.done !== 0) return ctPairValue(a, b, 0);
  a.busy = 1; b.busy = 1;
  if (ctRoll(seed, 13) >= 0.24) return ctPairValue(a, b, 0);
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
export function ctPlume(a0, b0, seed, up) {
  let a = ctCopy(a0);
  let b = ctCopy(b0);
  if ((a.request & 5) !== 0 || ctRow(a.id).burn === 0 || a.burning === 0 || a.life === 0 || up === 0 || (b.id !== E.EMPTY && b.id !== E.OXYGEN)) return ctPairValue(a, b, 0);
  a.busy = 1; b.busy = 1;
  if (ctRoll(seed, 16) >= 0.25) return ctPairValue(a, b, 0);
  let id = E.FIRE;
  if (ctRoll(seed, 17) < 0.2) id = E.SMOKE;
  else if (ctRoll(seed, 17) < 0.4) id = E.CO2;
  const initial = ctAdd(ctEnergy(a), ctEnergy(b));
  const oxy = b.id === E.OXYGEN;
  const fuel = ctRow(a.id);
  // Plume formation/heat is not free. Debit finite fuel at the same energy
  // per fuel unit as this material's burnHeat/burnRate content ratio.
  const perFuel = ctDiv(fuel.heat * 65536, Math.max(1, fuel.burn));
  if (perFuel <= 0) return ctPairValue(a0, b0, 0);
  const plumeQ = Math.min(fuel.flameQ, Math.max(2493, ctI(ctF(fuel.flameQ - 1093) * 0.85) + 1093));
  b = ctInherit(ctNew(id, plumeQ, 65536), b);
  if (oxy && id === E.FIRE) b.ctype = E.OXYGEN;
  let wanted = ctAdd(ctEnergy(a), ctEnergy(b));
  let spend = 0;
  if (ctLess(initial, wanted)) spend = ctCeilEnergy(ctSub(wanted, initial), perFuel);
  if (spend > a.life && id === E.FIRE) {
    b = ctInherit(ctNew(id, 2493, 65536), b0);
    if (oxy) b.ctype = E.OXYGEN;
    wanted = ctAdd(ctEnergy(a), ctEnergy(b));
    spend = 0;
    if (ctLess(initial, wanted)) spend = ctCeilEnergy(ctSub(wanted, initial), perFuel);
  }
  spend = Math.min(spend, a.life);
  a.life = a.life - spend;
  const released = ctMul(spend, perFuel);
  const total = ctAdd(initial, released);
  // The gas burns above its fuel; do not instantly average their temperatures
  // (that turns a whiskey vapour flame into sub-350 C smoke). The paid heat
  // goes into the emitted gas, including the exact integer payment remainder.
  if (ctLess(total, wanted)) {
    // Vaporization may cool the fuel, but cannot mint heat or borrow energy
    // below its zero-kelvin sensible bound. All remaining chemical fuel is
    // spent before a terminal plume can borrow this existing thermal energy.
    const donorEnergy = ctSub(total, ctEnergy(b));
    if (ctLess(donorEnergy, ctOffset(a)) || !ctFits(a, donorEnergy)) return ctPairValue(a0, b0, 0);
    a = ctSetEnergy(a, donorEnergy);
  } else {
    const gasEnergy = ctSub(total, ctEnergy(a));
    if (!ctFits(b, gasEnergy)) return ctPairValue(a0, b0, 0);
    b = ctSetEnergy(b, gasEnergy);
  }
  if (b.tq > fuel.flameQ) return ctPairValue(a0, b0, 0);
  a.source = ctAdd(a.source, released);
  b.request = b.request | 2; b.done = 1; b.busy = 1;
  return ctPairValue(a, b, 1);
}
CONTACT_KERNEL.push(
  [ctBalance, ['CTCell', 'CTCell', 'vec2u', 'i32'], 'CTPair'],
  [ctResolvePhase, ['CTCell', 'CTCell'], 'CTPair'],
  [ctReaction, ['CTCell', 'CTCell', 'i32'], 'CTPair'],
  [ctAcid, ['CTCell', 'CTCell', 'i32'], 'CTPair'],
  [ctSwallow, ['CTCell', 'CTCell', 'i32'], 'CTPair'],
  [ctPlume, ['CTCell', 'CTCell', 'i32', 'i32'], 'CTPair'],
);

export const CONTACT_FACES = Array.from({ length: 8 }, (_, i) => [i ^ 1, i ^ 2, i ^ 4]);
export const CONTACT_PAIRS = CONTACT_FACES.flatMap((ns, i) => ns.filter(j => j > i).map(j => [i, j]));
export const CONTACT_POSITIONS = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1]);
// Optional per-cell [air, oxygen, CO2, gas] counts must be frozen before any
// block writes. The standalone eight-cell patch defaults to a closed outside.
export function contactReference(cores, banks, tick = 0, positions = CONTACT_POSITIONS, pending = new Uint32Array(8), valid = Array(8).fill(true), outside = Array.from({ length: 8 }, () => [0, 0, 0, 0])) {
  let cells = cores.map((core, i) => {
    const c = unpackContact(core, banks[i]); c.request = pending[i]; c.valid = +!!valid[i];
    if (c.request & 5) { c.done = 1; c.busy = 1; }
    return c;
  });
  const requests = new Uint32Array(pending), busy = [];
  const seedAt = i => (Math.imul(positions[i][0], 73856093) ^ Math.imul(positions[i][1], 19349663) ^ Math.imul(positions[i][2], 83492791) ^ Math.imul(tick, 2654435761)) | 0;
  for (const [i, j] of CONTACT_PAIRS) {
    if (!valid[i] || !valid[j]) continue;
    const flux = ctFlux(cells[i], cells[j]);
    if (flux) { cells[i] = ctHeat(cells[i], flux); cells[j] = ctHeat(cells[j], -flux); cells[i].busy = 1; cells[j].busy = 1; }
    let pair = ctReaction(cells[i], cells[j], seedAt(i) ^ j);
    if (!pair.changed) pair = ctAcid(pair.a, pair.b, seedAt(i) ^ j);
    if (!pair.changed) { const reverse = ctAcid(pair.b, pair.a, seedAt(i) ^ j); pair = ctPairValue(reverse.b, reverse.a, reverse.changed); }
    if (!pair.changed) pair = ctSwallow(pair.a, pair.b, seedAt(i) ^ j);
    if (!pair.changed) { const reverse = ctSwallow(pair.b, pair.a, seedAt(i) ^ j); pair = ctPairValue(reverse.b, reverse.a, reverse.changed); }
    cells[i] = pair.a; cells[j] = pair.b;
  }
  const snapshot = cells.map(ctCopy);
  cells = cells.map((c, i) => valid[i] ? ctStepAtmosphere(c, CONTACT_FACES[i].map(j => snapshot[j]), seedAt(i), ...outside[i]) : c);
  for (const [i, j] of CONTACT_PAIRS) {
    if (!valid[i] || !valid[j]) continue;
    let pair = ctResolvePhase(cells[i], cells[j]);
    if (!pair.changed) { const reverse = ctResolvePhase(pair.b, pair.a); pair = ctPairValue(reverse.b, reverse.a, reverse.changed); }
    cells[i] = pair.a; cells[j] = pair.b;
  }
  // Emissions never cross disjoint block ownership. Burn state was evaluated
  // against this block's snapshot, including oxygen and CO2, before emission.
  for (const [i, j] of CONTACT_PAIRS) {
    if (!valid[i] || !valid[j]) continue;
    const up = +(positions[j][1] > positions[i][1]);
    const pair = ctPlume(cells[i], cells[j], seedAt(i) ^ j, up);
    cells[i] = pair.a; cells[j] = pair.b;
  }
  for (let i = 0; i < 8; i++) {
    if (!valid[i]) continue;
    const out = packContact(cells[i], cores[i]);
    cores[i] = out.core; banks[i] = out.bank; requests[i] = cells[i].request;
    if (cells[i].busy) busy.push(i);
  }
  return { cores, banks, requests, busy, sources: cells.map(c => c.source), sinks: cells.map(c => c.sink) };
}

// R5 ambient exchange is a boundary condition, never a global pull. The owner
// counts exposed open side/top faces (not the floor or closed/periodic edges).
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

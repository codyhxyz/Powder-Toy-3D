// CPU-only exact paid native hearth commits, real composed WGSL validation, and
// the authored fixed-cell thermal patch. No GPU/browser/server. Run with Node's
// --js-float16array flag on Node versions that require it for Industry imports.
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import { HEARTH_IGNITION_TARGET, HEARTH_MAX_FUEL_TEMPERATURE, hearthRegions } from '../../src/industry/hearth.js';
import { HEARTH_ENERGY_PER_QUANTUM as EQ, nativeHearthBudget, nativeHearthWGSL } from '../../src/v2/nativeHearth.js';
import { FUEL_Q, capacityQ, cid, cTq, energyOf, makeMaterial, payloadOf, withEnergy, withPayload } from '../../src/v2/layout.js';
import { encodeV2State, decodeV2State, stateLengths } from '../../src/v2/state.js';
import { nativeIndustryEvaluateWGSL, nativeIndustryPlanWGSL, NATIVE_INDUSTRY_COMMIT } from '../../src/v2/industry.js';
import { hearthUpdateWGSL } from '../../src/shaders/hearth.js';
import { industryUpdateWGSL } from '../../src/shaders/industry.js';
import { LEGACY_STEP_HZ, LEGACY_STEPS_PER_TICK } from '../../src/v2/host.js';
import { buildExceptions } from '../../src/lab/preservation/exceptions.js';
import * as C from '../../src/v2/contact.js';
import { offsetOf } from '../../src/v2/physics.js';
import { assertNaga } from './wgsl-grouping.mjs';

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const at = (m, temperature) => energyOf({ core: m.core, bank: 0 })
  + BigInt(capacityQ(m.core)) * BigInt(Math.round((temperature + 273.25) * 4) - cTq(m.core));
const fuel = (id, temperature, payload, bank = 0) => ({ ...withPayload(makeMaterial(id, temperature), payload), bank });
const trueTemperature = m => cTq(m.core) / 4 - 273.25 + m.bank / capacityQ(m.core) / 4;
function committed(m, dt, authorized = true) {
  const copy = { core: new Uint32Array(m.core), bank: m.bank };
  const result = nativeHearthBudget(m, dt, authorized), out = result.material;
  equal(m, copy, 'input is immutable');
  equal(payloadOf(m.core) - payloadOf(out.core), result.debit, 'committed fuel equals selected integer debit');
  equal(energyOf(out) - energyOf(m), BigInt(result.debit) * EQ, 'COMMITTED energy equals committed fuel times exact Eq');
  equal(result.energyGain, energyOf(out) - energyOf(m), 'reported gain is committed gain');
  check(result.debit >= 0 && result.debit <= payloadOf(m.core), 'fuel cannot underflow');
  if (result.debit) check(energyOf(out) <= at(out, HEARTH_MAX_FUEL_TEMPERATURE), 'paid heat never exceeds true ceiling, including bank');
  else equal(out, m, 'no debit means no change to either heat or fuel');
  equal(out.core[0] & 0xff0000ff, m.core[0] & 0xff0000ff, 'id and flags retained');
  equal(out.core[1] & 0xffff0000, m.core[1] & 0xffff0000, 'ctype retained');
  equal(Array.from(out.core.slice(2)), Array.from(m.core.slice(2)), 'seed/other state retained');
  return result;
}

equal(EQ, 2457600000n, 'one 1/2048 life quantum has exact native energy');
for (const id of [E.COAL, E.BROKENCOAL]) {
  const cold = committed(fuel(id, 20, FUEL_Q), 1 / 60);
  equal(cold.debit, 2, 'cold sufficient starter ceils to two quanta');
  check(trueTemperature(cold.material) >= HEARTH_IGNITION_TARGET && trueTemperature(cold.material) < 754,
    'paid starter intentionally overshoots 550 C minimum to about 752.64 C');
  equal(committed(fuel(id, 20, 1), 1 / 60).debit, 1, 'partial starter spends only its one saved quantum');
  equal(committed(fuel(id, 20, 0), 1 / 60).debit, 0, 'exhausted starter cannot invent heat');
  equal(committed(fuel(id, 2190, FUEL_Q), 1 / 60).debit, 0, 'original 2190 C reproduction: neither heat nor fuel changes');
  for (const payload of [0, 1, 2, FUEL_Q, 65534, 65535]) {
    for (const t of [20, 449.75, 450, 1000, 2190, 2199.75, 2200]) {
      const cap = capacityQ(makeMaterial(id).core);
      for (const bank of [0, 1, cap - 1, 2147483647, -2147483648]) {
        for (const dt of [1 / 240, LEGACY_STEPS_PER_TICK / LEGACY_STEP_HZ, 1e-9, 0.1, 10]) {
          committed(fuel(id, t, payload, bank), dt);
        }
      }
    }
  }
  const warm = fuel(id, 1000, FUEL_Q);
  for (const dt of [0, -1, NaN, Infinity, -Infinity, 1e30, Number.MAX_VALUE]) {
    equal(committed(warm, dt).material, warm, 'zero/invalid dt cannot heat or spend');
  }
  equal(committed(warm, 0.1).material, committed(warm, 10).material, 'elapsed seconds are capped, never multiplied by four again');
  equal(committed(warm, 1 / 60, false).material, warm, 'unauthorized/disabled proposal stays exact');
  const ceiling = at(warm, 2200);
  for (const room of [EQ - 1n, EQ, EQ + 1n, 2n * EQ - 1n, 2n * EQ]) {
    const edge = withEnergy(warm, ceiling - room);
    const result = committed(edge, 0.1);
    equal(result.debit, Number(room / EQ), 'exact one/two-quantum headroom edges include bank remainder');
  }
  const positiveBank = fuel(id, 2200, 65535, Math.floor(capacityQ(warm.core) / 2));
  equal(committed(positiveBank, 0.1).material, positiveBank, 'decoded 2200 C plus bank has no true headroom');
}
for (const id of [E.SCRAP, E.WOOD, E.WATER, E.EMPTY]) {
  const m = makeMaterial(id);
  equal(committed(m, 1 / 60).material, m, 'non-fuel paths are unchanged');
}
// Quantized rate is a per-call upper bound, not arbitrary-dt continuous equality.
const rateQ = (id, dt) => Math.floor(Math.fround(Math.fround(Math.fround(Math.fround(ELEMENTS[id].burnRate) * 240) * Math.fround(dt)) * FUEL_Q));
equal(rateQ(E.COAL, 1 / 60), 4, 'normal native tick coal allowance');
equal(rateQ(E.BROKENCOAL, 1 / 60), 13, 'normal native tick broken-coal allowance');
check(2 * rateQ(E.BROKENCOAL, 1 / 120) < rateQ(E.BROKENCOAL, 1 / 60), 'split dt may discard subquantum allowance (no hidden debt)');

// Adapt the existing <=2^31 divisor ABI without a new division algorithm.
const mask = 0xffffffffn, divisor = EQ / 2n;
for (const q of [0n, 1n, 2n, 7n, 65535n]) for (const rem of [0n, 1n, EQ / 2n, EQ - 1n]) {
  const e = q * EQ + rem, lo = e & mask, hi = e >> 32n;
  const half = ((hi >> 1n) << 32n) | (lo >> 1n) | ((hi & 1n) << 31n);
  equal(half / divisor, e / EQ, 'limb shift plus existing half-Eq divisor floors exactly');
  equal(half / divisor + (e % EQ ? 1n : 0n), (e + EQ - 1n) / EQ, 'ceil uses exact full-energy remainder');
}

function reload(m) {
  const dims = [16, 8, 8], lengths = stateLengths(dims, true);
  const state = { dims, tick: 4, frame: 8, paints: 0, acc: 0, certified: true, writtenSinceTick: true, mode: 'v2' };
  for (const [key, length] of Object.entries(lengths)) state[key] = new Uint32Array(length);
  for (let i = 0; i < state.cells.length; i += 4) state.cells.set(makeMaterial(E.EMPTY).core, i);
  state.cells.set(m.core); state.aux[0] = m.bank;
  const saved = decodeV2State(encodeV2State(state), dims);
  return { core: saved.cells.slice(0, 4), bank: saved.aux[0] | 0 };
}
for (const id of [E.COAL, E.BROKENCOAL]) {
  let uninterrupted = committed(fuel(id, 20, 65535, 1), 1 / 60).material;
  let continued = reload(uninterrupted);
  equal(continued, uninterrupted, 'native save preserves exact fuel and bank');
  for (let i = 0; i < 12; i++) {
    // Controlled exact cooling, not a conduction model.
    uninterrupted = withEnergy(uninterrupted, energyOf(uninterrupted) - EQ);
    continued = withEnergy(continued, energyOf(continued) - EQ);
    uninterrupted = committed(uninterrupted, 1 / 60).material;
    continued = committed(continued, 1 / 60).material;
    equal(continued, uninterrupted, 'save/reload continuation needs no fractional debt field');
  }
}

const g = { nx: 32, ny: 32, nz: 32 }, evaluate = nativeIndustryEvaluateWGSL(g), plan = nativeIndustryPlanWGSL(g);
check(evaluate.includes(hearthUpdateWGSL) && evaluate.includes(industryUpdateWGSL), 'legacy V1 fragment and guarded Industry body remain verbatim');
check(evaluate.indexOf('if (!machineEnabled(P.guardBase') < evaluate.indexOf('hearthUpdate(p, a, b, P.corner'),
  'disabled or damaged base/control guard precedes the only hearth proposal');
check(evaluate.includes('if (eid(fetchA(p)) != material) { return false; }')
  && evaluate.includes('return industryControlActive(port);'), 'actual evaluator retains damaged-base rejection and live control-port check');
check(plan.includes(nativeHearthWGSL), 'actual native Industry commit opts in');
check(plan.includes(`if(${NATIVE_INDUSTRY_COMMIT.material.handles}) { after=${NATIVE_INDUSTRY_COMMIT.material.update}; }\nelse { after=forceHeat(before,r);`),
  'handled zero-quantum/rejected update cannot fall through to generic heat OR life merging');
check(plan.includes('noteEnergySource(p,energySub(energyOf(after),energyOf(before)));storeMaterial(s,before,after);markBusy(p);'),
  'existing energy ledger, change detection and native storage retained');
check(nativeHearthWGSL.indexOf('if (!energyFits(m, next))') < nativeHearthWGSL.indexOf('var out = withEnergy(m, next)'),
  'failed energy admission returns before either heat or payload changes');
for (const [label, code] of [['native hearth evaluate', evaluate], ['native hearth commit', plan]]) {
  check([...code.matchAll(/var<storage,/g)].length <= 8, `${label} existing storage budget`);
  assertNaga(code, label);
}
console.log(`PASS ${checks} native hearth exact-energy/fuel, guards, save and composed Naga checks`);

// Actual cold authored hearth, production native heat/contact twins and exact
// material commits. Fixed cells: excludes gravity, particles and blast motion.
const start = [12, 6, 8], dims = [12, 14, 10], [nx, ny, nz] = dims;
const index = (x, y, z) => x + nx * (y + ny * z);
const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz;
const ids = new Uint16Array(nx * ny * nz);
const set = (x, y, z, id) => { const p = [x, y, z].map((v, i) => v - start[i]); if (inside(...p)) ids[index(...p)] = id; };
const authored = buildExceptions({ set, box(x, y, z, X, Y, Z, id) {
  for (let yy = y; yy < Y; yy++) for (let zz = z; zz < Z; zz++) for (let xx = x; xx < X; xx++) set(xx, yy, zz, id);
} });
const materials = Array.from(ids, id => makeMaterial(id)), cores = materials.map(m => m.core), banks = materials.map(m => m.bank);
const firebox = hearthRegions(authored.devices[0]).firebox.map(p => index(...p.map((v, i) => v - start[i])));
let first = null, tick = 0, totalDebit = 0, totalGain = 0n;
function cubes(offset, fn) {
  for (let z = offset[2] - 1; z < nz; z += 2) for (let y = offset[1] - 1; y < ny; y += 2) for (let x = offset[0] - 1; x < nx; x += 2) {
    const positions = C.CONTACT_POSITIONS.map(([dx, dy, dz]) => [x + dx, y + dy, z + dz]);
    const valid = positions.map(p => inside(...p)), slots = positions.map((p, i) => valid[i] ? index(...p) : -1);
    const block = slots.map(i => new Uint32Array(i < 0 ? 4 : cores[i])), bank = slots.map(i => i < 0 ? 0 : banks[i]);
    fn(block, bank, valid, positions);
    for (let k = 0; k < 8; k++) if (slots[k] >= 0) {
      const s = slots[k]; cores[s] = block[k]; banks[s] = bank[k];
      if (cid(cores[s]) !== E.THERMITE && ids[s] === E.THERMITE) first ??= {
        tick, position: positions[k].map((v, i) => v + start[i]), id: cid(cores[s]),
      };
    }
  }
}
for (tick = 1; tick <= 120; tick++) {
  const offset = offsetOf(tick);
  const heat = () => cubes(offset.map(v => 1 - v), (block, bank, valid) => C.contactHeatReference(block, bank, valid));
  if (tick & 1) heat();
  cubes(offset, (block, bank, valid, positions) => C.contactReference(block, bank, tick,
    positions.map(p => p.map((v, i) => v + start[i])), new Uint32Array(8), valid));
  if (!(tick & 1)) heat();
  for (const s of firebox) {
    const m = { core: cores[s], bank: banks[s] };
    const result = committed(m, LEGACY_STEPS_PER_TICK / LEGACY_STEP_HZ);
    cores[s] = result.material.core; banks[s] = result.material.bank;
    totalDebit += result.debit; totalGain += result.energyGain;
  }
  if (first) break;
}
check(first !== null, 'cold authored fixed-cell thermal patch still reaches native thermite conversion within 120 ticks');
equal(totalGain, BigInt(totalDebit) * EQ, 'entire authored thermal run is paid in committed exact energy');
console.log(`PASS authored fixed-cell thermal patch: ${JSON.stringify({ firstThermiteConversion: first, totalDebit, exactGain: String(totalGain) })}`);
console.log(`PASS ${checks} total checks including authored thermal continuation`);
console.log('Limits: no gravity/particles, pressure evolution, blast application, exposure counts, or whole-world/open-boundary proof. Naga is validation, not WGSL execution.');

// CPU-only hearth checks, including repeated native-rule conduction before each
// Industry update and Naga validation of the real composed Industry kernel.
// The bounded conduction fixture uses native per-face flux/cap rules, with its
// refractory surroundings held at 20 °C; it omits movement, phase changes, and GPU heat.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { E, ELEMENTS } from '../src/elements.js';
import { PHYS } from '../src/physics.js';
import { deviceDirection } from '../src/industry/catalog.js';
import {
  HEARTH_ENERGY_PER_LIFE, HEARTH_FUEL_IDS, HEARTH_IGNITION_MARGIN,
  HEARTH_IGNITION_TARGET, HEARTH_IGNITION_TEMPERATURE, HEARTH_LAYOUT,
  HEARTH_MAX_FUEL_TEMPERATURE, HEARTH_MAX_STEP_SECONDS, HEARTH_STEPS_PER_SECOND,
  hearthFuelBudget, hearthRegions,
} from '../src/industry/hearth.js';
import { HEARTH_UNIFORM_FIELDS, hearthUpdateWGSL } from '../src/shaders/hearth.js';
import { INDUSTRY_EDIT, INDUSTRY_KIND } from '../src/shaders/industry.js';
import { editKernelWGSL } from '../src/shaders/common.js';

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const close = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: got ${actual}, wanted ${expected}`);
  checks++;
};

check(HEARTH_FUEL_IDS.includes(E.COAL) && HEARTH_FUEL_IDS.includes(E.BROKENCOAL), 'only real coal and broken-coal cells fuel the abstraction');
check(!HEARTH_FUEL_IDS.includes(E.SCRAP), 'charge material is never treated as fuel');
check(Object.keys(HEARTH_UNIFORM_FIELDS).length === 0, 'the helper adds no Industry uniforms');
check(HEARTH_LAYOUT.footprint === 4 && HEARTH_LAYOUT.height === 4, 'layout stays inside the existing 4×4×4 working volume');
check(HEARTH_IGNITION_TARGET === HEARTH_IGNITION_TEMPERATURE + HEARTH_IGNITION_MARGIN, 'paid ignition includes its native-loss margin');
const coalNativeBudget = HEARTH_ENERGY_PER_LIFE * ELEMENTS[E.COAL].burnRate;
const sixTungstenFaceLoss = 6 * Math.min(ELEMENTS[E.COAL].cond, ELEMENTS[E.TUNGSTEN].cond)
  * (HEARTH_MAX_FUEL_TEMPERATURE - PHYS.AMBIENT);
check(coalNativeBudget >= sixTungstenFaceLoss,
  'calibrated local budget offsets six native tungsten-face losses at the source clamp');

for (let rotation = 0; rotation < 4; rotation++) {
  const device = { x: 20, y: 8, z: 30, rotation };
  const regions = hearthRegions(device);
  check(regions.fuel.length === 12 && regions.charge.length === 24 && regions.outlet.length === 12 && regions.mouth.length === 12,
    `rotation ${rotation}: fuel, charge, spout, and mouth capacities are fixed`);
  check(JSON.stringify(regions.outputDirection) === JSON.stringify(deviceDirection(device)), `rotation ${rotation}: output points forward`);
  const key = c => c.join(',');
  const fuel = new Set(regions.fuel.map(key)), charge = new Set(regions.charge.map(key)), outlet = new Set(regions.outlet.map(key));
  check(![...fuel].some(p => charge.has(p) || outlet.has(p)) && ![...charge].some(p => outlet.has(p)), `rotation ${rotation}: fuel, charge, and outlet do not overlap`);
  for (const region of [regions.fuel, regions.charge, regions.outlet]) for (const [x, y, z] of region) {
    check(x >= device.x && x < device.x + 4 && y >= device.y + 1 && y <= device.y + 3 && z >= device.z && z < device.z + 4,
      `rotation ${rotation}: internal zones fit the existing working volume`);
  }
}

const cold = { id: E.COAL, temperature: 20, life: 1 };
const spark = hearthFuelBudget(cold, 1 / 60);
check(spark.status === 'ignition', 'cold real fuel uses the built-in ignition phase');
close(spark.temperature, HEARTH_IGNITION_TARGET, 'paid ignition reaches above native losses');
close(spark.heatBudget, spark.consumedLife * HEARTH_ENERGY_PER_LIFE, 'spark heat is paid for by consumed life');
close(spark.life + spark.consumedLife, cold.life, 'spark preserves exact life accounting');
check(cold.life === 1 && cold.temperature === 20, 'budget preview does not mutate its terrain-cell input');

const noFuel = hearthFuelBudget({ id: E.SCRAP, temperature: 900, life: 1 }, 0.1);
check(noFuel.status === 'not-fuel' && noFuel.consumedLife === 0 && noFuel.heatApplied === 0, 'non-fuel material adds no heat');
const empty = hearthFuelBudget({ id: E.COAL, temperature: 1500, life: 0 }, 0.1);
check(empty.status === 'empty' && empty.consumedLife === 0 && empty.heatApplied === 0, 'exhausted physical fuel adds no heat');
const off = hearthFuelBudget({ id: E.COAL, temperature: 1500, life: 0.5 }, 0.1, false);
check(off.status === 'disabled' && off.life === 0.5 && off.consumedLife === 0 && off.heatApplied === 0, 'disabled hearth neither consumes fuel nor adds heat');
for (const dt of [0, -1, NaN, Infinity]) {
  const idle = hearthFuelBudget({ id: E.COAL, temperature: 1500, life: 1 }, dt);
  check(idle.consumedLife === 0 && idle.heatApplied === 0, `invalid/non-positive dt ${dt} produces no budget`);
}

const partialInput = { id: E.BROKENCOAL, temperature: 1000, life: 0.0003 };
const partial = hearthFuelBudget(partialInput, 1 / 60);
check(partial.status === 'burn' && partial.consumedLife === partialInput.life && partial.life === 0,
  'a partial broken-coal cell is exhausted exactly, never over-consumed');
close(partial.heatBudget, partial.consumedLife * HEARTH_ENERGY_PER_LIFE, 'partial-fuel budget accounts for all spent life');
close(partial.heatApplied + partial.heatWasted, partial.heatBudget, 'applied and capped/wasted heat sum to the finite budget');
check(partial.heatApplied <= partial.heatBudget, 'applied heat cannot exceed consumed-fuel budget');
const capped = hearthFuelBudget({ id: E.COAL, temperature: HEARTH_MAX_FUEL_TEMPERATURE - 1, life: 1 }, 0.1);
check(capped.temperature === HEARTH_MAX_FUEL_TEMPERATURE && capped.heatWasted > 0,
  'source-temperature cap wastes excess budget rather than creating heat');
const tooLittleToIgnite = hearthFuelBudget({ id: E.COAL, temperature: 20, life: 0.0005 }, 1 / HEARTH_STEPS_PER_SECOND);
check(tooLittleToIgnite.life === 0 && tooLittleToIgnite.temperature < HEARTH_IGNITION_TEMPERATURE,
  'partial cold fuel cannot receive free ignition heat beyond its remaining life');
check(HEARTH_STEPS_PER_SECOND === 240 && HEARTH_MAX_STEP_SECONDS === 0.1, 'fuel demand uses the native fixed step rate and Industry dt cap');

// Shader structure checks protect finite physical-fuel accounting and keep
// charge phase changes exclusively in native physics.
check(hearthUpdateWGSL.includes('id == E_COAL || id == E_BROKENCOAL'), 'WGSL accepts only the two physical coal types');
check(hearthUpdateWGSL.includes('HEARTH_IGNITION_TARGET_T - a.y'), 'WGSL pays for the same ignition headroom as the CPU budget');
check(hearthUpdateWGSL.includes('min(a.z, BURNRATE(id) * HEARTH_STEPS_PER_SECOND * min(dt, HEARTH_MAX_STEP_SECONDS))'), 'WGSL consumption is capped by real life and the Industry timestep');
check(hearthUpdateWGSL.includes('(*oA).z = max(0.0, a.z - consumed)'), 'WGSL writes remaining fuel life back to terrain');
check(!/\(\*oA\)\.x\s*=/.test(hearthUpdateWGSL) && !/E_SCRAP/.test(hearthUpdateWGSL), 'WGSL never converts charge material into LAVA');
check(hearthUpdateWGSL.includes('if (id == E_LAVA && (hearthChargeCell'), 'WGSL only guides already-molten charge toward the outlet');
check(hearthUpdateWGSL.includes('hearthFinite(dt)') && hearthUpdateWGSL.includes('hearthFinite(a.z)'), 'WGSL rejects non-finite time and fuel state');

// One native conduction face from react.js: min(cond)·ΔT, capped by the
// smaller capacity times PHYS.COND_FLUX_SHARE. Boundary cells are a fixed
// 20 °C bath: one tungsten face, four WALL faces on fuel, and five WALL faces
// on scrap. This deliberately bounded fixture exercises both native loss and
// transfer to a real charge without pretending to simulate all world physics.
function nativeFaceFlux(a, b) {
  const dT = b.temperature - a.temperature;
  const limit = Math.abs(dT) * Math.min(ELEMENTS[a.id].cap, ELEMENTS[b.id].cap) * PHYS.COND_FLUX_SHARE;
  const raw = Math.min(ELEMENTS[a.id].cond, ELEMENTS[b.id].cond) * dT;
  return Math.max(-limit, Math.min(limit, raw));
}
const oneTungstenLoss = nativeFaceFlux(
  { id: E.COAL, temperature: 450 }, { id: E.TUNGSTEN, temperature: 20 },
);
close(450 + oneTungstenLoss / ELEMENTS[E.COAL].cap, 439.25,
  'fixture reproduces native tungsten loss that defeated exact-threshold ignition');
const paidTargetAfterOneTungsten = HEARTH_IGNITION_TARGET + nativeFaceFlux(
  { id: E.COAL, temperature: HEARTH_IGNITION_TARGET }, { id: E.TUNGSTEN, temperature: 20 },
) / ELEMENTS[E.COAL].cap;
check(paidTargetAfterOneTungsten > HEARTH_IGNITION_TEMPERATURE,
  'paid ignition margin survives the reviewed one-tungsten native loss');

function boundedHearth({ fuelLife = 1, fuelTemperature = 20, enabled = true } = {}) {
  const fuel = { id: E.COAL, temperature: fuelTemperature, life: fuelLife };
  const charge = { id: E.SCRAP, temperature: 20, life: 0 };
  const sink = id => ({ id, temperature: 20, life: 0 });
  const exchange = (a, b, dynamicA, dynamicB, delta) => {
    const flux = nativeFaceFlux(a, b);
    if (dynamicA) delta[dynamicA] += flux;
    if (dynamicB) delta[dynamicB] -= flux;
  };
  return {
    fuel,
    charge,
    step() {
      const delta = { fuel: 0, charge: 0 };
      exchange(fuel, charge, 'fuel', 'charge', delta);
      exchange(fuel, sink(E.TUNGSTEN), 'fuel', null, delta);
      for (let i = 0; i < 4; i++) exchange(fuel, sink(E.WALL), 'fuel', null, delta);
      for (let i = 0; i < 5; i++) exchange(charge, sink(E.WALL), 'charge', null, delta);
      fuel.temperature += delta.fuel / ELEMENTS[fuel.id].cap;
      charge.temperature += delta.charge / ELEMENTS[charge.id].cap;
      const nativeFuelTemperature = fuel.temperature;
      const nativeChargeTemperature = charge.temperature;
      const update = hearthFuelBudget(fuel, 1 / HEARTH_STEPS_PER_SECOND, enabled);
      fuel.temperature = update.temperature;
      fuel.life = update.life;
      return { update, nativeFuelTemperature, nativeChargeTemperature };
    },
  };
}

const twin = boundedHearth();
const firstNativeStep = twin.step();
check(firstNativeStep.update.status === 'ignition' && twin.fuel.temperature === HEARTH_IGNITION_TARGET,
  'cold-start buys the ignition margin with saved fuel life');
check(twin.fuel.life < 1, 'cold-start consumes physical fuel before heating');
const secondNativeStep = twin.step();
check(secondNativeStep.nativeFuelTemperature > HEARTH_IGNITION_TEMPERATURE,
  `native conduction still leaves fuel at ${secondNativeStep.nativeFuelTemperature.toFixed(1)} °C, above ignition`);
check(secondNativeStep.update.status === 'burn' && secondNativeStep.update.consumedLife > 0,
  'after consecutive native conduction, cold-start enters the sustained paid burn branch');
let burningSteps = 1;
for (let i = 0; i < 28; i++) {
  const step = twin.step();
  if (step.update.status === 'burn') burningSteps++;
  check(step.update.heatApplied <= step.update.heatBudget + 1e-9, 'every continued-heating step stays within its paid budget');
}
check(burningSteps >= 25 && twin.fuel.life < 1, 'successive native steps keep industrial burning finite-fuel paid');
check(twin.fuel.temperature > HEARTH_IGNITION_TEMPERATURE && twin.charge.temperature > 150,
  `sustained burn heats the source and real scrap charge (fuel ${twin.fuel.temperature.toFixed(1)} °C, charge ${twin.charge.temperature.toFixed(1)} °C)`);

const partialCold = boundedHearth({ fuelLife: 0.0005 });
const partialStart = partialCold.step();
check(partialStart.update.status === 'ignition' && partialCold.fuel.life === 0,
  'a partial cold cell pays only its remaining life and is exhausted');
check(partialStart.update.heatApplied === 150 && partialCold.fuel.temperature < HEARTH_IGNITION_TEMPERATURE,
  'insufficient life cannot mint the unpaid ignition remainder');
const partialAfterExhaustion = partialCold.step();
check(partialAfterExhaustion.update.status === 'empty' && partialAfterExhaustion.update.heatApplied === 0
  && partialCold.fuel.temperature === partialAfterExhaustion.nativeFuelTemperature,
  'exhausted partial fuel gets no industrial heat on subsequent native steps');
const exhaustedHot = boundedHearth({ fuelLife: 0, fuelTemperature: 1500 });
const exhaustedStep = exhaustedHot.step();
check(exhaustedStep.update.status === 'empty' && exhaustedStep.update.heatApplied === 0
  && exhaustedHot.fuel.temperature <= exhaustedStep.nativeFuelTemperature,
  'hot exhausted fuel only loses native heat; it cannot create additional industrial heat');
const disabledTwin = boundedHearth({ enabled: false });
const disabledStep = disabledTwin.step();
check(disabledStep.update.status === 'disabled' && disabledTwin.fuel.life === 1
  && disabledTwin.fuel.temperature === 20 && disabledTwin.charge.temperature === 20,
  'disabled hearth applies no industrial heat, fuel use, or charge heating');

// Regression contract against actual integration: compile INDUSTRY_EDIT itself,
// including its kind==5 dispatch and guarded hearth call, not a test-authored caller.
check(INDUSTRY_KIND.hearth === 5, 'actual Industry kind dispatch retains integrated hearth kind 5');
const code = editKernelWGSL({ nx: 32, ny: 32, nz: 32 }, INDUSTRY_EDIT);
const dir = mkdtempSync(join(tmpdir(), 'industry-hearth-wgsl-'));
try {
  const file = join(dir, 'industry.wgsl');
  writeFileSync(file, code);
  const naga = spawnSync('naga', [file], { encoding: 'utf8' });
  if (naga.error?.code === 'ENOENT') throw new Error('Install naga-cli for CPU-only composed Industry WGSL validation; no browser fallback.');
  assert.equal(naga.status, 0, `Naga must accept the real composed Industry WGSL:\n${naga.stdout}\n${naga.stderr}`);
  const guardAt = code.indexOf('if (!machineEnabled(P.guardBase');
  const hearthAt = code.indexOf('hearthUpdate(p, a, b, P.corner');
  check(guardAt >= 0 && hearthAt > guardAt && code.includes('if (P.kind == 5u)'),
    'compiled actual Industry edit dispatch calls hearth only after its base/control guard');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`${checks} hearth CPU/conduction/structure checks passed; actual INDUSTRY_EDIT WGSL parsed by Naga. No browser, GPU, phase-change, or full-world behavior was tested.`);

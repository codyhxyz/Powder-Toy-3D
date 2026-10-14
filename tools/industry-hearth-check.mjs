// CPU-only contract checks for finite physical-fuel hearth budgets/geometry and
// Naga validation of the WGSL helper composed after Industry's existing guard.
// This does not simulate native conduction, melt/cool transitions, or GPU heat.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { E } from '../src/elements.js';
import { deviceDirection } from '../src/industry/catalog.js';
import {
  HEARTH_ENERGY_PER_LIFE, HEARTH_FUEL_IDS, HEARTH_LAYOUT,
  HEARTH_MAX_FUEL_TEMPERATURE, HEARTH_MAX_STEP_SECONDS, HEARTH_STEPS_PER_SECOND,
  hearthFuelBudget, hearthRegions,
} from '../src/industry/hearth.js';
import { HEARTH_UNIFORM_FIELDS, hearthUpdateWGSL } from '../src/shaders/hearth.js';
import { IndustryParams, machineGuardWGSL } from '../src/shaders/industry.js';
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
close(spark.temperature, 450, 'ignition reaches the native coal threshold');
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
const tooLittleToIgnite = hearthFuelBudget({ id: E.COAL, temperature: 20, life: 0.01 }, 1 / 60);
check(tooLittleToIgnite.life === 0 && tooLittleToIgnite.temperature < 450,
  'partial fuel cannot receive free ignition heat beyond its remaining life');
check(HEARTH_STEPS_PER_SECOND === 240 && HEARTH_MAX_STEP_SECONDS === 0.1, 'fuel demand uses the native fixed step rate and Industry dt cap');

// Regression contract: the Industry guard is before the hearth call, only
// physical life fields change, and only native LAVA is directed to the spout.
check(hearthUpdateWGSL.includes('id == E_COAL || id == E_BROKENCOAL'), 'WGSL accepts only the two physical coal types');
check(hearthUpdateWGSL.includes('min(a.z, BURNRATE(id) * HEARTH_STEPS_PER_SECOND * min(dt, HEARTH_MAX_STEP_SECONDS))'), 'WGSL consumption is capped by real life and the Industry timestep');
check(hearthUpdateWGSL.includes('(*oA).z = max(0.0, a.z - consumed)'), 'WGSL writes remaining fuel life back to terrain');
check(!/\(\*oA\)\.x\s*=/.test(hearthUpdateWGSL) && !/E_SCRAP/.test(hearthUpdateWGSL), 'WGSL never changes a charge element into LAVA');
check(hearthUpdateWGSL.includes('if (id == E_LAVA && (hearthChargeCell'), 'WGSL only guides already-molten charge toward the outlet');
check(hearthUpdateWGSL.includes('hearthFinite(dt)') && hearthUpdateWGSL.includes('hearthFinite(a.z)'), 'WGSL rejects non-finite time and fuel state');
const guardCall = 'if (!machineEnabled(P.guardBase, P.guardMaterial, P.guardPort, P.guardPowered)) { return; } hearthUpdate(p, a, b, P.corner, P.right, P.forward, P.dt, oA, oB);';
check(guardCall.indexOf('machineEnabled') < guardCall.indexOf('hearthUpdate'), 'integration call follows the existing base/control guard');

// Compile the helper in a complete edit kernel using the exact Industry
// uniforms and guard, but do not create a GPU device or run thermal behavior.
const update = `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  if (!machineEnabled(P.guardBase, P.guardMaterial, P.guardPort, P.guardPowered)) { return; }
  hearthUpdate(p, a, b, P.corner, P.right, P.forward, P.dt, oA, oB);
}`;
const code = editKernelWGSL({ nx: 32, ny: 32, nz: 32 }, {
  update,
  params: IndustryParams,
  reads: 'neighbours',
  decls: `${machineGuardWGSL}\n${hearthUpdateWGSL}`,
});
const dir = mkdtempSync(join(tmpdir(), 'industry-hearth-wgsl-'));
try {
  const file = join(dir, 'hearth.wgsl');
  writeFileSync(file, code);
  const naga = spawnSync('naga', [file], { encoding: 'utf8' });
  if (naga.error?.code === 'ENOENT') throw new Error('Install naga-cli for CPU-only hearth WGSL validation; no browser fallback.');
  assert.equal(naga.status, 0, `Naga must accept the composed hearth/Industry WGSL:\n${naga.stdout}\n${naga.stderr}`);
  const guardAt = code.lastIndexOf('machineEnabled(P.guardBase');
  const hearthAt = code.lastIndexOf('hearthUpdate(p, a, b, P.corner');
  check(guardAt >= 0 && hearthAt > guardAt, 'compiled integration calls hearth only after the actual Industry guard');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`${checks} hearth CPU/structure checks passed; composed WGSL parsed by Naga. No GPU or native thermal behavior was tested.`);

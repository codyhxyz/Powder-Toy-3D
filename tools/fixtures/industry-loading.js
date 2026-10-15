import { E } from '../../src/elements.js';
import { createConstruction } from '../../src/industry/construction.js';
import { createIndustryPhysics } from '../../src/industry/physics.js';
import { validateDevices } from '../../src/industry/validation.js';
import { hearthRegions, hearthStructureCells } from '../../src/industry/hearth.js';
import { TRANSFER_PUT } from '../../src/shaders/transfer.js';
import { purelineDeviceLayout, isColdLineMinedCoal } from './industry-line.js';
import { createIndustryOperator } from './industry-operator.js';

export const CHARGE_POSE = Object.freeze({ feet: [21.5, 16, 18.5], target: [16, 13, 18] });
export const FUEL_POSE = Object.freeze({ feet: [21.5, 16, 17.5], target: [16, 13, 17] });
export const loadingDeviceLayout = () => [
  ...purelineDeviceLayout({ operatorMode: 'tools' }),
  { id: 'operator-platform', type: 'foundation', x: 20, y: 15, z: 16, rotation: 0 },
];
const box = (lo, hi) => {
  const out = [];
  for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++)
    for (let x = lo[0]; x <= hi[0]; x++) out.push([x, y, z]);
  return out;
};
const metal = cell => cell.id === E.SCRAP || cell.id === E.METAL
  || (cell.id === E.LAVA && cell.ctype === E.METAL);
const clean = error => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 400);

/** Loading/short retention only, NOT a thermal or shipping checkpoint. */
export async function runIndustryLoading({ sim, gpu, deadline, stage = () => {} }) {
  const until = deadline ?? Date.now() + 16_000;
  const devices = validateDevices(loadingDeviceLayout(), [128, 128, 128]);
  const hearth = devices.find(d => d.type === 'hearth'), miner = devices.find(d => d.type === 'miner');
  const regions = hearthRegions(hearth);
  const chamber = [...regions.fuel, ...regions.charge], interior = [...chamber, ...regions.outlet];
  const inside = new Set(interior.map(at => at.join(',')));
  const rear = new Set(regions.fuel.map(at => at.join(',')));
  const watch = [...new Map([...interior, ...box([17, 12, 20], [18, 16, 22]),
    ...box([17, 16, 17], [18, 17, 19])].map(at => [at.join(','), at])).values()];
  const observations = { operatorMode: 'pending', deviceCount: devices.length, nativeTicks: 0,
    actions: [], snapshots: {}, platform: { cells: 16, shellContacts: 4, addedThermalMass: true } };
  const checks = { nativeBounds: false, atomicStructures: false, actualToolMode: false,
    chargeCaptured: false, chargePlacedInside: false, chargeRetainedBeforeFuel: false, scrapFloorBed: false,
    fuelCaptured: false, fuelPlacedInside: false, sixFuelObservedAtLoading: false,
    chargeRetained128Ticks: false, nativeFuelConsumed: false, shellIntact: false,
    noToolErrors: false, transfersSettled: false, nativeTickAccounting: false };
  const residualGaps = [], errors = [];
  const startFrame = sim.frame;
  let construction, industry, operator, fill;
  const ensure = label => { if (Date.now() >= until) throw new Error(`${label}: case deadline reached`); };
  const wait = async (promise, label) => {
    ensure(label);
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: case deadline reached`)), Math.max(1, until - Date.now()));
    })]); } finally { clearTimeout(timer); }
  };
  const fence = async () => { await wait(gpu.fence(), 'loading fence'); await Promise.resolve(); };
  const read = async cells => {
    const out = [];
    for (let i = 0; i < cells.length; i += 8) {
      const chunk = cells.slice(i, i + 8);
      const values = await wait(Promise.all(chunk.map(at => sim.readCell(...at))), 'bounded loading probe');
      out.push(...values.map(([a], j) => ({ at: chunk[j], id: Math.round(a[0]),
        temperature: a[1], life: a[2], ctype: Math.floor(a[3]), seed: a[3] - Math.floor(a[3]) })));
    }
    return out;
  };
  const nativeStep = async (ticks = 4) => {
    ensure('loading native step');
    if (ticks !== 4 || observations.nativeTicks + ticks > 4800) throw new Error('loading native tick budget reached');
    await operator?.beforeNativeFrame();
    const before = sim.frame;
    for (let n = 0; n < ticks; n++) sim.step();
    if (sim.frame - before !== ticks) throw new Error('incorrect native tick advance');
    observations.nativeTicks += ticks;
    industry.step(ticks / 240, [hearth, miner]);
  };
  const snapshot = async name => {
    await fence();
    const cells = await read(watch);
    const inBody = cells.filter(cell => inside.has(cell.at.join(',')));
    const fuel = inBody.filter(cell => cell.id === E.BROKENCOAL || cell.id === E.COAL);
    const value = { ticks: observations.nativeTicks, retainedMetal: inBody.filter(metal), fuel,
      rearFuel: fuel.filter(cell => rear.has(cell.at.join(','))),
      otherFuel: fuel.filter(cell => !rear.has(cell.at.join(','))),
      ash: inBody.filter(cell => cell.id === E.ASH),
      externalCargo: cells.filter(cell => !inside.has(cell.at.join(',')) && (metal(cell)
        || cell.id === E.BROKENCOAL || cell.id === E.COAL || cell.id === E.ASH)) };
    observations.snapshots[name] = value;
    return value;
  };
  const act = async options => {
    const action = await operator.act({ ...options, settleFrames: 0 });
    observations.actions.push(action);
    if (action.failure || !action.completed) throw new Error(`${action.label}: ${action.failure ?? 'required action incomplete'}`);
    return action;
  };
  const acceptedPuts = id => operator.snapshot().transfers.filter(r => r.mode === TRANSFER_PUT)
    .flatMap(r => r.accepted).filter(slot => slot.payload[0] === id);
  try {
    checks.nativeBounds = [sim.g.nx, sim.g.ny, sim.g.nz].every(n => n === 128);
    if (!checks.nativeBounds) throw new Error('loading requires native 128³');
    stage('construct charge-first loading layout');
    construction = createConstruction({ sim, gpu, requestRender() {} });
    industry = createIndustryPhysics({ getSim: () => sim, onError: error => errors.push(clean(error)) });
    await wait(Promise.all([construction.ready, industry.ready]), 'loading construction ready');
    for (const d of devices) {
      ensure('loading construction');
      if (!await wait(construction.run(d, 1), `construct ${d.id}`)) throw new Error(`construction rejected ${d.id}`);
    }
    await fence();
    const shell = await read(hearthStructureCells(hearth));
    const platform = await read(box([20, 15, 16], [23, 15, 19]));
    checks.atomicStructures = shell.length === 48 && [...shell, ...platform].every(c => c.id === E.TUNGSTEN);
    if (!checks.atomicStructures) throw new Error('constructed shell/platform mismatch');
    operator = await wait(createIndustryOperator({ sim, gpu, deadline: until, nativeStep }), 'loading real tools ready');
    observations.operatorMode = 'tools';
    checks.actualToolMode = true;
    fill = sim.editKernel('industryLoadingResources', { params: { material: 'vec4f' },
      update: 'fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) { *oA = P.material; *oB = vec4f(0.0); }' });
    await wait(fill.ready, 'loading resource kernel');
    sim.edit(fill, { lo: [96, 30, 96], hi: [98, 30, 97] }, { material: [E.COAL, 20, 1, 0.375] });
    sim.edit(fill, { lo: [96, 30, 100], hi: [97, 30, 101] }, { material: [E.SCRAP, 20, 0, 0.625] });
    await fence();
    stage('actual shovel charge-first pickup and side-face throw');
    const load = operator.shovel.load;
    await act({ tool: 'SHOVEL', button: 'primary', label: 'capture four cold SCRAP',
      pose: { feet: [98.5, 30, 94.5], target: [97, 30, 100] }, maxFrames: 120,
      done: () => load.cells.filter(c => c[0] === E.SCRAP).length === 4 });
    checks.chargeCaptured = load.count === 4 && load.cells.every(c => c[0] === E.SCRAP);
    observations.chargePayload = load.cells.map(c => [...c]);
    await act({ tool: 'SHOVEL', button: 'secondary', label: 'charge-first interior side-face throw',
      pose: CHARGE_POSE, maxFrames: 120, done: () => load.count === 0 && load.out === 0 });
    const placedCharge = acceptedPuts(E.SCRAP);
    checks.chargePlacedInside = placedCharge.length === 4 && placedCharge.every(slot => inside.has(slot.at.join(',')));
    await snapshot('chargeConfirmed');
    await operator.waitFrames(2);
    await snapshot('chargeAfter8Ticks');
    await operator.waitFrames(6);
    const settled = await snapshot('chargeAfter32Ticks');
    checks.chargeRetainedBeforeFuel = ['chargeConfirmed', 'chargeAfter8Ticks', 'chargeAfter32Ticks']
      .every(name => observations.snapshots[name].retainedMetal.length === 4
        && observations.snapshots[name].externalCargo.filter(metal).length === 0);
    checks.scrapFloorBed = settled.retainedMetal.length === 4
      && settled.retainedMetal.every(c => c.id === E.SCRAP && c.at[1] === 13
        && c.at[0] >= 17 && c.at[0] <= 18 && c.at[2] >= 17 && c.at[2] <= 18);
    if (!checks.chargeCaptured || !checks.chargePlacedInside || !checks.chargeRetainedBeforeFuel || !checks.scrapFloorBed)
      throw new Error('charge retention prerequisite failed; stopped before fuel');
    stage('actual shovel mined-coal pickup and side-face throw');
    const stock = box([95, 30, 92], [99, 32, 98]);
    let attempts = 0;
    for (let poll = 0; poll < 120 && load.count < 6; poll++) {
      const visible = (await read(stock)).find(c => c.id === E.BROKENCOAL);
      if (!visible) { await nativeStep(); await fence(); continue; }
      if (attempts++ >= 12) break;
      const before = load.count;
      const action = await operator.act({ tool: 'SHOVEL', button: 'primary',
        label: 'retarget visible mined coal', pose: { feet: [98.5, 30, 94.5], target: visible.at },
        maxFrames: 12, settleFrames: 1, done: () => load.count > before });
      observations.actions.push(action);
      if (action.failure) throw new Error(action.failure);
    }
    observations.fuelPayload = load.cells.map(c => [...c]);
    checks.fuelCaptured = load.count === 6 && load.cells.every(c => isColdLineMinedCoal(c));
    if (!checks.fuelCaptured) throw new Error('six cold mined fuel cells not captured');
    await act({ tool: 'SHOVEL', button: 'secondary', label: 'fuel interior side-face throw',
      pose: FUEL_POSE, maxFrames: 120, done: () => load.count === 0 && load.out === 0 });
    const placedFuel = acceptedPuts(E.BROKENCOAL);
    checks.fuelPlacedInside = placedFuel.length === 6 && placedFuel.every(slot => inside.has(slot.at.join(',')));
    const loaded = await snapshot('fuelConfirmed');
    checks.sixFuelObservedAtLoading = loaded.fuel.length === 6;
    if (!checks.fuelPlacedInside || !checks.sixFuelObservedAtLoading)
      throw new Error('fuel loading prerequisite failed; stopped before retention interval');
    stage('128 native ticks of charge retention; not a melting test');
    const fuelStart = observations.nativeTicks;
    for (const [frames, name] of [[2, 'fuelAfter8Ticks'], [6, 'fuelAfter32Ticks'], [24, 'fuelAfter128Ticks']]) {
      await operator.waitFrames(frames);
      await snapshot(name);
    }
    observations.retentionTicks = observations.nativeTicks - fuelStart;
    checks.chargeRetained128Ticks = observations.retentionTicks === 128
      && ['fuelConfirmed', 'fuelAfter8Ticks', 'fuelAfter32Ticks', 'fuelAfter128Ticks']
        .every(name => observations.snapshots[name].retainedMetal.length === 4
          && observations.snapshots[name].externalCargo.filter(metal).length === 0);
    checks.nativeFuelConsumed = observations.snapshots.fuelAfter128Ticks.fuel.some(c => c.life < 1)
      || observations.snapshots.fuelAfter128Ticks.ash.length > 0;
    checks.shellIntact = (await read(hearthStructureCells(hearth))).every(c => c.id === E.TUNGSTEN);
  } catch (error) { residualGaps.push(clean(error)); }
  finally {
    if (operator) {
      observations.operator = operator.snapshot();
      const state = observations.operator;
      checks.noToolErrors = errors.length === 0 && state.traceErrors.length === 0 && state.omittedTransfers === 0
        && observations.actions.every(a => !a.failure) && state.transfers.every(r => !r.error && !r.pending);
      checks.transfersSettled = !operator.belt.transfer.pending && !operator.shovel.load.out
        && !operator.shovel.load.reserved && !operator.bucket.load.out && !operator.bucket.load.reserved;
      await operator.dispose();
    }
    checks.nativeTickAccounting = sim.frame - startFrame === observations.nativeTicks && observations.nativeTicks > 0;
    observations.errors = errors;
    industry?.dispose();
    construction?.dispose?.();
  }
  return { case: 'loading', status: Object.values(checks).every(Boolean) && !residualGaps.length ? 'passed' : 'bounded-incomplete',
    scope: 'actual-tool loading and short retention only', checks, observations, residualGaps,
    limitations: ['No melting, bucket, ash-clearing, repeat-refueling, shipment, walking, or health attestation.',
      'Native fuel consumption and ash are recorded separately; complete global cargo accounting is not claimed.'] };
}

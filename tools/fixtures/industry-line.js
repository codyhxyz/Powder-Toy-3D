import { E, K, ELEMENTS } from '../../src/elements.js';
import { createConstruction } from '../../src/industry/construction.js';
import { createFactoryControlParts } from '../../src/industry/controlParts.js';
import { createGatePhysics, GATE_STATUS, gateGeometry } from '../../src/industry/gates.js';
import { createIndustryPhysics, machinePorts } from '../../src/industry/physics.js';
import { deviceCell } from '../../src/industry/catalog.js';
import { validateDevices } from '../../src/industry/validation.js';
import { hearthRegions, hearthStructureCells } from '../../src/industry/hearth.js';
import { createTransfer, Load } from '../../src/pov/tools/transfer.js';
import { createIndustryDiagnostics } from '../../src/industry/diagnostics.js';
import { PUMP_BACKPLATE_TAG, pumpBackplateCells, pumpStructureCells } from '../../src/industry/pumpStructure.js';
import { TRANSFER_PUT } from '../../src/shaders/transfer.js';

const BOUNDS = [128, 128, 128];
const NATIVE_DT = 4 / 240;
const MAX_NATIVE_TICKS = 4_800;
const FOUNDATION = (id, x, y, z) => ({ id, type: 'foundation', x, y, z, rotation: 0 });

// Collect successive native melts before they freeze; the full declared cargo
// must still reach the cold shipping intake, not just appear molten at once.
export function lineMoltenCargoComplete(cells, target) {
  return [2, 4].includes(target) && cells.length === target
    && cells.every(cell => cell.id === E.LAVA && cell.ctype === E.METAL);
}

// Inclusive ranges make the finite cold-water fill and its CPU checks share one
// source of truth. The 120-cell edit is a fixture, not a player-filled bucket.
export const LINE_WATER_SOURCE_BOUNDS = Object.freeze({
  x: Object.freeze([58, 67]), y: Object.freeze([13, 15]), z: Object.freeze([52, 55]),
});
const boxCells = bounds => {
  const cells = [];
  for (let z = bounds.z[0]; z <= bounds.z[1]; z++)
    for (let y = bounds.y[0]; y <= bounds.y[1]; y++)
      for (let x = bounds.x[0]; x <= bounds.x[1]; x++) cells.push([x, y, z]);
  return cells;
};
export const lineWaterSourceCells = () => boxCells(LINE_WATER_SOURCE_BOUNDS);

// Real pickup allows native motion between strokes. Friction can warm the
// initially 20°C stock slightly; remaining chemical fuel-life must stay exact.
export const isColdLineMinedCoal = (cell, initialLife = 1) => cell[0] === E.BROKENCOAL
  && Number.isFinite(cell[1]) && Math.abs(cell[1] - 20) <= 1 && cell[2] === initialLife;

// Real surface aims: the original centre ray can first-hit accumulated ash.
// These do not change the shovel's candidate sphere or select transfer cells.
export const lineRefuelPoses = () => [
  { feet: [21.5, 16, 16.5], point: [16.999, 14.7, 17.5], wall: [16, 14, 17], face: 0 },
  { feet: [17.5, 16, 16.5], point: [16.999, 14.5, 17.5], wall: [16, 14, 17], face: 0 },
  { feet: [18.5, 16, 16.5], point: [19.001, 14.5, 17.5], wall: [19, 14, 17], face: 1 },
].map(({ feet, point, wall, face }) => ({
  pose: { feet, direction: point.map((v, i) => v - feet[i] - (i === 1 ? 5 : 0)) }, wall, face,
}));

// Each foundation tile is an ordinary 4x4 build placed at every listed height.
// Keep the sealed tank/catch walls explicit and CPU-check their corners below.
export const LINE_FOUNDATION_COLUMNS = Object.freeze([
  ['spout-tower', 48, 52, 12, 16],
  ['catch-left', 40, 52, 15, 18],
  ['catch-rear', 44, 48, 15, 18],
  ['catch-front', 44, 56, 15, 18],
  ['spout-channel-back', 48, 48, 17, 18],
  ['spout-channel-front', 48, 56, 17, 18],
  ['tank-north-west', 52, 48, 13, 18],
  ['tank-north-east', 56, 48, 13, 15],
  ['tank-south-west', 52, 56, 13, 18],
  ['tank-south-east', 56, 56, 13, 15],
  ['tank-rear', 68, 52, 13, 15],
  ['tank-rear-north-corner', 68, 48, 13, 15],
  ['tank-rear-south-corner', 68, 56, 13, 15],
  ['tank-front-north-corner', 48, 48, 13, 16],
  ['tank-front-south-corner', 48, 56, 13, 16],
  ['catch-left-rear-corner', 40, 48, 15, 18],
  ['catch-left-front-corner', 40, 56, 15, 18],
  ['source-floor-west', 60, 52, 12, 12],
  ['source-floor-east', 64, 52, 12, 12],
  ['tank-north-middle', 60, 48, 13, 15],
  ['tank-north-east-extension', 64, 48, 13, 15],
  ['tank-south-middle', 60, 56, 13, 15],
  ['tank-south-east-extension', 64, 56, 13, 15],
]);

/** Pure, checked 128³ physical line geometry; no simulation or GPU is created. */
export function purelineDeviceLayout({ operatorMode = 'transfer', refuelOnce = false } = {}) {
  const devices = [
    { id: 'line-hearth', type: 'hearth', x: 16, y: 12, z: 16, rotation: 0 },
    { id: 'line-ship', type: 'ship', x: 44, y: 15, z: 52, rotation: 0 },
    { id: 'line-pump', type: 'pump', x: 52, y: 12, z: 52, rotation: 1, powered: true },
    { id: 'line-coolant-gate', type: 'gate', x: 56, y: 12, z: 52, rotation: 1,
      gateMode: 'closed', gateClosed: false },
    { id: 'line-miner', type: 'miner', x: 96, y: 29, z: 92, rotation: 0 },
  ];
  for (const [prefix, x, z, firstY, lastY] of LINE_FOUNDATION_COLUMNS)
    for (let y = firstY; y <= lastY; y++) devices.push(FOUNDATION(`${prefix}-${y}`, x, y, z));
  if (operatorMode === 'tools') {
    // Real pickup takes time. Build a normal supported work apron so loose
    // miner output cannot fall into the empty world's abyss between strokes.
    for (const [x, z] of [[92, 92], [92, 96], [96, 96], [92, 100], [96, 100]])
      devices.push(FOUNDATION(`tool-source-apron-${x}-${z}`, x, 29, z));
    devices.push(FOUNDATION('operator-platform', 20, 15, 16));
    if (refuelOnce) {
      // The miner drives debris off its rear deck at 0.6 cells/step.
      // A second pickup needs an ordinary physical apron beyond that deck.
      for (const x of [92, 96]) devices.push(FOUNDATION(`refuel-output-apron-${x}`, x, 29, 88));
    }
  }
  return devices;
}

const cleanError = error => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 400);

/**
 * Run one physical Sandustry batch in the caller-owned native simulation.
 * This function deliberately creates no browser, server, simulation, or bypass.
 */
export async function runIndustryLine({ sim, gpu, deadline, stage = () => {}, operatorMode = 'transfer', refuelOnce = false, scrapCells = 4 } = {}) {
  // Reject comparison misuse before inspecting or constructing the caller's world.
  if (!Number.isInteger(scrapCells) || ![2, 4].includes(scrapCells))
    throw new RangeError('scrapCells must be the integer 2 or 4');
  if (scrapCells === 2 && (operatorMode !== 'tools' || refuelOnce !== false))
    throw new RangeError('scrapCells=2 requires operatorMode=tools and refuelOnce=false');
  const meltBatchCheck = scrapCells === 2 ? 'operatorTwoCellMeltBatch' : 'operatorFourCellMeltBatch';
  const startedAt = Date.now();
  const until = Number.isFinite(deadline) ? deadline : startedAt + 20_000;
  const devices = validateDevices(purelineDeviceLayout({ operatorMode, refuelOnce }), BOUNDS);
  const byId = new Map(devices.map(device => [device.id, device]));
  const hearth = byId.get('line-hearth');
  const ship = byId.get('line-ship');
  const pump = byId.get('line-pump');
  const miner = byId.get('line-miner');
  const initialGate = byId.get('line-coolant-gate');
  const constructionDevices = devices;
  const hotRegions = hearthRegions(hearth);
  const shellCells = hearthStructureCells(hearth);
  const waterSource = lineWaterSourceCells();
  const waterSourceLo = [LINE_WATER_SOURCE_BOUNDS.x[0], LINE_WATER_SOURCE_BOUNDS.y[0], LINE_WATER_SOURCE_BOUNDS.z[0]];
  const waterSourceHi = [LINE_WATER_SOURCE_BOUNDS.x[1], LINE_WATER_SOURCE_BOUNDS.y[1], LINE_WATER_SOURCE_BOUNDS.z[1]];
  const pumpPorts = machinePorts(pump);
  const inletCells = pumpPorts.inlet;
  const outletCells = pumpPorts.outlet;
  const [, spoutX, spoutZ, , spoutRoof] = LINE_FOUNDATION_COLUMNS.find(([name]) => name === 'spout-tower');
  const spoutCells = boxCells({ x: [spoutX, spoutX + 3], y: [spoutRoof, spoutRoof + 3], z: [spoutZ, spoutZ + 3] });
  const coalSource = [];
  for (let z = 96; z <= 97; z++) for (let x = 96; x <= 98; x++) coalSource.push([x, 30, z]);
  const scrapSource = [];
  for (let z = 100; z < 100 + scrapCells / 2; z++) for (let x = 96; x <= 97; x++) scrapSource.push([x, 30, z]);
  const switchAt = deviceCell(pump, -1, 0, 1);
  const catchCells = machinePorts(ship).mouth;
  const waterWatchCells = [...new Map([...waterSource, ...inletCells, ...outletCells, ...catchCells]
    .map(at => [at.join(','), at])).values()];
  const ashRegion = [];
  for (let z = 17; z <= 19; z++) for (let y = 13; y <= 15; y++) for (let x = 17; x <= 19; x++) ashRegion.push([x, y, z]);

  const checks = {
    atomicStructures: false,
    pumpBackplateOwnership: false,
    gateClosedSourceHeld: false,
    nativePumpSwitchOffOnOffSequence: false,
    gateReleaseAndPumpConfirmed: false,
    physicalMinedCoalPreserved: false,
    realFuelSpent: false,
    nativeMetalMelt: false,
    bucketCarriedActualLava: false,
    bucketPouredActualLavaIntoCatch: false,
    realWaterPumpConfirmed: false,
    waterReachedShippingCatch: false,
    waterInteractedWithMelt: false,
    coldMetalConfirmedShipped: false,
    ashRemovedWithoutWallLoss: false,
    nativeTickAccounting: false,
  };
  const observations = {
    declaredScrapCells: scrapCells,
    ...(scrapCells === 2 ? { comparisonScope: 'two-SCRAP physical workflow comparison only; unchanged native rules, geometry and 4,800-total-tick cap; not a four-cell batch or GPU cost reduction' } : {}),
    bounds: [sim?.g?.nx, sim?.g?.ny, sim?.g?.nz],
    deviceCount: devices.length,
    foundationCount: devices.filter(d => d.type === 'foundation').length,
    layoutDeviceIds: devices.map(d => d.id),
    nativeTicks: 0,
    gate: {},
    fuel: {},
    heat: {},
    water: { seededCells: waterSource.length, sourceBounds: LINE_WATER_SOURCE_BOUNDS,
      setup: 'finite cold-WATER fixture edit; not a player-filled bucket claim',
      confirmedInput: 0, confirmedOutput: 0, confirmedReturn: 0, steamObserved: 0 },
    cargo: { bucketCells: [], ashTaken: 0, industryBufferAtEnd: 0, residuals: [] },
    shipments: [],
    elapsedMs: 0,
  };
  const refuel = refuelOnce ? { requested: true, providedCoalCells: 0, attempts: 0 } : null;
  if (refuel) {
    observations.operator = { refuel };
    checks.operatorRefuelColdMined = false;
    checks.operatorRefuelSourceSettled = false;
    checks.operatorRefuelDoseConfirmed = false;
    checks.operatorRefuelChargeRetained = false;
  }
  const residualGaps = [];
  const asyncErrors = [];
  let construction = null, gates = null, controls = null, industry = null, transfer = null, diagnostics = null;
  let physicalOperator = null;
  let fillKernel = null;
  let currentGate = initialGate;
  let switchState = null;
  let pumpActive = false;
  let disposed = false;

  const ensureTime = label => {
    if (Date.now() >= until) throw new Error(`${label}: case deadline reached`);
  };
  const bounded = async (promise, label) => {
    ensureTime(label);
    const remaining = Math.max(1, until - Date.now());
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: case deadline reached`)), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const markStage = name => {
    observations.stage = name;
    stage(name);
  };
  const fence = async label => {
    ensureTime(label);
    await bounded(gpu.fence(), label);
    await Promise.resolve();
  };
  const readCell = async at => {
    ensureTime('cell probe');
    const [cell] = await bounded(sim.readCell(...at), 'cell probe');
    return { id: Math.round(cell[0]), temperature: cell[1], life: cell[2], ctype: Math.floor(cell[3]), seed: cell[3] - Math.floor(cell[3]) };
  };
  const readCells = async cells => {
    const out = [];
    for (let i = 0; i < cells.length; i += 8) {
      ensureTime('bounded cell probes');
      out.push(...await bounded(Promise.all(cells.slice(i, i + 8).map(readCell)), 'bounded cell probes'));
    }
    return out;
  };
  const waitJob = async (job, label) => {
    let settled = false, value, failure;
    Promise.resolve(job).then(result => { value = result; settled = true; }, error => { failure = error; settled = true; });
    while (!settled) {
      ensureTime(label);
      await fence(label);
    }
    if (failure) throw failure;
    return value;
  };
  const waitGate = async (expected, label) => {
    while (gates.pending) {
      ensureTime(label);
      await fence(label);
    }
    const status = gates.status(currentGate.id);
    if (status?.status !== expected) throw new Error(`${label}: gate reported ${status?.status ?? 'no state'}, expected ${expected}`);
    return status;
  };
  const nativeFrameStart = sim.frame;
  const nativeStep = async (ticks = 4) => {
    ensureTime('native simulation step');
    if (observations.nativeTicks + ticks > MAX_NATIVE_TICKS) throw new Error('native tick budget reached');
    // The real operator runs once before the app-equivalent four native steps.
    if (physicalOperator) await physicalOperator.beforeNativeFrame();
    const before = sim.frame;
    for (let i = 0; i < ticks; i++) sim.step(); // Simulation.step takes no batch argument.
    if (sim.frame - before !== ticks) throw new Error('native simulation did not advance the requested tick count');
    observations.nativeTicks += ticks;
    // Registered machines stay present when OFF. The real SWITCH, not fixture
    // omission, must stop the pump. Empty hearth frames still advance its clock.
    industry.step(ticks / 240, [hearth, pump, ship, miner]);
    if (currentGate) gates.step(ticks / 240, [currentGate]);
  };
  const scanHearth = async () => {
    await fence('hearth sample fence');
    const cells = [...hotRegions.fuel, ...hotRegions.charge, ...hotRegions.outlet, ...hotRegions.mouth];
    const sampled = await readCells(cells);
    const records = cells.map((at, i) => ({ at, ...sampled[i] }));
    observations.heat.samples = records;
    const lava = records.filter(c => c.id === E.LAVA && c.ctype === E.METAL);
    const scrap = records.filter(c => c.id === E.SCRAP);
    const remainingFuel = records.filter(c => [E.COAL, E.BROKENCOAL].includes(c.id));
    observations.fuel.sampledRemainingLife = remainingFuel.reduce((sum, cell) => sum + Math.max(0, cell.life), 0);
    observations.fuel.sampledLiveFuelCells = remainingFuel.filter(cell => cell.life > 0).length;
    if (remainingFuel.some(cell => cell.life < 1 - 1e-7) || records.some(cell => cell.id === E.ASH))
      checks.realFuelSpent = true;
    observations.heat.peakC = Math.max(observations.heat.peakC ?? 20, ...records.map(c => c.temperature));
    observations.heat.metalPeakC = Math.max(observations.heat.metalPeakC ?? 20,
      ...[...scrap, ...lava].map(c => c.temperature));
    observations.heat.lavaMetalCells = lava.length;
    observations.heat.scrapCells = scrap.length;
    observations.heat.remainingFuelCells = remainingFuel.length;
    observations.heat.lavaLocations = lava.map(({ at, temperature, ctype }) => ({ at, temperature, ctype }));
    return records;
  };
  const edit = (lo, hi, id, temperature, life, ctype = 0.125) =>
    sim.edit(fillKernel, { lo, hi }, { material: [id, temperature, life, ctype] });
  const gateStepTo = async (device, expected, label) => {
    currentGate = device;
    gates.step(NATIVE_DT, [device]);
    await waitGate(expected, label);
  };
  const ensureSwitch = async wanted => {
    const before = await readCell(switchAt);
    if (before.id !== E.SWITCH) throw new Error('native pump-port SWITCH is missing');
    let on = before.life === 10;
    if (on !== wanted) {
      const result = await waitJob(controls.toggle({ x: switchAt[0], y: switchAt[1], z: switchAt[2] }), 'native SWITCH toggle');
      if (!result.ok) throw new Error(result.reason || 'native SWITCH toggle failed');
      on = result.on;
    }
    const after = await readCell(switchAt);
    if ((after.life === 10) !== wanted || on !== wanted) throw new Error(`native SWITCH did not reach ${wanted ? 'ON' : 'OFF'}`);
    switchState = wanted;
    return after;
  };
  const transferTake = async (load, opts, label) => {
    const job = transfer.take(load, opts);
    if (!job) throw new Error(`${label}: real transfer was not scheduled`);
    return waitJob(job, label);
  };
  const transferPut = async (load, cells, max, label) => {
    const job = transfer.put(load, { cells, max, vel: [0, 0, 0] });
    if (!job) throw new Error(`${label}: real transfer was not scheduled`);
    return waitJob(job, label);
  };

  try {
    if (!sim || !gpu || !Number.isFinite(sim.g?.nx) || sim.disposed) throw new TypeError('runIndustryLine requires the live native simulation and GPU');
    if (!['transfer', 'tools'].includes(operatorMode)) throw new RangeError(`unknown industry operator mode: ${operatorMode}`);
    if (typeof refuelOnce !== 'boolean' || (refuelOnce && operatorMode !== 'tools'))
      throw new RangeError('refuelOnce requires a boolean and operatorMode=tools');
    if (observations.bounds.some((n, i) => n !== BOUNDS[i])) throw new Error(`expected native 128³ bounds, got ${observations.bounds.join('x')}`);
    ensureTime('fixture setup');
    markStage('native industry fixture setup');
    if (operatorMode === 'tools') {
      markStage('prepare real shovel and finite bucket operator');
      const { createIndustryOperator } = await import('./industry-operator.js');
      physicalOperator = await bounded(createIndustryOperator({ sim, gpu, deadline: until, nativeStep }), 'operator tool setup');
      observations.operator = { mode: 'tools', owner: physicalOperator.owner, actions: [], initialLoads: physicalOperator.snapshot(),
        ...(refuel ? { refuel } : {}) };
    }
    observations.operatorMode = operatorMode;
    construction = createConstruction({ sim, gpu, requestRender() {} });
    gates = createGatePhysics({ getSim: () => sim, onError: error => asyncErrors.push(cleanError(error)) });
    controls = createFactoryControlParts({ getSim: () => sim });
    industry = createIndustryPhysics({ getSim: () => sim,
      onShip: shipment => observations.shipments.push({ ...shipment }),
      onTransfer: event => {
        if (!event.confirmed) return;
        if (event.device?.id === pump.id && event.operation === 'pump-input') observations.water.confirmedInput += event.count ?? 0;
        if (event.device?.id === pump.id && event.operation === 'pump-output') observations.water.confirmedOutput += event.count ?? 0;
        if (event.device?.id === pump.id && event.operation === 'pump-return') observations.water.confirmedReturn += event.count ?? 0;
      },
      onError: error => asyncErrors.push(cleanError(error)),
    });
    transfer = createTransfer({ getSim: () => sim });
    diagnostics = createIndustryDiagnostics({ getSim: () => sim, onError: error => asyncErrors.push(cleanError(error)) });
    await Promise.all([bounded(construction.ready, 'construction kernel ready'),
      bounded(gates.ready, 'gate kernel ready'), bounded(industry.ready, 'industry kernel ready')]);
    fillKernel = sim.editKernel('industryLineFiniteResources', {
      params: { material: 'vec4f' },
      update: 'fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) { *oA = P.material; *oB = vec4f(0.0); }',
    });
    await bounded(fillKernel.ready, 'finite resource write kernel ready');

    markStage(`atomic construction (${devices.length} validated devices)`);
    let constructed = 0;
    for (const device of constructionDevices) {
      ensureTime('atomic device construction');
      if (!await bounded(construction.run(device, 1), `atomic construction ${device.id}`)) throw new Error(`atomic construction rejected ${device.id}`);
      constructed++;
    }
    await fence('constructed layout fence');
    const shell = await readCells(shellCells);
    const pumpBuilt = await readCells(pumpStructureCells(pump));
    const pumpPlate = await readCells(pumpBackplateCells(pump));
    if (pumpBuilt.length !== 40 || pumpBuilt.some(c => c.id !== E.TUNGSTEN || c.temperature !== 20)
        || pumpPlate.length !== 24 || pumpPlate.some(c => c.life !== PUMP_BACKPLATE_TAG))
      throw new Error('atomic pump construction did not produce its real tagged backplate');
    const hearthBase = [];
    for (let z = 16; z <= 19; z++) for (let x = 16; x <= 19; x++) hearthBase.push([x, 12, z]);
    const gateBase = [];
    for (let z = 52; z <= 55; z++) for (let x = 56; x <= 59; x++) gateBase.push([x, 12, z]);
    const [hearthBaseCells, gateBaseCells] = await Promise.all([readCells(hearthBase), readCells(gateBase)]);
    const gateLeaf = gateGeometry(initialGate, sim.g).aperture;
    if (shell.length !== 48 || shell.some(c => c.id !== E.TUNGSTEN || c.temperature !== 20)
        || hearthBaseCells.some(c => c.id !== E.TUNGSTEN || c.temperature !== 20)
        || gateBaseCells.some(c => c.id !== E.INSULATOR || c.temperature !== 20)) throw new Error('atomic refractory/chassis materials did not read back as built and cold');
    checks.atomicStructures = constructed === devices.length;
    observations.structures = { constructed, tungstenHearthCells: shell.length, hearthBaseCells: hearthBaseCells.length,
      gateBaseMaterial: E.INSULATOR, gateBaseCells: gateBaseCells.length, initialGateLeafCells: gateLeaf.length,
      tungstenPumpCells: pumpBuilt.length, taggedPumpBackplateCells: pumpPlate.length };

    markStage('close coolant material gate and verify cold source hold');
    await gateStepTo(initialGate, GATE_STATUS.CLOSED, 'cold coolant-gate closure');
    currentGate = { ...initialGate, gateClosed: true };
    const closedLeaf = await readCells(gateLeaf);
    if (closedLeaf.length !== 12 || closedLeaf.some(c => c.id !== E.WALL)) throw new Error('closed coolant gate did not own its twelve-cell shutter');
    const switchPlaced = await waitJob(controls.place({ key: 'SWITCH', x: switchAt[0], y: switchAt[1], z: switchAt[2] }), 'native pump-port SWITCH placement');
    if (!switchPlaced.ok) throw new Error(switchPlaced.reason || 'native pump-port SWITCH placement failed');
    await ensureSwitch(false);
    observations.gate.pumpSwitchInitial = 'OFF';
    await edit(waterSourceLo, waterSourceHi, E.WATER, 20, 0, 0.125);
    await fence('cold water seed fence');
    const seededWater = await readCells(waterSource);
    observations.water.actualSeededWater = seededWater.filter(cell => cell.id === E.WATER).length;
    if (observations.water.actualSeededWater !== waterSource.length) throw new Error('finite cold water source was not fully written before native stepping');
    for (let i = 0; i < 3; i++) {
      ensureTime('gate hold native steps');
      await nativeStep(4);
      if (gates.pending) await waitGate(GATE_STATUS.CLOSED, 'gate holds cold source');
    }
    const [heldSource, heldInlet] = await Promise.all([readCells(waterSource), readCells(inletCells)]);
    const sourceWater = heldSource.filter(c => c.id === E.WATER).length;
    const inletWater = heldInlet.filter(c => c.id === E.WATER).length;
    checks.gateClosedSourceHeld = gates.status(currentGate.id)?.status === GATE_STATUS.CLOSED
      && sourceWater === waterSource.length && inletWater === 0;
    Object.assign(observations.gate, { closedStatus: gates.status(currentGate.id)?.status, sourceWaterHeld: sourceWater,
      sourceCells: waterSource.length, pumpInletWaterBeforeRelease: inletWater });
    observations.water.heldSource = waterSource.map((at, i) => ({ at, ...heldSource[i] }));
    if (!checks.gateClosedSourceHeld) residualGaps.push('coolant source hold was not fully observed before opening the real gate');

    markStage('load finite coal and scrap through physical transfer rules');
    const coalLife = ELEMENTS[E.COAL].life ?? 0;
    const scrapLife = ELEMENTS[E.SCRAP].life ?? 0;
    edit([96, 30, 96], [98, 30, 97], E.COAL, 20, coalLife, 0.375);
    await fence('finite cold material source fence');
    if (refuel) refuel.providedCoalCells = 6;

    // Exercise the real miner's COAL→BROKENCOAL output, including remaining life.
    // The optional branch uses the carried shovel itself; the default keeps the
    // established native-transfer backend evidence unchanged.
    let minedCoal = null;
    let coalTaken = [];
    let minedSnapshot = [];
    let fuelPut = 0;
    let scrapTaken = [];
    let scrapPayload = [];
    let chargePut = 0;
    const toolPoses = operatorMode === 'tools' ? await import('./industry-loading.js') : null;
    if (operatorMode === 'tools') {
      checks[meltBatchCheck] = false;
      markStage(scrapCells === 2 ? 'actual shovel charge-first loading (2 SCRAP comparison)' : 'actual shovel charge-first loading');
      edit([96, 30, 100], [97, 30, 99 + scrapCells / 2], E.SCRAP, 20, scrapLife, 0.625);
      await fence('finite cold scrap source');
      const load = physicalOperator.shovel.load;
      const scrapMine = await physicalOperator.act({ tool: 'SHOVEL', button: 'primary',
        pose: { feet: [98.5, 30, 94.5], target: [97, 30, 100] }, maxFrames: 120,
        done: () => load.cells.filter(c => c[0] === E.SCRAP).length === scrapCells, label: 'shovel mine finite SCRAP source' });
      observations.operator.actions.push(scrapMine);
      observations.operator.requiredActions = [{ label: scrapMine.label, completed: scrapMine.completed }];
      scrapTaken = load.cells.filter(c => c[0] === E.SCRAP).map(c => [...c]);
      scrapPayload = scrapTaken.map(c => [...c]);
      const scrapThrow = await physicalOperator.act({ tool: 'SHOVEL', button: 'secondary',
        pose: toolPoses.CHARGE_POSE, maxFrames: 120, settleFrames: 0,
        done: () => load.count === 0 && load.out === 0, label: 'shovel charge-first side-face throw' });
      observations.operator.actions.push(scrapThrow);
      observations.operator.requiredActions.push({ label: scrapThrow.label, completed: scrapThrow.completed });
      const chamber = [...hotRegions.fuel, ...hotRegions.charge];
      const chamberKeys = new Set(chamber.map(at => at.join(',')));
      const receipts = physicalOperator.snapshot().transfers.filter(r => r.tool === 'SHOVEL' && r.mode === TRANSFER_PUT)
        .flatMap(r => r.accepted).filter(slot => slot.payload[0] === E.SCRAP);
      chargePut = receipts.length;
      observations.fuel.operatorChargeSnapshots = [];
      for (const frames of [0, 2, 6]) {
        if (frames) await physicalOperator.waitFrames(frames, 'settle charge-first scrap');
        await fence('charge retention probe');
        const cells = await readCells(chamber);
        observations.fuel.operatorChargeSnapshots.push(chamber.flatMap((at, i) =>
          cells[i].id === E.SCRAP ? [{ at, ...cells[i] }] : []));
      }
      checks.operatorChargeDelivered = scrapTaken.length === scrapCells && chargePut === scrapCells
        && receipts.every(slot => chamberKeys.has(slot.at.join(',')))
        && observations.fuel.operatorChargeSnapshots.every(cells => cells.length === scrapCells)
        && observations.fuel.operatorChargeSnapshots.at(-1).every(cell => cell.at[1] === 13);
      observations.fuel.operatorChargeDump = { confirmedPackDecrease: scrapTaken.length - load.count,
        confirmedPutSlots: receipts, retainedScrap: load.cells.map(c => [...c]) };
      if (!checks.operatorChargeDelivered || !scrapMine.completed || !scrapThrow.completed)
        throw new Error('actual charge-first loading was not retained; stopped before fuel');
    }
    // Both finite sources use the same bounded stock scan and ordinary retargets.
    const collectToolCoal = async (receipt = {}) => {
      let exposed = false;
      for (let batch = 0; batch < 120 && !exposed; batch++) {
        await nativeStep(4);
        await fence('native miner output');
        exposed = (await readCells(coalSource)).some(cell => cell.id === E.BROKENCOAL);
      }
      const shovelLoad = physicalOperator.shovel.load;
      const stockCells = refuel
        ? boxCells({ x: [92, 99], y: [30, 32], z: [88, 103] })
        : boxCells({ x: [95, 99], y: [30, 32], z: [92, 98] });
      receipt.stockSearchCells = stockCells.length;
      const miningActions = [];
      receipt.actions = miningActions;
      for (let poll = 0; poll < 120 && shovelLoad.cells.filter(cell => cell[0] === E.BROKENCOAL).length < 6; poll++) {
        const stock = await readCells(stockCells);
        const at = stock.findIndex(cell => cell.id === E.BROKENCOAL);
        if (at < 0) { await nativeStep(4); await fence('wait for real miner output'); continue; }
        if (miningActions.length >= 12) break;
        const before = shovelLoad.cells.filter(cell => cell[0] === E.BROKENCOAL).length;
        const action = await physicalOperator.act({ tool: 'SHOVEL', button: 'primary',
          pose: { feet: [98.5, 30, 94.5], target: stockCells[at] }, maxFrames: 12,
          done: () => shovelLoad.cells.filter(cell => cell[0] === E.BROKENCOAL).length > before,
          label: 'shovel mine visible native BROKENCOAL' });
        miningActions.push(action);
        observations.operator.actions.push({ ...action, exposedBeforeDig: exposed });
      }
      receipt.exposed = exposed;
      receipt.payload = shovelLoad.cells.map(cell => [...cell]);
      if (refuel && receipt.payload.length !== 6) {
        const remaining = await readCells(stockCells);
        receipt.observedStockRemainder = stockCells.flatMap((at, i) =>
          remaining[i].id === E.BROKENCOAL ? [{ at, ...remaining[i] }] : []);
        const belowApron = boxCells({ x: [92, 99], y: [0, 2], z: [72, 91] });
        const fallen = await readCells(belowApron);
        receipt.observedBelowApron = belowApron.flatMap((at, i) =>
          fallen[i].id === E.BROKENCOAL ? [{ at, ...fallen[i] }] : []);
      }
      return { exposed, miningActions };
    };
    if (operatorMode === 'tools') {
      const { exposed, miningActions } = await collectToolCoal();
      const shovelLoad = physicalOperator.shovel.load;
      coalTaken = shovelLoad.cells.filter(cell => cell[0] === E.BROKENCOAL).map(cell => [...cell]);
      minedSnapshot = coalTaken.map(cell => [...cell]);
      observations.fuel.miningMethod = 'native Industry miner, actual POV shovel primary';
      observations.fuel.sourceTemperatureToleranceC = 1;
      observations.fuel.operatorMining = { exposed, actionFrames: miningActions.reduce((n, action) => n + action.frames, 0),
        rayHitFrames: miningActions.reduce((n, action) => n + action.hitFrames, 0),
        rayMissFrames: miningActions.reduce((n, action) => n + action.missFrames, 0),
        sourceSamples: miningActions.flatMap(action => action.hitSamples) };
      const remainingCoalSource = await readCells(coalSource);
      observations.fuel.minerSourceAfterShovel = coalSource.map((at, i) => ({ at, ...remainingCoalSource[i] }));

      const coalThrow = await physicalOperator.act({ tool: 'SHOVEL', button: 'secondary',
        pose: toolPoses.FUEL_POSE, maxFrames: 120,
        done: () => !shovelLoad.cells.some(cell => cell[0] === E.BROKENCOAL) && shovelLoad.out === 0,
        label: 'shovel throw mined coal into hearth' });
      observations.operator.actions.push(coalThrow);
      observations.operator.requiredActions.push({ label: coalThrow.label, completed: coalThrow.completed });
      await physicalOperator.waitFrames(8, 'settle real coal dump');
      const loadedFuelAfterCoal = await readCells(hotRegions.fuel);
      const loadedChargeAfterCoal = await readCells(hotRegions.charge);
      const rearCoal = hotRegions.fuel.flatMap((at, i) => loadedFuelAfterCoal[i].id === E.BROKENCOAL
        ? [{ at, ...loadedFuelAfterCoal[i] }] : []);
      const frontCoal = hotRegions.charge.flatMap((at, i) => loadedChargeAfterCoal[i].id === E.BROKENCOAL
        ? [{ at, ...loadedChargeAfterCoal[i] }] : []);
      fuelPut = rearCoal.length + frontCoal.length;
      observations.fuel.operatorCoalDistribution = { rearFuel: rearCoal, frontCharge: frontCoal,
        retainedPack: shovelLoad.cells.filter(cell => cell[0] === E.BROKENCOAL).map(cell => [...cell]),
        attemptedDumpFrames: coalThrow.frames, dumpRayHitFrames: coalThrow.hitFrames };
      observations.fuel.loadedBrokenCoal = rearCoal.length;
      observations.fuel.loadedBrokenCoalAcrossHearth = fuelPut;
      observations.fuel.operatorCoalDistributionAtDump = { rearFuel: rearCoal, frontCharge: frontCoal };
      checks.physicalMinedCoalPreserved = coalTaken.length === 6 && fuelPut === 6
        && minedSnapshot.every(cell => isColdLineMinedCoal(cell, coalLife))
        && [...rearCoal, ...frontCoal].every(cell => cell.id === E.BROKENCOAL);
    } else {
      minedCoal = new Load(6);
      for (let batch = 0; batch < 120 && minedCoal.count < 6; batch++) {
        await nativeStep(4);
        await fence('native miner output');
        const source = await readCells(coalSource);
        if (source.some(cell => cell.id === E.BROKENCOAL)) coalTaken.push(...await transferTake(minedCoal,
          { cells: coalSource, kinds: [K.POWDER], want: E.BROKENCOAL, limit: 6 - minedCoal.count }, 'collect actual miner output'));
      }
      minedSnapshot = minedCoal.cells.map(c => [...c]);
      if (coalTaken.length !== 6 || minedSnapshot.some(c => c[0] !== E.BROKENCOAL || c[1] !== 20 || c[2] !== coalLife)) {
        throw new Error(`native miner did not preserve six cold COAL→BROKENCOAL cells (got ${coalTaken.length})`);
      }
      observations.fuel.miningMethod = 'native Industry miner, then existing shovel transfer';
      fuelPut = await transferPut(minedCoal, hotRegions.fuel, 6, 'real broken-coal loading');
    }
    observations.fuel.minedCount = coalTaken.length;
    observations.fuel.minedPayload = minedSnapshot.map(c => ({ id: c[0], temperature: c[1], life: c[2], ctype: Math.floor(c[3]), seed: c[3] - Math.floor(c[3]) }));
    if (operatorMode === 'transfer') {
      edit([96, 30, 100], [97, 30, 101], E.SCRAP, 20, scrapLife, 0.625);
      await fence('finite cold scrap source');
    }
    if (operatorMode === 'tools') {
      const shovelLoad = physicalOperator.shovel.load;
      const [loadedFuel, loadedCharge] = await Promise.all([readCells(hotRegions.fuel), readCells(hotRegions.charge)]);
      const rearCoal = hotRegions.fuel.flatMap((at, i) => loadedFuel[i].id === E.BROKENCOAL
        ? [{ at, ...loadedFuel[i] }] : []);
      const frontCoal = hotRegions.charge.flatMap((at, i) => loadedCharge[i].id === E.BROKENCOAL
        ? [{ at, ...loadedCharge[i] }] : []);
      const coalStillInHearth = rearCoal.length + frontCoal.length;
      observations.fuel.operatorCoalDistribution = { rearFuel: rearCoal, frontCharge: frontCoal,
        retainedPack: shovelLoad.cells.filter(cell => cell[0] === E.BROKENCOAL).map(cell => [...cell]),
        loadingOrder: 'charge-first' };
      observations.fuel.operatorChargeDistribution = [
        ...hotRegions.fuel.map((at, i) => ({ at, ...loadedFuel[i] })),
        ...hotRegions.charge.map((at, i) => ({ at, ...loadedCharge[i] })),
      ].filter(cell => cell.id === E.SCRAP || cell.id === E.METAL || (cell.id === E.LAVA && cell.ctype === E.METAL));
      checks.operatorChargeDelivered &&= observations.fuel.operatorChargeDistribution.length === scrapCells;
      observations.fuel.loadedBrokenCoal = rearCoal.length;
      observations.fuel.loadedBrokenCoalAcrossHearth = coalStillInHearth;
      observations.fuel.loadedScrap = loadedCharge.filter(cell => cell.id === E.SCRAP).length;
      if (!checks.physicalMinedCoalPreserved) residualGaps.push(`real shovel coal handling: mined=${coalTaken.length}, hearth=${fuelPut}, retained=${observations.fuel.operatorCoalDistribution.retainedPack.length}`);
    } else {
      const scrapLoad = new Load(4);
      scrapTaken = await transferTake(scrapLoad, { cells: scrapSource, kinds: [K.POWDER, K.SOLID], want: E.SCRAP,
        ids: [E.SCRAP], limit: 4 }, 'physical scrap transfer');
      scrapPayload = scrapLoad.cells.map(c => [...c]);
      chargePut = await transferPut(scrapLoad, hotRegions.charge, 4, 'real scrap charge loading');
      const [loadedFuel, loadedCharge] = await Promise.all([readCells(hotRegions.fuel), readCells(hotRegions.charge)]);
      checks.physicalMinedCoalPreserved = coalTaken.length === 6 && fuelPut === 6
        && loadedFuel.filter(c => c.id === E.BROKENCOAL && c.life === coalLife && c.temperature === 20).length === 6;
      observations.fuel.loadedBrokenCoal = loadedFuel.filter(c => c.id === E.BROKENCOAL).length;
      observations.fuel.loadedBrokenCoalAcrossHearth = observations.fuel.loadedBrokenCoal;
      observations.fuel.loadedScrap = loadedCharge.filter(c => c.id === E.SCRAP).length;
    }
    observations.fuel.sourceScrapTaken = scrapTaken.length;
    observations.fuel.scrapPayload = scrapPayload.map(c => ({ id: c[0], temperature: c[1], life: c[2], ctype: Math.floor(c[3]), seed: c[3] - Math.floor(c[3]) }));
    observations.fuel.scrapPut = chargePut;
    if (operatorMode === 'transfer' && (scrapTaken.length !== 4 || chargePut !== 4 || observations.fuel.loadedScrap !== 4))
      throw new Error('four real SCRAP cells did not reach the physical charge bed');
    if (operatorMode === 'tools' && !checks.operatorChargeDelivered)
      residualGaps.push(`real shovel SCRAP handling: captured=${scrapTaken.length}, confirmedDump=${chargePut}, retained=${physicalOperator.shovel.load.cells.filter(cell => cell[0] === E.SCRAP).length}`);

    if (refuel) {
      markStage('stage one additional finite cold coal source and prefetch with actual shovel');
      const load = physicalOperator.shovel.load;
      if (!checks.physicalMinedCoalPreserved || !checks.operatorChargeDelivered || load.count || load.out
          || load.reserved || physicalOperator.belt.transfer.pending)
        throw new Error('refuel staging requires the first six fuel and four charge delivered and settled');
      const before = await readCells(coalSource);
      refuel.stagedSource = { atTick: observations.nativeTicks, cells: coalSource,
        before: coalSource.map((at, i) => ({ at, ...before[i] })),
        setup: 'ONE lab-provisioned finite six-cell cold COAL edit; not self-replenishing world or closed preseeded matter proof' };
      if (!before.every(cell => cell.id === E.EMPTY))
        throw new Error('refuel source contains foreign matter; no edit performed');
      edit([96, 30, 96], [98, 30, 97], E.COAL, 20, 1, 0.375);
      await fence('one finite cold refuel source');
      const staged = await readCells(coalSource);
      refuel.stagedSource.seeded = coalSource.map((at, i) => ({ at, ...staged[i] }));
      if (!staged.every(cell => cell.id === E.COAL && cell.temperature === 20 && cell.life === 1 && cell.seed === 0.375))
        throw new Error('finite refuel source did not read back as six cold full-life COAL cells');
      refuel.providedCoalCells = 12;
      refuel.prefetched = { startedAtTick: observations.nativeTicks };
      await collectToolCoal(refuel.prefetched);
      await fence('prefetched refuel proof fence');
      const sourceAfter = await readCells(coalSource);
      refuel.prefetched.atTick = observations.nativeTicks;
      refuel.prefetched.sourceAfter = coalSource.map((at, i) => ({ at, ...sourceAfter[i] }));
      checks.operatorRefuelColdMined = load.count === 6 && refuel.prefetched.payload.length === 6
        && refuel.prefetched.payload.every(cell => isColdLineMinedCoal(cell));
      checks.operatorRefuelSourceSettled = sourceAfter.every(cell => cell.id === E.EMPTY)
        && !load.out && !load.reserved && !physicalOperator.belt.transfer.pending;
      observations.operator.requiredActions.push({ label: 'prefetch six actual cold mined refuel cells',
        completed: checks.operatorRefuelColdMined && checks.operatorRefuelSourceSettled });
      if (!checks.operatorRefuelColdMined || !checks.operatorRefuelSourceSettled)
        throw new Error('bounded actual refuel mining did not collect and settle six cold full-life BROKENCOAL cells');
    }

    const refuelChamber = [...hotRegions.fuel, ...hotRegions.charge];
    const refuelChamberKeys = new Set(refuelChamber.map(at => at.join(',')));
    const doseRefuel = async sampled => {
      refuel.firstExhaustionTick = observations.nativeTicks;
      refuel.chamberBefore = sampled.filter(cell => refuelChamberKeys.has(cell.at.join(',')));
      const isCharge = cell => cell.id === E.SCRAP || cell.id === E.METAL
        || (cell.id === E.LAVA && cell.ctype === E.METAL);
      const load = physicalOperator.shovel.load;
      refuel.initialChamberLife = refuel.chamberBefore.filter(cell => [E.COAL, E.BROKENCOAL].includes(cell.id))
        .reduce((sum, cell) => sum + Math.max(0, cell.life), 0);
      refuel.payloadBeforeDose = load.cells.map(cell => [...cell]);
      refuel.carriedUnchanged = load.cells.length === refuel.prefetched.payload.length
        && load.cells.every((cell, i) => cell.every((value, j) => value === refuel.prefetched.payload[i][j]));
      if (refuel.chamberBefore.filter(isCharge).length !== 4 || load.count !== 6 || !refuel.carriedUnchanged
          || !load.cells.every(cell => isColdLineMinedCoal(cell)) || load.out || load.reserved)
        throw new Error('refuel requires all four chamber charge cells and six unchanged cold carried fuel cells');
      // Reserve room for at most 12 ordinary action frames, release, and four
      // settling frames. No partial action is started beyond the native cap.
      if (observations.nativeTicks + (12 + 1 + 4) * 4 > MAX_NATIVE_TICKS)
        throw new Error('refuel native tick budget reached before bounded dose');
      let dosePose = null;
      refuel.aimProbes = [];
      for (const candidate of lineRefuelPoses()) {
        const hit = await physicalOperator.probeRay(candidate.pose);
        refuel.aimProbes.push({ pose: candidate.pose, hit: hit ? {
          at: hit.cell.toArray(), id: hit.id, face: hit.face,
        } : null });
        if (hit?.id === E.TUNGSTEN && hit.face === candidate.face
            && hit.cell.toArray().every((v, i) => v === candidate.wall[i])) {
          dosePose = candidate.pose;
          break;
        }
      }
      if (!dosePose) throw new Error('refuel inner-wall sightline is blocked; no misleading shot attempted');
      refuel.dosePose = dosePose;
      markStage('one ordinary actual shovel refuel at sampled initial fuel exhaustion');
      refuel.attempts = 1;
      refuel.actionStartTick = observations.nativeTicks;
      const transferStart = physicalOperator.snapshot().transfers.length;
      const beforeCount = load.count;
      const action = await physicalOperator.act({ tool: 'SHOVEL', button: 'secondary',
        pose: dosePose, maxFrames: 12,
        done: () => load.count < beforeCount && load.out === 0,
        label: 'shovel one bounded actual refuel dose' });
      observations.operator.actions.push(action);
      observations.operator.requiredActions.push({ label: action.label, completed: action.completed });
      refuel.action = action;
      refuel.retainedPayload = load.cells.map(cell => [...cell]);
      await physicalOperator.waitFrames(4, 'settle ordinary refuel dose');
      const snapshot = physicalOperator.snapshot();
      refuel.doseTransfers = snapshot.transfers.slice(transferStart);
      refuel.acceptedSlots = refuel.doseTransfers.filter(r => r.tool === 'SHOVEL' && r.mode === TRANSFER_PUT)
        .flatMap(r => r.accepted);
      refuel.acceptedCount = refuel.acceptedSlots.length;
      refuel.retainedPayload = load.cells.map(cell => [...cell]);
      refuel.settledAtTick = observations.nativeTicks;
      const after = await readCells(refuelChamber);
      refuel.chamberAfter = refuelChamber.map((at, i) => ({ at, ...after[i] }));
      checks.operatorRefuelDoseConfirmed = refuel.attempts === 1 && action.completed && !action.failure
        && refuel.acceptedCount > 0 && beforeCount - load.count === refuel.acceptedCount
        && refuel.acceptedSlots.every(slot => refuelChamberKeys.has(slot.at.join(',')) && isColdLineMinedCoal(slot.payload))
        && load.cells.every(cell => isColdLineMinedCoal(cell))
        && !load.out && !load.reserved && !physicalOperator.belt.transfer.pending
        && !snapshot.omittedTransfers && !snapshot.traceErrors.length
        && snapshot.transfers.every(r => !r.pending && !r.error);
      checks.operatorRefuelChargeRetained = refuel.chamberBefore.filter(isCharge).length === 4
        && refuel.chamberAfter.filter(isCharge).length === 4;
      if (!checks.operatorRefuelDoseConfirmed || !checks.operatorRefuelChargeRetained)
        residualGaps.push('one actual refuel dose did not confirm a positive chamber-only PUT and all four retained charge cells');
    };

    markStage('open gate and release actual pumped coolant');
    const openGate = { ...currentGate, gateMode: 'open', gateClosed: true };
    await gateStepTo(openGate, GATE_STATUS.OPEN, 'coolant gate release');
    currentGate = { ...openGate, gateClosed: false };
    const openLeaf = await readCells(gateLeaf);
    checks.gateReleaseAndPumpConfirmed = gates.status(currentGate.id)?.status === GATE_STATUS.OPEN
      && openLeaf.every(c => c.id === E.EMPTY);
    observations.gate.openStatus = gates.status(currentGate.id)?.status;
    observations.gate.openLeafEmpty = openLeaf.filter(c => c.id === E.EMPTY).length;
    await ensureSwitch(true);
    pumpActive = true;
    observations.gate.pumpSwitchOn = true;

    markStage('native hearth heat, real pump flow, and physical shipment');
    let lastSampleTick = -Infinity;
    let lastPumpCheckpoint = 0;
    let bucketLoad = physicalOperator?.bucket.load ?? null;
    let bucketPoured = 0;
    let pumpStopped = false;
    let exhausted = false;
    let waterPeakBeforePour = null;
    let pumpOutputAtOff = null;
    let lastScoopProbeTick = -Infinity;
    const pumpOutputTarget = 32;
    observations.water.pumpOutputTarget = pumpOutputTarget;
    const pollEveryTicks = 24;
    while (Date.now() < until && observations.nativeTicks < MAX_NATIVE_TICKS) {
      await nativeStep(4);
      if (observations.nativeTicks % 32 === 0 || industry.pending) await fence('native batch/readback fence');
      if (observations.nativeTicks - lastSampleTick >= pollEveryTicks) {
        const sampled = await scanHearth();
        lastSampleTick = observations.nativeTicks;
        const hasMetalLava = sampled.some(c => c.id === E.LAVA && c.ctype === E.METAL);
        if (hasMetalLava) checks.nativeMetalMelt = true;
        const fuelLife = sampled.filter(c => [E.COAL, E.BROKENCOAL].includes(c.id)).reduce((sum, c) => sum + Math.max(0, c.life), 0);
        if (fuelLife <= 0 && sampled.some(c => c.id === E.ASH)) exhausted = true;
        const initialChamberLife = refuel && sampled.filter(c => refuelChamberKeys.has(c.at.join(','))
          && [E.COAL, E.BROKENCOAL].includes(c.id)).reduce((sum, c) => sum + Math.max(0, c.life), 0);
        if (refuel && refuel.attempts === 0 && initialChamberLife <= 0) {
          await doseRefuel(sampled);
          // Exhaustion of the first batch is not exhaustion of the new dose.
          exhausted = false;
          continue;
        }
        const molten = sampled.filter(c => c.id === E.LAVA && c.ctype === E.METAL);
        if (operatorMode === 'tools' && hasMetalLava && bucketPoured < scrapCells && bucketLoad.count === 0
            && (!refuel || (checks.operatorRefuelDoseConfirmed && checks.operatorRefuelChargeRetained))
            && observations.nativeTicks - lastScoopProbeTick >= 96) {
          lastScoopProbeTick = observations.nativeTicks;
          let pose = null;
          // Aim at a real visible surface, not a fixed cell hidden by ash/coal.
          // Both feet positions are on the already constructed external platform.
          for (const cell of molten) {
            for (const z of [17.5, 18.5]) {
              const feet = [20.01, 16, z];
              const candidate = { feet, direction: [cell.at[0] + 0.5 - feet[0],
                cell.at[1] + 0.999 - 21, cell.at[2] + 0.5 - feet[2]] };
              const hit = await physicalOperator.probeRay(candidate);
              if (hit?.id === E.LAVA) { pose = candidate; break; }
            }
            if (pose) break;
          }
          if (pose) {
            markStage('actual BUCKET scoop of visible native METAL-ctype LAVA');
            const scoop = await physicalOperator.act({ tool: 'BUCKET', button: 'primary',
              pose, maxFrames: 24,
              done: () => bucketLoad.count > 0, label: 'bucket scoop observed native LAVA' });
            observations.operator.actions.push(scoop);
            const payload = bucketLoad.cells.map(c => ({ id: c[0], temperature: c[1], life: c[2], ctype: Math.floor(c[3]), seed: c[3] - Math.floor(c[3]) }));
            observations.cargo.bucketCells.push(...payload);
            checks[meltBatchCheck] = lineMoltenCargoComplete(observations.cargo.bucketCells, scrapCells);
            if (checks[meltBatchCheck]) {
              observations.operator.moltenBatch = observations.cargo.bucketCells.map(cell => ({ ...cell }));
              observations.operator.moltenBatchScope = 'cumulative native molten cargo collected through the real bucket';
            }
            observations.cargo.bucketAfterScoop = { count: bucketLoad.count, payload };
            if (payload.length > 0 && payload.every(c => c.id === E.LAVA && c.ctype === E.METAL)) {
              checks.bucketCarriedActualLava = true;
            } else residualGaps.push('real BUCKET did not carry only observed native LAVA(METAL) cells');
          } else observations.operator.blockedScoopProbes = (observations.operator.blockedScoopProbes ?? 0) + 1;
        } else if (operatorMode === 'transfer' && hasMetalLava && bucketPoured + (bucketLoad?.count ?? 0) < 4) {
          markStage('bucket actual native METAL-ctype LAVA');
          bucketLoad ??= new Load(4);
          const lavaCells = [...hotRegions.fuel, ...hotRegions.charge, ...hotRegions.outlet, ...hotRegions.mouth];
          const taken = await transferTake(bucketLoad, { cells: lavaCells, kinds: [K.LIQUID], want: E.LAVA,
            ids: [E.LAVA], limit: 4 - bucketPoured - bucketLoad.count }, 'actual molten-metal bucket take');
          const payload = taken.map(c => ({ id: c[0], temperature: c[1], life: c[2], ctype: Math.floor(c[3]), seed: c[3] - Math.floor(c[3]) }));
          observations.cargo.bucketCells.push(...payload);
          if (taken.length > 0 && payload.every(c => c.id === E.LAVA && c.ctype === E.METAL)) {
            checks.bucketCarriedActualLava = true;
          } else residualGaps.push('molten-metal bucket transfer did not confirm native LAVA(METAL) cargo');
        }
        if (bucketLoad?.count) {
          const pool = await readCells(catchCells);
          const poolByCell = new Map(catchCells.map((at, i) => [at.join(','), pool[i]]));
          const water = pool.filter(cell => cell.id === E.WATER);
          if (water.length) {
            checks.waterReachedShippingCatch = true;
            observations.water.catchWaterObservedAtTick ??= observations.nativeTicks;
            observations.water.catchWaterObservedCells = Math.max(observations.water.catchWaterObservedCells ?? 0, water.length);
          }
          const pourCells = catchCells.flatMap((at, i) => {
            const above = [at[0], at[1] + 1, at[2]];
            return pool[i].id === E.WATER && poolByCell.get(above.join(','))?.id === E.EMPTY ? [above] : [];
          });
          if (operatorMode === 'tools' && water.length && bucketPoured < scrapCells && bucketLoad.count > 0) {
            waterPeakBeforePour ??= Math.max(...water.map(cell => cell.temperature));
            const before = bucketLoad.count;
            const wanted = Math.min(scrapCells - bucketPoured, before);
            markStage('actual BUCKET pour from the real spout into the shipping catch');
            const pour = await physicalOperator.act({ tool: 'BUCKET', button: 'secondary',
              pose: { feet: [43.2, 19, 53.5], direction: [0.18, -1, 0] }, maxFrames: 120,
              done: () => before - bucketLoad.count >= wanted,
              label: 'bucket pour through real collector spout' });
            observations.operator.actions.push(pour);
            const placed = Math.max(0, before - bucketLoad.count);
            bucketPoured += placed;
            observations.cargo.bucketPoured = bucketPoured;
            observations.cargo.bucketAfterPour = { count: bucketLoad.count,
              retained: bucketLoad.cells.map(c => ({ id: c[0], temperature: c[1], life: c[2], ctype: Math.floor(c[3]) })),
              attempted: wanted, actualOut: placed, actionFrames: pour.frames, rayHitFrames: pour.hitFrames };
            if (placed) {
              await physicalOperator.waitFrames(4, 'settle actual bucket pour');
              const afterCatch = await readCells(catchCells);
              const pouredLava = catchCells.flatMap((at, i) => afterCatch[i].id === E.LAVA && afterCatch[i].ctype === E.METAL
                ? [{ at, ...afterCatch[i] }] : []);
              observations.cargo.bucketObservedInCatch = pouredLava;
              // A positive actual bucket load decrease means its real put transfer
              // landed in the five open cells around the declared collector spout.
              checks.bucketPouredActualLavaIntoCatch ||= placed > 0;
            }
          } else if (operatorMode === 'transfer' && pourCells.length) {
            waterPeakBeforePour ??= Math.max(...water.map(cell => cell.temperature));
            const placed = await transferPut(bucketLoad, pourCells, 4, 'actual bucket pour above observed coolant');
            bucketPoured += placed;
            checks.bucketPouredActualLavaIntoCatch ||= placed > 0;
            observations.cargo.bucketPoured = bucketPoured;
          }
        }
      }
      if (!pumpStopped && observations.water.confirmedOutput >= pumpOutputTarget && checks.waterReachedShippingCatch
          && industry.pending === 0 && industry.buffered === 0) {
        await ensureSwitch(false);
        pumpActive = false;
        pumpStopped = true;
        observations.gate.pumpSwitchOffAfterConfirmedCells = observations.water.confirmedOutput;
        pumpOutputAtOff = observations.water.confirmedOutput;
        observations.water.pumpShutdownCatchWaterCells = observations.water.catchWaterObservedCells ?? 0;
        observations.water.pumpShutdownCatchWaterObservedAtTick = observations.water.catchWaterObservedAtTick ?? null;
        observations.water.pumpShutdownAtTick = observations.nativeTicks;
        observations.water.pumpShutdownConditionsMet = true;
        checks.nativePumpSwitchOffOnOffSequence = observations.gate.pumpSwitchInitial === 'OFF'
          && switchState === false && observations.water.confirmedOutput >= pumpOutputTarget
          && observations.water.pumpShutdownCatchWaterCells > 0
          && observations.water.pumpShutdownCatchWaterObservedAtTick <= observations.water.pumpShutdownAtTick;
      }
      if (observations.nativeTicks - lastPumpCheckpoint >= 96) {
        lastPumpCheckpoint = observations.nativeTicks;
        await fence('water-flow checkpoint');
        if (!observations.water.firstRunningPumpProbe) {
          const probe = await diagnostics.inspect(pump);
          observations.water.firstRunningPumpProbe = { status: probe.status, evidence: probe.evidence };
          observations.water.runningSwitch = await readCell(switchAt);
          const contents = await readCells(waterWatchCells);
          observations.water.releasedWaterLocations = waterWatchCells.flatMap((at, i) =>
            contents[i].id === E.WATER ? [{ at, ...contents[i] }] : []);
        }
        const catchWater = await readCells(catchCells);
        const coldMetal = observations.shipments.filter(s => s.id === E.METAL && s.temperature <= 400);
        const catchWaterCells = catchWater.filter(c => c.id === E.WATER);
        checks.waterReachedShippingCatch ||= catchWaterCells.length > 0;
        observations.water.catchWaterCells = catchWaterCells.length;
        if (catchWaterCells.length) {
          observations.water.catchWaterObservedAtTick ??= observations.nativeTicks;
          observations.water.catchWaterObservedCells = Math.max(observations.water.catchWaterObservedCells ?? 0, catchWaterCells.length);
        }
        observations.water.catchWaterHeatC = catchWaterCells.length ? {
          min: Math.min(...catchWaterCells.map(c => c.temperature)),
          max: Math.max(...catchWaterCells.map(c => c.temperature)),
          mean: catchWaterCells.reduce((sum, c) => sum + c.temperature, 0) / catchWaterCells.length,
        } : null;
        observations.water.catchSteamCells = catchWater.filter(c => c.id === E.STEAM).length;
        observations.water.steamObserved = Math.max(observations.water.steamObserved, observations.water.catchSteamCells);
        if (bucketPoured && waterPeakBeforePour !== null) checks.waterInteractedWithMelt ||=
          observations.water.catchSteamCells > 0 || catchWaterCells.some(cell => cell.temperature > waterPeakBeforePour + 1);
        observations.water.catchMetalCells = catchWater.filter(c => c.id === E.METAL).length;
        if (pumpStopped && bucketPoured === scrapCells && coldMetal.reduce((sum, shipment) => sum + shipment.count, 0) === scrapCells
            && checks.waterInteractedWithMelt) break;
      }
      // Promise callbacks and native readbacks must run between small native batches.
      if (observations.nativeTicks % 16 === 0) await Promise.resolve();
    }
    if (observations.nativeTicks >= MAX_NATIVE_TICKS) residualGaps.push('4,800-tick native safety cap reached');
    if (pumpActive) {
      while (industry.pending) await fence('settle pre-shutdown pump transactions');
      await ensureSwitch(false);
      pumpOutputAtOff = observations.water.confirmedOutput;
      pumpActive = false;
    }
    observations.water.finalConfirmedInput = observations.water.confirmedInput;
    observations.water.finalConfirmedOutput = observations.water.confirmedOutput;
    observations.water.pumpShutdownConditionsMet ??= false;
    observations.water.pumpOutputTargetReached = observations.water.confirmedOutput >= pumpOutputTarget;
    observations.water.pumpCatchWaterObserved = checks.waterReachedShippingCatch;
    observations.water.pumpSwitchOffAfterConditions = pumpStopped;
    observations.water.pumpOutputAtOff = pumpOutputAtOff;
    checks.realWaterPumpConfirmed = observations.water.confirmedInput > 0 && observations.water.confirmedOutput > 0;
    checks.gateReleaseAndPumpConfirmed = checks.gateReleaseAndPumpConfirmed && checks.realWaterPumpConfirmed;
    if (!checks.nativePumpSwitchOffOnOffSequence) residualGaps.push(`native pump SWITCH did not complete OFF→ON→OFF after ${pumpOutputTarget} confirmed outlet cells and observed water in the real shipping catch`);
    if (!checks.realWaterPumpConfirmed) residualGaps.push('real coolant pump did not confirm both native water intake and outlet transfers');
    if (!checks.bucketCarriedActualLava) residualGaps.push('no actual LAVA(METAL) cell was carried out by the bounded bucket transfer');
    if (!checks.bucketPouredActualLavaIntoCatch) residualGaps.push('bucket cargo did not confirm placement into the real shipping catch');

    markStage('verify cold shipment, exhaust, and shovel-only ash cleanup');
    await fence('final batch fence');
    const finalHearth = await scanHearth();
    checks.nativeMetalMelt ||= finalHearth.some(c => c.id === E.LAVA && c.ctype === E.METAL)
      || observations.cargo.bucketCells.some(c => c.id === E.LAVA && c.ctype === E.METAL);
    const coldShipments = observations.shipments.filter(s => s.id === E.METAL && Number.isFinite(s.temperature) && s.temperature <= 400);
    checks.coldMetalConfirmedShipped = coldShipments.reduce((sum, shipment) => sum + shipment.count, 0) === scrapCells;
    observations.cargo.industryBufferAtEnd = industry.buffered;
    observations.shipments = observations.shipments.map(s => ({ ...s }));

    if (bucketLoad?.count) {
      observations.cargo.residuals.push({ kind: 'bucket-cargo', cells: bucketLoad.cells.map(c => ({ id: c[0], temperature: c[1], life: c[2], ctype: Math.floor(c[3]) })) });
    }
    // Let remaining real fuel exhaust only while time and native tick budget permit.
    while (!exhausted && Date.now() < until && observations.nativeTicks + 4 <= MAX_NATIVE_TICKS) {
      await nativeStep(4);
      if (observations.nativeTicks % 48 === 0) {
        const sampled = await scanHearth();
        exhausted = sampled.filter(c => [E.COAL, E.BROKENCOAL].includes(c.id)).every(c => c.life <= 0);
      }
      if (observations.nativeTicks % 16 === 0) await fence('fuel exhaustion fence');
    }
    observations.fuel.sampledChamberFuelExhausted = exhausted;
    if (!checks.realFuelSpent) residualGaps.push('no actual fuel-life decrease or naturally produced ash was observed');

    const ashLoads = [];
    const wallsBefore = await readCells(shellCells);
    const ashBefore = await readCells(ashRegion);
    const ashInitially = ashBefore.filter(c => c.id === E.ASH).length;
    let ashTotal = 0;
    let ashAfter = ashBefore;
    if (operatorMode === 'tools') {
      const shovelLoad = physicalOperator.shovel.load;
      const carriedAshBefore = shovelLoad.cells.filter(cell => cell[0] === E.ASH).length;
      let ashIndex = ashAfter.findIndex(cell => cell.id === E.ASH);
      let target = ashIndex >= 0 ? ashRegion[ashIndex] : null;
      for (let i = 0; i < 8 && target && Date.now() < until && observations.nativeTicks + 8 <= MAX_NATIVE_TICKS; i++) {
        const action = await physicalOperator.act({ tool: 'SHOVEL', button: 'primary',
          pose: { feet: [16.5, 16, target[2] + 0.5], target },
          maxFrames: Math.min(18, Math.floor((MAX_NATIVE_TICKS - observations.nativeTicks) / 4) - 1),
          done: () => shovelLoad.cells.filter(cell => cell[0] === E.ASH).length - carriedAshBefore >= ashInitially,
          label: `shovel actual ash cleanup ${i + 1}` });
        observations.operator.actions.push(action);
        ashAfter = await readCells(ashRegion);
        ashIndex = ashAfter.findIndex(cell => cell.id === E.ASH);
        target = ashIndex >= 0 ? ashRegion[ashIndex] : null;
        if (action.hitFrames === 0 && target) observations.operator.ashMisses = (observations.operator.ashMisses ?? 0) + 1;
      }
      ashTotal = shovelLoad.cells.filter(cell => cell[0] === E.ASH).length - carriedAshBefore;
      observations.cargo.operatorAshPayload = shovelLoad.cells.filter(cell => cell[0] === E.ASH).map(cell => [...cell]);
      if (refuel) observations.cargo.operatorAshMixedPayload = shovelLoad.cells.map(cell => [...cell]);
      if (target && observations.nativeTicks + 8 > MAX_NATIVE_TICKS)
        observations.cargo.ashCleanupSkippedReason = 'native tick budget reached';
      ashAfter = await readCells(ashRegion);
    } else {
      for (let i = 0; i < 4 && ashAfter.some(c => c.id === E.ASH) && Date.now() < until; i++) {
        // Use the shovel's ordinary powder take, not an ash-only filter. Keep each
        // bounded Load at eight cells and retain every cell it actually carries.
        const ashLoad = new Load(8);
        const taken = await transferTake(ashLoad, { cells: ashRegion, kinds: [K.POWDER], limit: 8 }, 'physical shovel cleanup');
        if (!taken.length) break;
        ashLoads.push(ashLoad);
        ashTotal += taken.filter(c => c[0] === E.ASH).length;
        ashAfter = await readCells(ashRegion);
      }
    }
    const wallsAfter = await readCells(shellCells);
    ashAfter = await readCells(ashRegion);
    const leftAsh = ashAfter.filter(c => c.id === E.ASH).length;
    const wallsIntact = wallsAfter.length === 48 && wallsAfter.every(c => c.id === E.TUNGSTEN)
      && wallsBefore.every((c, i) => c.id === E.TUNGSTEN && wallsAfter[i].id === c.id);
    checks.ashRemovedWithoutWallLoss = ashInitially > 0 && ashTotal === ashInitially && wallsIntact && leftAsh === 0;
    observations.cargo.ashBefore = ashInitially;
    observations.cargo.ashTaken = ashTotal;
    observations.cargo.ashRemaining = leftAsh;
    if (ashLoads.length) observations.cargo.residuals.push({ kind: 'shovel-powder-cargo', cells: ashLoads.flatMap(load => load.cells.map(c => ({ id: c[0], temperature: c[1], life: c[2], ctype: Math.floor(c[3]) }))) });
    observations.cargo.hearthWallsAfterAsh = wallsAfter.filter(c => c.id === E.TUNGSTEN).length;
    if (!checks.ashRemovedWithoutWallLoss) residualGaps.push(ashInitially === 0
      ? 'no naturally produced eligible ASH was present in the 3³ shovel region'
      : 'ordinary shovel powder cleanup did not remove every observed ASH cell while preserving all hearth walls');

    const gateBaseEnd = await readCells(gateBase);
    observations.gate.basePeakC = Math.max(...gateBaseEnd.map(c => c.temperature));
    observations.water.sourceWaterRemaining = (await readCells(waterSource)).filter(c => c.id === E.WATER).length;
    observations.water.inletWaterRemaining = (await readCells(inletCells)).filter(c => c.id === E.WATER).length;
    const pumpPlateEnd = await readCells(pumpBackplateCells(pump));
    checks.pumpBackplateOwnership = pumpPlateEnd.length === 24
      && pumpPlateEnd.every(c => c.id === E.TUNGSTEN && c.life === PUMP_BACKPLATE_TAG);
    const spoutEnd = await readCells(spoutCells);
    observations.water.spoutContents = spoutCells.flatMap((at, i) => spoutEnd[i].id !== E.EMPTY
      ? [{ at, ...spoutEnd[i] }] : []);
    observations.cargo.industryBufferAtEnd = industry.buffered;
    if (bucketLoad?.count) observations.cargo.residuals.push({ kind: 'bucket-cargo', cells: bucketLoad.cells.map(cell => [...cell]) });
    if (physicalOperator) {
      observations.operator.finalLoads = physicalOperator.snapshot();
      if (refuel) {
        refuel.finalRetainedPayload = physicalOperator.shovel.load.cells.map(cell => [...cell]);
        refuel.carriedChemicalFuelLife = refuel.finalRetainedPayload.filter(cell => [E.COAL, E.BROKENCOAL].includes(cell[0]))
          .reduce((sum, cell) => sum + Math.max(0, cell[2]), 0);
        refuel.exhaustionScope = 'sampled chamber only; retained chemical fuel in actual tool cargo is not spent';
      }
      observations.operator.actionFailures = observations.operator.actions.filter(action => action.failure)
        .map(({ label, failure }) => ({ label, failure }));
      checks.operatorActionsWithoutErrors = observations.operator.actionFailures.length === 0;
      checks.operatorRequiredActionsComplete = observations.operator.requiredActions?.length === (refuel ? 5 : 3)
        && observations.operator.requiredActions.every(action => action.completed);
      checks.operatorBucketDelivered = bucketPoured === scrapCells && physicalOperator.bucket.load.count === 0
        && observations.cargo.bucketCells.length === scrapCells
        && observations.cargo.bucketCells.every(cell => cell.id === E.LAVA && cell.ctype === E.METAL);
      const nativePours = observations.operator.finalLoads.transfers
        .filter(r => r.tool === 'BUCKET' && r.mode === TRANSFER_PUT).flatMap(r => r.accepted)
        .filter(slot => slot.payload[0] === E.LAVA && Math.floor(slot.payload[3]) === E.METAL);
      const catchKeys = new Set(catchCells.map(at => at.join(',')));
      checks.operatorBucketDelivered &&= nativePours.length === scrapCells && nativePours.every(slot => catchKeys.has(slot.at.join(',')));
      checks.operatorTraceIntegrity = observations.operator.finalLoads.traceErrors.length === 0
        && observations.operator.finalLoads.omittedTransfers === 0
        && observations.operator.finalLoads.transfers.every(r => !r.error && !r.pending);
      observations.operator.cargoAccounting = { complete: false,
        note: 'Actual tool payloads and retained loads are recorded; this operator run does not claim complete world-wide cargo conservation.' };
      if (physicalOperator.shovel.load.count) observations.cargo.residuals.push({ kind: 'operator-shovel-pack',
        cells: physicalOperator.shovel.load.cells.map(cell => ({ id: cell[0], temperature: cell[1], life: cell[2], ctype: Math.floor(cell[3]), seed: cell[3] - Math.floor(cell[3]) })) });
      checks.operatorTransfersSettled = !physicalOperator.shovel.load.out && !physicalOperator.bucket.load.out
        && !physicalOperator.shovel.load.reserved && !physicalOperator.bucket.load.reserved
        && !physicalOperator.belt.transfer.pending;
      if (!checks.operatorTransfersSettled) residualGaps.push('operator cargo still had transfer work outstanding at final inspection');
      if (scrapCells === 2) {
        // Required operations and physical delivery checks govern completion.
        // A bounded retarget miss is not an unfinished required operation.
        checks.nativeJobsSettled = industry.pending === 0 && industry.buffered === 0 && !gates.pending
          && !controls.pending && !transfer.pending && !diagnostics.pending;
      }
    }
    observations.water.finalConfirmedInput = observations.water.confirmedInput;
    observations.water.finalConfirmedOutput = observations.water.confirmedOutput;
    checks.nativePumpSwitchOffOnOffSequence &&= observations.water.confirmedOutput === pumpOutputAtOff;
    if (industry.buffered) observations.cargo.residuals.push({ kind: 'industry-pump-buffer', cells: industry.buffered });
    if (observations.gate.basePeakC >= 100) residualGaps.push('gate INSULATOR base did not remain cold (<100°C)');
    if (gateBaseEnd.some(c => c.id !== E.INSULATOR) || observations.gate.basePeakC >= 100) throw new Error('coolant-gate INSULATOR base was damaged or heated');
    checks.gateClosedSourceHeld = checks.gateClosedSourceHeld && gateBaseEnd.every(c => c.id === E.INSULATOR && c.temperature < 100);
    if (asyncErrors.length) residualGaps.push(`native module callback errors: ${asyncErrors.join('; ')}`);
    observations.asyncErrors = asyncErrors;
    checks.nativeTickAccounting = sim.frame - nativeFrameStart === observations.nativeTicks && observations.nativeTicks > 0;
    observations.elapsedMs = Date.now() - startedAt;

    const passed = Object.values(checks).every(Boolean) && asyncErrors.length === 0;
    return { case: 'line', declaredScrapCells: scrapCells, status: passed ? 'passed' : 'bounded-incomplete', checks, observations,
      residualGaps: [...new Set(residualGaps)] };
  } catch (error) {
    observations.elapsedMs = Date.now() - startedAt;
    observations.lastError = cleanError(error);
    observations.partialStage = observations.stage ?? 'setup';
    if (!residualGaps.length) residualGaps.push('bounded native physical batch did not complete; no unobserved phase or cargo is credited');
    residualGaps.push('Interrupted runs do not establish complete accounting of outstanding loads and pending transfers.');
    observations.asyncErrors = [...asyncErrors];
    if (refuel && physicalOperator) refuel.interruptedLoads = physicalOperator.snapshot();
    return { case: 'line', declaredScrapCells: scrapCells, status: Date.now() >= until || (refuel && /bounded actual refuel mining|native tick budget reached/.test(observations.lastError))
      ? 'bounded-incomplete' : 'failed', checks, observations,
      residualGaps: [...new Set(residualGaps)] };
  } finally {
    // Tear down only this fixture's own async Industry jobs; the caller owns sim/gpu.
    if (!disposed) {
      disposed = true;
      try { await physicalOperator?.dispose(); } catch {}
      try { gates?.dispose(); } catch {}
      try { controls?.dispose(); } catch {}
      try { industry?.dispose(); } catch {}
      try { transfer?.dispose(); } catch {}
      try { diagnostics?.dispose(); } catch {}
      if (Date.now() < until && gpu && !sim?.disposed) {
        try { await bounded(gpu.fence(), 'fixture cleanup fence'); } catch {}
      }
    }
  }
}

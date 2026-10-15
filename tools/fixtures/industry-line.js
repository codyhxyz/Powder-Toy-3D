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

const BOUNDS = [128, 128, 128];
const NATIVE_DT = 4 / 240;
const MAX_NATIVE_TICKS = 4_800;
const FOUNDATION = (id, x, y, z) => ({ id, type: 'foundation', x, y, z, rotation: 0 });

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

// Each foundation tile is an ordinary 4x4 build placed at every listed height.
// Keep the sealed tank/catch walls explicit and CPU-check their corners below.
export const LINE_FOUNDATION_COLUMNS = Object.freeze([
  ['spout-tower', 48, 52, 12, 16],
  ['catch-left', 40, 52, 15, 18],
  ['catch-rear', 44, 48, 15, 18],
  ['catch-front', 44, 56, 15, 18],
  ['spout-channel-back', 48, 48, 17, 18],
  ['spout-channel-front', 48, 56, 17, 18],
  ['tank-north-west', 52, 48, 13, 15],
  ['tank-north-east', 56, 48, 13, 15],
  ['tank-south-west', 52, 56, 13, 15],
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
export function purelineDeviceLayout() {
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
  return devices;
}

const cleanError = error => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 400);

/**
 * Run one physical Sandustry batch in the caller-owned native simulation.
 * This function deliberately creates no browser, server, simulation, or bypass.
 */
export async function runIndustryLine({ sim, gpu, deadline, stage = () => {} } = {}) {
  const startedAt = Date.now();
  const until = Number.isFinite(deadline) ? deadline : startedAt + 20_000;
  const devices = validateDevices(purelineDeviceLayout(), BOUNDS);
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
  for (let z = 100; z <= 101; z++) for (let x = 96; x <= 97; x++) scrapSource.push([x, 30, z]);
  const switchAt = deviceCell(pump, -1, 0, 1);
  const catchCells = machinePorts(ship).mouth;
  const waterWatchCells = [...new Map([...waterSource, ...inletCells, ...outletCells, ...catchCells]
    .map(at => [at.join(','), at])).values()];
  const ashRegion = [];
  for (let z = 17; z <= 19; z++) for (let y = 13; y <= 15; y++) for (let x = 17; x <= 19; x++) ashRegion.push([x, y, z]);

  const checks = {
    atomicStructures: false,
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
  const residualGaps = [];
  const asyncErrors = [];
  let construction = null, gates = null, controls = null, industry = null, transfer = null, diagnostics = null;
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
    if (observations.bounds.some((n, i) => n !== BOUNDS[i])) throw new Error(`expected native 128³ bounds, got ${observations.bounds.join('x')}`);
    ensureTime('fixture setup');
    markStage('native industry fixture setup');
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
      gateBaseMaterial: E.INSULATOR, gateBaseCells: gateBaseCells.length, initialGateLeafCells: gateLeaf.length };

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

    // Exercise the real miner's COAL→BROKENCOAL output, including remaining life.
    // Collect each exposed row before its next native movement, like a continuously
    // held shovel. This is backend evidence, not a claim about player aiming.
    const minedCoal = new Load(6);
    const coalTaken = [];
    for (let batch = 0; batch < 120 && minedCoal.count < 6; batch++) {
      await nativeStep(4);
      await fence('native miner output');
      const source = await readCells(coalSource);
      if (source.some(cell => cell.id === E.BROKENCOAL)) coalTaken.push(...await transferTake(minedCoal,
        { cells: coalSource, kinds: [K.POWDER], want: E.BROKENCOAL, limit: 6 - minedCoal.count }, 'collect actual miner output'));
    }
    const minedSnapshot = minedCoal.cells.map(c => [...c]);
    observations.fuel.minedCount = coalTaken.length;
    observations.fuel.minedPayload = minedSnapshot.map(c => ({ id: c[0], temperature: c[1], life: c[2], ctype: Math.floor(c[3]), seed: c[3] - Math.floor(c[3]) }));
    if (coalTaken.length !== 6 || minedSnapshot.some(c => c[0] !== E.BROKENCOAL || c[1] !== 20 || c[2] !== coalLife)) {
      throw new Error(`native miner did not preserve six cold COAL→BROKENCOAL cells (got ${coalTaken.length})`);
    }
    observations.fuel.miningMethod = 'native Industry miner, then existing shovel transfer';
    const fuelPut = await transferPut(minedCoal, hotRegions.fuel, 6, 'real broken-coal loading');
    edit([96, 30, 100], [97, 30, 101], E.SCRAP, 20, scrapLife, 0.625);
    await fence('finite cold scrap source');
    const scrapLoad = new Load(4);
    const scrapTaken = await transferTake(scrapLoad, { cells: scrapSource, kinds: [K.POWDER, K.SOLID], want: E.SCRAP,
      ids: [E.SCRAP], limit: 4 }, 'physical scrap transfer');
    const scrapPayload = scrapLoad.cells.map(c => [...c]);
    const chargePut = await transferPut(scrapLoad, hotRegions.charge, 4, 'real scrap charge loading');
    const loadedFuel = await readCells(hotRegions.fuel);
    const loadedCharge = await readCells(hotRegions.charge);
    checks.physicalMinedCoalPreserved = coalTaken.length === 6 && fuelPut === 6
      && loadedFuel.filter(c => c.id === E.BROKENCOAL && c.life === coalLife && c.temperature === 20).length === 6;
    observations.fuel.loadedBrokenCoal = loadedFuel.filter(c => c.id === E.BROKENCOAL).length;
    observations.fuel.sourceScrapTaken = scrapTaken.length;
    observations.fuel.scrapPayload = scrapPayload.map(c => ({ id: c[0], temperature: c[1], life: c[2], ctype: Math.floor(c[3]), seed: c[3] - Math.floor(c[3]) }));
    observations.fuel.loadedScrap = loadedCharge.filter(c => c.id === E.SCRAP).length;
    observations.fuel.scrapPut = chargePut;
    if (scrapTaken.length !== 4 || chargePut !== 4 || observations.fuel.loadedScrap !== 4) throw new Error('four real SCRAP cells did not reach the physical charge bed');

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
    let bucketLoad = null;
    let bucketPoured = 0;
    let pumpStopped = false;
    let exhausted = false;
    let waterPeakBeforePour = null;
    let pumpOutputAtOff = null;
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
        if (hasMetalLava && bucketPoured + (bucketLoad?.count ?? 0) < 4) {
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
          if (pourCells.length) {
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
        if (pumpStopped && bucketPoured === 4 && coldMetal.reduce((sum, shipment) => sum + shipment.count, 0) === 4
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
    checks.coldMetalConfirmedShipped = coldShipments.reduce((sum, shipment) => sum + shipment.count, 0) === 4;
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
    const spoutEnd = await readCells(spoutCells);
    observations.water.spoutContents = spoutCells.flatMap((at, i) => spoutEnd[i].id !== E.EMPTY
      ? [{ at, ...spoutEnd[i] }] : []);
    observations.cargo.industryBufferAtEnd = industry.buffered;
    if (bucketLoad?.count) observations.cargo.residuals.push({ kind: 'bucket-cargo', cells: bucketLoad.cells.map(cell => [...cell]) });
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
    return { case: 'line', status: passed ? 'passed' : 'bounded-incomplete', checks, observations,
      residualGaps: [...new Set(residualGaps)] };
  } catch (error) {
    observations.elapsedMs = Date.now() - startedAt;
    observations.lastError = cleanError(error);
    observations.partialStage = observations.stage ?? 'setup';
    if (!residualGaps.length) residualGaps.push('bounded native physical batch did not complete; no unobserved phase or cargo is credited');
    residualGaps.push('Interrupted runs do not establish complete accounting of outstanding loads and pending transfers.');
    observations.asyncErrors = [...asyncErrors];
    return { case: 'line', status: Date.now() >= until ? 'bounded-incomplete' : 'failed', checks, observations,
      residualGaps: [...new Set(residualGaps)] };
  } finally {
    // Tear down only this fixture's own async Industry jobs; the caller owns sim/gpu.
    if (!disposed) {
      disposed = true;
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

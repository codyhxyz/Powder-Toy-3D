// Bounded, per-case physical Industry checkpoints. One real-GPU slot per run;
// Choose one case per invocation.
// Example (with this checkout's Vite already running):
//   node tools/industry-physical-check.mjs --case mechanisms --port 19543
// CPU geometry check: --case thermal --preflight. Compute-only: --case thermal --harness.
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { budgetMs, CLEANUP_MS } from './gpu-deadline.mjs';
import { validateDevices } from '../src/industry/validation.js';
import { hearthRegions, hearthStructureCells } from '../src/industry/hearth.js';
import { writeFileSync } from 'node:fs';

const invokedAt = Date.now();
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const slotBudgetMs = budgetMs(Number(arg('--budget-ms') || 10_000));
// The independent watchdog starts graceful shutdown two cleanup intervals
// before the slot ends. Return observations BEFORE that shutdown, not during it.
const workDeadline = invokedAt + slotBudgetMs - 2 * CLEANUP_MS - 500;
const caseDeadline = workDeadline - 300;
const selectedCase = arg('--case');
const port = arg('--port') || '19543';
const baseUrl = arg('--url') || `http://localhost:${port}/`;
const useHarness = process.argv.includes('--harness');
const thermalDevices = validateDevices([
  { id: 'physical-hearth', type: 'hearth', x: 48, y: 12, z: 48, rotation: 0 },
], [128, 128, 128]);
const thermalGeometry = { ...hearthRegions(thermalDevices[0]), structure: hearthStructureCells(thermalDevices[0]) };
if (!['thermal', 'mechanisms', 'diagnostics', 'line'].includes(selectedCase)) {
  console.error('Usage: node tools/industry-physical-check.mjs --case thermal|mechanisms|diagnostics|line [--budget-ms MS] [--harness] [--preflight] [--port PORT | --url URL]');
  process.exit(2);
}
if (process.argv.includes('--preflight')) {
  if (selectedCase === 'line') {
    const { purelineDeviceLayout } = await import('./fixtures/industry-line.js');
    const devices = validateDevices(purelineDeviceLayout(), [128, 128, 128]);
    console.log(JSON.stringify({ status: 'cpu-geometry-valid', devices: devices.length, bounds: [128, 128, 128],
      limitations: 'Bounds/overlap only; no mining, thermal, cargo, browser, or GPU validation.' }));
    process.exit(0);
  }
  console.log(JSON.stringify({ status: 'cpu-geometry-valid', devices: thermalDevices,
    cells: Object.fromEntries(Object.entries(thermalGeometry).filter(([key]) => key !== 'outputDirection').map(([key, cells]) => [key, cells.length])),
    limitations: 'Bounds/overlap validation only; no heat, tools, browser, or GPU was exercised.' }));
  process.exit(0);
}

const within = (promise, deadline, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label}: insufficient bounded time`)), Math.max(1, deadline - Date.now()));
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const cleanError = error => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 500);
let browser = null;
let page = null;
let result = { case: selectedCase, status: 'not-run', checks: {}, residualGaps: [] };
const browserErrors = [];
let lastStage = 'not-launched';

try {
  if (Date.now() >= workDeadline - 1_500) throw new Error('insufficient budget before browser launch');
  browser = await launchBrowser({ lifetimeMs: slotBudgetMs });
  if (Date.now() >= workDeadline - 1_000) throw new Error('insufficient bounded time remains after browser startup');
  page = await newTestPage(browser, { mode: 'manual', viewport: { width: 400, height: 300 } });
  page.on('pageerror', error => browserErrors.push(`page: ${cleanError(error)}`));
  page.on('console', message => {
    if (message.text().startsWith('[physical-check]')) {
      lastStage = message.text(); console.error(lastStage);
    }
    if (/GPU (validation|internal)|Error while parsing WGSL/.test(message.text())) browserErrors.push(`console: ${message.text().slice(0, 400)}`);
  });
  const url = new URL(baseUrl);
  if (useHarness) url.pathname = '/tools/harness/sim-check.html';
  url.searchParams.set('size', '128');
  url.searchParams.set('preset', 'empty');
  url.searchParams.set('mode', 'sandbox');
  url.searchParams.set('view', 'plain');
  url.searchParams.set('test', 'manual');
  await within(page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(4_000, workDeadline - Date.now())) }), workDeadline, 'app navigation');
  await within(useHarness ? page.waitForFunction(() => window.__harness?.ready) : ready(page), workDeadline, 'simulation ready');
  const payload = await within(page.evaluate(async ({ caseName, deadline, useHarness, thermalDevices, thermalGeometry }) => {
    const cleanError = error => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 500);
    const caseStarted = performance.now();
    const stage = name => console.log(`[physical-check] ${name} (${Math.round(performance.now() - caseStarted)} ms in page)`);
    stage('simulation setup');
    const h = useHarness ? window.__harness : null;
    const nativeSim = h ? await h.make(128, { debug: false }) : null;
    const a = h ? { sim: nativeSim, gpu: h.gpu, test: {
      mode: 'manual', park() {}, ready: () => nativeSim.ready,
      step(n) { for (let i = 0; i < n; i++) nativeSim.step(); },
    } } : window.__app;
    stage('native simulation ready');
    if (!a?.sim || !a.test || a.test.mode !== 'manual') throw new Error('manual 128³ app baseline is unavailable');
    a.test.park();
    const sim = a.sim;
    const bounds = [sim.g.nx, sim.g.ny, sim.g.nz];
    if (bounds.some(n => n !== 128)) throw new Error(`expected the actual 128³ fixture, got ${bounds.join('x')}`);
    const { E, ELEMENTS } = await import('/src/elements.js');
    const { GATE_OWNER_MARKER, GATE_STATUS, createGatePhysics, gateGeometry } = await import('/src/industry/gates.js');
    const { createFactoryControlParts } = await import('/src/industry/controlParts.js');
    const fill = sim.editKernel(`industryPhysicalFixture_${caseName}`, {
      params: { material: 'vec4f' },
      update: `fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) { *oA = P.material; *oB = vec4f(0.0); }`,
    });
    const errors = [];
    let gates = null, parts = null, thermalPhysics = null, diagnostics = null;
    const read = async at => {
      const [cell] = await sim.readCell(...at);
      return { id: Math.round(cell[0]), temperature: cell[1], life: cell[2], ctype: Math.floor(cell[3]), seed: cell[3] - Math.floor(cell[3]) };
    };
    const readCells = async cells => {
      const result = [];
      for (let i = 0; i < cells.length; i += 8) result.push(...await Promise.all(cells.slice(i, i + 8).map(read)));
      return result;
    };
    const box = (lo, hi, id, temperature = 20, life = 0, ctype = 0.125) =>
      sim.edit(fill, { lo, hi }, { material: [id, temperature, life, ctype] });
    const one = (at, id, temperature = 20, life = 0, ctype = 0.125) => box(at, at, id, temperature, life, ctype);
    const waitPending = async (isPending, until, label) => {
      while (isPending() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 0));
      if (isPending()) throw new Error(`${label}: operation exceeded the bounded checkpoint`);
    };
    const runGate = async device => {
      const wasPending = gates.pending;
      gates.step(1 / 60, [device]);
      const scheduled = gates.pending > wasPending;
      if (!scheduled) return { scheduled: false, status: gates.status(device.id) };
      await waitPending(() => gates.pending > wasPending, deadline, `gate ${device.id}`);
      await a.gpu.fence();
      return { scheduled: true, status: gates.status(device.id) };
    };
    const gate = (id, x, y, z, gateMode = 'open', gateClosed = false) => ({
      id, type: 'gate', x, y, z, rotation: 0, gateMode, gateClosed,
    });

    try {
      if (caseName === 'line') {
        const { runIndustryLine } = await import('/tools/fixtures/industry-line.js');
        const result = await runIndustryLine({ sim, gpu: a.gpu, deadline, stage });
        if (h?.failures?.length) return { ...result, status: 'failed', apiErrors: h.failures.map(cleanError) };
        return result;
      }
      if (caseName === 'diagnostics') {
        const { createConstruction } = await import('/src/industry/construction.js');
        const { createIndustryDiagnostics } = await import('/src/industry/diagnostics.js');
        const { hearthRegions, hearthStructureCells } = await import('/src/industry/hearth.js');
        const { controlCell } = await import('/src/industry/physics.js');
        const hearth = { id: 'diagnostic-hearth', type: 'hearth', x: 96, y: 12, z: 96, rotation: 1, powered: false };
        const geometry = hearthRegions(hearth), port = controlCell(hearth);
        const construction = createConstruction({ sim, gpu: a.gpu, requestRender() {} });
        parts = createFactoryControlParts({ getSim: () => sim });
        diagnostics = createIndustryDiagnostics({ getSim: () => sim, onError: error => errors.push(cleanError(error)) });
        await Promise.all([a.test.ready(), fill.ready, construction.ready, parts.ready]);
        if (!await construction.run(hearth, 1)) throw new Error('diagnostic hearth construction failed');
        const shell = await readCells(hearthStructureCells(hearth));
        if (!(await parts.place({ key: 'SWITCH', x: port[0], y: port[1], z: port[2] })).ok)
          throw new Error('diagnostic switch placement failed');
        one(geometry.fuel[0], E.BROKENCOAL, 20, 0);
        await a.gpu.fence();
        const spent = await diagnostics.inspect(hearth);
        // Real body/port inspections have distinct region identities. Alternating
        // those requests avoids cache reuse without disabling the production throttle.
        const portRegions = Object.fromEntries(Array.from({ length: 5 }, (_, i) =>
          [`portMembership${i}`, { cells: [port], ids: [E.SWITCH] }]));
        one(geometry.fuel[0], E.BROKENCOAL, 20, 1);
        await a.gpu.fence();
        const builtInOff = await diagnostics.inspect(hearth, { regions: portRegions });
        const controlled = { ...hearth, powered: true };
        const controlledOff = await diagnostics.inspect(controlled);
        const switchedOn = await parts.toggle({ x: port[0], y: port[1], z: port[2] });
        const controlledOn = await diagnostics.inspect(controlled, { regions: portRegions });
        one(hearthStructureCells(hearth)[0], E.EMPTY);
        await a.gpu.fence();
        const damagedWithLivePort = await diagnostics.inspect(controlled);
        const switchedOff = await parts.toggle({ x: port[0], y: port[1], z: port[2] });
        const standalone = await diagnostics.inspect({
          id: 'standalone-switch', type: 'control-cell', x: port[0], y: port[1], z: port[2], rotation: 0,
        }, {
          base: { cells: [port], material: E.SWITCH },
          guard: { base: [0, 0, 0], material: -1, port, powered: true },
          regions: { switch: { cells: [port], ids: [E.SWITCH] } },
          statusPolicy: { primaryRegions: ['switch'] },
        });
        const signalGate = { id: 'diagnostic-gate', type: 'gate', x: 80, y: 12, z: 96, rotation: 0, gateMode: 'signal' };
        if (!await construction.run(signalGate, 1)) throw new Error('diagnostic gate base construction failed');
        const gatePort = controlCell(signalGate);
        if (!(await parts.place({ key: 'SWITCH', x: gatePort[0], y: gatePort[1], z: gatePort[2] })).ok)
          throw new Error('gate diagnostic switch placement failed');
        const signalGateOff = await diagnostics.inspect(signalGate);
        if (!(await parts.toggle({ x: gatePort[0], y: gatePort[1], z: gatePort[2] })).ok)
          throw new Error('gate diagnostic switch toggle failed');
        const manualGate = { ...signalGate, gateMode: 'closed' };
        const gateModeInvalidates = diagnostics.snapshot(manualGate).freshness === 'stale';
        const manualGateOn = await diagnostics.inspect(manualGate);
        const checks = {
          actual128Cube: bounds.every(n => n === 128),
          rotated48CellShellMatchesPhysicalConstruction: shell.length === 48 && shell.every(cell => cell.id === E.TUNGSTEN),
          defaultHearthRegionsMatchPhysicalGeometry: spent.evidence?.regions.fuel?.sampled === 6
            && spent.evidence?.regions.charge?.sampled === 6 && spent.evidence?.regions.outlet?.sampled === 4,
          exhaustedCoalIsNotUsableFuel: spent.status === 'empty inlet' && spent.evidence?.regions.fuel?.eligible === 0,
          optionalOffPortDoesNotDisableBuiltInDrive: builtInOff.status === 'ready'
            && builtInOff.evidence?.control.required === false && builtInOff.evidence?.control.active === false,
          eightRegionPortInspectionRemainsBounded: Object.keys(builtInOff.evidence?.regions ?? {}).length === 8,
          requiredOffPortStopsMachine: controlledOff.status === 'control off' && controlledOff.evidence?.control.active === false,
          actualSwitchOnReportsReady: switchedOn.ok && controlledOn.status === 'ready' && controlledOn.evidence?.control.active === true,
          baseDamageDoesNotFalsifyLivePort: damagedWithLivePort.status === 'base damaged' && damagedWithLivePort.evidence?.control.active === true,
          negativeGuardMaterialDoesNotFalsifyOffSwitch: switchedOff.ok && standalone.evidence?.control.active === false,
          registeredGateReportsRealSignalRequirement: signalGateOff.evidence?.base.intact === true
            && signalGateOff.evidence?.control.required === true && signalGateOff.evidence?.control.active === false,
          manualGateStillReportsLivePortWithoutRequiringIt: manualGateOn.evidence?.control.required === false
            && manualGateOn.evidence?.control.active === true,
          gateModeChangeInvalidatesCachedObservation: gateModeInvalidates,
          noAsyncApiErrors: errors.length === 0 && !(h?.failures?.length),
        };
        const brief = observation => ({ status: observation.status, freshness: observation.freshness, evidence: observation.evidence });
        return { case: caseName, status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checks,
          observations: Object.fromEntries(Object.entries({ spent, builtInOff, controlledOff, controlledOn, damagedWithLivePort, standalone, signalGateOff, manualGateOn })
            .map(([key, value]) => [key, brief(value)])),
          apiErrors: [...errors, ...(h?.failures ?? []).map(cleanError)],
          residualGaps: ['Native GPU observations only; this case does not exercise the player UI.'] };
      }
      if (caseName === 'thermal') {
        if (!a.industry && !h) throw new Error('integrated Industry controller is unavailable');
        const [hearth] = thermalDevices;
        const emptyPhysics = { version: 1, pumps: [] };
        if (h) {
          const { createIndustryPhysics } = await import('/src/industry/physics.js');
          thermalPhysics = createIndustryPhysics({ getSim: () => sim, onError: error => errors.push(cleanError(error)) });
          await thermalPhysics.ready;
        } else a.industry.fromJSON({ version: 1, devices: thermalDevices, progression: null, paid: [], factoryRun: false,
          assisted: true, physics: emptyPhysics });
        const updateIndustry = () => h ? thermalPhysics.step(1 / 60, [hearth]) : a.industry.update(1 / 60, true);
        await Promise.all([a.test.ready(), fill.ready]);
        stage('industry pipelines ready');

        // Real atomic construction: the 48-cell thin shell, not a painted test wall.
        const { createConstruction } = await import('/src/industry/construction.js');
        const construction = createConstruction({ sim, gpu: a.gpu, requestRender() {} });
        await construction.ready;
        for (const d of thermalDevices) {
          if (Date.now() >= deadline) throw new Error('insufficient time to finish buildable tub construction');
          if (!await construction.run(d, 1)) throw new Error(`atomic construction failed: ${d.id}`);
        }
        const shell = await readCells(thermalGeometry.structure);
        if (shell.length !== 48 || shell.some(cell => cell.id !== E.TUNGSTEN || cell.temperature !== 20))
          throw new Error('physical 48-cell tungsten chassis was not constructed');
        stage('atomic hearth chassis confirmed');
        // This finite batch fits the six-cell rear firebox.
        // Actual shovel aiming/refueling is NOT asserted by this numerical fixture.
        box([49, 13, 49], [50, 15, 49], E.BROKENCOAL, 20, ELEMENTS[E.BROKENCOAL].life);
        box([49, 13, 50], [50, 14, 50], E.SCRAP, 20, ELEMENTS[E.SCRAP].life ?? 0);
        await a.gpu.fence();
        const hearthBase = Array.from({ length: 16 }, (_, i) => [48 + (i % 4), 12, 48 + Math.floor(i / 4)]);
        const [baseCells, controlCell, coalInitial, brokenInitial, scrapInitialCells] = await Promise.all([
          readCells(hearthBase), read([47, 12, 49]), read([49, 13, 49]), read([50, 13, 49]),
          readCells([[49, 13, 50], [50, 13, 50], [49, 14, 50], [50, 14, 50]]),
        ]);
        const scrapInitial = scrapInitialCells[1];
        const fixtureReady = baseCells.length === 16 && baseCells.every(cell => cell.id === E.TUNGSTEN && cell.temperature === 20)
          && controlCell.id === E.EMPTY && coalInitial.id === E.BROKENCOAL && coalInitial.temperature === 20 && coalInitial.life === ELEMENTS[E.BROKENCOAL].life
          && brokenInitial.id === E.BROKENCOAL && brokenInitial.temperature === 20 && brokenInitial.life === ELEMENTS[E.BROKENCOAL].life
          && scrapInitialCells.every(cell => cell.id === E.SCRAP && cell.temperature === 20);
        if (!fixtureReady) throw new Error('cold physical fuel, charge, tungsten base, or empty native port did not read back as built');
        stage('cold resources confirmed; stepping native physics');
        // Prime nativeFrame at the present frame. Every measured hearth update below
        // follows exactly four actual sim.step ticks (the app's native 240 Hz batch).
        updateIndustry();
        const startFrame = sim.frame;
        // Grains can redistribute between fuel and charge; sample both, not just
        // the initial SCRAP coordinates. The retained heel also stays observable.
        const scrapCells = [...thermalGeometry.fuel, ...thermalGeometry.charge, ...thermalGeometry.outlet, ...thermalGeometry.mouth];
        let coal = coalInitial, broken = brokenInitial;
        let scrapSamples = [scrapInitial];
        let alignedBatches = true, updates = 0, nativeTicks = 0, fences = 0;
        let ignition = false, fuelLifeReduced = false, melt = null;
        let peakFuelTemperatureC = 20, peakChargeTemperatureC = 20;
        let exhaustedBudget = false;
        // One invocation only. The wall-clock deadline, not an unbounded frame count,
        // determines how far real native heat transfer/phase change can progress.
        for (let batch = 0; batch < (h ? 1200 : 300) && Date.now() < deadline; batch++) {
          a.test.step(4);
          updateIndustry();
          updates++;
          nativeTicks = sim.frame - startFrame;
          alignedBatches &&= nativeTicks === updates * 4;
          if (batch % 12 !== 11 && batch !== 0) continue;
          if (Date.now() >= deadline) { exhaustedBudget = true; break; }
          await a.gpu.fence(); fences++;
          [coal, broken, ...scrapSamples] = await readCells([[49, 13, 49], [50, 13, 49], ...scrapCells]);
          const fuel = scrapSamples.filter(cell => cell.id === E.COAL || cell.id === E.BROKENCOAL);
          ignition ||= fuel.some(cell => cell.temperature >= ELEMENTS[cell.id].ignite);
          fuelLifeReduced ||= fuel.some(cell => cell.life < 1 - 1e-7) || scrapSamples.some(cell => cell.id === E.ASH);
          peakFuelTemperatureC = Math.max(peakFuelTemperatureC, ...fuel.map(cell => cell.temperature));
          peakChargeTemperatureC = Math.max(peakChargeTemperatureC, ...scrapSamples.filter(cell => cell.id === E.SCRAP || cell.id === E.LAVA).map(cell => cell.temperature));
          melt = scrapSamples.find(cell => cell.id === E.LAVA && cell.ctype === E.METAL) ?? null;
          if (melt) break;
        }
        if (Date.now() >= deadline) exhaustedBudget = true;
        if (updates && !fences) {
          await a.gpu.fence(); fences++;
          [coal, broken, ...scrapSamples] = await readCells([[49, 13, 49], [50, 13, 49], ...scrapCells]);
          const fuel = scrapSamples.filter(cell => cell.id === E.COAL || cell.id === E.BROKENCOAL);
          ignition ||= fuel.some(cell => cell.temperature >= ELEMENTS[cell.id].ignite);
          fuelLifeReduced ||= fuel.some(cell => cell.life < 1 - 1e-7) || scrapSamples.some(cell => cell.id === E.ASH);
          melt = scrapSamples.find(cell => cell.id === E.LAVA && cell.ctype === E.METAL) ?? null;
        }
        const checks = {
          actual128Cube: bounds.every(n => n === 128),
          coldFuelAndScrapWithRemainingLife: fixtureReady,
          tungstenBaseAndUnpoweredGuard: fixtureReady && hearth.powered === false,
          atomicRefractoryChassis: shell.length === 48,
          nativeBatch240Aligned: updates > 0 && alignedBatches && nativeTicks === updates * 4,
          ignitionObserved: ignition,
          physicalFuelLifeReduced: fuelLifeReduced,
          nativeScrapMeltedToLavaWithMetalCtype: !!melt,
          noAsyncApiErrors: errors.length === 0 && (!h || h.failures.length === 0),
        };
        const status = Object.values(checks).every(Boolean) ? 'passed' : 'bounded-incomplete';
        return {
          case: caseName, status, checks, apiErrors: [...errors, ...(h?.failures ?? [])],
          observations: { bounds, integration: h ? 'native Simulation + Industry physics (no app UI)' : 'app controller',
            fixtureTemperatureC: 20, fuelStartLife: coalInitial.life, fuelId: E.BROKENCOAL,
            loadedFuelCells: 6, containmentChassisCells: shell.length,
            peakFuelTemperatureC, peakChargeTemperatureC,
            rearProbeEnd: coal, otherRearProbeEnd: broken,
            scrapSamples, melt, nativeTicks, industryUpdates: updates, nativeBatchSize: 4, fences,
            waterFixture: 'none; native ambient unchanged', elapsedCaseMs: Math.round(performance.now() - caseStarted) },
          residualGaps: [
            ...(!checks.nativeScrapMeltedToLavaWithMetalCtype ? ['bounded run did not observe a native SCRAP→LAVA(METAL) cell'] : []),
            'No pump/cooling/shipment end-to-end claim is made by this checkpoint.',
            'Atomic hearth construction is exercised; real shovel loading, ash clearing and bucket extraction are not.',
            ...(exhaustedBudget ? ['case deadline reached; no second attempt was made'] : []),
          ],
        };
      }

      // The mechanisms case uses independent full-size gate/control coordinates and
      // the production GPU APIs; native-flow evidence is kept separate from static writes.
      const gateA = gate('physical-gate-a', 20, 20, 20, 'closed', false);
      const gateB = gate('physical-gate-b', 36, 20, 20, 'closed', false);
      const gateC = gate('physical-gate-c', 52, 20, 40, 'closed', false);
      const apertureA = gateGeometry(gateA, sim.g).aperture;
      const apertureB = gateGeometry(gateB, sim.g).aperture;
      const apertureC = gateGeometry(gateC, sim.g).aperture;
      const foreignB = apertureB[0];
      const sandStart = [53, 24, 42];
      gates = createGatePhysics({ getSim: () => sim, onError: error => errors.push(cleanError(error)) });
      parts = createFactoryControlParts({ getSim: () => sim });
      await Promise.all([a.test.ready(), fill.ready, gates.ready, parts.ready]);
      for (const d of [gateA, gateB, gateC]) box([d.x, d.y, d.z], [d.x + 3, d.y, d.z + 3], E.INSULATOR);
      one(foreignB, E.WALL, 20, 0);
      // A closed guide keeps a real falling SAND grain in the independent third aperture.
      box([51, 21, 41], [51, 24, 43], E.TUNGSTEN);
      box([56, 21, 41], [56, 24, 43], E.TUNGSTEN);
      box([52, 21, 41], [55, 24, 41], E.TUNGSTEN);
      box([52, 21, 43], [55, 24, 43], E.TUNGSTEN);
      one(sandStart, E.SAND, 20, ELEMENTS[E.SAND].life ?? 0);
      await a.gpu.fence();

      const closeA = await runGate(gateA);
      const ownedA = await read(apertureA[0]);
      const openADevice = { ...gateA, gateMode: 'open', gateClosed: true };
      const openA = await runGate(openADevice);
      const openedA = await read(apertureA[0]);
      const reclosedA = await runGate(gateA);
      one(apertureA[0], E.WALL, 20, 0);
      const damagedDevice = { ...gateA, gateClosed: true };
      const damaged = await runGate(damagedDevice);
      const damagedAgain = await runGate(damagedDevice);
      const foreignAfterDamage = await read(apertureA[0]);
      const remainingOwned = await read(apertureA[1]);
      const removed = await gates.remove(damagedDevice);
      await a.gpu.fence();
      const foreignAfterRemove = await read(apertureA[0]);
      const ownedAfterRemove = await read(apertureA[1]);

      const blockedB = await runGate(gateB);
      const blockerAfterClose = await read(foreignB);
      const emptySiblingB = await read(apertureB[1]);
      const openB = await runGate({ ...gateB, gateMode: 'open', gateClosed: false });
      const batteryAt = [35, 20, 21];
      const battery = await parts.place({ key: 'BATTERY', x: batteryAt[0], y: batteryAt[1], z: batteryAt[2] });
      const signalB = await runGate({ ...gateB, gateMode: 'signal', gateClosed: false });
      const batteryCell = await read(batteryAt);
      const foreignAfterOpen = await read(foreignB);

      const thresholdAt = [72, 30, 72];
      const threshold = 357.25;
      const sensor = await parts.place({ key: 'TSNS', x: thresholdAt[0], y: thresholdAt[1], z: thresholdAt[2], threshold });
      const sensorCell = await read(thresholdAt);
      const occupiedReject = await parts.place({ key: 'BATTERY', x: thresholdAt[0], y: thresholdAt[1], z: thresholdAt[2] });
      const occupiedAfter = await read(thresholdAt);
      const switchAt = [74, 30, 72];
      const switchPlaced = await parts.place({ key: 'SWITCH', x: switchAt[0], y: switchAt[1], z: switchAt[2] });
      const switchOn = await parts.toggle({ x: switchAt[0], y: switchAt[1], z: switchAt[2] });
      const switchOnCell = await read(switchAt);
      const switchOff = await parts.toggle({ x: switchAt[0], y: switchAt[1], z: switchAt[2] });
      const switchOffCell = await read(switchAt);

      let nativeFlowObserved = false, nativeFlowTicks = 0, sandCurrent = await read(sandStart), sandAperture = null;
      for (let batch = 0; batch < 8 && Date.now() < deadline && !nativeFlowObserved; batch++) {
        a.test.step(4);
        nativeFlowTicks += 4;
        await a.gpu.fence();
        sandCurrent = await read(sandStart);
        for (const y of [23, 22, 21]) {
          const cell = await read([53, y, 42]);
          if (cell.id === E.SAND) { nativeFlowObserved = true; sandAperture = { at: [53, y, 42], cell }; break; }
        }
      }
      let fallingBlocked = null;
      if (nativeFlowObserved && Date.now() < deadline) {
        const fallingResult = await runGate(gateC);
        const grainAfterGate = await read(sandAperture.at);
        fallingBlocked = { scheduled: fallingResult.scheduled, status: fallingResult.status?.status,
          preservedSand: grainAfterGate.id === E.SAND, at: sandAperture.at };
      }

      const checks = {
        actual128Cube: bounds.every(n => n === 128),
        gateClosedActuallyWritesOwnedShutter: closeA.scheduled && closeA.status?.status === GATE_STATUS.CLOSED && ownedA.id === E.WALL && ownedA.life === GATE_OWNER_MARKER,
        gateOpenActuallyErasesOwnedShutter: openA.scheduled && openA.status?.status === GATE_STATUS.OPEN && openedA.id === E.EMPTY,
        occupiedClosePreservesForeignWall: blockedB.scheduled && blockedB.status?.status === GATE_STATUS.BLOCKED && blockerAfterClose.id === E.WALL && blockerAfterClose.life !== GATE_OWNER_MARKER && emptySiblingB.id === E.EMPTY
          && openB.scheduled && openB.status?.status === GATE_STATUS.OPEN,
        partialShutterReportsDamageWithoutAutoheal: reclosedA.scheduled && reclosedA.status?.status === GATE_STATUS.CLOSED
          && damaged.scheduled && damaged.status?.status === GATE_STATUS.DAMAGED
          && damagedAgain.status?.status === GATE_STATUS.DAMAGED && !damagedAgain.scheduled
          && foreignAfterDamage.id === E.WALL && foreignAfterDamage.life !== GATE_OWNER_MARKER
          && remainingOwned.id === E.WALL && remainingOwned.life === GATE_OWNER_MARKER,
        removeErasesOnlyTaggedOwnership: removed.ok && foreignAfterRemove.id === E.WALL && foreignAfterRemove.life !== GATE_OWNER_MARKER
          && ownedAfterRemove.id === E.EMPTY,
        energizedSignalGateOpens: battery.ok && batteryCell.id === E.BATTERY && signalB.scheduled && signalB.status?.status === GATE_STATUS.OPEN
          && signalB.status?.desiredClosed === false && foreignAfterOpen.id === E.WALL && foreignAfterOpen.life !== GATE_OWNER_MARKER,
        controlPlacementWritesActualThreshold: sensor.ok && sensorCell.id === E.TSNS && sensorCell.temperature === Math.fround(threshold),
        occupiedControlPlacementRejected: !occupiedReject.ok && occupiedAfter.id === E.TSNS && occupiedAfter.temperature === Math.fround(threshold),
        nativeSwitchToggleChangesRealCell: switchPlaced.ok && switchOn.ok && switchOn.on === true && switchOnCell.id === E.SWITCH
          && switchOnCell.life === 10 && switchOff.ok && switchOff.on === false && switchOffCell.id === E.SWITCH && switchOffCell.life === 9,
        nativeFallingGrainBlocksGate: nativeFlowObserved && fallingBlocked?.scheduled && fallingBlocked.status === GATE_STATUS.BLOCKED && fallingBlocked.preservedSand,
        noAsyncApiErrors: errors.length === 0,
      };
      const required = Object.entries(checks).filter(([name]) => name !== 'nativeFallingGrainBlocksGate');
      const corePassed = required.every(([, value]) => value);
      const flowRequired = nativeFlowObserved;
      const status = corePassed && (!flowRequired || checks.nativeFallingGrainBlocksGate) ? 'passed' : 'bounded-incomplete';
      return {
        case: caseName, status, checks, apiErrors: errors,
        observations: { bounds, gateStatuses: { close: closeA.status?.status, open: openA.status?.status,
          blocked: blockedB.status?.status, openAfterBlock: openB.status?.status, signal: signalB.status?.status, damaged: damaged.status?.status,
          damagedAgain: damagedAgain.status?.status, removed: removed.status },
          controlParts: { sensorTemperature: sensorCell.temperature, sensorThreshold: threshold,
            occupiedResult: occupiedReject.ok, switchOn: switchOnCell.life, switchOff: switchOffCell.life,
            batteryPlaced: battery.ok },
          nativeFallingGrain: { attemptedTicks: nativeFlowTicks, sourceStillOccupied: sandCurrent.id === E.SAND,
            observedAt: sandAperture?.at ?? null, apertureBlocked: fallingBlocked },
          elapsedCaseMs: Math.round(performance.now() - caseStarted) },
        residualGaps: [
          ...(!nativeFlowObserved ? ['native falling-grain passage into the aperture was not observed within this bounded attempt'] : []),
          ...(!checks.nativeFallingGrainBlocksGate && nativeFlowObserved ? ['the observed native grain did not produce a confirmed all-or-none gate blockage'] : []),
        ],
      };
    } finally {
      gates?.dispose();
      parts?.dispose();
      thermalPhysics?.dispose();
      diagnostics?.dispose();
      nativeSim?.dispose();
    }
  }, { caseName: selectedCase, deadline: caseDeadline, useHarness, thermalDevices, thermalGeometry }), workDeadline, 'physical checkpoint');
  result = payload;
  if (browserErrors.length) {
    result.browserErrors = browserErrors;
    result.status = 'failed';
  }
} catch (error) {
  result = { case: selectedCase, status: 'failed', checks: {}, error: cleanError(error), lastStage,
    residualGaps: ['validation did not complete; no pass is claimed'] };
} finally {
  if (browser) {
    try { await browser.close(); }
    catch (error) {
      result.cleanupError = cleanError(error);
      result.status = 'failed';
    }
  }
}
  result.timing = { wallMs: Date.now() - invokedAt, slotBudgetMs };
const outputPath = arg('--output');
if (outputPath) {
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ case: result.case, status: result.status, checks: result.checks,
    error: result.error, stage: result.observations?.stage, output: outputPath, timing: result.timing }));
} else console.log(JSON.stringify(result));
if (result.status !== 'passed') process.exitCode = 1;

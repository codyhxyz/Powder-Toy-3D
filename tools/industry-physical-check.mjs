// Bounded, per-case physical Industry checkpoints. One real-GPU slot per run;
// use --case thermal or --case mechanisms, never both in one invocation.
// Example (with this checkout's Vite already running):
//   node tools/industry-physical-check.mjs --case mechanisms --port 19543
import { launchBrowser, newTestPage, ready } from './browser.mjs';

const invokedAt = Date.now();
const totalDeadline = invokedAt + 8_500; // leave >=1.5s for browser/slot cleanup
const caseDeadline = invokedAt + 7_600;  // hard stop for fixture, compile, and assertions
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const selectedCase = arg('--case');
const port = arg('--port') || '19543';
const baseUrl = arg('--url') || `http://localhost:${port}/`;
if (!['thermal', 'mechanisms'].includes(selectedCase)) {
  console.error('Usage: node tools/industry-physical-check.mjs --case thermal|mechanisms [--port PORT | --url URL]');
  process.exit(2);
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

try {
  if (Date.now() >= totalDeadline - 1_500) throw new Error('insufficient budget before browser launch');
  browser = await launchBrowser({ lifetimeMs: 10_000 });
  if (Date.now() >= totalDeadline - 2_500) throw new Error('insufficient bounded time remains after browser startup');
  page = await newTestPage(browser, { mode: 'manual', viewport: { width: 400, height: 300 } });
  page.on('pageerror', error => browserErrors.push(`page: ${cleanError(error)}`));
  page.on('console', message => {
    if (/GPU (validation|internal)|Error while parsing WGSL/.test(message.text())) browserErrors.push(`console: ${message.text().slice(0, 400)}`);
  });
  const url = new URL(baseUrl);
  url.searchParams.set('size', '128');
  url.searchParams.set('preset', 'empty');
  url.searchParams.set('mode', 'sandbox');
  url.searchParams.set('view', 'plain');
  url.searchParams.set('test', 'manual');
  await within(page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(4_000, totalDeadline - Date.now() - 1_500)) }), totalDeadline - 1_300, 'app navigation');
  await within(ready(page), totalDeadline - 1_300, 'app ready');
  const payload = await within(page.evaluate(async ({ caseName, deadline }) => {
    const cleanError = error => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 500);
    const caseStarted = performance.now();
    const a = window.__app;
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
    let gates = null, parts = null;
    const read = async at => {
      const [cell] = await sim.readCell(...at);
      return { id: Math.round(cell[0]), temperature: cell[1], life: cell[2], ctype: Math.floor(cell[3]), seed: cell[3] - Math.floor(cell[3]) };
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
      if (caseName === 'thermal') {
        if (!a.industry) throw new Error('integrated Industry controller is unavailable');
        const hearth = { id: 'physical-hearth', type: 'hearth', x: 48, y: 12, z: 48, rotation: 0 };
        const emptyPhysics = { version: 1, pumps: [] };
        a.industry.fromJSON({ version: 1, devices: [hearth], progression: null, paid: [], factoryRun: false,
          assisted: true, physics: emptyPhysics });
        await Promise.all([a.test.ready(), fill.ready]);

        // Full 4×4 tungsten deck, refractory side/rear walls, and a full-height
        // refractory baffle keep falling charge out of the separate rear firebox.
        // Every fixture cell starts at 20 °C; native ambient/water behavior is untouched.
        const refractory = E.TUNGSTEN;
        box([48, 12, 48], [51, 12, 51], refractory);
        box([47, 13, 48], [47, 17, 52], refractory);
        box([52, 13, 48], [52, 17, 52], refractory);
        box([48, 13, 47], [51, 17, 47], refractory);
        box([48, 13, 49], [51, 17, 49], refractory);
        box([50, 13, 48], [50, 13, 48], refractory); // retain broken coal in its physical firebox cell
        one([48, 13, 48], E.COAL, 20, ELEMENTS[E.COAL].life);
        one([51, 13, 48], E.BROKENCOAL, 20, ELEMENTS[E.BROKENCOAL].life);
        box([48, 13, 50], [51, 13, 50], E.SCRAP, 20, ELEMENTS[E.SCRAP].life ?? 0);
        // The control port at (-1,0,1) is explicitly empty; the built-in base is real tungsten.
        one([47, 12, 49], E.EMPTY, 20, 0);
        await a.gpu.fence();
        const hearthBase = Array.from({ length: 16 }, (_, i) => [48 + (i % 4), 12, 48 + Math.floor(i / 4)]);
        const [baseCells, controlCell, coalInitial, brokenInitial, scrapInitialCells] = await Promise.all([
          Promise.all(hearthBase.map(read)), read([47, 12, 49]), read([48, 13, 48]), read([51, 13, 48]),
          Promise.all([48, 49, 50, 51].map(x => read([x, 13, 50]))),
        ]);
        const scrapInitial = scrapInitialCells[1];
        const fixtureReady = baseCells.length === 16 && baseCells.every(cell => cell.id === E.TUNGSTEN && cell.temperature === 20)
          && controlCell.id === E.EMPTY && coalInitial.id === E.COAL && coalInitial.temperature === 20 && coalInitial.life === ELEMENTS[E.COAL].life
          && brokenInitial.id === E.BROKENCOAL && brokenInitial.temperature === 20 && brokenInitial.life === ELEMENTS[E.BROKENCOAL].life
          && scrapInitialCells.every(cell => cell.id === E.SCRAP && cell.temperature === 20);
        if (!fixtureReady) throw new Error('cold physical fuel, charge, 16-cell base, or empty control-guard fixture did not read back as built');
        // Prime nativeFrame at the present frame. Every measured hearth update below
        // follows exactly four actual sim.step ticks (the app's native 240 Hz batch).
        a.industry.update(1 / 60, true);
        const startFrame = sim.frame;
        const scrapCells = [[48, 13, 50], [49, 13, 50], [50, 13, 50], [51, 13, 50], [49, 13, 51], [50, 13, 51]];
        let coal = coalInitial, broken = brokenInitial;
        let scrapSamples = [scrapInitial];
        let alignedBatches = true, updates = 0, nativeTicks = 0, fences = 0;
        let ignition = false, fuelLifeReduced = false, melt = null;
        let exhaustedBudget = false;
        // One invocation only. The wall-clock deadline, not an unbounded frame count,
        // determines how far real native heat transfer/phase change can progress.
        for (let batch = 0; batch < 1_200 && Date.now() < deadline; batch++) {
          a.test.step(4);
          a.industry.update(1 / 60, true);
          updates++;
          nativeTicks = sim.frame - startFrame;
          alignedBatches &&= nativeTicks === updates * 4;
          if (batch % 12 !== 11 && batch !== 0) continue;
          if (Date.now() >= deadline) { exhaustedBudget = true; break; }
          await a.gpu.fence(); fences++;
          [coal, broken, ...scrapSamples] = await Promise.all([
            read([48, 13, 48]), read([51, 13, 48]), ...scrapCells.map(read),
          ]);
          ignition ||= coal.temperature >= ELEMENTS[E.COAL].ignite || broken.temperature >= ELEMENTS[E.BROKENCOAL].ignite;
          fuelLifeReduced ||= coal.life < coalInitial.life - 1e-7 || broken.life < brokenInitial.life - 1e-7;
          melt = scrapSamples.find(cell => cell.id === E.LAVA && cell.ctype === E.METAL) ?? null;
          if (melt) break;
        }
        if (Date.now() >= deadline) exhaustedBudget = true;
        if (updates && !fences) {
          await a.gpu.fence(); fences++;
          [coal, broken, ...scrapSamples] = await Promise.all([
            read([48, 13, 48]), read([51, 13, 48]), ...scrapCells.map(read),
          ]);
          ignition ||= coal.temperature >= ELEMENTS[E.COAL].ignite || broken.temperature >= ELEMENTS[E.BROKENCOAL].ignite;
          fuelLifeReduced ||= coal.life < coalInitial.life - 1e-7 || broken.life < brokenInitial.life - 1e-7;
          melt = scrapSamples.find(cell => cell.id === E.LAVA && cell.ctype === E.METAL) ?? null;
        }
        const checks = {
          actual128Cube: bounds.every(n => n === 128),
          coldFuelAndScrapWithRemainingLife: fixtureReady,
          tungstenBaseAndEmptyControlGuard: fixtureReady,
          nativeBatch240Aligned: updates > 0 && alignedBatches && nativeTicks === updates * 4,
          ignitionObserved: ignition,
          physicalFuelLifeReduced: fuelLifeReduced,
          nativeScrapMeltedToLavaWithMetalCtype: !!melt,
          noAsyncApiErrors: errors.length === 0,
        };
        const status = Object.values(checks).every(Boolean) ? 'passed' : 'bounded-incomplete';
        return {
          case: caseName, status, checks, apiErrors: errors,
          observations: { bounds, fixtureTemperatureC: 20, coalStartLife: coalInitial.life,
            brokenCoalStartLife: brokenInitial.life, coalEnd: coal, brokenCoalEnd: broken,
            scrapSamples, melt, nativeTicks, industryUpdates: updates, nativeBatchSize: 4, fences,
            waterFixture: 'none; native ambient unchanged', elapsedCaseMs: Math.round(performance.now() - caseStarted) },
          residualGaps: [
            ...(!checks.nativeScrapMeltedToLavaWithMetalCtype ? ['bounded run did not observe a native SCRAP→LAVA(METAL) cell'] : []),
            'No pump/cooling/shipment end-to-end claim is made by this checkpoint.',
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
    }
  }, { caseName: selectedCase, deadline: caseDeadline }), totalDeadline - 1_200, 'physical checkpoint');
  result = payload;
  if (browserErrors.length) {
    result.browserErrors = browserErrors;
    result.status = 'failed';
  }
} catch (error) {
  result = { case: selectedCase, status: 'failed', checks: {}, error: cleanError(error), residualGaps: ['validation did not complete; no pass is claimed'] };
} finally {
  if (browser) {
    try { await browser.close(); }
    catch (error) {
      result.cleanupError = cleanError(error);
      result.status = 'failed';
    }
  }
}
result.timing = { wallMs: Date.now() - invokedAt, slotBudgetMs: 10_000 };
console.log(JSON.stringify(result));
if (result.status !== 'passed') process.exitCode = 1;

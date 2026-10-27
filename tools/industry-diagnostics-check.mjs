// CPU-only async mock of the Industry diagnostics runtime; no browser/GPU or full-grid reads.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createIndustryDiagnostics, industryDiagnosticSignature, presentIndustryDiagnostic } from '../src/industry/diagnostics.js';
import { E, K } from '../src/elements.js';
import { HEARTH_FUEL_IDS, hearthRegions } from '../src/industry/hearth.js';
import { deviceCell } from '../src/industry/catalog.js';
import { INDUSTRY_DIAGNOSTICS, industryDiagnosticsWGSL } from '../src/shaders/industryDiagnostics.js';

const { RESULT_VECS } = INDUSTRY_DIAGNOSTICS;
const flush = () => new Promise(resolve => setImmediate(resolve));
function makeSim(id = 1) {
  const reads = [];
  let dispatches = 0, lastParams = null;
  const sim = {
    id, g: { nx: 128, ny: 128, nz: 128 }, disposed: false,
    L: { TABLES: [], STATE_RO: [] }, tables: {}, bindRO: {}, gpu: { frame: {},
      layout: () => ({}), bindGroup: () => ({}), flush() {},
      readback: { ring(_name, bytes) {
        return { buffer: { bytes }, next: () => reads.length,
          read() { return new Promise(resolve => reads.push({ resolve, params: lastParams })); } };
      } },
      kernel: spec => ({ ready: Promise.resolve(), state: 'ready', spec, dispatch() {} }),
    },
    header: () => ({}),
    _dispatch(kernel, _size, options) {
      assert.ok(kernel.spec.params.size < 65536, 'uniform probe remains below WebGPU minimum binding size');
      kernel.spec.params.pack(options.params); // exercise the production uniform layout/payload
      dispatches++; lastParams = options.params;
    },
    readState() { throw new Error('diagnostics must not read the full grid'); },
    test: { get dispatches() { return dispatches; }, get reads() { return reads; }, get params() { return lastParams; } },
  };
  return sim;
}
function answer({ baseMatched = 16, baseExpected = 16, control = 1, controlRequired = 0, regions = [], controlSample = [-1, 0, 0, 0] } = {}) {
  const f = new Float32Array(RESULT_VECS * 4);
  f.set([baseMatched, baseExpected, control, controlRequired], 0);
  for (let i = 0; i < 8; i++) f.set(regions[i] ?? [0, 0, 0, -3.402823e38], (i + 1) * 4);
  f.set(controlSample, (RESULT_VECS - 1) * 4);
  return f.buffer;
}
async function issue(api, sim, device, overrides, values) {
  const promise = api.inspect(device, overrides);
  await flush();
  const read = sim.test.reads.at(-1);
  assert.ok(read, 'one compact GPU result readback was issued');
  read.resolve(answer(values));
  return promise;
}
function fixture(id, { start = 10000, staleMs = 500, throttleMs = 100 } = {}) {
  const sim = makeSim(id), clock = { now: start };
  const api = createIndustryDiagnostics({ getSim: () => sim, throttleMs, staleMs, now: () => clock.now });
  return { sim, clock, api };
}
let now = 1000;
const sim = makeSim();
let liveSim = sim;
const errors = [];
const api = createIndustryDiagnostics({ getSim: () => liveSim, throttleMs: 100, staleMs: 500, now: () => now, onError: e => errors.push(e) });
const pump = { id: 'pump-a', type: 'pump', x: 20, y: 4, z: 20, rotation: 0, powered: false };

// pending/cache behavior, one flight, native powered port, and damaged base.
{
  const pending = api.inspect(pump);
  assert.equal(api.pending, 1);
  assert.equal(api.snapshot(pump).freshness, 'pending');
  assert.equal(api.snapshot(pump).status, 'pending');
  assert.equal(api.inspect(pump), pending, 'same inspected machine joins its sole in-flight sample');
  await flush();
  assert.equal(sim.test.dispatches, 1);
  assert.equal(sim.test.params.sampleCount, 16, 'only 16 pump port cells, not a grid scan');
  assert.deepEqual(sim.test.params.rules[0], [1 << K.LIQUID, -1, -1, -1]);
  sim.test.reads[0].resolve(answer({ baseMatched: 15 }));
  const damaged = await pending;
  assert.equal(damaged.status, 'base damaged');
  assert.equal(damaged.running, 'unconfirmed');
  assert.equal(api.pending, 0);
}

// Native port distinguishes powered-off from a machine that does not require power.
now += 101;
const poweredPump = { ...pump, powered: true };
{
  const off = await issue(api, sim, poweredPump, {}, { control: 0, controlRequired: 1 });
  assert.equal(sim.test.params.guardPowered, 1);
  assert.deepEqual(sim.test.params.guardPort, deviceCell(poweredPump, -1, 0, 1));
  assert.equal(off.status, 'control off');
  now += 101;
  const onButEmpty = await issue(api, sim, pump, {}, { regions: [[0, 0, 0, -3.402823e38], [0, 0, 0, -3.402823e38]] });
  assert.equal(onButEmpty.status, 'empty inlet');
  assert.equal(onButEmpty.evidence.control.required, false);
}

// Read the real port even for built-in drive; an inactive optional port must not
// disable an otherwise ready machine. Base damage and port state are independent.
now += 101;
{
  const optionalOff = await issue(api, sim, pump, {}, {
    control: 0, controlRequired: 0, regions: [[1, 1, 20, 20]],
  });
  assert.equal(optionalOff.status, 'ready');
  assert.equal(optionalOff.evidence.control.required, false);
  assert.equal(optionalOff.evidence.control.active, false);
  now += 101;
  const damagedWithLivePort = await issue(api, sim, poweredPump, {}, {
    baseMatched: 15, control: 1, controlRequired: 1,
  });
  assert.equal(damagedWithLivePort.status, 'base damaged');
  assert.equal(damagedWithLivePort.evidence.control.active, true);
  assert.match(industryDiagnosticsWGSL(sim.g), /control = u32\(industryControlActive\(P\.guardPort\)\)/);
}

// Default hearth observations must work without a caller inventing its regions.
{
  const f = fixture(90);
  const hearth = { id: 'default-hearth', type: 'hearth', x: 20, y: 4, z: 20, rotation: 1, powered: false };
  const observed = await issue(f.api, f.sim, hearth, {}, {
    control: 0, controlRequired: 0, regions: [[1, 1, 700, 700], [4, 4, 6400, 1600]],
  });
  assert.equal(observed.status, 'ready');
  assert.equal(f.sim.test.params.sampleCount, 22);
  assert.equal(observed.evidence.regions.fuel.sampled, 12);
  assert.deepEqual(f.sim.test.params.samples.slice(0, 12).map(p => p.slice(0, 3)),
    hearthRegions(hearth).firebox, 'default fuel observation includes naturally loaded coal in either row');
  assert.deepEqual(f.sim.test.params.rules[0], [0, ...HEARTH_FUEL_IDS, -1]);
  assert.equal(f.sim.test.params.limits[0][3] & 8, 8, 'spent coal is not usable fuel anywhere in the firebox');
  assert.equal(observed.evidence.regions.charge.sampled, 6);
  assert.equal(observed.evidence.regions.outlet.sampled, 4);
  assert.equal(observed.evidence.regions.charge.maxTemperatureC, 1600);
  f.api.dispose();
}

// Registered gate ports remain inspectable without pretending manual gate modes
// require an electrical signal. Mode changes invalidate previous observations.
{
  const f = fixture(91);
  const gate = { id: 'default-gate', type: 'gate', x: 20, y: 4, z: 20, rotation: 2, gateMode: 'open' };
  const manual = await issue(f.api, f.sim, gate, {}, { control: 1, controlRequired: 0 });
  assert.equal(manual.evidence.base.intact, true);
  assert.equal(manual.evidence.control.active, true);
  assert.equal(manual.evidence.control.required, false);
  assert.deepEqual(f.sim.test.params.guardPort, deviceCell(gate, -1, 0, 1));
  const signalGate = { ...gate, gateMode: 'signal' };
  assert.notEqual(industryDiagnosticSignature(gate), industryDiagnosticSignature(signalGate));
  assert.equal(f.api.snapshot(signalGate).freshness, 'stale');
  const off = await issue(f.api, f.sim, signalGate, {}, { control: 0, controlRequired: 1 });
  assert.equal(f.sim.test.params.guardPowered, 1);
  assert.equal(off.evidence.control.active, false);
  assert.equal(off.status, 'control off');
  f.api.dispose();
}

// An entirely occupied pump outlet is blocked; partial occupancy stays available.
now += 101;
{
  const blocked = await issue(api, sim, pump, {}, { regions: [[1, 0, 0, 22], [8, 8, 176, 22]] });
  assert.equal(blocked.status, 'outlet occupied');
  assert.equal(blocked.evidence.regions.outlet.available, 0);
  assert.equal(blocked.running, 'unconfirmed', 'ready/blocked observations are not transfer history');
  assert.equal(presentIndustryDiagnostic(blocked).label, 'Outlet has no open cells');
  assert.equal(api.recordTransfer(pump, { confirmed: true, count: 3, source: 'pump-transfer' }), true);
  assert.equal(api.snapshot(pump).running, 'confirmed-transfer-observed');
  assert.equal(api.snapshot(pump).transferHistory.count, 3);
  assert.equal(api.recordTransfer(pump, { count: 3 }), false, 'unconfirmed estimates are rejected');
  const before = sim.test.dispatches;
  const cached = await api.inspect(pump);
  assert.equal(sim.test.dispatches, before, 'throttled sample returns cached result');
  assert.equal(cached.freshness, 'fresh');
}

// Rotation/filter are part of identity; separator rules mirror its actual powder routes.
now += 101;
{
  const separator = { id: 'sort-a', type: 'separator', x: 30, y: 4, z: 30, rotation: 1, filter: E.SCRAP, powered: false };
  const job = api.inspect(separator);
  await flush();
  const params = sim.test.params;
  assert.equal(params.sampleCount, 48);
  assert.deepEqual(params.rules[1], [1 << K.POWDER, E.SCRAP, -1, -1]);
  assert.deepEqual(params.rules[2], [1 << K.POWDER, -1, -1, E.SCRAP]);
  assert.deepEqual(params.samples[0].slice(0, 3), deviceCell(separator, 0, 1, 0));
  sim.test.reads.at(-1).resolve(answer({ regions: [[1, 1, 25, 25], [1, 1, 25, 25], [1, 0, 25, 25]] }));
  const routed = await job;
  assert.equal(routed.status, 'ready');
  assert.equal(routed.evidence.regions.selectedRoute.eligible, 1);
  assert.equal(routed.evidence.regions.otherRoute.eligible, 0);
  assert.equal(routed.running, 'unconfirmed');
  assert.notEqual(industryDiagnosticSignature(separator), industryDiagnosticSignature({ ...separator, rotation: 2 }));
  assert.notEqual(industryDiagnosticSignature(separator), industryDiagnosticSignature({ ...separator, filter: E.NUGGETS }));
  assert.notEqual(industryDiagnosticSignature(separator), industryDiagnosticSignature({ ...separator, powered: true }));
}

// A ship's alternating private target remains unknown without a physics-confirmed expected ID.
now += 101;
{
  const ship = { id: 'ship-a', type: 'ship', x: 50, y: 4, z: 50, rotation: 0, powered: false };
  const unknownTarget = await issue(api, sim, ship, {}, { regions: [[1, 1, 25, 25]] });
  assert.equal(unknownTarget.status, 'unknown');
  assert.equal(unknownTarget.evidence.regions.inlet.eligible, 1);
  assert.equal(sim.test.params.rules[0][0], (1 << K.POWDER) | (1 << K.SOLID));
  assert.deepEqual(sim.test.params.limits[0].slice(0, 2), [1e30, 400], 'metal shipment keeps the native 400 C limit');
  now += 101;
  const exactTarget = await issue(api, sim, ship, { expectedShipId: E.NUGGETS }, { regions: [[1, 1, 25, 25]] });
  assert.equal(exactTarget.status, 'ready');
  assert.equal(sim.test.params.rules[0][1], E.NUGGETS);
}

// Custom hearth geometry comes only from its owner; fuel/charge temperatures are retained.
now += 101;
{
  const hearth = { id: 'hearth-a', type: 'hearth', x: 12, y: 4, z: 12, rotation: 3, powered: true };
  const overrides = {
    base: { material: E.TUNGSTEN, cells: [[12, 4, 12]] },
    regions: {
      fuel: { cells: [[12, 5, 12], [12, 5, 13]], kinds: [K.POWDER], ids: [E.BROKENCOAL] },
      charge: { cells: [[13, 5, 12]], ids: [E.SCRAP] },
    },
    statusPolicy: { primaryRegions: ['fuel'] },
  };
  const observation = await issue(api, sim, hearth, overrides, { baseMatched: 1, baseExpected: 1, control: 1,
    controlRequired: 1, regions: [[2, 2, 900, 470], [1, 1, 1800, 1800]] });
  assert.equal(observation.status, 'ready');
  assert.equal(observation.evidence.regions.fuel.meanTemperatureC, 450);
  assert.equal(observation.evidence.regions.fuel.maxTemperatureC, 470);
  assert.equal(sim.test.params.baseMaterial, E.TUNGSTEN);
  assert.equal(sim.test.params.guardMaterial, E.TUNGSTEN);
  assert.equal(api.recordConfirmation(hearth, { confirmed: true, source: 'hearth-observation', fuelCells: 2 }), true);
  assert.equal(api.snapshot(hearth).confirmed.fuelCells, 2);
}

// Gate has no guessed shutter/fuel geometry; caller-provided regions and confirmed transitions remain distinct.
now += 101;
{
  const gate = { id: 'gate-a', type: 'gate', x: 60, y: 4, z: 60, rotation: 2, gateMode: 'signal' };
  const custom = { base: { material: E.TUNGSTEN, cells: [[60, 4, 60]] },
    regions: { shutter: { cells: [[60, 5, 60]], ids: [E.TUNGSTEN] } },
    statusPolicy: { primaryRegions: ['shutter'] } };
  const observed = await issue(api, sim, gate, custom, { baseExpected: 1, baseMatched: 1, regions: [[1, 1, 20, 20]] });
  assert.equal(observed.status, 'ready');
  assert.equal(Object.keys(observed.evidence.regions).join(','), 'shutter');
  api.recordConfirmation(gate, { confirmed: true, source: 'gate-transition', closed: true });
  assert.equal(api.snapshot(gate).confirmed.closed, true);
}

// A changed inspection never queues a second GPU read behind the one active sample.
now += 101;
{
  const firstDevice = { ...pump, id: 'busy-a', x: 70 };
  const nextDevice = { ...pump, id: 'busy-b', x: 80 };
  const first = api.inspect(firstDevice);
  await flush();
  const dispatches = sim.test.dispatches;
  const second = await api.inspect(nextDevice);
  assert.equal(second.status, 'pending');
  assert.equal(sim.test.dispatches, dispatches, 'the second machine is not queued or dispatched');
  sim.test.reads.at(-1).resolve(answer());
  assert.equal((await first).freshness, 'stale', 'switching selection discards the former observation');
  assert.equal(api.pending, 0);
}

// Throttle, stale sample, stale device/sim reset and callback disposal.
now += 101;
{
  now += 501;
  assert.equal(api.snapshot(pump).freshness, 'stale');
  const changed = { ...pump, rotation: 2 };
  assert.equal(api.snapshot(changed).status, 'unknown', 'rotated identity cannot reuse stale data');
  const refresh = api.inspect(pump);
  await flush();
  const oldRead = sim.test.reads.at(-1);
  const replacement = makeSim(2);
  liveSim = replacement;
  api.snapshot(pump); // observes the simulation replacement and invalidates the old sample
  oldRead.resolve(answer({ regions: [[1, 1, 20, 20], [0, 0, 0, -3.402823e38]] }));
  const stale = await refresh;
  assert.equal(stale.status, 'unknown');
  assert.equal(stale.freshness, 'stale');
  assert.equal(api.snapshot(pump).freshness, 'stale', 'simulation replacement invalidates old observation');
  assert.equal(api.pending, 0);
  now += 1;
  const fresh = await issue(api, replacement, pump, {}, { regions: [[0, 0, 0, -3.402823e38], [0, 0, 0, -3.402823e38]] });
  assert.equal(fresh.status, 'empty inlet');
  api.reset();
  assert.equal(api.snapshot(pump).freshness, 'stale', 'explicit world reset invalidates cached samples');
  assert.equal(api.snapshot(pump).status, 'unknown');
}

// Disposed readback callbacks are discarded, and no full-grid CPU API is called.
{
  const disposeSim = makeSim(3); liveSim = disposeSim;
  const disposable = createIndustryDiagnostics({ getSim: () => liveSim, onError: e => errors.push(e) });
  const pending = disposable.inspect(pump);
  await flush();
  const read = disposeSim.test.reads[0];
  assert.ok(read);
  disposable.dispose();
  read.resolve(answer({ regions: [[1, 1, 20, 20], [0, 0, 0, -3.402823e38]] }));
  const discarded = await pending;
  assert.equal(discarded.status, 'unknown');
  assert.equal(disposable.snapshot(pump).reason, 'diagnostics disposed');
  assert.equal(disposable.pending, 0);
  assert.deepEqual(errors, []);
  assert.ok(disposeSim.test.dispatches <= 1);
}

// Cache hits supersede a different active request before returning; its late
// completion cannot evict the still-valid cache entry for the same device.
{
  const f = fixture(10);
  const device = { id: 'cache-race', type: 'hearth', x: 30, y: 4, z: 30, rotation: 0, powered: false };
  const overridesA = {
    base: { material: E.TUNGSTEN, cells: [[30, 4, 30]] },
    regions: { fuel: { cells: [[30, 5, 30]], ids: [E.COAL] } },
    statusPolicy: { primaryRegions: ['fuel'] },
  };
  const overridesB = {
    base: { material: E.TUNGSTEN, cells: [[30, 4, 30]] },
    regions: { fuel: { cells: [[31, 5, 30]], ids: [E.COAL] } },
    statusPolicy: { primaryRegions: ['fuel'] },
  };
  const cacheA = await issue(f.api, f.sim, device, overridesA, { baseExpected: 1, baseMatched: 1, regions: [[1, 1, 450, 450]] });
  assert.equal(cacheA.status, 'ready');
  const requestB = f.api.inspect(device, overridesB);
  await flush();
  const readB = f.sim.test.reads.at(-1);
  assert.ok(readB);
  const cachedA = await f.api.inspect(device, overridesA);
  assert.equal(cachedA.status, 'ready', 'cache A is returned while B is in flight');
  readB.resolve(answer({ baseExpected: 1, baseMatched: 1, regions: [[1, 0, 0, 450]] }));
  assert.equal((await requestB).freshness, 'stale', 'superseded B is discarded');
  assert.equal(f.api.snapshot(device).status, 'ready');
  assert.equal(f.api.snapshot(device).freshness, 'fresh', 'late B neither publishes nor evicts cache A');
}

// Caller mutations after inspect cannot change normalized geometry, guard,
// eligibility, or policy while the request waits for dispatch/readback.
{
  const f = fixture(11);
  const device = { id: 'override-copy', type: 'hearth', x: 40, y: 4, z: 40, rotation: 0, powered: true };
  const overrides = {
    base: { material: E.TUNGSTEN, cells: [[40, 4, 40]] },
    guard: { base: [40, 4, 40], material: E.TUNGSTEN, port: [39, 4, 41], powered: true },
    regions: { fuel: { cells: [[40, 5, 40]], ids: [E.COAL], requiresPositiveLife: true } },
    statusPolicy: { primaryRegions: ['fuel'] },
  };
  const pending = f.api.inspect(device, overrides);
  overrides.base.cells[0][0] = 99;
  overrides.guard.base[0] = 98;
  overrides.guard.port[0] = 97;
  overrides.regions.fuel.cells[0][0] = 96;
  overrides.regions.fuel.ids[0] = E.SCRAP;
  overrides.statusPolicy.primaryRegions[0] = 'mutated';
  await flush();
  assert.deepEqual(f.sim.test.params.baseCells[0].slice(0, 3), [40, 4, 40]);
  assert.deepEqual(f.sim.test.params.guardBase, [40, 4, 40]);
  assert.deepEqual(f.sim.test.params.guardPort, [39, 4, 41]);
  assert.deepEqual(f.sim.test.params.samples[0], [40, 5, 40, 0]);
  assert.equal(f.sim.test.params.rules[0][1], E.COAL);
  assert.ok((f.sim.test.params.limits[0][3] & 8) !== 0, 'positive-life policy survives caller mutation');
  f.sim.test.reads[0].resolve(answer({ baseExpected: 1, baseMatched: 1, control: 1, controlRequired: 1, regions: [[1, 1, 450, 450]] }));
  assert.equal((await pending).status, 'ready', 'copied primary-region policy is used at completion');
}

// A disposed simulation object invalidates its cache on both snapshot and
// inspect paths, even when getSim keeps returning that same object.
{
  const f = fixture(12);
  const device = { id: 'disposed-sim-cache', type: 'pump', x: 50, y: 4, z: 50, rotation: 0, powered: false };
  const fresh = await issue(f.api, f.sim, device, {}, { regions: [[1, 1, 20, 20], [0, 0, 0, -3.402823e38]] });
  assert.equal(fresh.status, 'ready');
  const dispatches = f.sim.test.dispatches;
  f.sim.disposed = true;
  const snapshot = f.api.snapshot(device);
  assert.equal(snapshot.freshness, 'stale');
  assert.notEqual(snapshot.status, 'ready');
  const inspected = await f.api.inspect(device);
  assert.equal(inspected.status, 'unknown');
  assert.equal(inspected.reason, 'simulation disposed');
  assert.equal(f.sim.test.dispatches, dispatches, 'disposed simulation cannot serve its throttled cache or dispatch');
}

// Freshness is measured from dispatch/sample time, so a slow readback cannot
// be returned as fresh merely because its completion callback just ran.
{
  const f = fixture(13, { staleMs: 500 });
  const device = { id: 'slow-readback', type: 'pump', x: 60, y: 4, z: 60, rotation: 0, powered: false };
  const dispatchAt = f.clock.now;
  const pending = f.api.inspect(device);
  await flush();
  f.clock.now += 501;
  f.sim.test.reads[0].resolve(answer({ regions: [[1, 1, 20, 20], [0, 0, 0, -3.402823e38]] }));
  const completed = await pending;
  assert.equal(completed.sampledAt, dispatchAt);
  assert.equal(completed.freshness, 'stale');
  assert.equal(f.api.snapshot(device).freshness, 'stale');
}

// Hearth status is based on the bounded native fuel cells and rejects exhausted
// coal IDs; positive remaining terrain life is encoded into the same probe.
{
  const f = fixture(14);
  const device = { id: 'fuel-life', type: 'hearth', x: 70, y: 4, z: 70, rotation: 0, powered: true };
  const fuel = hearthRegions(device).fuel;
  const overrides = {
    regions: { fuel: { cells: fuel, kinds: [K.POWDER], ids: [...HEARTH_FUEL_IDS], requiresPositiveLife: true } },
    statusPolicy: { primaryRegions: ['fuel'] },
  };
  const exhausted = await issue(f.api, f.sim, device, overrides, { control: 1, controlRequired: 1, regions: [[12, 0, 0, 0]] });
  assert.equal(exhausted.status, 'empty inlet', 'fuel IDs with no positive life are not ready');
  assert.deepEqual(f.sim.test.params.rules[0], [1 << K.POWDER, E.COAL, E.BROKENCOAL, -1]);
  assert.ok((f.sim.test.params.limits[0][3] & 8) !== 0);
  f.clock.now += 101;
  const burning = await issue(f.api, f.sim, device, overrides, { control: 1, controlRequired: 1, regions: [[12, 1, 1, 450]] });
  assert.equal(burning.status, 'ready', 'remaining positive-life fuel is eligible');
  assert.equal(burning.evidence.regions.fuel.eligible, 1);
}

// The legacy heater's capped heating and molten-output motion are separate
// eligibility branches: E.LAVA bypasses the ordinary <2200 C heat limit.
{
  const f = fixture(15);
  const device = { id: 'heater-hot-lava', type: 'heater', x: 80, y: 4, z: 80, rotation: 0, powered: false };
  const hotLava = await issue(f.api, f.sim, device, {}, { baseExpected: 16, baseMatched: 16, regions: [[1, 1, 2300, 2300]] });
  assert.equal(hotLava.status, 'ready', 'hot LAVA remains an eligible legacy output');
  assert.equal(f.sim.test.params.rules[0][1], E.LAVA);
  assert.ok((f.sim.test.params.limits[0][3] & 16) !== 0, 'heater rule encodes the LAVA temperature exemption');
  assert.equal(f.sim.test.params.limits[0][2], 2200);
  const wgsl = industryDiagnosticsWGSL({ nx: 32, ny: 32, nz: 32 });
  assert.ok(wgsl.includes('if ((flags & RULE_TEMP_EXEMPT_IDS) != 0u)'));
  assert.ok(wgsl.includes('idMatches = true;'));
  assert.ok(wgsl.includes('if ((flags & RULE_POSITIVE_LIFE) != 0u && !(a.z > 0.0))'));
  assert.ok(wgsl.includes('a.y >= maxT') && wgsl.includes('a.y > maxT'));
  const dir = mkdtempSync(join(tmpdir(), 'industry-diagnostics-wgsl-'));
  try {
    const file = join(dir, 'industry-diagnostics.wgsl');
    writeFileSync(file, wgsl);
    const naga = spawnSync('naga', [file], { encoding: 'utf8' });
    if (naga.error?.code === 'ENOENT') throw new Error('Install naga-cli for CPU-only Industry diagnostics WGSL validation.');
    assert.equal(naga.status, 0, `Naga must accept the complete diagnostics shader:\n${naga.stdout}\n${naga.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Exact control observations consume no work-region slots.
assert.equal(INDUSTRY_DIAGNOSTICS.MAX_REGIONS, 8);
assert.equal(RESULT_VECS, 10);
{
  const f = fixture(16);
  const device = { id: 'exact-control', type: 'hearth', x: 20, y: 4, z: 20, rotation: 0, powered: false };
  for (const material of [E.BUTTON, E.CONTACTOR, E.LAMP, E.EMPTY]) {
    const observed = await issue(f.api, f.sim, device, {}, {
      controlSample: [material, 125.5, 2.5, 81], regions: [[1, 1, 20, 20]],
    });
    assert.deepEqual(observed.evidence.control.sample, { material, temperatureC: 125.5, life: 2.5, ctype: 81 });
    assert.deepEqual(Object.keys(observed.evidence.regions), ['fuel', 'charge', 'outlet']);
    assert.equal(f.sim.test.params.sampleCount, 22);
    assert.equal(observed.running, 'unconfirmed'); f.clock.now += 101;
  }
  for (const controlSample of [[-1, 0, 0, 0], [E.BUTTON + .5, 20, 1, 0], [1e6, 20, 1, 0],
    [E.BUTTON, NaN, 1, 0], [E.BUTTON, 20, Infinity, 0], [E.LAMP, 20, 0, NaN],
    [E.LAMP, 20, 0, 1.5], [E.LAMP, 20, 0, -1]]) {
    const observed = await issue(f.api, f.sim, device, {}, { controlSample });
    assert.equal(observed.evidence.control.sample, null); f.clock.now += 101;
  }
  const disabled = await issue(f.api, f.sim, device, { guard: null }, { controlSample: [E.BUTTON, 20, 1, 0] });
  assert.equal(disabled.evidence.control.sample, null); assert.equal(f.sim.test.params.guardEnabled, 0);
  f.clock.now += 101;
  const outside = await issue(f.api, f.sim, device,
    { guard: { base: [20, 4, 20], material: -1, port: [-1, 4, 20], powered: false } },
    { controlSample: [-1, 0, 0, 0] });
  assert.equal(outside.evidence.control.sample, null); f.api.dispose();
}
{
  const f = fixture(17); f.sim.compact = {}; f.sim.bindPhysicalRO = { physical: true };
  const header = { format: 3 };
  f.sim.readHeader = options => { assert.deepEqual(options, { physical: true }); return header; };
  const dispatch = f.sim._dispatch;
  f.sim._dispatch = (kernel, size, options) => {
    assert.equal(options.bind[1], f.sim.bindPhysicalRO); assert.equal(options.header, header);
    dispatch(kernel, size, options);
  };
  const device = { id: 'native-control', type: 'pump', x: 20, y: 4, z: 20, rotation: 0, powered: false };
  const observed = await issue(f.api, f.sim, device, {}, { controlSample: [E.CONTACTOR, 20, 1, 0] });
  assert.equal(observed.evidence.control.sample.material, E.CONTACTOR); f.api.dispose();
}
{
  const shader = industryDiagnosticsWGSL({ nx: 32, ny: 32, nz: 32 });
  assert(shader.includes('if (P.guardEnabled != 0u && inGrid(P.guardPort))'));
  assert(shader.includes('controlSample = vec4f(f32(eid(a)), a.y, a.z, floor(a.w))'));
  assert(shader.includes('result[at + 1u + MAX_REGIONS] = controlSample'));
}

// Pure helper and region safety checks.
assert.equal(presentIndustryDiagnostic({ status: 'ready' }).running, 'unconfirmed');
assert.equal(api.recordConfirmation(pump, { source: 'desired-mode', closed: true }), false);
assert.equal(errors.length, 0);
console.log('ok bounded async probes, request ownership, override snapshots, positive-life fuel, heater lava exception, stale/reset/dispose, and confirmed evidence; Naga CPU validation passed');

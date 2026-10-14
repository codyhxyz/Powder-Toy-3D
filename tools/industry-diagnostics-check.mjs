// CPU-only async mock of the Industry diagnostics runtime; no browser/GPU or full-grid reads.
import assert from 'node:assert/strict';
import { createIndustryDiagnostics, industryDiagnosticSignature, presentIndustryDiagnostic } from '../src/industry/diagnostics.js';
import { E, K } from '../src/elements.js';
import { deviceCell } from '../src/industry/catalog.js';

const RESULT_VECS = 9;
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
function answer({ baseMatched = 16, baseExpected = 16, control = 1, controlRequired = 0, regions = [] } = {}) {
  const f = new Float32Array(RESULT_VECS * 4);
  f.set([baseMatched, baseExpected, control, controlRequired], 0);
  for (let i = 0; i < 8; i++) f.set(regions[i] ?? [0, 0, 0, -3.402823e38], (i + 1) * 4);
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

// Pure helper and region safety checks.
assert.equal(presentIndustryDiagnostic({ status: 'ready' }).running, 'unconfirmed');
assert.equal(api.recordConfirmation(pump, { source: 'desired-mode', closed: true }), false);
assert.equal(errors.length, 0);
console.log('ok bounded async probes, eligibility, native control, base damage, stale/reset/dispose, and confirmed evidence');

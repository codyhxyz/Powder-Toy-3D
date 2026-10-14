// CPU-only orchestration/conservation checks. No browser or GPU.
// node tools/industry-physics-check.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { E, K } from '../src/elements.js';
import { deviceCell } from '../src/industry/catalog.js';
import { createIndustryPhysics, validateIndustryPhysics, controlCell, machineBox, machinePorts, validMachine } from '../src/industry/physics.js';
import { createTransfer, Load } from '../src/pov/tools/transfer.js';
import { WGSL_CHECK } from '../src/shaders/industry.js';
import { transferFrag, TransferParams } from '../src/shaders/transfer.js';

globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, INDIRECT: 4 };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
  const reads = [], calls = [], edits = [];
  const gpu = {
    layout: () => ({}), createBuffer: () => ({}), bindGroup: () => ({}),
    kernel: () => ({ state: 'ready', ready: Promise.resolve() }),
    readback: { ring: () => ({ buffer: {}, next: () => 0,
      read: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) }) },
  };
  const sim = { gpu, g: { nx: 128, ny: 128, nz: 128 }, L: {}, tables: {}, bindRW: {}, version: 0,
    header: () => ({}), wake() {}, editKernel: () => ({ ready: Promise.resolve() }),
    edit: (kernel, box, values) => edits.push({ box, values }),
    _dispatch: (kernel, size, { params }) => calls.push(params),
  };
  function answer(items = []) {
    const buf = new Float32Array(256 * 4);
    for (let i = 0; i < 256; i++) buf[i * 4] = -1;
    items.forEach((c, i) => buf.set(c, i * 4));
    assert.ok(reads.length, 'a readback was requested');
    reads.shift().resolve(buf.buffer);
  }
  return { sim, reads, calls, edits, answer };
}
const d = (type, extra = {}) => ({ id: type, type, x: 24, y: 8, z: 32, rotation: 0, ...extra });
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

await test('rotated ports, bounds and finite drilling footprint', () => {
  for (let rotation = 0; rotation < 4; rotation++) {
    const m = d('miner', { rotation });
    assert.deepEqual(controlCell(m), deviceCell(m, -1, 0, 1));
    const b = machineBox(m);
    assert.equal(b.hi[0] - b.lo[0] + 1, rotation % 2 ? 8 : 4);
    assert.equal(b.hi[2] - b.lo[2] + 1, rotation % 2 ? 4 : 8);
    assert.equal(b.hi[1] - b.lo[1] + 1, 3);
    assert.equal(machinePorts(m).inlet.length, 8);
    assert.equal(new Set(machinePorts(m).mouth.map(String)).size, 48);
  }
  assert.equal(validMachine(d('belt'), { nx: 128, ny: 128, nz: 128 }), true);
  for (const bad of [{ x: NaN }, { rotation: 4 }, { x: 125 }, { type: '__proto__' }, { y: -1 }])
    assert.equal(!!validMachine(d('belt', bad), { nx: 128, ny: 128, nz: 128 }), false);
});
await test('exact transfer defaults, deduplication, atomic filters and reservation', async () => {
  const f = fixture(), t = createTransfer({ getSim: () => f.sim }), load = new Load(2);
  const p = t.take(load, { cells: [[1, 2, 3], [1, 2, 3]], kinds: [K.POWDER] });
  assert.equal(f.calls[0].count, 1);
  assert.equal(f.calls[0].guardMaterial, -1);
  assert.equal(f.calls[0].maxTemperature, 1e30);
  assert.equal(load.free, 0);
  f.answer([[E.SAND, 22, 0, 0.25]]);
  await p;
  assert.equal(load.count, 1);
  const put = t.put(load, { cells: [[2, 2, 3]] });
  assert.equal(load.count, 1, 'in-flight put remains counted');
  assert.equal(load.cells.length, 0, 'cannot place twice');
  f.answer(); await put;
  assert.deepEqual(load.cells, [[E.SAND, 22, 0, 0.25]], 'blocked outlet restores cargo');
  const guarded = t.take(load, { cells: [[3, 2, 3]], kinds: [K.SOLID], maxTemperature: 90,
    guard: { base: [20, 4, 20], material: E.INSULATOR, port: [19, 4, 21], powered: true } });
  assert.equal(f.calls.at(-1).maxTemperature, 90);
  assert.equal(f.calls.at(-1).guardPowered, 1);
  assert.deepEqual(f.calls.at(-1).guardPort, [19, 4, 21]);
  f.answer(); await guarded;
  assert.equal(load.count, 1);
});
await test('paused dt, bounds, defaults and all 128 machines', async () => {
  const f = fixture(), p = createIndustryPhysics({ getSim: () => f.sim }); await p.ready;
  for (const dt of [0, -1, NaN]) p.step(dt, [d('belt')]);
  assert.equal(f.edits.length, 0);
  p.step(0.02, [d('separator', { filter: -10 }), d('belt', { id: 'separator' })]);
  assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].values.selectedId, E.NUGGETS);
  p.reset(); await p.ready;
  p.step(1, Array.from({ length: 140 }, (_, i) => d('heater', { id: String(i) })));
  assert.equal(f.edits.length, 129);
  assert.equal(f.edits.at(-1).values.dt, 0.1);
  p.dispose(); p.step(1, [d('belt')]); assert.equal(f.edits.length, 129);
});
await test('foundations are structural matter, with no edit or transfer dispatch', async () => {
  const f = fixture(), p = createIndustryPhysics({ getSim: () => f.sim }); await p.ready;
  p.step(.1, [d('foundation'), d('foundation', {id:'top',y:127})]);
  assert.equal(f.edits.length + f.calls.length,0);
  assert.deepEqual(p.toJSON(),{version:1,pumps:[]});
  p.dispose();
});
await test('shipping only on confirmed readback; metal inclusive 90 C gate', async () => {
  const f = fixture(), shipped = [], p = createIndustryPhysics({ getSim: () => f.sim, onShip: c => shipped.push(c) }); await p.ready;
  p.step(0.1, [d('ship')]); p.step(0.1, [d('ship')]);
  assert.equal(shipped.length, 0);
  assert.equal(p.pending, 1);
  assert.equal(f.calls[0].cells[0][3], E.NUGGETS);
  assert.equal(f.calls[0].guardMaterial, E.INSULATOR);
  p.step(0.1, [d('ship')]); assert.equal(f.calls.length, 1, 'no concurrent request from a device');
  f.answer([[E.NUGGETS, 31, 0, 0.2]]); await settle();
  assert.deepEqual(shipped, [{ id: E.NUGGETS, count: 1, temperature: 31 }]);
  p.step(0.1, [d('ship')]);
  assert.equal(f.calls[1].cells[0][3], E.METAL);
  assert.equal(f.calls[1].maxTemperature, 90);
  f.answer(); await settle(); assert.equal(shipped.length, 1);
  p.dispose();
});
await test('reset, rebind and dispose invalidate asynchronous credit', async () => {
  for (const action of ['reset', 'rebind', 'dispose']) {
    const f = fixture(), shipped = [];
    let sim = f.sim;
    const p = createIndustryPhysics({ getSim: () => sim, onShip: c => shipped.push(c) }); await p.ready;
    p.step(0.1, [d('ship')]); p.step(0.1, [d('ship')]);
    if (action === 'rebind') sim = fixture().sim; else p[action]();
    f.answer([[E.NUGGETS, 22, 0, 0]]); await settle();
    assert.equal(shipped.length, 0, action);
    p.dispose(); assert.equal(p.pending, 0);
  }
});
await test('pump conserves blocked cargo and spills after dismantling without guard', async () => {
  const f = fixture(), p = createIndustryPhysics({ getSim: () => f.sim }); await p.ready;
  p.step(0.1, [d('pump')]); p.step(0.1, [d('pump')]);
  assert.equal(f.calls[0].kinds, 1 << K.LIQUID);
  f.answer([[E.WATER, 24, 0, 0.2], [E.WATER, 25, 0, 0.3]]); await settle();
  assert.equal(p.pending, 0, 'held matter does not prevent saving');
  assert.equal(p.buffered, 2, 'buffered counts held matter');
  p.step(0.1, [d('pump')]); p.step(0.1, [d('pump')]);
  assert.equal(f.calls[1].mode, 1);
  assert.equal(f.calls[1].guardMaterial, E.INSULATOR);
  assert.equal(f.calls[1].items.length, 2);
  f.answer(); await settle(); assert.equal(p.pending, 0); assert.equal(p.buffered, 2);
  p.step(0.1, []); p.step(0.1, []);
  assert.equal(f.calls[2].guardMaterial, -1, 'removed machine can spill without base');
  f.answer([[0, 0, 0, 0], [1, 0, 0, 0]]); await settle();
  assert.equal(p.pending, 0);
  p.step(0.1, []); assert.equal(f.calls.length, 3, 'no capture after dismantle');
  p.dispose();
});
await test('readback rejection releases reservations and reports once', async () => {
  const f = fixture(), errors = [], p = createIndustryPhysics({ getSim: () => f.sim, onError: e => errors.push(e.message) }); await p.ready;
  p.step(0.1, [d('ship')]); p.step(0.1, [d('ship')]);
  f.reads.shift().reject(new Error('test device lost')); await settle();
  assert.deepEqual(errors, ['test device lost']); assert.equal(p.pending, 0); p.dispose();
});
await test('fair dispatch eventually reaches every shipping device', async () => {
  const f = fixture(), p = createIndustryPhysics({ getSim: () => f.sim }); await p.ready;
  const ds = Array.from({ length: 24 }, (_, i) => d('ship', { id: String(i), x: i * 4 }));
  for (let n = 0; n < 40; n++) {
    p.step(0.1, ds);
    while (f.reads.length) f.answer();
    await settle();
  }
  assert.equal(new Set(f.calls.map(c => c.guardBase[0])).size, 24); p.dispose();
});
await test('cargo snapshot conserves cells and does not alias input or output', async () => {
  const f = fixture(), p = createIndustryPhysics({ getSim: () => f.sim }); await p.ready;
  const device = d('pump', { powered: true });
  p.step(0.1, [device]); p.step(0.1, [device]);
  f.answer([[E.WATER, 24, 0, 0.25], [E.OIL, 71, 1, 0.5]]); await settle();
  const snapshot = p.toJSON();
  assert.deepEqual(snapshot, { version: 1, pumps: [{ id: 'pump', device, cells: [[E.WATER, 24, 0, 0.25], [E.OIL, 71, 1, 0.5]] }] });
  const canonical = validateIndustryPhysics(snapshot, [device]);
  canonical.pumps[0].cells[0][1] = -20;
  canonical.pumps[0].device.x++;
  assert.deepEqual(p.toJSON(), snapshot, 'validation result owns its arrays/device');
  const other = fixture(), restored = createIndustryPhysics({ getSim: () => other.sim });
  // Restore before kernels finish: must not invalidate their readiness epoch.
  restored.fromJSON(snapshot, [device]); await restored.ready;
  assert.deepEqual(restored.toJSON(), snapshot);
  snapshot.pumps[0].cells[0][1] = 999;
  snapshot.pumps[0].device.x++;
  assert.equal(restored.toJSON().pumps[0].cells[0][1], 24, 'restore owns its cell tuples');
  assert.equal(restored.toJSON().pumps[0].device.x, device.x, 'restore owns device geometry');
  assert.equal(other.calls.length + other.edits.length, 0, 'restore never writes terrain');
  restored.step(0.1, [device]); assert.equal(other.calls.length, 0, 'restored clock starts safely');
  restored.step(0.1, [device]);
  assert.equal(restored.pending, 1); assert.equal(restored.buffered, 0, 'in-flight put is not also buffered');
  assert.deepEqual(other.calls[0].items, [[E.OIL, 71, 1, 0.5], [E.WATER, 24, 0, 0.25]]);
  other.answer([[0, 0, 0, 0], [1, 0, 0, 0]]); await settle();
  assert.deepEqual(restored.toJSON(), { version: 1, pumps: [] }, 'landed cells cannot be reserialized');
  p.dispose(); restored.dispose();
});
await test('detached cargo survives save/load then spills unguarded exactly once', async () => {
  const f = fixture(), p = createIndustryPhysics({ getSim: () => f.sim }); await p.ready;
  const snapshot = { version: 1, pumps: [{ id: 'removed', device: d('pump', { id: 'removed', rotation: 2 }), cells: [[E.WATER, 27, 0, 0.25]] }] };
  p.fromJSON(snapshot, []);
  assert.deepEqual(p.toJSON(), snapshot);
  p.step(0.1, []); p.step(0.1, []);
  assert.equal(f.calls[0].guardMaterial, -1);
  assert.equal(f.calls[0].mode, 1);
  assert.deepEqual(f.calls[0].items, snapshot.pumps[0].cells);
  f.answer(); await settle();
  assert.deepEqual(p.toJSON(), snapshot, 'blocked spill retains serializable cargo');
  p.step(0.1, []); p.step(0.1, []);
  f.answer([[0, 0, 0, 0]]); await settle();
  assert.equal(p.buffered, 0);
  assert.deepEqual(p.toJSON(), { version: 1, pumps: [] });
  p.step(0.1, []); p.step(0.1, []);
  assert.equal(f.calls.length, 2, 'orphan cannot capture again');
  p.dispose();
});
await test('take and put in-flight snapshots/restores refuse without mutation', async () => {
  const f = fixture(), p = createIndustryPhysics({ getSim: () => f.sim }); await p.ready;
  const empty = { version: 1, pumps: [] }, device = d('pump');
  p.step(0.1, [device]); p.step(0.1, [device]);
  assert.equal(p.pending, 1);
  assert.throws(() => p.toJSON(), /pending/);
  assert.throws(() => p.fromJSON(empty, [device]), /pending/);
  f.answer([[E.WATER, 24, 0, 0.25]]); await settle();
  const before = p.toJSON();
  p.step(0.1, [device]); p.step(0.1, [device]);
  assert.equal(p.pending, 1); assert.equal(p.buffered, 0);
  assert.throws(() => p.toJSON(), /pending/);
  assert.throws(() => p.fromJSON(empty, [device]), /pending/);
  f.answer(); await settle();
  assert.deepEqual(p.toJSON(), before, 'failed save/restore leaves rejected put cargo intact');
  p.fromJSON(empty, []);
  assert.deepEqual(p.toJSON(), empty, 'valid restore replaces rather than appends owned loads');
  assert.equal(f.calls.length, 2, 'restore itself issues no transfer');
  p.reset();
  assert.deepEqual(p.toJSON(), empty, 'explicit world reset has no old cargo even before rebinding');
  p.dispose();
});
await test('malformed snapshots and wrong active identities reject atomically', async () => {
  const f = fixture(), p = createIndustryPhysics({ getSim: () => f.sim }); await p.ready;
  const device = d('pump');
  const good = { version: 1, pumps: [{ id: device.id, device, cells: [[E.WATER, 25, 0, 0.25]] }] };
  p.fromJSON(good, [device]);
  const malformed = [null, [], {}, { ...good, version: 2 }, { ...good, pumps: {} }, { ...good, pumps: Array(129).fill(good.pumps[0]) }];
  const mutations = [
    s => s.pumps.push(structuredClone(s.pumps[0])),
    s => { s.pumps[0] = null; },
    s => { s.pumps[0].id = 'wrong'; },
    s => { s.pumps[0].device.id = ''; },
    s => { s.pumps[0].device.id = 'x'.repeat(129); },
    s => { s.pumps[0].device.type = 'belt'; },
    s => { s.pumps[0].device.type = {}; },
    s => { s.pumps[0].device.x = 1.5; },
    s => { s.pumps[0].device.x = -1; },
    s => { s.pumps[0].device.x = 4096; },
    s => { s.pumps[0].device.x = NaN; },
    s => { s.pumps[0].device.rotation = 4; },
    s => { s.pumps[0].device.powered = 'true'; },
    s => { s.pumps[0].device.filter = -10; },
    s => { s.pumps[0].cells = []; },
    s => { s.pumps[0].cells = Array(17).fill([E.WATER, 20, 0, 0]); },
    s => { s.pumps[0].cells = [null]; },
    s => { s.pumps[0].cells[0].pop(); },
    s => { s.pumps[0].cells[0][0] = E.SAND; },
    s => { s.pumps[0].cells[0][0] = 999; },
    s => { s.pumps[0].cells[0][0] = E.WATER + 0.5; },
    s => { s.pumps[0].cells[0][1] = NaN; },
    s => { s.pumps[0].cells[0][2] = Infinity; },
    s => { s.pumps[0].cells[0][3] = '0'; },
    s => { s.pumps[0].cells[0][1] = 1e100; },
  ];
  for (const mutate of mutations) { const s = structuredClone(good); mutate(s); malformed.push(s); }
  for (const s of malformed) {
    assert.throws(() => validateIndustryPhysics(s, [device]));
    assert.throws(() => p.fromJSON(s, [device]));
    assert.deepEqual(p.toJSON(), good);
  }
  for (const devices of [null, {}, [device, device], [d('belt', { id: device.id })], [d('pump', { x: 25 })], [d('pump', { rotation: 1 })]]) {
    assert.throws(() => p.fromJSON(good, devices));
    assert.deepEqual(p.toJSON(), good);
  }
  // A later bad entry cannot replace/append the first already-valid load.
  const badTail = structuredClone(good);
  badTail.pumps.push({ id: 'tail', device: d('pump', { id: 'tail' }), cells: [[E.SAND, 20, 0, 0]] });
  assert.throws(() => p.fromJSON(badTail, [device]));
  assert.deepEqual(p.toJSON(), good);
  const duplicateOrphans = structuredClone(good);
  duplicateOrphans.pumps.push({...structuredClone(good.pumps[0]),device:{...device,x:40}});
  assert.throws(() => validateIndustryPhysics(duplicateOrphans, []),/identity/,'orphan IDs must be unique even at different locations');
  const tooTall = structuredClone(good); tooTall.pumps[0].device.y = 122;
  assert.throws(() => validateIndustryPhysics(tooTall, [], f.sim.g),/outside/,'all seven rows of an orphan pump must fit');
  assert.throws(() => p.fromJSON(tooTall, []), /outside/);
  assert.deepEqual(p.toJSON(),good);
  const outside = structuredClone(good); outside.pumps[0].device.x = 128;
  assert.doesNotThrow(() => validateIndustryPhysics(outside, []), 'standalone validation is independent of grid size');
  assert.throws(() => p.fromJSON(outside, []), /outside/);
  assert.deepEqual(p.toJSON(), good);
  assert.equal(f.calls.length + f.edits.length, 0, 'validation/restoration never overwrites terrain');
  p.dispose();
});
await test('snapshot maximum capacities and current setting changes remain valid', () => {
  const pumps = Array.from({ length: 128 }, (_, i) => ({ id: String(i), device: d('pump', { id: String(i), x: i * 4 }),
    cells: Array.from({ length: 16 }, () => [E.WATER, 20, 0, 0.25]) }));
  const snapshot = { version: 1, pumps };
  assert.deepEqual(validateIndustryPhysics(snapshot, []), snapshot);
  assert.deepEqual(validateIndustryPhysics(snapshot, pumps.map(p => ({ ...p.device, powered: true, filter: E.SAND }))), snapshot,
    'current powered/filter settings may differ without changing identity');
});
await test('Naga CPU validation of full industry and transfer WGSL at 32/128', () => {
  assert.match(transferFrag({ nx: 32, ny: 32, nz: 32 }), /if \(a\.y > P\.maxTemperature\)/, 'temperature upper bound is inclusive');
  assert.ok(TransferParams.fields.some(f => f.name === 'maxTemperature'));
  const dir = mkdtempSync(join(tmpdir(), 'industry-wgsl-'));
  try {
    for (const size of [32, 128]) for (const [name, code] of [['industry', WGSL_CHECK[0].code], ['transfer', transferFrag]]) {
      const file = join(dir, `${name}-${size}.wgsl`);
      writeFileSync(file, code({ nx: size, ny: size, nz: size }));
      const r = spawnSync('naga', [file], { encoding: 'utf8' });
      if (r.error?.code === 'ENOENT') throw new Error('Install naga-cli for the CPU shader validation (no browser fallback).');
      assert.equal(r.status, 0, `${name}: ${r.stdout}\n${r.stderr}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
console.log(`${passed} CPU checks passed; native physical behavior still requires industry-gpu-check.mjs.`);

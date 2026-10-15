// CPU only. Numerical/property checks plus the real driver with a command recorder.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ELEMENTS, K } from '../../src/elements.js';
import { FULL, MAX_FILL, FUEL_Q, lifeScale, isConductor, makeMaterial, withPayload, payloadOf, cTq, cFill, cid, ctypeOf, capacityQ, energyOf, withEnergy, energyFits, cRawTq, advectReference, validateMaterialTable } from '../../src/v2/layout.js';
import { PHASE_ROWS, PHASE_NORMAL_MAX, PHASE_HOT_BASE, PHASE_COLD_BASE, PHASE_STEPS, phaseOffsetEnergy, validatePhaseCore } from '../../src/v2/phase.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { gridLayout } from '../../src/sim.js';
import { V2_KERNELS, v2ImportWGSL, v2ExternalEventsWGSL, v2FluxWGSL, v2ColumnWGSL, v2GatherWGSL, v2LimitWGSL, v2BlockWGSL, V2_DYNAMICS_LAYOUT, v2ActLayout } from '../../src/shaders/v2.js';
import { encodeV2State, decodeV2State, stateLengths } from '../../src/v2/state.js';
const id = key => ELEMENTS.find(e => e.key === key).id;
const water = id('WATER'), oil = id('OIL');
const energySum = a => a.reduce((sum, m) => sum + energyOf(m), 0n);
const fillSum = a => a.reduce((sum, m) => sum + (cid(m.core) ? cFill(m.core) : 0), 0);
const fuelSum = a => a.reduce((sum, m) => sum + payloadOf(m.core), 0);
let cases = 0;
function check(before, transfers, uniform = false, gated = false) {
  const after = advectReference(before, transfers, gated);
  assert.equal(energySum(after), energySum(before), 'defined integer energy is exact');
  assert.equal(fillSum(after), fillSum(before), 'fill is exact');
  assert.equal(fuelSum(after), fuelSum(before), 'fuel quanta are exact');
  if (uniform) for (const m of after) assert.equal(cTq(m.core), cTq(before[0].core), 'dry and wet cells retain uniform T');
  for (const m of after) assert.equal(energyOf(withEnergy(m, energyOf(m))), energyOf(m));
  cases++; return after;
}
for (const amount of [1, 7, FULL / 8, FULL - 1, FULL, FULL + 1234, MAX_FILL]) {
  for (const bank of [-1000001, -1, 0, 1, 1000001]) {
    const source = withPayload(makeMaterial(oil, 20, amount, 17), Math.floor(FUEL_Q * amount / FULL)); source.bank = bank;
    for (const fraction of [0, 0.125, 0.5, 1]) {
      check([source, makeMaterial(0)], [{ from: 0, to: 1, amount: Math.floor(amount * fraction) }], bank === 0);
    }
  }
}
// Every face sign, simultaneous six-way outflow, exact last quantum and multiple arrivals.
for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
  const center = withPayload(makeMaterial(oil, 800, FULL + 1, 23), 2049); center.bank = -97;
  const transfers = Array.from({ length: 6 }, (_, i) => ({ from: 0, to: i + 1, amount: i === 5 ? 10927 : 10922 }));
  const after = check([center, ...Array.from({ length: 6 }, () => makeMaterial(0))], transfers);
  assert.equal(cid(after[0].core), 0, `drained source axis ${axis} sign ${sign}`);
  for (const m of after.slice(1)) assert.equal(ctypeOf(m.core), 23);
  check(after, transfers.map(t => ({ from: t.to, to: t.from, amount: t.amount })));
}
let seed = 113;
const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
for (let trial = 0; trial < 1000; trial++) {
  const same = trial % 2 === 0, temperature = rnd(3000);
  const materials = Array.from({ length: 7 }, (_, i) => {
    const amount = rnd(FULL * 2) + 1;
    const m = withPayload(makeMaterial(i ? oil : 0, same ? temperature : rnd(3000), amount, i), Math.floor(amount * FUEL_Q / FULL));
    if (!i) return makeMaterial(0, same ? temperature : rnd(3000));
    m.bank = same ? 0 : rnd(2000001) - 1000000; return m;
  });
  const transfers = materials.slice(1).map((m, i) => ({ from: i + 1, to: 0, amount: rnd(cFill(m.core) + 1) }));
  check(materials, transfers, same);
}
assert.throws(() => validateMaterialTable([{ key: 'bad', kind: K.LIQUID, elec: 0.05, burnRate: 0.01, cap: 1 }]), /collision/);
assert.throws(() => validateMaterialTable([{ key: 'bad', kind: K.LIQUID, elec: 0.05, life: 1, cap: 1 }]), /collision/);
assert(isConductor(water), 'fresh water conducts even though the legacy conducts flag is false');
assert.equal(lifeScale(id('SINGULARITY')), 256);
assert.equal(payloadOf(withPayload(makeMaterial(id('SINGULARITY')), 200 * 256).core) / lifeScale(id('SINGULARITY')), 200);
assert.equal(payloadOf(withPayload(makeMaterial(oil, 20, MAX_FILL), FUEL_Q * 16).core), 32768);
const mercury = withPayload(makeMaterial(id('MERCURY')), 3608);
assert.equal(payloadOf(mercury.core), 3608, 'spark codes fit the conductor tagged union');
assert.equal(capacityQ(makeMaterial(0).core), FULL, 'air has permanent carrier capacity');
for (const bank of [-2147483648, -100000, 0, 100000, 2147483647]) {
  const m = makeMaterial(water, 1000, MAX_FILL); m.bank = bank;
  assert.equal(energyOf(withEnergy(m, energyOf(m))), energyOf(m));
}
// Both latent plateaus, partial/compressed mass, full drainage and new receivers.
for (const fill of [1, 12345, FULL, MAX_FILL]) for (const hot of [true, false]) for (const fraction of [0, 0.1, 0.5, 0.999, 1]) {
  const row = PHASE_ROWS[water], tq = hot ? row.hotQ : row.coldQ, latent = BigInt(hot ? row.hotLatent : row.coldLatent) * BigInt(fill);
  const base = makeMaterial(water, tq * 0.25 - 273.25, fill, 11);
  const progress = latent * BigInt(Math.floor(fraction * 1000)) / 1000n;
  const total = BigInt(capacityQ(base.core)) * BigInt(tq) + phaseOffsetEnergy(water, fill) + (hot ? progress : -progress);
  const phase = withEnergy(base, total);
  assert.equal(energyOf(phase), total); assert.equal(cTq(phase.core), tq); assert(cRawTq(phase.core) > PHASE_NORMAL_MAX);
  validatePhaseCore(phase.core);
  const receiver = makeMaterial(0, tq * 0.25 - 273.25);
  check([phase, receiver], [{ from: 0, to: 1, amount: fill }], true, true);
  check([phase, receiver], [{ from: 0, to: 1, amount: Math.floor(fill / 2) }], true, true);
}
// Extreme signed banks and concentrated fuel reject arrivals rather than overflow.
for (const hot of [true, false]) {
  const sources = Array.from({ length: 7 }, () => {
    const m = withPayload(makeMaterial(oil, hot ? 10000 : -273.25, FULL), 65535);
    m.bank = hot ? 2147483647 : -2147483648; return m;
  });
  const transfers = sources.slice(1).map((_, i) => ({ from: i + 1, to: 0, amount: FULL }));
  const after = check(sources, transfers, false, true);
  assert.deepEqual(after, sources, 'unrepresentable energy/fuel remains at source');
}
// A 3x3x3 face graph exercises concurrent arrivals AND departures under signed
// bank saturation. Each edge has one sign, each source budgets six raw faces.
for (let trial = 0; trial < 300; trial++) {
  const phases = trial % 2 === 0;
  const materials = Array.from({ length: 27 }, () => {
    const fill = rnd(FULL * 2) + 6;
    if (phases) {
      const hot = rnd(2) === 0, r = PHASE_ROWS[water], tq = hot ? r.hotQ : r.coldQ;
      const m = makeMaterial(water, tq / 4 - 273.25, fill);
      const progress = BigInt(hot ? r.hotLatent : r.coldLatent) * BigInt(fill) * BigInt(rnd(1001)) / 1000n;
      return withEnergy(m, energyOf(m) + (hot ? progress : -progress));
    }
    const m = withPayload(makeMaterial(oil, [-273.25, 20, 10000][rnd(3)], fill), rnd(65536));
    m.bank = [-2147483648, -1, 0, 1, 2147483647][rnd(5)]; return m;
  });
  const transfers = [];
  for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) {
    const i = x + 3 * (z + 3 * y);
    for (const [exists, stride] of [[x < 2, 1], [y < 2, 9], [z < 2, 3]]) if (exists) {
      const from = rnd(2) ? i : i + stride, to = from === i ? i + stride : i;
      transfers.push({ from, to, amount: rnd(Math.floor(cFill(materials[from].core) / 6) + 1) });
    }
  }
  check(materials, transfers, false, true);
}
const impossible = makeMaterial(0, -273.25);
assert.equal(energyFits(impossible, -2147483649n), false);
for (const raw of [PHASE_HOT_BASE, PHASE_COLD_BASE, 65535]) {
  const invalid = makeMaterial(oil); invalid.core[0] = (invalid.core[0] & 0xff0000ff) | (raw << 8);
  assert.throws(() => validatePhaseCore(invalid.core), /phase tag/);
}
// Check the exact limb multiplication algorithm used by WGSL against independent BigInt.
function mul(a, b) {
  const a0 = a & 65535, a1 = a >>> 16, b0 = b & 65535, b1 = b >>> 16;
  const p = (a0 * b0) >>> 0, t = (a1 * b0 + (p >>> 16)) >>> 0, t1 = (a0 * b1 + (t & 65535)) >>> 0;
  return BigInt(((t1 << 16) | (p & 65535)) >>> 0) + (BigInt((a1 * b1 + (t >>> 16) + (t1 >>> 16)) >>> 0) << 32n);
}
for (let i = 0; i < 10000; i++) { const a = rnd(2 ** 32), b = rnd(2 ** 32); assert.equal(mul(a, b), BigInt(a) * BigInt(b)); }

// Explicit old-format fixture, not a v2 encoder incorrectly labelled as an old save.
const dims = [32, 32, 32], lengths = stateLengths(dims, true, 1);
const fixture = { dims, mode: 'v2', tick: 1, frame: 1, paints: 0, acc: 0, certified: true, writtenSinceTick: false };
for (const [key, n] of Object.entries(lengths)) fixture[key] = new Uint32Array(n);
fixture.cells.set([oil | (1173 << 8) | (73 << 24), FULL | (19 << 24), 0x12345678, 0xffff3800]);
function oldBytes(f) {
  const { cells, activity, args, aux, ...meta } = f;
  const json = new TextEncoder().encode(JSON.stringify({ ...meta, version: 1, hasAux: true }));
  const out = new Uint8Array(12 + json.length + [cells, activity, args, aux].reduce((n, a) => n + a.byteLength, 0)), v = new DataView(out.buffer);
  v.setUint32(0, 0x32545054, true); v.setUint32(4, 1, true); v.setUint32(8, json.length, true); out.set(json, 12);
  let offset = 12 + json.length; for (const a of [cells, activity, args, aux]) for (const word of a) { v.setUint32(offset, word, true); offset += 4; }
  return out;
}
const migrated = decodeV2State(oldBytes(fixture));
assert.equal(migrated.version, 2); assert.equal(migrated.migratedFrom, 1);
assert.equal(migrated.cells[0] >>> 24, 0, 'old remainder is not foam');
assert.equal(migrated.cells[3] >>> 16, FUEL_Q, 'old limiter is not fuel');
assert.equal(migrated.cells[2], 0x12345678); assert.equal(migrated.cells[3] & 65535, 0x3800);
assert.equal(migrated.certified, false);
assert.equal(decodeV2State(encodeV2State(migrated)).cells[3], migrated.cells[3]);
fixture.aux[0] = 1; assert.throws(() => decodeV2State(oldBytes(fixture)), /opaque auxiliary/); fixture.aux[0] = 0;
fixture.cells[1] = MAX_FILL + 1; assert.throws(() => decodeV2State(oldBytes(fixture)), /compression/);
fixture.cells[1] = FULL; fixture.cells[0] = oil | (41094 << 8); assert.throws(() => decodeV2State(oldBytes(fixture)), /temperature/);
const invalidPhaseSave = encodeV2State({ ...fixture, cells: migrated.cells.slice(), activity: migrated.activity });
// Encode is opaque; decoder is the validation boundary before uploading.
const invalidPhase = { ...migrated, cells: migrated.cells.slice() }; invalidPhase.cells[0] = oil | (41094 << 8);
assert.throws(() => decodeV2State(encodeV2State(invalidPhase)), /phase tag/);

// Ownership, bindings, actual storage sizes, reset/disposal and sleeping/wake writes.
globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
const commands = [], buffers = [];
const gpu = {
  createBuffer(desc) { const b = { ...desc, destroy() { this.destroyed = true; } }; buffers.push(b); return b; },
  queue: { writeBuffer(...a) { commands.push(['write', ...a]); } },
  write(...a) { commands.push(['write', ...a]); }, layout(name, entries) { return { name, entries }; },
  bindGroup(layout, entries) { assert.equal(entries.length, layout.entries.length); return { layout, entries }; },
  L: { EMPTY: { entries: [] } }, emptyGroup: {},
  kernel(desc) { return { ...desc, ready: Promise.resolve(), dispatch(frame, size, data) { commands.push(['dispatch', desc.name, data]); } }; },
  readback: { buffer(buffer, offset, size) { return Promise.resolve(new ArrayBuffer(size)); } },
  frame: { clear(...a) { commands.push(['clear', ...a]); }, copy(...a) { commands.push(['copy', ...a]); } }, flush() {},
};
const g = gridLayout(...dims), sim = { gpu, g, id: 1, version: 0, wholeWrites: 0, frame: 0, paints: 0, state: { A: {}, B: {}, F: {} }, marks: {}, tables: {},
  L: { STATE_RO: { entries: [0, 1] }, TABLES: { entries: [0] } }, header: () => ({}), noteWrite() {} };
let finishInitialization;
sim.ready = new Promise(resolve => { finishInitialization = () => {
  assert.equal(sim.version, 0, 'native readiness cannot suppress Simulation.clear initialization');
  resolve(sim);
}; });
const engine = new PhysicsV2(sim);
assert.equal(Object.values(engine.kernels).filter(k => k.build === 'now').length, 1);
for (const k of Object.values(engine.kernels))
  assert.equal(k.build, k.name === 'v2block' ? 'now' : 'idle', 'only required contact gets early queue priority');
await new Promise(resolve => setImmediate(resolve));
assert.equal(engine.isReady, false, 'finished native kernels still wait for initial state');
assert.equal(sim.version, 0);
finishInitialization();
await engine.ready;
assert.equal(engine.isReady, true);
assert.equal(sim.version, 1);
for (const [name, bytes] of [['cells', 16], ['aux', 4], ['liquidScratch', 16], ['jetMask', 4], ['events', 4]]) assert.equal(engine[name].size, g.slots * bytes);
assert.equal(engine.contactReady, false); assert.equal(engine.dynamics, null); assert.equal(engine.jets, null);
assert.equal(engine.groups.liquid.entries.length, 7); // plus one shared table = eight
assert.equal(engine.nativeDynamics.layout.entries.length, 3); assert.equal(V2_DYNAMICS_LAYOUT.length, 3);
engine.sync();
const resetRequests = commands.findIndex(c => c[0] === 'dispatch' && c[1] === 'v2externalEvents');
assert(resetRequests >= 0 && resetRequests < commands.findIndex(c => c[0] === 'dispatch' && c[1] === 'v2import'));
assert(v2ExternalEventsWGSL(g).includes('P.full != 0u || owned != 0u'));
assert(v2FluxWGSL(g).includes('(events[slotOf(pi)] | events[slotOf(pj)]) & 1u'));
assert(v2ColumnWGSL(g).includes('events[slotOf(p)] = events[slotOf(q)]'));
const imported = commands.find(c => c[0] === 'dispatch' && c[1] === 'v2import');
assert.equal(imported[2].bind[1], engine.groups.import); assert.equal(imported[2].bind[2], engine.groups.material);
engine.certified = true; assert.equal(engine.asleep, true); sim.version++; assert.equal(engine.asleep, false);
engine.sync();
// A paused retained-v2 capture during v1 must not consume v1's edit wake bit.
sim.compact = null; sim.version++;
await engine.captureState('v1');
const suspendedImport = commands.filter(c => c[0] === 'dispatch' && c[1] === 'v2import').at(-1);
assert.equal(suspendedImport[2].params.preserveLegacyMarks, 1);
assert.equal(suspendedImport[2].params.full, 0, 'capture does not force whole reimport or lose untouched fractional fill');
sim.compact = engine; sim.version++; engine.sync();
assert.equal(commands.filter(c => c[0] === 'dispatch' && c[1] === 'v2import').at(-1)[2].params.preserveLegacyMarks, 0);
engine.restore({}, {});
for (const buffer of [engine.liquidScratch, engine.jetMask, engine.events]) assert(commands.some(c => c[0] === 'clear' && c[1] === buffer));
const source = v2ImportWGSL(g); assert(source.includes('if (P.preserveLegacyMarks == 0u) { atomicAnd(&marks[MARK_ACT'), 'suspended imports retain legacy wake marks'); assert(source.indexOf('banks[s] = 0') < source.indexOf('if (any(n != c)'), 'equal cores still reset bank');
const limit = v2LimitWGSL(g); assert(!/cells\[s\]\.[xyzw]\s*=/.test(limit.slice(limit.indexOf('fn main'))), 'limiter never writes persistent core');
const gather = v2GatherWGSL(g); assert(gather.includes('w: atomic<u32>')); assert(gather.includes('atomicLoad(&cells[s].w)')); assert(gather.includes('atomicStore(&cells[s].w'));
const contact = v2BlockWGSL(g, 'fn contactBlock(c:ptr<function,array<vec4u,8>>,b:ptr<function,array<i32,8>>,p:array<vec3i,8>,r:ptr<function,array<u32,8>>) {}');
assert(contact.includes('contactBlock(&cs, &bs, positions, &requests);'));
engine.dispose(); for (const name of ['cells', 'aux', 'liquidScratch', 'jetMask', 'events', 'act', 'args']) assert(engine[name].destroyed);
const failedSim = { ...sim, version: 0, ready: Promise.reject(new Error('initial state failed')) };
const failedEngine = new PhysicsV2(failedSim);
await assert.rejects(failedEngine.ready, /initial state failed/);
assert.equal(failedEngine.isReady, false);
assert.equal(failedSim.version, 0);
failedEngine.dispose();
console.log(`native foundation: ${cases} conservative advection cases, 10000 exact wide products, packing/migration/driver ownership and rest checks passed`);

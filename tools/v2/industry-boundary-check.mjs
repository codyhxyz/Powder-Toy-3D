// CPU protocol checks. Execute the real controller and app methods with GPU/UI
// services stubbed. This is admission/cadence evidence: both engines run the
// machines (native transport itself: tools/v2/industry-native-check.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as catalog from '../../src/industry/catalog.js';
import * as validation from '../../src/industry/validation.js';
import * as controls from '../../src/industry/controlParts.js';
import { createProgression } from '../../src/industry/progression.js';
import { validateIndustryPhysics, controlCell } from '../../src/industry/physics.js';
import { E } from '../../src/elements.js';
import { nativeReadiness } from '../../src/v2/host.js';

const indexSource = readFileSync(new URL('../../src/industry/index.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const clone = value => structuredClone(value);
const noop = () => {};
function fixture(native, gamemode = 'factory') {
  const core = Uint32Array.of(0xdeadbeef, 0x89abcdef), bank = Uint32Array.of(0x81234567);
  const writes = [], notices = [];
  const owner = { isReady: true };
  const sim = { compact: native ? owner : null, compactOwner: owner,
    g: { nx: 128, ny: 128, nz: 128 }, frame: 17, canUndo: false };
  const write = name => { writes.push(name); core[0]++; bank[0]++; };
  let cargo = { version: 1, pumps: [] };
  const physics = {
    ready: Promise.resolve(), pending: false, reset: noop, dispose: noop,
    step: () => write('machinery'),
    nativeStep: devices => { if (devices.length) write('paid heat'); },
    toJSON: () => clone(cargo),
    fromJSON: data => { cargo = clone(data); },
  };
  const app = { sim, gamemode, settings: { preset: 'quarry' }, hover: { valid: false },
    toolbar: { setIndustry: noop, setUndoEnabled: noop }, dock: { setSpawnLocked: noop, setCollapsed: noop },
    hud: { toast: message => notices.push(message), dismissHint: noop }, canvas: {},
    requestRender: noop, leaveBuild: noop, isTyping: () => false };
  const create = vm.runInNewContext(
    indexSource.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\ncreateIndustry;',
    { ...catalog, ...validation, ...controls, E, validateIndustryPhysics, controlCell, createProgression,
      structuredClone, performance, crypto,
      addEventListener: noop, removeEventListener: noop, allLoads: () => new Map(),
      createIndustryPhysics: () => physics,
      createConstruction: () => ({ ready: Promise.resolve(), run: async () => { write('construction'); return true; } }),
      createGatePhysics: () => ({ pending: false, reset: noop, dispose: noop,
        step: () => write('gate'), remove: async () => { write('gate removal'); return { ok: true }; } }),
      createFactoryControlParts: () => ({ pending: false, reset: noop, dispose: noop,
        place: async () => { write('control part'); return { ok: true }; },
        toggle: async () => { write('switch'); return { ok: true }; } }),
      createIndustryDiagnostics: () => ({ reset: noop, dispose: noop }),
      createIndustryView: () => ({ update: noop, dispose: noop }),
    });
  const api = create(app);
  app.industry = api;
  api.reset({ starters: true });
  return { api, app, sim, physics, core, bank, writes, notices };
}

for (const mode of ['factory', 'sandbox']) {
  const f = fixture(true, mode), { api } = f;
  const before = clone(api.toJSON());
  assert.equal(api.hasMachines, true);
  assert.equal(api.state.active, true, `${mode}: V2 runs the machines`);
  assert.equal('unavailable' in api.state, false, 'no engine refusal is published');
  api.update(1 / 60, true);
  api.nativeStep();
  assert.deepEqual(f.writes, ['machinery', 'gate', 'paid heat'], `${mode}: native ticks drive machines, gates and paid heat`);
  const machine = before.devices[0];
  assert.equal(api.setDrive(machine.id, true).ok, true);
  const placed = await api.place({ type: 'belt', x: 88, y: 8, z: 88 });
  if (mode === 'factory') assert.equal(placed.ok, true, 'V2 Factory builds machines');
  else assert.equal(placed.ok, true, 'V2 Sandbox builds machines');
  assert.equal((await api.remove(placed.id)).ok, true, 'V2 dismantles machines');
  for (const result of [api.setGateMode(machine.id, 'open'), api.toggle(true)]) {
    assert.notEqual(result?.reason ?? '', 'Factory machines require V1 physics. V2 machine transport is not implemented.');
  }
  // Save and undo snapshots round-trip registrations and cargo under V2.
  api.fromJSON(before);
  assert.deepEqual(clone(api.toJSON()), before);
  assert.equal(f.notices.some(n => /V1|not implemented/.test(n)), false, `${mode}: no V1-required notice`);
  api.dispose();
}
console.log('PASS active native Factory/Sandbox admit and step machine work, and round-trip their saves');

{
  const f = fixture(false);
  assert(f.sim.compactOwner, 'retain the native owner after suspension');
  assert.equal(f.api.state.active, true, 'retained owner must not disable V1 Factory');
  assert.equal(f.api.setDrive(f.api.state.devices[0].id, true).ok, true);
  f.api.update(1 / 60, true);
  f.api.nativeStep();
  assert.deepEqual(f.writes, ['machinery', 'gate', 'paid heat']);
  f.api.dispose();
}
console.log('PASS suspended native owner retains V1 machine dispatch');

const statusStart = appSource.indexOf('  function v2Status()');
const statusEnd = appSource.indexOf('function v2Active()', statusStart);
const setterStart = appSource.indexOf('    async setPhysics(mode)');
const setterEnd = appSource.indexOf('    get physics()', setterStart);
assert(statusStart >= 0 && statusEnd > statusStart && setterStart >= 0 && setterEnd > setterStart);
assert(!appSource.includes('INDUSTRY_V2_UNAVAILABLE') && !appSource.includes('nativePhysicsRequested'), 'the app no longer gates Factory on the engine');
function appFixture({ pending = false, duringImport = false, factory = false } = {}) {
  const calls = [], notices = [];
  const context = vm.createContext({
    nativeReadiness, sim: { compactOwner: { isReady: true }, nativeCapabilities: { state: true } },
    win: null, pov: null, mp: { replica: false, isGuest: false },
    selectedMode: factory ? 'factory' : 'sandbox', physicsMode: 'v1', physicsChanging: false,
    ctx: { industry: { pending, hasMachines: factory } }, V2mod: null, physicsV2: null,
    hud: { toast: message => notices.push(message) },
    pacer: { wake: noop }, wakeLoop: noop, v2Running: false,
  });
  context.loadNativePhysics = async () => {
    calls.push('import');
    if (duringImport) context.ctx.industry.pending = true;
    return { PhysicsV2: class {
      constructor(sim) { calls.push('construct'); sim.compact = sim.compactOwner = this; this.isReady = true; }
      activate() { calls.push('activate'); }
    }, options: {} };
  };
  context.sim.prepareNative = async () => { calls.push('prepare native'); };
  context.sim.prepareLegacy = async () => { throw new Error('No legacy fallback'); };
  context.v2Box = () => context.physicsMode === 'v2';
  vm.runInContext(appSource.slice(statusStart, statusEnd), context);
  const setPhysics = vm.runInContext(`({${appSource.slice(setterStart, setterEnd)}}).setPhysics`, context);
  return { context, calls, notices, setPhysics };
}

for (const options of [{ pending: true }, { duringImport: true }]) {
  const f = appFixture(options);
  await assert.rejects(f.setPhysics('v2'), /Wait for the machine transfer/);
  assert.equal(f.context.physicsMode, 'v1');
  assert.equal(f.context.physicsV2, null);
  assert.equal(f.context.physicsChanging, false, 'failed admission releases the engine-change lock');
  assert.deepEqual(f.calls, options.pending ? [] : ['import']);
}
console.log('PASS app refuses engine activation before and after an asynchronous machine-transfer race');

{
  const f = fixture(false), transition = appFixture({ factory: true });
  const before = clone(f.api.toJSON());
  let entered, release;
  const prepared = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const owner = f.sim.compactOwner;
  owner.ready = Promise.resolve();
  owner.activate = () => { f.sim.compact = owner; };
  f.sim.nativeCapabilities = { state: true };
  f.sim.prepareNative = async () => { entered(); await gate; };
  transition.context.sim = f.sim;
  transition.context.physicsV2 = owner;
  transition.context.V2mod = {};
  transition.context.ctx.industry = f.api;
  assert.equal(f.api.state.active, true, 'stable V1 with a retained owner admits machine work');
  const activation = transition.setPhysics('v2');
  try {
    await prepared;
    assert.equal(f.sim.compact, null, 'retained owner has not activated yet');
    assert.equal(transition.context.physicsMode, 'v2', 'requested mode is already published');
    await assert.rejects(transition.setPhysics('v1'), /current physics change/);
    // Admission stays open: a dismantle now is a captured edit the owner imports on activation.
    const removal = await f.api.remove(before.devices[0].id);
    assert.equal(removal.ok, true, 'machines stay usable while V2 prepares');
    assert.deepEqual(f.writes, ['construction']);
  } finally {
    release();
    await activation;
    assert.equal(transition.context.physicsChanging, false);
  }
  assert.equal(f.sim.compact, owner);
  assert.equal(f.api.state.active, true, 'V2 keeps the Factory running after activation');
  f.api.update(1 / 60, true);
  assert.deepEqual(f.writes, ['construction', 'machinery', 'gate']);
  f.api.dispose();
}
console.log('PASS real app/controller keeps machines admitted through V2 activation');


{
  const f = appFixture();
  f.context.sim.prepareNative = async () => { throw new Error('preparation failed'); };
  await assert.rejects(f.setPhysics('v2'), /preparation failed/);
  assert.equal(f.context.physicsChanging, false, 'failed preparation must not leave an admission lock');
}
console.log('PASS failed preparation releases engine-change serialization');

{
  const f = appFixture({ factory: true });
  await f.setPhysics('v2');
  assert.equal(f.context.physicsMode, 'v2');
  assert.equal(f.context.v2Status().ready, true, 'a Factory with machines runs on V2');
  assert.deepEqual(f.notices, [], 'no V1-required toast');
  f.context.selectedMode = 'sandbox';
  assert.equal(f.context.v2Status().ready, true, 'registered Sandbox machines run on V2 too');
  f.context.ctx = undefined;
  assert.equal(f.context.v2Status().ready, true, 'picker readiness runs before wires attach');
}
console.log('PASS app reports Factory and Sandbox machines ready on V2 with no refusal notice');


{
  const source = readFileSync(new URL('../../src/wire/saves.js', import.meta.url), 'utf8');
  const start = source.indexOf('      header: () => {');
  const end = source.indexOf('      thumbnail:', start);
  assert(start >= 0 && end > start);
  for (const mode of ['factory', 'sandbox']) {
    const f = fixture(true, mode);
    f.app.physics = { v2: null };
    f.app.mp = { isGuest: false };
    const header = vm.runInNewContext(`({${source.slice(start, end)}}).header()`,
      { app: f.app, settings: f.app.settings, mapOf: () => ({ key: 'quarry', name: 'Quarry' }) });
    assert.equal(f.api.state.active, true);
    assert.equal(header.industryMode, mode, 'a V2 save keeps its Factory/Sandbox mode');
    f.api.dispose();
  }
}
console.log('PASS real save header keeps V2 Factory/Sandbox metadata');

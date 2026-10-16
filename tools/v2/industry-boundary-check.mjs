// CPU protocol checks. Execute the real controller and app methods with GPU/UI
// services stubbed. This is refusal/cadence evidence, not Factory physics proof.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as catalog from '../../src/industry/catalog.js';
import * as validation from '../../src/industry/validation.js';
import * as controls from '../../src/industry/controlParts.js';
import { createProgression } from '../../src/industry/progression.js';
import { validateIndustryPhysics, controlCell } from '../../src/industry/physics.js';
import { E } from '../../src/elements.js';
import { nativeReadiness, INDUSTRY_V2_UNAVAILABLE } from '../../src/v2/host.js';

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
      INDUSTRY_V2_UNAVAILABLE, structuredClone, performance, crypto,
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
  const before = clone(api.toJSON()), core = f.core.slice(), bank = f.bank.slice();
  assert.equal(api.hasMachines, true);
  assert.equal(api.state.active, false);
  assert.equal(api.state.unavailable, INDUSTRY_V2_UNAVAILABLE);
  api.update(1 / 60, true);
  api.nativeStep();
  const machine = before.devices[0];
  const results = [
    await api.place({ type: 'belt', x: 88, y: 8, z: 88 }),
    await api.remove(machine.id), api.setDrive(machine.id, true),
    api.setGateMode(machine.id, 'open'), api.selectPart('TSNS'),
    api.setThreshold(500), api.toggleInspect(true), await api.toggleControl(),
    await api.placeControlPart({ x: 80, y: 8, z: 80 }), api.toggle(true),
  ];
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal(result.reason, INDUSTRY_V2_UNAVAILABLE);
  }
  // Registration/cargo restore is still allowed: loading must not discard
  // exact escrow merely because its machine operation is unsupported.
  api.fromJSON(before);
  assert.deepEqual(clone(api.toJSON()), before);
  assert.deepEqual(f.core, core);
  assert.deepEqual(f.bank, bank);
  assert.deepEqual(f.writes, [], `${mode}: no machine GPU work`);
  assert.equal(f.sim.frame, 17);
  api.dispose();
}
console.log('PASS active native Factory/Sandbox refuse machine work without changing registrations, core or bank');

{
  const f = fixture(false);
  assert(f.sim.compactOwner, 'retain the native owner after suspension');
  assert.equal(f.api.state.active, true, 'retained owner must not disable V1 Factory');
  assert.equal(f.api.state.unavailable, null);
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
function appFixture({ pending = false, duringImport = false, factory = false } = {}) {
  const calls = [], notices = [];
  const context = vm.createContext({
    nativeReadiness, sim: { compactOwner: { isReady: true }, nativeCapabilities: { state: true } },
    win: null, pov: null, mp: { replica: false, isGuest: false },
    selectedMode: factory ? 'factory' : 'sandbox', physicsMode: 'v1',
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
  assert.deepEqual(f.calls, options.pending ? [] : ['import']);
}
console.log('PASS app refuses engine activation before and after an asynchronous machine-transfer race');

{
  const f = appFixture({ factory: true });
  await f.setPhysics('v2');
  assert.equal(f.context.physicsMode, 'v2', 'unsupported native state never silently falls back');
  assert.equal(f.context.v2Status().ready, false);
  assert.deepEqual(f.notices, [INDUSTRY_V2_UNAVAILABLE]);
  f.context.selectedMode = 'sandbox';
  assert.equal(f.context.v2Status().ready, false, 'registered Sandbox machines also block native stepping');
  f.context.ctx.industry.hasMachines = false;
  assert.equal(f.context.v2Status().ready, true);
  f.context.ctx = undefined;
  assert.equal(f.context.v2Status().ready, true, 'picker readiness runs before wires attach');
}
console.log('PASS app publishes explicit unavailable status, preserves requested engine and handles early readiness');

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
    assert.equal(f.api.state.active, false);
    assert.equal(header.industryMode, mode, 'unavailable operation does not erase saved mode');
    f.api.dispose();
  }
}
console.log('PASS real save header retains unsupported Factory/Sandbox metadata');

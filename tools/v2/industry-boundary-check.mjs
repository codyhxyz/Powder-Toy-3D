// CPU protocol checks. Execute the real controller and app methods with GPU/UI
// services stubbed. This is admission/cadence evidence: V2 (the only engine) runs the
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
  const retags = [];
  const sim = { compact: native ? owner : null, compactOwner: owner,
    g: { nx: 128, ny: 128, nz: 128 }, frame: 17, canUndo: false,
    editKernel: name => ({ name, main: { state: 'ready' } }), edit: (kernel, box, values) => retags.push({ kernel: kernel.name, box, values, at: writes.length }) };
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
    hud: { toast: message => notices.push(message) }, canvas: {},
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
  return { api, app, sim, physics, core, bank, writes, notices, retags };
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

const statusStart = appSource.indexOf('  function v2Status()');
const statusEnd = appSource.indexOf('function v2Active()', statusStart);
assert(statusStart >= 0 && statusEnd > statusStart);
assert(!appSource.includes('setPhysics'), 'no runtime engine switch: V2 is the only engine');
assert(!appSource.includes('INDUSTRY_V2_UNAVAILABLE') && !appSource.includes('nativePhysicsRequested'), 'the app no longer gates Factory on the engine');
function appFixture({ pending = false, duringImport = false, factory = false } = {}) {
  const calls = [], notices = [];
  const context = vm.createContext({
    nativeReadiness, sim: { compactOwner: { isReady: true }, nativeCapabilities: { state: true } },
    win: null, pov: null, mp: { replica: false, isGuest: false },
    selectedMode: factory ? 'factory' : 'sandbox',
    ctx: { industry: { pending, hasMachines: factory } }, V2mod: null, physicsV2: null,
    hud: { toast: message => notices.push(message) },
    pacer: { wake: noop }, wakeLoop: noop, v2Running: false,
  });
  vm.runInContext(appSource.slice(statusStart, statusEnd), context);
  return { context, calls, notices };
}

{
  const f = appFixture({ factory: true });
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

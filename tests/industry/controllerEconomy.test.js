import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { E } from '../../src/elements.js';
import { DEVICE_TYPES } from '../../src/industry/catalog.js';
import { createProgression } from '../../src/industry/progression.js';
import { deviceSpec } from '../../src/industry/validation.js';
import { controlCell, machineGuard, createIndustryPhysics } from '../../src/industry/physics.js';

const hooks = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { createIndustry, validateIndustrySave } = await import('../../src/industry/index.js');
hooks.deregister();

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
  nodeType = 1; children = []; attributes = {}; dataset = {}; events = {}; className = '';
  style = { setProperty() {} };
  classList = {
    add: name => this.classList.toggle(name, true),
    toggle: (name, on) => {
      const names = new Set(this.className.split(' ').filter(Boolean));
      on ? names.add(name) : names.delete(name); this.className = [...names].join(' ');
    },
  };
  getAttribute(key) { return this.attributes[key] ?? null; }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = document.body; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value);
  }
  addEventListener(name, fn) { this.events[name] = fn; }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(s => s.trim().match(/^\w+(?:\[[\w-]+(?:="[^"]*")?\])?$/));
    const found = [];
    const visit = node => { for (const child of node.children ?? []) { found.push(child); visit(child); } };
    visit(this); return found;
  }
  remove() {}
}

globalThis.document = { body: new Element(), createElement: tag => new Element(tag),
  createTextNode: text => ({ nodeType: 3, textContent: text }) };
globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, INDIRECT: 4 };
const listeners = new Map();
globalThis.addEventListener = (name, fn) => listeners.set(name, fn);
globalThis.removeEventListener = (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); };
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('timed out waiting for a mocked Industry operation');
};
const grid = { nx: 128, ny: 128, nz: 128 };
function deferred() {
  let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve };
}
function fixture(mode = 'factory') {
  const calls = [], pendingReads = [], edits = [], toasts = [];
  const gpu = {
    three: { prepare: async () => {} }, layout: () => ({}), createBuffer: () => ({}), bindGroup: () => ({}), flush() {},
    kernel: spec => ({ name: spec.name, ready: Promise.resolve(), state: 'ready' }),
    readback: { ring(name) {
      let nextSlot = 0; const slots = new Map();
      return { buffer: {}, next() { const slot = nextSlot++; slots.set(slot, deferred()); return slot; },
        read(slot) {
          if (name === 'industry construction') return Promise.resolve(new Float32Array([1, 0, 0, 0]).buffer);
          const entry = slots.get(slot); pendingReads.push({ name, resolve: entry.resolve }); return entry.promise;
        } };
    } },
  };
  const sim = {
    gpu, g: grid, L: { TABLES: [], STATE_RW: [], STATE_RO: [] }, tables: {}, bindRW: {}, bindRO: {}, version: 0, frame: 0,
    header: () => ({}), wake() {}, editKernel: () => ({ ready: Promise.resolve() }), edit: (...args) => edits.push(args),
    _dispatch(kernel, _size, { params }) { calls.push({ name: kernel.name, params }); },
  };
  const app = { sim, gpu, gamemode: mode, settings: { preset: 'quarry' }, win: null, scale: 1,
    canvas: new Element('canvas'), scene: new THREE.Group(), volume: { position: new THREE.Vector3() },
    hud: { toast: text => toasts.push(text), dismissHint() {} }, requestRender() {}, leaveBuild() {},
    dock: { setCollapsed() {}, setSpawnLocked() {} }, toolbar: { setUndoEnabled() {}, setIndustry() {} }, isTyping: () => false,
    pov: { active: false, player: { pos: { x: 10, y: 8, z: 10 } }, worldReplaced() {} }, hover: { valid: false } };
  const industry = app.industry = createIndustry(app);
  if (mode === 'factory') industry.reset({ starters: true });
  function answer(name, values) {
    const index = pendingReads.findIndex(read => read.name === name);
    assert.notEqual(index, -1, `no pending ${name} readback`);
    const [{ resolve }] = pendingReads.splice(index, 1);
    const bytes = new Float32Array(Math.max(4, values.length)); bytes.set(values); resolve(bytes.buffer);
  }
  return { app, industry, calls, pendingReads, edits, toasts, answer };
}
const partCalls = f => f.calls.filter(call => call.name === 'industryFactoryControlParts');
const gateCalls = f => f.calls.filter(call => call.name === 'industryGate');
const findNode = (node, predicate) => predicate(node) ? node
  : node.children?.map(child => findNode(child, predicate)).find(Boolean);

test('actual controller keeps part placement and inspection controls visible', async () => {
  const f = fixture(); await settle();
  const panel = document.body.children.at(-1);
  const node = className => findNode(panel, element => element.className === className);
  f.industry.selectPart('TSNS');
  f.app.hover = { valid: true, cell: { x: 80, y: 40, z: 80 }, face: 2, id: -1 };
  f.industry.update(0, false);
  assert.equal(f.industry.state.building, true);
  assert.equal(node('industry-builder').hidden, false, 'selecting a part must not hide the threshold and Done controls');
  assert.equal(node('industry-threshold').hidden, false);
  assert.equal(f.app.scene.getObjectByName('industry-part-ghost').visible, true);
  f.industry.toggleInspect(true); f.industry.update(0, false);
  assert.equal(node('industry-builder').hidden, false, 'inspection actions must remain accessible');
  assert.equal(f.app.scene.getObjectByName('industry-part-ghost').visible, false);
  f.industry.dispose();
});

test('standalone sensor inspection stays pinned when the cursor moves to the panel', async () => {
  const f = fixture(); await settle();
  const panel = document.body.children.at(-1);
  const cell = { x: 127, y: 40, z: 127 };
  f.app.hover = { valid: true, cell, face: 2, id: E.TSNS };
  f.industry.toggleInspect(true);
  listeners.get('pointerdown')({ target: f.app.canvas, button: 0, type: 'pointerdown',
    preventDefault() {}, stopImmediatePropagation() {} });
  await waitFor(() => f.pendingReads.some(read => read.name === 'industry diagnostics'));
  const values = new Float32Array(36);
  values.set([0, 0, 0, 1]);
  values.set([1, 1, 200, 200], 4); // standalone controlPart0 identifies TSNS
  f.answer('industry diagnostics', [...values]);
  await waitFor(() => f.industry.state.inspection?.controlPart?.type === 'TSNS');
  f.app.hover.valid = false; f.industry.update(0, false);
  assert.equal(f.industry.state.inspection.device, null, 'an electrical cell is not a registered machine');
  assert.equal(f.industry.state.inspection.controlPart.threshold, 200);
  assert.equal(findNode(panel, element => element.className === 'industry-inspection').hidden, false);
  assert.match(findNode(panel, element => element.className === 'industry-control-part-label').textContent, /threshold 200°C/);
  assert.equal(f.industry.state.devices.length, 4, 'inspection clicks cannot construct a machine');
  f.industry.dispose();
});

test('canvas placement releases threshold focus so Escape and Q still work', async () => {
  const f = fixture(); await settle();
  const panel = document.body.children.at(-1);
  const input = findNode(panel, element => element.className === 'industry-threshold-input');
  f.app.isTyping = () => document.activeElement?.tagName === 'INPUT';
  f.app.hover = { valid: true, cell: { x: 80, y: 40, z: 80 }, face: 2, id: -1 };
  for (const code of ['Escape', 'KeyQ']) {
    f.industry.selectPart('TSNS'); f.industry.update(0, false); input.focus();
    assert.equal(f.app.isTyping(), true);
    const before = partCalls(f).length;
    listeners.get('pointerdown')({ target: f.app.canvas, button: 0, type: 'pointerdown',
      preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(f.app.isTyping(), false);
    await waitFor(() => partCalls(f).length > before);
    f.answer('industry factory control parts', [2, E.TSNS, 200, 0]); await settle();
    const event = { code, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
    listeners.get('keydown')(event);
    assert.equal(event.prevented, true);
    assert.equal(f.industry.state.part, null);
    assert.equal(f.industry.state.building, false);
  }
  f.industry.dispose();
});

test('inspection does not capture driving input and resumes after leaving the vehicle', async () => {
  const f = fixture(); await settle();
  f.industry.toggleInspect(true);
  f.app.pov.vehicles = { seated: { kind: 'boat' } };
  f.industry.update(0, false);
  const event = { target: f.app.canvas, button: 0, type: 'pointerdown',
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  listeners.get('pointerdown')(event);
  assert.equal(event.prevented, undefined);
  assert.equal(event.stopped, undefined);
  const escape = { code: 'Escape', preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
  listeners.get('keydown')(escape);
  assert.equal(escape.prevented, undefined);
  assert.equal(f.industry.state.building, false);
  f.app.pov.vehicles.seated = null; f.industry.update(0, false);
  assert.equal(f.industry.state.building, true);
  assert.equal(f.industry.state.inspectMode, true);
  f.industry.dispose();
});

test('partsSpent migrates old saves, validates equity, and prices metal above its shipment value', () => {
  let p = createProgression();
  const legacy = p.snapshot(); delete legacy.partsSpent;
  p = createProgression(legacy);
  assert.equal(p.snapshot().partsSpent, 0);
  assert.equal(p.buyPart('METAL').ok, true);
  const afterBuy = p.snapshot();
  assert.equal(afterBuy.credits, 19);
  assert.equal(afterBuy.partsSpent, 5);
  assert.equal(p.ship({ id: E.METAL, count: 1, temperature: 400 }).ok, true);
  const afterShip = p.snapshot();
  assert.equal(afterShip.credits, 23, 'a 4-credit shipment cannot recover the 5-credit metal purchase');
  assert.equal(afterShip.partsSpent, 5);
  const assets = Object.entries(afterShip.owned).reduce((sum, [type, count]) => sum + count * DEVICE_TYPES[type].cost, 0);
  assert.equal(afterShip.credits + assets + afterShip.partsSpent, 50 + afterShip.earned);
  assert.deepEqual(createProgression(afterShip).snapshot(), afterShip);
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createProgression({ ...afterShip, partsSpent: invalid }), /progression save/);
  }
  const inconsistent = { ...afterShip, partsSpent: 4 };
  assert.throws(() => createProgression(inconsistent), /economy/);
});

test('gate ports are validated and Factory drive is opt-in rather than banned', async () => {
  assert.throws(() => deviceSpec({ type: 'gate', x: 0, y: 4, z: 4 }, [128, 128, 128]), /control port/);
  assert.equal(deviceSpec({ type: 'gate', x: 4, y: 4, z: 4 }, [128, 128, 128]).gateMode, 'open');
  const f = fixture(); await settle();
  const built = await f.industry.place({ type: 'belt', x: 8, y: 32, z: 8, powered: true });
  assert.equal(built.ok, true);
  assert.equal(f.industry.state.devices.find(d => d.id === built.id).powered, true);
  assert.equal(f.industry.state.devices.find(d => d.id === 'starter-belt').powered, false);
  assert.equal(f.industry.setDrive('starter-belt', true).ok, true);
  assert.equal(f.industry.state.devices.find(d => d.id === 'starter-belt').powered, true);
  assert.equal(machineGuard(f.industry.state.devices.find(d => d.id === 'starter-belt')).powered, true,
    'the opt-in machine drive selects the existing native signal guard');
  f.industry.dispose();
});

test('confirmed part purchases debit fixed whitelist prices; occupied, pending, and stale writes do not charge', async () => {
  const f = fixture(); await settle();
  assert.equal(f.industry.selectPart('TSNS').ok, true);
  const failed = f.industry.placeControlPart({ x: 12, y: 32, z: 12, cost: 0 });
  await waitFor(() => partCalls(f).length === 1);
  assert.equal(f.industry.state.progression.credits, 24, 'reserve but do not debit before confirmation');
  assert.equal((await f.industry.placeControlPart({ x: 16, y: 32, z: 12 })).ok, false, 'overlapping placement is serialized');
  f.answer('industry factory control parts', [2, E.SWITCH, 20, 0]);
  assert.equal((await failed).ok, false, 'occupied empty-only backend rejection is not charged');
  assert.equal(f.industry.state.progression.partsSpent, 0);

  const bought = f.industry.placeControlPart({ x: 12, y: 32, z: 12, cost: 0 });
  await waitFor(() => partCalls(f).length === 2);
  f.answer('industry factory control parts', [1, E.TSNS, 200, 0]);
  assert.deepEqual(await bought, { ok: true, reason: '', key: 'TSNS', material: E.TSNS, cost: 3,
    x: 12, y: 32, z: 12, threshold: 200 });
  assert.equal(f.industry.state.progression.credits, 21);
  assert.equal(f.industry.state.progression.partsSpent, 3);
  const paidSave = f.industry.toJSON();
  assert.equal(paidSave.progression.partsSpent, 3);
  validateIndustrySave(paidSave, [128, 128, 128], 'quarry');

  const stale = f.industry.placeControlPart({ x: 20, y: 32, z: 12 });
  await waitFor(() => partCalls(f).length === 3);
  f.industry.reset({ starters: true });
  f.answer('industry factory control parts', [1, E.TSNS, 200, 0]);
  assert.equal((await stale).ok, false);
  assert.equal(f.industry.state.progression.credits, 24);
  assert.equal(f.industry.state.progression.partsSpent, 0, 'old epoch callback cannot charge the replacement scene');
  f.industry.dispose();
});

test('no-credit part purchases never dispatch; TSNS thresholds clamp only during placement', async () => {
  const f = fixture(); await settle();
  for (let i = 0; i < 12; i++) {
    const result = await f.industry.place({ type: 'belt', x: i * 4, y: 40, z: 4 });
    assert.equal(result.ok, true);
  }
  assert.equal(f.industry.state.progression.credits, 0);
  f.industry.selectPart('TSNS');
  assert.equal(f.industry.setThreshold(20000).threshold, 10000);
  assert.equal(f.industry.setThreshold(-500).threshold, -273.15);
  assert.equal(f.industry.setThreshold(NaN).ok, false);
  f.industry.selectPart('METAL');
  assert.equal(f.industry.setThreshold(200).ok, false);
  const calls = partCalls(f).length;
  assert.equal((await f.industry.placeControlPart({ x: 80, y: 40, z: 4 })).ok, false);
  assert.equal(partCalls(f).length, calls, 'insufficient credits are rejected before GPU dispatch');
  f.industry.dispose();
});

test('one-cell candidates use exact port coordinates and confirmed inspection selects/toggles a real SWITCH', async () => {
  const f = fixture(); await settle();
  const belt = f.industry.state.devices.find(d => d.id === 'starter-belt');
  const port = controlCell(belt);
  f.industry.selectPart('SWITCH');
  f.app.hover = { valid: true, cell: { x: port[0], y: port[1], z: port[2] }, face: 2, id: E.TUNGSTEN };
  f.industry.update(0, false);
  assert.deepEqual(f.industry.state.partCandidate, { x: port[0], y: port[1] + 1, z: port[2], type: 'SWITCH', threshold: null });
  // An empty-face hover uses the exact cell without four-cell snapping.
  f.app.hover.id = -1;
  f.industry.update(0, false);
  assert.deepEqual(f.industry.state.partCandidate, { x: port[0], y: port[1], z: port[2], type: 'SWITCH', threshold: null });
  const placed = f.industry.placeControlPart({ x: port[0], y: port[1], z: port[2] });
  await waitFor(() => partCalls(f).length === 1);
  f.answer('industry factory control parts', [1, E.SWITCH, 20, 0]);
  assert.equal((await placed).ok, true);
  const credits = f.industry.state.progression.credits;

  f.industry.toggleInspect(true);
  f.industry.update(0, false);
  await waitFor(() => f.pendingReads.some(read => read.name === 'industry diagnostics'));
  const values = new Float32Array(36);
  values.set([16, 1, 1, 1], 0); // all 16 registered base cells; energized native port
  values[3] = 1;
  // Region order is work, then the five one-cell control-material code probes.
  values[3 * 4 + 1] = 1; // controlPart1 identifies SWITCH
  f.answer('industry diagnostics', [...values]);
  await waitFor(() => f.industry.state.inspection?.controlPart?.type === 'SWITCH');
  assert.equal(f.industry.state.inspection.controlPart.on, true);
  const toggling = f.industry.toggleControl();
  await waitFor(() => partCalls(f).length === 2);
  assert.equal(partCalls(f)[1].params.mode, 1, 'toggle invokes the native SWITCH backend action');
  f.answer('industry factory control parts', [1, E.SWITCH, 20, 0]);
  assert.deepEqual(await toggling, { ok: true, reason: '', on: false });
  assert.equal(f.industry.state.inspection.controlPart.on, false);
  assert.equal(f.industry.state.progression.credits, credits, 'switch toggles are not purchases');
  f.industry.dispose();
});

test('gate transitions block save/restore/remove and shutter removal precedes base dismantling', async () => {
  const f = fixture(); await settle();
  const built = await f.industry.place({ type: 'gate', x: 12, y: 32, z: 12 });
  assert.equal(built.ok, true);
  assert.equal(f.industry.setGateMode(built.id, 'closed').ok, true);
  f.industry.update(1 / 60, true);
  await waitFor(() => gateCalls(f).length === 1);
  assert.throws(() => f.industry.toJSON(), /transferring matter/);
  assert.throws(() => f.industry.fromJSON({}), /current machine transfer/);
  assert.equal((await f.industry.remove(built.id)).ok, false);
  f.answer('industry gate', [2, 1, 1, 1]);
  await waitFor(() => f.industry.state.devices.find(d => d.id === built.id)?.gateClosed === true);
  await waitFor(() => f.industry.pending === false);
  const removing = f.industry.remove(built.id);
  await waitFor(() => gateCalls(f).length === 2);
  assert.equal(gateCalls(f)[1].params.operation, 1);
  assert.throws(() => f.industry.toJSON(), /transferring matter/);
  f.answer('industry gate', [1, 0, 1, 0]);
  assert.equal((await removing).ok, true);
  const gateRemovalIndex = f.calls.findIndex(call => call.name === 'industryGate' && call.params.operation === 1);
  const baseRemovalIndex = f.calls.findIndex(call => call.name === 'industryConstruction' && call.params.mode === 2);
  assert.ok(gateRemovalIndex >= 0 && baseRemovalIndex > gateRemovalIndex, 'owned shutter is opened before its base is dismantled');
  assert.equal(f.industry.state.devices.some(d => d.id === built.id), false);
  f.industry.dispose();
});

test('inspection has explicit pending/no-hover state and discards stale results', async () => {
  const f = fixture(); await settle();
  const d = f.industry.state.devices.find(d => d.id === 'starter-belt');
  f.app.hover = { valid: true, cell: { x: d.x, y: d.y, z: d.z }, face: 2, id: E.TUNGSTEN };
  f.industry.toggleInspect(true); f.industry.update(0, false);
  await waitFor(() => f.pendingReads.some(read => read.name === 'industry diagnostics'));
  f.industry.update(0, false);
  assert.equal(f.industry.state.inspection.observation.freshness, 'pending');
  f.app.hover.valid = false; f.industry.update(0, false);
  assert.equal(f.industry.state.inspection, null);
  const diagnostics = new Float32Array(36); diagnostics.set([16, 0, 0, 1]);
  f.answer('industry diagnostics', [...diagnostics]); await settle();
  assert.equal(f.industry.state.inspection, null, 'unhovered result cannot restore stale inspection');

  const other = f.industry.state.devices.find(d => d.id === 'starter-sorter');
  f.app.hover = { valid: true, cell: { x: other.x, y: other.y, z: other.z }, face: 2, id: E.TUNGSTEN };
  f.industry.update(0, false);
  await waitFor(() => f.pendingReads.some(read => read.name === 'industry diagnostics'));
  f.app.hover.valid = false;
  f.app.sim = { ...f.app.sim }; // replacement identity while the readback is still pending
  f.industry.update(0, false);
  assert.equal(f.industry.state.inspection, null);
  f.answer('industry diagnostics', [...diagnostics]); await settle();
  assert.equal(f.industry.state.inspection, null, 'old-simulation readback cannot publish after replacement');
  f.industry.dispose();
});

test('physics exposes only the exact ship target and records confirmed physical transfers', async () => {
  const f = fixture(), shipments = [], transfers = [];
  const physics = createIndustryPhysics({ getSim: () => f.app.sim,
    onShip: event => shipments.push(event), onTransfer: event => transfers.push(event) });
  await physics.ready;
  const ship = { id: 'test-intake', type: 'ship', x: 8, y: 8, z: 8, rotation: 0 };
  assert.equal(physics.expectedShipId(ship.id), E.NUGGETS);
  physics.step(.1, [ship]); physics.step(.05, [ship]);
  await waitFor(() => f.pendingReads.some(read => read.name === 'pov transfer'));
  assert.equal(physics.expectedShipId(ship.id), E.NUGGETS, 'in-flight target does not expose the next alternate');
  const cells = new Float32Array(48 * 4); cells.fill(-1);
  cells.set([E.NUGGETS, 20, 0, .25], 0);
  f.answer('pov transfer', [...cells]);
  await waitFor(() => transfers.length === 1);
  assert.deepEqual(shipments, [{ id: E.NUGGETS, count: 1, temperature: 20 }]);
  assert.equal(transfers[0].confirmed, true);
  assert.equal(transfers[0].operation, 'ship');
  assert.equal(transfers[0].count, 1);
  assert.equal(transfers[0].device.id, ship.id);
  assert.equal(physics.expectedShipId(ship.id), E.METAL, 'next alternating target follows the confirmed operation');
  physics.dispose(); f.industry.dispose();
});

test('save validation round-trips partsSpent while accepting pre-ledger saves', async () => {
  const f = fixture(); await settle();
  const saved = f.industry.toJSON();
  assert.equal(saved.progression.partsSpent, 0);
  validateIndustrySave(saved, [128, 128, 128], 'quarry');
  delete saved.progression.partsSpent;
  validateIndustrySave(saved, [128, 128, 128], 'quarry');
  assert.equal(createProgression(saved.progression).snapshot().partsSpent, 0);
  f.industry.dispose();
});

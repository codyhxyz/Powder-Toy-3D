// CPU-only Factory UI contract checks; no browser, server, or GPU.
// node scripts/check-industry-factory-ui.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from 'three';

const hooks = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { createIndustryView } = await import('../src/industry/view.js');
const {
  SENSOR_THRESHOLD_DEFAULT, SENSOR_THRESHOLD_MAX, SENSOR_THRESHOLD_MIN,
  createOperationsView, FACTORY_PARTS, presentFactoryObservation, presentGateResult, validSensorThreshold,
} = await import('../src/industry/operationsView.js');
const { DEVICE_TYPES } = await import('../src/industry/catalog.js');
const { CONTROL_PARTS } = await import('../src/industry/controlParts.js');
hooks.deregister();

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
  nodeType = 1;
  children = [];
  attributes = {};
  dataset = {};
  style = { setProperty() {} };
  className = '';
  hidden = false;
  disabled = false;
  value = '';
  append(...items) { this.children.push(...items); }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value);
  }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener() {}
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  remove() { this.removed = true; }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = document.body; }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    const found = [];
    const visit = parent => {
      for (const child of parent.children ?? []) {
        const match = selectors.some(item => {
          const parsed = item.match(/^([\w-]+)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
          return parsed && child.tagName === parsed[1].toUpperCase()
            && (!parsed[2] || child.getAttribute(parsed[2]) !== null
              && (parsed[3] === undefined || child.getAttribute(parsed[2]) === parsed[3]));
        });
        if (match) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

globalThis.document = {
  body: new Element('body'),
  activeElement: null,
  createElement: tag => new Element(tag),
};
document.activeElement = document.body;
const find = (node, predicate) => predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean);
const buttons = (node, attr, value) => find(node, child => child.getAttribute?.(attr) === value);
const machineTypes = Object.keys(DEVICE_TYPES).filter(type => !DEVICE_TYPES[type].factoryLegacy);
const calls = [];
const app = {
  scene: new THREE.Group(),
  gpu: { three: { prepare: async () => {} } },
  scale: 1,
  volume: { position: new THREE.Vector3() },
  requestRender() {},
  hud: { toast(message) { throw new Error(message); } },
};
const actions = {
  canBuild: () => ({ ok: true }),
  select: key => calls.push(['select', key]),
  toggle: () => calls.push(['toggle']),
  filter: value => calls.push(['filter', value]),
  rotate: () => calls.push(['rotate']),
  remove: () => calls.push(['remove']),
  cancel: () => calls.push(['cancel']),
  selectPart: key => calls.push(['selectPart', key]),
  setThreshold: value => calls.push(['setThreshold', value]),
  toggleInspect: () => calls.push(['toggleInspect']),
  setDrive: (id, on) => calls.push(['setDrive', id, on]),
  setGateMode: (id, mode) => calls.push(['setGateMode', id, mode]),
  toggleControl: (...args) => calls.push(['toggleControl', ...args]),
};
const view = createIndustryView(app, actions);
const progression = {
  credits: 300, goal: 'Stage 1: release coal', hint: 'Release a fuel batch through a physical gate.',
  stage: 0, earned: 0, delivered: { metal: 0 }, unlocked: machineTypes,
};
const heater = { id: 'saved-heater', type: 'heater', x: 8, y: 4, z: 8, rotation: 0, powered: true };
const hearth = { id: 'hearth-1', type: 'hearth', x: 16, y: 4, z: 8, rotation: 0, powered: false };
const gate = { id: 'gate-1', type: 'gate', x: 24, y: 4, z: 8, rotation: 0, powered: false, gateMode: 'signal', gateClosed: true };
const state = {
  active: true, factory: true, building: true, selected: 'hearth', rotation: 0,
  filter: 1, dismantling: false, pending: false, progression,
  devices: [heater, hearth, gate], part: null, partThreshold: SENSOR_THRESHOLD_DEFAULT,
  inspectMode: false, inspection: null, partCandidate: null,
};
const candidate = { type: 'belt', x: 32, y: 4, z: 8, rotation: 0, powered: false };
const tick = (nextState = state, nextCandidate = candidate, result = { ok: true }) => view.update(nextState, nextCandidate, result, 0);
await Promise.resolve();
tick();
const panel = document.body.children.at(-1);
const machineButton = type => buttons(panel, 'data-machine', type);
const classNode = className => find(panel, element => element.className === className);

// Hearth and gate are placeable with distinct, visible guidance; legacy heater remains render-only.
assert.equal(machineButton('hearth')?.tagName, 'BUTTON');
assert.equal(machineButton('gate')?.tagName, 'BUTTON');
assert.equal(machineButton('heater'), undefined, 'legacy heater is absent from new placement choices');
assert.match(classNode('industry-tip').textContent, /fuel goes in the rear inside row/i);
assert.match(classNode('industry-tip').textContent, /raised lip/i);
assert.match(classNode('industry-tip').textContent, /scrap goes in the front inside row.*extract molten charge before digging out ash/i);
assert.equal(classNode('industry-stage-hint').textContent, progression.hint);
assert.equal(classNode('industry-stage-hint').hidden, false, 'current stage guidance is visible, not title-only');
assert.deepEqual(machineTypes.includes('heater'), false);
assert.deepEqual(FACTORY_PARTS.map(({ key, price }) => [key, price]),
  Object.values(CONTROL_PARTS).map(part => [part.key, part.cost]));

// Saved legacy heater and new models remain in the scene, with truthful gate/port markers.
const industryRoot = app.scene.children.find(child => child.name === 'Industry');
const savedHeaterModel = industryRoot.children.find(child => child.name === 'industry-machine-saved-heater');
const hearthModel = industryRoot.children.find(child => child.name === 'industry-machine-hearth-1');
const gateModel = industryRoot.children.find(child => child.name === 'industry-machine-gate-1');
assert(savedHeaterModel && hearthModel && gateModel, 'saved heater and current device silhouettes all render');
assert.equal(savedHeaterModel.getObjectByName('industry-port-marker').visible, true, 'configured machine port is marked');
assert.equal(gateModel.getObjectByName('industry-port-marker').visible, true, 'signal gate port is marked');
assert.equal(gateModel.getObjectByName('gate-shutter').visible, true, 'only confirmed physical closure draws the shutter');
const gateReference = gateModel;
tick({ ...state, devices: [heater, hearth, { ...gate, gateClosed: false }] });
assert.equal(app.scene.children.find(child => child.name === 'Industry').children.find(child => child.name === 'industry-machine-gate-1'), gateReference);
assert.equal(gateReference.getObjectByName('gate-shutter').visible, false, 'open gate aperture remains visibly open');

// Paid part choices use canonical keys; TSNS threshold is finite and PHYS-bounded.
const selectSensor = buttons(panel, 'data-part', 'TSNS');
assert(selectSensor);
selectSensor.onclick();
assert.deepEqual(calls.at(-1), ['selectPart', 'TSNS']);
const sensorState = { ...state, part: 'TSNS', partThreshold: SENSOR_THRESHOLD_DEFAULT,
  partCandidate: { x: 40, y: 6, z: 12, type: 'TSNS', threshold: 200 } };
tick(sensorState);
const threshold = classNode('industry-threshold-input');
assert.equal(threshold.min, String(SENSOR_THRESHOLD_MIN));
assert.equal(threshold.max, String(SENSOR_THRESHOLD_MAX));
assert.equal(threshold.value, '200');
assert.equal(classNode('industry-threshold').hidden, false);
assert.match(classNode('industry-operations-help').textContent, /irreversible/i);
const partGhost = industryRoot.children.find(child => child.name === 'industry-part-ghost');
assert.equal(partGhost.visible, true);
assert.deepEqual(partGhost.position.toArray(), [40.5, 6.5, 12.5], 'part placement ghost covers one cell');
assert.equal(industryRoot.children.find(child => child === gateReference).visible, true);
threshold.value = '-273.15'; threshold.oninput();
assert.deepEqual(calls.at(-1), ['setThreshold', -273.15]);
for (const value of ['-273.151', '10000.1', 'Infinity', '']) {
  const count = calls.length;
  threshold.value = value; threshold.oninput();
  assert.equal(calls.length, count, `invalid threshold ${value} is not sent to the controller`);
  assert.equal(threshold.getAttribute('aria-invalid'), 'true');
}
assert(validSensorThreshold(-273.15));
assert(validSensorThreshold(10000));
assert(!validSensorThreshold(Number.NaN));
assert(!validSensorThreshold(Number.POSITIVE_INFINITY));
assert(!validSensorThreshold(-273.151));
assert(!validSensorThreshold(10000.001));
assert.equal(presentFactoryObservation({ status: 'ready', freshness: 'stale' }).label,
  'Ready — transfer not confirmed');
assert.equal(presentFactoryObservation({ status: 'ready', freshness: 'stale' }).sampleLabel, 'Sample: stale');
assert.equal(presentFactoryObservation({ status: 'unknown', freshness: 'unknown', pending: true }).sampleLabel,
  'Sample: unknown · request pending');
assert.equal(presentGateResult({ status: 'damaged' }), 'Gate result: damaged');

// Dynamic inspect/gate/switch controls call the exact parent interface arguments.
const inspectToggle = classNode('industry-inspect-toggle');
inspectToggle.onclick();
assert.deepEqual(calls.at(-1), ['toggleInspect']);
const heaterInspection = {
  device: heater,
  observation: { status: 'ready', freshness: 'stale', running: 'unconfirmed',
    evidence: { regions: { fuel: { eligible: 4, sampled: 12, maxTemperatureC: 1860 } } } },
  gateStatus: null,
};
tick({ ...state, inspectMode: true, part: null, partCandidate: null, inspection: heaterInspection });
assert.equal(inspectToggle.getAttribute('aria-pressed'), 'true');
assert.equal(classNode('industry-observation').textContent, 'Ready — transfer not confirmed');
assert.equal(classNode('industry-freshness').textContent, 'Sample: stale');
assert.match(classNode('industry-observed-regions').textContent, /fuel: 4 eligible \/ 12 sampled · peak 1860°C/);
assert.doesNotMatch(classNode('industry-observation').textContent, /running|throughput/i);
const drive = classNode('industry-drive');
assert.equal(drive.hidden, false);
drive.onclick();
assert.deepEqual(calls.at(-1), ['setDrive', 'saved-heater', false]);
assert.equal(classNode('industry-gate-modes').hidden, true, 'gate controls appear only for inspected gates');
assert.equal(classNode('industry-switch-toggle').hidden, true, 'switch toggle is not shown without an inspected switch');

const inspectedGate = { ...gate, powered: false, gateMode: 'closed' };
tick({ ...state, inspectMode: true, part: null, partCandidate: null,
  inspection: { device: inspectedGate, observation: { status: 'pending', freshness: 'unknown', pending: true }, gateStatus: { status: 'waiting: closure blocked' } } });
assert.equal(classNode('industry-observation').textContent, 'Observation pending');
assert.equal(classNode('industry-freshness').textContent, 'Sample: unknown · request pending');
assert.equal(classNode('industry-gate-result').textContent, 'Gate result: waiting: closure blocked');
const modeButtons = ['open', 'closed', 'signal'].map(mode => buttons(panel, 'data-gate-mode', mode));
assert(modeButtons.every(Boolean));
assert.equal(modeButtons[1].getAttribute('aria-pressed'), 'true');
modeButtons[2].onclick();
assert.deepEqual(calls.at(-1), ['setGateMode', 'gate-1', 'signal']);
const switchInspection = { ...inspectedGate, type: 'belt' };
tick({ ...state, inspectMode: true, part: null, partCandidate: null,
  inspection: { device: switchInspection, observation: { status: 'unknown', freshness: 'unknown' },
    controlPart: { type: 'SWITCH', x: 8, y: 5, z: 9, threshold: 200, on: false } } });
const switchButton = classNode('industry-switch-toggle');
assert.equal(switchButton.hidden, false);
switchButton.onclick();
assert.deepEqual(calls.at(-1), ['toggleControl'], 'switch action gets no device argument and is scoped to inspection');
tick({ ...state, inspectMode: true, part: null, partCandidate: null,
  inspection: { device: null, controlPart: { type: 'SWITCH', x: 8, y: 5, z: 9, on: true } } });
assert.equal(classNode('industry-inspection').hidden, false, 'standalone electrical controls do not need an associated machine');
assert.equal(switchButton.hidden, false);
assert.equal(drive.hidden, true);
tick({ ...state, inspectMode: true, part: null, partCandidate: null,
  inspection: { device: switchInspection, controlPart: { type: 'TSNS', x: 8, y: 5, z: 9, threshold: 200, on: false } } });
assert.equal(classNode('industry-switch-toggle').hidden, true, 'non-switch electronics never get a toggle control');
assert.match(classNode('industry-control-part-label').textContent, /Temperature sensor · off · threshold 200°C/);

// Factory/build visibility remains dynamic; inspection mode suppresses placement ghosts.
tick({ ...state, factory: false, inspectMode: true, partCandidate: sensorState.partCandidate });
assert.equal(panel.hidden, true);
assert.equal(partGhost.visible, false);
tick({ ...state, factory: true, building: false, inspectMode: false, part: 'TSNS', partCandidate: sensorState.partCandidate });
assert.equal(classNode('industry-builder').hidden, true);
assert.equal(partGhost.visible, false);

const optionalActionParent = new Element();
const optionalOperations = createOperationsView(optionalActionParent, {});
assert.doesNotThrow(() => optionalOperations.update({
  part: 'TSNS', partThreshold: SENSOR_THRESHOLD_DEFAULT, inspectMode: true,
  inspection: { device: gate, gateStatus: { pending: true }, controlPart: { type: 'SWITCH', on: false } },
}));
assert.equal(find(optionalActionParent, element => element.className === 'industry-part').disabled, true);
assert.equal(find(optionalActionParent, element => element.className === 'industry-drive').disabled, true);
view.dispose();
console.log('PASS Factory UI slice: modes, diagnostics freshness, action contracts, paid parts, bounds, legacy rendering');

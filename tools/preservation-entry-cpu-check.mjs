import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enterAuthoredMap } from '../src/lab/entry.js';
import { freshPresetKey } from '../src/presets.js';
import { decodeScenePlaques } from '../src/lab/scenePlaques.js';

test('the current map start retries a cancelled shared POV promise, not the stale start', async () => {
  let release, pending, epoch = 1, calls = 0;
  const pov = {
    active: false, player: null, looks: [],
    enter({ valid }) {
      if (pending) return pending;
      calls++;
      pending = new Promise(resolve => { release = () => {
        if (valid()) { this.active = true; this.player = {}; }
        pending = null; resolve();
      }; });
      return pending;
    },
    setLook(yaw) { this.looks.push(yaw); },
  };
  const first = enterAuthoredMap(pov, () => epoch === 1, 1);
  epoch = 2;
  const second = enterAuthoredMap(pov, () => epoch === 2, 2);
  release();
  await first;
  await Promise.resolve();
  assert.equal(calls, 2);
  release();
  assert.equal(await second, true);
  assert.deepEqual(pov.looks, [2]);
});

test('fresh legacy generation is normalized without mutating a saved snapshot header', () => {
  const header = { preset: 'labStudies', dims: [256, 96, 128] };
  assert.equal(freshPresetKey(header.preset), 'preservationLab');
  assert.equal(header.preset, 'labStudies');
  assert.equal(freshPresetKey('lab'), 'lab');
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(source, /function loadPreset\(name, undoable = true\) \{\s+name = freshPresetKey\(name\)/);
});

test('the actual scene-plaque getter refuses unrelated replica terrain', () => {
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const expression = source.match(/getScenePlaques: \(\) => ([^\n]+)/)[1].replace(/,$/, '');
  const invoke = new Function('mp', 'mapKind', 'settings', 'preservationManifest', 'savedScenePlaques', `return (${expression});`);
  const records = [{ elementKey: 'SAND' }], manifest = () => ({ plaques: records });
  const settings = { preset: 'preservationLab' }, kind = { presets: true };
  assert.equal(invoke({ replica: true }, kind, settings, manifest), null);
  assert.equal(invoke({ replica: false }, kind, settings, manifest), records);
  assert.equal(invoke({ replica: false }, kind, { preset: 'lab' }, manifest), null);
  const saved = [{ elementKey: 'SAND', cell: [12, 2, 16] }];
  assert.equal(invoke({ replica: false }, kind, settings, manifest, saved), saved);
});

test('regeneration then undo restores the old snapshot manifest, independent of Industry', async () => {
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const loadSource = source.slice(source.indexOf('function loadPreset('), source.indexOf('// A new scene clears'));
  const undoSource = source.slice(source.indexOf('async function undo()'), source.indexOf('// ---------------------------------------------------------------- saves ('));
  const old = [{ cell: [12, 2, 16], normal: [0, 0, -1], text: 'Sand', elementKey: 'SAND' }];
  const current = [{ ...old[0], cell: [99, 2, 16] }];
  const h = {
    freshPresetKey, decodeScenePlaques, savedScenePlaques: old,
    settings: { preset: 'preservationLab' }, graphicsFailure: null, selectedMode: 'sandbox',
    mp: { replica: false, frozen: false, guard: () => false },
    mapKind: { presets: true, sceneUndo: true }, presetWire: () => null,
    sceneLabel: name => name, resolveMode: () => ({ key: 'sandbox' }), mapOf: () => ({}),
    startMode() {}, whenSimReady() {}, save() {}, wire: () => null,
    pov: { worldReplaced() {} }, hud: { toast() {} }, toolbar: { setUndoEnabled() {} },
    sim: { history: [], snapshot(label) { this.history.push({ label }); }, undo: async () => true },
  };
  h.ctx = { industry: null, getScenePlaques: () => h.savedScenePlaques ?? current };
  const load = new Function('h', `with(h) { ${loadSource}; return loadPreset; }`)(h);
  const undo = new Function('h', `with(h) { ${undoSource}; return undo; }`)(h);
  assert(load('preservationLab'));
  assert.deepEqual(h.ctx.getScenePlaques(), current);
  await undo();
  assert.deepEqual(h.ctx.getScenePlaques(), old);
});

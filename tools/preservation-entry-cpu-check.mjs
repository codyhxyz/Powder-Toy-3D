import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enterAuthoredMap } from '../src/lab/entry.js';
import { freshPresetKey } from '../src/presets.js';

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
  const invoke = new Function('mp', 'mapKind', 'settings', 'preservationManifest', `return (${expression});`);
  const records = [{ elementKey: 'SAND' }], manifest = () => ({ plaques: records });
  const settings = { preset: 'preservationLab' }, kind = { presets: true };
  assert.equal(invoke({ replica: true }, kind, settings, manifest), null);
  assert.equal(invoke({ replica: false }, kind, settings, manifest), records);
  assert.equal(invoke({ replica: false }, kind, { preset: 'lab' }, manifest), null);
});

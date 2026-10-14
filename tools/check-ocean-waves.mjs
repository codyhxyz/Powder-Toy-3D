import assert from 'node:assert/strict';
import { OceanWaves, WAVE_PERIOD, waveSource } from '../src/world/waves.js';

const edits = [];
const sim = {
  frame: 0, origin: { x: 0, z: 0 }, g: { nx: 128, nz: 128 },
  editKernel: () => ({ main: { state: 'ready' }, apply: { state: 'ready' }, ready: Promise.resolve() }),
  edit: (...args) => edits.push(args),
};
const win = { sim, loaded: true, pending: null, epoch: 0, P: { sea: 32 }, scene: { ground: () => 8 } };
const waves = new OceanWaves(win);
assert.equal(waves.step('off'), false);
assert.equal(waves.kernel, null, 'Off builds and dispatches nothing');
assert.equal(waves.step('__proto__'), false);
assert.equal(waves.step('gentle'), true);
assert.equal(edits[0][2].height, 8);
assert.equal(waves.step('large'), false, 'no second wave in the same step');
sim.frame = WAVE_PERIOD - 1;
assert.equal(waves.step('large'), false);
sim.frame++;
assert.equal(waves.step('large'), true);
assert.equal(edits[1][2].height, 16);
win.pending = Promise.resolve();
sim.frame += WAVE_PERIOD;
assert.equal(waves.step('large'), false, 'no write during streaming');
win.pending = null;
assert.equal(waves.step('large'), true);
win.P.sea = 0;
assert.equal(waveSource(win), null);
assert.equal(waves.enabled('gentle'), false);
win.P.sea = 32;
win.scene.ground = () => 32;
assert.ok(waveSource(win), 'ground reports the top of water, not just the seabed');
win.scene.ground = () => 40;
assert.equal(waveSource(win), null, 'no ocean on dry land');
win.scene.ground = (x) => x / 4;
assert.equal(waveSource(win).direction, 1, 'waves travel toward higher ground');
assert.equal(waveSource(win).axis, 0);
win.scene.ground = () => 8;
win.epoch++;
sim.frame = 0;
assert.equal(waves.step('gentle'), true, 'new world resets wave scheduling');
console.log('PASS ocean wave source, levels, cadence, streaming, reload and zero-work Off');

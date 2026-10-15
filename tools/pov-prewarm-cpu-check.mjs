// CPU only: execute the actual optional timer and on-demand figure methods.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/pov/index.js', import.meta.url), 'utf8');
const delay = Number(source.match(/const PREWARM_DELAY_MS = (\d+)/)[1]);
const start = source.indexOf('  // Optional prewarm');
const end = source.indexOf('  function ensureParts()', start);
assert(start > 0 && end > start);
const schedule = new Function('createPlayer', 'app', 'globalThis', 'setTimeout', 'ensureFigure', 'PREWARM_DELAY_MS',
  source.slice(start, end));

for (const testMode of [null, undefined, 'manual', 'ui', 'preview', 'visual']) {
  for (const hasIdle of [false, true]) {
    const timers = [], idle = [];
    let calls = 0;
    const sim = { gpu: { testMode } };
    schedule(true, { getSim: () => sim },
      hasIdle ? { requestIdleCallback: fn => idle.push(fn) } : {},
      (fn, ms) => timers.push({ fn, ms }), () => calls++, delay);
    if (testMode != null) {
      assert.equal(timers.length, 0);
      assert.equal(calls, 0);
      continue;
    }
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 2000);
    timers.shift().fn();
    if (hasIdle) {
      assert.equal(idle.length, 1);
      idle.shift()();
    } else {
      assert.equal(timers.length, 1);
      assert.equal(timers[0].ms, 2000);
      timers.shift().fn();
    }
    assert.equal(calls, 1);
  }
}
schedule(false, { getSim() { throw new Error('No body must not inspect a grid'); } },
  {}, () => assert.fail('No body must not schedule'), () => assert.fail(), delay);
{
  const timers = [], idle = [];
  let sim = { gpu: { testMode: null } };
  schedule(true, { getSim: () => sim }, { requestIdleCallback: fn => idle.push(fn) },
    fn => timers.push(fn), () => assert.fail('Disposed grid must not prewarm'), delay);
  sim = null;
  timers.shift()();
  idle.shift()();
}

const ensureStart = source.indexOf('  function ensureFigure()');
const ensureEnd = source.indexOf("  // The body's and the tools' kernels", ensureStart);
assert(ensureStart > 0 && ensureEnd > ensureStart);
assert(source.includes('ensureFigure(), ensureKernels()'), 'POV entry retains its awaited on-demand path');
for (const testMode of ['manual', 'ui', 'preview', 'visual']) {
  const scene = {}, renderer = {}, camera = {}, g = {}, volume = {}, light = {};
  let creates = 0, adds = 0, binds = 0, compiles = 0;
  const ready = Promise.resolve('figure');
  const body = { root: {}, bind(v, grid) { assert.equal(v, light); assert.equal(grid, g); binds++; },
    compile(...args) { assert.deepEqual(args, [renderer, camera, scene]); compiles++; return ready; } };
  scene.add = root => { assert.equal(root, body.root); adds++; };
  const ensure = new Function('createBody', 'scene', 'volumeLight', 'app', 'renderer', 'camera', 'character',
    `let figure = null;\n${source.slice(ensureStart, ensureEnd)}\nreturn ensureFigure;`)(
    () => { creates++; return body; }, scene, v => { assert.equal(v, volume); return light; },
    { getSim: () => ({ gpu: { testMode }, g }), getVolume: () => volume }, renderer, camera, () => 'real');
  assert.equal(ensure(), ready);
  assert.equal(ensure(), ready);
  assert.deepEqual({ creates, adds, binds, compiles }, { creates: 1, adds: 1, binds: 2, compiles: 2 });
}
console.log('POV prewarm CPU: normal timer/idle fallback retained; all headless modes opt out; awaited on-demand figure construction, binding and compilation unchanged');

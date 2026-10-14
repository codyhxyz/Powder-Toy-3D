import assert from 'node:assert/strict';
import { createLightning } from '../src/lightning.js';
import { gridLayout } from '../src/sim.js';
import { cellSlot } from '../src/shaders/common.js';
import { STORM_KEY } from '../src/shaders/lightning.js';
import { STORM } from '../src/bolt.js';

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function fixture() {
  const reads = [], dispatches = [], edits = [];
  const gpu = {
    frame: { clear() {} }, failure: null,
    layout() { return {}; }, bindGroup() { return {}; },
    kernel({ name }) { return { state: 'ready', ready: Promise.resolve(), dispatch() { dispatches.push(name); } }; },
    readback: { ring(name, slotBytes) {
      return { buffer: {}, slotBytes, next: () => 0, offset: () => 0,
        read() { return new Promise(resolve => reads.push({ name, resolve })); } };
    } },
  };
  const sim = {
    id: 1, g: gridLayout(64, 64, 64), gpu, L: { TABLES: {}, STATE_RO: {} }, tables: {}, bindRO: {},
    frame: 0, paints: 0, wholeWrites: 0, disposed: false, origin: { x: 0, y: 0, z: 0 },
    header: () => ({}), touchCentres: (lo, hi) => ({ lo, hi }),
    editKernel: () => ({ main: { state: 'ready' }, ready: Promise.resolve() }),
    edit(...args) { edits.push(args); },
  };
  const context = { worldIdentity: {}, worldEpoch: 0 }, lightning = createLightning();
  function step() { sim.frame++; lightning.update(sim, context); }
  function start() { lightning.update(sim, context); sim.frame += STORM.POLL_STEPS; lightning.update(sim, context); }
  async function poll() {
    const q = reads.shift(); assert.equal(q.name, 'storm pick');
    q.resolve(new Uint32Array([STORM_KEY.SLOT_MAX - cellSlot(sim.g, 20, 40, 20), 0, 0, 0]).buffer);
    await settle();
  }
  async function scan() {
    const q = reads.shift(); assert.equal(q.name, 'storm scan');
    const data = new Float32Array(STORM.CANDIDATES * 4);
    data[0] = 10; data[1] = 1; data[2] = 1;
    q.resolve(data.buffer); await settle();
  }
  return { sim, context, lightning, reads, dispatches, edits, step, start, poll, scan };
}

{
  const f = fixture(); f.start(); await f.poll();
  assert.deepEqual(f.dispatches, ['stormSearch'], 'poll completion cannot dispatch a scan while paused');
  f.step(); assert.deepEqual(f.dispatches, ['stormSearch', 'stormScan']);
  await f.scan();
  assert.equal(f.edits.length, 0, 'scan completion cannot strike while paused');
  f.step(); assert.equal(f.edits.length, 1); assert.equal(f.lightning.strikes, 1);
}
let guards = 0;
for (const invalidate of [
  f => { f.sim.origin.x += 32; },
  f => { f.sim.wholeWrites++; },
  f => { f.sim.paints++; },
  f => { f.context.worldEpoch++; },
  f => { f.context.worldIdentity = {}; },
  f => { f.sim.frame = 0; },
  f => { f.sim.disposed = true; },
  f => f.lightning.reset(),
  f => f.lightning.dispose(),
]) {
  for (const stage of ['poll', 'scan']) {
    const f = fixture(); f.start(); await f.poll();
    if (stage === 'scan') { f.step(); await f.scan(); }
    invalidate(f); f.step();
    assert.equal(f.edits.length, 0, `stale ${stage} must not write`);
    assert.equal(f.lightning.strikes, 0);
    guards++;
  }
}
{
  const f = fixture(); f.start(); await f.poll(); f.step(); await f.scan();
  // No preset argument: surviving charged CLOUD still strikes after Clear.
  f.context.selectedWeather = 'clear'; f.step();
  assert.equal(f.lightning.strikes, 1);
}
console.log(`Lightning CPU: paused callbacks, ${guards} stale-result guards, and surviving charged clouds passed.`);

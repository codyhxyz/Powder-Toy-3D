// CPU ONLY. No browser, device, pipeline creation or GPU execution. Naga is
// optional static WGSL validation (--naga); this does NOT prove solver motion.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vector3 } from 'three';
import { createOceanEvents, oceanSourceCandidates, oceanOpenEdges, surgeEnvelope, OCEAN_EVENT as C } from '../src/oceanEvents.js';
import { WGSL_CHECK, oceanEventsEdit, oceanColumnsWGSL } from '../src/shaders/oceanEvents.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  const calls = [], buffers = [];
  let read = null, compilation = Promise.resolve(), live = true;
  const sim = {
    id: 1, frame: 0, g: { nx: 64, ny: 64, nz: 64 }, origin: new Vector3(100, 0, 200),
    L: { TABLES: {}, STATE_RO: {} }, tables: {}, bindRO: {},
    readHeader() { return { origin: this.origin.toArray(), src: 0, dst: 0 }; },
    editKernel(name, desc) { assert.equal(desc.reads, 'own'); return { name, ready: compilation }; },
    edit(kernel, box, params, opts) { calls.push({ kind: 'edit', box, params, opts }); },
    _retire(buffer) { calls.push({ kind: 'retire', buffer }); buffer.destroy(); },
  };
  sim.gpu = {
    frame: {}, layout: (name, entries) => ({ name, entries }),
    kernel(desc) { return { ready: compilation, dispatch(frame, size, opts) { calls.push({ kind: 'columns', size, opts }); } }; },
    createBuffer(desc) { const b = { ...desc, destroy() { this.destroyed = true; } }; buffers.push(b); return b; },
    bindGroup: (layout, entries) => ({ layout, entries }),
    write(buffer, offset, data) { calls.push({ kind: 'edges', data }); },
    readback: { async buffer(buffer) {
      calls.push({ kind: 'read' });
      if (read) return read.promise;
      const data = new Float32Array(buffer.size / 4);
      for (let i = 0; i < data.length; i += 2) data.set([live ? 1 : 0, 20], i);
      return data.buffer;
    } },
  };
  const world = { loaded: true, epoch: 1, pending: null };
  const ctx = { sim, world, mapId: 'fixture', seaLevel: 20, target: [132, 232], groundHeight: x => x < 132 ? 8 : 23 };
  return { sim, ctx, calls, buffers, events: createOceanEvents(),
    setRead: x => { read = x; }, setCompilation: p => { compilation = p; }, setLive: x => { live = x; },
    writes: () => calls.filter(c => c.kind === 'edit'),
    liveBytes: () => { const a = new Float32Array(64 * 64 * 2); for (let i = 0; i < a.length; i += 2) a.set([1, 20], i); return a.buffer; },
  };
}
const f = fixture(), { sim, ctx, events } = f;
const candidates = oceanSourceCandidates(ctx);
assert(candidates.length > 0);
assert(candidates.every(c => c.source[0] >= 100 && c.source[0] < 132 && c.source[1] >= 200 && c.source[1] < 264));
assert(candidates.every(c => c.direction[0] === 1 && c.direction[1] === 0));
for (const patch of [{ groundHeight: () => NaN }, { groundHeight: () => 50 }, { seaLevel: 60 }, { oceanEligible: false }])
  assert.equal(oceanSourceCandidates({ ...ctx, ...patch }).length, 0);
const edges = oceanOpenEdges(ctx);
assert(edges.slice(0, 64).every(x => x === 1));
assert(edges.slice(64, 128).every(x => x === 0));
assert(oceanOpenEdges({ ...ctx, groundHeight: () => NaN }).every(x => x === 0));
assert.equal(surgeEnvelope(0), 0); assert.equal(surgeEnvelope(C.duration), 0);
assert.equal(surgeEnvelope(C.rise), 1); assert.equal(surgeEnvelope(C.hold), 1);
for (let age = -1; age < C.duration + 1; age += .1) assert(surgeEnvelope(age) >= 0 && surgeEnvelope(age) <= 1);
assert.equal(await events.trigger({ ...ctx, isGuest: true }), false);
f.setLive(false); assert.equal(await events.trigger(ctx), false);
f.setLive(true); assert.equal(await events.trigger(ctx), true);
assert.equal(f.writes().length, 0, 'async trigger never writes matter');
assert.equal(await events.trigger(ctx), false);
const source = events.source.position;
assert.equal(events.step({ ocean: 0 }, ctx), false);
sim.frame = 240;
for (const patch of [{ paused: true }, { isGuest: true }]) assert.equal(events.step({ ocean: 0 }, { ...ctx, ...patch }), false);
ctx.world.pending = Promise.resolve(); assert.equal(events.step({ ocean: 0 }, ctx), false); ctx.world.pending = null;
assert.equal(events.active, true, 'stream-pending does not cancel source');
assert.equal(events.step({ ocean: 0 }, ctx), true);
assert(f.writes()[0].params.surge > 0 && f.writes()[0].params.surge < 1);
assert.equal(f.calls.at(-2).kind, 'columns', 'live mask dispatched before material edit');
assert.equal(f.writes()[0].opts.scrub, true);
for (const { box } of f.writes()) {
  assert(box.lo.every((n, i) => Number.isInteger(n) && n >= 0 && n <= box.hi[i]));
  assert(box.hi.every((n, i) => n < [sim.g.nx, sim.g.ny, sim.g.nz][i]));
  assert(box.hi[0] - box.lo[0] <= C.halfDepth * 2, 'reservoir stays spatially bounded');
}
assert.equal(events.step({ ocean: 1 }, ctx), false);
sim.frame++; assert.equal(events.step({ ocean: 0 }, ctx), false);
sim.origin.x += 8; sim.frame += C.sourceEvery;
assert.equal(events.step({ ocean: 0 }, ctx), true);
assert.deepEqual(events.source.position, source, 'fixed world-space source across shifts');
sim.origin.x += 64; sim.frame += C.sourceEvery;
assert.equal(events.step({ ocean: 0 }, ctx), false, 'off-window source does not follow player');
sim.origin.x -= 64;
const writes = f.writes().length;
assert.equal(events.cancel(), true);
sim.frame += 100; assert.equal(events.step({ ocean: 0 }, ctx), false);
assert.equal(f.writes().length, writes, 'cancel does not erase or zero momentum');
sim.frame++; assert.equal(events.step({ ocean: 1, wind: [3, 4] }, ctx), true);
assert.deepEqual(f.writes().at(-1).params.wind, [.6, .8]);
assert.equal(f.writes().at(-1).params.surge, 0);
assert.equal(f.writes().at(-1).opts.scrub, false);
sim.frame++; assert.equal(events.step({ ocean: 1 }, ctx), false);
events.reset(); assert.equal(f.writes().length, writes + 1);
assert.equal(await events.trigger(ctx), true);
sim.frame += C.stepsPerSecond * C.duration;
assert.equal(events.step({ ocean: 0 }, ctx), false); assert.equal(events.active, false);
assert.equal(await events.trigger(ctx), true);
ctx.world.epoch++; sim.frame++; events.step({ ocean: 0 }, ctx); assert.equal(events.active, false);
assert.equal(await events.trigger(ctx), true);
sim.frame--; events.step({ ocean: 0 }, ctx); assert.equal(events.active, false, 'rewind resets event');
events.dispose(); assert.equal(await events.trigger(ctx), false);
assert(f.buffers.every(b => b.destroyed));

// Delayed readback cannot resurrect an event after any lifecycle invalidation.
for (const change of [
  f => f.events.cancel(), f => f.events.reset(), f => f.events.dispose(),
  f => { f.sim.origin.x += 16; }, f => { f.ctx.world.epoch++; },
  f => { f.ctx.mapId = 'replacement'; }, f => { f.ctx.sim = { ...f.sim }; },
  f => { f.ctx.world = { ...f.ctx.world }; }, f => { f.ctx.seaLevel++; },
  f => { f.ctx.isGuest = true; }, f => { f.ctx.world.loaded = false; },
  f => { f.events.step({ ocean: 0 }, { ...f.ctx, mapId: 'replacement' }); },
]) {
  const f = fixture(), read = deferred(); f.setRead(read);
  const result = f.events.trigger(f.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.pending, true);
  assert.equal(await f.events.trigger(f.ctx), false, 'single pending trigger');
  change(f); read.resolve(f.liveBytes());
  assert.equal(await result, false); assert.equal(f.events.active, false);
  assert.equal(f.writes().length, 0); f.events.dispose();
}
{
  const f = fixture(), ready = deferred(); f.setCompilation(ready.promise);
  assert.equal(f.events.step({ ocean: 1 }, f.ctx), false);
  assert.equal(f.calls.length, 0, 'pending pipelines never dispatch');
  ready.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes().length, 0, 'readiness callback never writes');
  f.sim.frame++; assert.equal(f.events.step({ ocean: 1 }, f.ctx), true);
  f.events.dispose();
}
{
  const f = fixture(), read = deferred(); f.setRead(read);
  const result = f.events.trigger(f.ctx); await new Promise(resolve => setImmediate(resolve));
  read.reject(new Error('readback failed'));
  await assert.rejects(result, /readback failed/);
  assert.equal(f.events.pending, false); assert.equal(f.events.active, false); f.events.dispose();
}

{
  const f = fixture(), ready = deferred(); f.setCompilation(ready.promise);
  const result = f.events.trigger(f.ctx);
  f.events.cancel(); ready.resolve();
  assert.equal(await result, false);
  assert.equal(f.calls.length, 0, 'cancel during compilation records neither read nor write');
  f.events.dispose();
}
{
  const f = fixture(), old = deferred(); f.setRead(old);
  const first = f.events.trigger(f.ctx); await new Promise(resolve => setImmediate(resolve));
  f.events.cancel(); f.setRead(null);
  assert.equal(await f.events.trigger(f.ctx), true);
  const source = f.events.source;
  old.resolve(f.liveBytes()); assert.equal(await first, false);
  assert.deepEqual(f.events.source, source, 'old readback cannot overwrite a newer event');
  f.events.dispose();
}
{
  const f = fixture(), ready = deferred(); f.setCompilation(ready.promise);
  const result = f.events.trigger(f.ctx); ready.reject(new Error('compile failed'));
  await assert.rejects(result, /compile failed/);
  assert.equal(f.events.pending, false); assert.equal(f.calls.length, 0); f.events.dispose();
}

// CPU specification fixture for the mask, explicitly NOT shader execution.
// Static assertions connect the safety-critical datum->surface loop to WGSL.
const shader = oceanColumnsWGSL({ nx: 64, ny: 64, nz: 64 });
assert.match(shader, /for \(var y = datum; y < top; y\+\+\)/);
assert.match(shader, /eid\(fetchA\(vec3i\(c.x, y, c.y\)\)\) != E_WATER/);
assert.match(shader, /if \(id != E_WATER\) \{ return; \}/);
assert.equal(oceanEventsEdit.reads, 'own');
assert.match(oceanEventsEdit.update, /id != E_EMPTY && id != E_WATER/);
assert.match(oceanEventsEdit.update, /id == E_EMPTY/);
assert.match(oceanEventsEdit.update, /else if \(id == E_WATER && P.chop/);
assert.doesNotMatch(oceanEventsEdit.update, /f32\(E_EMPTY\)/, 'forcing never deletes material');
function marine(cell, x, z, open = true) {
  let top = -1;
  for (let y = 63; y >= 0; y--) {
    const id = cell(x, y, z);
    if (id === 'air' || id === 'gas') continue;
    if (id !== 'water') return false;
    top = y + 1; break;
  }
  if (top < 18 || top > 42) return false;
  for (let y = 18; y < top; y++) if (cell(x, y, z) !== 'water') return false;
  if (!open) return false;
  return [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dz]) => {
    let a = x, b = z;
    for (let i = 0; i < 64; i++, a += dx, b += dz) {
      if (a < 0 || a >= 64 || b < 0 || b >= 64) return true;
      if (cell(a, 18, b) !== 'water') return false;
    }
    return true;
  });
}
const sea = (x, y, z) => y < 9 ? 'solid' : y < 20 ? 'water' : 'air';
assert.equal(marine(sea, 16, 16), true);
assert.equal(marine(sea, 16, 16, false), false);
assert.equal(marine((x, y, z) => y === 30 ? 'solid' : sea(x, y, z), 16, 16), false, 'roof shelters water');
const tank = (x, y, z) => x >= 10 && x <= 20 && z >= 10 && z <= 20 && y >= 20 && y <= 24
  ? (y === 20 || x === 10 || x === 20 || z === 10 || z === 20 ? 'solid' : y < 23 ? 'water' : 'air') : sea(x, y, z);
assert.equal(marine(tank, 16, 16), false, 'elevated sealed tank must not inherit underlying marine connection');
const basin = (x, y, z) => (x === 10 || x === 20 || z === 10 || z === 20) && y < 25 ? 'solid' : sea(x, y, z);
assert.equal(marine(basin, 16, 16), false, 'closed basin');
assert.equal(marine((x, y, z) => y === 19 ? 'air' : y === 22 ? 'water' : sea(x, y, z), 16, 16), false, 'detached water above sea');

// Native host clock: unchanged per-second source strength at 60Hz,
// including the source's non-integral 7.5-tick cadence.
const native = fixture(); native.ctx.stepHz = 60;
assert(await native.events.trigger(native.ctx));
for (let i = 1; i <= 60; i++) { native.sim.frame = i; native.events.step({ ocean: 1 }, native.ctx); }
assert.equal(native.writes().filter(w => w.params.surge > 0).length, 8, 'eight surge pulses in one native second');
assert.equal(native.writes().filter(w => w.params.chop > 0).length, 5, 'chop includes both t=0-ish and t=1 boundary');
assert.equal(native.writes().at(-1).params.time, 1);
native.events.dispose();

if (process.argv.includes('--naga')) {
  const dir = mkdtempSync(join(tmpdir(), 'ocean-wgsl-'));
  try {
    for (const dims of [[64, 64, 64], [128, 384, 128], [256, 96, 128]]) {
      const [nx, ny, nz] = dims;
      for (const c of WGSL_CHECK) {
        const path = join(dir, `${c.name}-${nx}-${ny}-${nz}.wgsl`);
        writeFileSync(path, c.code({ nx, ny, nz }));
        execFileSync('naga', [path], { stdio: 'pipe' });
        const storage = c.layouts().flat().filter(e => /storage/.test(e.buffer?.type ?? '')).length;
        assert(storage <= 8, `${c.name}: ${storage} storage bindings exceeds WebGPU minimum`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('Naga CPU validation: 6 complete WGSL modules passed (including giant/rectangular grids)');
}
console.log('Ocean CPU checks passed: lifecycle, async guards, cadence, streaming, source bounds, mask specification. GPU behavior NOT tested.');

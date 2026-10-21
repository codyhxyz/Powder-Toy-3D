// CPU only: mocks, shader generation, optional Naga validation. Never starts
// a browser, GPU device, server, or shader pipeline. --wgsl requires naga.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { E } from '../src/elements.js';
import { createLighthouse } from '../src/gfx/lighthouse.js';
import { LIGHTHOUSE, lighthouseLantern, lighthouseNight, lighthouseDirection } from '../src/gfx/lighthouseMath.js';
import { FRAME_UNIFORMS, FrameUniforms } from '../src/shaders/bindings.js';
import { WGSL_CHECK as renderChecks } from '../src/shaders/render.js';
import { WGSL_CHECK as farChecks } from '../src/shaders/far.js';
import { libChecks, lib } from '../src/shaders/gfx/lib.js';

const tick = () => new Promise((r) => setImmediate(r));
const structure = () => {
  const s = { w: 3, h: 5, d: 3, base: { y: 2 }, data: new Float32Array(3 * 5 * 3 * 4) };
  for (const y of [3, 4]) s.data[((1 * s.h + y) * s.w + 1) * 4] = E.CRYSTAL + 1;
  return { kind: 'lighthouse', x0: 10, y: 20, z0: 30, s };
};
assert.deepEqual(lighthouseLantern([structure()]), { cell: [11, 21, 31], position: [11.5, 22, 31.5] });
assert.equal(lighthouseLantern([]), null);
assert.equal(lighthouseNight(0), 1); assert.equal(lighthouseNight(0.5), 0); assert.equal(lighthouseNight(NaN), 0);
assert(Math.abs(lighthouseDirection(0)[0] - lighthouseDirection(LIGHTHOUSE.period)[0]) < 1e-10);
assert(Math.abs(Math.hypot(...lighthouseDirection(4)) - 1) < 1e-12);

function fixture() {
  const reads = [], uniforms = Object.fromEntries(['uBeacon', 'uBeaconDir', 'uBeaconCell'].map((k) => [k, { value: new Float32Array(4) }]));
  const sim = { origin: { x: 0, y: 0, z: 0 }, g: { nx: 64, ny: 64, nz: 64 }, version: 1,
    readCell(...cell) { return new Promise((resolve, reject) => reads.push({ cell, resolve, reject })); } };
  const world = { loaded: true, epoch: 1, P: { structures: true }, sim };
  let changes = 0;
  const light = createLighthouse({ uniforms, getStructures: () => [structure()], onChange: () => changes++ });
  const update = (time = 0, options = {}) => light.update({ time }, { world, dayPhase: 0, ...options });
  const resolve = async (id = E.CRYSTAL, i = reads.length - 1) => { reads[i].resolve([new Float32Array([id, 0, 0, 0]), new Float32Array(4)]); await tick(); };
  return { sim, world, reads, light, uniforms, update, resolve, changes: () => changes, power: () => uniforms.uBeaconDir.value[3] };
}
{
  const f = fixture(); f.update(); assert.equal(f.power(), 1);
  assert.deepEqual(f.reads[0].cell, [11, 21, 31]);
  f.update(0.01); assert.equal(f.reads.length, 1, 'one pending capture');
  const beforeCapture = f.changes(); await f.resolve(); assert.equal(f.changes(), beforeCapture + 1, 'async capture wakes presentation');
  f.update(1); assert.equal(f.reads.length, 1, 'unchanged version sleeps');
  f.update(1, { dayPhase: 0.5 }); assert.equal(f.power(), 0, 'daylight off');
  f.update(1); const dir = [...f.uniforms.uBeaconDir.value], beforePaused = f.changes(); f.update(1);
  assert.deepEqual([...f.uniforms.uBeaconDir.value], dir, 'paused sweep frozen');
  assert.equal(f.changes(), beforePaused, 'unchanged paused light does not wake');
  f.sim.version++; f.update(1); assert.equal(f.reads.length, 2, 'paused edit captures');
  await f.resolve(E.EMPTY); assert.equal(f.power(), 0, 'destroyed crystal switches off immediately');
  f.light.reset(); f.sim.origin.x = 128; f.update(2); assert.equal(f.power(), 0, 'reset/unload cannot resurrect');
  f.world.epoch++; f.update(3); assert.equal(f.power(), 1, 'new map epoch forgets old destruction');
  f.light.dispose(); assert.equal(f.power(), 0); f.update(4); assert.equal(f.power(), 0);
}
for (const guard of ['origin', 'epoch', 'sim', 'world', 'dispose', 'reset', 'disabled']) {
  const f = fixture(); f.update();
  if (guard === 'origin') f.sim.origin.x = 128;
  if (guard === 'epoch') f.world.epoch++;
  if (guard === 'sim') f.world.sim = { ...f.sim };
  if (guard === 'world') f.update(0, { world: { ...f.world } });
  if (guard === 'dispose') f.light.dispose();
  if (guard === 'reset') f.light.reset();
  if (guard === 'disabled') f.update(0, { enabled: false });
  const before = f.changes(); await f.resolve(E.EMPTY, 0);
  assert.equal(f.changes(), before, `stale ${guard} callback discarded`);
  f.light.dispose();
}
{
  const f = fixture(); f.update(); await f.resolve();
  f.sim.version++; f.update(0.1); assert.equal(f.reads.length, 1, 'read rate capped');
  f.sim.origin.x = 128; f.update(0.2); assert.equal(f.power(), 0, 'unverified departure stays dark');
}
{
  const f = fixture(); f.update(); f.reads[0].reject(new Error('device lost')); await tick();
  f.sim.origin.x = 128; f.update(1); assert.equal(f.power(), 0, 'failed capture cannot authorize unloaded lamp');
}
{
  const f = fixture(); f.update(0, { enabled: false }); assert.equal(f.reads.length, 0);
  f.update(0); assert.equal(f.reads.length, 1, 're-enable captures');
  await f.resolve(); f.sim.origin.x = 128; f.update(1); assert.equal(f.power(), 1, 'verified departure can remain lit');
}
// The beacon's three fields, together and in order wherever they sit (later fields are appended after them).
const beaconAt = FRAME_UNIFORMS.findIndex(([n]) => n === 'beacon');
assert.deepEqual(FRAME_UNIFORMS.slice(beaconAt, beaconAt + 3).map(([n, type]) => [n, type]), [['beacon', 'vec4f'], ['beaconDir', 'vec4f'], ['beaconCell', 'vec4f']]);
assert(FrameUniforms.size < 65536);
const g = { nx: 64, ny: 64, nz: 64 };
const checks = [...renderChecks(), ...farChecks().filter((c) => /^(far view|far detail$)/.test(c.name)), ...libChecks('lib'), ...libChecks('lighting')];
const dir = process.argv.includes('--wgsl') ? mkdtempSync(join(tmpdir(), 'tpt-beacon-wgsl-')) : null;
let validated = 0;
try {
  for (const check of checks) {
    const code = check.code(g);
    assert(!code.includes('undefined'), check.name);
    if (check.name.includes('realistic')) {
      assert(code.includes('sum += E * gasPhase(mu, g0)'), 'actual gas scattering hook');
      assert(code.includes('NX + NY + NZ + 3'), 'resident geometry DDA budget');
      assert(code.includes('textureLoad(tFarGrid, bc, 0)'), 'far shadow from actual occupancy');
    }
    for (const stage of [1, 2, 4]) {
      const bindings = check.layouts(g).flat().filter((e) => (e.visibility ?? 7) & stage);
      assert(bindings.filter((e) => /storage/.test(e.buffer?.type ?? '')).length <= 8, `${check.name}: storage budget`);
      assert(bindings.filter((e) => e.texture).length <= 16, `${check.name}: texture budget`);
    }
    if (dir) {
      const file = join(dir, `${check.name.replaceAll(/[^\w.-]/g, '_')}.wgsl`); writeFileSync(file, code);
      execFileSync('naga', [file], { stdio: 'pipe' }); validated++;
    }
  }
  assert(!lib(g, { far: false }).includes('textureLoad(tFarGrid, bc, 0)'), 'no far texture dependency for bare library');
} finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
console.log(`lighthouse-cpu-check: lifecycle/guard/math checks passed; ${checks.length} shader variants generated and binding-budget checked; ${validated} CPU Naga validations; no GPU/browser.`);

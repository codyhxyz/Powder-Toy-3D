// CPU ONLY. No browser, GPU device, pipeline build or simulation readback.
// --wgsl additionally runs the local Naga CLI's CPU parser/validator.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gridLayout, Simulation } from '../src/sim.js';
import { ELEMENTS, E, K } from '../src/elements.js';
import { PHYS } from '../src/physics.js';
import { SALT, LAYOUT } from '../src/shaders/common.js';
import { createElementWeather, elementWeatherPolicy, ELEMENT_WEATHER } from '../src/elementWeather.js';
import { WGSL_CHECK, weatherUpdateWGSL, weatherRoofFrag } from '../src/shaders/elementWeather.js';

const calls = [], kernels = [], buffers = [];
// Only usage bits, not a GPU implementation. Every resource/dispatch is a mock.
globalThis.GPUBufferUsage = { STORAGE: 128 };
const gpu = {
  frame: {}, failure: null, lost: false,
  layout: (name, entries) => ({ name, entries }),
  createBuffer: desc => { const b = { ...desc, retired: false }; buffers.push(b); return b; },
  bindGroup: (layout, entries) => ({ layout, entries }),
  kernel(desc) {
    let resolve;
    const k = { ...desc, state: 'pending', ready: new Promise(r => { resolve = r; }),
      dispatch(frame, size, opts) { assert.equal(k.state, 'ready'); calls.push({ op: 'scan', frame, size, opts }); },
      finish() { k.state = 'ready'; resolve(k); },
    };
    kernels.push(k); return k;
  },
};
const makeSim = () => ({
  gpu, g: gridLayout(128, 128, 128), frame: 0, origin: { x: 160, y: 0, z: 256 },
  L: { TABLES: LAYOUT.TABLES, STATE_RO: LAYOUT.STATE_RO, STATE_RW: LAYOUT.STATE_RW },
  tables: {}, bindRO: {}, debug: false,
  header() { return { origin: [this.origin.x, this.origin.y, this.origin.z], src: 1, dst: 1 }; },
  editKernel: Simulation.prototype.editKernel,
  edit(kernel, box, values, opts) { calls.push({ op: 'edit', kernel, box, values, opts }); },
  _retire(buffer) { buffer.retired = true; },
});
const sim = makeSim(), world = { loaded: true, epoch: 0, P: { sea: 18 } };
// Off uses the already-ready filtered brush, with no step/readback/compilation.
{
  const fog = createElementWeather(), edits = [];
  const fixture = { ...sim, paint: args => edits.push(args) };
  assert.equal(fog.clearFog({ sim: fixture, world }), false);
  assert.equal(fog.clearFog({ sim: fixture, world: { ...world, loaded: false }, host: true }), false);
  for (const y of [-8, 0, 32]) {
    fixture.origin = { ...sim.origin, y };
    assert.equal(fog.clearFog({ sim: fixture, world, host: true }), true);
    const edit = edits.at(-1);
    assert.equal(edit.filter, E.CLOUD);
    assert.equal(edit.erase, true);
    assert.equal(edit.shape, 1);
    const top = edit.center.y + edit.radius;
    const skyBottom = Math.max(y + 2, world.P.sea + 14,
      y + sim.g.ny - ELEMENT_WEATHER.cloudMargin - ELEMENT_WEATHER.cloudDepth);
    assert.equal(top + y, skyBottom);
    assert(edit.center.y - edit.radius < 0);
    assert(edit.center.x - edit.radius < 0 && edit.center.x + edit.radius > sim.g.nx);
    assert(edit.center.z - edit.radius < 0 && edit.center.z + edit.radius > sim.g.nz);
  }
  fog.dispose();
  assert.equal(fog.clearFog({ sim: fixture, world, host: true }), false);
  assert.equal(edits.length, 3);
}
const context = { sim, world, advancing: true, host: true, fogEnabled: true };
const storm = { preset: 'storm', cloud: 1, rain: 1, storm: 1, fog: 1, wind: [3, 4], time: 10 };
const clear = { ...storm, preset: 'clear' };
for (const c of [{ ...context, advancing: false }, { ...context, advancing: undefined },
  { ...context, host: false }, { ...context, host: undefined }, { ...context, enabled: false },
  { ...context, world: { ...world, loaded: false } }, { ...context, seaLevel: NaN }, { ...context, sim: null },
  { ...context, sim: { ...sim, disposed: true } }, { ...context, sim: { ...sim, frame: -1 } },
  { ...context, sim: { ...sim, gpu: { failure: new Error('test') } } }]) {
  assert.equal(elementWeatherPolicy(storm, c), null, 'host step permission and live state are mandatory');
}
assert.equal(elementWeatherPolicy(null, context), null);
const p = elementWeatherPolicy(storm, context);
assert.deepEqual(p.source, [1, 1, 1, 1]);
assert.deepEqual(p.wind, [0.6, 0.8]);
assert.deepEqual(p.bands, [112, 124, 19, 28]);
assert.deepEqual(p.boxes, [
  { lo: [0, 112, 0], hi: [127, 123, 127] }, { lo: [0, 19, 0], hi: [127, 27, 127] },
]);
assert.equal(elementWeatherPolicy(clear, { ...context, fogEnabled: false }), null, 'clear gates fading storm values');
assert.deepEqual(elementWeatherPolicy(clear, context).source, [0, 0, 0, 1], 'independent fog under clear sky');
assert.deepEqual(elementWeatherPolicy({ ...storm, preset: 'overcast' }, context).source, [1, 0, 0, 1]);
assert.deepEqual(elementWeatherPolicy({ ...storm, preset: 'rain' }, context).source, [1, 1, 0, 1]);
assert.deepEqual(elementWeatherPolicy(storm, { ...context, cloudEnabled: false }).source, [0, 0, 0, 1]);
assert.deepEqual(elementWeatherPolicy({ ...storm, wind: [NaN, 4] }, context).wind, [0.8, 0.6]);
assert.deepEqual(elementWeatherPolicy({ ...storm, cloud: 10, rain: -1, storm: NaN, fog: -2 }, context).source, [1, 0, 0, 0]);
assert.equal(elementWeatherPolicy({ ...storm, cloud: NaN, fog: NaN }, context), null);
assert.equal(elementWeatherPolicy(storm, { ...context, seaLevel: 200 }), null);
assert.equal(elementWeatherPolicy(storm, { ...context, world: null }), null);
assert(elementWeatherPolicy(storm, { ...context, world: null, seaLevel: 18, enabled: true }));

// Height and scratch budget on production/test grids, including shifted Y
// and fractional sea levels. No gap between thin bands is ever edited.
const dims = [[32, 32, 32], [64, 64, 64], [128, 128, 128], [160, 96, 160], [256, 96, 128], [128, 384, 128]];
let maxScratch = 0;
for (const size of dims) for (const y of [-8, 0, 32]) for (const sea of [18, 18.5, 19.1, 200]) {
  const fixture = { ...sim, g: gridLayout(...size), origin: { ...sim.origin, y } };
  const policy = elementWeatherPolicy(storm, { ...context, sim: fixture, seaLevel: sea });
  if (!policy) continue;
  assert(policy.boxes.length <= 2);
  for (const box of policy.boxes) {
    assert(box.lo[1] >= 0 && box.hi[1] < size[1]);
    assert(box.hi[1] - box.lo[1] + 1 <= ELEMENT_WEATHER.cloudDepth);
    for (let cy = box.lo[1]; cy <= box.hi[1]; cy++) {
      const wy = y + cy + 0.5, b = policy.bands;
      assert((policy.source[0] && wy >= b[0] && wy < b[1]) || (policy.source[3] && wy >= b[2] && wy < b[3]));
    }
    const alignedHeight = ((box.hi[1] >> 2) - (box.lo[1] >> 2) + 1) * 4;
    const bytes = size[0] * size[2] * alignedHeight * 32;
    maxScratch = Math.max(maxScratch, bytes);
    assert(bytes <= 16 * size[0] * size[2] * 32, 'scratch bounded to a brick-aligned thin band');
  }
}

const sources = createElementWeather();
assert.equal(sources.step(storm, { ...context, host: false }), false);
assert.equal(kernels.length, 0, 'guests do not even initialize sources');
assert.equal(sources.step(storm, context), false, 'lazy kernels are not ready');
assert.equal(calls.length, 0);
assert.equal(kernels.length, 3, 'one scan and shared edit main/apply, compiled only on first permitted use');
const firstReady = sources.ready;
assert.equal(sources.step(clear, { ...context, fogEnabled: false }), false);
kernels.forEach(k => k.finish());
await firstReady;
await Promise.resolve();
assert.equal(calls.length, 0, 'readiness must never asynchronously emit (cancel/pause safe)');
assert.equal(sources.step(storm, { ...context, advancing: false }), false);
assert.equal(sources.step(storm, context), true);
assert.deepEqual(calls.map(c => c.op), ['scan', 'edit', 'edit']);
assert.deepEqual(calls[0].size, [256, 1, 1]);
assert.equal(calls[0].opts.bind[1], sim.bindRO);
assert.deepEqual(calls[0].opts.header.origin, [160, 0, 256]);
for (const edit of calls.slice(1)) {
  assert.equal(edit.kernel.reads, 'neighbours', 'rain reads a stable neighbour snapshot');
  assert.equal(edit.opts.bind[0].buffer, buffers[0]);
  assert.deepEqual(edit.values.source, [1, 1, 1, 1]);
  assert.equal(edit.values.pulse, 0);
}
assert.equal(sources.step(storm, context), false);
sim.frame = ELEMENT_WEATHER.cadence - 1;
assert.equal(sources.step(storm, context), false);
sim.frame++;
assert.equal(sources.step(storm, context), true);
assert.equal(sources.pulses, 2);
const count = calls.length;
sim.frame += ELEMENT_WEATHER.cadence;
assert.equal(sources.step(clear, { ...context, fogEnabled: false }), false);
assert.equal(calls.length, count, 'clear never edits or erases previously emitted cells');
sim.origin.x += 32;
assert.equal(sources.step(storm, context), true);
assert.equal(calls[count].opts.header.origin[0], 192);
sim.frame = 0;
assert.equal(sources.step(storm, context), true, 'rewound clock rebases');
world.epoch++;
assert.equal(sources.step(storm, context), true, 'world reload rebases');
const writes = calls.length;
sources.reset();
assert.equal(calls.length, writes);
assert(buffers[0].retired, 'owned buffer goes through shared safe retirement');
assert.equal(sources.step(storm, context), false);
const pending = sources.ready;
sources.reset();
kernels.forEach(k => k.finish());
await pending;
assert.equal(calls.length, writes, 'abandoned compilation never writes after reset');
const replacement = makeSim();
assert.equal(sources.step(storm, { ...context, sim: replacement }), false);
kernels.forEach(k => k.finish());
await sources.ready;
assert.equal(sources.step(storm, { ...context, sim: replacement }), true);
const end = calls.length;
sources.dispose(); sources.dispose();
assert.equal(sources.step(storm, context), false);
assert.equal(calls.length, end);
assert(buffers.every(b => b.retired));

// Exercise the production edit wrapper with CPU mocks too: both phases are
// ordered before the next step, version changes and the activity map wakes.
const recorded = [];
const writer = {
  g: sim.g, gpu, tables: {}, bindRW: {}, version: 3,
  _clip: Simulation.prototype._clip, header: () => sim.header(),
  _editScratch: bytes => ({ size: bytes }),
  _editGroup: (kernel, bindings) => ({ kernel, bindings }),
  _dispatch: (kernel, size, options) => recorded.push({ kernel, size, options }),
  wake: () => recorded.push({ wake: true }),
};
const firstEdit = calls.find(c => c.op === 'edit');
Simulation.prototype.edit.call(writer, firstEdit.kernel, firstEdit.box, firstEdit.values, firstEdit.opts);
assert.equal(writer.version, 4);
assert.deepEqual(recorded.map(c => c.kernel?.name ?? 'wake'), ['elementWeather', 'elementWeather apply', 'wake']);
assert.deepEqual(recorded[0].options.params.editLo, p.boxes[0].lo);
assert.deepEqual(recorded[0].options.params.editHi, p.boxes[0].hi);

// Static semantic checks tied to the real WGSL, not the stale GLSL draft.
assert.equal(ELEMENTS[E.CLOUD].kind, K.GAS);
assert(PHYS.CHARGE_BREAKDOWN > 0 && PHYS.CHARGE_BREAKDOWN <= PHYS.CHARGE_MAX);
assert(!Object.values(SALT).includes(0x57ea7), 'weather random stream does not collide');
assert.match(weatherUpdateWGSL, /if \(eid\(a\) != E_EMPTY\) \{ return; \}/);
assert.match(weatherUpdateWGSL, /if \(w.y <= roof\) \{ return; \}/);
assert.match(weatherRoofFrag(sim.g), /top = f32\(y \+ 1\)/);
assert.match(weatherRoofFrag(sim.g), /id != E_EMPTY && KIND\(id\) != K_GAS/);
assert.match(weatherUpdateWGSL, /eid\(fetchA\(p \+ vec3i\(0, 1, 0\)\)\) == E_CLOUD/);
assert.match(weatherUpdateWGSL, /charge = CHARGE_BREAKDOWN/);
assert.match(weatherUpdateWGSL, /id = E_SNOW; velocity.y = SPAWN_DROP_V/);
assert.match(weatherUpdateWGSL, /SPAWNLIFE\(id\), charge \+ rnd\(&rng\) \* SEED_MAX/);
assert.match(weatherUpdateWGSL, /\*oB = vec4f\(velocity, b.w\)/);
// A roof at y=19 stores 20: centre 20.5 must be open, centre 19.5 closed.
assert(20.5 > 19 + 1 && !(19.5 > 19 + 1));

// Registry/layout/import validation is CPU-only. Never import check-wgsl.mjs:
// that tool launches a browser even with --no-build.
const dir = process.argv.includes('--wgsl') ? mkdtempSync(join(tmpdir(), 'element-weather-wgsl-')) : null;
let programs = 0;
try {
  for (const size of dims) for (const entry of WGSL_CHECK) {
    const g = gridLayout(...size), code = entry.code(g), layouts = entry.layouts(g);
    const bindings = [...code.matchAll(/@group\((\d+)\) @binding\((\d+)\) var<storage, (read|read_write)>/g)];
    assert(bindings.length <= 8, `${entry.name}: storage budget`);
    for (const [, group, binding, access] of bindings) {
      const expected = layouts[+group].find(e => e.binding === +binding);
      assert(expected, `${entry.name}: binding ${group}/${binding} exists`);
      assert.equal(expected.buffer.type, access === 'read' ? 'read-only-storage' : 'storage');
    }
    assert(entry.dispatch(g).every(n => n <= 65535));
    if (entry.name.startsWith('elementWeather')) {
      assert.equal(bindings.length, 8);
      assert.match(code, /writeCell\(p, fetchA\(p\), fetchB\(p\), fetchF\(p\), editScratch\[i\], editScratch\[i \+ 1u\]\)/);
      assert.match(code, /markBrick\(brickId\(b\)\)/, 'shared writer marks changed bricks');
    }
    if (dir) {
      const path = join(dir, `${size.join('x')}-${entry.entry ?? 'roof'}.wgsl`);
      writeFileSync(path, code);
      execFileSync('naga', [path], { stdio: 'pipe' }); // CPU parsing/validation only; no output target/pipeline/device
    }
    programs++;
  }
} finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
console.log(`element weather CPU: policy, cadence, host/pause gating, cancellation/readiness, lifecycle, bounded bands, metadata predicates and ${programs} WGSL layouts passed; max band scratch ${maxScratch} bytes${dir ? '; Naga validation passed' : ''}`);

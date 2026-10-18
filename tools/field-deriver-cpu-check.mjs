import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FieldTestGPU } from './field-test-gpu.mjs';
import { gridDims, LAYOUT, cellSlot, slotCell } from '../src/shaders/common.js';
import * as shaders from '../src/shaders/fields.js';
import { FIELD_RESOURCES, createFieldResources, createFieldLayouts, createFieldKernels, createFieldHelpers, FieldDeriver, fieldWeights } from '../src/gfx/fieldDeriver.js';
import { Derived, fieldWeights as publicWeights } from '../src/derived.js';
import { CHANNELS, MEDIA } from '../src/gfx/materials.js';

const baseline = JSON.parse(readFileSync(new URL('./field-box-shader-hashes.json', import.meta.url)));
const hash = (s) => createHash('sha256').update(s).digest('hex');
const gpu = new FieldTestGPU(), g = gridDims({ nx: 32, ny: 32, nz: 32 });
const tablesLayout = gpu.layout('TABLES', LAYOUT.TABLES), stateLayout = gpu.layout('STATE_RO', LAYOUT.STATE_RO);
const layouts = createFieldLayouts(gpu), resources = { ...createFieldResources(gpu, g),
  age: gpu.createBuffer({ size: g.nbricks * 4 }), dlist: gpu.createBuffer({ size: shaders.dirtyLists(g).words * 4 }) };
assert.equal(Object.entries(FIELD_RESOURCES).reduce((n, [k]) => n + resources[k].size, 0) + g.slots * 24, g.slots * 80);
assert.equal(resources.tmpB.size, 4 * g.slots * 4, 'GI reset/shift still has fourth plane');
assert.equal(resources.blurred.usage, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
assert.equal(resources.tmpA.usage, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
assert.equal(publicWeights, fieldWeights);
const kernels = createFieldKernels(gpu, g, { tablesLayout, stateLayout, layouts });
const helpers = createFieldHelpers(gpu, g, tablesLayout, layouts);
for (const make of Object.values(helpers)) { const k = make(); assert.equal(k.state, 'ready'); }
const tables = {}, sourceGroup = {}, events = [], deriver = new FieldDeriver(gpu, { g, resources, layouts, kernels, tables, onPass: (name) => events.push(name) });
const aerBuffer = gpu.createBuffer({ size: 16 });
deriver.setAeration({ buffer: aerBuffer, active: true, copy: 1 });
deriver.recordEMA(gpu.frame, { sourceGroup, header: { src: 1, origin: [8, 0, 4] }, reset: true });
deriver.recordSpatial(gpu.frame, { sourceGroup, header: { src: 1, origin: [8, 0, 4] }, smoothing: 0.75 });
assert.deepEqual(events, ['fieldEma', 'fieldBlur', 'fieldBlur', 'fieldFinal', 'fieldBoost0', 'fieldBoost', 'fieldBoost', 'fieldPeak']);
const dispatches = gpu.trace.filter((e) => e.kernel), weights = fieldWeights(0.75);
assert.deepEqual(dispatches[0].opts.params, { emaS: CHANNELS.map((c) => c.ema), emaM: MEDIA.map((m) => m.ema), reset: true, aer: 2, particleSplit: 0, world: 0 });
assert.equal(dispatches[0].opts.bind[1], sourceGroup);
assert.deepEqual(dispatches[1].opts.params, { w: weights.w, axis: 0 });
assert.equal(dispatches[1].opts.header, undefined);
assert.deepEqual(dispatches[7].opts.params, { bulk: weights.bulk, reach: [1, 1, 1], aer: 2 });
for (const e of dispatches) {
  const list = e.name === 'fieldEma' ? shaders.DIRTY.EMA : e.name.startsWith('fieldBoost') ? shaders.DIRTY.WORK : shaders.DIRTY.FIELDS;
  assert.deepEqual(e.size, { indirect: resources.dlist, offset: (shaders.dirtyLists(g).args + 4 * list) * 4 });
}
const noRebind = deriver.groups.ema;
deriver.setAeration({ buffer: aerBuffer, active: false }); assert.equal(deriver.groups.ema, noRebind); assert.equal(deriver.aer, 0);

// Instantiate the real Box adapter, preserving public aliases, dirty scheduling,
// onPass notifications, shifts' lazy factories and one destruction owner.
const sim = { gpu, id: 99, g, world: null, L: { TABLES: tablesLayout, STATE_RO: stateLayout, STATE_BUILD: stateLayout },
  tables, bindRO: sourceGroup, bindBuild: {}, smoothing: 1, incremental: true, actCarry: null, actAge: 0,
  attachDerived(d) { this.derived = d; }, onShift() { return () => {}; }, header() { return { src: 0, origin: [0, 0, 0] }; }, readHeader() { return this.header(); }, onPass(name) { events.push(name); } };
const box = new Derived(sim); await box.ready;
assert.equal(box.ema, box.fields.resources.ema); assert.equal(box.groups.blur, box.fields.groups.blur);
assert.equal(box.tmpB, box.fields.resources.tmpB);
assert(sim.fieldReset && sim.giReset && sim.changedAll);
gpu.trace.length = 0; box.updateDirty(); box.updateFields();
assert.deepEqual(gpu.trace.filter((e) => e.kernel).map((e) => e.name), ['age', 'dirty', 'dirtyArgs', ...events.slice(0, 8)]);
assert.equal(sim.fieldReset, false); assert.equal(box.frameNo, 1);
gpu.trace.length = 0;
assert.equal(box.setParticleSplit(true),true);box.updateFields();
for (const e of gpu.trace.filter(e=>e.kernel && (e.name==='fieldEma'||e.name.startsWith('fieldBoost')))) {
  assert.equal(e.opts.params.particleSplit,1);assert.equal(e.opts.params.world,0);
}
await box.prepare('shift', 'fieldMax', 'brickBits');
assert(box.passes.fieldShift && box.passes.fieldMax && box.passes.brickShift && box.passes.giShift);
const sharedTmpB = box.tmpB; box.dispose(); assert(sharedTmpB.destroyed);

let validates = 0, nagaAvailable = spawnSync('naga', ['--version'], { encoding: 'utf8' }).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'field-wgsl-'));
try {
  for (const n of [32, 64, 128]) {
    const grid = gridDims({ nx: n, ny: n, nz: n });
    // Actual slot/brick helpers, including all 128-cubed addresses.
    for (let s = 0; s < grid.slots; s++) assert.equal(cellSlot(grid, ...slotCell(grid, s)), s);
    for (const domain of ['box', 'world']) {
      const kgpu = new FieldTestGPU(), L = createFieldLayouts(kgpu);
      const ks = createFieldKernels(kgpu, grid, { tablesLayout, stateLayout, layouts: L, domain });
      if (domain === 'box') for (const [name, make] of Object.entries(createFieldHelpers(kgpu, grid, tablesLayout, L))) ks[name] = make();
      for (const [name, kernel] of Object.entries(ks)) {
        if (domain === 'box') assert.equal(hash(kernel.code), baseline.hashes[n][name], `${name}/${n} Box WGSL changed`);
        else {
          assert(!kernel.code.includes('var cover ='), 'world must not trust persistent normalized COVER');
          assert(kernel.code.includes('p >= P.hi')); assert(kernel.params.size <= 256);
          if (name.startsWith('fieldBoost')) assert(!kernel.code.includes('let q = clamp(p + dir * i, vec3i(0)'));
          if (['fieldEma', 'fieldBoost0'].includes(name)) assert(kernel.code.includes('if (!fieldInWorld(c))'));
          if (['fieldBlur', 'fieldFinal'].includes(name)) assert(kernel.code.includes('if (!fieldInWorld(q))'));
          if (name === 'fieldPeak') assert(kernel.code.includes('if (fieldInWorld(q))'));
        }
        const entries = kernel.layouts.flatMap((l) => l.entries);
        assert(entries.filter((e) => e.buffer?.type.includes('storage')).length <= 8);
        assert(entries.filter((e) => e.storageTexture).length <= 4);
        assert(entries.filter((e) => e.texture).length <= 16);
        assert.equal(kernel.layouts.length + 1, 4);
        if (nagaAvailable) {
          const path = join(dir, `${domain}-${n}-${name}.wgsl`); writeFileSync(path, kernel.code);
          const result = spawnSync('naga', [path], { encoding: 'utf8', timeout: 30_000 });
          assert.equal(result.status, 0, `${path}: ${result.stderr}`); validates++;
        }
      }
    }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(`PASS field deriver: Box resources/aliases/dirty/order/lazy helpers; exact WGSL hashes at 32/64/128; default binding limits; 2,392,064 slot round trips; Naga ${validates}/42${nagaAvailable ? '' : ' (CLI unavailable, skipped)'}`);

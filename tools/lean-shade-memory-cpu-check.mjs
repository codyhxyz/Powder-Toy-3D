// CPU only: validate the assembled WGSL and record real host allocation/dispatch paths.
import assert from 'node:assert/strict';
import { Derived } from '../src/derived.js';
import { E } from '../src/elements.js';
import { PHYS } from '../src/physics.js';
import { gridLayout, Simulation } from '../src/sim.js';
import { WGSL_CHECK as lightingChecks } from '../src/shaders/gfx/lighting.js';
import { materialProbe } from '../src/shaders/gfx/surface.js';
import { REALISTIC_LEVELS, volumeFrag } from '../src/shaders/render.js';
import { marchSplits, worldMarchFrag } from '../src/shaders/world/march.js';
import { BRIDGE } from '../src/shaders/v2.js';
import { makeMaterial } from '../src/v2/layout.js';
import { PhysicsV2 } from '../src/v2/physics.js';
import { nagaExec } from './naga.mjs';

Object.assign(globalThis, {
  GPUBufferUsage: { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 256, UNIFORM: 64 },
  GPUTextureUsage: { TEXTURE_BINDING: 4, STORAGE_BINDING: 8, COPY_SRC: 1, COPY_DST: 2 },
});

function fixture(n, { windowed = false, hold = null } = {}) {
  const allocations = [], dispatches = [], kernels = new Map();
  const buffer = (desc, bytes) => {
    const obj = { ...desc, bytes, destroy() { this.destroyed = true; } };
    allocations.push(obj);
    return obj;
  };
  const gpu = {
    L: { EMPTY: {} }, emptyGroup: {}, fits: () => true,
    queue: { writeBuffer() {}, onSubmittedWorkDone: async () => {} }, write() {}, flush() {},
    frame: { clear() {}, copy() {}, direct: () => ({ copyTextureToTexture() {} }) },
    readback: { buffer: async (_b, _at, n) => new ArrayBuffer(n) },
    layout: (name, entries) => ({ name, entries }),
    bindGroup(layout, entries, label) {
      assert.equal(entries.length, layout.entries.length, label);
      for (const { resource, binding } of entries) assert('buffer' in resource ? resource.buffer : resource, `${label}/${binding}`);
      return { layout, entries, label };
    },
    createBuffer: (desc) => buffer(desc, desc.size),
    createTexture(desc) {
      assert.equal(desc.format, 'rgba16float');
      const t = buffer(desc, desc.size.reduce((count, side) => count * side, 8));
      t.createView = (opts) => ({ texture: t, opts });
      return t;
    },
    kernel(desc) {
      const k = { ...desc, state: desc.build === 'manual' ? 'idle' : 'ready',
        build() { k.state = 'ready'; return k.ready; },
        dispatch(_frame, size, opts) {
          assert.equal(k.state, 'ready', desc.name);
          dispatches.push({ name: k.name, size, opts });
        },
      };
      k.ready = (hold && desc.name === 'v2args' ? hold : Promise.resolve()).then(() => k);
      kernels.set(k.name, k);
      return k;
    },
  };
  const sim = new Simulation(gpu, n, n, n, { windowed });
  const owner = new PhysicsV2(sim);
  const beforeDerived = allocations.length;
  const derived = new Derived(sim);
  assert.equal(allocations.length, beforeDerived, 'Derived construction allocates no storage');
  const legacy = () => allocations.filter((r) => /^sim\d+ [ABF]$/.test(r.label) && !r.destroyed);
  const legacyBytes = () => legacy().reduce((sum, r) => sum + r.bytes, 0);
  return { sim, owner, derived, allocations, dispatches, kernels, legacy, legacyBytes };
}

const f = fixture(128, { windowed: true });
const { sim, owner, derived } = f;
assert.equal(f.legacyBytes(), 0);
assert.equal(derived.allocated, false);
assert.equal(derived.bytes, 0);
await Promise.all([sim.ready, owner.ready, derived.ready, derived.prepareGI()]);
derived.resetGI();
assert.equal(derived.bytes, 0, 'readiness and an untouched GI reset preserve laziness');
assert.equal(f.legacyBytes(), 0);
assert.equal(sim.legacyAllocated, false);
assert.equal(sim.state.flow, sim.flow);
const readGroup = sim.bindRO;
assert.equal(readGroup.entries[0].resource.buffer, owner.cells);
assert.equal(sim.readHeader().format, 2);
assert(!owner.groups.import && !owner.groups.state);
const blank = f.dispatches.find((d) => d.name === 'v2blank');
assert(blank && blank.opts.bind[2] === owner.groups.v2);
const [word] = makeMaterial(E.EMPTY, PHYS.AMBIENT).core;
assert(f.kernels.get('v2blank').code.includes(`vec4u(${word}u, 0u, 0u, 0u)`));
assert.equal(owner.ticks(1), 1);
assert(!f.dispatches.some(({ name }) => ['fromAtlas', 'v2import', 'v2bridge'].includes(name)));

let at = f.allocations.length;
// Explicit resource consumer, then a full derived frame with no legacy cache.
const firstTexture = derived.fieldSurf;
const derivedAllocations = f.allocations.slice(at);
const bytes = derivedAllocations.reduce((sum, r) => sum + r.bytes, 0);
assert(derived.allocated && derived.bytes > 160 * 2 ** 20);
assert.equal(derived.bytes, bytes);
assert.equal(derived.fieldSurf, firstTexture);
assert.equal(derived.ensureAllocated().fieldSurf, firstTexture);
derived.updateBricks();
assert(f.dispatches.some(({ name }) => name === 'occupancy'));
assert.equal(f.legacyBytes(), 0, 'derived age binds only marks/activity and tiny stand-ins');
assert.equal(sim.state.A, sim.ensureLegacyState().A);
assert.equal(f.legacyBytes(), 72 * 2 ** 20);
let bridges = f.dispatches.filter(({ name }) => name === 'v2bridge');
assert.equal(bridges.length, 1);
assert.equal(bridges[0].opts.params.full, BRIDGE.ALL);
assert.deepEqual(f.legacy(), [sim.state.A, sim.state.B, sim.state.F]);
assert(owner.isReadGroup(readGroup), 'a cached native reader survives first legacy touch');
assert.equal(sim.bindRW.entries[0].resource.buffer, sim.state.A);
bridges = f.dispatches.filter(({ name }) => name === 'v2bridge');
assert.equal(bridges[1].opts.params.full, BRIDGE.FLIP);
assert.equal(f.legacyBytes(), 72 * 2 ** 20, 'writers reuse the allocated cache');
derived.dispose();
assert(derivedAllocations.every((r) => r.destroyed));
assert.equal(derived.bytes, 0);
const legacy = f.legacy();
owner.dispose(); sim.dispose();
assert(legacy.every((r) => r.destroyed));
assert.equal(sim.legacyAllocated, false);

for (const touch of ['updateBricks', 'updateGI', 'shift', 'dispose']) {
  const s = fixture(32, { windowed: true });
  await Promise.all([s.owner.ready, s.derived.ready]);
  assert.equal(s.derived.bytes, 0);
  at = s.allocations.length;
  if (touch === 'updateGI') assert.equal(s.derived.updateGI({ frame: {} }), false, 'first call requests cold GI shaders');
  else if (touch === 'shift') s.derived.shift(16, 0);
  else s.derived[touch]();
  assert.equal(s.derived.allocated, touch !== 'dispose');
  assert.equal(s.derived.bytes, s.allocations.slice(at).reduce((sum, r) => sum + r.bytes, 0));
  assert.equal(s.legacyBytes(), 0);
  const beforeDispose = s.allocations.length;
  s.derived.dispose(); s.owner.dispose(); s.sim.dispose();
  assert.equal(s.allocations.length, beforeDispose);
  assert.equal(s.legacyBytes(), 0, 'dispose never materializes the cache');
}

// Before the bridge builds, a legacy read still sees blank defaults, and a load replaces them.
for (const load of [false, true]) {
  let release;
  const early = fixture(32, { hold: new Promise((resolve) => { release = resolve; }) });
  await early.sim.ready;
  assert.equal(early.owner.isReady, false);
  assert.equal(early.legacyBytes(), 0);
  if (load) early.sim.load(...early.sim.blankState());
  else assert(early.sim.ensureLegacyState().A);
  const writes = early.dispatches.filter(({ name }) => name === 'fromAtlas');
  assert.equal(writes.length, 1, 'no second blank load on first-touch replacement');
  assert(writes[0].opts.bind[2].entries[0].resource.buffer);
  release(); await early.owner.ready;
  early.owner.sync();
  assert(early.dispatches.some(({ name, opts }) => name === 'v2import' && opts.params.full === 1));
  early.derived.dispose(); early.owner.dispose(); early.sim.dispose();
}

const g = gridLayout(32, 32, 32);
const modules = lightingChecks().map((e) => [e.name, e.code(g)]);
for (const level of ['off', 'balanced', 'full']) {
  const detail = REALISTIC_LEVELS[level]();
  modules.push([`material-${level}`, materialProbe(g, detail)], [`box-${level}`, volumeFrag(g, { detail, fixedReadFormat: 2 })]);
  for (const optics of [true, false]) {
    const stage = marchSplits(detail) ? 'shade' : 'whole';
    const source = worldMarchFrag(g, { detail, stage, optics });
    assert(source.includes('const PCSS_TAPS: i32 = 4;'));
    assert(source.includes('const LAMP_MAX_STEPS: i32 = 24;'));
    assert(source.includes('ign(gFragCoord'));
    assert(source.includes('select(8, 27, exact)'));
    assert(source.includes('if (id == E_SAND) { m.g += SAND_SLUMP_H * sandSlumps(p, fp).yzw; }'));
    modules.push([`world-${stage}-${level}-${optics}`, source]);
  }
}
modules.push(['v2blank', f.kernels.get('v2blank').code], ['derived-age', derived.kernels.age.code]);
for (const [name, code] of modules) nagaExec(code, `${name}.wgsl`);
console.log(`Lean shade/memory: ${modules.length} Naga validations; zero legacy/derived bytes at V2 startup, ${(bytes / 2 ** 20).toFixed(1)} MiB of Derived and 72 MiB of legacy on demand; native tick, shift, disposal and early legacy import passed`);

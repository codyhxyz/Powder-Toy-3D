// CPU only (fake device + Naga), no GPU or browser: the World view pipeline, a big map's
// longest cold build (~10 s in Chrome after a deploy), is one module for every world size,
// and the build its map starts early (wire/world.js attach -> startWorldFrameView, beside the
// world's generation) is the very pipeline the first frame then draws with.
// Run: node --test tools/world-view-early-cpu-check.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { volumeFrag, REALISTIC_LEVELS } from '../src/shaders/render.js';
import { tableLayout } from '../src/shaders/common.js';
import { WORLD_SCENES } from '../src/world/scenes/index.js';
import { WORLD_SIZE } from '../src/shaders/farShared.js';
import { WorldRenderAtlas } from '../src/world/renderAtlas.js';
import { worldSunFeedbackWords, worldSunProjection } from '../src/world/worldSun.js';
import { createWorldVolume, startWorldView } from '../src/gfx/worldVolume.js';
import { WORLD_APPEARANCE_GRID } from '../src/gfx/worldAppearance.js';
import { worldViewOf, startWorldFrameView } from '../src/wire/worldRenderFrame.js';
import { WORLD_NATIVE } from '../src/shaders/gfx/liquidDetail.js';
import { VIEWS } from '../src/views.js';
import { gateVariants } from '../src/gfx/detailGate.js';
import { detailDefaults } from '../src/gfx/detail.js';
import { nagaSpawn } from './naga.mjs';

// Every World world: the registered scenes and the converted source levels (as check-world-fit.mjs).
function worldSizes() {
  const sizes = new Map();
  for (const scene of WORLD_SCENES) { const s = [...(scene.size ?? WORLD_SIZE)]; sizes.set(s.join('x'), s); }
  const local = new URL('../public/local-maps/', import.meta.url);
  for (const file of readdirSync(local).filter((f) => f.endsWith('.json'))) {
    const manifest = JSON.parse(readFileSync(new URL(file, local)));
    if (Array.isArray(manifest.size)) sizes.set(manifest.size.join('x'), manifest.size);
  }
  return [...sizes.values()];
}

test('one World view module serves every world size (one cold compile per view, not per map and view)', () => {
  const sizes = worldSizes();
  assert.ok(sizes.length >= 4, `World sizes found: ${sizes.length}`);
  const detail = REALISTIC_LEVELS.balanced();
  let modules = 0;
  for (const view of ['realistic', 'noita', 'cozy', 'plain', 'heat']) for (const curved of [false, true]) for (const sourceAppearance of [false, true]) {
    const codes = new Set(sizes.map(([nx, ny, nz]) => volumeFrag({ nx, ny, nz, sourceAppearance, sourceGrid: WORLD_APPEARANCE_GRID }, { backend: 'world', view, detail, curved })));
    assert.equal(codes.size, 1, `${view}${curved ? ' curved' : ''}${sourceAppearance ? ' source' : ''}: ${codes.size} modules for ${sizes.length} world sizes`);
    const [code] = codes;
    assert.doesNotMatch(code, /\bconst (NX|NY|NZ|BX|BY|BZ|GRID|MAX_STEPS)\b/, 'no world size spelt into the module');
    assert.match(code, /fn worldGrid\(\) -> vec3i \{ return vec3i\(WA\.world\.xyz\); \}/);
    modules++;
  }
  // and the module startWorldView builds before any world exists is that same module
  const early = volumeFrag({ sourceAppearance: false, sourceGrid: WORLD_APPEARANCE_GRID }, { backend: 'world', view: 'realistic', detail });
  assert.equal(early, volumeFrag({ nx: sizes[0][0], ny: sizes[0][1], nz: sizes[0][2] }, { backend: 'world', view: 'realistic', detail }));
  console.log(`PASS ${modules} World view modules, each shared by all ${sizes.length} world sizes`);
});

test('the shared module validates in Naga (flat, curved, Plain, source artwork)', () => {
  const naga = spawnSync('naga', ['--version'], { encoding: 'utf8' });
  assert.equal(naga.status, 0, 'install the CPU naga CLI for this gate');
  for (const [view, curved, sourceAppearance] of [['realistic', false, false], ['realistic', true, true], ['plain', false, false], ['noita', false, false]]) {
    const code = volumeFrag({ sourceAppearance, sourceGrid: WORLD_APPEARANCE_GRID }, { backend: 'world', view, detail: REALISTIC_LEVELS.full(), curved });
    const r = nagaSpawn(code, `world-${view}.wgsl`, {encoding: 'utf8'});
    assert.equal(r.status, 0, `${view}: ${r.stdout}\n${r.stderr}`);
  }
});

// A device double: pipelines settle when the test says, every request recorded.
function fakeGpu() {
  const render = [], pending = [], outside = [];
  const device = {
    limits: {}, queue: { writeBuffer() {}, writeTexture() {}, onSubmittedWorkDone: () => Promise.resolve() },
    createBuffer: (d) => ({ ...d, data: new Uint8Array(d.size), destroy() {} }),
    createTexture: (d) => ({ ...d, createView: () => ({}), destroy() {} }),
    createBindGroupLayout: (d) => d, createPipelineLayout: (d) => d, createSampler: (d) => d, createShaderModule: (d) => d, createBindGroup: (d) => d,
    createRenderPipelineAsync(d) { render.push(d); return new Promise((resolve) => pending.push(() => resolve({ d }))); },
    createComputePipelineAsync(d) { return new Promise((resolve) => pending.push(() => resolve({ d }))); },
  };
  const gpu = { device, pipelines: { outside(p) { outside.push(p); return p; } } };
  return { gpu, device, render, outside, settle: () => { for (const f of pending.splice(0)) f(); } };
}
function worldVolume(f, worldSize) {
  const sun = worldSunProjection(worldSize, [1, .01, 0]);
  const atlas = new WorldRenderAtlas(f.gpu, { worldSize, initialCapacity: 1, feedbackExtraWords: worldSunFeedbackWords(sun.tiles), retire: (fn) => fn() });
  const [nx, ny, nz] = worldSize;
  return { atlas, volume: createWorldVolume(f.gpu, { g: { nx, ny, nz }, atlas, tables: f.device.createBuffer({ size: tableLayout().Tables.size }) }) };
}

test('the early build is the pipeline every world\'s first frame draws with', async () => {
  const f = fakeGpu(), detail = REALISTIC_LEVELS.balanced();
  const ready = startWorldView(f.gpu, { view: 'realistic', detail, sourceGrid: WORLD_APPEARANCE_GRID });
  assert.equal(f.render.length, 1, 'one native build, started before any world exists');
  assert.equal(f.outside.length, 1, 'counted against the pipeline cache\'s bound (gpu/kernels.js outside)');
  const early = f.render[0];
  for (const size of [[128, 128, 128], [256, 64, 128]]) {
    const { atlas, volume } = worldVolume(f, size);
    const state = volume.pipelineState('realistic', detail, false);
    assert.equal(f.render.length, 1, `${size.join('×')}: no second build of the same module`);
    f.settle(); await ready;
    assert.equal((await state.ready).d, early, `${size.join('×')} draws the early pipeline`);
    assert.equal(state.state, 'ready');
    await volume.compilationSettled;
    volume.dispose(); atlas.dispose();
  }
  // another view is its own module and build
  const { atlas, volume } = worldVolume(f, [128, 128, 128]);
  volume.pipelineState('noita', detail, false);
  assert.equal(f.render.length, 2);
  f.settle(); await volume.compilationSettled; volume.dispose(); atlas.dispose();
});

test('the early build asks for the view the first frame asks for', () => {
  const settings = { view: VIEWS.find((v) => v.key === 'noita').id, ...detailDefaults() };
  const near = gateVariants(settings).near;
  const v2 = worldViewOf({ settings, sim: { compact: {} }, presentation: { active: true, parameters: { k: 1e-4 } } });
  assert.deepEqual(v2, { view: 'noita', detail: { ...near, [WORLD_NATIVE]: true }, curved: true });
  const v1 = worldViewOf({ settings, sim: { compact: null }, presentation: { active: false, parameters: { k: 1e-4 } } });
  assert.deepEqual(v1, { view: 'noita', detail: near, curved: false });
  // a failure only loses the head start: the map's build goes on
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(startWorldFrameView({ settings, sim: null, presentation: null, gpu: { device: null } }, null), null); }
  finally { console.warn = warn; }
  // and the map's build starts it before the world's window and generation (wire/world.js attach)
  const source = readFileSync(new URL('../src/wire/world.js', import.meta.url), 'utf8');
  const attach = source.slice(source.indexOf('  attach(app) {'));
  assert.ok(attach.indexOf('startWorldFrameView(app, scene)') >= 0 && attach.indexOf('startWorldFrameView(app, scene)') < attach.indexOf('new WorldWindow('));
});

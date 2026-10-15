// CPU only. Execute production host methods; shader snapshots are the pre-change
// 8d5ad463 generic ABI. No browser/device or timing claim.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Matrix4 } from 'three/webgpu';
import { gridLayout } from '../src/sim.js';
import { LEGACY_PRESSURE_PA } from '../src/v2/pressure.js';
import { prelude, STATE_OPTS } from '../src/shaders/common.js';
import { moveBlockFrag } from '../src/shaders/move.js';
import { volumeFrag, pickFrag, warmChecks, VOLUME_VIEWS, volumePipeline, VolumeParams, VOLUME_VERTICES, VOLUME_SCREEN_VERTICES } from '../src/shaders/render.js';
import { volumeReadFormat, detailKey, volumeShaderGrid } from '../src/gfx/volume.js';
import { createReadyVolumeView } from '../src/gfx/readyVolumeView.js';
import { isMaterialView } from '../src/views.js';
const g = gridLayout(32, 32, 32), hash = s => createHash('sha256').update(s).digest('hex');
const baseline = {
  ro: 'e2a1e0d56d584d171e6acd19521d730d36910adbecc268aa4146e1f3e7e845a0',
  rw: '7cace457fd34ae24250c20222ef0181d9e843d11bbfc0b9809715fef2d604683',
  move: 'c630fbf8f7dd7a5fe0858cc661c873534ce73b1961ad796016d94ffb229b7c13',
  pick: '4a9ce710be24487274c398f64c59475f606ffb31a67561a16ba63f8ff4bd33d2',
  volume: 'b3ebec44f3407a3919b273d67b5a095fc0ffdddc53ad3d38eb296c8277b2f169',
  detail: '11b580f9bd7553b8896756c2dc5fc80f9014c0575f3ace85a1e5214537bc914a',
};
const sources = { ro: prelude(g, STATE_OPTS.STATE_RO), rw: prelude(g, STATE_OPTS.STATE_RW), move: moveBlockFrag(g), pick: pickFrag(g),
  volume: volumeFrag(g), detail: volumeFrag(g, { detail: { DETAIL_LIQ_FOAM: 1, DETAIL_LIQ_RIPPLES: 1 }, curved: true }) };
for (const [key, code] of Object.entries(sources)) assert.equal(hash(code), baseline[key], `unchanged generic ${key}`);
for (const bad of [null, 1, 4, -1, '2', NaN]) assert.throws(() => volumeFrag(g, { fixedReadFormat: bad }), /fixedReadFormat/);
for (const state of ['read_write', false]) assert.throws(() => prelude(g, { state, fixedReadFormat: 0 }), /readonly/);
for (const format of [0, 2, 3]) {
  // Exact substitution of the header value is the oracle, not a second decoder.
  assert.equal(prelude(g, { state: 'read', fixedReadFormat: format }), sources.ro.replaceAll('H.format', `${format}u`));
  const code = volumeFrag(g, { fixedReadFormat: format, detail: { DETAIL_LIQ_FOAM: 1 } });
  assert(!code.includes('H.format'), `all volume format switches specialize ${format}`);
  assert(code.includes('H.src * SLOTS + s'), 'legacy ping-pong retained');
  assert(code.includes('core = compactProbeCore(core)'), 'physical one-quantum normalization retained');
  assert(code.includes(`air.w / ${LEGACY_PRESSURE_PA}`), 'coarse-air conversion retained');
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const sim = { compact: null, readHeader: () => ({ format: 0 }) }, gpuMode = { testMode: 'visual' };
assert.equal(volumeReadFormat(sim, gpuMode), 0);
const native = sim.compact = { isReady: false, disposed: false, forceCompatibility: false };
assert.equal(volumeReadFormat(sim, gpuMode), 2, 'forecast unready active native');
native.forceCompatibility = true; assert.equal(volumeReadFormat(sim, gpuMode), 0);
assert.equal(volumeReadFormat(sim, { testMode: null }), 2, 'compatibility flag is test-only');
native.forceCompatibility = false; native.disposed = true; assert.equal(volumeReadFormat(sim, gpuMode), 0);
native.disposed = false; native.isReady = true; sim.readHeader = () => ({ format: 3 });
assert.equal(volumeReadFormat(sim, gpuMode), 3, 'actual ready header honored');
sim.compact = null; assert.equal(volumeReadFormat(sim, gpuMode), 3, 'suspended owner does not forecast');
sim.compact = native; native.isReady = false; assert.equal(volumeReadFormat(sim, gpuMode), 2);

const volumeSource = readFileSync(new URL('../src/gfx/volume.js', import.meta.url), 'utf8');
function method(name) {
  const start = volumeSource.indexOf(`    ${name}(`, volumeSource.indexOf('  const volume = {')), end = volumeSource.indexOf('\n    },', start);
  assert(start >= 0 && end > start);
  return 'function ' + volumeSource.slice(start + 4, end) + '\n}';
}
function productionVolume() {
  const descs = [], draws = [], pipes = new Map();
  let header = { format: 0 }, reads = 0;
  const sim = { g, compact: null, bindRO: 'state', readHeader() { reads++; return header; } };
  const gpu = { testMode: 'visual', renderPipeline(desc) {
    descs.push(desc); return { state: 'ready', ready: Promise.resolve(), build() {}, draw(_rp, opts) { draws.push(opts); } };
  } };
  const volume = { get format() { return volumeReadFormat(sim, gpu); } };
  const state = { volume, sim, gpu, pipes, g: volumeShaderGrid(g), VOLUME_VIEWS, isMaterialView, drawable: d => d,
    detailKey, volumeReadFormat, volumeFrag, VolumeParams, volumePipeline, L: {}, Matrix4,
    isCurved: w => !!w?.k, meshInv: new Matrix4(), fu: { last: { viewProj: new Matrix4(), model: new Matrix4() } },
    dummy: { depth: { width: 1, height: 1 } }, volumeFrameGroup: () => ({}), lightingGroup: () => ({}),
    decoShown: () => false, VOLUME_VERTICES, VOLUME_SCREEN_VERTICES };
  for (const name of ['pipeline', 'draw']) volume[name] = new Function('state', `with(state) { return ${method(name)}; }`)(state);
  return { volume, sim, gpu, descs, draws, setHeader(h) { header = h; }, reads: () => reads };
}
const p = productionVolume();
p.sim.compact = { isReady: false };
p.volume.pipeline('realistic'); assert.match(p.descs[0].name, /format2$/);
assert(p.descs.every(d => !d.name.endsWith('format0')), 'no unused startup format0 compilation');
const before = p.reads(); assert.equal(p.volume.draw(null), false); assert.equal(p.reads() - before, 1);
p.sim.compact.isReady = true; p.setHeader({ format: 2 });
const current = p.reads(); assert.equal(p.volume.draw(null), true); assert.equal(p.reads() - current, 1, 'one actual draw header snapshot');
assert.equal(p.draws.at(-1).header.format, 2);
p.sim.compact = null; p.setHeader({ format: 0 }); p.volume.pipeline('realistic');
assert.equal(p.descs.length, 2); assert.notEqual(p.descs[0].code, p.descs[1].code);
p.sim.compact = { isReady: true }; p.setHeader({ format: 2 }); p.volume.pipeline('realistic'); assert.equal(p.descs.length, 2, 'reactivation reuses native pipeline');
p.sim.compact.forceCompatibility = true; p.setHeader({ format: 0 }); p.volume.pipeline('realistic'); assert.equal(p.descs.length, 2);
for (const curved of [false, true]) for (const view of ['realistic', 'heat']) {
  const settings = { detail_liqFoam: true, detail_smoothClose: true };
  for (const entry of warmChecks(view, settings, { curved, fixedReadFormat: 0 }).filter(e => e.name.startsWith('volume.'))) {
    const runtime = productionVolume(); runtime.volume.pipeline(view, entry.detail, 'now', curved);
    assert.equal(entry.code(volumeShaderGrid(g)), runtime.descs[0].code, 'warm/runtime text identity');
    assert.equal(entry.name, runtime.descs[0].name, 'warm/runtime labels match');
  }
}
const retention = createReadyVolumeView(), owner = {}, old = { view: 'realistic', curved: false, format: 2 };
retention.select(owner, old, [{ state: 'ready' }]);
const same = { ...old, view: 'cozy' }; assert.equal(retention.select(owner, same, [{ state: 'pending' }]), old);
const changed = { ...same, format: 0 }; assert.equal(retention.select(owner, changed, [{ state: 'pending' }]), changed);
retention.select(owner, old, [{ state: 'ready' }]);
const bent = { ...old, curved: true }; assert.equal(retention.select(owner, bent, [{ state: 'pending' }]), bent);
assert.equal(retention.select({}, same, [{ state: 'pending' }]), same);
assert.equal(retention.select(owner, { view: 'plain', format: 2 }, [{ state: 'pending' }]).view, 'plain');

const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
function block(source, marker) { const start = source.indexOf(marker); assert(start >= 0); let i = source.indexOf('{', start), n = 1;
  for (i++; n; i++) { if (source[i] === '{') n++; if (source[i] === '}') n--; } return source.slice(start, i); }
const coreStart = app.indexOf('  const nativeOwner = physicsV2;'), coreEnd = app.indexOf('\n  core.catch', coreStart);
const makeCore = new Function('state', `with(state) { return async function() { ${app.slice(coreStart, coreEnd)}; return core; }; }`);
const ready = deferred(), integration = deferred(), c = productionVolume();
c.sim.compact = { isReady: false };
const context = { physicsV2: { ready: ready.promise, integrationReady: integration.promise }, coreWait: null, coreReady: false,
  s: { ready: Promise.resolve() }, derived: { ready: Promise.resolve() }, vol: Object.assign(c.volume, { ready: Promise.resolve(), noiseReady: Promise.resolve(), viewReady(v,d,b) { return this.pipeline(v,d,'now',b).ready; } }),
  post: { ready: Promise.resolve() }, overlays: { ready: Promise.resolve() }, brush: { ready: Promise.resolve() }, blocks: null,
  settings: { view: 'realistic' }, viewKeyOf: v => v, baseDetail: () => ({}), warpNow: () => null, wakeLoop() {} };
const cp = makeCore(context)(); let done = false; cp.then(() => { done = true; });
await Promise.resolve(); assert.equal(done, false); assert(c.descs.every(d => d.name.endsWith('format2')));
context.physicsV2 = null; ready.resolve(); await Promise.resolve(); assert.equal(done, false, 'captured integration still blocks');
integration.resolve(); await cp; assert.equal(context.coreReady, true);
const thumbGate = deferred(), thumbVol = { format: 2, viewReady: () => thumbGate.promise };
const thumbState = { graphicsFailure: null, coreReady: true, viewKeyOf: v => v, isMaterialView, gateVariants: () => ({ base: {} }),
  settings: {}, vol: thumbVol, blocks: null, viewShadows: () => false };
const thumb = new Function('state', `with(state) { return ${block(app, 'async function renderThumb(')}; }`)(thumbState);
const tp = thumb('realistic', null); thumbVol.format = 0; thumbGate.resolve(); assert.equal(await tp, false, 'stale thumbnail cancels before GPU draw');
assert.match(app, /curved: !!warpNow\(\)\?\.k, format/);
assert.match(app, /volumeFormat !== format\) \{ post.reset\(\); meshFrames.drop\(\); sim.resetGI\(\)/);
assert.match(app, /\$\{giBuilt\}\|\$\{blocksOn\}\|\$\{vol.format\}/);
assert.match(app, /\$\{presentation.key\}\|\$\{vol.format\}/);
assert.match(readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8'), /warmChecks\(view, settings, \{ fallback, curved, fixedReadFormat: 0 \}\)/);

const dir = mkdtempSync(join(tmpdir(), 'volume-format-'));
try {
  for (const format of [0, 2, 3]) for (const curved of [false, true]) {
    const file = join(dir, `${format}-${curved}.wgsl`);
    writeFileSync(file, volumeFrag(g, { fixedReadFormat: format, curved, detail: { DETAIL_LIQ_FOAM: 1, DETAIL_LIQ_RIPPLES: 1 } }));
    const result = spawnSync('naga', [file], { encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('Volume format CPU: six generic/RW hashes unchanged; formats 0/2/3, actual cache/draw/startup/thumbnail/retention methods, warm identity and six Naga modules passed');

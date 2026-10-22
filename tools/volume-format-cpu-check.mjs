// CPU only. Execute production host methods; shader snapshots are the pre-change
// dcd03636 generic ABI, captured before specialization after production merge.
// Only volume/detail changed from 8d5ad463, retaining production's cave fixes.
// No browser/device or timing claim.
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
import { compactDecodeWGSL } from '../src/shaders/compact.js';
import { moveBlockFrag } from '../src/shaders/move.js';
import { volumeFrag, pickFrag, warmChecks, VOLUME_VIEWS, volumePipeline, VolumeParams, VOLUME_VERTICES, VOLUME_SCREEN_VERTICES } from '../src/shaders/render.js';
import { volumeReadFormat, readsAir, detailKey, volumeShaderGrid } from '../src/gfx/volume.js';
import { createReadyVolumeView } from '../src/gfx/readyVolumeView.js';
import { isMaterialView } from '../src/views.js';
const g = gridLayout(32, 32, 32), hash = s => createHash('sha256').update(s).digest('hex');
// Re-pinned 2026-10-20 against origin/main 6a056d8d (unpinned since f86a20c8, as this check wasn't in CI).
// Every generic shader moved with intended work only, hashed at each first-parent commit between: the
// prelude (ro, rw) with Descent's four exact-terrain elements (07f0ca91), the birds' removal (ea102f19, T_FLOCK)
// and the Noita view's appearance variants (0da2ef45); move, pick and the volume with the V2 and render merges.
// Then (wave 4, 2026-10-20) the volume and its detail variant: the distance haze (farShared.js volumeHaze), over origin/main bb37db6e.
// Re-pinned 2026-10-21 (cold compile): only the lamp and beacon shadow rays moved (lighting.js lampLights/lampShade/lampSpecSeen, lighthouse.js beaconRay/beaconFarClear/beaconMaxSteps/beaconVisible; one traceNearSteps call site, crystals skip the beam), diffed against origin/main 186cefd7; the volume and its detail variant only.
const baseline = {
  ro: 'd92592ba9576e9c02a65919e3badf678beb30dc58576e8fa22d4bf520d9174ed',
  rw: '338e904f3a7cce43eab8e931d3610b2e9c36d58ac2f7a4bc2d5a94acf39380ea',
  move: '15befffbaa07f695efdc6970792bbc6f5bee4b25c3781fba3e2dbccc227e8026',
  pick: 'debfa4a3adc9ee44fb37c263209b75fc88f1427fc1b35c298af82f1acfc370c9',
  volume: 'e4c3443f7527e6ca144e6a71a91f2b487f78bd93f0ea868a9cccbccd816cb9da',
  detail: 'd3308a6d02042db7a009210a14ede172ffd936424cc35b90048884dd7f7dd03d',
};
const sources = { ro: prelude(g, STATE_OPTS.STATE_RO), rw: prelude(g, STATE_OPTS.STATE_RW), move: moveBlockFrag(g), pick: pickFrag(g),
  volume: volumeFrag(g), detail: volumeFrag(g, { detail: { DETAIL_LIQ_FOAM: 1, DETAIL_LIQ_RIPPLES: 1 }, curved: true }) };
for (const [key, code] of Object.entries(sources)) assert.equal(hash(code), baseline[key], `unchanged generic ${key}`);
for (const bad of [null, 1, 4, -1, '2', NaN]) assert.throws(() => volumeFrag(g, { fixedReadFormat: bad }), /fixedReadFormat/);
for (const state of ['read_write', false]) assert.throws(() => prelude(g, { state, fixedReadFormat: 0 }), /readonly/);
// The prelude's state readers: from their first line through fetchB, the last of them.
const FETCH_B = 'fn fetchB(p: vec3i) -> vec4f { return fetchBs(slotOf(p)); }';
function readers(code, first) {
  const start = code.indexOf(first), end = code.indexOf(FETCH_B, start) + FETCH_B.length;
  assert(start >= 0 && end > start, 'state readers found');
  return { head: code.slice(0, start).trimEnd(), body: code.slice(start, end), tail: code.slice(end) };
}
for (const format of [0, 2, 3]) {
  const fixed = prelude(g, { state: 'read', fixedReadFormat: format }), substituted = sources.ro.replaceAll('H.format', `${format}u`);
  if (format === 0) {
    // Committed to V1's read format: V1-only readers, no compact decoder or its tables (the Physics V2 merge,
    // 8946dd2d: the Test view's smooth draw statically used a table its vertex stage can't bind). Outside
    // the readers, still the header value substituted, exactly.
    const own = readers(fixed, 'fn fetchAs('), generic = readers(substituted, compactDecodeWGSL);
    assert.equal(own.head, generic.head); assert.equal(own.tail, generic.tail);
    assert(!/compact/i.test(own.body), 'no compact decoder in V1-only readers');
    assert(own.body.includes('return bitcast<vec4f>(A[H.src * SLOTS + s]);') && own.body.includes('return B[H.src * SLOTS + s];'), 'V1 ping-pong reads');
  } else {
    // Exact substitution of the header value is the oracle, not a second decoder.
    assert.equal(fixed, substituted);
  }
  const code = volumeFrag(g, { fixedReadFormat: format, detail: { DETAIL_LIQ_FOAM: 1 } });
  assert(!code.includes('H.format'), `all volume format switches specialize ${format}`);
  assert(code.includes('H.src * SLOTS + s'), 'legacy ping-pong retained');
  if (format === 0) assert(!code.includes('compactProbeCore'), 'format 0 carries no compact decoder');
  else {
    assert(code.includes('core = compactProbeCore(core)'), 'physical one-quantum normalization retained');
    assert(code.includes(`air.w / ${LEGACY_PRESSURE_PA}`), 'coarse-air conversion retained');
  }
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
    detailKey, volumeReadFormat, readsAir, volumeFrag, VolumeParams, volumePipeline, L: {}, Matrix4,
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
  hybridWait: Promise.resolve(), worldMode: false,   // (app.js since: the hybrid engine's load, and a World session draws no Box view)
  settings: { view: 'realistic' }, viewKeyOf: v => v, baseDetail: () => ({}), warpNow: () => null, wakeLoop() {} };
const cp = makeCore(context)(); let done = false; cp.then(() => { done = true; });
await Promise.resolve(); assert.equal(done, false); assert(c.descs.every(d => d.name.endsWith('format2')));
context.physicsV2 = null; ready.resolve(); await Promise.resolve(); assert.equal(done, false, 'captured integration still blocks');
integration.resolve(); await cp; assert.equal(context.coreReady, true);
const thumbGate = deferred(), thumbVol = { format: 2, viewReady: () => thumbGate.promise };
const thumbState = { graphicsFailure: null, coreReady: true, viewKeyOf: v => v, isMaterialView, gateVariants: () => ({ base: {} }),
  settings: {}, vol: thumbVol, blocks: null, viewShadows: () => false, win: null };   // (win: a Box session's thumbnail, not a World's)
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

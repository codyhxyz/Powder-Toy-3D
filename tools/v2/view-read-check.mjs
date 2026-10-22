// CPU only: the Box draw's reads of Physics V2's cells and air (v2f/drawread).
// D   the volume's readers (shaders/compact.js compactDrawWGSL, executed) decode as fetchA does,
//     every native volume module reads through them, and V1's draw (format 0) is byte-identical.
// R1  V2's read group binds dynamics' current air in B, and the derived frame sets the brick
//     map's air flags from it (shaders/v2/viewAir.js) under V2 only.
// R2  V1's B as V2 holds it (shaders/v2/viewRead.js nativeMotionB, executed): a grain's fall, a
//     liquid's flux, still solids, the air elsewhere; the Flow view and World's export use it.
// R3  the realistic module's "Smoke follows the flow" reads it too.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ELEMENTS, E, K } from '../../src/elements.js';
import { PHASE_ROWS } from '../../src/v2/phase.js';
import { lifeScale } from '../../src/v2/layout.js';
import { compactDecodeWGSL } from '../../src/shaders/compact.js';
import { SEED_MAX } from '../../src/shaders/common.js';
import { gridLayout } from '../../src/sim.js';
import { volumeFrag, VOLUME_VIEWS } from '../../src/shaders/render.js';
import { nativeMotionWGSL } from '../../src/shaders/v2/viewRead.js';
import { nativeBrickAirWGSL } from '../../src/shaders/v2/viewAir.js';
import { nativeAirWGSL } from '../../src/shaders/renderSource.js';
import { brickFrag, AIR_FLAG } from '../../src/shaders/passes.js';
import { WEATHER_SPEED_SI, WEATHER_SPEED_FLUX } from '../../src/v2/nativeWeather.js';
import { LEGACY_PRESSURE_PA } from '../../src/v2/pressure.js';
import { Derived } from '../../src/derived.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { Simulation } from '../../src/sim.js';

let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; };

function body(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  assert(start >= 0, `missing ${name}`);
  const brace = source.indexOf('{', start);
  let end = brace + 1, depth = 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  return source.slice(brace + 1, end - 1);
}
function execute(source, name, args, env) {
  const js = body(source, name)
    .replace('var core = c;', 'var core = { ...c };')
    .replace(/\blet\b/g, 'const').replace(/\bvar\b/g, 'let')
    .replace(/\b(0x[\da-f]+|\d+)u\b/gi, '$1').replace(/>>/g, '>>>');
  return new Function(...Object.keys(env), `return function(${args}) { ${js} };`)(...Object.values(env));
}

// ---- D: V1's draw unchanged; every native volume read goes through the draw's readers ----
const g = gridLayout(32, 32, 32);
const detail = { DETAIL_LIQ_FOAM: 1, DETAIL_LIQ_MENISCUS: 1, DETAIL_LIQ_RIPPLES: 1, DETAIL_MEDIA_STEP: 1, DETAIL_MEDIA_FLOW: 1 };
// V1's (format 0) volume, every view, flat and curved: pinned at origin/main 19a98c9e.
const v1 = createHash('sha256');
for (const view of VOLUME_VIEWS) for (const curved of [false, true]) v1.update(volumeFrag(g, { view, detail, curved, fixedReadFormat: 0 }));
assert.equal(v1.digest('hex'), '1ccdc46bb28d77e6196c8358223825c0b3460d3e4bdb7cfa086bca31ab5bbaf6', 'V1 draw byte-identical');
checks++;
const calls = (code, name) => (code.match(new RegExp(`(?<![\\w.])${name}\\(`, 'g')) ?? []).length - (code.match(new RegExp(`fn ${name}\\(`, 'g')) ?? []).length;
for (const format of [2, 3]) for (const view of VOLUME_VIEWS) for (const curved of [false, true]) {
  const code = volumeFrag(g, { view, detail, curved, fixedReadFormat: format });
  ok(calls(code, 'fetchA') === 0 && calls(code, 'fetchB') === 0, `${view} format ${format}: no generic cell read left`);
  ok(!/eid\(volumeA\(/.test(code), `${view}: an ID probe reads volumeId`);
  ok(code.includes('fn volumeA(') && code.includes('fn volumeT(') && code.includes('fn volumeB('), 'readers present');
}

// The readers, executed against the full decoder (compactA via fetchAs's canonical coordinate).
const p = [-1, 4, 33], canonical = [31, 4, 1];
let core, thresholdBits, kindOverride = null, colourBits = 0, state = 0x5bd1e995;
const random = () => state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
const env = {
  KIND: id => kindOverride ?? ELEMENTS[id]?.kind ?? K.EMPTY,
  K_EMPTY: K.EMPTY, K_LIQUID: K.LIQUID, E_EMPTY: E.EMPTY,
  i32: x => x | 0, u32: x => x >>> 0, f32: Math.fround, max: Math.max, SEED_MAX,
  select: (a, b, test) => test ? b : a,
  vec4f: (x, y, z, w) => ({ x: Math.fround(x), y, z, w }),
  seed3: (position, tick, salt) => {
    assert.deepEqual(position, canonical); assert.equal(tick, 0); assert([991, 4243].includes(salt));
    return salt === 4243 ? thresholdBits : colourBits;
  },
  COMPACT_HOT_T: PHASE_ROWS.map(r => r.hotQ), COMPACT_COLD_T: PHASE_ROWS.map(r => r.coldQ),
  COMPACT_CONDUCTS: ELEMENTS.map(e => e.elec > 0), COMPACT_LIFE_SCALE: ELEMENTS.map(e => lifeScale(e.id)),
  COMPACT_CTYPE_MASK: ELEMENTS.map(e => e.burnRate > 0 ? 127 : 255),
  slotOf: position => { assert.deepEqual(position, p); return 73; },
  cellOf: slot => { assert.equal(slot, 73); return canonical; },
  A: new Proxy({}, { get: (_, k) => { assert.equal(k, '73'); return core; } }),
};
env.compactTq = execute(compactDecodeWGSL, 'compactTq', 'c', env);
env.compactProbeCore = execute(compactDecodeWGSL, 'compactProbeCore', 'c', env);
const decode = execute(compactDecodeWGSL, 'compactA', 'p,c', env);
const reader = Object.fromEntries([2, 3].map(f => { const code = volumeFrag(g, { fixedReadFormat: f, detail });
  return [f, { A: execute(code, 'volumeA', 'p', env), T: execute(code, 'volumeT', 'p', env) }]; }));
let decodes = 0;
function check(c, threshold, override = null) {
  core = c; kindOverride = override;
  thresholdBits = ((threshold << 16) | (random() & 65535)) >>> 0;
  colourBits = random();
  for (const format of [2, 3]) {
    const full = decode(canonical, format === 3 ? env.compactProbeCore(c) : c);
    const a = reader[format].A(p), t = reader[format].T(p);
    const what = `id=${c.x & 255} kind=${override} fill=${c.y & 0xffffff} threshold=${threshold} format=${format}`;
    assert.equal(t, full.y, `volumeT ${what}`);
    assert.equal(a.x, full.x, `volumeA.x ${what}`); assert.equal(a.y, full.y, `volumeA.y ${what}`); assert.equal(a.z, full.z, `volumeA.z ${what}`);
    // .w: identical, except an empty (or dithered-out) cell's seed fraction, 0, read only floored (0 either way)
    if (a.w !== full.w) assert(a.w === 0 && full.x === 0 && Math.floor(full.w) === 0 && Math.floor(a.w) === 0, `volumeA.w ${what}`);
    decodes++;
  }
}
for (let id = 0; id < 256; id++)   // (arbitrary kinds only for invalid IDs: a catalog element's kind is its own)
  for (const kind of id < ELEMENTS.length ? [null] : [null, K.EMPTY, K.LIQUID, ELEMENTS[E.WALL].kind, K.POWDER])
    for (const threshold of [0, 1, 32767, 65534, 65535])
      for (const fill of [0, 1, Math.max(0, threshold - 1), threshold, threshold + 1, 65535, 65536, 65537, 0xffffff])
        check({ x: ((random() & 0xffffff00) | id) >>> 0, y: ((random() & 0xff000000) | fill) >>> 0, z: random(), w: random() }, threshold, kind);
for (let i = 0; i < 20000; i++) check({ x: random(), y: random(), z: random(), w: random() }, random() & 65535);
// (T from the phase rows: every raw value band)
for (const raw of [0, 1173, 41093, 41094, 53314, 53315, 65535])
  for (const e of ELEMENTS) check({ x: (e.id | (raw << 8)) >>> 0, y: random(), z: random(), w: random() }, random() & 65535);
checks += decodes;

// ---- R2: V1's B as V2 holds it, executed ----
const half = (h) => { const s = h >> 15 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); };
const fallOf = (c) => 0.5 + (c.x >>> 24);   // a stand-in fall speed (fall.js fallVelocity's own checks: tools/v2/fall-check.mjs)
const motionEnv = {
  KIND: id => ELEMENTS[id]?.kind ?? K.EMPTY, K_POWDER: K.POWDER, K_LIQUID: K.LIQUID, K_SOLID: K.SOLID,
  i32: x => x | 0, fallVelocity: fallOf,
  vec4f: (...v) => v.length === 2 ? [...v[0], v[1]] : v, vec3f: (...v) => v.flat(),
  unpack2x16float: (w) => Object.assign([half(w & 65535), half(w >>> 16)], { x: half(w & 65535), y: half(w >>> 16) }),
};
const motionJs = body(nativeMotionWGSL, 'nativeMotionB').replace(/\blet\b/g, 'const').replace(/\b(0x[\da-f]+|\d+)u\b/gi, '$1').replace(/>>/g, '>>>')
  .replace(/vec3f\(([^;]*?)\) \/ (\d+(?:\.\d+)?)/, (m, inner, d) => `vec3f(${inner}).map(v => v / ${d})`)
  .replace(/\/ (\d+(?:\.\d+)?), 0\.0, air\.w\)/, '/ $1, 0.0, air[3])').replace(/air\.w/g, 'air[3]');
const motion = new Function(...Object.keys(motionEnv), `return function(c, air) { ${motionJs} };`)(...Object.values(motionEnv));
const air = [0.25, -0.5, 0.125, 0.75];
for (const e of ELEMENTS) for (const fill of [0, 1, 65536]) {
  const c = { x: (e.id | (7 << 24)) >>> 0, y: fill, z: (0x3c00 | (0x4000 << 16)) >>> 0, w: 0xbc00 };
  const got = motion(c, air);
  let want;
  if (e.kind === K.POWDER) want = [0, -fallOf(c) / WEATHER_SPEED_SI, 0, air[3]];
  else if (e.kind === K.LIQUID && fill) want = [1 / WEATHER_SPEED_FLUX, 2 / WEATHER_SPEED_FLUX, -1 / WEATHER_SPEED_FLUX, air[3]];
  else if (e.kind === K.SOLID) want = [0, 0, 0, air[3]];
  else want = air;
  assert.deepEqual(got.map(v => +v.toFixed(12)), want.map(v => +v.toFixed(12)), `nativeMotionB ${e.key} fill ${fill}`);
  checks++;
}
// the air in V1's units, as the physical readers' fetchBs (shaders/common.js format 3) converts it
ok(body(nativeMotionWGSL, 'nativeAirB').includes(`air.xyz / ${WEATHER_SPEED_SI}, air.w / ${LEGACY_PRESSURE_PA}`), 'air units');
// The Flow view tints matter by its own motion, its strokes and haze by the air; the Pressure view
// reads the air's pressure; the realistic module's smoke rides it; World's B carries the same.
const flow = volumeFrag(g, { view: 'flow', fixedReadFormat: 2 });
ok(flow.includes('mobileVel(cell, id, volumeB(cell).xyz)') && body(flow, 'brickStroke').includes('volumeB(c).xyz'), 'Flow reads V1\'s B');
ok(body(volumeFrag(g, { view: 'pressure', fixedReadFormat: 2 }), 'pressureAt').includes('volumeB('), 'Pressure reads the air');
ok(body(volumeFrag(g, { fixedReadFormat: 2, detail }), 'flowVel').includes('volumeB(i0)'), 'smoke follows the flow (R3)');
ok(nativeAirWGSL(g).includes('airB[s] = nativeMotionB(A[s], fetchBs(s));'), 'World\'s B export');

// ---- R1: the brick map's air flags under V2 ----
const air2 = nativeBrickAirWGSL(g), v1Brick = brickFrag(g);
ok(v1Brick.includes(`const AIR_FLAG_P: f32 = ${AIR_FLAG.P};`) && v1Brick.includes(`const AIR_FLAG_V: f32 = ${AIR_FLAG.V};`), 'brickFrag thresholds');
ok(air2.includes(`const AIR_FLAG_P: f32 = ${AIR_FLAG.P};`) && air2.includes('nativeMotionB(A[s], air)') && air2.includes('vec3i(k & 1, (k >> 1u) & 1, (k >> 2u) & 1) + 1'),
  'V2 flags: brickFrag\'s core sample and thresholds over V1\'s B');

// Fake device: V2's read group binds the current air; the derived frame flags the bricks with it.
globalThis.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100, UNIFORM: 0x40, MAP_READ: 1, VERTEX: 0x20, INDEX: 0x10 };
globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
const buffer = (desc) => ({ ...desc, destroy() {} });
const kernels = [];
const gpu = {
  testMode: true, L: { EMPTY: [], PARAMS: [] }, emptyGroup: {}, stats: { flushes: 0 }, device: { limits: {} },
  createBuffer: buffer, layout: (name, entries) => ({ name, entries }), bindGroup: (layout, entries, label) => ({ layout, entries, label }),
  queue: { writeBuffer() {} }, write() {},
  kernel: (desc) => { const k = { name: desc.name, code: desc.code, state: 'ready', ready: Promise.resolve(), dispatch() {} }; kernels.push(k); return k; },
  readback: { buffer: () => Promise.resolve(new ArrayBuffer(16)) }, flush() {}, frame: { clear() {}, copy() {} },
};
const sim = Object.assign(Object.create(Simulation.prototype), {
  gpu, g, id: 1, origin: { x: 0, y: 0, z: 0, clone() { return { ...this }; } }, cur: 0, version: 0, wholeWrites: 0, frame: 0, paints: 0,
  L: { TABLES: [], STATE_RO: { name: 'STATE_RO' }, STATE_RW: [], UNDO: [], FLOW_SHIFT: [] }, tables: { name: 'tables' }, marks: buffer({ size: 4096 }),
  state: { A: buffer({ size: 16 }), B: buffer({ size: 16, label: 'V1 B' }), F: buffer({ size: 16 }) },
  _bindRO: { name: 'V1 read' }, _bindRW: {}, _bindFlagsRO: {}, _bindAct: {}, history: [], flow: null,
  _shiftListeners: [], shiftKeepsHistory: true, wake() {}, _retire() {}, stillFlow() {}, ready: Promise.resolve(),
  rays: { wake() {}, reset() {}, paint() { return false; }, noteElement() {} },
  passOf: name => gpu.kernel({ name, code: '' }), passes: { paint: {}, undoShift: {} },
});
const { contactWGSL } = await import('../../src/shaders/v2/contact.js');
const { NativeDynamics } = await import('../../src/v2/dynamics.js');
const owner = new PhysicsV2(sim, { contactWGSL, Dynamics: NativeDynamics });
await owner.ready;
sim.compact = owner;
owner.sync = () => {};
const d = owner.dynamics;
ok(owner.groups.read.entries[1].resource.buffer === sim.state.B, 'the legacy read group (generic readers, World foam) is unchanged');
for (const index of [0, 1]) {
  d.airIndex = index;
  const group = sim.bindRO;
  ok(group.entries[0].resource.buffer === owner.cells && group.entries[1].resource.buffer === d.air[index], `bindRO binds the cells and air copy ${index}`);
  ok(owner.isReadGroup(group), 'sim.probe still knows it as V2\'s reader');
}
ok(sim.readHeader().format === 2, 'format 2');
// derived.updateBricks, its own dispatches recorded (the passes around it stubbed)
const dispatched = [];
const derived = Object.assign(Object.create(Derived.prototype), {
  sim, gpu, g, brick: buffer({ size: 16, label: 'brick map' }), kernels: { brick: { name: 'brick' }, boxArgs: { name: 'boxArgs' }, brickDist: { name: 'brickDist' }, blur: { name: 'blur' }, blurLast: { name: 'blurLast' } },
  groups: { brick: {}, boxes: {}, dist: [{}, {}, {}], light: { fromBrick: {}, aToB: {}, bToA: {}, aToLight: {} } },
  occupancy: { update() { dispatched.push({ name: 'occupancy' }); } }, updateDirty() {}, updateFields() {}, _over: () => [1, 1, 1], _region: () => [1, 1, 1],
  _dispatch(kernel, size, opts) { dispatched.push({ name: kernel.name, size, opts }); },
});
derived.updateBricks();
const names = dispatched.map(x => x.name);
const flag = dispatched.find(x => x.name === 'nativeBrickAir');
ok(flag && names.indexOf('nativeBrickAir') === names.indexOf('brick') + 1 && names.indexOf('occupancy') > names.indexOf('nativeBrickAir'), 'air flags right after the brick kernel');
ok(flag.opts.bind[1] === sim.bindRO && flag.opts.bind[2].entries[0].resource.buffer === derived.brick && flag.opts.header.format === 2, 'over V2\'s read group, into the brick map');
ok(kernels.find(k => k.name === 'nativeBrickAir').code === nativeBrickAirWGSL(g), 'its kernel');
ok(flag.size[0] * flag.size[1] * 64 >= g.nbricks ?? true, 'every brick');
// V1 (no owner): no V2 pass
sim.compact = null; dispatched.length = 0;
const v1Derived = Object.assign(Object.create(Derived.prototype), { ...derived, nativeAir: undefined });
v1Derived.updateBricks();
ok(!dispatched.some(x => x.name === 'nativeBrickAir'), 'V1 has no V2 air pass');
console.log(`View reads: ${checks} checks (${decodes} executed decodes; V1 draw pinned; V1's B from V2; brick air flags under V2); CPU only`);

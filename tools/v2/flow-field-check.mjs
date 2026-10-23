// CPU only (no browser, device or GPU slot): what V2 gives the renderer for moving matter and for
// part-full liquid, on the real PhysicsV2 driver over a fake GPU.
//
// 1. The flow field (Simulation.flow, cells per V1 step): read by the flowing grains' flow maps
//    (gfx/surface.js gatherSurf cellFlow) in Box and, through the live copies, World. V2 writes it from
//    its own motion (src/v2/flow.js v2flow, its main transpiled to JS and run on the fake GPU's
//    dispatch): a falling grain's fall velocity, a liquid's face flux; resting matter reads 0, and
//    V1's motion is cleared when V2 takes the box. Water's ripples read none of it (asserted below):
//    they are the view clock's, the same text in V1's and V2's programs.
// 2. Part-full liquid's dither (shaders/compact.js compactA, the drawn projection the bridge writes
//    and World copies): hashed at the world cell (seed3 adds H.origin; the bridge and the readers
//    get the window's origin), so a cell keeps its look wherever the World window is.
import assert from 'node:assert/strict';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { v2FlowWGSL, FLOW_LAYOUT } from '../../src/v2/flow.js';
import { fallVelocity, setFall } from '../../src/v2/fall.js';
import { WEATHER_SPEED_SI, WEATHER_SPEED_FLUX } from '../../src/v2/nativeWeather.js';
import { ARGS2, CNT, v2ActLayout } from '../../src/shaders/v2.js';
import { compactDecodeWGSL } from '../../src/shaders/compact.js';
import { prelude, cellSlot, marksLayout, SEED_MAX } from '../../src/shaders/common.js';
import { volumeFrag } from '../../src/shaders/render.js';
import { snapshotSource } from '../../src/world/renderSource.js';
import { E, K, ELEMENTS } from '../../src/elements.js';
import * as L from '../../src/v2/layout.js';
import { assertNaga } from './wgsl-grouping.mjs';

const g = gridLayout(32, 32, 32), calls = [];

// ---- WGSL → JS (scalar code only; every rewrite must find its text, as legacy-flip-check.mjs)
function body(code, name) {
  const start = code.indexOf('{', code.indexOf(`fn ${name}(`));
  assert(start >= 0, `fn ${name} exists`); let depth = 1, end = start + 1;
  for (; depth; end++) { if (code[end] === '{') depth++; if (code[end] === '}') depth--; }
  return code.slice(start + 1, end - 1);
}
const scalar = s => s.replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1').replace(/\bvar\b/g, 'let').replace(/ >> /g, ' >>> ')
  .replace(/\b(c|core|before|after)\.([xyzw])\b/g, (_s, v, c) => `${v}[${'xyzw'.indexOf(c)}]`);
function rewrite(text, pairs) {
  for (const [from, to] of pairs) { assert(text.includes(from), `the WGSL still reads ${from}`); text = text.replaceAll(from, to); }
  return text;
}
const constOf = (code, name) => {
  const m = code.match(new RegExp(`const ${name}: (?:u32|f32) = ([\\d.e+-]+)u?;`));
  assert(m, `the kernel declares ${name}`); return Number(m[1]);
};
const halves = u => new Float16Array(new Uint32Array([u >>> 0]).buffer);
const vec3 = (x, y, z) => ({ x, y, z, get xy() { return { x: this.x, y: this.y }; } });

// ---- 1a. the kernel: valid WGSL, and its main as JS
const flowCode = v2FlowWGSL(g);
assertNaga(flowCode, 'v2flow');
assert.deepEqual(FLOW_LAYOUT.map(e => e.buffer.type), ['storage'], 'group 1: the flow field alone');
const act = v2ActLayout(g);
assert.equal(constOf(flowCode, 'FLOW_LIST'), act.list, 'reads the awake list');
assert.equal(constOf(flowCode, 'FLOW_USE_AWAKE'), act.count + CNT.USE_AWAKE, '... and the count this tick\'s passes use');
assert.equal(constOf(flowCode, 'FLOW_CHANGED'), act.changed, 'notes the bricks whose flow it wrote (the tick\'s change: World\'s source)');
assert.equal(constOf(flowCode, 'FLOW_SPEED_SI'), WEATHER_SPEED_SI, 'V1 units as nativeB gives them (m/s per cell/step)');
assert.equal(constOf(flowCode, 'FLOW_SPEED_FLUX'), WEATHER_SPEED_FLUX, '... and face flux per cell/step');
const liquidRow = flowCode.match(/const FLOW_LIQUID = array<bool, \d+>\(([^)]*)\);/);
assert(liquidRow, 'the kernel has its liquid rows');
const FLOW_LIQUID = liquidRow[1].split(',').map(v => v === 'true');
assert.deepEqual(FLOW_LIQUID, ELEMENTS.map(e => e.kind === K.LIQUID));
const ctx = {
  FLOW_LIST: act.list, FLOW_USE_AWAKE: act.count + CNT.USE_AWAKE, FLOW_CHANGED: act.changed, FLOW_SPEED_SI: WEATHER_SPEED_SI, FLOW_SPEED_FLUX: WEATHER_SPEED_FLUX, FLOW_LIQUID,
  FLOW_TOPPLE_MARK: constOf(flowCode, 'FLOW_TOPPLE_MARK'), FLOW_POWDER: flowCode.match(/const FLOW_POWDER = array<bool, \d+>\(([^)]*)\);/)[1].split(',').map(v => v === 'true'),
  fallVelocity: c => fallVelocity(c),   // the CPU twin of fallWGSL's (tools/v2/fall-check.mjs holds them together)
  vec3f: (a, b, c) => (typeof a === 'object' ? vec3(a.x, a.y, b) : vec3(a, b, c)), vec2f: (x, y) => ({ x, y }), vec2u: (x, y) => [x >>> 0, y >>> 0],
  unpack2x16float: u => { const h = halves(u); return { x: h[0], y: h[1] }; },
  pack2x16float: v => new Uint32Array(new Float16Array([v.x, v.y]).buffer)[0],
  div3: (v, k) => vec3(Math.fround(v.x / k), Math.fround(v.y / k), Math.fround(v.z / k)),
  select: (a, b, c) => (c ? b : a), differ: (a, b) => a[0] !== b[0] || a[1] !== b[1],
};
const mainText = rewrite(scalar(body(flowCode, 'main')), [
  ['foldId(wg, nwg)', 'wg'], ['atomicLoad(&act2[FLOW_USE_AWAKE])', 'act2[FLOW_USE_AWAKE]'], ['atomicLoad(&act2[FLOW_LIST + e])', 'act2[FLOW_LIST + e]'],
  ['cells[s]', 'cellAt(s)'],
  ['vec3f(unpack2x16float(c[2]), unpack2x16float(c[3] & 65535).x) / FLOW_SPEED_FLUX', 'div3(vec3f(unpack2x16float(c[2]), unpack2x16float(c[3] & 65535).x), FLOW_SPEED_FLUX)'],
  ['let old = flow[s];', 'let old = flowAt(s);'], ['any(flow[s] != w)', 'differ(flowAt(s), w)'], ['flow[s] = w;', 'setFlow(s, w);'],
  ['atomicStore(&act2[FLOW_CHANGED + (s >>> 6)], 1);', 'act2[FLOW_CHANGED + (s >>> 6)] = 1;'],
]);
const flowMain = new Function('ctx', 'io', 'wg', 'li', `with (ctx) { with (io) { ${mainText} } }`);
let flowRuns = 0;
// The dispatch: every workgroup of the indirect count, 64 lanes each (the fake GPU's stand-in for the GPU).
function runFlow(opts) {
  const flow = new Uint32Array(opts.bind[1].entries[0].resource.buffer.data.buffer);
  const [cellsBuf, actBuf] = opts.bind[2].entries.map(e => e.resource.buffer);
  const cells = new Uint32Array(cellsBuf.data.buffer), act2 = new Uint32Array(actBuf.data.buffer);
  const io = { act2, cellAt: s => cells.subarray(s * 4, s * 4 + 4), flowAt: s => flow.subarray(s * 2, s * 2 + 2), setFlow: (s, w) => flow.set(w, s * 2) };
  for (let wg = 0; wg < act2[ctx.FLOW_USE_AWAKE] + 1; wg++) for (let li = 0; li < 64; li++) flowMain(ctx, io, wg, li);   // (+1: a padding workgroup returns)
  flowRuns++;
}

// ---- 1b. the driver on the fake GPU (as tools/v2/compact-check.mjs, with a flow field)
globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100 };
const buffer = ({ size, ...desc }) => ({ ...desc, size, data: new Uint8Array(size), destroy() {} });
const u32 = b => new Uint32Array(b.data.buffer);
const gpu = {
  testMode: true, L: { EMPTY: [] }, emptyGroup: {},
  createBuffer: buffer, layout: (_name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
  queue: { writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); } },
  write(b, at, data) { this.queue.writeBuffer(b, at, data); },
  frame: { copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); }, clear(b, at = 0, n = b.size - at) { b.data.fill(0, at, at + n); } },
  kernel: ({ name, build }) => ({ name, build, ready: Promise.resolve(), dispatch(_f, size, opts) {
    calls.push({ name, size, opts });
    if (name === 'v2flow') runFlow(opts);
  } }),
  readback: { buffer: async (b, at, n) => b.data.slice(at, at + n).buffer },
  flush() {},
};
const bytes = g.slots * 16, origin = { x: 64, y: 0, z: -32 };
const sim = Object.assign(Object.create(Simulation.prototype), {
  gpu, g, id: 1, origin: { ...origin, clone() { return { x: this.x, y: this.y, z: this.z }; } }, cur: 0, version: 0, wholeWrites: 0, frame: 0, paints: 0,
  L: { TABLES: [], STATE_RO: [], UNDO: [] }, tables: {}, marks: buffer({ size: marksLayout(g).words * 4 }),
  state: { A: buffer({ size: bytes * 2 }), B: buffer({ size: bytes * 2 }), F: buffer({ size: g.slots * 8 }) },
  flow: buffer({ size: g.slots * 8 }),
  _bindRO: {}, _bindRW: {}, _bindFlagsRO: {}, _bindAct: {}, history: [],
  wake() {}, _retire() {}, stillFlow() {}, rays: { wake() {} },
});
const flowWords = u32(sim.flow);
const STALE = 0x3c003c00;   // (1, 1) and 1 as f16: V1's last motion, a grain sliding a cell a step
flowWords.fill(STALE);
const owner = new PhysicsV2(sim);
assert(flowWords.every(w => w === 0), 'V2 taking the box clears V1\'s motion: none of its cells moves yet');
await owner.ready;
await owner.flowField.ready;
const desc = calls.length;   // (nothing dispatched while building)
assert.equal(desc, 0);

// the scene: a grain falling at 6 m/s, one resting on the floor, water whose faces carry flux, air
const cells = u32(owner.cells);
const put = (p, c) => cells.set(c, cellSlot(g, ...p) * 4);
const at = p => cellSlot(g, ...p);
const falling = [5, 20, 6], resting = [5, 0, 6], water = [9, 1, 9], air = [12, 12, 12];
const fallingCore = setFall(L.makeMaterial(E.SAND).core, 6, 0.25);
put(falling, fallingCore);
put(resting, setFall(L.makeMaterial(E.SAND).core, 0, 0));
const flux = [2048, -1024, 512];   // fill quanta a tick (f16 lanes: x, y in z; z in w's low half)
const waterCore = L.makeMaterial(E.WATER, 20, L.FULL).core;
waterCore[2] = new Uint32Array(new Float16Array([flux[0], flux[1]]).buffer)[0];
waterCore[3] = (waterCore[3] & 0xffff0000) | new Uint16Array(new Float16Array([flux[2]]).buffer)[0];
put(water, waterCore);
// the awake list: the bricks of all four (the activity pass is a spy here)
const actWords = u32(owner.act), bricks = [...new Set([falling, resting, water, air].map(p => at(p) >> 6))];
actWords.set(bricks, owner.layout.list); actWords[owner.layout.count + CNT.USE_AWAKE] = bricks.length;
// V1's motion in a brick V2 left asleep would be stale; a stale word in an awake one is overwritten
flowWords.fill(STALE, at(air) * 2, at(air) * 2 + 2);

calls.length = 0;
owner.ticks(1);
const names = calls.map(c => c.name);
const fl = names.indexOf('v2flow');
assert.equal(names.filter(n => n === 'v2flow').length, 1, 'once a tick');
for (const mover of ['v2column', 'v2block', 'v2runs', 'v2pairs']) assert(names.lastIndexOf(mover) < fl, `after ${mover}, which moves cells`);
assert(fl < names.indexOf('v2invalidate'), 'within the tick');
const dispatch = calls[fl];
assert.deepEqual(dispatch.size, { indirect: owner.args, offset: ARGS2.BRICKS * 4 }, 'over the awake bricks');
assert.equal(dispatch.opts.bind[1].entries[0].resource.buffer, sim.flow, 'into the renderer\'s field');
assert.equal(dispatch.opts.bind[2], owner.groups.v2, 'from V2\'s cells');
assert.equal(flowRuns, 1);

const flowAt = p => { const w = flowWords.subarray(at(p) * 2, at(p) * 2 + 2), a = halves(w[0]), b = halves(w[1]); return [a[0], a[1], b[0]]; };
const f16 = x => Math.f16round(x);
assert.deepEqual(flowAt(falling), [0, f16(-6 / WEATHER_SPEED_SI), 0], 'a falling grain: its fall, in cells per V1 step');
assert(Math.abs(flowAt(falling)[1] * 32) > 0.01, 'enough for the flow map to move its texture (surface.js FLOW_PERIOD, FLOW_MIN_TRAVEL)');
assert.deepEqual(flowAt(resting), [0, 0, 0], 'a resting grain reads 0: motion that happened (move.js)');
assert.deepEqual(flowAt(water), flux.map(q => f16(q / WEATHER_SPEED_FLUX)), 'water: its face flux');
assert.deepEqual(flowAt(air), [0, 0, 0], 'air: 0, V1\'s stale word overwritten');
// (v2invalidate is a spy here: the tick's change words stay as the flow left them)
for (const p of [falling, water, air]) assert.equal(actWords[owner.layout.changed + (at(p) >> 6)], 1, 'a brick whose flow changed is noted as changed');
// the grain lands: the next tick writes 0 while its brick is still awake (it sleeps a quiet cycle later)
put(falling, setFall(fallingCore, 0, 0));
owner.ticks(1);
assert.deepEqual(flowAt(falling), [0, 0, 0], 'a landed grain stops its texture');

// a topple (shaders/v2.js, the block pass): a one-cell jump with no fall speed, recorded where the grain
// landed with FLOW_TOPPLE_MARK in the spare half. v2flow keeps the jump for that tick (cells per V1 step),
// mark cleared, then the grain's own motion: its texture slides one cell, as V1's hop moves it.
{
  const block = calls.find(c => c.name === 'v2block');
  assert.equal(block.opts.bind[1], owner.groups.flow, 'the block pass writes into the renderer\'s field');
  assert.equal(owner.groups.flow.entries[0].resource.buffer, sim.flow);
  const blockCode = (await import('../../src/shaders/v2.js')).v2BlockWGSL(g, (await import('../../src/shaders/v2/contact.js')).contactWGSL, true);
  assert.match(blockCode, /noteTopple\(positions\[pick\], ti, pick, down\);/, 'each topple records its jump');
  assert.match(blockCode, /flow\[slotOf\(to\)\] = vec2u\(pack2x16float\(moveD\.xy\), pack2x16float\(vec2f\(moveD\.z, FLOW_TOPPLE_MARK\)\)\);/, '... where it lands, marked');
  assert.equal(constOf(blockCode, 'FLOW_TOPPLE_MARK'), ctx.FLOW_TOPPLE_MARK, 'the same mark');
  assert.equal(constOf(blockCode, 'FLOW_TOPPLE_STEPS'), 4, 'V1 steps a tick (host.js LEGACY_STEPS_PER_TICK)');
  assertNaga(blockCode, 'v2block with the flow field');
  const toppled = [5, 1, 7], jump = [1 / 4, -1 / 4, -1 / 4];
  put(toppled, setFall(L.makeMaterial(E.SAND).core, 0, 0));
  const pack = (a, b) => new Uint32Array(new Float16Array([a, b]).buffer)[0];
  flowWords.set([pack(jump[0], jump[1]), pack(jump[2], ctx.FLOW_TOPPLE_MARK)], at(toppled) * 2);
  owner.ticks(1);
  assert.deepEqual(flowAt(toppled), jump.map(f16), 'the toppled grain\'s jump, for its tick');
  assert.equal(halves(flowWords[at(toppled) * 2 + 1])[1], 0, '... its mark cleared');
  owner.ticks(1);
  assert.deepEqual(flowAt(toppled), [0, 0, 0], 'then its own motion: at rest, 0');
  flowWords.set([pack(1, 1), pack(1, ctx.FLOW_TOPPLE_MARK)], at(water) * 2);
  owner.ticks(1);
  assert.deepEqual(flowAt(water), flux.map(q => f16(q / WEATHER_SPEED_FLUX)), 'a mark under anything but a grain is not a topple\'s');
}
// the owner's activation clears what the cache's field held before it (a pre-owner load's motion)
sim.compact = null;
flowWords.fill(STALE);
owner.activate();
assert(flowWords.every(w => w === 0), 'V2 activated clears the stale motion');
// World's copy of the live window carries the same field (world/renderSource.js aux flow)
assert.equal(snapshotSource(sim).flow, sim.flow, 'World\'s live copies take V2\'s flow field');

// ---- 1c. the ripples read no flow: the view clock's, the same text in V1's and V2's programs
const rippleFns = ['liquidRipple', 'liquidCapillary', 'rippleH'];
const programs = [0, 2].map(fixedReadFormat => volumeFrag(g, { fixedReadFormat, detail: { DETAIL_LIQ_RIPPLES: 1 } }));
programs.push(volumeFrag(g, { backend: 'world', detail: { DETAIL_LIQ_RIPPLES: 1 } }));
for (const name of rippleFns) {
  const texts = programs.map(code => body(code, name));
  for (const t of texts) {
    assert.equal(t, texts[0], `${name}: the same in V1's, V2's and World's programs`);
    assert(!/cellFlow|worldFlow|fetchB|flow\[|aeration|fetchNative/.test(t), `${name} reads no motion field`);
  }
}
assert(/FU\.time/.test(body(programs[0], 'liquidRipple')) && /FU\.time/.test(body(programs[0], 'liquidCapillary')), 'ripples run on the view clock');
assert(/if \(flowing\) \{ vel \+= w \* cellFlow\(c\); \}/.test(programs[1]) && /let flowing = ch == CH_GRANULAR;/.test(programs[1]),
  'the field\'s reader in V2\'s program: flowing grains');

// ---- 2. the dither is the world cell's
const preludeRO = prelude(g, { state: 'read', fixedReadFormat: 2 });
assert(preludeRO.includes('fn seed3(p: vec3i, frame: u32, salt: u32) -> u32 { return seedWorld(p + H.origin, frame, salt); }'), 'seed3 hashes the world cell');
assert(/fn compactA\(p: vec3i, c: vec4u\)/.test(compactDecodeWGSL));
assert(!/\bp\b(?!,)/.test(body(compactDecodeWGSL, 'compactA').replace(/seed3\(p, /g, '')), 'compactA reads its cell only through seed3');
const pcg = v => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const H = { origin: [0, 0, 0] };
const seed3 = (p, frame, salt) => { const w = p.map((v, i) => v + H.origin[i]); return pcg(w[0] + pcg(w[1] + pcg(w[2] + pcg(Math.imul(frame, 1664525) + salt)))); };
const dctx = {
  f32: Number, i32: Math.trunc, u32: Math.trunc, max: Math.max, select: (a, b, c) => (c ? b : a),
  vec4f: (x, y, z, w) => [x, y, z, w].map(Math.fround), KIND: id => ELEMENTS[id].kind, K_LIQUID: K.LIQUID, K_EMPTY: K.EMPTY,
  compactTq: L.cTq, seed3, SEED_MAX, COMPACT_CONDUCTS: ELEMENTS.map(e => e.elec > 0), COMPACT_LIFE_SCALE: ELEMENTS.map(e => L.lifeScale(e.id)),
  COMPACT_CTYPE_MASK: ELEMENTS.map(e => (e.burnRate > 0 ? 127 : 255)),
};
const compactA = new Function('ctx', 'p', 'c', `with (ctx) { ${scalar(body(compactDecodeWGSL, 'compactA'))} }`);
const drawn = (worldCell, windowOrigin, c) => { H.origin = windowOrigin; return compactA(dctx, worldCell.map((v, i) => v - windowOrigin[i]), c); };
let shown = 0, hidden = 0;
for (let i = 0; i < 400; i++) {
  const w = [(i * 37) % 300 - 150, (i * 11) % 64, (i * 53) % 300 - 150], fill = 1 + ((i * 2654435761) >>> 0) % (L.FULL - 1);
  const c = L.makeMaterial(E.WATER, 20, fill).core;
  const views = [[0, 0, 0], [64, 0, -32], [-96, 0, 128]].map(o => drawn(w, o, c));
  for (const v of views) assert.deepEqual(v, views[0], `a part-full cell at world ${w} looks the same from every window`);
  if (views[0][0] === E.WATER) shown++; else hidden++;
}
assert(shown > 50 && hidden > 50, 'the fills sampled both show and hide');
// ... given the window's origin in every header that projects or reads the cells
owner.legacyPending = true;
calls.length = 0;
owner.exportLegacy(false);
const bridge = calls.find(c => c.name === 'v2bridge');
assert(bridge, 'the export ran');
assert.deepEqual(bridge.opts.header.origin, [origin.x, origin.y, origin.z], 'the bridge (World\'s copies) hashes at the window\'s origin');
assert.deepEqual(sim.readHeader().origin, [origin.x, origin.y, origin.z], 'Box\'s readers too');
assert.deepEqual(snapshotSource(sim).origin, [origin.x, origin.y, origin.z], 'World places the copy at that origin');

owner.dispose();
console.log('flow-field-check: V2 writes the flow field from its motion; ripples read none; the dither is the world cell\'s');

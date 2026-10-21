// CPU only: the lazy legacy export's switch of projection (src/v2/physics.js exportLegacy, the v2bridge
// kernel in src/shaders/v2.js) on the real PhysicsV2 driver over a fake GPU. The bridge dispatch runs the
// production WGSL helpers (bridgeConverts, bridgeCell) and projections (compact.js compactA,
// compactProbeCore, compactProbeA) and its main transpiled to JS, as tools/v2/edit-intent-check.mjs
// does (main a workgroup at a time, each of its barrier phases for the 64 threads in turn); a tick's
// store runs the production noteVisible the same way. Not a GPU emulator, no GPU or performance claim.
//
// What it proves: the drawn projection (compactA: a partial liquid fill dithered against a per-cell
// seed) and the edit projection (compactProbeA: any fill shows) differ only in bricks holding such a
// fill, so a switch between them converts only those bricks and the changed ones, and A/B then equal a
// full export in the new projection, cell for cell, after edits, ticks, saves, suspend and resume.
import assert from 'node:assert/strict';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { v2BridgeWGSL, BRIDGE, LEGACY_WORD } from '../../src/shaders/v2.js';
import { compactDecodeWGSL } from '../../src/shaders/compact.js';
import { cellSlot, slotCell, marksLayout, gridDims, SEED_MAX } from '../../src/shaders/common.js';
import { E, K, ELEMENTS } from '../../src/elements.js';
import * as L from '../../src/v2/layout.js';

const g = gridLayout(32, 32, 32), { nbricks } = gridDims(g), calls = [];

// ---- WGSL → JS (scalar code only; every rewrite below must find its text)
function body(code, name) {
  const start = code.indexOf('{', code.indexOf(`fn ${name}(`));
  assert(start >= 0, `fn ${name} exists`); let depth = 1, end = start + 1;
  for (; depth; end++) { if (code[end] === '{') depth++; if (code[end] === '}') depth--; }
  return code.slice(start + 1, end - 1);
}
const scalar = s => s.replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1').replace(/\bvar\b/g, 'let').replace(/ >> /g, ' >>> ')
  .replace(/\b(c|core|before|after)\.([xyzw])/g, (_s, v, c) => `${v}[${'xyzw'.indexOf(c)}]`);
function rewrite(text, pairs) {
  for (const [from, to] of pairs) { assert(text.includes(from), `the WGSL still reads ${from}`); text = text.replaceAll(from, to); }
  return text;
}
const fn = (args, text) => new Function('ctx', ...args, `with (ctx) { ${text} }`);

// WGSL's u32 hashes, exactly (shaders/common.js pcg, seedWorld, seed3 at origin 0)
const pcg = v => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const seed3 = (p, frame, salt) => pcg(p[0] + pcg(p[1] + pcg(p[2] + pcg(Math.imul(frame, 1664525) + salt))));
const vec = (x = 0, y = x, z = x, w = x) => ({ x: Math.fround(x), y: Math.fround(y), z: Math.fround(z), w: Math.fround(w) });
const parts = v => ArrayBuffer.isView(v) ? Array.from(v) : [v.x, v.y, v.z, v.w];
const same = (a, b) => parts(a).every((x, i) => x === parts(b)[i]);
const ctx = {
  f32: Number, i32: Math.trunc, u32: Math.trunc, max: Math.max, select: (a, b, c) => (c ? b : a), vec4f: vec,
  KIND: id => ELEMENTS[id].kind, K_LIQUID: K.LIQUID, K_EMPTY: K.EMPTY, compactTq: L.cTq, seed3, SEED_MAX,
  COMPACT_CONDUCTS: ELEMENTS.map(e => e.elec > 0), COMPACT_LIFE_SCALE: ELEMENTS.map(e => L.lifeScale(e.id)),
  COMPACT_CTYPE_MASK: ELEMENTS.map(e => (e.burnRate > 0 ? 127 : 255)), same, differ: (a, b) => !same(a, b),
};
const decode = name => scalar(body(compactDecodeWGSL, name));
const compactA = fn(['p', 'c'], decode('compactA'));
const compactProbeCore = fn(['c'], rewrite(decode('compactProbeCore'), [['let core = c;', 'let core = c.slice();']]));
const compactProbeA = fn(['p', 'c'], decode('compactProbeA'));
Object.assign(ctx, { compactA: (p, c) => compactA(ctx, p, c), compactProbeCore: c => compactProbeCore(ctx, c), compactProbeA: (p, c) => compactProbeA(ctx, p, c) });

const bridge = v2BridgeWGSL(g);
for (const [name, value] of [['LEGACY_STALE', LEGACY_WORD.STALE], ['LEGACY_DIFFERS', LEGACY_WORD.DIFFERS], ['BRIDGE_ALL', BRIDGE.ALL], ['BRIDGE_FLIP', BRIDGE.FLIP]]) {
  assert(bridge.includes(`const ${name}: u32 = ${value}u;`), `the kernel's ${name} is the driver's`);
  ctx[name] = value;
}
const converts = fn(['word'], scalar(body(bridge, 'bridgeConverts')));
const cellBody = rewrite(scalar(body(bridge, 'bridgeCell')), [
  ['cells[s]', 'cellAt(s)'], ['any(compactProbeCore(c) != c)', 'differ(compactProbeCore(c), c)'], ['any(drawn != edit)', 'differ(drawn, edit)']]);
const bridgeCell = fn(['s'], cellBody);
Object.assign(ctx, { bridgeConverts: word => converts(ctx, word), bridgeCell: s => bridgeCell(ctx, s), foldId: wg => wg });
// main, a workgroup a brick: run in its barrier phases, each for the 64 threads in turn (the
// uniform load and the barrier are where every thread's earlier writes are seen)
const main = rewrite(scalar(body(bridge, 'main')), [
  ['atomicLoad(&act2[V2_LEGACY + b])', 'words[b]'], ['atomicOr(&wgDiffers, 1)', 'wgDiffers |= 1'],
  ['atomicLoad(&wgDiffers)', 'wgDiffers'], ['atomicStore(&act2[V2_LEGACY + b], ', 'words[b] = (']]);
const uniform = 'if (workgroupUniformLoad(&wgConverts) == 0) { return; }', barrier = 'workgroupBarrier();';
assert(main.includes(uniform) && main.includes(barrier), 'the bridge\'s main keeps its uniform load and barrier');
const [pre, rest] = main.split(uniform), [mid, post] = rest.split(barrier), head = pre.slice(0, pre.indexOf('if (li == 0)'));
const phases = [pre, head + uniform.replace('workgroupUniformLoad(&wgConverts)', 'wgConverts') + mid, head + 'if (wgConverts == 0) { return; }' + post]
  .map(text => new Function('ctx', 'group', 'wg', 'nwg', 'li', `with (ctx) { with (group) { ${text} } }`));

// noteVisible, the tick's store hook (with compactProbeHolds, which it calls)
const holds = fn(['p', 'before', 'after'], rewrite(scalar(body(bridge, 'compactProbeHolds')), [
  ['all(pb == before) && all(pa == after)', 'same(pb, before) && same(pa, after)'], ['all(compactA(p, pb) == compactA(p, pa))', 'same(compactA(p, pb), compactA(p, pa))']]));
ctx.compactProbeHolds = (p, before, after) => holds(ctx, p, before, after);
const noteVisible = fn(['p', 'before', 'after'], rewrite(scalar(body(bridge, 'noteVisible')), [
  ['all(compactA(p, before) == compactA(p, after))', 'same(compactA(p, before), compactA(p, after))'],
  ['atomicStore(&act2[V2_LEGACY + brickOfCell(p)], 1);', 'mark("LEGACY", brickOfCell(p));'],
  ['atomicStore(&act2[V2_VISIBLE + b], 1);', 'mark("VISIBLE", b);'], ['atomicStore(&act2[V2_LEGACY + b], 1);', 'mark("LEGACY", b);']]));

// ---- the fake GPU and simulation (as tools/v2/compact-check.mjs)
globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100 };
const buffer = ({ size, ...desc }) => ({ ...desc, size, data: new Uint8Array(size), destroy() {} });
const u32 = b => new Uint32Array(b.data.buffer), f32 = b => new Float32Array(b.data.buffer);
let owner = null;
const legacyWords = () => u32(owner.act).subarray(owner.layout.legacy, owner.layout.legacy + nbricks);

// Runs the bridge over the state given (default: the live one); returns the bricks it converted.
function runBridge(opts, state = { A: f32(sim.state.A), B: f32(sim.state.B), cells: u32(owner.cells), words: legacyWords() }) {
  const { header: H, params: P } = opts, at = (copy, s) => (copy * g.slots + s) * 4;
  const read = (view, s) => vec(...view.subarray(at(H.src, s), at(H.src, s) + 4));
  Object.assign(ctx, {
    H, P, cellOf: s => slotCell(g, s), cellAt: s => state.cells.subarray(s * 4, s * 4 + 4),
    fetchAs: s => read(state.A, s), fetchBs: s => read(state.B, s), fetchFs: () => 0,
    writeCell(p, a, b, _f, oA, oB) {
      if (same(oA, a) && same(oB, b)) return false;
      const s = cellSlot(g, ...p);
      state.A.set(parts(oA), at(H.dst, s)); state.B.set(parts(oB), at(H.dst, s));
      return true;
    },
  });
  const converted = [];
  ctx.NBRICKS = nbricks;
  for (let b = 0; b < nbricks; b++) {
    const group = { wgConverts: 0, wgDiffers: 0, words: state.words };
    for (const phase of phases) for (let li = 0; li < 64; li++) phase(ctx, group, b, null, li);
    if (group.wgConverts) converted.push(b);
  }
  return converted;
}
// The import's legacy side: every brick it imports is stale (v2ImportWGSL); its cells' import is not under test.
function runImport(opts) {
  const m = u32(sim.marks), layout = marksLayout(g), words = legacyWords();
  for (let b = 0; b < nbricks; b++) {
    const act = (m[layout.act + (b >> 5)] >>> (b & 31)) & 1, owned = m[layout.owned + 2 * b] | m[layout.owned + 2 * b + 1];
    if (!opts.params.full && !act && !owned) continue;
    words[b] = LEGACY_WORD.STALE;
    m[layout.owned + 2 * b] = m[layout.owned + 2 * b + 1] = 0;
    if (!opts.params.preserveLegacyMarks) m[layout.act + (b >> 5)] &= ~(1 << (b & 31));
  }
}
const bridges = [];
const gpu = {
  testMode: true, L: { EMPTY: [] }, emptyGroup: {},
  createBuffer: buffer, layout: (_name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
  queue: { writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); } },
  write(b, at, data) { this.queue.writeBuffer(b, at, data); },
  frame: { copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); }, clear(b, at = 0, n = b.size - at) { b.data.fill(0, at, at + n); } },
  kernel: ({ name }) => ({ name, ready: Promise.resolve(), dispatch(_f, size, opts) {
    calls.push({ name, size, opts });
    if (name === 'v2bridge') bridges.push({ full: opts.params.full, format: opts.header.format, converted: runBridge(opts) });
    if (name === 'v2import') runImport(opts);
  } }),
  readback: { buffer: async (b, at, n) => b.data.slice(at, at + n).buffer },
  flush() {},
};
const bytes = g.slots * 16;
const sim = Object.assign(Object.create(Simulation.prototype), {
  gpu, g, id: 1, origin: { x: 0, y: 0, z: 0, clone() { return { x: this.x, y: this.y, z: this.z }; } }, cur: 0, version: 0, wholeWrites: 0, frame: 0, paints: 0,
  L: { TABLES: [], STATE_RO: [], UNDO: [] }, tables: {}, marks: buffer({ size: marksLayout(g).words * 4 }),
  state: { A: buffer({ size: bytes * 2 }), B: buffer({ size: bytes * 2 }), F: buffer({ size: g.slots * 8 }) },
  _bindRO: {}, _bindRW: {}, _bindFlagsRO: {}, _bindAct: {}, history: [],
  wake() {}, _retire() {}, stillFlow() {}, rays: { wake() {} },
});
owner = new PhysicsV2(sim);
await owner.ready;

// ---- the scene: a cell's core and its brick
const cells = u32(owner.cells);
const core = (id, fill = L.FULL, T = 20) => L.makeMaterial(id, T, fill).core;
const put = (p, c) => cells.set(c, cellSlot(g, ...p) * 4);
const brickOf = p => cellSlot(g, ...p) >> 6;
// a partial fill the drawn dither hides here (fill at or under the cell's threshold) and one it shows
const threshold = p => seed3(p, 0, 4243) >>> 16;
const hiddenFill = p => Math.max(1, threshold(p));
// A tick's store: the production noteVisible, then the write (src/shaders/v2.js storeCell).
function tickStore(p, c) {
  const s = cellSlot(g, ...p), before = cells.slice(s * 4, s * 4 + 4);
  noteVisible(Object.assign(Object.create(ctx), {
    isLiq: x => ELEMENTS[x[0] & 255].kind === K.LIQUID, cAge: x => x[0] >>> 24, brickOfCell: q => brickOf(q),
    mark: (name, b) => { if (name === 'LEGACY') legacyWords()[b] = LEGACY_WORD.STALE; },
  }), p, before, c);
  put(p, c);
  owner.legacyPending = true;
}
// What a full export in this projection would make of today's cells: A/B of the current copy.
function fullExport(native) {
  const state = { A: f32(sim.state.A).slice(), B: f32(sim.state.B).slice(), cells: cells.slice(), words: new Uint32Array(nbricks) };
  runBridge({ header: { ...sim.header(), capture: 0, format: native ? 3 : 0 }, params: { full: BRIDGE.ALL } }, state);
  return state;
}
function assertExact(native, label) {
  const want = fullExport(native), at = sim.cur * g.slots * 4, n = g.slots * 4;
  for (const k of ['A', 'B']) {
    const have = f32(sim.state[k]).subarray(at, at + n), ref = want[k].subarray(at, at + n);
    const bad = have.findIndex((v, i) => !Object.is(v, ref[i]));
    assert.equal(bad, -1, `${label}: ${k} equals a full ${native ? 'edit' : 'drawn'} export at every cell (first difference at word ${bad})`);
  }
}
// The bricks of the last export, and the export's scope.
const exported = () => bridges.at(-1);
const differing = () => [...legacyWords()].flatMap((w, b) => (w & LEGACY_WORD.DIFFERS ? [b] : []));

// 1. No partial fill anywhere: sand, stone, full and compressed water, air. A switch converts nothing.
for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 6; y++)
  put([x, y, z], y < 2 ? core(E.STONE) : y < 4 ? core(E.SAND) : core(E.WATER, y === 5 ? 3 * L.FULL : L.FULL));
sim.legacyState(false);
assert.equal(exported().full, BRIDGE.ALL, 'the first export (no projection yet) converts every brick');
assert.equal(exported().converted.length, nbricks);
assert.deepEqual(differing(), [], 'no brick holds a cell the projections show differently');
assertExact(false, 'first export');
sim.legacyState(true);
assert.equal(exported().full, BRIDGE.FLIP, 'a switch of projection asks for the stale and differing bricks');
assert.deepEqual(exported().converted, [], 'a switch with no partial fill converts no brick');
assertExact(true, 'switch to the edit projection, no partial fill');
sim.legacyState(false);
assert.deepEqual(exported().converted, [], 'and back');
assertExact(false, 'switch back');
let count = bridges.length;
sim.legacyState(false);
assert.equal(bridges.length, count, 'an unchanged cache in its projection exports nothing');

// 2. Partial fills in a few bricks: hidden films, one shown beside a hidden one, a hidden one in the
// water layer's top. A brick whose only partial fill shows (fill over the cell's threshold) looks the
// same in both projections: it isn't one of them.
const film = [[1, 8, 1], [2, 8, 1], [13, 9, 22], [30, 20, 30]], shown = [17, 9, 5];
film.forEach((p, i) => put(p, core(E.WATER, i === 1 ? L.FULL - 1 : hiddenFill(p))));
put([6, 4, 6], core(E.WATER, hiddenFill([6, 4, 6])));
put(shown, core(E.WATER, threshold(shown) + 1));
for (const p of [...film.filter((_, i) => i !== 1), [6, 4, 6]]) assert(hiddenFill(p) <= threshold(p), 'the fixture\'s films are hidden');
assert(threshold(film[1]) < L.FULL - 1 && threshold(shown) + 1 < L.FULL, 'the fixture\'s shown fills are partial and show');
const wanted = [...new Set([...film, [6, 4, 6]].map(brickOf))].sort((a, b) => a - b);
assert(!wanted.includes(brickOf(shown)));
owner.legacyPending = true;
// (the cells above bypassed the store hook: mark them as a whole-grid write would, then export them)
for (const b of [...wanted, brickOf(shown)]) legacyWords()[b] = LEGACY_WORD.STALE;
sim.legacyState(false);
assert.deepEqual(exported().converted, [...wanted, brickOf(shown)].sort((a, b) => a - b), 'an export in the same projection converts only the stale bricks');
assert.deepEqual(differing(), wanted, 'the export finds every brick holding a hidden partial fill, and only those');
assertExact(false, 'stale bricks');
sim.legacyState(true);
assert.deepEqual(exported().converted, wanted, 'a switch converts exactly the bricks with a partial fill');
assertExact(true, 'switch with partial fills');
sim.legacyState(false);
assert.deepEqual(exported().converted, wanted, 'and back');
assertExact(false, 'switch back with partial fills');

// 3. Ticks: a hidden film arrives in the air over the water (the drawn projection doesn't change: air
// and a hidden film look alike), another dries off (the same), a shown cell drains under its threshold.
const arrive = [20, 6, 20], dry = film[3], drain = film[1];
assert(!wanted.includes(brickOf(arrive)) && hiddenFill(arrive) <= threshold(arrive) && hiddenFill(drain) <= threshold(drain));
tickStore(arrive, core(E.WATER, hiddenFill(arrive)));
tickStore(dry, L.makeMaterial(E.EMPTY).core);
tickStore(drain, core(E.WATER, hiddenFill(drain)));
const ticked = [brickOf(arrive), brickOf(dry), brickOf(drain)];
assert(ticked.every(b => legacyWords()[b] & LEGACY_WORD.STALE), 'the store hook marks a change only the edit projection sees');
sim.legacyState(true);
const afterTick = [...new Set([...wanted, ...ticked])].sort((a, b) => a - b);
assert.deepEqual(exported().converted, afterTick, 'a switch converts the stale bricks and the differing ones');
assertExact(true, 'after ticks');
assert(differing().includes(brickOf(arrive)) && !differing().includes(brickOf(dry)), 'the bricks the ticks changed are found again');
sim.legacyState(false);
assertExact(false, 'after ticks, back');

// 4. An edit, then the World copy: a legacy writer (the brush) writes A in the edit projection, marks
// its brick; the copy's export imports it first (capture 2: the edit projection), then switches.
sim.legacyState(true);
const edited = [9, 12, 9], es = cellSlot(g, ...edited);
f32(sim.state.A).set([E.SAND, 20, 0, 0.5], (sim.cur * g.slots + es) * 4);
u32(sim.marks)[marksLayout(g).act + (brickOf(edited) >> 5)] |= 1 << (brickOf(edited) & 31);
sim.version++;
count = calls.length;
sim.legacyState(false);
const names = calls.slice(count).map(c => c.name);
assert(names.indexOf('v2import') >= 0 && names.indexOf('v2import') < names.indexOf('v2bridge'), 'the edit is imported before the switch');
assert.equal(calls.slice(count).find(c => c.name === 'v2import').opts.header.capture, 2, 'and read in the edit projection it was written in');
assert.deepEqual(exported().converted, [...new Set([...differing(), brickOf(edited)])].sort((a, b) => a - b));
assertExact(false, 'edit then World copy');

// 5. Save and load: the loaded cache is the drawn projection (a V1-mode save keeps V1's velocities in
// B); its partial fills are unknown, so the first switch converts every brick, as a full export would.
const saved = await owner.captureState();
f32(sim.state.B).fill(0.25, sim.cur * g.slots * 4, (sim.cur + 1) * g.slots * 4);
owner.restoreState(saved, { legacyCurrent: true });
count = bridges.length;
sim.legacyState(false);
assert.equal(bridges.length, count, 'the loaded cache serves the drawn projection as it is');
sim.legacyState(true);
assert.equal(exported().converted.length, nbricks, 'the first switch after a load converts every brick');
assertExact(true, 'switch after a load');
sim.legacyState(false);
assert.deepEqual(exported().converted, differing(), 'then only the differing ones again');
assertExact(false, 'after a load, back');

// 6. Suspend (V1 runs on the drawn cache), V1 writes a cell, resume, edit.
sim.legacyState(true);
owner.suspend();
assertExact(false, 'suspend');
const v1 = [24, 4, 3], vs = cellSlot(g, ...v1);
f32(sim.state.A).set([E.STONE, 40, 0, 0.25], (sim.cur * g.slots + vs) * 4);
f32(sim.state.B).set([0.5, 0, 0, 0.1], (sim.cur * g.slots + vs) * 4);
u32(sim.marks)[marksLayout(g).owned + (vs >> 5)] |= 1 << (vs & 31);
sim.version++;
owner.activate();
sim.legacyState(true);
assert.deepEqual(exported().converted, [...new Set([...differing(), brickOf(v1)])].sort((a, b) => a - b), 'resume: the V1 write and the differing bricks');
assertExact(true, 'resume then edit');

// 7. A whole-grid write (an undo) leaves every brick stale.
owner.restore(owner.cells);
sim.legacyState(false);
assert.equal(exported().converted.length, nbricks, 'a whole-grid write converts every brick');
assertExact(false, 'after a whole-grid write');

console.log(`legacy projection switch: converts only the stale bricks and the ${differing().length} of ${nbricks} holding a partial liquid fill; A/B equal a full export after edits, ticks, a load, suspend/resume and a whole-grid write`);

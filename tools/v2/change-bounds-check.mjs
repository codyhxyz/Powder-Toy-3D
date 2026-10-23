// CPU only (no browser, device or GPU slot): what a batch of V2 ticks tells World's renderer it changed
// (src/v2/physics.js _reportChanges) covers every cell the ticks wrote, and stays small.
//
// 1. The notes: every write of a V2 cell's core goes through noteState (storeCell, storeMaterial, the
//    import), every decoration write through setDeco, every flow write through v2flow or a topple; each
//    sets the brick's change word (v2ActLayout changed). A lint over every V2 kernel's WGSL pins it, and
//    the writers of V2's cells outside those helpers are a known list (each tells World's source itself).
// 2. The fold (shaders/v2.js v2InvalidateWGSL, its WGSL executed on the CPU): a brick changed, drawn
//    differently or, while the air runs, with live air sets exactly its bits in its tile's word, and the
//    change and visible words are cleared.
// 3. V2's tick logic with random activity: the column-run water's emitted WGSL (tools/v2/column-wgsl.mjs:
//    runs, pairs, jets, landings) on a CPU grid, its notes folded by the real fold and decoded by the
//    driver's own decoder (PhysicsV2 _changeBoxes, shaders/v2.js v2ChangeBoxes): every cell whose core,
//    bank or decoration changed lies in a reported box, tick after tick, and once the water rests the
//    report empties within the linger.
// 4. The driver on a fake GPU (as tools/v2/compact-check.mjs) and the real journal (world/renderSource.js):
//    the batch's read holds the stats and the tiles, the tiles are cleared after it, the report comes in
//    world cells at the ticks' origin, the same report again replaces the journal's last entry, a reset
//    source or a failed read is handled, undo and the first batch report the whole window.
//
//   node tools/v2/change-bounds-check.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WgslExec, WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';
import { Simulation, gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { v2Head, v2InvalidateWGSL, v2ActLayout, v2ChangeLayout, v2ChangeBoxes, V2Params, ARGS2, STATS, CHANGE_TILE } from '../../src/shaders/v2.js';
import { v2FlowWGSL } from '../../src/v2/flow.js';
import { decoStorageWGSL, materialStorageWGSL } from '../../src/shaders/v2/state.js';
import { brickIdOf, marksLayout } from '../../src/shaders/common.js';
import { WorldRenderSource } from '../../src/world/renderSource.js';
import { E } from '../../src/elements.js';
import * as L from '../../src/v2/layout.js';
import { ColumnGrid } from './column-wgsl.mjs';
import { assertNaga } from './wgsl-grouping.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '../../..');
let seed = 0x2026_1022;
const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
const int = (n) => Math.floor(rand() * n);
// wgsl_reflect reads a single workgroup size as a string (tools/world-field-copies-cpu-check.mjs)
class Exec extends WgslExec {
  _dispatchWorkgroup(fn, id, context) {
    for (const a of fn.node.attributes ?? []) if (a.name === 'workgroup_size' && typeof a.value === 'string') a.value = [a.value];
    return super._dispatchWorkgroup(fn, id, context);
  }
}

// ---- 1. the notes
const g32 = gridLayout(32, 32, 32);
const head = v2Head(g32, { state: false }, 'contact');
assert.match(head, /fn noteState\(s: u32\) \{[^}]*atomicStore\(&act2\[V2_CHANGED \+ s \/ 64u\], 1u\);[^}]*\}/, 'noteState notes the brick as changed');
assert.match(head, /fn storeCell\(p: vec3i, c: vec4u\) \{\s*let s = slotOf\(p\);\s*if \(any\(loadCore\(s\) != c\)\) \{ noteState\(s\); \}/, 'storeCell notes a changed core');
assert(materialStorageWGSL.includes('if (any(before.core != after.core) || before.bank != after.bank) { noteState(slot); }'), 'storeMaterial notes a changed core or bank');
assert.match(decoStorageWGSL, /fn setDeco\(slot: u32, d: u32\) \{ if \(decoOf\(slot\) != d\) \{ banks\[SLOTS \+ slot\] = bitcast<i32>\(d\); atomicStore\(&act2\[V2_CHANGED \+ slot \/ 64u\], 1u\); \} \}/, 'setDeco notes a changed decoration');
assert.match(v2FlowWGSL(g32), /if \(any\(flow\[s\] != w\)\) \{ flow\[s\] = w; atomicStore\(&act2\[FLOW_CHANGED \+ \(s >> 6u\)\], 1u\); \}/, 'v2flow notes a changed flow');
// Every V2 kernel that binds V2's cells (with its activity words): no cell, decoration or flow write
// outside those helpers. A function's body by name (its braces matched).
function functions(code) {
  const out = [];
  for (const m of code.matchAll(/\bfn\s+(\w+)\s*\(/g)) {
    const start = code.indexOf('{', m.index); let depth = 1, end = start + 1;
    for (; depth && end < code.length; end++) { if (code[end] === '{') depth++; if (code[end] === '}') depth--; }
    out.push({ name: m[1], body: code.slice(start + 1, end - 1) });
  }
  return out;
}
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.js$/.test(n) ? [p] : []; });
const modules = walk(join(ROOT, 'src')).filter((f) => /export\s+(const|let|function)\s+WGSL_CHECK\b/.test(readFileSync(f, 'utf8')));
let linted = 0;
const otherWriters = new Set();
for (const f of modules) {
  const mod = await import(pathToFileURL(f)), list = typeof mod.WGSL_CHECK === 'function' ? mod.WGSL_CHECK() : mod.WGSL_CHECK;
  for (const e of list ?? []) {
    if ((e.kind ?? 'compute') !== 'compute') continue;
    let code; try { code = e.code(e.grids === false ? null : g32); } catch { continue; }
    if (typeof code !== 'string') continue;
    const rel = relative(ROOT, f);
    // V2's cells under another name: residency moves, a guest's frame, the transfer, the World fill
    if (/var<storage, ?read_write> (cores|cells): array<vec4u>/.test(code) && !/var<storage, read_write> act2: array<atomic<u32>>/.test(code)) { otherWriters.add(rel); continue; }
    if (!/var<storage, read_write> cells: array<vec4u>/.test(code)) continue;
    linted++;
    for (const fn of functions(code)) {
      // (a function's own `cells` array, the contact model's 8 unpacked cells, is not the buffer)
      if (!/\bvar cells\b/.test(fn.body)) for (const m of fn.body.matchAll(/\bcells\[[^\]]+\]\s*=(?!=)[^;]*;([^\n]*)/g))
        assert(fn.name === 'storeCore' || /noteState\(/.test(m[0] + m[1]), `${rel} ${e.name}: fn ${fn.name} writes a cell without noteState: ${m[0]}`);
      if (/\bbanks\[SLOTS \+ [^\]]+\]\s*=(?!=)/.test(fn.body)) assert.equal(fn.name, 'setDeco', `${rel} ${e.name}: fn ${fn.name} writes the decoration outside setDeco`);
      if (/\bflow\[[^\]]+\]\s*=(?!=)/.test(fn.body)) assert(fn.name === 'noteTopple' || /FLOW_CHANGED/.test(fn.body), `${rel} ${e.name}: fn ${fn.name} writes the flow field unnoted`);
    }
  }
}
assert(linted > 40, `the lint saw the V2 kernels (${linted})`);
// (a topple writes its flow where its grain lands: that cell's core changed, noted by its store)
// The writers of V2's cells outside the notes, each telling World's source itself: a window move (residency:
// no content changes), a guest's frame (sim.noteWrite), the transfer (its slots' box), the World fill (its box).
const KNOWN = ['src/net/codec.js', 'src/shaders/v2/transfer.js', 'src/shaders/v2/window.js', 'src/shaders/worldWrite.js'];
for (const rel of otherWriters) assert(KNOWN.includes(rel), `${rel} writes V2's cells outside the change notes: tell World's source (v2/physics.js _reportChanges)`);
assert.match(readFileSync(join(ROOT, 'src/v2/transfer.js'), 'utf8'), /sim\.worldRenderSource\?\.noteContentChange\(\{ lo:/, 'the native transfer reports its slots\' box');
assert.match(readFileSync(join(ROOT, 'src/world/gpu.js'), 'utf8'), /nativeWritten\(sim, \{ residency, box \}\)/, 'the native World fill reports its box');

// ---- 2. the fold, its WGSL executed
function fold(g, words, { full = 1 } = {}) {
  const A = v2ActLayout(g), C = v2ChangeLayout(g);
  const act = new Uint32Array(A.allocated), args = new Uint32Array(C.allocated), marks = new Uint32Array(marksLayout(g).words);
  for (const [name, list] of Object.entries(words)) for (const b of list) act[A[name] + b] = 1;
  const program = foldPrograms.get(g) ?? foldPrograms.set(g, new WgslParser().parse(v2InvalidateWGSL(g))).get(g);
  new Exec(program).dispatchWorkgroups('main', [Math.ceil(g.nbricks / 64), 1, 1], {
    2: { 0: new Uint32Array(4), 1: act, 2: new Uint32Array(4), 3: args }, 1: { 3: marks }, 3: { 1: new Uint32Array(V2Params.pack({ full })) } });
  return { act, tiles: args.subarray(C.base, C.allocated), marks, A, C };
}
const foldPrograms = new Map();
// brick id → brick coordinates (common.js brickIdOf, inverted once per grid)
const coordsOf = (g) => { const out = new Array(g.nbricks); for (let z = 0; z < g.bz; z++) for (let y = 0; y < g.by; y++) for (let x = 0; x < g.bx; x++) out[brickIdOf(g, x, y, z)] = [x, y, z]; return out; };
let folds = 0;
for (const dims of [[32, 32, 32], [48, 40, 80]]) {
  const g = gridLayout(...dims), coords = coordsOf(g), C = v2ChangeLayout(g);
  assertNaga(v2InvalidateWGSL(g), `v2invalidate ${dims}`);
  for (let trial = 0; trial < 6; trial++) {
    const pick = (n) => Array.from({ length: n }, () => int(g.nbricks));
    const words = { changed: pick(1 + int(12)), visible: pick(int(6)), air: pick(int(6)) }, full = trial % 3 ? 1 : 0;
    const r = fold(g, words, { full });
    const want = new Uint32Array(C.count);
    for (const b of [...words.changed, ...words.visible, ...(full ? words.air : [])]) {
      const [x, y, z] = coords[b], t = [x, y, z].map((v) => Math.floor(v / CHANGE_TILE));
      want[t[0] + C.tiles[0] * (t[1] + C.tiles[1] * t[2])] |= (1 << (x % CHANGE_TILE)) | (256 << (y % CHANGE_TILE)) | (65536 << (z % CHANGE_TILE));
    }
    assert.deepEqual([...r.tiles], [...want], `${dims} trial ${trial}: the tiles hold exactly the changed bricks' bits`);
    for (const b of words.changed) assert.equal(r.act[r.A.changed + b], 0, 'a change word is cleared');
    for (const b of words.visible) { assert.equal(r.act[r.A.visible + b], 0, 'a visible word is cleared'); assert(r.marks[marksLayout(g).derived + (b >> 5)] & (1 << (b & 31)), 'and its brick re-derived'); }
    for (const b of words.air) assert.equal(r.act[r.A.air + b], 1, 'the air live words are the air\'s own');
    folds++;
  }
}

// ---- 3. V2's tick logic (column-run water's WGSL) with random activity
// The driver's decoder, on a stand-in holding what it reads (PhysicsV2 _changeBoxes)
const decoder = (g) => ({ g, changeLayout: v2ChangeLayout(g), changeGenerations: [new Uint32Array(v2ChangeLayout(g).count), new Uint32Array(v2ChangeLayout(g).count)], changeBoxes: PhysicsV2.prototype._changeBoxes });
const origin = [64, 0, 32];
const inBoxes = (boxes, p) => boxes.some((b) => p.every((v, k) => v >= b.lo[k] && v < b.hi[k]));
const volume = (boxes) => boxes.reduce((n, b) => n + b.hi.reduce((m, v, k) => m * (v - b.lo[k]), 1), 0);
let ticks = 0, changedCells = 0, reported = 0, windowCells = 0, rests = 0;
for (const scene of [0, 1]) {
  const grid = new ColumnGrid(32, 32, 32, { deco: 1 }), g = g32, dec = decoder(g);
  let lastChange = 0;
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) grid.set(x, 0, z, E.STONE);
  // water and oil dropped in blobs from the air: runs fall, land, spread, splash (jets fly and land)
  const blob = (id) => { const x0 = int(26), z0 = int(26), y0 = 8 + int(16), s = 2 + int(4);
    for (let y = y0; y < y0 + s; y++) for (let z = z0; z < z0 + s; z++) for (let x = x0; x < x0 + s; x++) if (x < 32 && z < 32 && y < 32) { grid.set(x, y, z, id); grid.deco[grid.at(x, y, z)] = (0xff000000 | int(0xffffff)) >>> 0; } };
  for (let k = 0; k < 3 + scene * 2; k++) blob(k % 2 ? E.OIL : E.WATER);
  // the notes, as production makes them: noteState's twin is the grid's touch (every store of a changed
  // core or bank), setDeco's is a decoration store that differs
  let noted = new Set();
  const touch = grid.touch.bind(grid);
  grid.touch = (i) => { touch(i); noted.add(i); };
  const setDeco = grid.ctx.setDeco;
  grid.ctx.setDeco = (s, d) => { if (grid.deco[s] !== d >>> 0) noted.add(s); setDeco(s, d); };
  noted = new Set();   // (the scene's own edits came before the first batch)
  const T = 70 + scene * 30;
  for (let t = 0; t < T; t++) {
    const before = { cores: grid.cores.map((c) => new Uint32Array(c)), banks: grid.banks.slice(), deco: grid.deco.slice() };
    // a later drop now and then: activity elsewhere, in another tile
    if (t === 40 && scene) { blob(E.WATER); }
    grid.step();
    // the jets' and landings' decoration moves with a changed core (jets.js, particles.js deposit)
    const changed = [];
    for (let i = 0; i < grid.n; i++) if (grid.cores[i].some((v, k) => v !== before.cores[i][k]) || grid.banks[i] !== before.banks[i] || grid.deco[i] !== before.deco[i]) changed.push(i);
    const bricks = [...new Set([...noted].map((i) => { const x = i % 32, z = Math.floor(i / 32) % 32, y = Math.floor(i / 1024); return brickIdOf(g, x >> 2, y >> 2, z >> 2); }))];
    noted = new Set();
    const { tiles } = fold(g, { changed: bricks }, { full: 0 });
    const boxes = dec.changeBoxes(tiles, t, origin);
    for (const i of changed) {
      const p = [i % 32, Math.floor(i / 1024), Math.floor(i / 32) % 32].map((v, k) => v + origin[k]);
      assert(inBoxes(boxes, p), `scene ${scene} tick ${t}: cell ${p} changed outside the reported boxes ${JSON.stringify(boxes)}`);
    }
    ticks++; changedCells += changed.length; reported += volume(boxes); windowCells += 32 ** 3;
    if (changed.length || grid.parts.length) lastChange = t;
    // (the linger: two generations of 30 batches, physics.js CHANGE_LINGER)
    else if (t - lastChange >= 2 * 30) { assert.equal(boxes.length, 0, 'a rested box reports nothing once its linger is over'); rests++; }
  }
  assert(changedCells > 0, 'the water moved');
}
// the linger: a change is reported for at most two generations of CHANGE_LINGER (30) batches, then nothing
{
  const dec = decoder(g32), words = new Uint32Array(dec.changeLayout.count);
  words[0] = 1 | 256 | 65536;
  let lastSeen = -1;
  for (let batch = 0; batch < 100; batch++) {
    const boxes = dec.changeBoxes(batch === 7 ? words : new Uint32Array(words.length), batch, origin);
    if (batch === 7) assert.deepEqual(boxes, [{ lo: origin, hi: origin.map((v) => v + 16) }], 'the change, quantized');
    if (boxes.length) { assert(batch < 7 || boxes.length === 1, 'kept as it was'); lastSeen = batch; }
  }
  assert(lastSeen >= 7 + 30 - 1 - 7 && lastSeen < 7 + 60, `kept for the rest of its generation and the next (to ${lastSeen})`);
  assert.equal(lastSeen, 59, 'generations of 30 batches: a change in batch 7 is kept through batch 59');
}

// ---- 4. the driver (fake GPU) and the journal
globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
const calls = [], reads = [];
const buffer = ({ size, ...desc }) => ({ ...desc, size, data: new Uint8Array(size), destroy() {} });
let foldInto = null, failRead = false;
const gpu = {
  testMode: true, L: { EMPTY: [] }, emptyGroup: {},
  createBuffer: buffer, layout: (name, entries) => entries, bindGroup: (layout, entries) => ({ layout, entries }),
  queue: { writeBuffer(b, at, data) { b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at); } },
  write(b, at, data) { this.queue.writeBuffer(b, at, data); },
  frame: {
    copy(a, at, b, to, n) { b.data.set(a.data.subarray(at, at + n), to); },
    clear(b, at = 0, n = b.size - at) { calls.push({ name: 'clear', b, at, n }); b.data.fill(0, at, at + n); },
  },
  // v2invalidate: the fold's stand-in sets the tiles the test asks for (part 2 holds the real fold)
  kernel: ({ name }) => ({ name, ready: Promise.resolve(), dispatch(f, size, opts) {
    calls.push({ name, size, opts });
    if (name === 'v2invalidate' && foldInto) { const w = new Uint32Array(opts.bind[2].entries[3].resource.buffer.data.buffer); for (const [i, v] of foldInto) w[v2ChangeLayout(g).base + i] |= v; }
  } }),
  readback: { buffer(b, at, n) { const bytes = b.data.slice(at, at + n).buffer; calls.push({ name: 'read', b, at, n }); let settle; const p = new Promise((res, rej) => { settle = () => (failRead ? rej(new Error('lost')) : res(bytes)); }); reads.push(settle); return p; } },
  flush() {},
};
const g = gridLayout(64, 32, 32), bytes = g.slots * 16;
const sim = Object.assign(Object.create(Simulation.prototype), {
  gpu, g, id: 1, origin: { x: 96, y: 0, z: 48, clone() { return { x: this.x, y: this.y, z: this.z }; } }, cur: 1, version: 0, wholeWrites: 0, frame: 0, paints: 0,
  L: { TABLES: [], STATE_RO: [], UNDO: [] }, tables: {}, marks: buffer({ size: marksLayout(g).words * 4 }),
  state: { A: buffer({ size: bytes * 2 }), B: buffer({ size: bytes * 2 }), F: buffer({ size: g.slots * 8 }) },
  _bindRO: {}, _bindRW: {}, _bindFlagsRO: {}, _bindAct: {}, history: [],
  wake() {}, _retire() {}, stillFlow() {}, rays: { wake() {} },
  passes: { undoShift: { name: 'undoShift', dispatch() {} } },
});
const source = Object.assign(Object.create(WorldRenderSource.prototype), { sim, context: { size: [512, 32, 512] }, chunks: new Map(), epoch: 3, revision: 0, contentRevision: 0 });
sim.worldRenderSource = source;
const owner = new PhysicsV2(sim);
await owner.ready;
const C = v2ChangeLayout(g), win = { lo: [96, 0, 48], hi: [160, 32, 80] };
const settleAll = async () => { while (reads.length) reads.shift()(); await new Promise((r) => setTimeout(r, 0)); };
const last = () => source.changeJournal.at(-1);
const box = (e) => ({ lo: [e.loX, e.loY, e.loZ], hi: [e.hiX, e.hiY, e.hiZ] });
// the first batch: the whole window at once (a new owner), then the batch's read and the tiles' clear
calls.length = 0;
owner.ticks(1);
assert.deepEqual(box(last()), win, 'the first batch reports the whole window');
const read = calls.findIndex((c) => c.name === 'read' && c.b === owner.args);
assert(read >= 0, 'the batch reads the args');
assert.equal(calls[read].at, ARGS2.STATS * 4, '... from the stats');
assert.equal(calls[read].n, (C.allocated - ARGS2.STATS) * 4, '... through the tiles');
assert(calls.slice(read).some((c) => c.name === 'clear' && c.b === owner.args && c.at === C.base * 4 && c.n === C.count * 4), 'and clears the tiles after the read');
assert(read > calls.map((c) => c.name).lastIndexOf('v2invalidate'), 'after the tick folded them');
assert.equal(calls.find((c) => c.name === 'v2invalidate').opts.params.full, 0, 'no air ran (no dynamics): its live words are not the tick\'s');
assert(owner.idleRead, 'the idle read waits on the batch\'s read');
await settleAll();
assert.equal(source.changeJournal.length, 1, 'nothing changed: no report');
assert(owner.stats.length === STATS.words, 'the idle read took its stats from the batch\'s read');
// a batch whose fold set tiles 0 (bricks 1-2 x, 0 y, 3 z) and 1 (tile [1, 0, 0]: brick 5 x, 7 y, 0 z): two boxes, quantized
assert.deepEqual(C.tiles, [2, 1, 1]);
foldInto = [[0, (2 | 4) | (256 << 0) | (65536 << 3)], [1, (1 << 5) | (256 << 7) | 65536]];
owner.ticks(2);
foldInto = null;
const before = source.contentRevision;
sim.origin.x = 112;   // the window moves before the read comes back: the report keeps the ticks' origin
await settleAll();
sim.origin.x = 96;
assert.equal(source.contentRevision, before + 1, 'one report for the batch');
assert.deepEqual(last().boxes.map(box), [
  { lo: [96, 0, 48], hi: [96 + 16, 16, 48 + 16] },          // bricks x 1-2, y 0, z 3: the first quanta
  { lo: [96 + 48, 16, 48], hi: [96 + 64, 32, 48 + 16] },    // tile 1's brick x 5 (cells 52-56), y 7, z 0
], 'each tile\'s bricks, in world cells at the ticks\' origin, widened to 16-cell quanta');
const delta = source.changesSince({ epoch: 3, sourceRevision: before });
assert.equal(delta.changedBricks.length, 4 * 4 * 4 + 4 * 4 * 4, 'the delta lists both boxes\' bricks once');
// the same report again (the linger keeps it): the journal's last entry is replaced, not grown
const length = source.changeJournal.length;
owner.ticks(1); await settleAll();
assert.equal(source.changeJournal.length, length, 'the same change again replaces the last entry');
assert.equal(last().revision, source.contentRevision);
// a reset source (a new world) drops a report in flight; a failed read reports the whole window
foldInto = [[0, 1 | 256 | 65536]];
owner.ticks(1); foldInto = null;
source.epoch = 4; source.changeJournal = []; source.contentRevision = 0;
await settleAll();
assert.equal(source.changeJournal.length, 0, 'a report into a reset source is dropped');
failRead = true; owner.ticks(1); await settleAll(); failRead = false;
assert.deepEqual(box(last()), win, 'a failed read reports the whole window');
// an undo is a whole-grid write: the whole window at once
const n0 = source.changeJournal.length, r0 = source.contentRevision;
owner.restore(buffer({ size: bytes }));
assert.equal(source.contentRevision, r0 + 1, 'an undo reports at once');
assert.deepEqual(box(last()), win, 'an undo reports the whole window');
assert.equal(source.changeJournal.length, n0, '(the same whole window again: it replaces the failed read\'s entry)');
owner.dispose();

const share = (100 * reported / windowCells).toFixed(1);
console.log(`change bounds: ${linted} V2 kernels' writes noted (${otherWriters.size} other writers each report themselves); ${folds} folds (WGSL executed) exact; ` +
  `${ticks} ticks of column water: all ${changedCells} changed cells inside the reports, which held ${share}% of the window's cells a tick on average (the whole window before), empty in ${rests} rested ticks; ` +
  `the driver reads, clears, reports at the ticks' origin, collapses repeats and falls back to the window`);

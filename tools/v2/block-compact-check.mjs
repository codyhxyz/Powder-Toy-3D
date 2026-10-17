// CPU only: emitted predicates/dispatch, original-ID geometry, shuffled replay.
// This is not a native GPU replay, compile-time/resource or Metal speed claim.
import assert from 'node:assert/strict';
import { E } from '../../src/elements.js';
import { gridLayout, cellTexel } from '../../src/sim.js';
import { brickCoordOf, brickIdOf, SEED_MAX, LAYOUT } from '../../src/shaders/common.js';
import { PhysicsV2, offsetOf } from '../../src/v2/physics.js';
import { fold } from '../../src/gpu/kernels.js';
import { EDGE, GRAV } from '../../src/simModes.js';
import { edgeCell } from '../../src/v2/modes.js';
import { makeMaterial } from '../../src/v2/layout.js';
import { setFall } from '../../src/v2/fall.js';
import * as C from '../../src/v2/contact.js';
import { modeWGSL } from '../../src/shaders/v2/modes.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { ARGS2, V2_KERNELS, WGSL_CHECK, v2BlockWGSL, v2BlockClassifyWGSL, v2BlockFinalizeWGSL, v2BlockCompactLayout, v2Rows, v2Table } from '../../src/shaders/v2.js';
import { buildFixture } from './frame-bench.mjs';
import { wgslGroupingErrors, assertNaga, importMinified } from './wgsl-grouping.mjs';

const g = gridLayout(16, 16, 16), dims = [16, 16, 16];
const original = v2BlockWGSL(g, contactWGSL), heavy = v2BlockWGSL(g, contactWGSL, true), scan = v2BlockClassifyWGSL(g);
const identity = code => code.slice(code.indexOf('  // Canonical full WATER'), code.indexOf('  // R2 topple'));
const predicateSource = identity(original).trim();
assert(scan.includes(predicateSource), 'classifier uses the exact original production predicate');
assert(!scan.includes('fn contactBlock(')); assert(!scan.includes('var orig:'));
assert(scan.includes('liquidScratch: array<atomic<u32>>'));
assert(scan.includes('let t = foldId(wg, nwg) * 64u + li;'));
assert(scan.includes('atomicStore(&liquidScratch['));
assert(heavy.includes('let e = t / 8u;')); assert(heavy.includes('let j = t % 8u;'));
assert(!heavy.includes('var zeroWork'));
assert.equal(heavy.slice(heavy.indexOf('  // R2 topple')), original.slice(original.indexOf('  // R2 topple')), 'entire heavy body/RNG/contact/boundary/store unchanged');
for (const custom of ['', contactWGSL + '\n', 'fn contactBlock() {}']) {
  assert.equal(v2BlockWGSL(g, custom, true), v2BlockWGSL(g, custom), 'nonproduction emission is unchanged');
}
const f = Math.fround;
const ambientQ = ambient => Math.min(65535, Math.max(0, Math.round(f(f(f(ambient) + f(273.25)) * f(4)))));
const js = predicateSource.replace(/\/\/[^\n]*/g, '')
  .replaceAll('u32(clamp(round((P.ambient+273.25)*4.0),0.0,65535.0))', 'ambientQ(P.ambient)')
  .replace(/cs\[([^\]]+)\]\.([xyzw])/g, (_, i, a) => `cs[${i}][${'xyzw'.indexOf(a)}]`)
  .replace('vec4u(rawTq << 8u, 0u, 0u, 0u)', '[rawTq << 8u, 0u, 0u, 0u]')
  .replace('any(cs[k] != canonicalAir)', 'cs[k].some((v,j)=>v!==canonicalAir[j])')
  .replaceAll('mAirHeat()', '(P.ambientHeat !== 0)').replaceAll('inGrid(positions[k])', 'valid(positions[k])')
  .replaceAll('var ', 'let ').replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1')
  .replaceAll('{ return; }', '{ return true; }');
const emittedPredicate = new Function('cs', 'bs', 'positions', 'pending', 'P', 'blockCount', 'valid', 'ambientQ', `${js}\nreturn false;`);
const valid = p => p.every((v, a) => v >= 0 && v < dims[a]);
const ps = Array.from({ length: 8 }, (_, i) => [6 + (i & 1), 6 + (i >> 2), 6 + ((i >> 1) & 1)]);
const P = { edge: EDGE.SOLID, ambient: 20, ambientHeat: 1, gravMode: GRAV.VERTICAL, gravity: 19.6 };
const zero = new Int32Array(8);
const air = q => Array.from({ length: 8 }, () => new Uint32Array([q << 8, 0, 0, 0]));
const water = () => Array.from({ length: 8 }, () => new Uint32Array([(1173 << 8) | E.WATER, 65536, 0, 0]));
const eligible = (cs, bs = zero, positions = ps, pending = zero, params = P, count = 8) => emittedPredicate(cs, bs, positions, pending, params, count, valid, ambientQ);
for (let q = 0; q <= 41093; q++) assert(eligible(air(q)));
let seed = 77123;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const shuffle = input => { const a = [...input]; for (let i = a.length - 1; i > 0; i--) { const j = random() % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
let waterCases = 0;
for (let bit = 0; bit < 384; bit++) {
  const cs = water(), cell = Math.floor(bit / 48), lane = bit % 48;
  cs[cell][lane < 32 ? 2 : 3] = (2 ** (lane % 32)) >>> 0; assert(eligible(cs)); waterCases++;
}
for (let i = 0; i < 512; i++) {
  const cs = water(); for (const c of cs) { c[2] = random(); c[3] = random() & 65535; }
  assert(eligible(cs)); waterCases++;
}
assert.equal(waterCases, 896);
for (const base of [air(1173), water()]) {
  for (let i = 0; i < 8; i++) {
    const banks = new Int32Array(8); banks[i] = -1; assert(!eligible(base, banks));
    const requests = new Uint32Array(8); requests[i] = 1; assert(!eligible(base, zero, ps, requests));
    const outside = ps.map(p => [...p]); outside[i][0] = -1; assert(!eligible(base, zero, outside));
    for (let lane = 0; lane < 4; lane++) for (let bit = 0; bit < 32; bit++) {
      const cs = base.map(c => new Uint32Array(c)); cs[i][lane] ^= (2 ** bit) >>> 0;
      const allowedFlux = (base[0][0] & 255) === E.WATER && (lane === 2 || (lane === 3 && bit < 16));
      assert.equal(eligible(cs), allowedFlux, `${i}/${lane}/${bit}`);
    }
  }
  assert(!eligible(base, zero, ps, zero, P, 7));
}
assert(!eligible(air(41094))); assert(!eligible(water(), zero, ps, zero, { ...P, ambient: 21 }));
assert(!eligible(air(1173), zero, ps, zero, { ...P, edge: EDGE.VOID, ambient: 21 }));
console.log('Emitted predicate: 41094 AIR, 896 opaque WATER and strict negatives; heavy suffix byte-identical');

const permutation = modeWGSL.slice(modeWGSL.indexOf('  var p=o;'), modeWGSL.indexOf('\nfn mAirVelocity'))
  .replace(/}\s*$/, '').replace('var p=o;', 'let p=[...o];').replace(/vec3i\(([^)]+)\)/g, '[$1]')
  .replace(/\b(o|p|down)\.([xyz])/g, (_, v, a) => `${v}[${'xyz'.indexOf(a)}]`);
const blockOffset = new Function('o', 'down', permutation);
const off8 = i => [i & 1, i >> 2, (i >> 1) & 1];
const add = (a, b) => a.map((v, i) => v + b[i]);
const key = p => p.join(',');
const index = p => p[0] + 16 * (p[2] + 16 * p[1]);
function positionsOf(t, awake, offset, down, edge, grid = g) {
  const b = awake[Math.floor(t / 8)], j = t % 8;
  const c0 = brickCoordOf(grid, b).map((v, a) => 4 * v + offset[a] + 2 * off8(j)[[0, 2, 1][a]] - 1);
  return Array.from({ length: 8 }, (_, i) => {
    const p = add(c0, blockOffset(off8(i), down));
    return edgeCell(p, [grid.nx, grid.ny, grid.nz], edge) ?? p;
  });
}
const allAwake = Array.from({ length: g.nbricks }, (_, b) => b);
const downAxes = [[0, 0, 0], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
// Pin the actual production seed algorithm; original positions, ticks and salts
// imply identical per-corner random streams regardless of compact list order.
assert(original.includes('return seedWorld(p + H.origin, frame, salt);'));
assert(original.includes('let s = v * 747796405u + 2891336453u;'));
const pcg = v => { const s = (Math.imul(v, 747796405) + 2891336453) >>> 0; const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0; return ((w >>> 22) ^ w) >>> 0; };
const seed3 = (p, tick, salt) => pcg((p[0] + pcg((p[1] + pcg((p[2] + pcg((Math.imul(tick, 1664525) + salt) >>> 0)) >>> 0)) >>> 0)) >>> 0);
let geometries = 0;
for (let offset = 0; offset < 8; offset++) for (const edge of Object.values(EDGE)) for (const down of downAxes) {
  for (const awake of [allAwake, shuffle(allAwake).slice(0, 7)]) {
    const owned = new Set(), support = new Set(), expected = new Map();
    for (let t = 0; t < awake.length * 8; t++) {
      const positions = positionsOf(t, awake, off8(offset), down, edge);
      expected.set(t, positions);
      for (const p of positions) if (valid(p)) { assert(!owned.has(key(p))); owned.add(key(p)); }
      for (const p of positionsOf(t, awake, off8(offset), [0, 0, 0], edge)) if (valid(p)) support.add(key(p));
    }
    assert.deepEqual(owned, support, 'support retains ALL original targets, including skipped blocks/halo');
    if (awake === allAwake) {
      if (edge === EDGE.LOOP) assert.equal(owned.size, g.slots);
      else assert.equal(owned.size, off8(offset).reduce((n, v) => n * (15 + v), 1), 'do not repair original excluded stripes');
    }
    for (const t of shuffle([...expected.keys()])) {
      const foldId = Math.floor(t / 64), li = t % 64;
      assert.equal(8 * foldId + Math.floor(li / 8), Math.floor(t / 8));
      assert.equal(li % 8, t % 8);
      const decoded = positionsOf(t, awake, off8(offset), down, edge);
      assert.deepEqual(decoded, expected.get(t));
      for (let i = 0; i < 8; i++) for (const salt of [77, 78, 79 + i, 4242])
        assert.equal(seed3(decoded[i], 48, salt), seed3(expected.get(t)[i], 48, salt));
    }
  }
  geometries++;
}
assert.equal(geometries, 168);
// Original dispatch itself can fold into 2D. Padded classifier invocations
// must return before reading an awake-list element, even on the final row.
for (const awakeCount of [0, 1, 7, 8, 9, 524280, 524281, 1048576]) {
  const [x, y] = fold(Math.ceil(awakeCount / 8));
  if (!x) { assert.equal(awakeCount, 0); continue; }
  for (const wy of new Set([0, y - 1])) for (const wx of new Set([0, x - 1])) for (const li of [0, 7, 8, 63]) {
    const folded = wx + wy * x, t = 64 * folded + li;
    assert.equal(Math.floor(t / 8), 8 * folded + Math.floor(li / 8));
    assert.equal(t % 8, li % 8);
    assert.equal(Math.floor(t / 8) < awakeCount, t < awakeCount * 8);
    assert(t < 0x100000000);
  }
  assert(x * y * 64 >= awakeCount * 8);
}

// Execute the emitted finalizer, checking byte36 only and all folding/padding.
const tail = v2BlockCompactLayout(g), finalizeCode = v2BlockFinalizeWGSL(g);
const finalizeBody = finalizeCode.slice(finalizeCode.indexOf('fn main() {') + 11, finalizeCode.lastIndexOf('}'))
  .replaceAll('let ', 'const ').replace(/\b(\d+)u\b/g, '$1').replaceAll('max(', 'Math.max(')
  .replace('const groups = (count + 63) / 64;', 'const groups = Math.floor((count + 63) / 64);')
  .replace('(groups + 65534) / 65535', 'Math.floor((groups + 65534) / 65535)')
  .replace('(groups + y - 1) / y', 'Math.floor((groups + y - 1) / y)');
const finalize = new Function('scratch', 'args', finalizeBody);
for (const count of [0, 1, 7, 8, 63, 64, 65, tail.capacity, 65535 * 64, 65535 * 64 + 1, 9000000]) {
  const scratch = { [tail.header / 4]: count }, args = new Uint32Array(32).fill(0xaabbccdd);
  finalize(scratch, args); assert.deepEqual([...args.slice(9, 12)], fold(Math.ceil(count / 64)));
  assert(args.every((v, i) => (i >= 9 && i < 12) || v === 0xaabbccdd));
  const [x, y, z] = args.slice(9, 12); assert(x <= 65535 && y <= 65535 && z === 1);
  assert(x * y * 64 >= count && x * y * 64 - count < y * 64);
}
const big = v2BlockCompactLayout(gridLayout(128, 128, 128));
assert.equal(big.bytes - 128 ** 3 * 16, 1048592); assert.equal(big.capacity, 262144);
assert.throws(() => v2BlockCompactLayout(g, { maxStorageBufferBindingSize: tail.bytes - 1 }), /bounds/);
assert.throws(() => v2BlockCompactLayout(g, { maxBufferSize: tail.bytes - 1 }), /bounds/);
assert.throws(() => v2BlockCompactLayout({ nx: 65536, ny: 65536, nz: 65536 }), /bounds/);
for (const awakeCount of [0, 1, 7, 8, 9, g.nbricks]) for (const keep of [() => false, () => true, t => t % 3 === 0]) {
  const scratch = new Uint32Array(tail.bytes / 4).fill(0xdeadbeef);
  scratch.fill(0, tail.header / 4, tail.list / 4);
  const ids = shuffle(Array.from({ length: awakeCount * 8 }, (_, t) => t)).filter(keep);
  for (const t of ids) { const at = scratch[tail.header / 4]++; scratch[tail.list / 4 + at] = t; }
  assert(scratch.subarray(0, tail.header / 4).every(v => v === 0xdeadbeef));
  assert.deepEqual([...scratch.subarray(tail.list / 4, tail.list / 4 + ids.length)], ids);
  assert(scratch.subarray(tail.list / 4 + ids.length).every(v => v === 0xdeadbeef));
  assert.equal(scratch[tail.header / 4], ids.length);
}
console.log('168 offset/edge/gravity permutations; partial wake, original IDs/corners/RNG, zero/full/fold/tail bounds');

// Actual driver, recorded without GPU. No writable args on classifier; direct
// finalizer has only scratch+args; custom dispatch/resources remain original.
globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
async function record(contact, limits = {}, expectCompact = contact === contactWGSL) {
  const commands = [], buffers = [], compiled = [], uploads = [];
  const gpu = {
    device: { limits: { maxStorageBufferBindingSize: 134217728, maxBufferSize: 268435456, ...limits } },
    createBuffer(d) { const b = { ...d, destroy() {} }; buffers.push(b); return b; },
    queue: { writeBuffer(...args) { uploads.push(args); } }, write() {}, layout(name, entries) { return { name, entries }; },
    bindGroup(layout, entries) { assert.equal(entries.length, layout.entries.length); return { layout, entries }; },
    L: { EMPTY: { entries: [] } }, emptyGroup: {},
    kernel(d) { compiled.push(d); return { ...d, ready: Promise.resolve(), dispatch(frame, size, data) { commands.push({ name: d.name, size, data }); } }; },
    frame: { clear(...args) { commands.push({ name: 'clear', args }); } },
  };
  const sim = { gpu, g, id: 1, version: 0, wholeWrites: 0, state: { A: {}, B: {}, F: {} }, marks: {}, tables: {},
    L: { STATE_RO: { entries: [0, 1] }, TABLES: { entries: [0] } }, header: () => ({}), ready: Promise.resolve() };
  const engine = new PhysicsV2(sim, { contactWGSL: contact }); await engine.ready;
  engine._tick();
  assert.equal(buffers.length, 8, 'existing driver buffers only; no phase buffer');
  const tableUploads = uploads.filter(([buffer]) => buffer.label === 'v2 elements');
  assert.equal(tableUploads.length, 1, 'one existing immutable table upload');
  assert.deepEqual(new Uint8Array(tableUploads[0][2].buffer), new Uint8Array(v2Table().buffer), 'table ABI and bytes unchanged');
  assert.equal(engine.kernels.v2block.layouts.length, 3);
  assert.equal(engine.kernels.v2block.layouts[1], gpu.L.EMPTY);
  assert.equal(engine.kernels.v2block.layouts[2].name, 'V2_CONTACT', 'existing contact binding family');
  assert.equal(compiled.filter(k => k.build === 'now').length, 1); assert.equal(compiled.filter(k => k.code.includes('fn contactBlock(')).length, contact ? 1 : 0);
  for (const k of compiled) {
    const storage = k.layouts.flatMap(l => l.entries ?? []).filter(e => e?.buffer?.type?.includes('storage')).length;
    assert(storage <= 8, `${k.name}: ${storage}`);
  }
  assert.equal(buffers.filter(b => b.usage & GPUBufferUsage.INDIRECT).length, 1);
  const supportAt = commands.findIndex(c => c.name === 'v2support');
  if (expectCompact) {
    assert.deepEqual(commands.slice(supportAt, supportAt + 5).map(c => c.name), ['v2support', 'clear', 'v2blockClassify', 'v2blockFinalize', 'v2block']);
    const [support, clear, classify, final, block] = commands.slice(supportAt, supportAt + 5);
    assert.equal(support.size.offset, ARGS2.BRICKS * 4);
    assert.deepEqual(clear.args, [engine.liquidScratch, tail.header, 16]);
    assert.equal(classify.size.offset, 24); assert(!classify.data.bind[2].entries.some(e => e.resource.buffer === engine.args));
    assert.deepEqual(final.size, [1, 1, 1]); assert.equal(final.data.bind[2].entries.length, 2);
    assert.equal(engine.kernels.v2blockFinalize.layouts[0], gpu.L.EMPTY);
    assert.equal(engine.kernels.v2blockFinalize.layouts[1], gpu.L.EMPTY);
    assert.deepEqual(final.data.bind[2].entries.map(e => e.resource.buffer), [engine.liquidScratch, engine.args]);
    assert.equal(block.size.offset, 36); assert.equal(block.size.indirect, engine.args);
    assert.equal(engine.liquidScratch.size, tail.bytes);
    assert.equal(engine.kernels.v2block.code, v2BlockWGSL(g, contactWGSL, true));
  } else {
    assert.equal(engine.blockCompact, null, 'custom contact or insufficient tail capacity keeps original dispatch');
    assert.deepEqual(commands.slice(supportAt, supportAt + 2).map(c => c.name), ['v2support', 'v2block']);
    assert.equal(commands[supportAt + 1].size.offset, 24);
    assert.equal(engine.liquidScratch.size, g.slots * 16);
    assert.equal(compiled.length, V2_KERNELS.length);
    assert.equal(engine.kernels.v2block.code, v2BlockWGSL(g, contact));
  }
}
for (const contact of [contactWGSL, '', contactWGSL + '\n']) await record(contact);
await record(contactWGSL, { maxStorageBufferBindingSize: g.slots * 16 }, false);
await record(contactWGSL, { maxBufferSize: g.slots * 16 }, false);
await record(contactWGSL, { maxStorageBufferBindingSize: tail.bytes, maxBufferSize: tail.bytes });
for (const k of WGSL_CHECK.filter(k => /v2block(Classify|Finalize|Compact)/.test(k.name))) {
  const storage = k.layouts(g).flatMap(l => typeof l === 'string' ? LAYOUT[l] ?? [] : l).filter(e => e?.buffer?.type?.includes('storage')).length;
  assert(storage <= 8);
}
console.log('Real driver: support -> tail clear -> original indirect classify -> DIRECT finalize -> heavy byte36; custom unchanged, max8 storage');

// Full production contact replay; include actual emitted motion (not a sorted
// material simulation). Syntax-only translation, with CPU storage helpers.
let motion = original.slice(original.indexOf('  // R2 topple'), original.indexOf('  // Obligations follow'));
motion = motion.replace(/\/\/[^\n]*/g, '').replaceAll('var ', 'let ')
  .replace(/array<u32, 3>\(([^)]+)\)/g, '[$1]').replace(/array<f32, 3>\(([^)]+)\)/g, '[$1]')
  .replace(/\b(\d+)u\b/g, '$1').replaceAll('pt + down*i32(dd)', 'add(pt,down.map(v=>v*dd))')
  .replaceAll('rnd(&rs)', '(rs=pcg(rs), unit(rs))');
const rows = v2Rows(), clsOf = c => rows[c[0] & 255].cls;
const withAge = (c, age) => new Uint32Array([(c[0] & 0xffffff) | (Math.min(age, 255) << 24), c[1], c[2], c[3]]);
const zeroQ = c => [0, 3].includes(clsOf(c)) ? new Uint32Array([c[0], c[1], 0, c[3] & 0xffff0000]) : c;
const helpers = { add, pcg, seed3, unit: s => f(f(f(s >>> 8) * 256) + f(s & 255)) / 4294967296,
  clsOf, inGrid: valid, fluidC: c => [0, 3, 4].includes(clsOf(c)), dropOfE: id => rows[id].drop,
  cid: c => c[0] & 255, cAge: c => c[0] >>> 24, withAge, zeroQ, setFall,
  resetMotionAge: c => clsOf(c) === 3 ? c : clsOf(c) === 2 ? setFall(c, 0, 0) : withAge(c, 0),
  motionDensity: c => C.ctDensity(C.unpackContact(c)), select: (a, b, yes) => yes ? b : a,
  C_SOLID: 1, C_POWDER: 2, C_LIQUID: 3, C_AIR: 0, C_GAS: 4,
  MOORE_U: 0x80000000, SINK_RATE: 0.6, LIQ_SWAP: 0.3, GAS_SWAP: 0.5, DIFFUSE: 0.25, DIFFUSE_AGE: 120 };
const move = new Function(...Object.keys(helpers), 'cs', 'bs', 'positions', 'pending', 'P', 'down', 'supportAt', 'markBusy', `const gravityOn=down.some(v=>v!==0),blockCount=8,columnCount=4;${motion}`);
const clone = a => a.map(c => new Uint32Array(c));
function replay(compact, order, ticks, edge, down, awake = allAwake, startTick = 1) {
  const cores = Array.from({ length: g.slots }, () => makeMaterial(E.EMPTY).core), banks = new Int32Array(g.slots), events = new Uint32Array(g.slots);
  // Dense enough to exercise motion/contact, sparse enough to keep identity
  // blocks. Include opaque SMOKE history and carry the replay through tick48.
  for (let y = 4; y < 12; y++) for (let z = 4; z < 12; z++) for (let x = 4; x < 12; x++) {
    const s = index([x, y, z]), ids = [E.SMOKE, E.WATER, E.SAND, E.OIL, E.WOOD, E.EMPTY];
    const m = makeMaterial(ids[(x + 3 * y + z) % ids.length], 20); cores[s] = m.core; banks[s] = (s % 17) - 8;
    if ((cores[s][0] & 255) === E.SMOKE) { cores[s][2] = 0xaabbccdd; cores[s][3] = 0x12345678; }
    if (s % 37 === 0) events[s] = 1;
  }
  const marks = new Uint32Array(g.slots).fill(0x80), dirty = new Uint32Array(g.slots).fill(0x40), visible = new Uint32Array(g.slots).fill(0x20);
  let source = 0n, sink = 0n;
  for (let step = 0; step < ticks; step++) {
    const tick = startTick + step;
    const frozen = clone(cores), params = { ...P, edge, offset: offsetOf(tick), tick };
    const work = Array.from({ length: awake.length * 8 }, (_, t) => t);
    const positions = work.map(t => positionsOf(t, awake, params.offset, down, edge));
    const load = ps => ps.map(p => valid(p) ? cores[index(p)] : new Uint32Array([E.WALL, 0, 0, 0]));
    const local = (array, ps) => ps.map(p => valid(p) ? array[index(p)] : 0);
    const survivors = compact ? work.filter(t => !eligible(load(positions[t]), local(banks, positions[t]), positions[t], local(events, positions[t]), params)) : work;
    const list = order === 'shuffle' ? shuffle(survivors) : order === 'reverse' ? survivors.reverse() : survivors;
    const supportAt = p => { const q = edgeCell(p, dims, edge); return !q ? edge !== EDGE.VOID : [1, 2].includes(clsOf(frozen[index(q)])); };
    for (const t of list) {
      const ps = positions[t], vs = ps.map(valid), before = clone(load(ps)), cs = clone(before), bs = local(banks, ps), oldBanks = [...bs], pending = local(events, ps);
      const outside = ps.map((p, i) => {
        const counts = [0, 0, 0, 0], o = blockOffset(off8(i), down);
        for (let a = 0; a < 3; a++) {
          const q = [...p]; q[a] += o[a] ? 1 : -1;
          const n = edgeCell(q, dims, edge), c = n ? frozen[index(n)] : new Uint32Array([E.WALL, 0, 0, 0]), id = c[0] & 255;
          counts[0] += +(id === E.EMPTY); counts[1] += +(id === E.OXYGEN || (id === E.FIRE && C.unpackContact(c).ctype === E.OXYGEN));
          counts[2] += +(id === E.CO2); counts[3] += +[0, 4].includes(clsOf(c));
        }
        return counts;
      });
      const markBusy = p => { const q = edgeCell(p, dims, edge); if (q) marks[index(q)] = 1; };
      move(...Object.values(helpers), cs, bs, ps, pending, params, down, supportAt, markBusy);
      const out = C.contactReference(cs, bs, tick, ps, pending, vs, outside);
      for (const i of out.busy) if (vs[i]) markBusy(ps[i]);
      for (let i = 0; i < 8; i++) if (vs[i]) {
        let core = out.cores[i], bank = out.banks[i]; source += out.sources[i]; sink += out.sinks[i];
        if (edge === EDGE.VOID) {
          const p = ps[i], open = +(p[0] === 0) + +(p[0] === 15) + +(p[2] === 0) + +(p[2] === 15) + +(p[1] === 15);
          if (open) {
            const boundary = C.ctBoundary(C.unpackContact(core, bank), open, 1173), packed = C.packContact(boundary, core);
            core = packed.core; bank = packed.bank; source += boundary.source; sink += boundary.sink;
            if (boundary.busy) markBusy(p);
          }
        }
        const s = index(ps[i]);
        if (before[i].some((v, j) => v !== core[j]) || oldBanks[i] !== bank) dirty[s] = 1;
        // Exact equal-core writes must retain previous marks. Differing-core
        // visibility is conservatively marked in both CPU paths (not a render oracle).
        if (before[i].some((v, j) => v !== core[j])) visible[s] = 1;
        cores[s] = core; banks[s] = bank; events[s] = pending[i] | out.requests[i];
      }
    }
  }
  return { cores, banks, events, marks, dirty, visible, source, sink };
}
for (let tick = 1; tick <= 8; tick++) for (const edge of Object.values(EDGE)) for (const down of downAxes) {
  const expected = replay(false, 'forward', 1, edge, down, allAwake, tick);
  assert.deepEqual(replay(true, 'shuffle', 1, edge, down, allAwake, tick), expected);
}
const partial = shuffle(allAwake).slice(0, 7);
assert.deepEqual(replay(true, 'shuffle', 8, EDGE.LOOP, [1, 0, 0], partial), replay(false, 'forward', 8, EDGE.LOOP, [1, 0, 0], partial));
const expected48 = replay(false, 'forward', 48, EDGE.LOOP, [0, -1, 0]);
assert.deepEqual(replay(true, 'shuffle', 48, EDGE.LOOP, [0, -1, 0]), expected48);
assert.deepEqual(replay(true, 'reverse', 48, EDGE.LOOP, [0, -1, 0]), expected48);
assert(expected48.cores.some(c => (c[0] & 255) === E.SMOKE), 'SMOKE included through tick48');
console.log('Full production contact + emitted motion replay: shuffled/reversed original IDs, exact cores/banks/requests/opaque/marks/ledgers through SMOKE tick48');

// Initial CPU import census of the real benchmark fixture; NOT evolved or GPU
// coverage. Only non-AIR imported bricks wake, with the original 3^3 dilation.
const fixtureGrid = gridLayout(128, 128, 128), fixture = buildFixture({ g: fixtureGrid, cellTexel: (x, y, z) => cellTexel(fixtureGrid, x, y, z) }, E, SEED_MAX, 'water', 1);
const ids = new Uint8Array(fixtureGrid.slots), busy = new Set();
for (let y = 0; y < 128; y++) for (let z = 0; z < 128; z++) for (let x = 0; x < 128; x++) {
  const i = cellTexel(fixtureGrid, x, y, z) * 4, id = fixture.A[i]; ids[x + 128 * (z + 128 * y)] = id;
  assert.equal(fixture.A[i + 1], 20); assert.equal(fixture.A[i + 2], 0); assert(fixture.A[i + 3] < 1);
  if (id !== E.EMPTY) busy.add(brickIdOf(fixtureGrid, x >> 2, y >> 2, z >> 2));
}
const awakeSet = new Set();
for (const b of busy) {
  const p = brickCoordOf(fixtureGrid, b);
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const q = add(p, [dx, dy, dz]); if (q.every(v => v >= 0 && v < 32)) awakeSet.add(brickIdOf(fixtureGrid, ...q));
  }
}
assert.equal(awakeSet.size, 9088);
const awake = [...awakeSet], fractions = [];
for (let offset = 0; offset < 8; offset++) {
  let airCount = 0, waterCount = 0;
  for (let t = 0; t < awake.length * 8; t++) {
    const ps = positionsOf(t, awake, off8(offset), [0, -1, 0], EDGE.SOLID, fixtureGrid);
    const block = ps.map(p => p.every(v => v >= 0 && v < 128) ? ids[p[0] + 128 * (p[2] + 128 * p[1])] : -1);
    if (block.every(id => id === E.EMPTY)) airCount++;
    if (block.every(id => id === E.WATER)) waterCount++;
  }
  fractions.push((airCount + waterCount) / (awake.length * 8));
  if (key(off8(offset)) === key(offsetOf(1))) { assert.equal(airCount, 26131); assert.equal(waterCount, 28380); }
}
assert(Math.min(...fractions) > .73 && Math.max(...fractions) < .83);
console.log(`INITIAL CPU ONLY eligibility ${(100 * Math.min(...fractions)).toFixed(3)}–${(100 * Math.max(...fractions)).toFixed(3)}%; no evolved/native performance claim`);

const minified = await importMinified('src/shaders/v2.js');
for (const [name, code, emit] of [
  ['classify', scan, m => m.v2BlockClassifyWGSL(g)],
  ['finalize', finalizeCode, m => m.v2BlockFinalizeWGSL(g)],
  ['heavy', heavy, m => m.v2BlockWGSL(g, contactWGSL, true)],
  ['fallback', v2BlockWGSL(g, contactWGSL), m => m.v2BlockWGSL(g, contactWGSL)],
]) {
  assert.equal(emit(minified), code); assert.deepEqual(wgslGroupingErrors(code), []);
  assertNaga(code, name);
}
console.log('Production minified classifier/finalizer/heavy identical; CPU Naga/grouping pass; no GPU');

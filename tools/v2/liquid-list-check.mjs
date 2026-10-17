// CPU-only: the liquid list (docs: src/shaders/v2.js v2FluxWGSL). The first flux lists every awake brick
// in the 3³ neighbourhood of liquid work; the later liquid passes and the jets run over that list only.
// Pins (1) the classifier against gather's own AIR identity, translated from production WGSL, (2) the
// reach: SUB substeps of one-cell moves, plus the neighbour each move reads, never leave the listed
// bricks, periodic seams included, (3) the real driver's dispatch plumbing, recorded without a GPU.
import assert from 'node:assert/strict';
import { E, ELEMENTS, K } from '../../src/elements.js';
import { BRICK } from '../../src/shaders/common.js';
import { gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { ARGS2, SUB, v2FluxWGSL, v2GatherWGSL, v2LimitWGSL, v2FoamWGSL, v2ActScanWGSL, v2LiquidListLayout } from '../../src/shaders/v2.js';
import { jetsWGSL } from '../../src/shaders/v2/jets.js';

const g = gridLayout(32, 16, 48);
const flux = v2FluxWGSL(g), gather = v2GatherWGSL(g);
const fnBody = (code, name) => {
  const start = code.indexOf(`fn ${name}(`), open = code.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < code.length; i++) { if (code[i] === '{') depth++; if (code[i] === '}' && --depth === 0) break; }
  return code.slice(open + 1, i);
};
const js = s => s.replace(/\/\/[^\n]*/g, '').replace(/\b(var|let)\b/g, 'let').replace(/\b(0x[\da-f]+|\d+)u\b/gi, '$1').replaceAll('>>', '>>>');

// (1) Not liquid work = canonical AIR at rest, exactly the cells gather's AIR identity leaves alone with
// no wet neighbour, and with no stored face flux for the later fluxes to rewrite.
const work = new Function('c', 'bank', 'clsOf', 'cRawTq', 'C_LIQUID', 'C_AIR', js(fnBody(flux, 'liquidWork'))
  .replace('any(c.yzw != vec3u(0))', '(c[1] !== 0 || c[2] !== 0 || c[3] !== 0)').replace('banks[s]', 'bank').replaceAll('c.x', 'c[0]'));
const identity = new Function('p', 's', 'before', 'src', 'banks', 'liquidScratch', 'jetMask', 'neighbor', 'inGrid', 'awakeCell', 'slotOf', 'snapshot', 'faceQ', 'isLiq', 'cRawTq', 'cid', 'cAge', 'cFill', 'phaseHotLatent', 'phaseHotQ', 'phaseColdLatent', 'phaseColdQ', 'MATERIAL_BURNS', 'select',
  js(fnBody(gather, 'gatherIdentity')).replace('any(before.xy != src.core.xy)', 'before[0] !== src.core[0] || before[1] !== src.core[1]')
    .replace('any(liquidScratch[other] != frozen)', 'liquidScratch[other].some((v,i)=>v!==frozen[i])').replaceAll('mEdge(p + face6(i32(face)))', 'neighbor(p, face)')
    .replaceAll('src.core.w', 'src.core[3]').replaceAll('src.core.y', 'src.core[1]').replaceAll('before.w', 'before[3]').replaceAll('frozen.x', 'frozen[0]')
    .replaceAll('i32(raw)', 'raw').replace(/atomicLoad\(&jetMask\[([^\]]+)\]\)/g, 'jetMask[$1]'));
const CLS = { [K.EMPTY]: 0, [K.SOLID]: 1, [K.POWDER]: 2, [K.LIQUID]: 3, [K.GAS]: 4 };
const clsOf = c => CLS[ELEMENTS[c[0] & 255]?.kind] ?? 1, cRawTq = c => (c[0] >>> 8) & 0xffff;
const isWork = (c, bank = 0) => work(c, bank, clsOf, cRawTq, 3, 0);
// limit's snapshot of a non-liquid cell: its x (age from jetMask), nothing else; the dry neighbourhood.
const airIdentity = (c, bank = 0) => identity(0, 0, c, { core: [c[0], 0, 0, 0], bank }, [bank], [], [0], (_, f) => f + 1, () => true, () => true, q => q,
  () => ({ core: [0, 0, 0, 0], bank: 0 }), () => 0, () => false, cRawTq, c => c[0] & 255, c => c[0] >>> 24, c => c[1] & 0xffffff, () => 0, () => 0, () => 0, () => 0, [], (a, b, s) => s ? b : a);
for (let q = 0; q <= 0xffff; q++) {
  const c = [(q << 8) >>> 0, 0, 0, 0];
  assert.equal(isWork(c), q > 41093, `AIR code ${q}`);
  assert.equal(airIdentity(c), q > 41093 ? 0 : 1, `gather AIR identity ${q}`);
}
let rejected = 0;
for (const [word, bit] of [[0, 0], [0, 7], [0, 24], [0, 31], ...[1, 2, 3].flatMap(w => [0, 15, 16, 31].map(b => [w, b]))]) {
  const c = [1173 << 8, 0, 0, 0]; c[word] = (c[word] | (1 << bit)) >>> 0;
  if ((c[0] & 255) && clsOf(c) !== 0) continue; // another class, covered below
  assert.equal(isWork(c), true, `perturbed AIR word ${word} bit ${bit}`);
  if (airIdentity(c) === 0) rejected++;
}
for (const bank of [-2147483648, -1, 1, 2147483647]) { assert.equal(isWork([1173 << 8, 0, 0, 0], bank), true); assert.equal(airIdentity([1173 << 8, 0, 0, 0], bank), 0); }
assert(rejected > 0);
for (const e of ELEMENTS) assert.equal(isWork([(e.id | (1173 << 8)) >>> 0, 0, 0, 0]), e.kind === K.LIQUID || (e.kind === K.EMPTY && e.id !== 0), e.key);
// gather returns for every non-open cell before its identity; flux for every non-open cell.
assert(gather.indexOf('if (!isOpenC(src.core)) { return; }') < gather.indexOf('let identity = gatherIdentity('));
assert(fnBody(flux, 'flux').trimStart().startsWith('if (!isOpenC(c)) { return; }'));

// (2) Reach. Listed = the awake bricks within the activity pass's 3³ neighbourhood (mEdge wrap) of
// a brick holding liquid work. Over a tick liquid reaches SUB cells from where it was; each wet cell
// reads its six neighbours. All of it must lie in listed bricks (asleep bricks are never read).
// The activity scan scatters each busy brick over the same 3³ set (negated offsets: the set is symmetric).
assert(v2ActScanWGSL(g).includes('let n = mEdge((bc + vec3i(-dx, -dy, -dz))*BS)/BS;'));
assert(flux.includes('let n = mEdge((brickCoord(b) + vec3i(i32(li % 3u), i32(li / 3u % 3u), i32(li / 9u)) - vec3i(1)) * BS) / BS;'));
assert.deepEqual(new Set(Array.from({ length: 27 }, (_, li) => `${li % 3 - 1},${Math.floor(li / 3) % 3 - 1},${Math.floor(li / 9) - 1}`)).size, 27);
assert(SUB < BRICK);
function reach(loop, seed) {
  const B = 6, N = B * BRICK, idx = (x, y, z) => x + N * (y + N * z);
  let r = seed; const rnd = n => { r = (Math.imul(r, 1103515245) + 12345) >>> 0; return r % n; };
  const wrap = v => loop ? (v + N) % N : v, inside = v => v >= 0 && v < N;
  const work = new Set(), wet = new Set();
  for (let k = 0; k < 6; k++) { const x = rnd(N), y = rnd(N), z = rnd(N); wet.add(idx(x, y, z)); work.add(`${x >> 2},${y >> 2},${z >> 2}`); }
  const listed = (x, y, z) => { for (const w of work) { const [a, b, c] = w.split(',').map(Number);
    if ([[x >> 2, a], [y >> 2, b], [z >> 2, c]].every(([u, v]) => { const d = Math.abs(u - v); return d <= 1 || (loop && d === B - 1); })) return true; } return false; };
  let front = [...wet];
  for (let s = 0; s <= SUB; s++) {
    const next = [];
    for (const i of front) {
      const x = i % N, y = Math.floor(i / N) % N, z = Math.floor(i / (N * N));
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const q = [wrap(x + dx), wrap(y + dy), wrap(z + dz)]; if (!q.every(inside)) continue;
        assert(listed(...q), `cell ${q} read in substep ${s} lies in a listed brick`);
        if (s < SUB && !wet.has(idx(...q))) { wet.add(idx(...q)); next.push(idx(...q)); }
      }
      assert(listed(x, y, z));
    }
    front = next;
  }
}
for (let seed = 1; seed <= 64; seed++) { reach(false, seed); reach(true, seed); }

// (3) The driver: first flux over the awake list builds the list; finalize; everything else over it.
globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8 };
const commands = [];
const gpu = {
  createBuffer(d) { return { ...d, destroy() {} }; }, queue: { writeBuffer() {} }, write() {}, flush() {},
  layout: (name, entries) => ({ name, entries }), L: { EMPTY: { entries: [] } }, emptyGroup: {},
  bindGroup(layout, entries) { return { layout, entries }; },
  kernel(d) { return { ...d, ready: Promise.resolve(), dispatch(frame, size, data) { d.params.pack(data.params); commands.push({ name: d.name, size, ...data }); } }; },
  frame: { clear() {}, copy() {} }, readback: { buffer: (b, o, n) => Promise.resolve(new ArrayBuffer(n)) },
};
const sim = { gpu, g, id: 1, version: 0, wholeWrites: 0, frame: 0, paints: 0, origin: [0, 0, 0], state: { A: {}, B: {}, F: {} }, marks: {}, tables: {},
  L: { STATE_RO: { entries: [0, 1] }, TABLES: { entries: [0] } }, header: () => ({ format: 0 }), noteWrite() {} };
const owner = new PhysicsV2(sim, { Dynamics: NativeDynamics }); await owner.ready; owner.ticks(1);
const at = c => c.size?.indirect === owner.args ? c.size.offset / 4 : null;
const liquid = commands.filter(c => /^v2(flux|limit|gather|foam|liquidFinalize)$|^v2jets_/.test(c.name));
assert.equal(liquid[0].name, 'v2flux'); assert.equal(at(liquid[0]), ARGS2.BRICKS); assert.equal(liquid[0].params.liquidList, 0);
assert.equal(liquid[1].name, 'v2liquidFinalize'); assert.deepEqual(liquid[1].size, [1, 1, 1]);
assert.deepEqual(liquid[1].bind[2].entries.map(e => e.resource.buffer), [owner.jetMask, owner.args]);
for (const c of liquid.slice(2)) {
  if (c.name === 'v2jets_count') assert.deepEqual(c.size, [Math.ceil(g.nbricks / 64), 1, 1], 'every brick keeps its prefix');
  else if (c.name === 'v2jets_allocate') assert.deepEqual(c.size, [1, 1, 1]);
  else { assert.equal(at(c), ARGS2.LIQUID, c.name); if (c.name === 'v2flux') assert.equal(c.params.liquidList, 1); }
}
assert.equal(liquid.filter(c => c.name === 'v2flux').length, SUB); assert.equal(liquid.filter(c => c.name === 'v2liquidFinalize').length, 1);
assert.equal(ARGS2.LIQUID + 3 <= ARGS2.words && ARGS2.LIQUID >= ARGS2.STATS + 8, true, 'own args words');
assert.equal(owner.jetMask.size, v2LiquidListLayout(g).words * 4);
// Gather and the jets see unlisted bricks asleep; flux and limit keep the awake test (equivalent there).
for (const code of [gather, ...['candidate', 'count', 'spawn'].map(s => jetsWGSL(g, s))]) assert(code.includes('fn awakeCell(p: vec3i) -> bool { return liquidListed(p); }'));
for (const code of [flux, v2LimitWGSL(g)]) assert(code.includes('fn awakeCell(p: vec3i) -> bool { return atomicLoad(&act2[V2_AWAKE + brickOfCell(p)]) != 0u; }'));
assert(v2FoamWGSL(g).includes('atomicAnd(&jetMask[LIQ_BITS + (b >> 5u)], ~(1u << (b & 31u)))'), 'the last listed pass clears membership');
console.log(`liquid list: classifier = gather AIR identity (${0x10000} codes, ${rejected} rejected perturbations), reach of ${SUB} substeps inside listed bricks (128 fixtures), driver plumbing: pass`);

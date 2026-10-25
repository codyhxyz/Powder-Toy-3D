// The cost view's honesty, CPU only (docs/profiler.md "Cost view").
//
//  1. Same code: for every lit view, detail level, flat/curved and read format, the cost module is
//     the normal module plus counter spans only (shaders/costView.js verifyCost: stripping the spans
//     gives the normal text byte for byte, and each span is a counter line), and every counter counts.
//     The same for the world march (shaders/world/march.js) of every lit view and level: the whole
//     march, and each split stage (march, reflect, shade), whose counters together count them all.
//  2. Off is off: the normal modules' hashes are the same before shaders/costView.js is imported,
//     after, and after every module has been counted (no state leaks into the generator).
//  3. naga validates every cost module (--no-naga skips it).
//
// usage: node tools/check-cost-view.mjs [--no-naga] [--hashes]   (--hashes prints the normal modules' sha256)
import { createHash } from 'node:crypto';
import { volumeFrag, REALISTIC_LEVELS, VOLUME_VIEWS } from '../src/shaders/render.js';
import { isMaterialView } from '../src/views.js';
import { gridLayout } from '../src/sim.js';
import { worldMarchFrag, MARCH_STAGES, marchSplits, WORLD_MARCH_LAYOUTS } from '../src/shaders/world/march.js';
import { nagaExec } from './naga.mjs';

const argv = process.argv.slice(2);
const NAGA = !argv.includes('--no-naga');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const GRIDS = { 64: gridLayout(64, 64, 64), valley: gridLayout(256, 96, 128) };
const FORMATS = [undefined, 0, 2, 3];

const variants = [];
for (const view of VOLUME_VIEWS.filter(isMaterialView)) {
  for (const [level, d] of Object.entries(REALISTIC_LEVELS)) {
    for (const curved of [false, true]) {
      for (const format of FORMATS) {
        for (const [grid, g] of Object.entries(GRIDS)) {
          if (grid !== '64' && (view !== 'realistic' || curved)) continue;   // (one big grid for the main view)
          variants.push({ name: `${view}.${level}${curved ? '.curved' : ''}.format${format ?? '-'}.${grid}`,
            code: () => volumeFrag(g, { view, detail: d(), curved, fixedReadFormat: format }) });
        }
      }
    }
  }
}

// the world march: its modules are one per (view, detail, stage) for every map (physics' grid only
// sizes the physics-indexed reads)
const PHYS = gridLayout(128, 128, 128);
for (const view of VOLUME_VIEWS.filter(isMaterialView)) {
  for (const [level, d] of Object.entries(REALISTIC_LEVELS)) {
    for (const stage of ['whole', ...(marchSplits(d()) ? MARCH_STAGES : [])]) {
      variants.push({ name: `world.${view}.${level}.${stage}`, split: stage === 'whole' ? null : `${view}.${level}`,
        stage, code: () => worldMarchFrag(PHYS, { view, detail: d(), stage }) });
    }
  }
}

// 2: hashes before the cost module exists in this process
const before = new Map(variants.map((v) => [v.name, sha(v.code())]));
const { costify, verifyCost, stripCost, costBinding, COST_KINDS } = await import('../src/shaders/costView.js');
const optsOf = (v) => (v.stage ? { sink: 'storage', binding: costBinding(WORLD_MARCH_LAYOUTS(undefined, v.stage)[0]), require: v.split ? [] : COST_KINDS } : {});
const splitCounts = new Map();   // a split's stages: the counters each counts

let failed = 0;
const fail = (msg) => { failed++; console.error(`FAIL ${msg}`); };
const naga = new Set();
for (const v of variants) {
  const normal = v.code();
  if (sha(normal) !== before.get(v.name)) fail(`${v.name}: the normal module changed once shaders/costView.js was imported`);
  const opts = optsOf(v);
  const cost = costify(normal, opts);
  const r = verifyCost(normal, cost, { require: opts.require ?? COST_KINDS });
  if (!r.ok) fail(`${v.name}: ${r.problems.join('; ')}`);
  if (v.split) {
    const set = splitCounts.get(v.split) ?? new Set();
    for (const [k, n] of Object.entries(r.bumps)) if (n) set.add(k);
    splitCounts.set(v.split, set);
  }
  if (stripCost(cost) !== normal) fail(`${v.name}: strip(cost) != normal`);
  if (NAGA && !naga.has(sha(cost))) {
    naga.add(sha(cost));
    try { nagaExec(cost, `${v.name}.cost.wgsl`); } catch (e) { fail(`${v.name}: naga\n${e.message.slice(0, 2000)}`); }
  }
}
for (const [name, set] of splitCounts) {
  const missing = COST_KINDS.filter((k) => !set.has(k));
  if (missing.length) fail(`world.${name}: the split stages together never count ${missing.join(', ')}`);
}
// and once more after everything was counted
for (const v of variants) if (sha(v.code()) !== before.get(v.name)) fail(`${v.name}: the normal module changed after counting`);

if (argv.includes('--hashes')) console.log(JSON.stringify(Object.fromEntries(before), null, 1));
console.log(`${variants.length} variants (box volume and world march, ${splitCounts.size} split marches): cost = normal + counter spans${NAGA ? `, ${naga.size} distinct cost modules valid under naga` : ''}, normal hashes unchanged`);
if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }

// 4. The readback's arithmetic on synthetic texels: the decode keeps exact integers and coverage, the
// stats are over covered pixels only, and the picture comparison is not vacuous (it sees a change).
{
  const { decode, stats, compare } = await import('../src/gfx/costView.js');
  const { COST_COVERED_BIT } = await import('../src/shaders/costView.js');
  const n = 4;
  const c0 = new Uint32Array(4 * n), c1 = new Uint32Array(2 * n);
  // pixel 0: uncovered (counts there must be ignored); pixels 1-3 covered with march 1..3, cellReads 10..30
  c0[0] = 99 | (5 << 16);
  for (let p = 1; p < n; p++) { c0[4 * p] = COST_COVERED_BIT | p | ((p * 2) << 16); c1[2 * p + 1] = (p * 10) << 16; }
  c0[4 * 3 + 3] = 0xffff0000 >>> 0;   // pixel 3: rootIters at the ceiling
  const d = decode(c0, c1, n);
  const want = (cond, what) => { if (!cond) fail(`readback: ${what}`); };
  want(d.count === 3 && d.covered[0] === 0, 'coverage');
  want(d.vals[0][1] === 1 && d.vals[0][3] === 3 && d.vals[1][2] === 4 && d.vals[11][3] === 30, 'exact counts in their slots');
  const m = stats(d.vals[0], d.covered, d.count, 0x7fff);
  want(m.sum === 6 && m.mean === 2 && m.max === 3 && m.p50 === 2, 'stats over covered pixels only');
  want(stats(d.vals[7], d.covered, d.count, 0xffff).saturated === 1, 'saturation reported');
  const a = new Uint16Array(4 * n).fill(0x3c00), b = a.slice();   // 1.0 everywhere
  const same = compare(a, b, d.covered);
  want(same.maxDiff === 0 && same.differing === 0 && same.exactShare === 1, 'identical pictures compare equal');
  b[4 * 2] = 0x3e00;   // 1.5 in one texel
  const diff = compare(a, b, d.covered);
  want(diff.maxDiff === 0.5 && diff.differing === 1, 'a changed texel is seen');
  // the storage sink's rows (shaders/costView.js costStore: the pixel's words in rows 2y and 2y + 1)
  const { storageWords, compareWords } = await import('../src/gfx/costView.js');
  const W = 2, H = 2, tex = new Uint32Array(4 * W * 2 * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = W * y + x;
    tex.set([COST_COVERED_BIT | p, 1, 2, 3], 4 * (W * 2 * y + x));
    tex.set([10 + p, (20 + p) << 16, 0, 0], 4 * (W * (2 * y + 1) + x));
  }
  const s = decode(...storageWords(tex, W, H), W * H);
  want(s.count === 4 && s.vals[0][3] === 3 && s.vals[10][2] === 0 && s.vals[11][2] === 22 && s.vals[8][1] === 11, 'storage rows decode per pixel');
  want(compareWords(new Uint32Array([1, 2, 3, 4]), new Uint32Array([1, 2, 3, 5]), 2) === 1, 'word comparison sees a change');
  console.log('readback arithmetic: exact decode (targets and storage rows), covered-only stats, comparisons see a change');
}
if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }

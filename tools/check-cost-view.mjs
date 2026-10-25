// The cost view's honesty, CPU only (docs/profiler.md "Cost view").
//
//  1. Same code: for every lit view, detail level, flat/curved and read format, the cost module is
//     the normal module plus counter spans only (shaders/costView.js verifyCost: stripping the spans
//     gives the normal text byte for byte, and each span is a counter line), and every counter counts.
//  2. Off is off: the normal modules' hashes are the same before shaders/costView.js is imported,
//     after, and after every module has been counted (no state leaks into the generator).
//  3. naga validates every cost module (--no-naga skips it).
//
// usage: node tools/check-cost-view.mjs [--no-naga] [--hashes]   (--hashes prints the normal modules' sha256)
import { createHash } from 'node:crypto';
import { volumeFrag, REALISTIC_LEVELS, VOLUME_VIEWS } from '../src/shaders/render.js';
import { isMaterialView } from '../src/views.js';
import { gridLayout } from '../src/sim.js';
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

// 2: hashes before the cost module exists in this process
const before = new Map(variants.map((v) => [v.name, sha(v.code())]));
const { costify, verifyCost, stripCost } = await import('../src/shaders/costView.js');

let failed = 0;
const fail = (msg) => { failed++; console.error(`FAIL ${msg}`); };
const naga = new Set();
for (const v of variants) {
  const normal = v.code();
  if (sha(normal) !== before.get(v.name)) fail(`${v.name}: the normal module changed once shaders/costView.js was imported`);
  const cost = costify(normal);
  const r = verifyCost(normal, cost);
  if (!r.ok) fail(`${v.name}: ${r.problems.join('; ')}`);
  if (stripCost(cost) !== normal) fail(`${v.name}: strip(cost) != normal`);
  if (NAGA && !naga.has(sha(cost))) {
    naga.add(sha(cost));
    try { nagaExec(cost, `${v.name}.cost.wgsl`); } catch (e) { fail(`${v.name}: naga\n${e.message.slice(0, 2000)}`); }
  }
}
// and once more after everything was counted
for (const v of variants) if (sha(v.code()) !== before.get(v.name)) fail(`${v.name}: the normal module changed after counting`);

if (argv.includes('--hashes')) console.log(JSON.stringify(Object.fromEntries(before), null, 1));
console.log(`${variants.length} variants: cost = normal + counter spans${NAGA ? `, ${naga.size} distinct cost modules valid under naga` : ''}, normal hashes unchanged`);
if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }

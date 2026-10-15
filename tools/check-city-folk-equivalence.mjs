// CPU only: exact-cell equivalence and warmed timings of the spatial early-outs.
// node tools/check-city-folk-equivalence.mjs (no browser or GPU).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { E } from '../src/elements.js';
import { willowCoveTwin } from '../src/world/scenes/willowCove.js';

const beforeCommit = '1fcda7c43def85c723ff1027821fc56154438260';
const legacyCommit = 'f8d9d8d6b00a2e25c641ad6086e759ba79a6f579';
const scenePath = 'src/world/scenes/willowCove.js';
// Snapshot the composed scene AND its feature modules from the fixed commit.
// Shared compiler dependencies resolve normally; no working-tree overlay may
// accidentally change the reference generator along with the candidate.
function historicScene(commit) {
  const cache = new Map();
  function url(path) {
    if (cache.has(path)) return cache.get(path);
    let source = execFileSync('git', ['show', `${commit}:${path}`], { encoding: 'utf8' });
    source = source.replace(/from '(\.[^']+)'/g, (_, relative) => {
      const resolved = new URL(relative, new URL(`../${path}`, import.meta.url));
      const child = resolved.pathname.split('/src/world/scenes/')[1];
      const dependency = child?.startsWith('cityFolk/')
        ? url(`src/world/scenes/${child}`) : resolved.href;
      return `from '${dependency}'`;
    });
    const result = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    cache.set(path, result); return result;
  }
  return import(url(scenePath));
}
const before = await historicScene(beforeCommit), legacy = await historicScene(legacyCommit);
const size = [3072, 128, 1024], seeds = [1, 20261008, 0xffffffff];
const sites = [
  ['village', -28, 12], ['upper', -400, -112], ['orchard', 624, 80],
  ['city', 0, -352], ['meadow', 850, 70],
];
let comparisons = 0, nonempty = 0;
function compare(a, b, x0, x1, z0, z1, seed) {
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) for (let y = 0; y < 128; y++) {
    const actual = a(x + 1536, y, z + 512), expected = b(x + 1536, y, z + 512);
    if (actual !== expected) assert.fail(`seed ${seed}, ${x},${y},${z}: ${expected}->${actual}`);
    comparisons++; if (expected !== E.EMPTY) nonempty++;
  }
}
for (const seed of seeds) {
  const p = { size, seed }, a = willowCoveTwin(p).wcCell, b = before.willowCoveTwin(p).wcCell;
  // Full changed core bounds at every Y/Z, including the ENTIRE city district
  // and both X seams. No stride, hashing or metadata equality substitution.
  compare(a, b, -200, 200, -512, 511, seed);
  for (const [, x, z] of sites) compare(a, b, x - 64, x + 63, z - 64, z + 63, seed);
  for (const x of [-1537, -1536, -201, -200, -192, -191, 0, 191, 192, 200, 201, 1535, 1536])
    for (const z of [-513, -512, -441, -440, -280, -279, 511, 512])
      for (const y of [-1, 0, 47, 48, 79, 80, 127, 128]) {
        assert.equal(a(x + 1536, y, z + 512), b(x + 1536, y, z + 512)); comparisons++;
      }
}
assert(nonempty > 1000000, 'reference sweeps contain substantive generated matter');
console.log(`Exact composed IDs: ${comparisons.toLocaleString('en-US')} comparisons, ${nonempty.toLocaleString('en-US')} nonempty cells; 3 seeds; full core/city/seams and five full 128^3 windows: PASS`);

// Reproducible CPU methodology: serial sweeps, all 128^3 cells, two warmups
// then five measurements per generator/site. Report median, retain checksum.
// These are CPU generator timings, NOT GPU latency estimates.
const p = { size, seed: seeds[1] }, generators = [
  ['pre-feature', legacy.willowCoveTwin(p).wcCell],
  ['composed-before', before.willowCoveTwin(p).wcCell],
  ['optimized', willowCoveTwin(p).wcCell],
];
function sweep(cell, cx, cz) {
  let checksum = 0;
  for (let z = cz - 64; z < cz + 64; z++) for (let x = cx - 64; x < cx + 64; x++)
    for (let y = 0; y < 128; y++) checksum += cell(x + 1536, y, z + 512);
  return checksum;
}
console.log('CPU ms (median of 5, after 2 warmups each; seed 20261008; columns pre-feature / composed-before / optimized):');
for (const [site, x, z] of sites) {
  const timings = [], sums = [];
  for (const [, cell] of generators) {
    for (let i = 0; i < 2; i++) sweep(cell, x, z);
    const times = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now(); const sum = sweep(cell, x, z);
      times.push(performance.now() - start); sums.push(sum);
    }
    timings.push(times.sort((a, b) => a - b)[2].toFixed(2));
  }
  assert.equal(sums[5], sums[10], 'before/after benchmark checksums');
  console.log(`${site} center [${x},${z}]: ${timings.join(' / ')}`);
}

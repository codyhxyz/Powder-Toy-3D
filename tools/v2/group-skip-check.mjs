// CPU-only: the jets' and the couple run's counts skip whole groups of the shared allocator exactly.
// Three users share one per-brick prefix run and one per-group sum run each tick (blasts.js
// SPAWN_PREFIX): the blast batch (every brick), the jets (jets.js) and the couple run (blasts.js count,
// COUPLE_MODE). Each count writes a group's in-group brick prefixes and its sum; allocate turns every
// sum into a base in place; the consumers rank a brick's cells at its prefix plus its group's base.
// Today's counts visit every brick of every group. A group skip writes only the group's sum (zero)
// when a word says no brick in it can count: a jet mark notes its group (noteJet, the count clears
// it), windList writes whether it listed any brick (dWindListed). Skipped groups' prefixes stay stale.
// Over many ticks with stale words carried over (the new run starts from other garbage), every rank a
// consumer reads, every request total, the gate's work and the pool's overflow must match the
// all-group counts. A mark without its group note, a skip without the zero sum, a group word from
// the bricks' own air word alone (no neighbours), or another group mapping must break it.
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { BRICK_GROUP, brickGroups, nativeDynamicsHead, v2ActLayout, v2PairsWGSL } from '../../src/shaders/v2.js';
import { blastsWGSL, listControl, COUPLE_MODE, SPAWN_PREFIX } from '../../src/shaders/v2/blasts.js';
import { airWGSL } from '../../src/shaders/v2/air.js';
import { jetsWGSL } from '../../src/shaders/v2/jets.js';

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// One count over a group's bricks (both counts' bodies): in-group exclusive prefixes and the group sum.
function countGroup(w, group, nb, demandOf, writePrefix) {
  let prefix = 0;
  for (let lane = 0; lane < BRICK_GROUP; lane++) {
    const b = group * BRICK_GROUP + lane, n = b < nb ? demandOf(b) : 0;
    if (b < nb && writePrefix(n)) w.prefix[b] = prefix;
    prefix += n;
  }
  w.counts[group] = prefix;
  return prefix;
}
// allocate: every group sum into an exclusive base, in group order; the request total
function allocate(w, groups) { let total = 0; for (let g = 0; g < groups; g++) { const c = w.counts[g]; w.counts[g] = total; total += c; } return total; }
// what a consumer reads for a brick: its prefix plus its group's base (dRank, jets spawn)
const base = (w, b, group) => w.prefix[b] + w.counts[group(b)];

const groupOf = b => Math.floor(b / BRICK_GROUP);
const seen = { skips: 0, groups: 0, ranks: 0 };
function tick(w, s, nb, groups, variant, fresh) {
  const group = groupOf, out = [];
  if (fresh) { seen.groups += 2 * groups; seen.skips += w.jetGroups.filter(x => !x).length; }
  // the blast batch (any mode but the couple run's): every brick, every prefix
  if (s.batch) {
    for (let g = 0; g < groups; g++) countGroup(w, g, nb, b => s.plans[b], () => true);
    const total = allocate(w, groups); out.push(['batch', total]);
    for (let b = 0; b < nb; b++) if (s.plans[b]) out.push(['batch rank', b, base(w, b, group)]);
  }
  // the jets: a brick's count is its marked cells where its jets word is set
  const jetDemand = b => (s.noted[b] ? s.marked[b] : 0);
  let jetTotal = 0;
  for (let g = 0; g < groups; g++) {
    if (fresh && !w.jetGroups[g]) { if (!variant.noZero) w.counts[g] = 0; continue; }
    if (fresh) w.jetGroups[g] = 0;
    jetTotal += countGroup(w, g, nb, jetDemand, () => true);
  }
  out.push(['jets work', jetTotal > 0]);
  if (jetTotal > 0) {
    const requested = allocate(w, groups); out.push(['jets total', requested, Math.max(0, requested - s.free)]);
    for (let b = 0; b < nb; b++) if (s.noted[b] && s.marked[b]) out.push(['jets rank', b, base(w, b, group)]);
  }
  // the couple run: a brick counts its flagged plans where it is wind-listed and couple-active;
  // windList's group word is the OR of dWindListed over the group (its workgroup)
  const coupleDemand = b => (s.wind(b) && s.active[b] ? s.plans2[b] : 0);
  if (fresh) for (let g = 0; g < groups; g++) {
    w.windGroups[g] = 0;
    for (let lane = 0; lane < BRICK_GROUP; lane++) { const b = g * BRICK_GROUP + lane; if (b < nb && (variant.ownAirOnly ? s.live[b] : s.wind(b))) w.windGroups[g] = 1; }
  }
  if (fresh) seen.skips += w.windGroups.filter(x => !x).length;
  for (let g = 0; g < groups; g++) {
    if (fresh && !w.windGroups[g]) { if (!variant.noZero) w.counts[g] = 0; continue; }
    countGroup(w, g, nb, coupleDemand, n => n > 0);
  }
  let demand = 0; for (let g = 0; g < groups; g++) demand += w.counts[g];
  const work = demand > 0 || s.particles > 0; out.push(['couple work', work]);
  if (work) {
    const requested = allocate(w, groups); out.push(['couple total', requested]);
    for (let b = 0; b < nb; b++) if (coupleDemand(b)) out.push(['couple rank', b, base(w, b, group)]);
  }
  if (fresh) seen.ranks += out.filter(r => r[0].endsWith(' rank') && !r[0].startsWith('batch')).length;
  return JSON.stringify(out);
}

function run(seed, dims, variant = {}) {
  const random = rng(seed), [bx, by, bz] = dims, nb = bx * by * bz, groups = Math.ceil(nb / BRICK_GROUP);
  const coord = b => [b % bx, Math.floor(b / bx) % bz, Math.floor(b / (bx * bz))], id = ([x, z, y]) => x + bx * (z + bz * y);
  const neighbours = b => { const c = coord(b), out = []; for (let a = 0; a < 3; a++) for (const d of [-1, 1]) { const n = [...c]; n[a] += d; if (n[0] >= 0 && n[1] >= 0 && n[2] >= 0 && n[0] < bx && n[1] < bz && n[2] < by) out.push(id(n)); } return out; };
  const words = () => ({ prefix: Uint32Array.from({ length: nb }, () => random() * 2 ** 32), counts: Uint32Array.from({ length: groups }, () => random() * 2 ** 32),
    jetGroups: new Uint8Array(groups), windGroups: new Uint8Array(groups) });
  const old = words(), lean = words();
  for (let t = 0; t < 40; t++) {
    const sparse = random() < 0.7, pick = p => (sparse ? random() < p : random() < 0.5);
    const s = { neighbours, batch: random() < 0.3, free: Math.floor(random() * 64), particles: random() < 0.2 ? 1 : 0,
      plans: Uint32Array.from({ length: nb }, () => (pick(0.02) ? Math.floor(random() * 4) : 0)),
      noted: Uint8Array.from({ length: nb }, () => pick(0.003)), marked: Uint32Array.from({ length: nb }, () => Math.floor(random() * 5)),
      live: Uint8Array.from({ length: nb }, () => pick(0.002)), active: Uint8Array.from({ length: nb }, () => random() < 0.7),
      plans2: Uint32Array.from({ length: nb }, () => (pick(0.3) ? Math.floor(random() * 3) : 0)) };
    s.wind = b => s.live[b] || neighbours(b).some(q => s.live[q]);
    // the pair stages' marks: noteJet sets the brick's word and its group's
    for (let b = 0; b < nb; b++) if (s.noted[b] && !(variant.silentMark && b % 7 === 3)) lean.jetGroups[(variant.noteGroup ?? groupOf)(b)] = 1;
    if (tick(old, s, nb, groups, variant, false) !== tick(lean, s, nb, groups, variant, true)) return false;
    // between ticks every group word is clear again (spawn cleared the bricks' words, count the groups')
    if (lean.jetGroups.some(x => x)) return false;
  }
  return true;
}

const shapes = [[4, 2, 4], [8, 4, 8], [32, 8, 32], [6, 5, 7], [16, 16, 16]];
let runs = 0;
for (const dims of shapes) for (let seed = 1; seed <= 10; seed++) { assert.ok(run(seed * 977 + runs, dims), `group skip differs: dims ${dims}, seed ${seed}`); runs++; }
for (const [what, variant] of [['a mark that does not note its group', { silentMark: true }], ['a skipped group without its zero sum', { noZero: true }],
  ['a wind group word from the brick\'s own air alone', { ownAirOnly: true }], ['a mark noting a group of 32 bricks', { noteGroup: b => Math.floor(b / 32) }]]) {
  let broke = false;
  for (const dims of shapes) for (let seed = 1; seed <= 10 && !broke; seed++) broke = !run(seed * 977, dims, variant);
  assert.ok(broke, `${what} must break the group skip`);
}

// The generated WGSL is the model above.
for (const g of [gridLayout(16, 8, 8), gridLayout(128, 128, 128)]) {
  const A = v2ActLayout(g), C = listControl(g), groups = brickGroups(g);
  assert.equal(groups, Math.ceil(g.nbricks / BRICK_GROUP));
  assert.ok(A.jetGroups >= A.words && A.jetGroups === A.plive + A.liveWords && A.allocated === A.jetGroups + groups, 'the jets\' group words are unsaved and last');
  assert.ok(C.windGroups > C.jetTotal && C.words === C.windGroups + groups, 'windList\'s group words follow every other control run');
  const pairs = v2PairsWGSL(g);
  assert.match(pairs, /fn noteJet\(b: u32\) \{ atomicStore\(&act2\[V2_JETS \+ b\], 1u\); atomicStore\(&act2\[V2_JET_GROUPS \+ b \/ BRICK_GROUP\], 1u\); \}/);
  assert.equal([...pairs.matchAll(/noteJet\(brickOfCell\(p\)\);/g)].length, 2, 'both marks (colMarkJet, colMarkCrown) note their group');
  assert.equal([...pairs.matchAll(/atomicStore\(&act2\[V2_JETS \+/g)].length, 1, 'no mark sets a jets word outside noteJet');
  const body = code => code.slice(code.lastIndexOf('@compute'));
  // both counts: lane 0 reads the group's word, a group it clears gets its zero sum, the skip is uniform
  const jets = body(jetsWGSL(g, 'count'));
  assert.match(jets, /let group=wg\.x\+wg\.y\*nwg\.x;/);
  assert.match(jets, /if\(wgNoted==0u\) \{ atomicStore\(&control\[J_COUNTS\+group\],0u\); \} else \{ atomicStore\(&act2\[V2_JET_GROUPS\+group\],0u\); \}/);
  assert.match(jets, /if\(workgroupUniformLoad\(&wgNoted\)==0u\) \{ return; \}/);
  assert.equal([...jets.matchAll(/return;/g)].length, 1, 'the only return is the uniform group skip, before the barrier');
  assert.ok(jets.indexOf('return;') < jets.indexOf('workgroupBarrier()'));
  const couple = body(blastsWGSL(g, nativeDynamicsHead, 'count'));
  assert.match(couple, new RegExp(`if\\(P\\.mode==${COUPLE_MODE}u && group<BRICK_GROUPS\\) \\{\\s*wgCounted=atomicLoad\\(&control\\[D_WIND_GROUPS\\+group\\]\\);\\s*if\\(wgCounted==0u\\) \\{ atomicStore\\(&control\\[D_SPAWN_COUNTS\\+group\\],0u\\); \\}`));
  assert.match(couple, /if\(workgroupUniformLoad\(&wgCounted\)==0u\) \{ return; \}/);
  assert.equal([...couple.matchAll(/return;/g)].length, 1, 'only the couple run skips, uniformly, before the barrier');
  assert.ok(couple.indexOf('return;') < couple.indexOf('workgroupBarrier()'));
  // windList: every lane reaches its barrier; one word a group, the OR of dWindListed, every tick
  const wind = body(airWGSL(g, nativeDynamicsHead, 'windList'));
  assert.doesNotMatch(wind, /return;/);
  assert.match(wind, /if \(dWindListed\(t\)\) \{ dAppend\(LIST_WIND,t\); atomicStore\(&wgWind,1u\); \}/);
  assert.match(wind, /workgroupBarrier\(\);\s*let group=wg\.x\+wg\.y\*nwg\.x;\s*if \(li==0u && group<BRICK_GROUPS\) \{ atomicStore\(&control\[D_WIND_GROUPS\+group\],atomicLoad\(&wgWind\)\); \}/);
  assert.match(airWGSL(g, nativeDynamicsHead, 'windList'), /var<workgroup> wgWind: atomic<u32>;/);
  // the shared words both counts write are the allocator's (jets.js J_PREFIX/J_COUNTS are SPAWN_PREFIX's)
  assert.match(jetsWGSL(g, 'count'), new RegExp(`const J_PREFIX: u32 = ${SPAWN_PREFIX}u;`));
}
assert.ok(seen.skips > seen.groups / 4 && seen.ranks > 1000, `the fixtures must skip groups and read ranks (${seen.skips}/${seen.groups} skipped, ${seen.ranks} ranks)`);
console.log(`group skip: ${(100 * seen.skips / seen.groups).toFixed(0)}% of group counts skipped, ${seen.ranks} jet and couple ranks read; ${runs} runs of 40 ticks identical to the all-group counts (ranks, totals, gates, overflow) with stale words carried over; 4 red variants caught`);

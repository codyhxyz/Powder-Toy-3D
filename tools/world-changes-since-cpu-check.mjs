// CPU-only: WorldRenderSource.changesSince against the e7787283 implementation it replaced, on random
// journals and on a World-sized V2 run, plus its work and allocation bounds. No GPU, no browser.
//
// The old code expanded every journal entry since the token into a Map keyed by 'x,y,z' strings. V2
// journals its whole window every step, so a lighting transaction's span was dozens of window-sized
// boxes: 2.6 s of 20 s after Island's first frame, 3.9 s on Descent, in stalls of up to 7 s
// (real Chrome, 2026-10-22). The delta must list the same bricks in the same order (Fields gives new
// owners that order), and its includes()/coreKeys() must agree with that list.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { WorldRenderSource, changesSinceStats as stats } from '../src/world/renderSource.js';

// e7787283's changesSince over a journal with one entry per change (as noteContentChange kept it).
function reference(source, token, journal) {
  const current = source.contentToken();
  if (!token || token.epoch !== source.epoch || token.sourceRevision > source.contentRevision) return { token: current, global: true, changedBricks: [] };
  const changed = new Map(), size = source.context.size;
  for (const entry of journal) if (entry.revision > token.sourceRevision) {
    if (entry.global) return { token: current, global: true, changedBricks: [] };
    const loX = Math.max(0, entry.loX), loY = Math.max(0, entry.loY), loZ = Math.max(0, entry.loZ);
    const hiX = Math.min(size[0], entry.hiX), hiY = Math.min(size[1], entry.hiY), hiZ = Math.min(size[2], entry.hiZ);
    if (loX < hiX && loY < hiY && loZ < hiZ) for (let z = Math.floor(loZ / 4); z < Math.ceil(hiZ / 4); z++)
      for (let y = Math.floor(loY / 4); y < Math.ceil(hiY / 4); y++)
        for (let x = Math.floor(loX / 4); x < Math.ceil(hiX / 4); x++) changed.set(`${x},${y},${z}`, [x, y, z]);
  }
  return { token: current, global: false, changedBricks: [...changed.values()] };
}
// What reference visits: every brick of every entry in the span.
function referenceVisits(source, token, journal) {
  let n = 0;
  const size = source.context.size;
  for (const e of journal) if (e.revision > token.sourceRevision && !e.global) {
    const d = [[e.loX, e.hiX], [e.loY, e.hiY], [e.loZ, e.hiZ]].map(([lo, hi], k) => {
      lo = Math.max(0, lo); hi = Math.min(size[k], hi);
      return lo < hi ? Math.ceil(hi / 4) - Math.floor(lo / 4) : 0;
    });
    n += d[0] * d[1] * d[2];
  }
  return n;
}

let seed = 0x2026_1022;
const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
const int = (n) => Math.floor(rand() * n);

// A source without GPU (as world-source-cut-cpu-check does), with e7787283's journal kept beside it.
function fixture(size, win = [Math.min(16, size[0]), size[1], Math.min(16, size[2])]) {
  const source = Object.create(WorldRenderSource.prototype);
  Object.assign(source, { sim: { origin: { x: 0, y: 0, z: 0 }, g: { nx: win[0], ny: win[1], nz: win[2] } }, context: { size }, chunks: new Map(), epoch: 3, revision: 0, contentRevision: 0 });
  const raw = [];
  const note = (change) => {
    const before = source.contentRevision;
    source.noteContentChange(change);
    if (source.contentRevision === before) return;
    // The same validation as noteContentChange: what it journals, one entry per change.
    const lo = change === undefined ? [source.sim.origin.x, source.sim.origin.y, source.sim.origin.z] : change && !change.global && (change.lo || change.min);
    const hi = change === undefined ? lo.map((v, i) => v + win[i]) : change && (change.lo ? change.hi : change.max);
    const bounded = Array.isArray(lo) && Array.isArray(hi) && lo.length === 3 && hi.length === 3 && [...lo, ...hi].every(Number.isFinite) && lo.every((v, i) => v <= hi[i]);
    raw.push(Object.freeze(bounded ? { revision: source.contentRevision, global: false, loX: lo[0], loY: lo[1], loZ: lo[2], hiX: hi[0], hiY: hi[1], hiZ: hi[2] } : { revision: source.contentRevision, global: true }));
  };
  return { source, raw, note, win };
}
const keyOf = (b) => b.join(',');
function compare(source, token, journal, label) {
  const want = reference(source, token, journal), got = source.changesSince(token);
  assert.deepEqual(got, want, `${label}: changesSince`);
  assert(Object.isFrozen(got) && Object.isFrozen(got.changedBricks) && got.changedBricks.every(Object.isFrozen), `${label}: the delta is frozen, as it is shared`);
  const keys = new Set(want.changedBricks.map(keyOf)), size = source.context.size;
  for (let i = 0; i < 64; i++) {
    const b = [int(size[0] / 4 + 4) - 2, int(size[1] / 4 + 4) - 2, int(size[2] / 4 + 4) - 2];
    assert.equal(got.includes(b), keys.has(keyOf(b)), `${label}: includes ${b}`);
  }
  for (const b of want.changedBricks.slice(0, 32)) assert.equal(got.includes(b), true, `${label}: includes listed ${b}`);
  assert.equal(got.includes([0.5, 0, 0]), false);
  const cores = new Set(want.changedBricks.map((b) => b.map((v) => Math.floor(v / 8) * 32).join(',')));
  assert.deepEqual([...got.coreKeys()].sort(), [...cores].sort(), `${label}: coreKeys`);
  return got;
}

// 1. Random journals: any boxes (outside the world, empty, fractional, malformed), repeats of one
// window box (coalesced), globals, and every kind of token, on the source and on cuts of it.
{
  const sizes = [[12, 8, 8], [96, 8, 8], [64, 32, 48], [40, 12, 36]];
  let checked = 0;
  for (let round = 0; round < 60; round++) {
    const size = sizes[round % sizes.length], { source, raw, note, win } = fixture(size);
    const tokens = [null, { epoch: 2, sourceRevision: 0 }, source.contentToken()], cuts = [];
    const steps = 20 + int(60);
    for (let s = 0; s < steps; s++) {
      const r = rand();
      if (r < 0.35) note();   // the window, as V2 notes it every step
      else if (r < 0.45) { source.sim.origin.x = int(size[0]); source.sim.origin.z = int(size[2]); note(); }   // the window walks
      else if (r < 0.8) {
        const lo = [0, 1, 2].map((k) => int(size[k] + 8) - 4 + (rand() < 0.1 ? 0.5 : 0));
        note({ lo, hi: lo.map((v, k) => v + int(size[k] / 2 + 2)) });
      } else if (r < 0.85) note({ min: [0, 0, 0], max: [int(size[0]), 4, 4] });
      else if (r < 0.9) note({ lo: [4, 0, 0], hi: [4, 4, 4] });
      else if (r < 0.93) note({ global: true });
      else if (r < 0.95) note(null);
      else if (r < 0.97) note({ lo: [NaN, 0, 0], hi: [4, 4, 4] });
      else {
        const cut = Object.create(WorldRenderSource.prototype);
        Object.assign(cut, { context: source.context, epoch: source.epoch, revision: source.revision, contentRevision: source.contentRevision, changeJournal: (source.changeJournal ?? []).slice() });
        cuts.push({ cut, raw: raw.slice() });
      }
      if (rand() < 0.3) tokens.push(source.contentToken());
      if (rand() < 0.2) {
        const token = tokens[int(tokens.length)];
        compare(source, token, raw, `round ${round} step ${s}`); checked++;
        compare(source, token, raw, `round ${round} step ${s} (kept)`);
      }
    }
    tokens.push({ epoch: source.epoch, sourceRevision: source.contentRevision + 1 });
    for (const token of tokens) { compare(source, token, raw, `round ${round} end`); checked++; }
    for (const { cut, raw: cutRaw } of cuts) for (const token of tokens) {
      compare(cut, token, cutRaw, `round ${round} cut`); checked++;
    }
    assert(source.changeJournal.length <= raw.length);
    // The journal's entries stay strictly ordered by revision (changesSince searches it).
    assert(source.changeJournal.every((e, i, a) => !i || a[i - 1].revision < e.revision));
    source.reset(); assert.equal(source.changesSince(tokens.at(-2)).global, true);
  }
  console.log(`exact: ${checked} random deltas match e7787283's, in order, on sources and cuts`);
}

// 2. A delta kept for the same span is the same object; a new change or another token builds anew.
{
  const { source, note } = fixture([64, 16, 64]);
  const t0 = source.contentToken(); note(); note({ lo: [8, 0, 8], hi: [12, 4, 12] });
  const a = source.changesSince(t0), built = stats.built;
  assert.equal(source.changesSince({ ...t0 }), a); assert.equal(stats.built, built);
  note(); const b = source.changesSince(t0);
  assert.notEqual(b, a); assert.equal(stats.built, built + 1);
  assert.notEqual(source.changesSince(source.contentToken()), b);
  // Repeats of the latest box replace it: a V2 run's journal holds one entry, not one a step.
  const { source: s2, note: n2 } = fixture([1024, 128, 1024], [128, 128, 128]);
  for (let i = 0; i < 1000; i++) n2();
  assert.equal(s2.changeJournal.length, 1);
  assert.equal(s2.changeJournal[0].revision, 1000);
  console.log('kept: one delta per span, rebuilt when the journal or the token moves; 1000 window notes journal as 1 entry');
}

// 3. Work and allocation on World sizes: a V2 run (the window every step, a walk, smaller physics boxes)
// queried as a lighting transaction's three callers do. Old work = every brick of every span entry.
for (const [name, size, win] of [['Island', [1024, 128, 1024], [128, 128, 128]], ['Descent', [2560, 320, 2560], [128, 320, 128]]]) {
  const { source, raw, note } = fixture(size, win);
  source.sim.origin.x = 448; source.sim.origin.z = 448;
  let baseline = source.contentToken(), oldVisits = 0, newVisits = 0, oldMs = 0, newMs = 0, worstMs = 0, calls = 0;
  for (let f = 1; f <= 600; f++) {
    note();
    if (rand() < 0.3) { const o = source.sim.origin, lo = [o.x + int(100), int(size[1] - 32), o.z + int(100)]; note({ lo, hi: lo.map((v) => v + 4 + int(28)) }); }
    if (rand() < 1 / 40) source.sim.origin[rand() < 0.5 ? 'x' : 'z'] += 16;
    if (f % 30) continue;
    const before = { ...stats };
    let t = performance.now();
    const delta = source.changesSince(baseline);
    // The cut and the lighting record read only membership and cores: nothing is listed for them.
    delta.coreKeys(); delta.includes([120, 4, 120]);
    assert.equal(stats.bricksListed, before.bricksListed, `${name}: includes/coreKeys list no bricks`);
    const bricks = delta.changedBricks;   // the CELL adapter reads the list once per span
    for (let k = 0; k < 2; k++) assert.equal(source.changesSince(baseline), delta);
    const ms = performance.now() - t;
    newMs += ms; worstMs = Math.max(worstMs, ms); calls++;
    t = performance.now(); const want = reference(source, baseline, raw); oldMs += 3 * (performance.now() - t);
    assert.deepEqual(bricks, want.changedBricks, `${name}: frame ${f}`);
    assert.equal(stats.built - before.built, 1, `${name}: one build per span`);
    // A span scans only its own entries, never the journal before it.
    assert(stats.entries - before.entries <= source.changeJournal.filter((e) => e.revision > baseline.sourceRevision).length);
    newVisits += stats.bricksVisited - before.bricksVisited; oldVisits += 3 * referenceVisits(source, baseline, raw);
    // Listing visits each distinct box once: at most the walk's few window boxes, never one per step.
    assert(stats.bricksVisited - before.bricksVisited <= 4 * bricks.length, `${name}: listing visits ${stats.bricksVisited - before.bricksVisited} for ${bricks.length} bricks`);
    baseline = source.contentToken();
  }
  assert(oldVisits >= 20 * newVisits, `${name}: ${oldVisits} old brick visits vs ${newVisits}`);
  assert(source.changeJournal.length < raw.length / 2, `${name}: journal ${source.changeJournal.length} entries for ${raw.length} changes`);
  console.log(`${name} ${size.join('x')}: ${calls} transactions x 3 calls; brick visits ${oldVisits} -> ${newVisits} (${(oldVisits / newVisits).toFixed(0)}x); ` +
    `${(oldMs / calls).toFixed(1)} -> ${(newMs / calls).toFixed(2)} ms a transaction (worst ${worstMs.toFixed(2)} ms, listing included); journal ${raw.length} -> ${source.changeJournal.length} entries`);
}
console.log('world changes-since CPU check passed');

// CPU check of the explosives (elements.js C4, NITRO, TNT, THERMITE, PROPANE,
// FUSE), driving the dock tiles' twin of the engine (src/ui/tiles/engine.js):
// a side-on slice that runs the GPU passes' own rules. No browser, no GPU.
//   node tools/boom-check.mjs
// Prints one line per check and exits 1 if any fails. Checks that need the
// shared blast mechanism (branch el-core) print SKIP until it is merged.
import { ELEMENTS, E, K, PALETTE, itemByKey } from '../src/elements.js';
import { PHYS, SIM_GRAVITY } from '../src/physics.js';
import { World, densityOf } from '../src/ui/tiles/engine.js';
import { readFileSync } from 'node:fs';

// keys with a row in gfx/materials.js LOOKS (the table itself isn't exported)
const LOOKS_SRC = readFileSync(new URL('../src/gfx/materials.js', import.meta.url), 'utf8');
const LOOKS_KEYS = [...LOOKS_SRC.matchAll(/^\s{2}([A-Z0-9_]+): \{/gm)].map((m) => m[1]);

const NEW = ['C4', 'NITRO', 'TNT', 'THERMITE', 'PROPANE', 'FUSE'];
const FUSE_LEN = 6;           // cells of fuse in the fuse runs
const FUSE_TOL = 2;           // steps: slack on the fuse front's per-cell time
const POOL_STEPS = 3000;      // steps for released propane to settle
const POOL_LOW_SHARE = 0.75;  // share of propane that must end in the lower half
const PUT_STEPS = 600;        // steps a painted C-4 block must hold still
const SINK_STEPS = 1500;      // steps for nitroglycerin to sink through water
const SINK_TRIALS = 10;
const MELT_STEPS = 3000;      // steps molten thermite has to get through a floor
const IRON_T = 2500;          // °C: burning thermite's product (its blast.T)
const PROBE_STEPS = 6;        // steps to see whether heated C-4 does anything
const PROPANE_BURNT = 0.6;    // median share of a lit propane pool that must burn
const PROPANE_TRIALS = 10;
const PROPANE_STEPS = 600;

let failed = 0;
const line = (status, name, detail) => {
  if (status === 'FAIL') failed++;
  console.log(`${status.padEnd(4)} ${name}${detail ? `: ${detail}` : ''}`);
};
const check = (name, ok, detail) => line(ok ? 'ok' : 'FAIL', name, detail);

function world(nx, ny) {
  const w = new World(nx, ny);
  w.gravity = SIM_GRAVITY;
  return w;
}
const fill = (w, x0, x1, y0, y1, id, extra) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) w.put(x, y, id, extra);
};
const count = (w, id) => w.id.reduce((n, v) => n + (v === id), 0);
const cellsOf = (w, id) => {
  const out = [];
  for (let i = 0; i < w.id.length; i++) if (w.id[i] === id) out.push([i % w.nx, (i / w.nx) | 0]);
  return out;
};

// ---- the table ----
{
  const missing = NEW.filter((k) => !(k in E));
  check('rows: all six elements', missing.length === 0, missing.length ? `missing ${missing}` : `ids ${NEW.map((k) => E[k]).join(', ')}`);
  const noDesc = NEW.filter((k) => !ELEMENTS[E[k]].desc);
  check('rows: plain-words descs', noDesc.length === 0, noDesc.join(', '));
  const group = PALETTE.find((g) => g.name === 'Explosives');
  const want = ['GUNPOWDER', 'FUSE', 'THERMITE', 'NITRO', 'TNT', 'C4'];
  check('palette: Explosives group', group && want.every((k) => group.items.includes(k)), group?.items.join(' '));
  const gases = PALETTE.find((g) => g.name === 'Gases');
  check('palette: propane under Gases', gases?.items.includes('PROPANE'));
  const placed = PALETTE.flatMap((g) => g.items);
  const twice = [...NEW, 'GUNPOWDER'].filter((k) => placed.filter((p) => p === k).length !== 1);
  check('palette: each explosive listed once', twice.length === 0, twice.join(', '));
  check('palette: every key resolves', placed.every((k) => itemByKey(k)));
  const noLook = NEW.filter((k) => !LOOKS_KEYS.includes(k));
  check('looks: a LOOKS row each', noLook.length === 0, noLook.join(', '));
  const nitro = densityOf(E.NITRO, 20), water = densityOf(E.WATER, 20);
  const prop = densityOf(E.PROPANE, 20), air = densityOf(E.EMPTY, 20);
  check('density: nitroglycerin sinks in water', nitro > water, `${nitro} vs ${water}`);
  check('density: propane ~1.5× air', prop / air > 1.45 && prop / air < 1.6, (prop / air).toFixed(2));
}

// ---- the fuse: steady speed, no air needed ----
// A straight fuse, its first cell just lit; returns the step each cell lit,
// and what the run left. around: what fills the rest of the slice.
function fuseRun(around) {
  const nx = FUSE_LEN + 4, ny = 5, y = 1, x0 = 2;
  const w = world(nx, ny);
  fill(w, 0, nx - 1, 0, ny - 1, around);
  for (let x = x0; x < x0 + FUSE_LEN; x++) w.put(x, y, E.FUSE);
  w.life[w.idx(x0, y)] = 1 - PHYS.FUSE_BURN;
  const lit = new Array(FUSE_LEN).fill(-1);
  lit[0] = 0;
  const limit = (FUSE_LEN + 2) * PHYS.FUSE_STEPS_PER_CELL * 1.2;
  let ended = false, airAtStart = count(w, E.EMPTY);
  for (let s = 1; s <= limit && !ended; s++) {
    w.step();
    for (let k = 0; k < FUSE_LEN; k++) {
      const i = w.idx(x0 + k, y);
      if (lit[k] < 0 && w.id[i] === E.FUSE && w.life[i] < 1) lit[k] = s;
    }
    ended = count(w, E.FUSE) === 0;
  }
  const gaps = lit.slice(1).map((s, k) => s - lit[k]);
  return { lit, gaps, ended, airAtStart, w };
}
for (const [label, around] of [['sealed in wall (no air)', E.WALL], ['underwater', E.WATER], ['in air', E.EMPTY]]) {
  const r = fuseRun(around);
  const ok = r.lit.every((s) => s >= 0) && r.gaps.every((g) => Math.abs(g - PHYS.FUSE_STEPS_PER_CELL) <= FUSE_TOL);
  check(`fuse ${label}: one cell per ${PHYS.FUSE_STEPS_PER_CELL} steps`, ok && r.ended,
    `gaps ${[...new Set(r.gaps)].join('/')} steps${around === E.WALL ? `, air cells ${r.airAtStart}` : ''}${r.ended ? '' : ', never burnt out'}`);
}
{
  // a flame at its end lights it; its burnt end spits a flame that sets off gunpowder
  const nx = FUSE_LEN + 6, ny = 6, y = 0;
  const w = world(nx, ny);
  for (let x = 1; x <= FUSE_LEN; x++) w.put(x, y, E.FUSE);
  w.put(FUSE_LEN + 1, y, E.GUNPOWDER); w.put(FUSE_LEN + 2, y, E.GUNPOWDER); w.put(FUSE_LEN + 1, y + 1, E.GUNPOWDER);
  w.put(0, y, E.FIRE);
  let litAt = -1, gone = -1;   // gone: the first gunpowder goes off
  const limit = (FUSE_LEN + 2) * PHYS.FUSE_STEPS_PER_CELL * 1.2;
  for (let s = 1; s <= limit && gone < 0; s++) {
    if (w.id[w.idx(0, y)] !== E.FIRE && litAt < 0) w.put(0, y, E.FIRE);   // hold the match to it
    w.step();
    if (litAt < 0 && w.life[w.idx(1, y)] < 1) litAt = s;
    if (count(w, E.GUNPOWDER) < 3) gone = s;
  }
  check('fuse: a touching flame lights it', litAt > 0 && litAt < 20, `lit after ${litAt} steps`);
  const due = litAt + FUSE_LEN * PHYS.FUSE_STEPS_PER_CELL;
  check('fuse: its end sets off gunpowder on time', gone > 0 && Math.abs(gone - due) <= FUSE_TOL + 2,
    `first gunpowder off at ${gone}, front due at the end at ~${due}`);
}

// ---- propane pools ----
{
  const n = 16;
  const w = world(n, n);
  fill(w, 5, 10, 11, 14, E.PROPANE);
  const start = count(w, E.PROPANE);
  for (let s = 0; s < POOL_STEPS; s++) w.step();
  const cells = cellsOf(w, E.PROPANE);
  const low = cells.filter(([, y]) => y < n / 2).length;
  const meanY = cells.reduce((a, [, y]) => a + y, 0) / Math.max(cells.length, 1);
  check('propane: pools in the lower half of still air', cells.length === start && low >= POOL_LOW_SHARE * start,
    `${low}/${cells.length} low, mean height ${meanY.toFixed(1)} of ${n} (from 12.5)`);
}

// ---- C-4 stays put; nitroglycerin sinks ----
{
  const w = world(12, 12);
  fill(w, 4, 7, 6, 8, E.C4);
  const before = cellsOf(w, E.C4).join(';');
  for (let s = 0; s < PUT_STEPS; s++) w.step();
  check('C-4: a painted block holds still in mid-air', cellsOf(w, E.C4).join(';') === before);
}
{
  // Sinking matter feels no buoyancy or drag on its speed in the engine (it
  // falls through water as fast as through air), so nitroglycerin poured into
  // water can land hard enough on the bottom to go off: a rate, not a check.
  let intact = 0, sank = 0;
  for (let t = 0; t < SINK_TRIALS; t++) {
    const w = world(10, 10);
    fill(w, 0, 9, 0, 3, E.WATER);
    fill(w, 3, 6, 4, 5, E.NITRO);
    const n = count(w, E.NITRO);
    for (let s = 0; s < SINK_STEPS; s++) w.step();
    if (count(w, E.NITRO) === n) intact++;
    if (cellsOf(w, E.NITRO).filter(([, y]) => y <= 1).length >= n * 0.75) sank++;
  }
  line('INFO', 'nitroglycerin poured into a 4-deep pool', `${sank}/${SINK_TRIALS} sank intact to the bottom, ${SINK_TRIALS - intact}/${SINK_TRIALS} went off on landing`);
}

// ---- molten thermite on a floor (its product, placed: no blast needed) ----
// A 30 cm steel slab takes a deep pile: one thermite cell (~50 kg) holds less
// heat than it takes to melt one steel cell (~210 kg), and steel conducts it away.
for (const [label, floor, depth, must] of [['metal', E.METAL, 3, false], ['metal', E.METAL, 6, true],
  ['wood', E.WOOD, 3, true], ['glass', E.GLASS, 3, true], ['stone', E.SANDSTONE, 3, true]]) {
  const nx = 20, ny = 16, fy = 3;
  const w = world(nx, ny);
  fill(w, 0, nx - 1, fy, fy, floor);
  fill(w, 4, 15, fy + 1, fy + depth, E.LAVA, { T: IRON_T, ctype: E.METAL });
  let through = -1;
  for (let s = 1; s <= MELT_STEPS && through < 0; s++) {
    w.step();
    for (let x = 0; x < nx; x++) if (w.id[w.idx(x, fy)] !== floor && w.id[w.idx(x, fy)] !== E.LAVA && w.id[w.idx(x, fy)] !== E.METAL) through = s;
    for (let x = 0; x < nx; x++) for (let y = 0; y < fy; y++) if (w.id[w.idx(x, y)] === E.LAVA || (floor !== E.METAL && w.id[w.idx(x, y)] === E.METAL)) through = s;
  }
  line(through > 0 ? 'ok' : must ? 'FAIL' : 'INFO', `molten thermite (${depth} deep, 12 wide, ${IRON_T} °C) through a 1-cell ${label} floor`,
    through > 0 ? `through after ${through} steps` : `not through in ${MELT_STEPS} steps`);
}

// ---- the blasts (el-core's mechanism) ----
// live once heated C-4 makes a blast's pressure (before el-core, a row with
// ignite but no fuel just burns out into fire)
const blastLive = (() => {
  const w = world(8, 8);
  w.put(4, 4, E.C4, { T: 400 });
  let peak = 0;
  for (let s = 0; s < PROBE_STEPS; s++) { w.step(); peak = Math.max(peak, ...w.P); }
  return peak >= ELEMENTS[E.C4].blast.P / 2;
})();
const blastCheck = (name, fn) => {
  if (!blastLive) return line('SKIP', name, 'needs the blast mechanism (el-core)');
  const [ok, detail] = fn();
  check(name, ok, detail);
};
const runUntil = (w, steps, done) => { for (let s = 1; s <= steps; s++) { w.step(); if (done(w)) return s; } return -1; };
const maxP = (w) => w.P.reduce((m, v) => Math.max(m, v), 0);

blastCheck('C-4: heat past 263 °C sets it off, at full blast pressure', () => {
  const w = world(10, 10);
  fill(w, 4, 5, 4, 5, E.C4);
  w.T[w.idx(4, 4)] = 300;
  let peak = 0;
  const s = runUntil(w, 50, (w) => { peak = Math.max(peak, maxP(w)); return count(w, E.C4) === 0; });
  return [s > 0 && peak >= ELEMENTS[E.C4].blast.P * 0.8, `gone after ${s} steps, peak P ${peak.toFixed(0)}`];
});
blastCheck('C-4: a hard hit (metal at full speed) sets it off; a grain does not', () => {
  const w = world(12, 6);
  fill(w, 8, 9, 0, 3, E.C4);
  w.put(7, 1, E.SCRAP); w.vx[w.idx(7, 1)] = PHYS.V_MAX;   // right against it
  const s = runUntil(w, 10, (w) => count(w, E.C4) < 8);
  const g = world(12, 6);
  fill(g, 8, 9, 0, 3, E.C4);
  g.put(7, 1, E.SAND); g.vx[g.idx(7, 1)] = 0.5;
  const sg = runUntil(g, 10, (w) => count(w, E.C4) < 8);
  return [s > 0 && sg < 0, `metal: ${s} steps; sand at 0.5: ${sg < 0 ? 'nothing' : sg + ' steps'}`];
});
blastCheck('nitroglycerin: a fall of 22 cells sets it off; resting on the floor it holds', () => {
  const w = world(8, 24);
  w.put(4, 22, E.NITRO);   // 22 cells (6.6 m) up: past NITRO_FALL_M
  const s = runUntil(w, 200, (w) => count(w, E.NITRO) === 0);
  const r = world(8, 24);
  fill(r, 2, 5, 0, 1, E.NITRO);
  const sr = runUntil(r, 300, (w) => count(w, E.NITRO) < 8);
  return [s > 0 && sr < 0, `dropped: gone after ${s}; resting: ${sr < 0 ? 'intact' : 'went off at ' + sr}`];
});
blastCheck("TNT: one gunpowder cell's blast pressure does not set it off; C-4 beside it does", () => {
  // the pressure alone (a gunpowder blast's fire would heat it past 240 °C in a few steps)
  const w = world(12, 8);
  fill(w, 6, 8, 0, 2, E.TNT);
  w.P[w.idx(5, 1)] = ELEMENTS[E.GUNPOWDER].blast.P;
  runUntil(w, 30, () => false);
  const kept = count(w, E.TNT);
  const c = world(12, 8);
  fill(c, 6, 8, 0, 2, E.TNT);
  c.put(5, 1, E.C4, { T: 300 });
  const s = runUntil(c, 40, (w) => count(w, E.TNT) === 0);
  return [kept === 9 && s > 0, `under gunpowder's pressure ${kept}/9 left; beside C-4 gone in ${s}`];
});
blastCheck('TNT: a flame sets it off only by heating it', () => {
  const w = world(8, 8);
  w.put(4, 0, E.TNT);
  w.put(4, 1, E.FIRE);
  w.step();
  const after1 = count(w, E.TNT);
  return [after1 === 1, `after one step beside a flame: ${after1 ? 'intact' : 'gone'}`];
});
blastCheck('thermite: a wood-fire flame does not light it; lava does, into iron at 2500 °C', () => {
  const w = world(10, 8);
  fill(w, 3, 6, 0, 1, E.THERMITE);
  for (let s = 0; s < 300; s++) { if (w.id[w.idx(4, 2)] !== E.FIRE) w.put(4, 2, E.FIRE, { T: 1000 }); w.step(); }
  const kept = count(w, E.THERMITE);
  const l = world(10, 8);
  fill(l, 3, 6, 0, 0, E.THERMITE);
  l.put(2, 0, E.LAVA, { T: 1600 });
  let peakP = 0;
  runUntil(l, 400, (w) => { peakP = Math.max(peakP, maxP(w)); return count(w, E.THERMITE) === 0; });
  const iron = cellsOf(l, E.LAVA).filter(([x, y]) => l.ctype[l.idx(x, y)] === E.METAL).length
    + count(l, E.METAL);
  return [kept === 8 && count(l, E.THERMITE) === 0 && iron >= 4 && peakP < 1,
    `beside fire ${kept}/8 unlit; beside lava ${count(l, E.THERMITE)} left, ${iron} iron cells, peak P ${peakP.toFixed(2)}`];
});
blastCheck('propane: a flame sweeps through a pool (median of trials); a sealed pocket with no air holds', () => {
  // A 2-deep, 16-long pool with a match held to its end until it catches. The
  // front is a chance per step (blast.flame), so the share burnt varies; the
  // 2D slice has 4 neighbours a cell, the box 6, so this is the harder case.
  const shares = [];
  let peak = 0;
  for (let t = 0; t < PROPANE_TRIALS; t++) {
    const w = world(20, 10);
    fill(w, 2, 17, 0, 1, E.PROPANE);
    const n0 = count(w, E.PROPANE);
    runUntil(w, PROPANE_STEPS, (w) => {
      if (count(w, E.PROPANE) === n0) w.put(1, 0, E.FIRE, { T: 1000 });
      peak = Math.max(peak, maxP(w));
      return count(w, E.PROPANE) === 0;
    });
    shares.push(1 - count(w, E.PROPANE) / n0);
  }
  shares.sort((a, b) => a - b);
  const median = shares[shares.length >> 1];
  const sealed = world(8, 6);
  fill(sealed, 0, 7, 0, 5, E.WALL);
  fill(sealed, 2, 5, 2, 3, E.PROPANE, { T: 500 });
  runUntil(sealed, 50, () => false);
  return [median >= PROPANE_BURNT && count(sealed, E.PROPANE) === 8,
    `burnt ${shares.map((x) => x.toFixed(2)).join(' ')} (median ${median.toFixed(2)}), peak P ${peak.toFixed(1)}; sealed at 500 °C: ${count(sealed, E.PROPANE)}/8 left`];
});
blastCheck('thermite: a lit pile (6 deep) burns through a 1-cell metal floor', () => {
  const nx = 20, ny = 16, fy = 3;
  const w = world(nx, ny);
  fill(w, 0, nx - 1, fy, fy, E.METAL);
  fill(w, 4, 15, fy + 1, fy + 6, E.THERMITE);
  w.put(9, fy + 7, E.LAVA, { T: 1600 });
  const s = runUntil(w, MELT_STEPS, (w) => {
    for (let x = 0; x < nx; x++) for (let y = 0; y < fy; y++) if (w.id[w.idx(x, y)] === E.LAVA || w.id[w.idx(x, y)] === E.METAL) return true;
    return false;
  });
  return [s > 0, s > 0 ? `molten iron below the floor after ${s} steps` : `not through in ${MELT_STEPS} steps`];
});

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

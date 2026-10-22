// Liquid outcomes (docs/v2.md 4.4, GPU acceptance): U-tube, partial layer,
// puddle, pipe, hole jet, splash, yield. Scenes after lean-sim's (tools/v2/lean-sim.mjs)
// and audit-liquids.md 2.1, sized for SwiftShader: each its smallest grid that
// still shows its outcome. Every test checks its scene before it runs it
// (SetupError: the result would say nothing about physics) and prints the
// evidence a failure needs: level profiles, maps, slices.
import { at, inGrid, SetupError } from '../engine.js';
import { OUTCOMES, CELL_M } from '../thresholds.js';
import { columnLevel, meanLevel, levelRange, liquidMass, mapText, sliceText, amountChar, advanceWatching, restNote, crit, r2, r3, wet } from '../lib.js';

const cm = (cells) => cells * CELL_M * 100;
const setup = (ok, what) => { if (!ok) throw new SetupError(what); };
const same = (a, b) => Math.abs(a - b) < 1e-6;
const every = (t, period) => Math.abs(t / period - Math.round(t / period)) < 1e-6;   // t is a multiple of period

export const utube = {
  name: 'utube', group: 'liquids', size: [16, 16, 8], needs: ['WALL', 'WATER'], cost: 140,
  title: 'a U-tube equalises within 1 cm and rests',
  audit: 'audit-liquids B1, B4: no rule gives a liquid an upward velocity, so the right arm never rises above the channel (B1); and each arm\'s partial top layer beads, so the tube never rests either (B4: audit-liquids\' own U-tube, whole layers in each arm, stopped at left 25, right 5 and certified that idle)',
  async run(e) {
    const O = OUTCOMES.utube, [nx, ny] = this.size;
    // two 2×2 arms (x 1-2 and 13-14, z 3-4) open to the top, joined at their feet by a 10-cell channel
    // (y 1-2); the left arm filled to y = 13, the right one empty (lean-sim utube and audit-liquids 2.1's
    // U-tube at half their size: 4×4 arms and a 20-cell channel cost today's engine 4 minutes here)
    e.box([0, 0, 0], [nx - 1, ny - 1, 7], 'WALL');
    e.box([1, 1, 3], [2, ny - 1, 4], 'AIR'); e.box([13, 1, 3], [14, ny - 1, 4], 'AIR'); e.box([3, 1, 3], [12, 2, 4], 'AIR');
    e.box([1, 1, 3], [2, 13, 4], 'WATER'); e.box([3, 1, 3], [12, 2, 4], 'WATER');
    const arms = (g) => [meanLevel(g, 1, 2, 3, 4), meanLevel(g, 13, 14, 3, 4)];
    let g = await e.read();
    const m0 = liquidMass(g), [L0, R0] = arms(g);
    setup(same(L0, 14) && same(R0, 0) && same(m0, 52 + 40), `start: arms at ${L0}, ${R0} (14, 0), mass ${m0} (92)`);
    const hist = [];
    const { idleAt, resolution } = await advanceWatching(e, O.seconds, {
      every: 0.5,
      onChunk: async (t) => { if (every(t, 2)) { const [L, R] = arms(await e.read()); hist.push(`${r2(t)} s: left ${r3(L)}, right ${r3(R)}`); } },
    });
    g = await e.read();
    const [L, R] = arms(g), m = liquidMass(g);
    const profile = [];
    for (let x = 1; x <= 14; x++) profile.push(r2(columnLevel(g, x, 3)));
    return {
      headline: `left ${r3(L)}, right ${r3(R)} cells: ${r2(cm(Math.abs(L - R)))} cm apart; ${idleAt === null ? 'not idle' : `idle at ${r2(idleAt)} s`}`,
      criteria: [
        crit('arms level', r2(cm(Math.abs(L - R))), cm(Math.abs(L - R)) <= O.levelCm, `≤ ${O.levelCm}`, 'cm'),
        crit('rests (certified idle)', idleAt === null ? 'never' : r2(idleAt), idleAt !== null && idleAt <= O.seconds, `≤ ${O.seconds}`, 's', restNote(resolution)),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [`surface along the channel (z = 3), x = 1…14 at ${r2(e.time)} s:\n${profile.join(' ')}`, `arms over time:\n${hist.join('\n')}`],
      numbers: { left: L, right: R, idleAt, massDrift: m - m0 },
    };
  },
};

export const partial = {
  name: 'partial', group: 'liquids', size: [16, 8, 16], needs: ['WALL', 'WATER'], cost: 120,
  title: 'a pool of any volume rests flat',
  audit: 'audit-liquids B4: a top-layer cell with an open side is kicked toward it forever (FLOW_SURFACE), so a partial layer beads and never rests',
  async run(e) {
    const O = OUTCOMES.partial;
    // a 14×14 tank: 2 full layers and 70 cells' worth on top (audit-liquids 2.1's "partial top layer", smaller)
    e.box([0, 0, 0], [15, 0, 15], 'WALL');
    e.box([0, 0, 0], [0, 7, 15], 'WALL'); e.box([15, 0, 0], [15, 7, 15], 'WALL');
    e.box([0, 0, 0], [15, 7, 0], 'WALL'); e.box([0, 0, 15], [15, 7, 15], 'WALL');
    e.box([1, 1, 1], [14, 2, 14], 'WATER'); e.box([1, 3, 1], [14, 3, 5], 'WATER');
    let g = await e.read();
    const m0 = liquidMass(g);
    setup(same(m0, 392 + 70), `start: ${m0} cells of water (462)`);
    const flatAt = 3 + 70 / 196;
    const { idleAt, resolution } = await advanceWatching(e, O.seconds, { every: 0.5 });
    g = await e.read();
    const [lo, hi] = levelRange(g, 1, 14, 1, 14), m = liquidMass(g);
    const top = mapText(16, 16, (x, z) => (x % 15 && z % 15 ? (wet(g, x, 3, z) ? '~' : '.') : '#'));
    return {
      headline: `surface ${r2(lo)}…${r2(hi)} cells (${r2(cm(hi - lo))} cm; flat would be ${r2(flatAt)}); ${idleAt === null ? 'not idle' : `idle at ${r2(idleAt)} s`}`,
      criteria: [
        crit('surface flat', r2(cm(hi - lo)), cm(hi - lo) <= O.levelCm, `≤ ${O.levelCm}`, 'cm'),
        crit('rests (certified idle)', idleAt === null ? 'never' : r2(idleAt), idleAt !== null && idleAt <= O.seconds, `≤ ${O.seconds}`, 's', restNote(resolution)),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [`top layer (y = 3) at ${r2(e.time)} s, ~ water, # wall:\n${top}`],
      numbers: { lo, hi, idleAt, massDrift: m - m0 },
    };
  },
};

export const puddle = {
  name: 'puddle', group: 'liquids', size: [32, 8, 24], needs: ['WATER'], cost: 180,
  title: 'a spill rests as a puddle with an edge, then AWAKE = 0',
  audit: 'audit-liquids B3: film edges keep 0.27 cells/step of cohesion pull and droplets re-roll a direction, so a spill smears to a speckle that never sleeps',
  async run(e) {
    const O = OUTCOMES.puddle;
    e.box([15, 3, 11], [16, 4, 12], 'WATER');   // 2³ dropped 3 cells onto the floor
    let g = await e.read();
    const m0 = liquidMass(g);
    setup(same(m0, 8), `start: ${m0} cells of water (8)`);
    const { idleAt, activity, resolution } = await advanceWatching(e, O.seconds, { every: 0.5 });
    g = await e.read();
    const m = liquidMass(g), { nx, nz } = g;
    let edge = Infinity, wetCols = 0, high = 0;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      let f = 0;
      for (let y = 0; y < g.ny; y++) { f += g.amount[at(g, x, y, z)]; if (g.amount[at(g, x, y, z)] > 0) high = Math.max(high, y); }
      if (f > 0) { wetCols++; edge = Math.min(edge, x, z, nx - 1 - x, nz - 1 - z); }
    }
    const map = mapText(nx, nz, (x, z) => amountChar(g, x, z));
    return {
      headline: `${wetCols} wet columns, ${edge === Infinity ? 'none' : edge} cells from the nearest wall, liquid up to y = ${high}; ${idleAt === null ? `not idle (${activity.awake} of ${activity.units} units awake)` : `idle at ${r2(idleAt)} s`}`,
      criteria: [
        crit('rests (certified idle)', idleAt === null ? 'never' : r2(idleAt), idleAt !== null && idleAt <= O.seconds, `≤ ${O.seconds}`, 's', restNote(resolution)),
        crit('has an edge (cells to the nearest wall)', edge === Infinity ? 0 : edge, edge >= O.wallGap && edge !== Infinity, `≥ ${O.wallGap}`, 'cells'),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [`liquid per column at ${r2(e.time)} s (tenths of a cell, 0 under a tenth; A = 1, B = 2 …):\n${map}`],
      numbers: { idleAt, wetCols, edge, massDrift: m - m0, awake: activity.awake },
    };
  },
};

export const pipe = {
  name: 'pipe', group: 'liquids', size: [48, 16, 8], needs: ['WALL', 'WATER'], cost: 160,
  title: "a tank drains through a 30-cell pipe to the pipe's level",
  audit: 'audit-liquids B2: a lidded cell has no head, and pipe flow only keeps the speed a cell came in with, so a full pipe stops with head behind it',
  async run(e) {
    const O = OUTCOMES.pipe;
    // a 4×4 tank 14 deep (y 2-15, 224 cells: 7 times what the bore holds, as a reservoir is) whose 1×1
    // bore (y 2, z 3) runs 30 cells (x 5-34: its own wall and 29 more) to fall 2 cells into an open basin
    // (x 35-47, and under the bore): audit-liquids 2.1's tank and bore, the bore 30 long as docs/v2.md 4.4
    // asks. (A 2×2 tank empties into the bore before today's pipe flow has decayed: it drains, and shows
    // nothing.)
    e.box([0, 0, 1], [5, 15, 6], 'WALL'); e.box([1, 2, 2], [4, 15, 5], 'AIR');
    e.box([6, 1, 2], [34, 3, 4], 'WALL'); e.box([5, 2, 3], [34, 2, 3], 'AIR');
    e.box([1, 2, 2], [4, 15, 5], 'WATER');
    const BORE_TOP = 3;   // the bore's cells are y = 2: its top face
    const tank = (g) => meanLevel(g, 1, 4, 2, 5);
    const bore = (g) => {
      let n = 0, f = 0, moving = 0;
      for (let x = 5; x <= 34; x++) { const i = at(g, x, 2, 3); if (g.amount[i] > 0) { n++; if (g.moving?.[i]) moving++; } f += g.amount[i]; }
      return { n, f, moving };
    };
    // what has left: everything past the bore's end, and under the bore
    const out = (g) => {
      let f = 0;
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 6; x < g.nx; x++) if (x >= 35 || y < 2 || z < 2 || z > 4) f += g.amount[at(g, x, y, z)];
      return f;
    };
    let g = await e.read();
    const m0 = liquidMass(g);
    setup(same(tank(g), 16) && same(m0, 224) && bore(g).n === 0 && e.kindOf(g.id[at(g, 20, 2, 3)]) === 'air' && e.kindOf(g.id[at(g, 35, 2, 3)]) === 'air',
      `start: tank level ${tank(g)} (16), ${m0} cells (224), the bore open and dry`);
    // it ends when the tank reaches the bore's top, or when it has stopped: a tank with head over its pipe
    // whose level hasn't moved for `stall` seconds is clogged, whatever it might do later
    const hist = [], levels = [];
    let reached = null, stalled = null;
    while (e.time < O.seconds - 1e-9 && reached === null && stalled === null) {
      await e.advance(0.5);
      const gg = await e.read(), b = bore(gg), l = tank(gg);
      levels.push([e.time, l]);
      if (l - BORE_TOP <= O.levelTol) reached = e.time;
      const back = levels.find(([t]) => t >= e.time - O.stall - 1e-9);
      if (e.time >= O.stall && back && back[0] <= e.time - O.stall + 1e-9 && Math.abs(back[1] - l) < 0.01) stalled = [back[0], e.time, l];
      if (every(e.time, 1)) hist.push(`${r2(e.time)} s: tank ${r3(l)}, bore ${b.n}/30 wet (${r2(b.f)} cells${gg.moving ? `, ${b.moving} moving` : ''}), out ${r2(out(gg))}`);
    }
    g = await e.read();
    const level = tank(g), m = liquidMass(g), b = bore(g);
    return {
      headline: `tank at ${r3(level)} after ${r2(e.time)} s (the bore's top is ${BORE_TOP})${reached !== null ? `, reached at ${r2(reached)} s` : ''}${stalled ? `, stopped: no change from ${r2(stalled[0])} to ${r2(stalled[1])} s, ${b.n}/30 of the bore wet` : ''}; ${r2(out(g))} cells out`,
      criteria: [
        crit("tank level over the bore's top", r3(level - BORE_TOP), level - BORE_TOP <= O.levelTol, `≤ ${O.levelTol}`, 'cells'),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [`over time:\n${hist.join('\n')}`, `bore (x = 5…34) at the end: ${Array.from({ length: 30 }, (_, k) => (g.amount[at(g, 5 + k, 2, 3)] > 0 ? (g.moving?.[at(g, 5 + k, 2, 3)] ? '>' : '~') : '.')).join('')} (~ water, > water moving, . dry)`],
      numbers: { level, reached, stalled, bore: b.n, boreFill: b.f, massDrift: m - m0 },
    };
  },
};

export const hole = {
  name: 'hole', group: 'liquids', size: [48, 32, 8], needs: ['WALL', 'WATER'], cost: 160,
  title: 'a hole drains its tank and throws its stream as V1\'s does (V1 measured: OUTCOMES.hole.v1)',
  audit: 'audit-liquids B7: the 2×2×2 block dots a falling column into parcels, a parcel on every other row at a time (alternate rows at alternate steps), so the jet is broken (B14\'s head-scan cap at ~16 cells doesn\'t bite here: every head is under 16)',
  async run(e) {
    const O = OUTCOMES.hole;
    // a 7×6 tank 18 deep (y 13-30) on a 13-cell pedestal, a 1-cell hole at the foot of its +x wall
    // (x 8, y 14, z 3): lean-sim hole, audit-liquids 2.1
    e.box([0, 0, 0], [8, 31, 7], 'WALL'); e.box([1, 13, 1], [7, 31, 6], 'AIR'); e.box([1, 13, 1], [7, 30, 6], 'WATER');
    e.box([8, 14, 3], [8, 14, 3], 'AIR');
    const EXIT_X = 9, EXIT_Y = 14.5, BAND = [6, 7, 8];   // the hole's outer face and centre; the rows measured, half way down
    const tankLevel = (g) => meanLevel(g, 1, 7, 1, 6);
    // the tank's liquid (cells): what is left in it, voids and all (V1's draining tank holds air under its surface)
    const tankMass = (g) => { let m = 0; for (let y = 13; y < g.ny; y++) for (let z = 1; z <= 6; z++) for (let x = 1; x <= 7; x++) m += g.amount[at(g, x, y, z)]; return m; };
    let g = await e.read();
    const m0 = liquidMass(g);
    setup(same(tankLevel(g), 31) && same(m0, 7 * 6 * 18) && e.kindOf(g.id[at(g, 8, 14, 3)]) === 'air', `start: level ${tankLevel(g)} (31), ${m0} cells (756), the hole open`);
    const gCells = e.info.gravity / CELL_M, dt = 1 / e.info.stepsPerSecond;   // cells/s², s
    const drop = (y) => EXIT_Y - (y + 0.5), flight = (y) => Math.sqrt((2 * drop(y)) / gCells);   // cells, s from the hole to row y
    const ideal = (h, y) => 2 * Math.sqrt(Math.max(h, 0) * drop(y));   // the parabola's x at row y for head h
    // the tank's level by game time, from every read, and the head when water now at row y left the hole
    const levels = [];
    const headAt = (t) => {
      let k = levels.length - 1;
      while (k > 0 && levels[k - 1][0] >= t) k--;
      const [ta, la] = levels[Math.max(k - 1, 0)], [tb, lb] = levels[k];
      return (tb > ta ? la + ((lb - la) * Math.min(Math.max(t - ta, 0), tb - ta)) / (tb - ta) : lb) - EXIT_Y;
    };
    // unbroken: in the hole's plane (z 2-4), liquid within two cells of liquid links the mouth to the floor
    const linked = (gg) => {
      const wetXY = (x, y) => { for (let z = 2; z <= 4; z++) if (gg.amount[at(gg, x, y, z)] > 0) return true; return false; };
      const seen = new Set(), stack = [];
      for (let y = 13; y <= 15; y++) if (wetXY(EXIT_X, y)) { stack.push([EXIT_X, y]); seen.add(EXIT_X + 64 * y); }
      while (stack.length) {
        const [x, y] = stack.pop();
        if (y <= 1) return true;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const X = x + dx, Y = y + dy;
          if (X < EXIT_X || Y < 0 || X >= gg.nx || Y >= gg.ny || seen.has(X + 64 * Y) || !wetXY(X, Y)) continue;
          seen.add(X + 64 * Y); stack.push([X, Y]);
        }
      }
      return false;
    };
    const rows = [], slices = [], drainedAt = [], reachAt = [];
    let worst = 0, measured = true, worstUnbroken = 1;
    for (const t of O.checkpoints) {
      // every step of the window [t - w/2, t + w/2], and of the flight time before it (the heads its water left at)
      const t0 = t - O.window / 2, t1 = t + O.window / 2;
      await e.advance(Math.max(0, t0 - flight(BAND[0]) - 2 * dt - e.time));
      const acc = BAND.map(() => ({ x: 0, ideal: 0, a: 0 }));
      let reads = 0, unbroken = 0, gt = null, ht = 0;
      while (e.time < t1 - 1e-9) {
        await e.advance(dt);
        const gg = await e.read();
        levels.push([e.time, tankLevel(gg)]);
        if (e.time < t0 - 1e-9) continue;
        reads++;
        if (linked(gg)) unbroken++;
        BAND.forEach((y, k) => {
          const id = ideal(headAt(e.time - flight(y)), y);
          for (let z = 2; z <= 4; z++) for (let x = EXIT_X; x < gg.nx; x++) {
            const a = gg.amount[at(gg, x, y, z)];
            if (a > 0) { acc[k].x += a * (x + 0.5 - EXIT_X); acc[k].ideal += a * id; acc[k].a += a; }
          }
        });
        if (!gt && e.time >= t - 1e-9) { gt = gg; ht = headAt(e.time - flight(7)); }
      }
      const sx = acc.reduce((s, r) => s + r.x, 0), si = acc.reduce((s, r) => s + r.ideal, 0), sa = acc.reduce((s, r) => s + r.a, 0);
      const err = sa > 0 ? Math.abs(sx / si - 1) : null, share = unbroken / reads;
      if (err === null) measured = false; else worst = Math.max(worst, err);
      worstUnbroken = Math.min(worstUnbroken, share);
      const perRow = BAND.map((y, k) => (acc[k].a > 0 ? `y ${y}: ${r2(acc[k].x / acc[k].a)} (parabola ${r2(acc[k].ideal / acc[k].a)}, ${r2(acc[k].a)} cells·reads)` : `y ${y}: no water`)).join('; ');
      drainedAt.push(7 * 6 * 18 - tankMass(gt)); reachAt.push(sa > 0 ? sx / sa : null);
      rows.push(`${t} s ± ${O.window / 2} s (${reads} steps): head ${r2(headAt(t0))}…${r2(headAt(t1))} cells; ${err === null ? `no water crossed rows ${BAND[0]}-${BAND.at(-1)}: reach not measured` : `the stream ${r2(100 * err)} % off the √(2gh) parabola`} [${perRow}]; unbroken from the hole to the floor in ${unbroken} of ${reads} reads`);
      const par = (x) => EXIT_Y - ((x - EXIT_X) / 2) ** 2 / Math.max(ht, 1e-6);   // the ideal stream's y at x
      slices.push(`at ${r2(t)} s (# wall, ~ ≥ ½ cell, , less, + the ideal parabola):\n${sliceText(gt, (x, y) => {
        const id = gt.id[at(gt, x, y, 3)];
        if (e.kindOf(id) === 'solid') return '#';
        let a = 0; for (let z = 2; z <= 4; z++) a = Math.max(a, gt.amount[at(gt, x, y, z)]);
        if (a >= 0.5) return '~';
        if (a > 0) return ',';
        return x >= EXIT_X && Math.abs(par(x + 0.5) - (y + 0.5)) < 0.5 ? '+' : ' ';
      }, { y1: 20 })}`);
    }
    g = await e.read();
    const m = liquidMass(g);
    // V1's own hole (OUTCOMES.hole.v1, measured on the GPU): its stream is broken at 60 Hz with its pull and lands
    // off the ideal parabola, so V2 is held to V1's outcome, not the ideal: as unbroken and as near the parabola as
    // V1's at least, its tank drained by each checkpoint (cells) within drainTol of what V1's drained, and its
    // stream's reach (rows 6-8, mass-weighted, cells past the hole) within reachV1Tol of V1's
    const V1 = O.v1;
    const drainErr = Math.max(...drainedAt.map((d, k) => Math.abs(d / V1.drained[k] - 1)));
    const reachErr = reachAt.some(x => x === null) ? null : Math.max(...reachAt.map((x, k) => Math.abs(x / V1.reach[k] - 1)));
    return {
      headline: rows.at(-1).replace(/ \[.*\]/, ''),
      criteria: [
        crit('one unbroken stream (worst window: share of its reads)', r2(worstUnbroken), worstUnbroken >= V1.unbroken, `≥ V1's ${V1.unbroken}`),
        crit('reach off the √(2gh) parabola (worst window)', measured ? r2(100 * worst) : 'not measured', measured && worst <= Math.max(O.reachTol, V1.offParabola), `≤ V1's ${r2(100 * Math.max(O.reachTol, V1.offParabola))}`, measured ? '%' : ''),
        crit('drains as V1\'s tank (worst checkpoint, off V1\'s drained cells)', r2(100 * drainErr), drainErr <= O.drainTol, `≤ ${100 * O.drainTol}`, '%'),
        crit('the stream reaches as V1\'s (worst window, off V1\'s reach)', reachErr === null ? 'not measured' : r2(100 * reachErr), reachErr !== null && reachErr <= O.reachV1Tol, `≤ ${100 * O.reachV1Tol}`, reachErr === null ? '' : '%'),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [rows.join('\n'), ...slices],
      numbers: { worstReach: measured ? worst : null, unbroken: worstUnbroken, massDrift: m - m0, drained: drainedAt.map(r3), reach: reachAt.map(x => (x === null ? null : r3(x))) },
    };
  },
};

export const splash = {
  name: 'splash', group: 'liquids', size: [32, 16, 32], needs: ['WATER'], cost: 70,
  title: 'a block dropped into a pool splashes as much of its kinetic energy out of it as V1\'s (V1 measured: OUTCOMES.splash.v1)',
  audit: 'audit-liquids B5, B6: a liquid cell that lands gets a random sideways speed of 0.9 cells/step plus 0.3·|vy| (per component up to V_MAX), so a landing makes kinetic energy, not spends it (×160-210 from a 1-cell drop)',
  expressible: (e) => (e.info.velocity ? null : `${e.name} reports no complete cell velocities`),
  async run(e) {
    const O = OUTCOMES.splash, S = 3;   // the pool's surface: layers y 0-2 are full
    // a pool 3 deep over the whole floor, and a 4×4×2 block of water whose foot is 6 cells over it
    e.box([0, 0, 0], [31, S - 1, 31], 'WATER');
    e.box([14, S + 6, 14], [17, S + 7, 17], 'WATER');
    // kinetic energy of liquid (fill or particle mass × speed², in cells·(m/s)²: the same ρ throughout, so
    // the ratio is the energies'), all of it, and of what is at or above the surface going sideways or up: the
    // splash. Its fall back is not counted (the downward part of its speed), so a drop thrown level counts its throw
    // whether it is a cell sliding on the surface (V1 move.js land: v.y = 0, the throw sideways) or a packet already
    // falling a tick after it left (V2's crown, columns.js colSplash)
    const water = e.id('WATER');
    const thrown = (vx, vy, vz) => vx * vx + vz * vz + Math.max(vy, 0) ** 2;
    const energy = (g) => {
      let all = 0, out = 0, lowest = Infinity, cellsOut = 0;
      const inFlight = new Map();   // (amount bins each particle into its cell: the cell's own fill is the rest)
      for (const p of g.particles ?? []) {
        setup(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) &&
          Number.isFinite(p.vx) && Number.isFinite(p.vy) && Number.isFinite(p.vz) &&
          Number.isFinite(p.mass) && p.mass >= 0, 'splash: invalid matter packet position, velocity or mass');
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (inGrid(g, x, y, z)) inFlight.set(at(g, x, y, z), (inFlight.get(at(g, x, y, z)) ?? 0) + p.mass);
      }
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const i = at(g, x, y, z), a = g.id[i] === water ? g.amount[i] - (inFlight.get(i) ?? 0) : 0;
        if (!(a > 0)) continue;
        setup(!g.velocityKnown || g.velocityKnown[i] !== 0, `splash: unknown resident-water velocity at ${x},${y},${z}`);
        const vx = g.vel[3 * i], vy = g.vel[3 * i + 1], vz = g.vel[3 * i + 2];
        setup(Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(vz), `splash: nonfinite resident-water velocity at ${x},${y},${z}`);
        const k = a * (vx * vx + vy * vy + vz * vz), up = a * thrown(vx, vy, vz);
        all += k;
        if (y >= S) { out += up; if (up > 0) cellsOut++; }
        if (y >= S) lowest = Math.min(lowest, y);
      }
      for (const p of g.particles ?? []) {
        const k = p.mass * (p.vx * p.vx + p.vy * p.vy + p.vz * p.vz), up = p.mass * thrown(p.vx, p.vy, p.vz);
        all += k; if (p.y >= S) { out += up; if (up > 0) cellsOut++; }
        lowest = Math.min(lowest, Math.floor(p.y));
      }
      setup(Number.isFinite(all) && Number.isFinite(out), 'splash: nonfinite kinetic energy');
      return { all, out, lowest, cellsOut };
    };
    let g = await e.read();
    const m0 = liquidMass(g), k0 = energy(g);
    setup(same(m0, 32 * 32 * S + 32) && k0.all < 1e-9, `start: ${m0} cells of water (${32 * 32 * S + 32}), kinetic energy ${k0.all} (0)`);
    // fall to contact: the read before the block's foot reaches the surface layer (y = S) is the incoming
    const dt = 1 / e.info.stepsPerSecond;
    let incoming = 0, contact = null, fallTime = 0;
    while (contact === null && e.time < 3) {
      await e.advance(dt);
      g = await e.read();
      const k = energy(g);
      if (k.lowest <= S) contact = e.time; else { incoming = k.all; fallTime = e.time; }
    }
    setup(contact !== null && incoming > 0, `the block never reached the pool (${r2(e.time)} s)`);
    const vIdeal = Math.sqrt(2 * e.info.gravity * 6 * CELL_M);   // m/s at 6 cells of free fall
    const vIn = Math.sqrt(incoming / 32);
    let peak = 0, peakAt = 0, peakAll = 0, peakCells = 0;
    const hist = [];
    while (e.time < contact + O.seconds - 1e-9) {
      await e.advance(dt);
      g = await e.read();
      const k = energy(g);
      if (k.out > peak) { peak = k.out; peakAt = e.time - contact; peakCells = k.cellsOut; }
      peakAll = Math.max(peakAll, k.all);
      if (Math.round((e.time - contact) / dt) % Math.max(1, Math.round(0.05 / dt)) === 0) hist.push(`${r2(e.time - contact)} s: out of the pool ${r2(k.out / incoming)} of the incoming (${k.cellsOut} cells moving), all liquid ${r2(k.all / incoming)}`);
    }
    const ratio = peak / incoming, m = liquidMass(g);
    return {
      headline: `the block met the pool at ${r2(vIn)} m/s (free fall: ${r2(vIdeal)}); at its peak, ${r2(peakAt)} s after contact, the splash carried ${r2(ratio)} of that energy (${peakCells} cells); all liquid at most ${r2(peakAll / incoming)}`,
      criteria: [
        crit('splash kinetic energy / incoming (peak), off V1\'s', r2(ratio), Math.abs(ratio / O.v1 - 1) <= O.keTol, `V1's ${O.v1} ± ${100 * O.keTol} %`),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [`fell ${r2(fallTime)} s to contact at ${r2(contact)} s; after contact:\n${hist.join('\n')}`],
      numbers: { ratio, incoming, vIn, vIdeal, peakAll: peakAll / incoming, peakAt },
    };
  },
};

export const yieldSlope = {
  name: 'yield', group: 'liquids', size: [16, 8, 16], needs: ['WATER', 'MUD'], cost: 140,
  title: 'mud levels as V1\'s does (no yield stress), and water spreads to a layer or less',
  audit: 'MV-8 (the V2 finish push): V1 has no yield stress (react.js: a liquid flows until the level evens out), so V1\'s mud levels to a cell over 64 columns from a 4³ block within 1 s; V2\'s yield dead band held a mound',
  async run(e, ctx) {
    const O = OUTCOMES.yield;
    const one = async (name) => {
      await ctx.fresh();   // a new box for each liquid
      e.box([6, 0, 6], [9, 3, 9], name);   // a 4³ block standing on the floor
      await e.advance(O.seconds);
      const g = await e.read();
      let peak = 0, cols = 0;
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) { const l = columnLevel(g, x, z); peak = Math.max(peak, l); if (l > 0) cols++; }
      return { peak, cols, map: mapText(16, 16, (x, z) => amountChar(g, x, z)) };
    };
    const water = await one('WATER'), mud = await one('MUD');
    return {
      headline: `after ${O.seconds} s a 4³ block stands ${r2(mud.peak)} cells tall as mud over ${mud.cols} columns, ${r2(water.peak)} as water over ${water.cols}`,
      criteria: [
        crit('mud levels as V1\'s (its peak)', r2(mud.peak), mud.peak <= O.mudPeak, `≤ V1's ${O.mudPeak}`, 'cells'),
        crit('water spreads to a layer or less', r2(water.peak), water.peak <= O.waterPeak, `≤ ${O.waterPeak}`, 'cells'),
      ],
      evidence: [`mud per column (tenths of a cell; A = 1, B = 2 …):\n${mud.map}`, `water per column:\n${water.map}`],
      numbers: { mudPeak: mud.peak, waterPeak: water.peak, mudCols: mud.cols, waterCols: water.cols },
    };
  },
};

export default [utube, partial, puddle, pipe, hole, splash, yieldSlope];

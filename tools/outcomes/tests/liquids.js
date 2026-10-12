// Liquid outcomes (docs/v2.md 4.4, GPU acceptance): U-tube, partial layer,
// puddle, pipe, hole jet, yield. Scenes after lean-sim's (tools/v2/lean-sim.mjs)
// and audit-liquids.md 2.1, sized for SwiftShader: each its smallest grid that
// still shows its outcome. Every test checks its scene before it runs it
// (SetupError: the result would say nothing about physics) and prints the
// evidence a failure needs: level profiles, maps, slices.
import { at, SetupError } from '../engine.js';
import { OUTCOMES, CELL_M } from '../thresholds.js';
import { columnLevel, meanLevel, levelRange, liquidMass, mapText, sliceText, amountChar, advanceWatching, crit, r2, r3, wet } from '../lib.js';

const cm = (cells) => cells * CELL_M * 100;
const setup = (ok, what) => { if (!ok) throw new SetupError(what); };
const same = (a, b) => Math.abs(a - b) < 1e-6;
const every = (t, period) => Math.abs(t / period - Math.round(t / period)) < 1e-6;   // t is a multiple of period

export const utube = {
  name: 'utube', group: 'liquids', size: [32, 32, 8], needs: ['WALL', 'WATER'], cost: 40,
  title: 'a U-tube equalises within 1 cm and rests',
  async run(e) {
    const O = OUTCOMES.utube, [nx, ny] = this.size;
    // two 4×4 arms (x 1-4 and 25-28) open to the top, joined at their feet by a 20-cell channel (y 1-4);
    // the left arm filled to y = 25 (lean-sim utube; audit-liquids 2.1)
    e.box([0, 0, 0], [nx - 1, ny - 1, 7], 'WALL');
    e.box([1, 1, 2], [4, ny - 1, 5], 'AIR'); e.box([25, 1, 2], [28, ny - 1, 5], 'AIR'); e.box([5, 1, 2], [24, 4, 5], 'AIR');
    e.box([1, 1, 2], [4, 25, 5], 'WATER'); e.box([5, 1, 2], [24, 4, 5], 'WATER');
    const arms = (g) => [meanLevel(g, 1, 4, 2, 5), meanLevel(g, 25, 28, 2, 5)];
    let g = await e.read();
    const m0 = liquidMass(g), [L0, R0] = arms(g);
    setup(same(L0, 26) && same(R0, 0) && same(m0, 720), `start: arms at ${L0}, ${R0} (26, 0), mass ${m0} (720)`);
    const hist = [];
    const { idleAt } = await advanceWatching(e, O.seconds, {
      every: 0.5,
      onChunk: async (t) => { if (every(t, 2)) { const [L, R] = arms(await e.read()); hist.push(`${r2(t)} s: left ${r2(L)}, right ${r2(R)}`); } },
    });
    g = await e.read();
    const [L, R] = arms(g), m = liquidMass(g);
    const profile = [];
    for (let x = 1; x <= 28; x++) profile.push(r2(columnLevel(g, x, 3)));
    return {
      headline: `left ${r2(L)}, right ${r2(R)} cells: ${r2(cm(Math.abs(L - R)))} cm apart; ${idleAt === null ? 'not idle' : `idle at ${r2(idleAt)} s`}`,
      criteria: [
        crit('arms level', r2(cm(Math.abs(L - R))), cm(Math.abs(L - R)) <= O.levelCm, `≤ ${O.levelCm}`, 'cm'),
        crit('rests (certified idle)', idleAt === null ? 'never' : r2(idleAt), idleAt !== null && idleAt <= O.seconds, `≤ ${O.seconds}`, 's'),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [`surface along the channel (z = 3), x = 1…28 at ${r2(e.time)} s:\n${profile.join(' ')}`, `arms over time:\n${hist.join('\n')}`],
      numbers: { left: L, right: R, idleAt, massDrift: m - m0 },
    };
  },
};

export const partial = {
  name: 'partial', group: 'liquids', size: [16, 8, 16], needs: ['WALL', 'WATER'], cost: 70,
  title: 'a pool of any volume rests flat',
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
    const { idleAt } = await advanceWatching(e, O.seconds, { every: 0.5 });
    g = await e.read();
    const [lo, hi] = levelRange(g, 1, 14, 1, 14), m = liquidMass(g);
    const top = mapText(16, 16, (x, z) => (x % 15 && z % 15 ? (wet(g, x, 3, z) ? '~' : '.') : '#'));
    return {
      headline: `surface ${r2(lo)}…${r2(hi)} cells (${r2(cm(hi - lo))} cm; flat would be ${r2(flatAt)}); ${idleAt === null ? 'not idle' : `idle at ${r2(idleAt)} s`}`,
      criteria: [
        crit('surface flat', r2(cm(hi - lo)), cm(hi - lo) <= O.levelCm, `≤ ${O.levelCm}`, 'cm'),
        crit('rests (certified idle)', idleAt === null ? 'never' : r2(idleAt), idleAt !== null && idleAt <= O.seconds, `≤ ${O.seconds}`, 's'),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [`top layer (y = 3) at ${r2(e.time)} s, ~ water, # wall:\n${top}`],
      numbers: { lo, hi, idleAt, massDrift: m - m0 },
    };
  },
};

export const puddle = {
  name: 'puddle', group: 'liquids', size: [32, 8, 32], needs: ['WATER'], cost: 150,
  title: 'a spill rests as a puddle with an edge, then AWAKE = 0',
  async run(e) {
    const O = OUTCOMES.puddle;
    e.box([15, 3, 15], [16, 4, 16], 'WATER');   // 2³ dropped 3 cells onto the floor
    let g = await e.read();
    const m0 = liquidMass(g);
    setup(same(m0, 8), `start: ${m0} cells of water (8)`);
    const { idleAt, activity } = await advanceWatching(e, O.seconds, { every: 0.5 });
    g = await e.read();
    const m = liquidMass(g), n = g.nx;
    let edge = Infinity, wetCols = 0, high = 0;
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      let f = 0;
      for (let y = 0; y < g.ny; y++) { f += g.amount[at(g, x, y, z)]; if (g.amount[at(g, x, y, z)] > 0) high = Math.max(high, y); }
      if (f > 0) { wetCols++; edge = Math.min(edge, x, z, n - 1 - x, n - 1 - z); }
    }
    const map = mapText(n, n, (x, z) => amountChar(g, x, z));
    return {
      headline: `${wetCols} wet columns, ${edge === Infinity ? 'none' : edge} cells from the nearest wall, liquid up to y = ${high}; ${idleAt === null ? `not idle (${activity.awake} of ${activity.units} units awake)` : `idle at ${r2(idleAt)} s`}`,
      criteria: [
        crit('rests (certified idle)', idleAt === null ? 'never' : r2(idleAt), idleAt !== null && idleAt <= O.seconds, `≤ ${O.seconds}`, 's'),
        crit('has an edge (cells to the nearest wall)', edge === Infinity ? 0 : edge, edge >= O.wallGap && edge !== Infinity, `≥ ${O.wallGap}`, 'cells'),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [`liquid per column at ${r2(e.time)} s (tenths of a cell, 0 under a tenth; A = 1, B = 2 …):\n${map}`],
      numbers: { idleAt, wetCols, edge, massDrift: m - m0, awake: activity.awake },
    };
  },
};

export const pipe = {
  name: 'pipe', group: 'liquids', size: [48, 16, 8], needs: ['WALL', 'WATER'], cost: 80,
  title: "a tank drains through a 30-cell pipe to the pipe's level",
  async run(e) {
    const O = OUTCOMES.pipe;
    // a 2×2 tank 12 deep (y 4-15) whose 1×1 bore (y 4, z 3) runs 30 cells (x 3-32: its own wall and 29
    // more) to fall into an open basin (x 33-47) whose floor is 4 cells lower (audit-liquids 2.1's tank and
    // bore, the bore 30 long as docs/v2.md 4.4 asks)
    e.box([0, 0, 2], [3, 15, 5], 'WALL'); e.box([1, 4, 3], [2, 15, 4], 'AIR');
    e.box([4, 3, 2], [32, 5, 4], 'WALL'); e.box([3, 4, 3], [32, 4, 3], 'AIR');
    e.box([1, 4, 3], [2, 15, 4], 'WATER');
    const BORE_TOP = 5;   // the bore's cells are y = 4: its top face
    const tank = (g) => meanLevel(g, 1, 2, 3, 4);
    const bore = (g) => { let n = 0, f = 0; for (let x = 3; x <= 32; x++) { const a = g.amount[at(g, x, 4, 3)]; if (a > 0) n++; f += a; } return [n, f]; };
    // what has left: the basin past the bore's end, and under the bore
    const basin = (g) => {
      let f = 0;
      for (let y = 0; y < 16; y++) for (let z = 0; z < 8; z++) for (let x = 0; x < 48; x++) if (x >= 33 || y < 3) f += g.amount[at(g, x, y, z)];
      return f;
    };
    let g = await e.read();
    const m0 = liquidMass(g);
    setup(same(tank(g), 16) && same(m0, 48) && bore(g)[0] === 0 && g.amount[at(g, 33, 4, 3)] === 0 && e.kindOf(g.id[at(g, 20, 4, 3)]) === 'air',
      `start: tank level ${tank(g)} (16), ${m0} cells (48), the bore open and dry`);
    const hist = [];
    await advanceWatching(e, O.seconds, {
      every: 1,
      onChunk: async (t) => { if (every(t, 5)) { const gg = await e.read(), [n, f] = bore(gg); hist.push(`${r2(t)} s: tank ${r2(tank(gg))}, bore ${n}/30 wet (${r2(f)} cells), basin ${r2(basin(gg))}`); } },
    });
    g = await e.read();
    const level = tank(g), m = liquidMass(g), [n, f] = bore(g);
    return {
      headline: `tank at ${r2(level)} (the bore's top is ${BORE_TOP}); bore ${n}/30 wet; ${r2(basin(g))} cells out at ${r2(e.time)} s`,
      criteria: [
        crit("tank level over the bore's top", r2(level - BORE_TOP), level - BORE_TOP <= O.levelTol, `≤ ${O.levelTol}`, 'cells'),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [`over time:\n${hist.join('\n')}`, `bore (x = 3…32) at the end: ${Array.from({ length: 30 }, (_, k) => (g.amount[at(g, 3 + k, 4, 3)] > 0 ? '~' : '.')).join('')}`],
      numbers: { level, bore: n, boreFill: f, massDrift: m - m0 },
    };
  },
};

export const hole = {
  name: 'hole', group: 'liquids', size: [48, 32, 8], needs: ['WALL', 'WATER'], cost: 60,
  title: 'a hole pours one unbroken stream within 5 % of the √(2gh) parabola at every head',
  async run(e) {
    const O = OUTCOMES.hole;
    // a 7×6 tank 18 deep (y 13-30) on a 13-cell pedestal, a 1-cell hole at the foot of its +x wall
    // (x 8, y 14, z 3): lean-sim hole, audit-liquids 2.1
    e.box([0, 0, 0], [8, 31, 7], 'WALL'); e.box([1, 13, 1], [7, 31, 6], 'AIR'); e.box([1, 13, 1], [7, 30, 6], 'WATER');
    e.box([8, 14, 3], [8, 14, 3], 'AIR');
    const EXIT_X = 9, EXIT_Y = 14.5, ROW = 7;   // the hole's outer face and centre; the row measured, half way down
    const tankLevel = (g) => meanLevel(g, 1, 7, 1, 6);
    let g = await e.read();
    const m0 = liquidMass(g);
    setup(same(tankLevel(g), 31) && same(m0, 7 * 6 * 18) && e.kindOf(g.id[at(g, 8, 14, 3)]) === 'air', `start: level ${tankLevel(g)} (31), ${m0} cells (756), the hole open`);
    const gCells = e.info.gravity / CELL_M;   // cells/s²
    const flight = Math.sqrt(2 * (EXIT_Y - (ROW + 0.5)) / gCells);   // s from the hole to the row
    const rows = [], slices = [];
    let worstReach = 0, allUnbroken = true;
    for (const t of O.checkpoints) {
      // the head when the water now at the row left the hole
      await e.advance(Math.max(0, t - flight - e.time));
      const h = tankLevel(await e.read()) - EXIT_Y;
      await e.advance(t - e.time);
      g = await e.read();
      // the stream's mean x at the row, in the hole's plane (z 2-4), past the wall
      let sx = 0, sw = 0;
      for (let z = 2; z <= 4; z++) for (let x = EXIT_X; x < g.nx; x++) { const a = g.amount[at(g, x, ROW, z)]; sx += a * (x + 0.5); sw += a; }
      const ideal = 2 * Math.sqrt(Math.max(h, 0) * (EXIT_Y - (ROW + 0.5)));
      const reach = sw > 0 ? sx / sw - EXIT_X : 0, err = ideal > 0 ? Math.abs(reach - ideal) / ideal : 1;
      worstReach = Math.max(worstReach, err);
      // unbroken: in the slice, liquid within a cell of liquid links the hole's mouth to the floor
      const wetXY = (x, y) => { for (let z = 2; z <= 4; z++) if (g.amount[at(g, x, y, z)] > 0) return true; return false; };
      const seen = new Set(), stack = [];
      for (let y = 13; y <= 15; y++) if (wetXY(EXIT_X, y)) { stack.push([EXIT_X, y]); seen.add(EXIT_X + 64 * y); }
      let floor = false;
      while (stack.length) {
        const [x, y] = stack.pop();
        if (y <= 1) floor = true;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const X = x + dx, Y = y + dy;
          if (X < EXIT_X || Y < 0 || X >= g.nx || Y >= g.ny || seen.has(X + 64 * Y) || !wetXY(X, Y)) continue;
          seen.add(X + 64 * Y); stack.push([X, Y]);
        }
      }
      allUnbroken &&= floor;
      rows.push(`${t} s: head ${r2(h)} cells, the stream ${r2(reach)} cells out at y = ${ROW} (√(2gh) parabola: ${r2(ideal)}, ${r2(100 * err)} % off), ${floor ? 'unbroken' : 'broken'}`);
      const par = (x) => EXIT_Y - ((x - EXIT_X) / 2) ** 2 / Math.max(h, 1e-6);   // the ideal stream's y at x
      slices.push(`at ${t} s (# wall, ~ ≥ ½ cell, , less, + the ideal parabola):\n${sliceText(g, (x, y) => {
        const id = g.id[at(g, x, y, 3)];
        if (e.kindOf(id) === 'solid') return '#';
        let a = 0; for (let z = 2; z <= 4; z++) a = Math.max(a, g.amount[at(g, x, y, z)]);
        if (a >= 0.5) return '~';
        if (a > 0) return ',';
        return x >= EXIT_X && Math.abs(par(x + 0.5) - (y + 0.5)) < 0.5 ? '+' : ' ';
      }, { y1: 20 })}`);
    }
    const m = liquidMass(g);
    return {
      headline: rows.at(-1),
      criteria: [
        crit('one unbroken stream at every checkpoint', allUnbroken ? 'yes' : 'no', allUnbroken, 'yes'),
        crit('reach off the √(2gh) parabola (worst checkpoint)', r2(100 * worstReach), worstReach <= O.reachTol, `≤ ${100 * O.reachTol}`, '%'),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [rows.join('\n'), ...slices],
      numbers: { worstReach, unbroken: allUnbroken, massDrift: m - m0 },
    };
  },
};

export const yieldSlope = {
  name: 'yield', group: 'liquids', size: [16, 8, 16], needs: ['WATER', 'MUD'], cost: 80,
  title: 'slope rises with yield: mud holds a mound, water spreads',
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
        crit('mud mound height', r2(mud.peak), mud.peak >= O.mudPeak, `≥ ${O.mudPeak}`, 'cells'),
        crit('water spreads under', r2(water.peak), water.peak < O.waterPeak, `< ${O.waterPeak}`, 'cells'),
        crit('mud stands taller than water', r2(mud.peak - water.peak), mud.peak > water.peak, '> 0', 'cells'),
      ],
      evidence: [`mud per column (tenths of a cell; A = 1, B = 2 …):\n${mud.map}`, `water per column:\n${water.map}`],
      numbers: { mudPeak: mud.peak, waterPeak: water.peak, mudCols: mud.cols, waterCols: water.cols },
    };
  },
};

export default [utube, partial, puddle, pipe, hole, yieldSlope];

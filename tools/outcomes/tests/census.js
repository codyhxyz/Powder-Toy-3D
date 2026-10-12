// Mass and the positive controls. The census (docs/v2.md 4.1 "mass is exact by
// construction", 12 risk 3): liquid plus particle mass exact through a pour and
// a splash, and cells per element conserved where nothing reacts. The controls
// are scenes today's engine does handle, so an adapter that writes, reads,
// steps or reports activity wrongly shows up here instead of passing for
// failing physics: a full tank stays full and rests, sand falls and lands,
// wood past its ignition point burns (fire.js woodBurns), the census itself.
import { at, SetupError } from '../engine.js';
import { OUTCOMES, LEVEL_CM } from '../thresholds.js';
import { tally, liquidMass, levelRange, cellsOf, advanceWatching, crit, r2, r3 } from '../lib.js';

const setup = (ok, what) => { if (!ok) throw new SetupError(what); };

export const census = {
  name: 'census', group: 'census', size: [16, 16, 16], needs: ['SAND', 'WATER', 'WALL'], cost: 50,
  title: 'liquid and particle mass exact, cells per element kept, through a pour and a splash',
  async run(e) {
    const O = OUTCOMES.census;
    // a basin (a wall ring, x, z 1-14, 3 high) over 2 layers of sand; a 3×3×8 column of water dropped
    // into it from y 6 and a 4×2×2 block of sand from y 14 after it: a splash, then sand through water
    e.box([0, 0, 0], [15, 1, 15], 'SAND');
    e.box([1, 2, 1], [14, 4, 1], 'WALL'); e.box([1, 2, 14], [14, 4, 14], 'WALL');
    e.box([1, 2, 1], [1, 4, 14], 'WALL'); e.box([14, 2, 1], [14, 4, 14], 'WALL');
    e.box([6, 6, 6], [8, 13, 8], 'WATER');
    e.box([5, 14, 9], [8, 15, 10], 'SAND');
    const count = (g) => { const c = tally(g, e).cells; return [c.SAND ?? 0, c.WALL ?? 0]; };
    let g = await e.read();
    const m0 = liquidMass(g), [s0, w0] = count(g);
    setup(m0 === 72 && s0 === 512 + 16 && w0 === 4 * 13 * 3, `start: ${m0} water (72), ${s0} sand (528), ${w0} wall (156)`);
    let worstM = 0, worstS = 0, worstW = 0, checks = 0;
    const rows = [];
    while (e.time < O.seconds - 1e-9) {
      await e.advance(O.every);
      g = await e.read();
      const m = liquidMass(g), [s, w] = count(g), inFlight = (g.particles ?? []).reduce((a, p) => a + p.mass, 0);
      worstM = Math.max(worstM, Math.abs(m - m0)); worstS = Math.max(worstS, Math.abs(s - s0)); worstW = Math.max(worstW, Math.abs(w - w0));
      checks++;
      if (checks % 5 === 0) rows.push(`${r2(e.time)} s: water ${r3(m)} (${r3(inFlight)} in flight), sand ${s}, wall ${w}`);
    }
    return {
      headline: `${checks} checks over ${r2(e.time)} s: water off by at most ${r3(worstM)} cells, sand by ${worstS}, wall by ${worstW}`,
      criteria: [
        crit('liquid + particle mass exact (worst drift)', r3(worstM), worstM < 1e-6, '0', 'cells'),
        crit('sand cells kept (worst drift)', worstS, worstS === 0, '0', 'cells'),
        crit('wall cells kept (worst drift)', worstW, worstW === 0, '0', 'cells'),
      ],
      evidence: [rows.join('\n')],
      numbers: { worstM, worstS, worstW, checks },
    };
  },
};

export const tankStill = {
  name: 'tankStill', group: 'controls', size: [16, 8, 16], needs: ['WALL', 'WATER'], cost: 30,
  title: 'control: a tank of whole layers stays full and flat, and rests',
  async run(e) {
    const O = OUTCOMES.tankStill;
    // partial.js's tank without the partial layer: 3 full layers in a 14×14 tank (audit-liquids 2.1's control)
    e.box([0, 0, 0], [15, 0, 15], 'WALL');
    e.box([0, 0, 0], [0, 7, 15], 'WALL'); e.box([15, 0, 0], [15, 7, 15], 'WALL');
    e.box([0, 0, 0], [15, 7, 0], 'WALL'); e.box([0, 0, 15], [15, 7, 15], 'WALL');
    e.box([1, 1, 1], [14, 3, 14], 'WATER');
    let g = await e.read();
    const m0 = liquidMass(g);
    setup(m0 === 588, `start: ${m0} water (588)`);
    const { idleAt } = await advanceWatching(e, O.seconds, { every: 0.25 });
    g = await e.read();
    const [lo, hi] = levelRange(g, 1, 14, 1, 14), m = liquidMass(g);
    // full: the surface within the hidden mass docs/v2.md 4.1 allows a compressible liquid (≤ 5 % of its depth)
    const full = 4 - O.hidden * 3;
    return {
      headline: `surface ${r3(lo)}…${r3(hi)} (4 is full), ${idleAt === null ? 'not idle' : `idle at ${r2(idleAt)} s`}`,
      criteria: [
        crit('stays full (lowest surface)', r3(lo), lo >= full && hi <= 4 + 1e-6, `${r2(full)}…4`, 'cells'),
        crit('stays flat', r2((hi - lo) * 30), (hi - lo) * 30 <= LEVEL_CM, `≤ ${LEVEL_CM}`, 'cm'),
        crit('rests (certified idle)', idleAt === null ? 'never' : r2(idleAt), idleAt !== null && idleAt <= O.seconds, `≤ ${O.seconds}`, 's'),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [],
      numbers: { lo, hi, idleAt },
    };
  },
};

export const sandFalls = {
  name: 'sandFalls', group: 'controls', size: [16, 16, 16], needs: ['SAND'], cost: 20,
  title: 'control: a block of sand in the air falls and lands',
  async run(e) {
    const O = OUTCOMES.sandFalls;
    e.box([6, 10, 6], [9, 13, 9], 'SAND');   // 4³ at y 10-13
    const sand = e.id('SAND');
    const stats = (g) => {
      const c = cellsOf(g, [sand]);
      let mean = 0, held = 0;
      for (const [x, y, z] of c) { mean += y / c.length; if (y === 0 || g.id[at(g, x, y - 1, z)] !== e.id('AIR')) held++; }
      return { n: c.length, mean, held };
    };
    const a = stats(await e.read());
    setup(a.n === 64 && Math.abs(a.mean - 11.5) < 1e-9, `start: ${a.n} grains (64) at mean y ${a.mean} (11.5)`);
    await e.advance(O.seconds);
    const b = stats(await e.read());
    return {
      headline: `mean height ${r2(a.mean)} → ${r2(b.mean)}; ${b.held} of ${b.n} grains resting on something`,
      criteria: [
        crit('fell (mean height)', r2(b.mean), b.mean < 3, '< 3', 'cells'),
        crit('landed (grains with something under them)', b.held, b.held === b.n, `${b.n}`),
        crit('grains kept', b.n, b.n === 64, '64'),
      ],
      evidence: [],
      numbers: { from: a.mean, to: b.mean, held: b.held },
    };
  },
};

export default [census, tankStill, sandFalls];

// Fire outcomes (docs/v2.md 5.5 R8): a flame lights wood by contact. The scene
// is audit-physics E7's (two 1,000 °C flames at a wooden block's corner) on a
// 4³ block, six times over in walled bays (R8's ignition is a chance a second,
// so one trial says little); the positive control, woodBurns, is E7b's
// pre-heated edge (the Campfire's 450 °C logs), which today's engine does burn.
import { SetupError } from '../engine.js';
import { OUTCOMES } from '../thresholds.js';
import { crit, r2 } from '../lib.js';

const setup = (ok, what) => { if (!ok) throw new SetupError(what); };

// Wood cells, how many of them the engine says are burning, the hottest, and flames, smoke and ash about
// (in the cells x0..x1 only, when given: one bay).
function woodStats(g, e, x0 = 0, x1 = g.nx - 1) {
  const wood = e.id('WOOD'), fire = e.id('FIRE'), smoke = e.id('SMOKE'), ash = e.id('ASH');
  const s = { wood: 0, burning: 0, maxT: -Infinity, fire: 0, smoke: 0, ash: 0 };
  for (let i = 0; i < g.id.length; i++) {
    if (i % g.nx < x0 || i % g.nx > x1) continue;
    const id = g.id[i];
    if (id === wood) { s.wood++; if (g.burning?.[i]) s.burning++; if (g.T) s.maxT = Math.max(s.maxT, g.T[i]); }
    else if (id === fire) s.fire++;
    else if (id === smoke) s.smoke++;
    else if (id === ash) s.ash++;
  }
  return s;
}
const line = (t, s) => `${r2(t)} s: wood ${s.wood} (${s.burning} burning, hottest ${r2(s.maxT)} °C), flames ${s.fire}, smoke ${s.smoke}, ash ${s.ash}`;

// a 4³ wooden block on the floor at x, z 6-9
const block = (e, opts) => e.box([6, 0, 6], [9, 3, 9], 'WOOD', opts);
// lit: some wood burning by the engine's own flag, or wood gone to fire, smoke or ash
const lit = (s0, s) => s.burning > 0 || s.wood < s0.wood;
const needsFire = (e) => (e.info.burning ? null : `${e.name} has no burning state`);

export const flameWood = {
  name: 'flameWood', group: 'fire', size: [48, 8, 8], needs: ['WOOD', 'FIRE', 'WALL'], cost: 45,
  title: 'two 1,000 °C flames light a wooden block (in 5 of 6 trials)',
  audit: 'audit-physics B9: ignition is a temperature threshold only; buoyant flames warm the wood to ~39 °C and are gone',
  expressible: needsFire,
  async run(e) {
    const O = OUTCOMES.flameWood, W = 8;
    // six bays 8 cells wide along x, walled from each other (a WALL slab at each bay's +x side; the grid's
    // edge closes the last): in each, a 4³ wooden block on the floor (x 2-5 of the bay, z 2-5) and two
    // flames against its corner edge (x 1, y 0-1, z 2), as in audit-physics E7
    for (let k = 0; k < O.trials; k++) {
      const x = W * k;
      if (k < O.trials - 1) e.box([x + W - 1, 0, 0], [x + W - 1, 7, 7], 'WALL');
      e.box([x + 2, 0, 2], [x + 5, 3, 5], 'WOOD');
      e.box([x + 1, 0, 2], [x + 1, 1, 2], 'FIRE', { T: 1000 });
    }
    const bay = (g, k) => woodStats(g, e, W * k, W * k + W - 1);
    let g = await e.read();
    const s0 = Array.from({ length: O.trials }, (_, k) => bay(g, k));
    setup(s0.every((s) => s.wood === 64 && s.fire === 2 && s.burning === 0), `start: ${s0.map((s) => `${s.wood} wood, ${s.fire} flames, ${s.burning} burning`).join('; ')} (64, 2, 0 in each bay)`);
    const litAt = s0.map(() => null), rows = [`0 s: ${s0.map((s) => `${s.wood}w ${s.fire}f`).join(' | ')}`];
    let s = s0;
    while (e.time < O.seconds - 1e-9 && litAt.some((t) => t === null)) {
      await e.advance(0.25);
      g = await e.read();
      s = s0.map((_, k) => bay(g, k));
      s.forEach((sk, k) => { if (litAt[k] === null && lit(s0[k], sk)) litAt[k] = e.time; });
      rows.push(`${r2(e.time)} s: ${s.map((sk) => `${sk.wood}w ${sk.burning}b ${r2(sk.maxT)}°C ${sk.fire}f ${sk.smoke}s`).join(' | ')}`);
    }
    const n = litAt.filter((t) => t !== null).length;
    return {
      headline: `${n} of ${O.trials} blocks lit within ${O.seconds} s${n ? ` (at ${litAt.map((t) => (t === null ? '-' : r2(t))).join(', ')} s)` : ''}; last: ${line(e.time, s[0])} (bay 1)`,
      criteria: [crit(`blocks lit within ${O.seconds} s`, n, n >= O.lit, `≥ ${O.lit} of ${O.trials}`)],
      evidence: [`per bay (w wood, b burning, hottest wood, f flames, s smoke):\n${rows.join('\n')}`],
      numbers: { lit: n, litAt, final: s },
    };
  },
};

export const woodBurns = {
  name: 'woodBurns', group: 'controls', size: [16, 16, 16], needs: ['WOOD'], cost: 20,
  title: 'control: wood with a 450 °C edge burns (the Campfire)',
  expressible: needsFire,
  async run(e) {
    const O = OUTCOMES.woodBurns;
    block(e);
    e.box([6, 0, 6], [6, 3, 6], 'WOOD', { T: 450 });   // one edge column pre-heated past its ignition point
    const s0 = woodStats(await e.read(), e);
    setup(s0.wood === 64, `start: ${s0.wood} wood (64)`);
    await e.advance(O.seconds);
    const s = woodStats(await e.read(), e);
    return {
      headline: line(e.time, s),
      criteria: [crit('wood burning', s.burning + (s0.wood - s.wood), lit(s0, s), '> 0', 'cells')],
      evidence: [`${line(0, s0)}\n${line(e.time, s)}`],
      numbers: { start: s0, final: s },
    };
  },
};

export default [flameWood, woodBurns];

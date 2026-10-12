// Fire outcomes (docs/v2.md 5.5 R8): a flame lights wood by contact. The scene
// is audit-physics E7's (two 1,000 °C flames at a wooden block's corner) on a
// 4³ block; the positive control, woodBurns, is E7b's pre-heated edge (the
// Campfire's 450 °C logs), which today's engine does burn.
import { at, SetupError } from '../engine.js';
import { OUTCOMES } from '../thresholds.js';
import { crit, r2 } from '../lib.js';

const setup = (ok, what) => { if (!ok) throw new SetupError(what); };

// Wood cells, how many of them the engine says are burning, the hottest, and flames, smoke and ash about.
function woodStats(g, e) {
  const wood = e.id('WOOD'), fire = e.id('FIRE'), smoke = e.id('SMOKE'), ash = e.id('ASH');
  const s = { wood: 0, burning: 0, maxT: -Infinity, fire: 0, smoke: 0, ash: 0 };
  for (let i = 0; i < g.id.length; i++) {
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
  name: 'flameWood', group: 'fire', size: [16, 16, 16], needs: ['WOOD', 'FIRE'], cost: 60,
  title: 'two 1,000 °C flames light a wooden block',
  audit: 'audit-physics B9: ignition is a temperature threshold only; buoyant flames warm the wood to ~39 °C and are gone',
  expressible: needsFire,
  async run(e) {
    const O = OUTCOMES.flameWood;
    block(e);
    e.box([5, 0, 6], [5, 1, 6], 'FIRE', { T: 1000 });   // two flames against its corner
    let g = await e.read();
    const s0 = woodStats(g, e);
    setup(s0.wood === 64 && s0.fire === 2 && s0.burning === 0, `start: ${s0.wood} wood (64), ${s0.fire} flames (2), ${s0.burning} burning (0)`);
    const rows = [line(0, s0)];
    let litAt = null, s = s0;
    while (e.time < O.seconds - 1e-9 && litAt === null) {
      await e.advance(0.25);
      s = woodStats(await e.read(), e);
      rows.push(line(e.time, s));
      if (lit(s0, s)) litAt = e.time;
    }
    return {
      headline: litAt === null ? `not lit after ${O.seconds} s: ${rows.at(-1)}` : `lit by ${r2(litAt)} s`,
      criteria: [crit('wood lit', litAt === null ? 'never' : r2(litAt), litAt !== null, `≤ ${O.seconds}`, 's')],
      evidence: [rows.join('\n')],
      numbers: { litAt, final: s },
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

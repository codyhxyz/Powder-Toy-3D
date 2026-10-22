// Fire outcomes (docs/v2.md 5.5 R8): fire lights wood. The scene is a 4³ wooden
// block with the fire brush held to its corner edge, as a player sets wood alight
// (audit-physics E7's two 1,000 °C flames at a block's corner, held), six times
// over in walled bays (ignition is partly a chance, so one trial says little);
// the positive control, woodBurns, is E7b's pre-heated edge (the Campfire's
// 450 °C logs).
import { SetupError } from '../engine.js';
import { OUTCOMES } from '../thresholds.js';
import { crit, r2 } from '../lib.js';

const setup = (ok, what) => { if (!ok) throw new SetupError(what); };

// Cell-equivalent material, including live packets. Leaving the grid is not
// conversion. Explicit x bounds select one bay, using the packet's cell index.
export function woodStats(g, e, x0, x1 = g.nx - 1) {
  const wood = e.id('WOOD'), fire = e.id('FIRE'), smoke = e.id('SMOKE'), ash = e.id('ASH');
  const tracked = new Set([wood, fire, smoke, ash]);
  const s = { wood: 0, burning: 0, maxT: -Infinity, fire: 0, smoke: 0, ash: 0 };
  for (let i = 0; i < g.id.length; i++) {
    if (x0 !== undefined && (i % g.nx < x0 || i % g.nx > x1)) continue;
    const id = g.id[i];
    if (id === wood) { s.wood++; if (g.burning?.[i]) s.burning++; if (g.T) s.maxT = Math.max(s.maxT, g.T[i]); }
    else if (id === fire) s.fire++;
    else if (id === smoke) s.smoke++;
    else if (id === ash) s.ash++;
  }
  for (const p of g.particles ?? []) {
    if (!tracked.has(p.id)) continue;
    setup(Number.isFinite(p.mass) && p.mass > 0 && Number.isFinite(p.x), 'invalid fire material packet mass/position');
    if (x0 !== undefined && (Math.floor(p.x) < x0 || Math.floor(p.x) > x1)) continue;
    if (p.id === wood) {
      setup(Number.isFinite(p.T), 'invalid wood packet temperature');
      s.wood += p.mass;
      if (p.burning) s.burning += p.mass;
      s.maxT = Math.max(s.maxT, p.T);
    } else if (p.id === fire) s.fire += p.mass;
    else if (p.id === smoke) s.smoke += p.mass;
    else if (p.id === ash) s.ash += p.mass;
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
  name: 'flameWood', group: 'fire', size: [48, 8, 8], needs: ['WOOD', 'FIRE', 'WALL'], cost: 60,
  title: 'a fire brush held to a wooden block\'s corner lights it (in 5 of 6 trials)',
  audit: 'audit-physics B9: two 1,000 °C flames put down once warm the wood to ~39 °C and are gone (a one-frame dab: FIRE lives ~0.15 s); a player holds the brush',
  expressible: needsFire,
  async run(e) {
    const O = OUTCOMES.flameWood, W = 8;
    // six bays 8 cells wide along x, walled from each other (a WALL slab at each bay's +x side; the grid's
    // edge closes the last): in each, a 4³ wooden block on the floor (x 2-5 of the bay, z 2-5) and the fire
    // brush held to its corner edge, as a player lights wood: FIRE at its 1,000 °C painted into the empty
    // cells of a 1×3×3 patch beside the edge (x 1, y 0-2, z 1-3) every frame for O.held s, as the held
    // brush paints FIRE into the empty cells under it each frame (app.js brushPaints; shaders/passes.js
    // paintUpdateWGSL, replace off). (The bench's first scene put two flames down once: a one-frame dab of
    // FIRE, which lives ~0.15 s (physics.js FIRE_BURN), lit no engine's wood, V1's either: not play.)
    const brush = (k) => e.box([W * k + 1, 0, 1], [W * k + 1, 2, 3], 'FIRE', { T: 1000, onlyEmpty: true });
    for (let k = 0; k < O.trials; k++) {
      const x = W * k;
      if (k < O.trials - 1) e.box([x + W - 1, 0, 0], [x + W - 1, 7, 7], 'WALL');
      e.box([x + 2, 0, 2], [x + 5, 3, 5], 'WOOD');
      brush(k);
    }
    const bay = (g, k) => woodStats(g, e, W * k, W * k + W - 1);
    let g = await e.read();
    const s0 = Array.from({ length: O.trials }, (_, k) => bay(g, k));
    setup(s0.every((s) => s.wood === 64 && s.fire === 9 && s.burning === 0), `start: ${s0.map((s) => `${s.wood} wood, ${s.fire} flames, ${s.burning} burning`).join('; ')} (64, 9, 0 in each bay)`);
    const litAt = s0.map(() => null), rows = [`0 s: ${s0.map((s) => `${s.wood}w ${s.fire}f`).join(' | ')}`];
    let s = s0;
    while (e.time < O.seconds - 1e-9 && litAt.some((t) => t === null)) {
      // a quarter second a frame at a time, the brush painting while it is held
      for (let f = 0; f < 15; f++) {
        if (e.time < O.held - 1e-9) for (let k = 0; k < O.trials; k++) brush(k);
        await e.advance(1 / 60);
      }
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

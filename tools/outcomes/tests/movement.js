// Movement against V1 (the V2 finish push, WS-C): what sinks, floats, rises and spreads, and how fast, and a
// heavy-grain slab onto C-4. One box size for every scene, so an engine builds its kernels once per run.
// Each criterion is V1's own behaviour (measured on V1's CPU port of move.js and react.js, src/ui/tiles/engine.js,
// and V1's laws: tools/v2/exchange-check.mjs, grain-landing-check.mjs), with room for the run's own noise.
import { SetupError } from '../engine.js';
import { cellsOf, crit, r2 } from '../lib.js';

const SIZE = [16, 48, 16];
const EVEN = 2 * (16 * 16 - 1) / 12;
const mean = (cells, a) => cells.reduce((s, c) => s + c[a], 0) / Math.max(1, cells.length);
// the mean height of `name`'s cells every `every` s for `seconds`
async function track(e, name, seconds, every = 0.1) {
  const id = e.id(name), out = [];
  for (let t = 0; t < seconds - 1e-9; t += every) { await e.advance(every); out.push({ t: e.time, y: mean(cellsOf(await e.read(), [id]), 1), n: cellsOf(await e.read(), [id]).length }); }
  return out;
}
// the speed (cells/s) between the first sample past `from` cells moved and the last before `to`
function speed(samples, y0, from, to) {
  const moved = s => Math.abs(s.y - y0);
  const a = samples.find(s => moved(s) >= from), b = [...samples].reverse().find(s => moved(s) <= to && s.t > (a?.t ?? Infinity));
  return a && b ? Math.abs(b.y - a.y) / (b.t - a.t) : 0;
}

export const sinkSand = {
  name: 'sinkSand', group: 'movement', size: SIZE, needs: ['SAND', 'WATER', 'URANIUM'], cost: 20,
  title: 'movement: sand and uranium sink through water at V1\'s speeds',
  async run(e, ctx) {
    const out = {};
    for (const grain of ['SAND', 'URANIUM']) {
      await ctx.fresh();
      e.box([0, 0, 0], [15, 43, 15], 'WATER');
      e.box([7, 41, 7], [8, 42, 8], grain);
      const s = await track(e, grain, grain === 'SAND' ? 0.8 : 0.4, 0.05);
      out[grain] = speed(s, 41.5, 3, 30);
    }
    return {
      headline: `sand ${r2(out.SAND)} cells/s, uranium ${r2(out.URANIUM)} cells/s through water`,
      criteria: [crit('sand sinks (V1 ~70-77)', r2(out.SAND), out.SAND > 45 && out.SAND < 110, '45..110', 'cells/s'),
        crit('uranium sinks (V1 ~213-240)', r2(out.URANIUM), out.URANIUM > 120, '> 120', 'cells/s')],
      evidence: [], numbers: out,
    };
  },
};

export const floatSawdust = {
  name: 'floatSawdust', group: 'movement', size: SIZE, needs: ['SAWDUST', 'WATER'], cost: 20,
  title: 'movement: sawdust under water floats up, slowly, as in V1',
  async run(e) {
    e.box([0, 0, 0], [15, 30, 15], 'WATER');
    e.box([6, 1, 6], [9, 2, 9], 'SAWDUST');
    const s = await track(e, 'SAWDUST', 3, 0.5);
    const rise = (s.at(-1).y - 1.5) / s.at(-1).t;
    return {
      headline: `sawdust rose ${r2(s.at(-1).y - 1.5)} cells in ${r2(s.at(-1).t)} s (${r2(rise)} cells/s)`,
      criteria: [crit('floats up (V1 ~4-7)', r2(rise), rise > 1.5 && rise < 15, '1.5..15', 'cells/s')],
      evidence: [], numbers: { rise },
    };
  },
};

export const gasRise = {
  name: 'gasRise', group: 'movement', size: SIZE, needs: ['HYDROGEN', 'CO2'], cost: 20,
  title: 'movement: hydrogen rises fast, CO2 sinks slowly, each at its own speed',
  async run(e) {
    e.box([7, 2, 2], [8, 3, 3], 'HYDROGEN');
    e.box([7, 44, 12], [8, 45, 13], 'CO2');
    const id = { H: e.id('HYDROGEN'), C: e.id('CO2') }, at = [];
    for (let k = 0; k < 6; k++) { await e.advance(0.1); const g = await e.read(); at.push({ t: e.time, h: mean(cellsOf(g, [id.H]), 1), c: mean(cellsOf(g, [id.C]), 1) }); }
    const h = (at[2].h - 2.5) / at[2].t, c = (44.5 - at.at(-1).c) / at.at(-1).t;
    return {
      headline: `hydrogen rose ${r2(h)} cells/s, CO2 sank ${r2(c)} cells/s`,
      criteria: [crit('hydrogen rises (V1 ~130-150)', r2(h), h > 60, '> 60', 'cells/s'),
        crit('CO2 sinks (V1 ~15-19)', r2(c), c > 5 && c < 40, '5..40', 'cells/s')],
      evidence: [], numbers: { hydrogen: h, co2: c },
    };
  },
};

export const gasSpread = {
  name: 'gasSpread', group: 'movement', size: SIZE, needs: ['CO2', 'WALL'], cost: 20,
  title: 'movement: CO2 in a sealed room keeps spreading until it fills it',
  async run(e) {
    e.box([0, 6, 0], [15, 6, 15], 'WALL');   // a lid: the room is y 0..5
    e.box([6, 0, 6], [9, 3, 9], 'CO2');
    const id = e.id('CO2');
    const spread = g => { const c = cellsOf(g, [id]); const mx = mean(c, 0), mz = mean(c, 2); return c.reduce((s, p) => s + (p[0] - mx) ** 2 + (p[2] - mz) ** 2, 0) / Math.max(1, c.length); };
    const s0 = spread(await e.read());
    await e.advance(2); const s2 = spread(await e.read());
    await e.advance(3); const s5 = spread(await e.read());
    return {
      headline: `CO2's spread ${r2(s0)} → ${r2(s2)} cells² at 2 s → ${r2(s5)} at 5 s`,
      // (a cell spread evenly over the 16×16 room: (16² - 1)/12 on each axis; V1 on the GPU: 39 at 2 s, 43 at 5 s)
      criteria: [crit('mixed through the room by 5 s', r2(s5), s5 > 0.8 * EVEN, `> ${r2(0.8 * EVEN)}`, 'cells²')],
      evidence: [], numbers: { s0, s2, s5 },
    };
  },
};

export const slabOnC4 = {
  name: 'slabOnC4', group: 'movement', size: SIZE, needs: ['URANIUM', 'C4', 'STONE'], cost: 25,
  title: 'movement: a uranium slab dropped 1 and 3 cells onto C-4 sets it off as V1\'s grains do',
  async run(e, ctx) {
    const went = {};
    for (const h of [1, 3]) {
      await ctx.fresh();
      e.box([0, 0, 0], [15, 3, 15], 'STONE');
      e.box([4, 4, 4], [11, 4, 11], 'C4');
      e.box([6, 5 + h, 6], [9, 5 + h, 9], 'URANIUM');
      const c4 = e.id('C4'), before = cellsOf(await e.read(), [c4]).length;
      if (before !== 64) throw new SetupError(`C-4 ${before}`);
      await e.advance(1);
      went[h] = cellsOf(await e.read(), [c4]).length < before;
    }
    return {
      headline: `from 1 cell ${went[1] ? 'went off' : 'rested'}, from 3 cells ${went[3] ? 'went off' : 'rested'}`,
      criteria: [crit('from 3 cells it goes off (V1: 16 grains at 0.52 each, 1 - 0.48^16)', went[3], went[3], 'off')],
      evidence: [], numbers: { from1: went[1], from3: went[3] },
    };
  },
};

export default [sinkSand, floatSawdust, gasRise, gasSpread, slabOnC4];

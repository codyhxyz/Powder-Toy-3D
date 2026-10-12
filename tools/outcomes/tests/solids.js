// Solid outcomes (docs/v2.md 5.3, 5.5 R1-R2, 0 "Things move honestly"): a
// slab falls as a slab, heaps take their element's angle, come out round and
// rest, a throw lands where its velocity says. Scenes after lean-sim's slab and
// heap and audit-physics E1-E3. "Where the engine's own law says" is the
// engine's declared fall and flight (engine.fall, engine.flight: its g, run or
// terminal speed and drag), so the tests ask that velocity becomes motion, not
// that two engines share a g.
import { at, SetupError } from '../engine.js';
import { OUTCOMES, ROUND_TOL } from '../thresholds.js';
import { tally, cellsOf, heightMap, reach, mapText, digit, advanceWatching, crit, r2 } from '../lib.js';

const setup = (ok, what) => { if (!ok) throw new SetupError(what); };

export const slab = {
  name: 'slab', group: 'solids', size: [32, 32, 32], needs: ['SAND'], cost: 30,
  title: 'a slab stays a slab and falls on its own law',
  audit: 'audit-physics B2, B3: a cell moves with probability |v| only on its parity\'s steps, each grain on its own coin, so a slab smears over 21 cells at 65 % of its own velocity',
  expressible: (e) => (e.fall('SAND', 0.1) === null ? `${e.name} declares no fall law` : null),
  async run(e) {
    const O = OUTCOMES.slab, Y0 = 28, N = 24 * 24;
    e.box([4, Y0, 4], [27, Y0, 27], 'SAND');   // a 24×24×1 layer (audit-physics E2, lean-sim slab)
    const sand = e.id('SAND');
    const stats = (g) => {
      let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
      for (const [, y] of cellsOf(g, [sand])) { lo = Math.min(lo, y); hi = Math.max(hi, y); sum += y; n++; }
      return { lo, hi, mean: sum / n, n };
    };
    setup(stats(await e.read()).n === N, 'start: the slab has 576 grains');
    // the ideal landing time on the engine's own law, to its step
    const dt = 1 / e.info.stepsPerSecond;
    let tLand = 0;
    while (e.fall('SAND', tLand) < Y0 && tLand < 10) tLand += dt;
    const rows = [];
    let worst = 0, thick = 1, worstAt = '';
    for (let k = 1; k <= 5; k++) {
      await e.advance(Math.round((k / 6) * tLand / dt) * dt - e.time);
      const s = stats(await e.read()), fallen = Y0 - s.mean, ideal = Math.min(e.fall('SAND', e.time), Y0);
      const err = Math.abs(fallen - ideal), tol = Math.max(1, O.fallTol * ideal);
      if (err / tol > worst) { worst = err / tol; worstAt = `${r2(e.time)} s`; }
      thick = Math.max(thick, s.hi - s.lo + 1);
      rows.push(`${r2(e.time)} s: fallen ${r2(fallen)} cells (its law: ${r2(ideal)}), layers y ${s.lo}…${s.hi} (${s.hi - s.lo + 1} thick)`);
    }
    await e.advance(tLand * 0.3 + 0.25);
    const g = await e.read(), s = stats(g);
    let floor = 0;
    for (const [, y] of cellsOf(g, [sand])) if (y === 0) floor++;
    rows.push(`${r2(e.time)} s (landed): ${floor} of ${s.n} grains on the floor, layers y ${s.lo}…${s.hi}`);
    return {
      headline: rows[2],
      criteria: [
        crit('thickest while falling', thick, thick === 1, '1', 'layers'),
        crit('fall off its law (worst, in tolerances: a cell or 5 %)', r2(worst), worst <= 1, `≤ 1 (at ${worstAt})`),
        crit('lands as one layer', floor, floor === N, `${N}`, 'grains on the floor'),
        crit('grains kept', s.n, s.n === N, `${N}`),
      ],
      evidence: [rows.join('\n')],
      numbers: { worst, thick, floor, tLand },
    };
  },
};

function heapTest(name, element) {
  return {
    name, key: 'heap', group: 'solids', size: [32, 16, 24], needs: [element], cost: 170,
    title: `a ${element === 'SAND' ? 'sand' : 'flour'} heap takes its angle, comes out round and rests`,
    audit: 'audit-physics B1, 4.2: every powder piles to the automaton\'s one square, terraced heap (slide only sets the time), and the rest test assumes 8 lower neighbours the move can\'t reach, so a settled heap never sleeps',
    async run(e) {
      const O = OUTCOMES.heap, id = e.id(element), [nx, , nz] = this.size;
      // poured from a 6×6 hopper (x 13-18, z 9-14) at y = 14, a layer each 1/15 s into its empty cells,
      // until 432 grains are in (lean-sim heap's hopper, half its grains)
      const count = (g) => tally(g, e).cells[e.nameOf(id)] ?? 0;
      let poured = 0;
      while (poured < O.grains && e.time < 20) {
        e.box([13, 14, 9], [18, 14, 14], element, { onlyEmpty: true });
        await e.advance(1 / 15);
        poured = count(await e.read());
      }
      setup(poured >= O.grains, `the pour stalled at ${poured} grains`);
      const pourEnd = e.time;
      const { idleAt } = await advanceWatching(e, O.restSeconds, { every: 0.25 });
      const g = await e.read(), n = count(g);
      const H = heightMap(g, [id]);
      let peak = 0, foot = 0;
      for (const h of H) { peak = Math.max(peak, h); if (h) foot++; }
      const r = reach(nx, nz, 16, 12, (x, z) => H[x + nx * z] > 0);
      const ratio = r.rDiag / r.rAxis, slope = peak / r.rAxis, band = O.slope[element];
      const rest = idleAt === null ? null : idleAt - pourEnd;
      return {
        headline: `${n} grains: peak ${peak}, reach ${r2(r.rAxis)} along the axes and ${r2(r.rDiag)} on the diagonals (×${r2(ratio)}), slope ${r2(slope)}; ${rest === null ? 'not idle' : `idle ${r2(Math.max(rest, 0))} s after the pour`}`,
        criteria: [
          crit('round: diagonal reach / axis reach', r2(ratio), Math.abs(ratio - 1) <= ROUND_TOL, `1 ± ${ROUND_TOL}`),
          crit(`slope (peak / axis reach) in its class`, r2(slope), slope >= band[0] && slope <= band[1], `${band[0]}…${band[1]}`),
          crit('rests after the pour ends', rest === null ? 'never' : r2(Math.max(rest, 0)), rest !== null && rest <= O.restSeconds, `≤ ${O.restSeconds}`, 's'),
          crit('grains kept', n, n === poured, `${poured}`),
        ],
        evidence: [`height map at ${r2(e.time)} s (pour ended at ${r2(pourEnd)} s), x 4…27, z 0…23:\n${mapText(nx, nz, (x, z) => digit(H[x + nx * z]), { x0: 4, x1: 27 })}`,
          `reach: axes ${r.axis.map(r2).join(' ')}, diagonals ${r.diag.map(r2).join(' ')}`],
        numbers: { grains: n, peak, foot, rAxis: r.rAxis, rDiag: r.rDiag, ratio, slope, pourEnd, idleAt },
      };
    },
  };
}
export const heapSand = heapTest('heapSand', 'SAND');
export const heapFlour = heapTest('heapFlour', 'FLOUR');

export const throwLump = {
  name: 'throw', group: 'solids', size: [32, 32, 32], needs: ['SAND'], cost: 40,
  title: 'a thrown lump lands where its velocity says',
  audit: 'audit-physics B2: sideways moves skip a cell that moved this step and drag eats the rest, so a throw goes 33-57 % as far as its velocity says',
  expressible: (e) => (e.flight('SAND', [1, 0], 0.1) === null ? `${e.name} has no thrown matter (its particles are liquid only)` : null),
  async run(e) {
    const O = OUTCOMES.throw, DROP = 24, X0 = 3;   // the lump's bottom at y = 24, its centre at x = 3
    const dt = 1 / e.info.stepsPerSecond;
    // where a cell thrown at vx cells/s from DROP up lands, on the engine's own law: [dx, t]
    const land = (vx) => { let t = 0, d; do { t += dt; d = e.flight('SAND', [vx, 0], t); } while (d[1] > -DROP && t < 10); return [d[0], t]; };
    let lo = 0, hi = 400;
    for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (land(mid)[0] < O.travel) lo = mid; else hi = mid; }
    const vx = (lo + hi) / 2, [, tLand] = land(vx);
    // a 2×2×2 lump of sand at x 2-3, y 24-25, z 15-16 thrown along +x (audit-physics E1's grains, as one lump)
    e.box([2, DROP, 15], [3, DROP + 1, 16], 'SAND', { v: [vx * e.info.cellM, 0, 0] });
    const sand = e.id('SAND');
    setup(cellsOf(await e.read(), [sand]).length === 8, 'start: 8 grains');
    await e.advance(tLand * 1.5 + 0.5);
    const cells = cellsOf(await e.read(), [sand]);
    const mx = cells.reduce((s, c) => s + c[0] + 0.5, 0) / cells.length, ideal = X0 + O.travel;
    const spread = Math.max(...cells.map((c) => Math.abs(c[0] + 0.5 - mx)));
    const tol = Math.max(1, O.landTol * O.travel);
    return {
      headline: `thrown at ${r2(vx * e.info.cellM)} m/s, its law lands it at x = ${ideal}; it rests at x = ${r2(mx)} (${r2(100 * (mx - X0) / O.travel)} % of the throw), cells ±${r2(spread)} about it`,
      criteria: [
        crit('lands where its law says (off by)', r2(Math.abs(mx - ideal)), Math.abs(mx - ideal) <= tol, `≤ ${r2(tol)}`, 'cells'),
        crit('lands as a lump (farthest cell from its centre)', r2(spread), spread <= O.spread, `≤ ${O.spread}`, 'cells'),
        crit('grains kept', cells.length, cells.length === 8, '8'),
      ],
      evidence: [`resting cells (x, y, z): ${cells.map((c) => c.join(',')).join('  ')}`],
      numbers: { vx, tLand, mx, ideal, spread },
    };
  },
};

export default [slab, heapSand, heapFlour, throwLump];

// Blast outcomes (docs/v2.md 5.5 R10, R12; 11 P2 and P4): a charge on open
// ground leaves a round crater, not audit-physics E4's L1 diamond; a charge in
// a sealed vessel stays contained and keeps its pressure (E5's box lost 95 %
// in 100 steps).
import { at, SetupError } from '../engine.js';
import { OUTCOMES, ROUND_TOL } from '../thresholds.js';
import { reach, mapText, digit, crit, r2 } from '../lib.js';

const setup = (ok, what) => { if (!ok) throw new SetupError(what); };

export const blastCrater = {
  name: 'blast', group: 'blasts', size: [32, 16, 32], needs: ['BRICK', 'C4'], cost: 90,
  title: 'a charge on open ground leaves a round crater',
  audit: 'audit-physics B4: pressure is a max-plus front that travels in the L1 metric, so what a charge breaks is a diamond around it',
  async run(e) {
    const O = OUTCOMES.blast;
    // a brick floor 4 deep; one cell of C4 on it at its centre, lit (past its ignition point), in open air
    e.box([0, 0, 0], [31, 3, 31], 'BRICK');
    e.box([16, 4, 16], [16, 4, 16], 'C4', { T: 400 });
    const brick = e.id('BRICK');
    let g = await e.read();
    let n0 = 0;
    for (let i = 0; i < g.id.length; i++) if (g.id[i] === brick) n0++;
    setup(n0 === 32 * 32 * 4, `start: ${n0} bricks (4096)`);
    await e.advance(O.seconds);
    g = await e.read();
    // the crater: per column, the floor's cells that are no longer brick
    const D = new Int16Array(32 * 32);
    for (let y = 0; y < 4; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) if (g.id[at(g, x, y, z)] !== brick) D[x + 32 * z]++;
    let gone = 0;
    for (const d of D) gone += d;
    const r = reach(32, 32, 16.5, 16.5, (x, z) => D[x + 32 * z] > 0);
    const ratio = r.rAxis > 0 ? r.rDiag / r.rAxis : 0;
    return {
      headline: `${gone} bricks broken; the crater reaches ${r2(r.rAxis)} along the axes and ${r2(r.rDiag)} on the diagonals (×${r2(ratio)})`,
      criteria: [
        crit('a crater (axis reach)', r2(r.rAxis), r.rAxis >= O.minReach, `≥ ${O.minReach}`, 'cells'),
        crit('round: diagonal reach / axis reach', r2(ratio), r.rAxis > 0 && Math.abs(ratio - 1) <= ROUND_TOL, `1 ± ${ROUND_TOL}`),
      ],
      evidence: [`cells broken per column (of 4) at ${r2(e.time)} s, x, z 4…28:\n${mapText(32, 32, (x, z) => digit(D[x + 32 * z]), { x0: 4, x1: 28, z0: 4, z1: 28 })}`,
        `reach: axes ${r.axis.map(r2).join(' ')}, diagonals ${r.diag.map(r2).join(' ')}`],
      numbers: { gone, rAxis: r.rAxis, rDiag: r.rDiag, ratio },
    };
  },
};

export const vessel = {
  name: 'vessel', group: 'blasts', size: [16, 16, 16], needs: ['WALL', 'GUNPOWDER'], cost: 60,
  title: 'a blast in a sealed vessel is contained and keeps its pressure',
  audit: 'audit-physics B5: a global 3 % decay a step deletes pressure, sealed or not (E5: 100 to 4.8 in 100 steps)',
  expressible: (e) => (e.info.pressure ? null : `${e.name} has no air pressure (docs/v2.md P4 adds the air grid)`),
  async run(e) {
    const O = OUTCOMES.vessel;
    // a WALL box (x, y, z 2-13: 1-cell walls round a 10³ room) holding one lit cell of gunpowder
    e.box([2, 2, 2], [13, 13, 13], 'WALL'); e.box([3, 3, 3], [12, 12, 12], 'AIR');
    e.box([7, 7, 7], [7, 7, 7], 'GUNPOWDER', { T: 400 });
    const wall = e.id('WALL');
    const inside = (x, y, z) => x >= 3 && x <= 12 && y >= 3 && y <= 12 && z >= 3 && z <= 12;
    const measure = (g) => {
      let pin = 0, nin = 0, pout = 0, walls = 0;
      for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const i = at(g, x, y, z);
        if (g.id[i] === wall) { walls++; continue; }
        if (inside(x, y, z)) { pin += g.pressure[i]; nin++; } else pout = Math.max(pout, Math.abs(g.pressure[i]));
      }
      return { p: pin / nin, out: pout, walls };
    };
    const w0 = measure(await e.read()).walls;
    setup(w0 === 12 ** 3 - 10 ** 3, `start: ${w0} wall cells (728)`);
    await e.advance(0.25);
    const a = measure(await e.read());
    await e.advance(O.seconds);
    const b = measure(await e.read());
    const keep = a.p > 0 ? b.p / a.p : 0;
    return {
      headline: `mean overpressure inside ${r2(a.p)} at 0.25 s, ${r2(b.p)} ${O.seconds} s later (${r2(100 * keep)} % kept); outside at most ${r2(Math.max(a.out, b.out))}`,
      criteria: [
        crit('a blast at all (overpressure at 0.25 s)', r2(a.p), a.p > 0, '> 0', 'engine units'),
        crit(`kept after ${O.seconds} s`, r2(keep), keep >= O.keep, `≥ ${O.keep}`),
        crit('contained (outside / inside)', r2(a.p > 0 ? Math.max(a.out, b.out) / a.p : 1), a.p > 0 && Math.max(a.out, b.out) <= O.leak * a.p, `≤ ${O.leak}`),
        crit('vessel intact (wall cells)', b.walls, b.walls === w0, `${w0}`),
      ],
      evidence: [`inside: ${r2(a.p)} → ${r2(b.p)}; outside max ${r2(a.out)} → ${r2(b.out)}; walls ${w0} → ${b.walls}`],
      numbers: { p0: a.p, p1: b.p, keep, out: Math.max(a.out, b.out) },
    };
  },
};

export default [blastCrater, vessel];

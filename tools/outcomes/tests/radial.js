// Radial gravity outcomes (src/shaders/v2/columns.js RADIAL; TPT's radial gravity mode: Simulation.cpp
// GetGravityField, full strength toward the centre, and MovementPhase, a liquid stepping perpendicular to
// the pull). A spill on a planet spreads over it and rests as a lens whose surface is level: a sphere about
// the centre, not a plane. Engines without radial gravity (setGravity) cannot express it.
import { at, SetupError } from '../engine.js';
import { OUTCOMES, CELL_M } from '../thresholds.js';
import { liquidMass, mapText, advanceWatching, restNote, crit, r2, r3 } from '../lib.js';

const cm = (cells) => cells * CELL_M * 100;
const setup = (ok, what) => { if (!ok) throw new SetupError(what); };

// a 16³ planet at the box's centre; the water stands on its +y face, the cells y ≥ FACE over it
const PLANET = [8, 23], FACE = PLANET[1] + 1;

/** The water over the planet's +y face, a column at a time: its depth (cells) and the head at its surface
 * (cells: the surface's distance to the centre, the radial potential over g). */
export function faceColumns(g) {
  const c = [g.nx / 2, g.ny / 2, g.nz / 2], out = [];
  for (let z = PLANET[0]; z <= PLANET[1]; z++) for (let x = PLANET[0]; x <= PLANET[1]; x++) {
    let m = 0;
    for (let y = FACE; y < g.ny; y++) m += g.amount[at(g, x, y, z)];
    if (m > 0) out.push({ x, z, m, head: Math.hypot(x + 0.5 - c[0], FACE + m - c[1], z + 0.5 - c[2]) });
  }
  return out;
}

export const radialSpread = {
  name: 'radialSpread', group: 'radial', size: [32, 32, 32], needs: ['WALL', 'WATER'], cost: 60,
  title: 'under radial gravity a spill on a planet spreads into a lens level about the centre, then rests',
  audit: '7f9b2f1c: radial gravity had no columns, so a liquid that landed held still where it stood (columns.js, "liquids hold still under it")',
  expressible: (e) => (e.setGravity ? null : `${e.name} has no radial gravity`),
  async run(e) {
    const O = OUTCOMES.radialSpread, [lo, hi] = PLANET;
    await e.setGravity('radial');
    // a 2×2 tower 4 cells tall on the face's centre (16 cells): it stands on the planet, so nothing falls
    e.box([lo, lo, lo], [hi, hi, hi], 'WALL');
    e.box([15, FACE, 15], [16, FACE + 3, 16], 'WATER');
    let g = await e.read();
    const m0 = liquidMass(g), start = faceColumns(g).length;
    setup(m0 === 16 && start === 4, `start: ${m0} cells of water (16) over ${start} columns (4)`);
    const { idleAt, activity, resolution } = await advanceWatching(e, O.seconds, { every: 0.5 });
    g = await e.read();
    const m = liquidMass(g), cols = faceColumns(g), lens = cols.filter((c) => c.m >= O.minDepth);
    const onFace = cols.reduce((s, c) => s + c.m, 0);
    const heads = lens.map((c) => c.head), range = lens.length ? Math.max(...heads) - Math.min(...heads) : Infinity;
    const depth = (x, z) => cols.find((c) => c.x === x && c.z === z)?.m ?? 0;
    const map = mapText(hi - lo + 1, hi - lo + 1, (x, z) => { const d = depth(x + lo, z + lo); return d ? String(Math.min(9, Math.floor(d * 10))) : '.'; });
    return {
      headline: `${cols.length} wet columns (from ${start}), the ${lens.length} deeper than ${O.minDepth} level to ${r2(cm(range))} cm about the centre; ${idleAt === null ? `not idle (${activity.awake} of ${activity.units} units awake)` : `idle at ${r2(idleAt)} s`}`,
      criteria: [
        crit('spreads (wet columns)', cols.length, cols.length >= O.minWetColumns, `≥ ${O.minWetColumns}`, 'columns'),
        crit('level about the centre (head range)', r2(cm(range)), cm(range) <= O.levelCm, `≤ ${O.levelCm}`, 'cm'),
        crit('rests (certified idle)', idleAt === null ? 'never' : r2(idleAt), idleAt !== null && idleAt <= O.seconds, `≤ ${O.seconds}`, 's', restNote(resolution)),
        crit('stays on the planet', r3(m - onFace), Math.abs(m - onFace) < 1e-6, '0', 'cells'),
        crit('mass exact', r3(m - m0), Math.abs(m - m0) < 1e-6, '0', 'cells'),
      ],
      evidence: [`depth over the +y face at ${r2(e.time)} s (tenths of a cell, . dry):\n${map}`],
      numbers: { idleAt, wetColumns: cols.length, lensColumns: lens.length, headRange: range, massDrift: m - m0, awake: activity.awake },
    };
  },
};

export default [radialSpread];

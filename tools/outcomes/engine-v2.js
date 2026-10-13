// The outcome bench's engine on v2 (docs/v2.md 5, P2): a stub until P2 writes
// it. tools/harness/outcomes.html?engine=v2 and `node tools/outcomes.mjs
// --engine v2` load this module; P2's gate is `node tools/outcomes.mjs --engine
// v2 --strict --phase P2` on the Apple GPU (docs/v2.md 11 P2's exit: every
// week-0 outcome test of its phase passes).
//
// What P2 implements, against ./engine.js's contract, with engine-v1.js as the
// worked example:
//   createEngine(gpu, { seed }) → an engine named 'v2'
//   info        stepsPerSecond 60: a game second is 60 ticks, Speed 1× (5.1),
//               whatever Speed the box runs at, so a time limit means the same
//               on every run (at the proposed box 2×, 10 s would be 1,200
//               ticks: R12's AIR_PLOSS 0.9999 a tick alone would keep 0.887 of
//               a sealed vessel's pressure, under P4's 0.90; at 1× it keeps
//               0.942); clock says so ('60 ticks a game second (Speed 1×)');
//               gravity 19.6 (2 g); fillQuantum 2⁻¹⁶ (4.1: fill is a u24 with
//               1.0 = 2¹⁶); velocity true; pressure true from P4 (the air
//               grid), else false, and airCell 4 (R12's 4³ bricks); burning
//               true from 2d (R8's burning state)
//   id/nameOf   the bench's names on the migrated element rows (6.2): AIR,
//               WALL, SAND, FLOUR (today's DUST), STONE, WATER, MUD, OIL, WOOD,
//               FIRE, GUNPOWDER, C4, BRICK, SMOKE, ASH
//   box         through the same Cell API every writer uses (loadCell/storeCell,
//               5.2): a liquid gets fill 1.0; T in °C; v (m/s) sets a cell
//               moving the way a kick does (a particle for sideways speed, 5.3)
//   advance     whole ticks (an accumulator), each the full 5.4 tick
//   read        id per cell; amount = fill (u24 / 2¹⁶) plus every particle in
//               flight binned into the cell it is in (its fill share), so a
//               sum over cells is the exact liquid mass; vel: a liquid cell's
//               velocity from its face fluxes (the mean of its faces' flux over
//               its fill, m/s), a falling powder run's from R1; particles
//               listed with their positions, velocities (m/s) and masses; T;
//               burning from the burn stage; pressure from the air grid (P4)
//               as the excess over ambient, each brick's value in all its cells
//               (not interpolated: the vessel test needs a brick's air on one
//               side of a closed face to stay its own)
//   activity    AWAKE units of the D5 lists (5.6) and the idle certificate
//   fall        R1: s(age) on the column pass's curve, capped at the class's
//               run speed (vRun)
//   flight      R4 particles: ballistic under g with the row's quadratic drag
//               (terminal speed vt), so a throw is held to the law v2 declares
export function createEngine() {
  throw new Error('not built yet (docs/v2.md P2 writes tools/outcomes/engine-v2.js; its contract is in this file and ./engine.js)');
}

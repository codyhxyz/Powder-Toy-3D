// The outcome bench's numbers, in one table (tools/outcomes.mjs): every
// threshold a test holds an engine to, the game time it gets, and where each
// number comes from. docs/v2.md first; where it gives none, a design touchstone
// (CLAUDE.md) or the CPU prototype (tools/v2/lean-sim.mjs, whose World the
// bench runs as `--engine lean`, so these are the prototype's thresholds too).
// Times are game seconds on the engine's own clock (engine.info.stepsPerSecond:
// today's 240 steps a second; v2's 60 ticks, at Speed 1× whatever Speed the box
// runs at: engine-v2.js). "lean" in a comment is the
// prototype's number on its own scene (docs/v2/evidence/lean-sim.log); the
// bench's scenes are smaller (SwiftShader), and `--engine lean` measures the
// prototype on exactly the bench's scenes.

export const CELL_M = 0.3;   // docs/v2.md 2.1: the cell stays 0.30 m

// One tolerance for every resting liquid surface: 1 cm. docs/v2.md 4.4 asks a
// U-tube to equalise "within one quantum"; the unit brief reads that as 1 cm
// (Minecraft's flowing water steps by 1/8 block, 3.75 cm at this cell size: the
// bench asks a little better than a block game shows). The prototype sits on
// this bar: its own U-tube rests 2.1 cm apart (12.35 vs 12.28 cells), the
// bench's half-size one 0.99 cm (its dead band in compressed cells grows with
// depth: 0.4 cm with the left arm filled to 11, 1.3 cm to 15).
export const LEVEL_CM = 1;

// A 2-D footprint is round when its reach along the diagonals is within 15 %
// of its reach along the axes: docs/v2.md 11 P4's blast exit ("a blast's
// diagonal/axis ratio within 15 %"), the only roundness tolerance v2 states.
// lib.js roundness() reads it from the footprint's centroid with sub-cell rays
// and against the roundest footprint the lattice allows with as many cells, so a
// round footprint reads 1: squares read 1.18-1.41, diamonds 0.70-0.84.
export const ROUND_TOL = 0.15;

export const OUTCOMES = {
  // ---- liquids (docs/v2.md 4.4, 5.6) ----
  utube: {
    phase: 'P2',
    // lean: on its own 4×4-armed U-tube 2.1 cm apart and idle at 6.4 s; on the bench's half-size one
    // 0.99 cm apart and idle at 5.6 s
    seconds: 10,
    levelCm: LEVEL_CM,
  },
  partial: {
    phase: 'P2',
    // lean: flat to 0.02 cell, idle at 4.3 s on its 24×24 pool; 0.16 cm and 4.1 s on the bench's 14×14
    seconds: 8,
    levelCm: LEVEL_CM,
  },
  puddle: {
    phase: 'P2',
    // lean: a 6³ spill rests as a round puddle 2-3 cm deep at 14.5 s; the bench drops 2³ (8 cells), which
    // lean spreads 1.2 cm thin over 196 columns (radius ~8) of a 32×24 floor and rests at 4.1 s
    seconds: 6,
    wallGap: 1,   // cells: the puddle stops short of every wall (it has an edge)
  },
  radialSpread: {
    phase: 'P2',
    // the CPU witness (column-wgsl): the 16-cell tower spreads over 44 columns, the 32 deeper than a quarter
    // cell level to 0.03 cm about the centre, idle at 1.3 s
    seconds: 6,
    levelCm: LEVEL_CM,
    minDepth: 0.25,       // cells: a column this deep is lens, not the film at its rim (twice the dry tolerance)
    minWetColumns: 16,    // the tower's 2×2 footprint four times over
  },
  pipe: {
    phase: 'P2',
    // "a tank drains through a 30-cell pipe to the pipe's level" (docs/v2.md 4.4): the surface ends within
    // this many cells of the bore's top (3 cm). lean gets there at 44 s (its own 13-cell pipe from a 6×6 tank
    // 27 deep was still draining at 60 s: the bench's tank is 4×4, 14 deep). Its drain is viscous (the face
    // flux is damped): the level falls exponentially, so the tail is slow
    levelTol: 0.1,
    seconds: 60,
    // a tank with head over its pipe whose level hasn't moved for this long is clogged: the test ends there
    // (lean's level falls 0.2 cell or more every 3 s until it gets there)
    stall: 3,
  },
  hole: {
    phase: 'P3',   // docs/v2.md 11 P3's exit: "the hole jet lands within 5 % of the √(2gh) parabola at every head"
    // the stream's mass-weighted x on rows 6-8 (half way down), against x(y) = 2√(h·d) from the hole's outer
    // face with h the head when that water left the hole (Torricelli's speed √(2gh) on a parabola under the
    // same g, so the reach doesn't depend on g)
    reachTol: 0.05,
    // game seconds, from once the first water has had time to reach the floor (at 2 g the drop from the
    // hole takes 0.67 s, and the first parcels leave slow while the flow through the hole builds up) as the
    // head falls from ~13 to ~7 cells; each a window this long of consecutive steps (every step read, so a
    // stream that moves in parcels on alternate rows at alternate steps is seen on every row)
    checkpoints: [1.5, 2.5, 3.5],
    window: 0.25,
    // unbroken from the hole to the floor in this share of a window's reads (one stray read is not a break)
    unbroken: 0.9,
  },
  splash: {
    phase: 'P3',   // docs/v2.md 4.2 and 4.4 ("splash KE ≤ 0.3 × incoming"), P3's exit
    // a 4×4×2 block of water dropped 6 cells into a pool 3 deep: the kinetic energy of the liquid that the
    // impact sends up or sideways out of the pool (at or above its surface, not falling), at its peak over
    // `seconds` after contact, over the block's at contact
    keRatio: 0.3,
    seconds: 0.75,
  },
  yield: {
    phase: 'P2',
    // "slope rises with yield" (docs/v2.md 4.4): from a 4³ block, mud stands taller than water by more than
    // the bench's level tolerance, and water spreads to a layer or less. How tall mud stands is v2's dead band
    // (5.4: "rest and yield are one knob", re-tuned on the motion sheet in P3), not a number the bench can
    // derive: real mud (a Bingham plastic of tens of Pa, Coussot, Mudflow Rheology and Dynamics, 1997, which
    // today's MUD row cites) would hold a mound of only ~0.1 m (a third of a cell) from this block at 2 g;
    // a game mud that reads as mud from the god view is a game multiplier on that. No prototype number (lean
    // has one liquid).
    seconds: 5,
    tallerCm: LEVEL_CM,
    waterPeak: 1,
  },
  // ---- solids (docs/v2.md 5.3, 5.5 R1-R2) ----
  slab: {
    phase: 'P2',
    // a slab stays one layer and falls on the engine's own fall law (its g and run speed): within a cell or
    // 5 % of it at every checkpoint (lean: within 1 cell, one layer throughout)
    fallTol: 0.05,
  },
  heap: {
    phase: 'P2',
    grains: 432,   // exactly: the last layer of the pour is partial
    // R2's classes: drop 1 = 45° (free-flowing: sand's measured 34° quantised), drop 2 = 63° (cohesive: wheat
    // flour). Slope is peak / the radius of a disc of the footprint's area (lean-sim's own heap test reads
    // peak / axis reach: sand 0.89, flour 1.79)
    slope: { SAND: [0.7, 1.3], FLOUR: [1.4, 2.6] },
    // idle after the pour ends (lean: sand 1.55 s, flour 2.65 s on its own heaps; on the bench's, see
    // expected-lean.json), read every `every` s
    restSeconds: 2.5,
    every: 0.1,
  },
  throw: {
    phase: 'P2',
    // "a throw lands where it was aimed" (docs/v2.md 0): the lump's resting centre within a cell or 5 % of
    // its travel of where the engine's own ballistic law puts it, and every cell within 2 of the centre
    travel: 16,
    landTol: 0.05,
    spread: 2,
  },
  // ---- fire (docs/v2.md 5.5 R8) ----
  flameWood: {
    phase: 'P2',
    // "Two 1,000 °C flames now light a wooden block within a second or two" (R8). R8 makes ignition a
    // chance (flammability per second per flame) and FIRE short-lived (~0.5-1 s) and buoyant, so one trial
    // proves little: the scene is `trials` blocks in walled bays, each with its own two flames, and at least
    // `lit` of them must light within `seconds`. A design that lights 19 times in 20 passes 97 % of the time,
    // 9 in 10 89 %, a coin flip 11 %. TPT's touchstone: FIRE lives 120-169 frames and lights a neighbour
    // with chance Flammable/1000 a frame (WOOD's Flammable is 20: 2 % a frame per touching flame at 60 fps),
    // so two flames light wood within 2 s 99 % of the time
    seconds: 2,
    trials: 6,
    lit: 5,
  },
  // ---- blasts (docs/v2.md 5.5 R10, R12) ----
  blast: {
    phase: 'P2',   // P2's immediate damage makes "crisp craters"; P4's exit holds the 15 %
    seconds: 1,
    minReach: 2,   // cells: a crater at all
  },
  vessel: {
    phase: 'P4',   // docs/v2.md 11 P4's exit: "a sealed vessel keeps ≥ 90 % after 10 s"
    keep: 0.9,
    seconds: 10,
    // a sealed WALL vessel lets out nothing: the air outside stays within 1 % of the inside's excess
    leak: 0.01,
    // the vessel's shell lies on these cells' faces, with a whole one of free air outside it: an engine whose
    // air cell (engine.info.airCell, v2's 4³ bricks) doesn't divide it can't resolve the shell (n/a)
    airCell: 4,
  },
  // ---- the world (docs/v2.md 4.4 "a settled world with water in it certifies idle", 5.6) ----
  settledWorld: {
    phase: 'P2',
    // a generated world is already at rest when it loads (R2: generator slopes from the repose table): idle
    // within one 8-tick offset cycle plus its maps (5.6: 133 ms); 2 s of margin
    seconds: 2,
    url: '/?map=island&view=plain&win=64',
  },
  // ---- census (docs/v2.md 4.1 "mass is exact by construction", 12 risk 3) ----
  census: {
    phase: 'P2',
    seconds: 2,
    every: 0.1,
  },
  // ---- positive controls: scenes every engine handles, so a broken adapter can't pass for broken physics ----
  // lean: 3 full layers settle 0.024 cell low (its compression) and rest at 2.55 s
  tankStill: { phase: 'P2', seconds: 4, hidden: 0.05, every: 0.1 },
  sandFalls: { phase: 'P2', seconds: 1.5 },
  woodBurns: { phase: 'P2', seconds: 1 },
};

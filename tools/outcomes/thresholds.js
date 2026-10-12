// The outcome bench's numbers, in one table (tools/outcomes.mjs): every
// threshold a test holds an engine to, the game time it gets, and where each
// number comes from. docs/v2.md first; where it gives none, a design touchstone
// (CLAUDE.md) or the CPU prototype (tools/v2/lean-sim.mjs, whose World the
// bench runs as `--engine lean`, so these are the prototype's thresholds too).
// Times are game seconds on the engine's own clock (engine.info.stepsPerSecond:
// today's 240 steps a second, v2's 60 ticks). "lean" in a comment is the
// prototype's number on its own scene (docs/v2/evidence/lean-sim.log); the
// bench's scenes are smaller (SwiftShader), and `--engine lean` measures the
// prototype on exactly the bench's scenes.

export const CELL_M = 0.3;   // docs/v2.md 2.1: the cell stays 0.30 m

// One tolerance for every resting liquid surface: 1 cm. docs/v2.md 4.4 asks a
// U-tube to equalise "within one quantum"; the unit brief reads that as 1 cm
// (Minecraft's flowing water steps by 1/8 block, 3.75 cm at this cell size: the
// bench asks a little better than a block game shows). lean's U-tube rests
// 2.1 cm apart (12.35 vs 12.28 cells), so the prototype misses this bar as tuned.
export const LEVEL_CM = 1;

// A 2-D footprint is round when its reach along the diagonals is within 15 %
// of its reach along the axes: docs/v2.md 11 P4's blast exit ("a blast's
// diagonal/axis ratio within 15 %"), the only roundness tolerance v2 states.
// A square measures 1.41, a diamond 0.71; lean's heaps 1.02.
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
    // lean: flat to 0.02 cell, idle at 4.3 s (a 24×24 pool; the bench's is 14×14)
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
    // the stream's mean x half way down, against x(y) = 2√(h·d) from the hole's outer face (Torricelli's
    // speed √(2gh) on a parabola under the same g, so the reach doesn't depend on g)
    reachTol: 0.05,
    // game seconds, from once the first water has had time to reach the floor (at 2 g the drop from the
    // hole takes 0.67 s, and the first parcels leave slow while the flow through the hole builds up) as the
    // head falls from ~13 to ~7 cells
    checkpoints: [1.5, 2.5, 3.5],
  },
  yield: {
    phase: 'P2',
    // "slope rises with yield" (docs/v2.md 4.4); mud is a Bingham plastic with a yield stress of tens of Pa
    // (Coussot, Mudflow Rheology and Dynamics, 1997: what today's MUD row cites). A 4³ block of it holds a
    // mound at least this tall; water's spreads to a layer or less. No prototype number (lean has one liquid).
    seconds: 5,
    mudPeak: 2,
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
    grains: 432,
    // R2's classes: drop 1 = 45° (free-flowing: sand's measured 34° quantised), drop 2 = 63° (cohesive: wheat
    // flour). Slope is peak / axis reach (lean: sand 0.89, flour 1.79)
    slope: { SAND: [0.7, 1.3], FLOUR: [1.4, 2.6] },
    // idle after the pour ends (lean: sand 1.55 s, flour 2.65 s on its own heaps; 0.93 s and 1.57 s on the
    // bench's)
    restSeconds: 2.5,
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
    // "Two 1,000 °C flames now light a wooden block within a second or two" (R8). TPT's touchstone: WOOD's
    // Flammable 20 is a 20/1000 chance a frame per touching flame at 60 fps (Simulation.cpp), so ~0.8 s
    // for one flame, ~0.4 s for two
    seconds: 2,
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
  tankStill: { phase: 'P2', seconds: 4, hidden: 0.05 },
  sandFalls: { phase: 'P2', seconds: 1.5 },
  woodBurns: { phase: 'P2', seconds: 1 },
};

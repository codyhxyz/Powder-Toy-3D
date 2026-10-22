// The outcome bench's engine contract (tools/outcomes.mjs; docs/v2.md 2.10,
// 4.4 and 11 "Week 0"). A test asks only this of a simulation, so one test
// measures V1 (engine-v1.js, at the v1-oracle tag), the CPU prototype (engine-lean.js),
// the game at a URL (engine-app.js) and the V2 engine (engine-v2.js, written
// in P2) alike. Nothing here imports the game: this module loads in Node and
// in a page.
//
// An engine (every method that touches a GPU is async):
//   name                       'v1', 'lean', 'v2', 'app'
//   info                       { label, stepsPerSecond, clock (what a game second is on it, in words),
//                                gravity (m/s²), cellM (m), fillQuantum (cells: 1 for whole-cell liquids),
//                                velocity: bool (read() gives complete cell velocities), pressure: bool (it has an
//                                air pressure field), airCell (cells per side of its air grid's cell: 1 per
//                                cell, 4 for 4³ bricks), burning: bool (it marks burning fuel) }
//                              Partial particle/powder/air vectors do not establish resident-liquid kinetic
//                              energy and do not qualify as complete cell velocities.
//                              A game second is the engine's own, at the speed its tests are judged at:
//                              v2's is 60 ticks (Speed 1×) whatever Speed the box runs at (engine-v2.js),
//                              so every time limit means the same thing on every run
//   app                        true for the game at a URL (engine-app.js): app tests need it
//   id(name)                   the engine's id for a bench element name (ELEMENTS below), or null when
//                              it has no such element (the test is then not expressible: n/a)
//   nameOf(id), kindOf(id)     a bench name (or the engine's own) and 'air' | 'solid' | 'powder' |
//                              'liquid' | 'gas'
//   create([nx, ny, nz], { seed, url })
//                              a fresh box of air at ambient temperature; outside it is solid (a cell
//                              off the grid is a wall). Sides are multiples of SIZE_STEP. An app engine
//                              loads `url` instead (the game's own scene; size is ignored)
//   box(lo, hi, name, { T, v, onlyEmpty, pressure })
//                              every cell of the box [lo, hi] (inclusive grid cells) becomes `name`
//                              (full, for a liquid): T in °C (default: the element's own), v in m/s
//                              ([vx, vy, vz], default still), onlyEmpty: only cells that are air,
//                              pressure: the engine's units over ambient. Recorded in order
//   advance(seconds)           game time: the engine rounds it to its own steps or ticks, accumulated so
//                              repeated calls don't drift. `time` is the game seconds actually advanced
//                              (its steps / stepsPerSecond), `steps` its steps
//   read()                     the state as a Grid (below)
//   census()                   the mass census: { size, cells: { name: n }, classes: { air, solid, powder,
//                              liquid, gas }, liquid: { name: cells of liquid }, particles: { name: cells
//                              in flight } } (lib.js census of a read, or the app's own)
//   activity()                 { awake, units, idle, idleSince? }: units awake under the engine's sleep
//                              rules, of how many, and whether it certified the world idle (AWAKE = 0
//                              and nothing drawn: docs/webgpu.md D4); idleSince, game seconds, when known
//   fall(name, seconds)        cells a cell of `name` falls from rest in `seconds` under the engine's own
//                              declared law (its g, run or terminal speed, drag), or null
//   flight(name, [vx, vy], seconds)
//                              [dx, dy] cells a cell of `name` thrown at [vx, vy] cells/s flies in
//                              `seconds` under the engine's own declared law, or null when the engine
//                              has no thrown matter
//   setGravity(mode)           optional: 'vertical' (the default) or 'radial' (TPT's radial mode: full
//                              strength toward the box's centre). An engine without it cannot express a
//                              radial test (n/a)
//   park(), resume()           the game's loop (app engines); harness engines have none
//   dispose()
//
// A Grid: { nx, ny, nz, id (Int32Array), amount (Float32Array: liquid in cells, its fill, plus any
// particle in flight binned into the cell it is in), T (Float32Array °C) | null, burning (Uint8Array) |
// null, pressure (Float32Array, the engine's units over ambient: an air cell's value in every grid cell
// of it, not interpolated across its faces) | null, moving (Uint8Array: the cell carries a velocity) |
// null, vel (Float32Array, 3 a cell: its velocity in m/s, x, y, z) | null, particles: [{ x, y, z (cells),
// vx, vy, vz (m/s), mass (cells of liquid), id }] }, cell (x, y, z) at index x + nx·(z + nz·y) (at()).

// Every bench scene's sides are multiples of these (today's supertile is 16×8×8 cells: shaders/common.js
// SUPER_CELLS), so one scene runs on every engine.
export const SIZE_STEP = [16, 8, 8];

// The bench's element names. An engine maps each to its own id or to null; v1's DUST is wheat flour
// (elements.js: "Flour is cohesive"), the prototype's FLOUR.
export const ELEMENTS = ['AIR', 'WALL', 'SAND', 'FLOUR', 'STONE', 'WATER', 'MUD', 'OIL', 'WOOD', 'FIRE', 'GUNPOWDER', 'C4', 'BRICK', 'SMOKE', 'ASH'];

/** Index of cell (x, y, z) in a Grid's arrays. */
export const at = (g, x, y, z) => x + g.nx * (z + g.nz * y);

/** True when (x, y, z) is in the grid. */
export const inGrid = (g, x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < g.nx && y < g.ny && z < g.nz;

/** Thrown by a test's setup check: the scene isn't what the test meant, so its result says nothing. */
export class SetupError extends Error {}

/** Thrown when a test runs past its wall-clock budget. */
export class BudgetError extends Error {}

/**
 * A step accumulator: how many of its steps an engine runs to reach `time + seconds` (rounded once, at
 * the target, so many small advances don't drift).
 * @param {number} stepsPerSecond
 */
export function stepClock(stepsPerSecond) {
  let target = 0, steps = 0;
  return {
    get steps() { return steps; },
    get time() { return steps / stepsPerSecond; },
    /** steps to take now for `seconds` more */
    take(seconds) {
      target += seconds;
      const n = Math.max(0, Math.round(target * stepsPerSecond) - steps);
      steps += n;
      return n;
    },
    reset() { target = 0; steps = 0; },
  };
}

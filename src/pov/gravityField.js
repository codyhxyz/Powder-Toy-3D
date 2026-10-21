import { gravityAt } from '../v2/modes.js';
import { GRAV } from '../simModes.js';

// Which way first-person things fall: the world's own field, the one its matter falls along under
// both engines (simModes.js gravity mode; v2/modes.js gravityAt). That is straight down, or in TPT's
// radial mode toward the centre of the box (TPT Simulation.cpp GetGravityField: the full strength,
// pointed at the centre; on a big map the box is the window around the player, as for its matter).
// The body (player.js), the shots and throws (ballistics.js, frag.js), the wand bolts (wands/runtime.js)
// and the bots' aim (ai/brain.js) all read it here. Each keeps its own strength (Noita's for the body,
// 1 g for a round, a wand's own for a bolt): only the direction comes from the field. Straight down,
// each keeps its own y-only arithmetic, so normal gravity is bit for bit what it was.
//
// Positions are grid cells ({ x, y, z }), strengths cells/s².

// true when things fall toward the box's centre
export const radialGravity = (sim) => sim?.gravityMode === GRAV.RADIAL;

// the pull of `strength` at p: [0, −strength, 0], or under radial gravity toward the centre ([0, 0, 0]
// at the centre itself). A negative strength (a wand's anti-gravity) pushes the other way.
export function pullAt(sim, p, strength) {
  if (!radialGravity(sim)) return [0, -strength, 0];
  return gravityAt([p.x, p.y, p.z], [sim.g.nx, sim.g.ny, sim.g.nz], { gravMode: GRAV.RADIAL, gravity: strength });
}

// "up" at p, away from the pull (a unit { x, y, z }), into `out`; null where nothing pulls (the centre)
export function upAt(sim, p, out) {
  const [x, y, z] = pullAt(sim, p, -1);
  if (x === 0 && y === 0 && z === 0) return null;
  return out.set(x, y, z);
}

// One stretch of a fall, the pull at its start held over dt (a wand bolt's traced segment): to gains
// ½·a·dt², vel gains a·dt (THREE vectors, in place).
export function fallSegment(sim, at, strength, dt, to, vel) {
  if (!radialGravity(sim)) {
    to.y -= strength * dt * dt / 2;
    vel.y -= strength * dt;
    return;
  }
  const [x, y, z] = pullAt(sim, at, strength), k = dt * dt / 2;
  to.x += x * k; to.y += y * k; to.z += z * k;
  vel.x += x * dt; vel.y += y * dt; vel.z += z * dt;
}

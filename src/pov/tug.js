import { ELEMENTS } from '../elements.js';
import { CELL_M } from '../scale.js';

// One boot, one rope: what a shove or a pull between two masses does to each.
// It is momentum conservation for a pair driven together or apart at a set
// speed v along a line (the foot extending at its speed, the winch reeling at
// its own): the pair's momentum doesn't change, so each moves by
//   share_a = m_b / (m_a + m_b),  share_b = m_a / (m_a + m_b)   of v,
// the lighter one more. A world cell that is solid is anchored (no rigid
// bodies: solids never move), so its mass counts as infinite: all of v goes to
// the other one. That one rule is the kick's Newton's third law (kick a wall,
// you fly; kick a body, you both stagger) and the hook's "mass decides which
// way things move" (a wall reels you in, a clump of sand comes to you).
//
// A body standing on the ground is braced: the ground takes the sideways and
// downward part of what it is given, as it takes the gun's recoil
// (tools/firearm.js).

export const BODY_MASS_KG = 70;          // kg, a body (tools/firearm.js's player)
const KG_PER_DENS = 100;                 // kg/m³ per unit of elements.js dens (water 10 → 1000 kg/m³)

// kg in one cell of element id (a 30 cm cube of sand is 43 kg, of water 27 kg)
export const cellKg = (id) => (ELEMENTS[id]?.dens ?? 0) * KG_PER_DENS * CELL_M ** 3;

// [share of a, share of b] of the speed the pair is driven at
export function split(ma, mb) {
  if (!Number.isFinite(mb)) return [1, 0];
  if (!Number.isFinite(ma)) return [0, 1];
  const m = ma + mb;
  return m > 0 ? [mb / m, ma / m] : [0, 0];
}

// dv (Vector3) for a body: on the ground, only what lifts it is left
export function brace(dv, onGround) {
  if (onGround) dv.set(0, Math.max(dv.y, 0), 0);
  return dv;
}

import { HIT } from '../viewmodel.js';
import { gear } from './catalog.js';
import { firearm } from './firearm.js';

// Pistol: Garry's Mod's (Half-Life 2's USP Match, weapon_pistol.cpp). It fires
// as fast as you click, up to PISTOL_FASTEST_REFIRE_TIME's ten a second, and
// slower while held. Spamming it costs accuracy (firearm.js). Its round is a
// real 9 mm's speed and mass, and carries the energy the old SCRAP slug could
// (ballistics.js ROUND_ENERGY): it breaks glass, wood and the face of rock, and
// goes through a plank or two.

const DEG = Math.PI / 180;

export default firearm({
  ...gear('GUN'),
  round: {
    speed: 360,              // m/s, a subsonic 9 mm
    energy: 39,              // sim KE units (ROUND_ENERGY): above ROCK's 30, below METAL's 60
    depth: 8,                // cells its strike walks on past the face
    damage: 0.5,             // health a round takes from a body (an NPC): two kill
    mass: 0.008,             // kg, a 9 mm bullet (the recoil)
  },
  refire: 0.1,               // s between clicks (PISTOL_FASTEST_REFIRE_TIME)
  hold: 0.5,                 // s between shots while held (CWeaponPistol::GetFireRate)
  spread: {
    min: 1 * DEG,            // full cone angle, paced (VECTOR_CONE_1DEGREES)
    max: 6 * DEG,            // ...and spammed (VECTOR_CONE_6DEGREES)
    penalty: 0.2,            // s of inaccuracy per shot (PISTOL_ACCURACY_SHOT_PENALTY_TIME)
    penaltyMax: 1.5,         // s (PISTOL_ACCURACY_MAXIMUM_PENALTY_TIME)
  },
  hit: HIT.GUN,
  sound: { rate: 1, gain: 1, thump: 1 },
  // the held pistol, in cells (camera space: +x right, +y up, −z forward)
  pose: { pos: [0.45, -0.42, -1.3], muzzle: [0, 0.17, -0.4] },
});

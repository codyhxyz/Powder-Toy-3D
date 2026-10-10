import { HIT } from '../viewmodel.js';
import { gear } from './catalog.js';
import { firearm } from './firearm.js';

// SMG: Half-Life 2's SMG1 (weapon_smg1.cpp), the fast one. Hold to spray at
// its 0.075 s refire, about thirteen rounds a second. Each round is lighter
// than the pistol's: it breaks glass, ice and wood but not rock. Held, the
// spray opens up (firearm.js accuracy).

const DEG = Math.PI / 180;

export default firearm({
  ...gear('SMG'),
  round: {
    speed: 400,              // m/s, a 4.6 mm PDW round
    energy: 22,              // sim KE units: above WOOD's 20, below ROCK's 30
    depth: 4,                // cells its strike walks on past the face
    damage: 0.2,             // health a round takes from a body (an NPC): five kill
    mass: 0.003,             // kg (the recoil)
  },
  refire: 0.075,             // s between rounds (HL2 SMG1 GetFireRate)
  hold: true,
  spread: {
    min: 2 * DEG,            // full cone angle, first round
    max: 7 * DEG,            // ...after a long burst
    penalty: 0.1,            // s of inaccuracy per round
    penaltyMax: 1.2,         // s
  },
  hit: HIT.SMG,
  sound: { rate: 1.25, gain: 0.7, thump: 0.5 },
  // the held SMG, in cells (camera space)
  pose: { pos: [0.5, -0.45, -1.5], muzzle: [0, 0.094, -0.625] },
});

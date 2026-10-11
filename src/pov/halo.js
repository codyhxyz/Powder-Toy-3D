import { CELL_M } from '../scale.js';
import { povEvents } from './events.js';

// Halo 3's combat numbers, shared by the frag grenade (frag.js), the melee
// (kick.js in a Halo match), the reticle (combat.js) and the bots (ai/brain.js),
// and whether a Halo-style match is on (docs/halo-contract.md: game:spawn
// carries the match's style, game:stop ends it).
//
// Units: Halo's damage points against this game's health. A body's health is
// 1 base life (vitals.js); Halo 3's Spartan has 45 health under 70 shield
// (Halopedia, "Energy shielding"; perks.js SHIELD_STACK is the same 70 / 45), so
// one base life is 45 points. Halo's distances are world units (wu): Halopedia,
// "World unit": 1 wu = 10 ft.

export const HALO_HEALTH = 45;                 // points of health in one base life (Halo 3's Spartan)
export const HALO_SHIELD = 70;                 // points of shield (one Energy Shield stack, perks.js)
export const WU_M = 3.048;                     // m per Halo world unit (10 ft)
export const wu = (n) => n * WU_M / CELL_M;    // Halo world units → grid cells
export const points = (p) => p / HALO_HEALTH;  // Halo damage points → base lives (vitals.js hurt units)

// Damage causes (body.cause → game:kill cause): the feel agent's medals read these
export const CAUSE = {
  MELEE: 'melee',                 // a Halo melee from the front (Halo 3's Beat Down medal)
  ASSASSINATION: 'assassination', // a Halo melee from behind (the Assassin medal)
  GRENADE: 'grenade',             // a frag grenade's shrapnel
};

// The match's style while one runs ('halo' | 'tf2'), from the game's own events
let style = null;
povEvents.on('game:spawn', (e) => { style = e.style ?? null; });
povEvents.on('game:stop', () => { style = null; });
export const haloMatch = () => style === 'halo';

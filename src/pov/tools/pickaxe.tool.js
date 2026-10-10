import { pickaxeFrag, PICK } from '../../shaders/povTools.js';
import { HIT } from '../viewmodel.js';
import { meleeTool } from './melee.js';

// Pickaxe: the axe's swing (melee.js) with a heavier, pointed head: a slower
// blow with more energy in a narrower, deeper patch (shaders/povTools.js PICK),
// so it bites into rock, about a 3×3 face two cells deep a swing, where the
// axe bounces off. Still bounces off metal. The rock breaks into STONE in
// place; the shovel picks it up.

const REFIRE = 0.6;          // s between swings: a heavier head than the axe's

export default meleeTool({
  key: 'PICKAXE', name: 'Pickaxe', slot: 10, model: 'pickaxe',
  desc: 'Mines rock into stone and breaks anything the axe can. Too weak for metal.',
  blow: PICK, frag: pickaxeFrag, hit: HIT.PICK, refire: REFIRE,
  body: {
    damage: 0.4,             // health a blow takes from a body (an NPC): three blows kill
    energy: 50,              // the impact's energy for the shake and hitmarker
    cause: 'Picked apart',
  },
  // the held pickaxe, in cells (camera space: +x right, +y up, −z forward); the
  // model's origin is the end of the handle, in the hand
  pose: {
    pos: [0.7, -0.95, -1.55],
    rest: 0.45,              // rad, raised a little higher than the axe for the heavier blow
    hit: -0.6,               // rad, point down where it bit in
    miss: -1.25,             // rad, point down past the aim: a miss follows through
    roll: -0.25,             // rad, tilted in toward the crosshair
    strike: 0.08,            // s for the head to come down (the blow itself lands at once)
  },
});

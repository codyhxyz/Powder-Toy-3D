import { axeFrag, AXE } from '../../shaders/povTools.js';
import { HIT } from '../viewmodel.js';
import { meleeTool } from './melee.js';
import { gear } from './catalog.js';

// Axe: a short-range swing that breaks breakable solids in a wide, shallow
// patch around the struck cell into their debris (shaders/povTools.js AXE for
// the energy and tuning; melee.js for the swing, shared with the pickaxe).
// Weaker and less focused than the gun: it chops wood where it lands, smashes
// glass, ice and plants around that, and bounces off rock and metal.

const REFIRE = 0.4;          // s between swings (HL2 CROWBAR_REFIRE)

export default meleeTool({
  ...gear('AXE'),
  blow: AXE, frag: axeFrag, hit: HIT.AXE, refire: REFIRE,
  body: {
    damage: 0.34,            // health a blow takes from a body (an NPC): three blows kill
    energy: 40,              // the impact's energy for the shake and hitmarker
    cause: 'Axed',
  },
  // the held axe, in cells (camera space: +x right, +y up, −z forward); the
  // model's origin is the end of the handle, in the hand
  pose: {
    pos: [0.7, -0.95, -1.55],
    rest: 0.35,              // rad, held up and back
    hit: -0.55,              // rad, blade down where it bit into something
    miss: -1.15,             // rad, blade down past the aim: a miss follows through
    roll: -0.25,             // rad, tilted in toward the crosshair
    strike: 0.06,            // s for the blade to come down (the blow itself lands at once)
  },
});

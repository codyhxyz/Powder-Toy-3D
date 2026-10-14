import { pickaxeFrag, PICK } from '../../shaders/povTools.js';
import { HIT } from '../viewmodel.js';
import { meleeTool } from './melee.js';
import { gear } from './catalog.js';

// Pickaxe: the axe's swing (melee.js) with a heavier, pointed head, that digs
// like Minecraft's pickaxe (dig.js): every blow lands on the outlined 0.9 m
// block you aim at, and a block it has beaten comes up whole, rock as STONE,
// into the pack, leaving a clean, square hole. POWER is the hardness one blow
// beats: rock and every softer breakable solid in one blow; wood it leaves to
// the axe (a toast says so). It never digs a
// solid harder than its blow's energy (PICK.ENERGY 52): metal (60) still
// rings off it, as before.

const REFIRE = 0.4;          // s between blows: Half-Life 2's crowbar (weapon_crowbar.h CROWBAR_REFIRE); was 0.6
const TOOLS = ['pickaxe', 'shovel'];   // the elements it digs (elements.js tool): its own and loose ground, never wood (the axe's, as in Minecraft)
const POWER = 30;            // hardness one blow beats: ROCK's 30, the hardest rock a world is made of

export default meleeTool({
  ...gear('PICKAXE'),
  blow: PICK, frag: pickaxeFrag, hit: HIT.PICK, refire: REFIRE, dig: { power: POWER, tools: TOOLS },
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

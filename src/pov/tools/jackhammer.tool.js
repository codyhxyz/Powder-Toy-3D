import { pickaxeFrag, PICK } from '../../shaders/povTools.js';
import { meleeTool } from './melee.js';
import { gear } from './catalog.js';

// Rust's jackhammer: hold for rapid powered mining, not an axe swing. Reuse
// the pick's outlined lattice mining (52 energy beats ROCK 30, never METAL
// 60). Every cell comes up as its debris; a full pack leaves the rock intact.
export const REFIRE = 0.1;   // s: ten short piston strokes a second (Rust-inspired)
export default meleeTool({
  ...gear('JACKHAMMER'),
  blow: PICK, frag: pickaxeFrag, hit: { kick: 0.025 }, refire: REFIRE,
  dig: { power: 30, tools: ['pickaxe', 'shovel'] },
  buffer: false,            // release stops mining, including a tap during cooldown
  reach: 5,                // cells (1.5 m): close enough to press the bit into the face
  body: { damage: 0.06, energy: 12, cause: 'Jackhammered' },
  pose: {
    pos: [1, -0.15, -3.2], rest: 0, hit: 0, miss: 0, roll: 0,
    thrust: [0.07, 0.04], thrustAxis: [0, -1, 0], strike: 0.025, gesture: 'drill',
  },
});

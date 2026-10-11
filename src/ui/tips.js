// The loading screen's tips (ui/menu.js), TF2's: one at a time in a box with
// an icon, said flatly. Every one is true of the game as it is; the comment
// after each says where. Change the code, check its tip.
// Loaded on its own when the menu opens (with its icons, ui/tipicons.js), so
// the menu's first paint doesn't wait for it.
//   icon   a ui/tipicons.js key
export { TIPICONS, TIPICON_BOX, TIPICON_CREDIT } from './tipicons.js';

export const TIPS = [
  // pov/tools/bucket.tool.js header; the temperature rides along (shaders/transfer.js)
  { icon: 'bucket', text: 'A bucket keeps what it scoops at the temperature it was scooped. Lava stays hot.' },
  // elements.js CLONE; shaders/react.js locks in the first element it copies
  { icon: 'clone', text: 'Clone copies the first thing that touches it. Forever.' },
  // elements.js densities: water 10, snow 9, oil 8, ash 4 (shaders/move.js swaps by density)
  { icon: 'snow', text: 'Snow and ash float on water. So does oil.' },
  // pov/ballistics.js: 360 m/s at 1 g over a 128-cell box (38 m, scale.js): 0.11 s, 5.6 cm
  { icon: 'round', text: 'A pistol round crosses a 128-cell box in a tenth of a second. It drops about 6 cm on the way.' },
  // pov/tools/shovel.tool.js, shaders/transfer.js
  { icon: 'shovel', text: 'The shovel keeps what it digs at the temperature it was dug. Dig hot sand, throw hot sand.' },
  // app.js keys: V is Garry's Mod's noclip key
  { icon: 'noclip', text: 'V drops you into the world, and takes you back out.' },
  // pov/kick.js KICK_KEY
  { icon: 'kick', text: 'In first person, F kicks.' },
  // pov/tools/flask.tool.js (you start with water, DRINK_KEY); pov/ingest.js (lava kills from a sip)
  { icon: 'flask', text: 'You start with a flask of water. H drinks from it. Do not drink lava: one sip is enough.' },
  // pov/ballistics.js: a round's flight time advances only while the sim runs
  { icon: 'pause', text: 'Pausing the simulation freezes bullets in mid-air.' },
  // pov/perks.js SHRINE_OFFERS; world/structures.js puts one near every world's start
  { icon: 'shrine', text: 'A shrine offers three perks. Take one and the other two vanish. Every world has one near the start.' },
  // pov/perks.js: a body loses its perks when it dies, unless Extra Life brings it back
  { icon: 'life', text: 'Die and you lose your perks, unless you took Extra Life.' },
  // pov/worm.js: it hunts a body near it, else goes to the last loud noise
  { icon: 'worm', text: 'Worms go to the last loud noise they heard. A gunshot counts.' },
  // shaders/react.js: lava keeps the element it melted from and sets back into it
  { icon: 'metal', text: 'Melt metal, let it cool, and you get metal back. Lava remembers what it was.' },
  // physics.js, shaders/react.js: steam cooling in open air turns to cloud, and thick cloud rains
  { icon: 'cloud', text: 'Steam that cools in open air turns to cloud. Thick cloud rains.' },
  // pov/descent/index.js: the temple heals you to full, once a visit
  { icon: 'temple', text: 'In Descent, the Holy Mountain heals you to full, once a visit.' },
  // pov/tools/knife.tool.js: TF2's backstab test, through any shield
  { icon: 'backstab', text: 'The knife kills in one stab from behind, shield or not. From the front it barely scratches.' },
  // scale.js CELL_M; pov/constants.js BODY_HEIGHT
  { icon: 'metres', text: 'One cell is 30 cm. You are 5.5 cells tall.' },
  // pov/perks.js FIRE_IMMUNITY; lava (25) is denser than you (pov/constants.js BODY_DENS 9.8)
  { icon: 'lava', text: 'You are lighter than lava. With Fire Immunity, you can float on it.' },
  // pov/constants.js BODY_DENS: 9.8 to water's 10
  { icon: 'float', text: 'You are a little lighter than water. You float, barely.' },
  // pov/vehicles/hoverbike.js: it skims a lake as it does a road, and never flips
  { icon: 'hoverbike', text: 'The hoverbike skims water and cannot flip. E gets you on and off.' },
];

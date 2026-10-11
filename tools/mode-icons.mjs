// The start menu's icons, baked from game-icons.net by tools/game-icons.mjs.
// One flat shape each, drawn in one colour. Rerun after changing either set.
//   src/ui/modeicons.js   one per gamemode (maps.js GAMEMODES), big in the
//                         gamemode's title, small in the list down the left and
//                         on the loading screen, as Halo 3's lobby shows a
//                         gametype by its icon; and a map's kind and size
//   src/ui/tipicons.js    the loading screen's tips (ui/tips.js), one icon each,
//                         as TF2's loading tips carry their class's; loaded only
//                         with the tips, so the menu stays small
// usage: node tools/mode-icons.mjs
import { bakeIcons } from './game-icons.mjs';

// icon key → '<author>/<name>' in the repo
const MODE_ICONS = {
  // the gamemodes (maps.js GAMEMODES keys)
  sandbox: 'delapouite/sand-castle',
  slayer: 'lorc/crossed-swords',
  ctf: 'lorc/flying-flag',
  koth: 'lorc/crown',                  // Halo's King of the Hill is a crown too
  infection: 'skoll/raise-zombie',
  siege: 'delapouite/siege-tower',
  // a map's kind and size
  box: 'delapouite/cube',
  world: 'lorc/world',
  cells: 'lorc/cubeforce',
  metres: 'delapouite/measure-tape',
};

// ui/tips.js icon keys
const TIP_ICONS = {
  tip: 'lorc/light-bulb',
  bucket: 'delapouite/full-metal-bucket',
  clone: 'lorc/cubes',
  snow: 'lorc/snowflake-2',
  round: 'lorc/bullets',
  shovel: 'skoll/trench-spade',
  noclip: 'lorc/boot-prints',
  kick: 'lorc/boot-kick',
  flask: 'lorc/round-bottom-flask',
  pause: 'lorc/hourglass',
  shrine: 'delapouite/crystal-shrine',
  life: 'lorc/heart-organ',
  worm: 'lorc/worm-mouth',
  metal: 'lorc/anvil',
  cloud: 'lorc/raining',
  temple: 'delapouite/water-fountain',
  backstab: 'lorc/backstab',
  metres: 'delapouite/measure-tape',
  lava: 'carl-olsen/flame',
  float: 'delapouite/life-buoy',
  hoverbike: 'delapouite/aero-bike',
};

await bakeIcons({ icons: MODE_ICONS, out: 'src/ui/modeicons.js', prefix: 'MODEICON', what: 'Gamemode and map icons', script: 'tools/mode-icons.mjs' });
await bakeIcons({ icons: TIP_ICONS, out: 'src/ui/tipicons.js', prefix: 'TIPICON', what: 'Tip icons', script: 'tools/mode-icons.mjs' });

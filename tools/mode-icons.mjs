// The start menu's icons, baked from game-icons.net by tools/game-icons.mjs.
// One flat shape each, drawn in one colour. Rerun after changing the set.
//   src/ui/modeicons.js   one per gamemode (maps.js GAMEMODES), big in the
//                         gamemode's title and small in the list down the left,
//                         as Halo 3's lobby shows a gametype by its icon; and a
//                         map's kind
// usage: node tools/mode-icons.mjs
import { bakeIcons } from './game-icons.mjs';

// icon key → '<author>/<name>' in the repo
const MODE_ICONS = {
  // the gamemodes (maps.js GAMEMODES keys)
  sandbox: 'delapouite/sand-castle',
  factory: 'delapouite/factory',       // the quarry's sorting and smelting production line
  crueltySquad: 'lorc/on-target',      // Cruelty Squad's designated assassination targets
  noita: 'lorc/fairy-wand',            // the killfeed's wand (tools/killicons.mjs WAND)
  animalCrossing: 'lorc/three-leaves',  // Animal Crossing's leaf motif for village life
  slayer: 'lorc/crossed-swords',
  ctf: 'lorc/flying-flag',
  koth: 'lorc/crown',                  // Halo's King of the Hill is a crown too
  infection: 'skoll/raise-zombie',
  siege: 'delapouite/siege-tower',
  saves: 'delapouite/save',            // the menu's Saves (Your games)
  // a map's kind
  box: 'delapouite/cube',
  world: 'lorc/world',
};

await bakeIcons({ icons: MODE_ICONS, out: 'src/ui/modeicons.js', prefix: 'MODEICON', what: 'Gamemode and map icons', script: 'tools/mode-icons.mjs' });

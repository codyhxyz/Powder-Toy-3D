// The killfeed's icons (src/pov/killicons.js), baked from game-icons.net by
// tools/game-icons.mjs. They stand in for Half-Life 2's kill icon font, which is
// Valve's and can't be copied; like it they are one flat shape each, which the
// killfeed draws in GMod's kill-icon orange. Rerun after changing ICONS.
// usage: node tools/killicons.mjs
import { bakeIcons } from './game-icons.mjs';

// icon key (a tool key from tools/catalog.js, or a kind of death) → '<author>/<name>' in the repo
const ICONS = {
  default: 'lorc/skull-crossed-bones',   // GMod's 'default' kill icon is a skull: suicides and unknown deaths
  // the tools (catalog.js keys)
  SHOVEL: 'skoll/trench-spade',
  PICKAXE: 'delapouite/war-pick',
  AXE: 'lorc/wood-axe',
  KNIFE: 'skoll/butterfly-knife',   // the Spy's knife (TF2)
  TROWEL: 'delapouite/trowel',
  BUCKET: 'delapouite/full-metal-bucket',
  FLASK: 'lorc/round-bottom-flask',
  GUN: 'skoll/glock',
  SMG: 'skoll/mp5k',
  SNIPER: 'skoll/lee-enfield',
  LASER: 'lorc/ray-gun',
  BOMB: 'lorc/unlit-bomb',
  ROCKET: 'lorc/rocket',
  BURROWER: 'delapouite/drill',
  PHYSGUN: 'lorc/magnet',
  BLOWTORCH: 'delapouite/flamethrower',
  POGO: 'delapouite/bouncing-spring',
  TORCH: 'delapouite/torch',
  LANTERN: 'lorc/lantern-flame',
  HOOK: 'lorc/grapple',
  WAND: 'lorc/fairy-wand',
  // blows that aren't a held tool
  backstab: 'lorc/backstab',
  kick: 'lorc/boot-kick',
  worm: 'lorc/worm-mouth',
  jeep: 'skoll/jeep',
  hoverbike: 'delapouite/aero-bike',
  shot: 'lorc/bullets',
  // the world's
  explosion: 'lorc/bright-explosion',
  fire: 'carl-olsen/flame',
  lava: 'sbed/lava',
  acid: 'sbed/acid',
  cold: 'lorc/snowflake-2',
  drowned: 'lorc/drowning',
  buried: 'lorc/tombstone',
  fall: 'sbed/falling',
  impact: 'lorc/impact-point',
  shock: 'sbed/electric',
  poison: 'lorc/poison-gas',
};

await bakeIcons({ icons: ICONS, out: 'src/pov/killicons.js', prefix: 'KILLICON', what: 'Kill icons', script: 'tools/killicons.mjs' });

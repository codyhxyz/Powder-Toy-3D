// The medals' icons (src/game/medalIcons.js), baked from game-icons.net by
// tools/game-icons.mjs. Halo 3's medal art is Bungie's and can't ship; each of
// our badges (src/game/medalBadge.js) is a hex or a disc in its kind's colours
// with one of these silhouettes in it. Rerun after changing ICONS.
// usage: node tools/medal-icons.mjs
import { bakeIcons } from './game-icons.mjs';
import { MEDALS } from '../src/game/medals.js';

// icon key → '<author>/<name>' in the repo. Keys are medals.js MEDALS keys, but
// 'multi': Halo 3's multi-kills share one icon and the badge counts the kills
// in stars round it.
const ICONS = {
  multi: 'lorc/sword-clash',
  // sprees
  KILLING_SPREE: 'sbed/death-skull',
  KILLING_FRENZY: 'lorc/fanged-skull',
  RUNNING_RIOT: 'lorc/run',
  RAMPAGE: 'lorc/daemon-skull',
  UNTOUCHABLE: 'lorc/bolt-shield',
  INVINCIBLE: 'lorc/crowned-skull',
  INFECTION_SPREE: 'delapouite/shambling-zombie',
  MMM_BRAINS: 'lorc/brain',
  ZOMBIE_KILLING_SPREE: 'lorc/broken-skull',
  HELLS_JANITOR: 'delapouite/broom',
  SNIPER_SPREE: 'skoll/bullseye',
  SHARPSHOOTER: 'delapouite/crosshair',
  SPLATTER_SPREE: 'delapouite/car-wheel',
  VEHICULAR_MANSLAUGHTER: 'delapouite/jeep',
  // how the kill was made
  KILLJOY: 'delapouite/party-popper',
  BEAT_DOWN: 'lorc/punch-blast',
  ASSASSIN: 'lorc/cloak-dagger',
  GRENADE_STICK: 'delapouite/sticky-boot',   // stuck fast
  GRENADE_KILL: 'lorc/grenade',
  SPLATTER: 'lorc/splurt',
  SNIPER_KILL: 'lorc/arrow-scope',
  LASER_KILL: 'lorc/laser-precision',
  INCINERATION: 'lorc/fire-silhouette',
  DEATH_FROM_THE_GRAVE: 'skoll/raise-zombie',
  FIRST_STRIKE: 'delapouite/podium-winner',
  EXTERMINATION: 'lorc/triple-skulls',
  PERFECTION: 'lorc/laurel-crown',
  // the objectives
  LAST_MAN_STANDING: 'delapouite/person',
  FLAG_SCORE: 'lorc/flying-flag',
  KILLED_FLAG_CARRIER: 'lorc/black-flag',
  FLAG_KILL: 'delapouite/flag-objective',
  FLAG_RETURNED: 'lorc/return-arrow',
  HAIL_TO_THE_KING: 'delapouite/throne-king',
  // the sim's (ours)
  OWN_GOAL: 'delapouite/boomerang',   // your own blast, come back
  BORED: 'lorc/drill',
  CHAIN_REACTION: 'lorc/crossed-chains',
  HEAVY_PARTICLES: 'lorc/quicksand',
  FLOODED: 'lorc/big-wave',
};

const missing = Object.keys(MEDALS).filter((k) => MEDALS[k].kind !== 'multi' && !ICONS[k]);
if (missing.length) throw new Error(`no icon for ${missing.join(', ')}`);
await bakeIcons({ icons: ICONS, out: 'src/game/medalIcons.js', prefix: 'MEDALICON', what: 'Medal icons', script: 'tools/medal-icons.mjs' });

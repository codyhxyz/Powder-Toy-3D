// The medals' icons (src/pov/medalicons.js), baked from game-icons.net by
// tools/game-icons.mjs. Halo 3's medal art is Bungie's and can't ship; each of
// our badges (src/pov/medalbadge.js) is a hex or a disc in a Halo-like colour
// family with one of these silhouettes in it. Rerun after changing ICONS.
// usage: node tools/medal-icons.mjs
import { bakeIcons } from './game-icons.mjs';

// icon key (src/pov/medaldefs.js MEDALS[key].icon) → '<author>/<name>' in the repo
const ICONS = {
  // Halo 3's multi-kills share one icon; the badge counts the kills in stars round it
  multikill: 'lorc/sword-clash',
  // the sprees
  killingSpree: 'sbed/death-skull',
  killingFrenzy: 'lorc/fanged-skull',
  runningRiot: 'lorc/run',
  rampage: 'lorc/daemon-skull',
  untouchable: 'lorc/bolt-shield',
  invincible: 'lorc/crowned-skull',
  sniperSpree: 'skoll/bullseye',
  sharpshooter: 'delapouite/crosshair',
  splatterSpree: 'delapouite/car-wheel',
  vehicularManslaughter: 'delapouite/jeep',
  // how the kill was made
  splatter: 'lorc/splurt',
  incineration: 'lorc/fire-silhouette',
  assassin: 'lorc/cloak-dagger',
  beatDown: 'lorc/punch-blast',
  sniperKill: 'lorc/arrow-scope',
  laserKill: 'lorc/laser-precision',
  killjoy: 'delapouite/party-popper',
  deathFromTheGrave: 'skoll/raise-zombie',
  // the match
  flagScore: 'lorc/flying-flag',
  killedFlagCarrier: 'lorc/black-flag',
  perfection: 'lorc/laurel-crown',
  infectionSpree: 'delapouite/shambling-zombie',
  mmmBrains: 'lorc/brain',
  zombieKillingSpree: 'lorc/broken-skull',
  hellsJanitor: 'delapouite/broom',
  lastManStanding: 'delapouite/person',
  // the sim's (ours)
  ownGoal: 'delapouite/boomerang',   // your own blast, come back
  bored: 'lorc/drill',
  chainReaction: 'lorc/crossed-chains',
  heavyParticles: 'lorc/quicksand',
  flooded: 'lorc/big-wave',
};

await bakeIcons({ icons: ICONS, out: 'src/pov/medalicons.js', prefix: 'MEDALICON', what: 'Medal icons', script: 'tools/medal-icons.mjs' });

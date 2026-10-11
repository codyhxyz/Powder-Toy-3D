// The medals: Halo 3's, with its names and numbers, and a few of our own for
// what the sim does (medals.js awards them, medalbadge.js draws them,
// announcer.js says them). Pure data, so node tools can read it
// (tools/announcer-lines.mjs).
//
// Halo 3's rules are from Halopedia's "List of Halo 3 and Halo 3: ODST medals"
// (https://www.halopedia.org/List_of_Halo_3_and_Halo_3:_ODST_medals). The
// medal art is Bungie's and isn't copied: our badges are drawn shapes in
// colour families with a game-icons.net silhouette (medalicons.js).

// ---- Halo 3's numbers
export const MULTIKILL_S = 4;         // s: each kill of a multi-kill comes within this of the one before (Halo 3 multiplayer)
export const SPREE_STEP = 5;          // kills without dying between two spree medals: 5, 10, ... 30 (Killing Spree ... Invincible)
export const WEAPON_SPREE = [5, 10];  // kills with one weapon in one life: Sniper Spree / Sharpshooter, Splatter Spree / Vehicular Manslaughter
export const ZOMBIE_SPREE = [5, 10];  // Infection: 5 / 10 infections in one life (Infection Spree / Mmmm... Brains), or zombie kills without dying (Zombie Killing Spree / Hell's Janitor)
export const KILLJOY_SPREE = SPREE_STEP;  // Killjoy: end an opponent's killing spree, which starts at 5 kills
export const PERFECTION_KILLS = 15;   // Perfection: win a Slayer game with 15 or more kills and no deaths

// ---- ours
// Chain Reaction: a blast of yours, then at least CHAIN_BLASTS − 1 more set off
// by something else (a vehicle going up, a Revenge perk, an NPC's charge), each
// within CHAIN_GAP_S of the one before. Only blasts on povEvents count: a bomb,
// a rocket, a vehicle, a Revenge. The sim's own explosions (TNT, gunpowder) don't
// announce themselves, so three is already a big chain.
export const CHAIN_BLASTS = 3;
export const CHAIN_GAP_S = 1;         // s between two links of a chain: a vehicle blows the instant its health runs out

// ---- colour families: Halo 3 tells its medals apart by colour; these are ours, in
// its spirit. multikill/spree/style keep the mockup's gradients (light → dark).
// shape 'hex' (flat-topped) or 'round'; rim the outer ring's dark; mark the stars' and pips' colour
export const MEDAL_FAMILIES = {
  multikill: { shape: 'round', light: '#ff8576', dark: '#9c1220', rim: '#43060c', mark: '#ffd9d6' },   // Halo 3's multi-kills: pale stars on a red disc
  spree: { shape: 'hex', light: '#ffbf5a', dark: '#cc420a', rim: '#561b02', mark: '#fff1d6' },
  style: { shape: 'hex', light: '#7fd0ff', dark: '#1a5cb5', rim: '#0a2550', mark: '#e3f6ff' },
  objective: { shape: 'round', light: '#d9b8ff', dark: '#6a32c4', rim: '#26104f', mark: '#f1e6ff' },
  infection: { shape: 'hex', light: '#dcf77e', dark: '#5f9a14', rim: '#213804', mark: '#f6ffd9' },
  chaos: { shape: 'hex', light: '#ff9fe0', dark: '#b8207f', rim: '#470931', mark: '#ffe3f5' },   // the sim's: ours, not Halo's
};

// key → { name (shown and spoken), family, icon (medalicons.js), rule, stars? (a multi-kill's count),
// quiet? (no announcer line of its own) }. The order here is the order a
// kill's medals pop in (medals.js).
export const MEDALS = {
  // how the kill was made (Halo 3)
  assassin: { name: 'Assassin', family: 'style', icon: 'assassin', rule: 'A backstab (Halo 3: a melee kill from behind)' },
  beatDown: { name: 'Beat Down', family: 'style', icon: 'beatDown', rule: 'A melee kill: axe, knife, pickaxe or kick' },
  splatter: { name: 'Splatter', family: 'style', icon: 'splatter', rule: 'Run someone over' },
  incineration: { name: 'Incineration', family: 'style', icon: 'incineration', rule: 'A blowtorch kill (Halo 3: Flamethrower or Firebomb)' },
  sniperKill: { name: 'Sniper Kill', family: 'style', icon: 'sniperKill', rule: 'A sniper rifle kill (Halo 3 asks for a headshot; our bodies have no head hitbox)' },
  laserKill: { name: 'Laser Kill', family: 'style', icon: 'laserKill', rule: 'A laser cannon kill (Halo 3: the Spartan Laser)' },
  killjoy: { name: 'Killjoy', family: 'style', icon: 'killjoy', rule: `Kill someone on a killing spree (${KILLJOY_SPREE}+ kills without dying)` },
  deathFromTheGrave: { name: 'Death from the Grave', family: 'style', icon: 'deathFromTheGrave', rule: 'Kill someone after you have died' },
  // the sim's (ours)
  bored: { name: 'Bored', family: 'chaos', icon: 'bored', rule: 'A burrower kill' },
  heavyParticles: { name: 'Heavy Particles', family: 'chaos', icon: 'heavyParticles', rule: 'Bury someone with your kill credit (The Powder Toy calls sand "heavy particles")' },
  flooded: { name: 'Flooded', family: 'chaos', icon: 'flooded', rule: 'Someone drowns with your kill credit' },
  ownGoal: { name: 'Own Goal', family: 'chaos', icon: 'ownGoal', rule: 'Killed by your own blast' },
  chainReaction: { name: 'Chain Reaction', family: 'chaos', icon: 'chainReaction', rule: `Your blast, then ${CHAIN_BLASTS - 1}+ more set off by something else, each within ${CHAIN_GAP_S} s` },
  // multi-kills (Halo 3): each kill within MULTIKILL_S of the one before
  doubleKill: { name: 'Double Kill', family: 'multikill', icon: 'multikill', stars: 2, rule: '2 kills' },
  tripleKill: { name: 'Triple Kill', family: 'multikill', icon: 'multikill', stars: 3, rule: '3 kills' },
  overkill: { name: 'Overkill', family: 'multikill', icon: 'multikill', stars: 4, rule: '4 kills' },
  killtacular: { name: 'Killtacular', family: 'multikill', icon: 'multikill', stars: 5, rule: '5 kills' },
  killtrocity: { name: 'Killtrocity', family: 'multikill', icon: 'multikill', stars: 6, rule: '6 kills' },
  killimanjaro: { name: 'Killimanjaro', family: 'multikill', icon: 'multikill', stars: 7, rule: '7 kills' },
  killtastrophe: { name: 'Killtastrophe', family: 'multikill', icon: 'multikill', stars: 8, rule: '8 kills' },
  killpocalypse: { name: 'Killpocalypse', family: 'multikill', icon: 'multikill', stars: 9, rule: '9 kills' },
  killionaire: { name: 'Killionaire', family: 'multikill', icon: 'multikill', stars: 10, rule: '10 kills (Halo 3 stops here: no repeat past 10)' },
  // sprees (Halo 3): kills without dying, a medal every SPREE_STEP
  killingSpree: { name: 'Killing Spree', family: 'spree', icon: 'killingSpree', rule: '5 kills without dying' },
  killingFrenzy: { name: 'Killing Frenzy', family: 'spree', icon: 'killingFrenzy', rule: '10 kills without dying' },
  runningRiot: { name: 'Running Riot', family: 'spree', icon: 'runningRiot', rule: '15 kills without dying' },
  rampage: { name: 'Rampage', family: 'spree', icon: 'rampage', rule: '20 kills without dying' },
  untouchable: { name: 'Untouchable', family: 'spree', icon: 'untouchable', rule: '25 kills without dying' },
  invincible: { name: 'Invincible', family: 'spree', icon: 'invincible', rule: '30 kills without dying' },
  // weapon sprees (Halo 3): kills with one weapon in one life
  sniperSpree: { name: 'Sniper Spree', family: 'spree', icon: 'sniperSpree', rule: `${WEAPON_SPREE[0]} sniper kills without dying` },
  sharpshooter: { name: 'Sharpshooter', family: 'spree', icon: 'sharpshooter', rule: `${WEAPON_SPREE[1]} sniper kills without dying` },
  splatterSpree: { name: 'Splatter Spree', family: 'spree', icon: 'splatterSpree', rule: `${WEAPON_SPREE[0]} run-overs without dying` },
  vehicularManslaughter: { name: 'Vehicular Manslaughter', family: 'spree', icon: 'vehicularManslaughter', rule: `${WEAPON_SPREE[1]} run-overs without dying` },
  // the match (Halo 3's objective and Infection medals)
  flagScore: { name: 'Flag Score', family: 'objective', icon: 'flagScore', rule: 'Capture the enemy flag', quiet: true },   // the match's own "Flag captured" line says it (announcer.js)
  killedFlagCarrier: { name: 'Killed Flag Carrier', family: 'objective', icon: 'killedFlagCarrier', rule: 'Kill whoever carries your flag' },
  perfection: { name: 'Perfection', family: 'objective', icon: 'perfection', rule: `Win Team Slayer with ${PERFECTION_KILLS}+ kills and no deaths` },
  infectionSpree: { name: 'Infection Spree', family: 'infection', icon: 'infectionSpree', rule: `Infect ${ZOMBIE_SPREE[0]} in one life` },
  mmmBrains: { name: 'Mmmm... Brains', family: 'infection', icon: 'mmmBrains', rule: `Infect ${ZOMBIE_SPREE[1]} in one life` },
  zombieKillingSpree: { name: 'Zombie Killing Spree', family: 'infection', icon: 'zombieKillingSpree', rule: `Kill ${ZOMBIE_SPREE[0]} infected without dying` },
  hellsJanitor: { name: "Hell's Janitor", family: 'infection', icon: 'hellsJanitor', rule: `Kill ${ZOMBIE_SPREE[1]} infected without dying` },
  lastManStanding: { name: 'Last Man Standing', family: 'infection', icon: 'lastManStanding', rule: 'Be the last survivor in Infection' },
};

// the ladders, in order
export const MULTIKILLS = Object.keys(MEDALS).filter((k) => MEDALS[k].family === 'multikill');   // [i]: i + 2 kills
export const SPREES = ['killingSpree', 'killingFrenzy', 'runningRiot', 'rampage', 'untouchable', 'invincible'];   // [i]: (i + 1) × SPREE_STEP kills

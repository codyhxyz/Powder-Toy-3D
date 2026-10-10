// Classes: Team Fortress 2's, built from this game's tools and Noita's perks
// (docs/classes.md). Plain data plus the bookkeeping that puts a class on a
// body; no three.js and no DOM, so anything (a game mode, a bot, a check) can
// import it.
//
// A class only adds: its perks go on top of whatever the body earned at
// shrines, and its signature tool goes in hand. The hotbar isn't restricted
// (yet). Keys of tools and perks that don't exist in this build are kept in the
// data and skipped when a class is applied; the picker shows them dimmed.

import { PERK } from './perks.js';

export const CLASSES_ENABLED = true;   // the whole layer: the picker, its key, applying classes on spawn
export const RESPAWN_ROOM_S = 6;       // s after a spawn in which a class change applies at once (TF2's respawn room)

// ---- body scales (the class's "low health" / "slow"): hooks on the body, see docs/classes.md
const FRAIL = 0.7;                     // × max health: the Runner dies to less
const HEAVY = 0.82;                    // × walking and running speed: the Bulwark plods

// key: also what body.cls holds. color: the accent (portrait robe, card, eyes).
// signature: the tool put in hand on spawn; if it doesn't exist yet, the
// first tool of `tools` that does. tools: the loadout's tools (tool keys).
// perks: perk key → stacks. body: { health, speed } scales (1 if absent).
// pose: how the portrait stands (classPortraits.js).
export const CLASSES = [
  {
    key: 'ROCKETEER', name: 'Rocketeer', color: '#e0783a',
    tagline: 'Rides his own blasts.',
    role: 'Rocket-jumps onto the high ground and shells the choke points nobody else can hold.',
    signature: 'ROCKET', tools: ['ROCKET', 'BOMB'], perks: { EXPLOSION_IMMUNITY: 1 },
    pose: 'shoulder',
  },
  {
    key: 'RUNNER', name: 'Runner', color: '#f2c84b',
    tagline: 'First to the flag, first to fall.',
    role: 'Flanks wide, grabs the flag and is gone before the defence turns round. Dies to a stiff breeze.',
    signature: 'POGO', tools: ['POGO', 'AXE'], perks: { FLEET_FOOT: 1 }, body: { health: FRAIL },
    pose: 'sprint',
  },
  {
    key: 'SKYJACK', name: 'Skyjack', color: '#5fc8e8',
    tagline: 'Owns the sky over the fight.',
    role: 'Holds the high ground on a long burn of fuel, then drops onto whoever looks up too late.',
    signature: 'GUN', tools: ['GUN'], perks: { ROCKET_BOOTS: 1, BIG_TANK: 1 },
    pose: 'hover',
  },
  {
    key: 'BULWARK', name: 'Bulwark', color: '#8f9cb3',
    tagline: 'Plants his feet and stays.',
    role: 'Two shields and a deep well of health. Slow to arrive, slower to leave the hill.',
    signature: 'SMG', tools: ['SMG', 'GUN'], perks: { ENERGY_SHIELD: 2, EXTRA_HEALTH: 1 }, body: { speed: HEAVY },
    pose: 'brace',
  },
  {
    key: 'SPY', name: 'Spy', color: '#a77ce0',
    tagline: 'Comes up from the reservoir.',
    role: 'Swims in through the water nobody watches and puts a knife in the back of the base.',
    signature: 'KNIFE', tools: ['KNIFE', 'GUN'], perks: { BREATHLESS: 1 },
    pose: 'sneak',
  },
  {
    key: 'SAPPER', name: 'Sapper', color: '#c79a5b',
    tagline: 'Opens walls. Closes dams.',
    role: 'Picks through the enemy wall, melts what the pick can\'t, and pours water where the dam leaks.',
    signature: 'PICKAXE', tools: ['PICKAXE', 'BUCKET', 'BLOWTORCH'], perks: {},
    pose: 'swing',
  },
  {
    key: 'PYRO', name: 'Pyro', color: '#ff5a3c',
    tagline: 'Leaves nothing standing.',
    role: 'Walks through fire to light the forest round their base, and the base after it.',
    signature: 'BLOWTORCH', tools: ['BLOWTORCH'], perks: { FIRE_IMMUNITY: 1 },
    pose: 'torch',
  },
];
export const CLASS = Object.fromEntries(CLASSES.map((c) => [c.key, c]));

// ---- the picker's bars, worked out from the loadout
// What each tool and perk adds to a bar (per stack, for perks). Keys missing
// here add nothing. Everyone starts from STAT_BASE (a jetpack is mobility).
const STAT_BASE = { health: 1, speed: 1, mobility: 0.35, firepower: 0 };
const TOOL_STATS = {
  ROCKET: { firepower: 1, mobility: 0.35 },   // and rocket jumps
  SNIPER: { firepower: 0.85 },
  KNIFE: { firepower: 0.85 },                 // a backstab kills
  BLOWTORCH: { firepower: 0.75 },
  SMG: { firepower: 0.7 },
  BOMB: { firepower: 0.6 },
  GUN: { firepower: 0.55 },
  PHYSGUN: { firepower: 0.35, mobility: 0.15 },
  AXE: { firepower: 0.4 },
  PICKAXE: { firepower: 0.35 },
  SHOVEL: { firepower: 0.15 },
  POGO: { mobility: 0.45, speed: 0.15 },
};
const PERK_STATS = {
  EXTRA_HEALTH: { health: 0.5 },              // perks.js: +50% per stack
  ENERGY_SHIELD: { health: 0.4 },
  EXTRA_LIFE: { health: 0.5 },
  SAVING_GRACE: { health: 0.15 },
  FIRE_IMMUNITY: { health: 0.15 },
  EXPLOSION_IMMUNITY: { health: 0.15, mobility: 0.2 },   // blast jumps
  FLEET_FOOT: { speed: 0.4 },
  ROCKET_BOOTS: { mobility: 0.55 },
  BIG_TANK: { mobility: 0.35 },
  LUKKI: { mobility: 0.35 },
  BREATHLESS: { mobility: 0.2 },              // water is a road
  SAND_SWIMMER: { mobility: 0.2 },
  FASTER_TOOLS: { firepower: 0.3 },
  REVENGE_EXPLOSION: { firepower: 0.2 },
};
const EXTRA_TOOL_FIREPOWER = 0.25;            // share of each tool's firepower past the best one (a second gun helps a little)
// a bar is full at this
export const STAT_FULL = { health: 2.2, speed: 1.5, mobility: 1.4, firepower: 1.15 };
export const STATS = [
  { key: 'health', name: 'Health' },
  { key: 'speed', name: 'Speed' },
  { key: 'mobility', name: 'Mobility' },
  { key: 'firepower', name: 'Firepower' },
];

// { health, speed, mobility, firepower }, each 0..1 of its bar
export function classStats(cls) {
  const s = { ...STAT_BASE };
  const fire = [];
  for (const t of cls.tools) {
    const d = TOOL_STATS[t] ?? {};
    for (const [k, v] of Object.entries(d)) if (k === 'firepower') fire.push(v); else s[k] += v;
  }
  fire.sort((a, b) => b - a);
  s.firepower += (fire[0] ?? 0) + EXTRA_TOOL_FIREPOWER * fire.slice(1).reduce((a, b) => a + b, 0);
  for (const [p, n] of Object.entries(cls.perks)) {
    for (const [k, v] of Object.entries(PERK_STATS[p] ?? {})) s[k] += v * n;
  }
  s.health *= cls.body?.health ?? 1;
  s.speed *= cls.body?.speed ?? 1;
  const out = {};
  for (const { key } of STATS) out[key] = Math.min(1, Math.max(0, s[key] / STAT_FULL[key]));
  return out;
}

// 'ROCKET_BOOTS' → 'Rocket boots': a name for a key this build doesn't know
export const keyName = (key) => key.charAt(0) + key.slice(1).toLowerCase().replaceAll('_', ' ');

// ---- putting a class on a body (the player's or a bot's: anything made by createPlayer)
//
// The class's perks are added as stacks on body.perks and remembered in
// body.classPerks, so the next class change takes exactly those stacks back
// and leaves the shrine's. Death clears every perk (vitals.js); the shell
// applies the class again on respawn. body.speedScale and
// body.perks.healthScale carry the class's body scales.
//
// Returns { cls, granted: { key: n }, skipped: [perk keys this build lacks] },
// or null for an unknown class key (nothing changes). key null: no class.
export function applyClass(body, key) {
  const cls = key == null ? null : CLASS[key];
  if (key != null && !cls) return null;
  const perks = body.perks;
  for (const [k, n] of Object.entries(body.classPerks ?? {})) {
    for (let i = 0; i < n; i++) if (!perks?.take(k)) break;   // gone already (death, or Extra Life used up)
  }
  const granted = {}, skipped = [];
  for (const [k, n] of Object.entries(cls?.perks ?? {})) {
    if (!PERK[k] || PERK[k].oneOff || !perks) { skipped.push(k); continue; }
    for (let i = 0; i < n; i++) perks.add(k);
    granted[k] = n;
  }
  body.classPerks = granted;
  body.cls = cls?.key ?? null;
  body.speedScale = cls?.body?.speed ?? 1;
  if (perks) perks.healthScale = cls?.body?.health ?? 1;
  return { cls, granted, skipped };
}

// The tool to put in hand: the signature, else the first of the loadout's tools
// that `has` (key → bool) says this build has. null if none.
export function heldTool(cls, has) {
  if (!cls) return null;
  if (has(cls.signature)) return cls.signature;
  return cls.tools.find(has) ?? null;
}

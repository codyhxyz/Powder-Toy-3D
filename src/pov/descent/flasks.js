// Descent's potion flasks (docs/descent-contract.md, "Items"): Noita's second
// kind of item. A flask found lying in a level (levels.js `potions`) or spilled
// from a chest is full of one material, rolled by the level's tier. Pure: node
// checks import it (scripts/check-descent-items.mjs).
//
// Noita's world potions (data/scripts/items/potion.lua, as mirrored in
// vexx32/noita-data) roll a material from two lists: `materials_standard`
// (water, oil, blood, alcohol, slime, acid, lava, poison...) most of the time,
// and `materials_magic` (teleportatium, levitatium, healthium, berserkium,
// polymorphine, charm...) otherwise. Ours keeps that split as three rarity
// bands, over the liquids this game has, and lets deeper levels (Noita's
// deeper biomes) lean toward the magic ones.

import { E, ELEMENTS } from '../../elements.js';
import { rng, hashString, mixSeed } from './rng.js';
import { clampTier } from './gold.js';

// the rarity bands, element keys (WHISKEY is Noita's `alcohol`, TOXIC its `poison`/toxic sludge)
export const POTION_BANDS = Object.freeze({
  common: ['WATER', 'OIL', 'TOXIC', 'BLOOD', 'WHISKEY'],
  uncommon: ['ACID', 'SLIME', 'HEALTHIUM', 'BERSERKIUM'],
  rare: ['TELEPORTATIUM', 'LEVITATIUM', 'POLYMORPHINE', 'PHEROMONE'],
});
// [tier] → chance of the uncommon band, then of the rare band (the rest is common).
// Tier 1 is potion.lua's split (about three in four standard); deeper, more magic.
const UNCOMMON_BY_TIER = [0, 0.22, 0.28, 0.33];
const RARE_BY_TIER = [0, 0.06, 0.1, 0.15];
const POTION_SALT = 0x907;

// Noita's flask holds 1000 units, ours FLASK_CAP cells (tools/flask.tool.js; repeated here so this stays
// free of the tool's three.js imports: scripts/check-descent-items.mjs checks the two agree).
export const FLASK_CELLS = 125;
const SEED_SPAN = 0.999;   // a cell's random seed stays below 1 (shaders/common.js SEED_MAX)

// the material (element key) of a flask at `seed` (a string: its site) on a level of `tier`
export function rollPotion(tier, seed) {
  const t = clampTier(tier);
  const r = rng(mixSeed(hashString(String(seed)), POTION_SALT));
  const x = r();
  const band = x < RARE_BY_TIER[t] ? 'rare' : x < RARE_BY_TIER[t] + UNCOMMON_BY_TIER[t] ? 'uncommon' : 'common';
  const list = POTION_BANDS[band];
  return list[Math.floor(r() * list.length)];
}

// a full flask of element `key`'s cells, each [id, T, life, seed] as a tool's load carries them
export function flaskCells(key, seed = 0, n = FLASK_CELLS) {
  const id = E[key];
  const r = rng(mixSeed(hashString(String(seed)), id));
  return Array.from({ length: n }, () => [id, ELEMENTS[id].temp, ELEMENTS[id].life, r() * SEED_SPAN]);
}

// a run's flask: { id, material, name, cells } (what descentRun.js keeps)
export function makeFlask(key, seed) {
  return { id: `flask-${hashString(String(seed)).toString(36)}`, material: key, name: `Flask of ${ELEMENTS[E[key]].name.toLowerCase()}`, cells: flaskCells(key, seed) };
}

export const potionColor = (key) => ELEMENTS[E[key]]?.color ?? '#ffffff';

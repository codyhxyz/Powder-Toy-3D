// Descent's treasure chests (docs/descent-contract.md, "Items"): look at one,
// press E, and it bursts open and spills what it held. Pure: node checks import
// it (scripts/check-descent-items.mjs).
//
// Noita's chest (data/scripts/items/chest_random.lua, as mirrored in
// vexx32/noita-data) rolls on open: most rolls are gold nuggets, then potions,
// spell cards, and now and then a wand; some rolls add more rolls. Ours: always
// a handful of nuggets (Noita's chests are never empty-handed: gold is its most
// common roll), plus CHEST_ROLLS rolls on Noita's order of likelihood. The same
// chest (its site) always holds the same things.

import { rng, hashString, mixSeed } from './rng.js';
import { siteNuggets, clampTier } from './gold.js';
import { rollPotion } from './flasks.js';

export const CHEST_NUGGETS = [3, 6];     // nuggets every chest holds, min and max (Noita: gold is the usual roll)
export const CHEST_ROLLS = 2;            // further rolls, each one of the kinds below
export const CHEST_SPELLS = 2;           // spell cards a 'spells' roll spills (Noita's random card roll gives a few)
// one roll's chances, in chest_random.lua's order of likelihood: more gold, a potion, spells, a wand
const ROLL = [['gold', 0.3], ['potion', 0.3], ['spells', 0.25], ['wand', 0.15]];
const CHEST_SALT = 0xc4e57;

// What the chest at `site` (a string) on a level of `tier` spills:
// [{ kind: 'gold', value } | { kind: 'potion', material, seed } | { kind: 'spell', seed } | { kind: 'wand', seed }].
// seeds are strings for generate.js (generateWand(tier, seed), randomSpell(tier, seed)) and flasks.js.
export function rollChest(tier, site) {
  const t = clampTier(tier);
  const base = mixSeed(hashString(String(site)), CHEST_SALT);
  const r = rng(base);
  const out = [];
  const gold = (n, salt) => siteNuggets(t, mixSeed(base, salt), n).forEach((value) => out.push({ kind: 'gold', value }));
  gold(CHEST_NUGGETS[0] + Math.floor(r() * (CHEST_NUGGETS[1] - CHEST_NUGGETS[0] + 1)), 0);
  for (let i = 0; i < CHEST_ROLLS; i++) {
    let x = r(), kind = ROLL.at(-1)[0];
    for (const [k, p] of ROLL) { if (x < p) { kind = k; break; } x -= p; }
    const seed = `${site}:${i}`;
    if (kind === 'gold') gold(CHEST_NUGGETS[0], i + 1);
    else if (kind === 'potion') out.push({ kind: 'potion', material: rollPotion(t, seed), seed });
    else if (kind === 'wand') out.push({ kind: 'wand', seed });
    else for (let n = 0; n < CHEST_SPELLS; n++) out.push({ kind: 'spell', seed: `${seed}:${n}` });
  }
  return out;
}

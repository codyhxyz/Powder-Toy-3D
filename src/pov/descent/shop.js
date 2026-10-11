// The Holy Mountain shop's stock (docs/descent-contract.md, C). Pure: node checks
// import it with the stand-in generator (stubs.js); the game passes B's.
//
// Noita's temple shop is a wand shop or a spell shop, a coin flip per temple
// (temple_altar.lua). Ours has the contract's 5 pedestals: a wand shop puts
// wands on the first SHOP_WANDS of them and spells on the rest (Noita's wand
// shop has only wands; 5 wands at once would outrun the gold a level gives
// here), a spell shop is all spells. Items are rolled from the level's tier and
// the temple's seed, so a temple always stocks the same things in a run.

import { mixSeed, rng } from './rng.js';

export const SHOP_WAND_CHANCE = 0.5;   // a temple's shop is a wand shop (Noita's coin flip)
export const SHOP_WANDS = 2;           // wands in a wand shop; its other pedestals hold spells

// gen = { generateWand(tier, seed), randomSpell(tier, seed), wandPrice(wand, tier), spellPrice(id, tier) }
// → [{ slot, kind: 'wand' | 'spell', wand?, spell?, price }] one per pedestal
export function rollShop(tier, seed, pedestals, gen) {
  const r = rng(seed);
  const wandShop = r() < SHOP_WAND_CHANCE;
  const out = [];
  for (let i = 0; i < pedestals; i++) {
    const s = mixSeed(seed, i);
    if (wandShop && i < SHOP_WANDS) {
      const wand = gen.generateWand(tier, s);
      out.push({ slot: i, kind: 'wand', wand, price: gen.wandPrice(wand, tier) });
    } else {
      const spell = gen.randomSpell(tier, s);
      out.push({ slot: i, kind: 'spell', spell, price: gen.spellPrice(spell, tier) });
    }
  }
  return out;
}

// Buy `item` with `purse` (gold.js createPurse): Noita's walk-in purchase.
// → 'bought' (gold taken), 'poor' (not enough, nothing taken) or 'sold' (already gone)
export function buy(item, purse) {
  if (!item || item.sold) return 'sold';
  if (!purse.spend(item.price)) return 'poor';
  item.sold = true;
  return 'bought';
}

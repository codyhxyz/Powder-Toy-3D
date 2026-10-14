// Stand-ins for agent B's src/pov/wands/generate.js (docs/descent-contract.md, B),
// used only while that file is missing (deps.js picks the real one when it lands).
// Same signatures: generateWand(tier, seed), randomSpell(tier, seed),
// wandPrice(wand, tier), spellPrice(id, tier). Pure: node checks import it.

import { PRESETS, SPELLS, SPELL_BY_ID } from '../wands/catalog.js';
import { rng } from '../../rng.js';

// Noita's shop price (data/scripts/items/generate_shop_item.lua): an item's own cost
// scaled down, plus a step per Holy Mountain, rounded to tens:
//   price = max(floor((cost × 0.30 + 70 × level) / 10) × 10, 10)
export const SHOP_COST_SHARE = 0.3;
export const SHOP_PRICE_PER_LEVEL = 70;
export const SHOP_PRICE_ROUND = 10;
export const shopPrice = (cost, level) =>
  Math.max(Math.floor((cost * SHOP_COST_SHARE + SHOP_PRICE_PER_LEVEL * level) / SHOP_PRICE_ROUND) * SHOP_PRICE_ROUND, SHOP_PRICE_ROUND);

// The stand-in costs, until B's generator prices its own. Noita's spells cost 60 to
// ~300 (a Spark Bolt 100, a Bomb 200); ours grow with mana, the nearest thing they carry.
const SPELL_COST_BASE = 60;         // a cheap spell's Noita cost
const SPELL_COST_PER_MANA = 6;      // more per point of mana it takes
const WAND_COST_PER_TIER = 1000;    // a wand's cost per tier: ~370 gold in the first temple, Noita's going rate
const TIER_STAT_STEP = 0.25;        // stand-in wands: +25% mana and regen per tier over the preset's

export function generateWand(tier, seed) {
  const r = rng(seed);
  const p = PRESETS[Math.floor(r() * PRESETS.length)];
  const k = 1 + TIER_STAT_STEP * (tier - 1);
  return {
    id: `descent-${seed >>> 0}`, name: p.name, cards: [...p.cards], slot: p.slot, tier,
    config: { ...p.config, manaMax: Math.round(p.config.manaMax * k), manaRegen: Math.round(p.config.manaRegen * k) },
    cost: WAND_COST_PER_TIER * tier,
  };
}

const POOL = SPELLS.filter((s) => s.category !== 'Storage').map((s) => s.id);   // storage spells need a reservoir the shop can't sell
export function randomSpell(tier, seed) { return POOL[Math.floor(rng(seed)() * POOL.length)]; }

const spellMana = (id) => SPELL_BY_ID[id]?.params?.mana ?? SPELL_BY_ID[id]?.mana ?? 0;
export const spellPrice = (id, tier) => shopPrice(SPELL_COST_BASE + SPELL_COST_PER_MANA * spellMana(id), tier);
export const wandPrice = (wand, tier) => shopPrice(wand.cost ?? WAND_COST_PER_TIER * tier, tier);

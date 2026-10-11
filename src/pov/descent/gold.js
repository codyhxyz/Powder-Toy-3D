// Gold: Noita's money (docs/descent-contract.md, C). Pure numbers: node checks
// import it (scripts/check-descent-temple.mjs).
//
// Noita's gold comes as nuggets you walk over: the common one is worth 10, the
// bigger ones (50, 200) turn up deeper. Killed enemies spill nuggets too, more
// for tougher ones (Noita's drop_money.lua scales the drop with the enemy's max
// HP), and those vanish if left lying (Noita: about 15 s, blinking at the end).
// A death ends a Noita run and its gold with it; here, for now, you come back at
// the drop point and keep your gold (createDescent notes it).

import { rng } from './rng.js';

export const NUGGET = Object.freeze({ SMALL: 10, BIG: 50, HUGE: 200 });   // Noita's gold_nugget, gold_nugget_50, gold_nugget_200
const DENOMINATIONS = [NUGGET.HUGE, NUGGET.BIG, NUGGET.SMALL];          // largest first: a drop is split into these
export const NUGGETS_PER_SITE = 2;      // nuggets at a loot site of kind 'gold': a small clump (Noita's lie in pockets, in many small ones)
// The chance a site's nugget is a bigger one, by level tier (Noita: deeper, bigger nuggets)
const BIG_CHANCE_BY_TIER = [0, 0, 0.25, 0.5];    // [tier] → chance a nugget is a 50 instead of a 10
const HUGE_CHANCE_BY_TIER = [0, 0, 0, 0.1];      // [tier] → chance a nugget is a 200
export const MAX_TIER = BIG_CHANCE_BY_TIER.length - 1;
export const DROP_LIFETIME_S = 15;      // s an enemy's dropped gold lies before it vanishes (Noita's, about)
export const DROP_BLINK_S = 3;          // s before vanishing it blinks (Noita's warning)
// Gold an enemy spills, by spawner kind (spawners.js SPAWNER values). Noita scales it with
// max HP; ours rank the enemies by how hard they are here: the axeman a Noita zombie,
// the jetpack gunner a hiisi, the worms Noita's worms (the giant one a boss-sized haul).
export const ENEMY_GOLD = Object.freeze({ enemy: 20, gunner: 30, worm: 50, giantworm: 200 });
export const ENEMY_GOLD_DEFAULT = NUGGET.SMALL;   // an enemy kind not listed

export const clampTier = (t) => Math.max(1, Math.min(MAX_TIER, Math.round(t) || 1));

// The nuggets at a 'gold' loot site of `tier`, rolled from `seed`: [value, ...]
export function siteNuggets(tier, seed, n = NUGGETS_PER_SITE) {
  const r = rng(seed), t = clampTier(tier), out = [];
  for (let i = 0; i < n; i++) {
    const x = r();
    out.push(x < HUGE_CHANCE_BY_TIER[t] ? NUGGET.HUGE : x < HUGE_CHANCE_BY_TIER[t] + BIG_CHANCE_BY_TIER[t] ? NUGGET.BIG : NUGGET.SMALL);
  }
  return out;
}

// `amount` split into Noita's nugget sizes, largest first: 270 → [200, 50, 10, 10]
export function splitGold(amount) {
  let left = Math.max(0, Math.floor(amount / NUGGET.SMALL) * NUGGET.SMALL);
  const out = [];
  for (const d of DENOMINATIONS) while (left >= d) { out.push(d); left -= d; }
  return out;
}

export const enemyGold = (kind) => ENEMY_GOLD[kind] ?? ENEMY_GOLD_DEFAULT;

// The run's gold. A new run (arriving at the first level) starts at 0, as Noita's does.
export function createPurse(start = 0) {
  let gold = start, version = 0;
  return {
    get gold() { return gold; },
    get version() { return version; },
    add(n) { if (n > 0) { gold += Math.floor(n); version++; } return gold; },
    canAfford: (price) => gold >= price,
    // pay `price`; false (and nothing taken) when there isn't enough
    spend(price) {
      if (!(price >= 0) || gold < price) return false;
      gold -= price; version++;
      return true;
    },
    reset(n = 0) { gold = n; version++; },
  };
}

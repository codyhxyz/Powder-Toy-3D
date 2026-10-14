import { SPELLS, SPELL_BY_ID } from './catalog.js';
import { compileWand, CONFIG_BOUNDS } from './compiler.js';
import { rng as mulberry32, hashString } from '../../rng.js';

// Noita's procedural wands, reimplemented from its public rules (not its code):
// data/scripts/gun/procedural/gun_procedural.lua (get_gun_data,
// apply_random_variable, wand_add_random_cards), wand_level_0N.lua,
// starting_wand.lua and data/scripts/items/generate_shop_item.lua, as mirrored
// in vexx32/noita-data; and noita.wiki.gg "Wand" / "Guide: Wand Mechanics".
//
// A wand is rolled from a cost budget per tier: each stat (recharge, cast
// delay, capacity, shuffle, spells per cast) takes a random value from Noita's
// distributions within what the remaining budget can pay for, and whatever is
// left buys capacity. Then it's preloaded with one projectile from the tier's
// pool, sometimes led by a modifier or a multicast. Noita frames are 1/60 s
// (FRAME_S); mana and mana/s are Noita's own numbers (our spell costs are on
// Noita's scale: Spark bolt 5 as LIGHT_BULLET).
//
// Deterministic per seed (Noita seeds by the item's position: SetRandomSeed(x, y)).

const FRAME_S = 1 / 60;                       // Noita runs at 60 frames a second
export const TIERS = 3;                       // Descent's levels (docs/descent-contract.md)
// wand_level_01..03.lua: generate_gun(cost, level): the stat budget per tier
const TIER_COST = [30, 40, 60];
const LEVEL1_BONUS = 5, LEVEL1_BONUS_P = 50;  // get_gun_data: level 1 wands get +5 half the time
const COST_JITTER = 3;                        // ...and every wand ± Random(-3, 3)
// mana_max = 50 + 150·level + Random(-5,5)·10; mana_charge_speed = 50·level + Random(-5, 5·level)
const MANA_BASE = 50, MANA_PER_LEVEL = 150, MANA_JITTER = 5, MANA_STEP = 10;
const REGEN_PER_LEVEL = 50, REGEN_JITTER_LO = -5, REGEN_JITTER_HI_PER_LEVEL = 5;
const SLOW_CHARGER_P = 20, SLOW_CHARGER_REGEN = 1 / 5, SLOW_CHARGER_MANA = 3;   // big tank, slow fill
const FAST_CHARGER_P = 15, FAST_CHARGER_REGEN = 5, FAST_CHARGER_MANA = 1 / 3;   // small tank, fast fill
const MANA_MIN = 50, REGEN_MIN = 10;
const UNSHUFFLE_P_BASE = 15, UNSHUFFLE_P_PER_LEVEL = 6;   // force_unshuffle: p < 15 + level·6
const RARE_P = 5, RARE_COST = 65;                         // is_rare: 5 %, +65 budget
const CAPACITY_MIN = 2, CAPACITY_MAX = 26;                // "OLLI REQUIRED A MAX CLAMP FOR UI"
const UNSHUFFLE_MAX_CAPACITY = 9;                         // unshuffled only up to 9 slots
const LEFTOVER_MIN = 5, LEFTOVER_PER_SLOT_SHUFFLED = 5, LEFTOVER_PER_SLOT_UNSHUFFLED = 10;
const SLOW_RELOAD_FRAMES = 60;                            // reload ≥ 60 f: extra spells per cast
const EXTRA_CAST_P = 70, SPREAD_CASTS_P = 50, SPREAD_CASTS_TRIES = 6;

// gun_procedural.lua gun_probs: { prob, min, max, mean, sharpness } per stat
const PROBS = {
  capacity: [[1, 3, 10, 6, 2], [0.1, 2, 7, 4, 4, 'unshuffle'], [0.05, 1, 5, 3, 4, 'unshuffle'], [0.15, 5, 11, 8, 2],
    [0.12, 2, 20, 8, 4], [0.15, 3, 12, 6, 6, 'drawMany'], [1, 1, 20, 6, 0]],
  recharge: [[1, 5, 60, 30, 2], [0.5, 1, 100, 40, 2], [0.02, 1, 100, 40, 0], [0.35, 1, 240, 40, 0, 'unshuffle']],
  castDelay: [[1, 1, 30, 5, 2], [0.1, 1, 50, 15, 3], [0.1, -15, 15, 0, 3], [0.45, 0, 35, 12, 0]],
  spread: [[1, -5, 10, 0, 3], [0.1, -35, 35, 0, 0]],
  spellsPerCast: [[1, 1, 3, 1, 3], [0.2, 2, 4, 2, 8], [0.05, 1, 5, 2, 2], [1, 1, 5, 2, 0]],
};

// Each of our spells' nearest Noita action (gun_actions.lua): its type, the
// spawn levels it appears at, its spawn probabilities there, and its shop
// price. Noita level L ↔ our tier L + 1 for wands (wand_add_random_cards uses
// level − 1) and tier L for shops (the first Holy Mountain is level 1). `null`
// noita: no counterpart, priced and placed like the nearest kind.
const P = 'projectile', M = 'modifier', D = 'drawMany', U = 'utility', T = 'trigger';
const pool = (type, levels, probs, price, noita = null) => ({ type, levels, probs, price, noita });
const ALL = [0, 1, 2, 3, 4, 5, 6];
export const SPELL_POOL = {
  spark: pool(P, [0, 1, 2], [2, 1, 0.5], 100, 'LIGHT_BULLET'),
  'heavy-bolt': pool(P, [1, 2, 3, 4, 5, 6], [0.5, 1, 1, 1, 1, 1], 200, 'HEAVY_BULLET'),
  carrier: pool(P, [0, 1, 2, 3], [0.3, 0.3, 0.3, 0.3], 60, 'RUBBER_BALL'),   // a harmless bolt to hang triggers on
  bomb: pool(P, ALL, [1, 1, 1, 1, 1, 1, 1], 200, 'BOMB'),
  'acid-bolt': pool(P, [1, 2, 3, 4], [1, 1, 1, 1], 180, 'ACIDSHOT'),
  'water-bolt': pool(P, [1, 2, 3, 4], [0.4, 0.4, 0.4, 0.4], 160, 'CIRCLE_WATER'),
  firebolt: pool(P, [0, 3, 4, 6], [1, 1, 1, 1], 220, 'FIREBALL'),
  dig: pool(P, [0, 1, 2], [1, 1, 0.5], 70, 'DIGGER'),                     // level 0 as CHAINSAW (also digs)
  teleport: pool(P, [0, 1, 2, 4, 5, 6], [0.6, 0.6, 0.6, 0.4, 0.4, 0.4], 130, 'TELEPORT_PROJECTILE'),
  'black-hole': pool(P, [0, 2, 4, 5], [0.8, 0.8, 0.8, 0.8], 200, 'BLACK_HOLE'),
  explosion: pool(U, [0, 2, 4, 5], [0.5, 1, 1, 1], 160, 'EXPLOSION'),
  erase: pool(U, [1, 2, 4, 5], [0.1, 1, 0.1, 0.1], 280, 'MATTER_EATER'),
  ice: pool(U, [0, 2, 4, 5], [0.3, 0.6, 0.7, 0.3], 200, 'FREEZE_FIELD'),
  smoke: pool(U, [0, 1, 2, 3, 4, 5], [0.4, 0.4, 0.4, 0.4, 0.4, 0.4], 140, 'CLOUD_WATER'),
  steam: pool(U, [0, 1, 2, 3, 4, 5], [0.4, 0.4, 0.4, 0.4, 0.4, 0.4], 140, 'CLOUD_WATER'),
  'water-jet': pool(U, [1, 2, 3, 4, 5], [0.4, 0.4, 0.4, 0.4, 0.4], 110, 'MATERIAL_WATER'),
  'oil-jet': pool(U, [1, 2, 3, 4, 5], [0.4, 0.4, 0.4, 0.4, 0.4], 140, 'MATERIAL_OIL'),
  'fire-jet': pool(U, [1, 2, 3, 4], [0.4, 0.4, 0.4, 0.4], 170, 'CIRCLE_FIRE'),
  sand: pool(U, [1, 2, 3, 5], [1, 1, 1, 1], 10, 'SOILBALL'),
  powder: pool(U, [1, 2, 3, 4, 5], [0.4, 0.4, 0.4, 0.4, 0.4], 140),
  stone: pool(U, ALL, [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8], 160, 'SUMMON_ROCK'),
  glass: pool(U, ALL, [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4], 160),
  heat: pool(U, [0, 1, 2], [1, 1, 1], 100, 'TORCH'),
  ignite: pool(U, [0, 1, 2], [1, 1, 1], 100, 'TORCH'),
  cool: pool(U, [1, 3, 4, 5], [1, 1, 1, 1], 140, 'FREEZE'),
  lantern: pool(U, [0, 1, 2], [1, 1, 1], 20, 'LIGHT'),
  scan: pool(U, ALL, [0.8, 1, 1, 0.8, 0.6, 0.4, 0.2], 230, 'X_RAY'),
  recoil: pool(U, [0, 1, 2, 4], [0.6, 0.6, 0.6, 0.6], 100, 'RECOIL'),
  attraction: pool(U, [1, 2, 4, 5], [0.3, 0.3, 0.3, 0.3], 200),
  repulsion: pool(U, [1, 2, 4, 5], [0.3, 0.3, 0.3, 0.3], 200),
  vacuum: pool(U, [0, 1, 2, 3], [0.4, 0.4, 0.4, 0.4], 110),                // storage: no Noita counterpart
  sponge: pool(U, [0, 1, 2, 3], [0.4, 0.4, 0.4, 0.4], 110),
  release: pool(U, [0, 1, 2, 3], [0.4, 0.4, 0.4, 0.4], 110),
  'stored-shot': pool(U, [1, 2, 3], [0.3, 0.3, 0.3], 140),
  'stored-lob': pool(U, [1, 2, 3], [0.3, 0.3, 0.3], 140),
  'multi-2': pool(D, ALL, [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8], 140, 'BURST_2'),
  'multi-3': pool(D, [1, 2, 3, 4, 5, 6], [0.7, 0.7, 0.7, 0.7, 0.7, 0.7], 160, 'BURST_3'),
  'multi-4': pool(D, [2, 3, 4, 5, 6], [0.6, 0.6, 0.6, 0.6, 0.6], 180, 'BURST_4'),
  scatter: pool(D, [0, 1, 2, 3], [0.7, 0.7, 0.7, 0.8], 120, 'SCATTER_3'),
  burst: pool(D, [1, 2, 3, 4], [0.5, 0.5, 0.5, 0.5], 160),
  'burst-2': pool(D, [0, 1, 2, 3], [0.5, 0.5, 0.5, 0.5], 140),
  impact: pool(T, [0, 1, 2, 3], [1, 0.5, 0.5, 0.5], 140, 'LIGHT_BULLET_TRIGGER'),
  timer: pool(T, [1, 2, 3], [0.5, 0.5, 0.5], 140, 'LIGHT_BULLET_TIMER'),
  expiry: pool(T, [1, 2, 3], [0.5, 0.5, 0.5], 140, 'LIGHT_BULLET_DEATH_TRIGGER'),
  power: pool(M, [1, 2, 3, 4, 5], [0.6, 0.6, 0.6, 0.6, 0.6], 140, 'DAMAGE'),
  wide: pool(M, [2, 3, 4], [0.4, 0.4, 0.4], 150, 'HEAVY_SHOT'),
  narrow: pool(M, [1, 2, 3, 4, 5, 6], [0.4, 0.4, 0.4, 0.4, 0.4, 0.4], 100),
  speed: pool(M, [1, 2, 3], [1, 0.5, 0.5], 100, 'SPEED'),
  slow: pool(M, [1, 2, 3, 4], [0.5, 0.5, 0.5, 0.5], 100),
  'long-life': pool(M, [3, 4, 5, 6], [0.5, 0.5, 0.5, 0.5], 250, 'LIFETIME'),
  gravity: pool(M, [2, 3, 4, 5, 6], [0.5, 0.5, 0.5, 0.5, 0.5], 50, 'GRAVITY'),
  'no-gravity': pool(M, [2, 3, 4, 5, 6], [0.5, 0.5, 0.5, 0.5, 0.5], 50, 'GRAVITY_ANTI'),
  focused: pool(M, [1, 2, 3, 4, 5, 6], [0.8, 0.8, 0.8, 0.8, 0.8, 0.8], 100, 'SPREAD_REDUCE'),
  spread: pool(M, [0, 1, 2], [0.3, 0.3, 0.3], 50),
  kick: pool(M, [3, 5], [0.6, 0.6], 100, 'KNOCKBACK'),
  rapid: pool(M, [1, 2, 3, 4, 5, 6], [0.6, 0.6, 0.6, 0.6, 0.6, 0.6], 180),
  'quick-recharge': pool(M, [1, 2, 3, 4, 5, 6], [1, 1, 1, 1, 1, 1], 200, 'RECHARGE'),
  bounce: pool(M, [2, 3, 4, 5, 6], [1, 1, 0.4, 0.2, 0.2], 50, 'BOUNCE'),
  pierce: pool(M, [2, 3, 4, 5, 6], [0.6, 0.6, 0.6, 0.6, 0.6], 190, 'PIERCING_SHOT'),
  homing: pool(M, [1, 2, 3, 4, 5, 6], [0.1, 0.4, 0.4, 0.4, 0.4, 0.4], 220, 'HOMING'),
  'fire-trail': pool(M, [0, 1, 2, 3, 4], [0.3, 0.3, 0.3, 0.3, 0.3], 130, 'FIRE_TRAIL'),
};
// every spell has a pool entry (check-wand-generate.mjs asserts it)
export const unpooled = () => SPELLS.map((s) => s.id).filter((id) => !SPELL_POOL[id]);

// generate_shop_item.lua: a spell costs max(floor((price·0.30 + 70·level²) / 10)·10, 10);
// a wand 50 + 210·(level/2 + level²/2) + Random(-15, 15)·10. A sale halves either.
const SPELL_PRICE_SHARE = 0.3, SPELL_PRICE_PER_LEVEL2 = 70, PRICE_ROUND = 10, SPELL_PRICE_MIN = 10;
const WAND_PRICE_BASE = 50, WAND_PRICE_PER_LEVEL = 210, WAND_PRICE_JITTER = 15;
export const SALE = 0.5;

// --- seeded random (Noita's Random(a, b) is integer-inclusive, Random() is [0,1)) ---
export function hashSeed(...parts) { return hashString(parts.join('|')); }   // FNV-1a over the parts' text
function rng(seed) {
  const next = mulberry32(typeof seed === 'number' ? seed : hashSeed(seed));
  const int = (lo, hi) => { lo = Math.ceil(lo); hi = Math.floor(hi); return hi < lo ? lo : lo + Math.floor(next() * (hi - lo + 1)); };
  // Noita's native RandomDistribution(min, max, mean, sharpness): a value in
  // [min, max] peaked at mean, sharper with sharpness; 0 is uniform. Its native
  // code isn't public: this is a peaked stand-in (rejection-sampled bell).
  const dist = (min, max, mean, sharp) => {
    if (!sharp) return int(min, max);
    for (let i = 0; i < 64; i++) {
      const x = int(min, max), d = (x - mean) / Math.max(1, max - min);
      if (next() < Math.exp(-sharp * sharp * d * d * 4)) return x;
    }
    return Math.round(mean);
  };
  return { next, int, dist };
}
const clamp = (x, lo, hi) => Math.max(Math.min(lo, hi), Math.min(Math.max(lo, hi), x));
function pick(r, rows) {
  let x = r.next() * rows.reduce((n, row) => n + row[0], 0);
  for (const row of rows) { if (x <= row[0]) return row; x -= row[0]; }
  return rows.at(-1);
}

// get_gun_data: the stats, in Noita's units (frames, degrees)
function gunData(r, tier) {
  const level = tier;
  let cost = TIER_COST[tier - 1];
  if (level === 1 && r.int(0, 100) < LEVEL1_BONUS_P) cost += LEVEL1_BONUS;
  cost += r.int(-COST_JITTER, COST_JITTER);
  const regen = () => REGEN_PER_LEVEL * level + r.int(REGEN_JITTER_LO, REGEN_JITTER_HI_PER_LEVEL * level);
  const mana = () => MANA_BASE + MANA_PER_LEVEL * level + r.int(-MANA_JITTER, MANA_JITTER) * MANA_STEP;
  const g = { cost, capacity: 0, spellsPerCast: 0, reload: 0, shuffle: 1, delay: 0, spread: 0,
    regen: regen(), manaMax: mana(), forceUnshuffle: false, rare: false, drawMany: 0.15 };
  if (r.int(0, 100) < SLOW_CHARGER_P) { g.regen = regen() * SLOW_CHARGER_REGEN; g.manaMax = mana() * SLOW_CHARGER_MANA; }
  if (r.int(0, 100) < FAST_CHARGER_P) { g.regen = regen() * FAST_CHARGER_REGEN; g.manaMax = mana() * FAST_CHARGER_MANA; }
  g.manaMax = Math.max(MANA_MIN, g.manaMax);
  g.regen = Math.max(REGEN_MIN, g.regen);
  if (r.int(0, 100) < UNSHUFFLE_P_BASE + level * UNSHUFFLE_P_PER_LEVEL) g.forceUnshuffle = true;
  if (r.int(0, 100) < RARE_P) { g.rare = true; g.cost += RARE_COST; }

  const roll = (key) => { const row = pick(r, PROBS[key]); if (row[5] === 'drawMany') g.drawMany += 0.8; return r.dist(row[1], row[2], row[3], row[4]); };
  const apply = {
    reload() { g.reload = clamp(roll('recharge'), clamp(60 - g.cost * 5, 1, 240), 1024); g.cost -= (60 - g.reload) / 5; },
    delay() { g.delay = clamp(roll('castDelay'), clamp(16 - g.cost, -50, 50), 50); g.cost -= 16 - g.delay; },
    spread() { g.spread = clamp(roll('spread'), clamp(g.cost / -1.5, -35, 35), 35); g.cost -= 16 - g.spread; },
    capacity() {
      let max = clamp(g.cost / 5 + 6, 1, 20);
      if (g.forceUnshuffle) { max = (g.cost - 15) / 5; if (max > 6) max = 6 + (g.cost - (15 + 6 * 5)) / 10; }
      g.capacity = clamp(roll('capacity'), 1, clamp(max, 1, 20));
      g.cost -= (g.capacity - 6) * 5;
    },
    shuffle() {
      const unshuffle = g.forceUnshuffle || r.int(0, 1) === 1, price = 15 + g.capacity * 5;
      if (unshuffle && g.cost >= price && g.capacity <= UNSHUFFLE_MAX_CAPACITY) { g.shuffle = 0; g.cost -= price; }
    },
    spellsPerCast() {
      const c = g.capacity, costs = [0, 5 + c * 2, 15 + c * 3.5, 35 + c * 5, 45 + c * c];
      let max = 1;
      costs.forEach((k, i) => { if (k <= g.cost) max = i + 1; });
      g.spellsPerCast = Math.floor(clamp(roll('spellsPerCast'), 1, clamp(max, 1, c)));
      g.cost -= costs[clamp(g.spellsPerCast, 1, costs.length) - 1];
    },
  };
  const shuffled = (list) => { for (let i = list.length - 1; i > 0; i--) { const j = r.int(0, i); [list[i], list[j]] = [list[j], list[i]]; } return list; };
  const third = ['shuffle', 'spellsPerCast'];
  for (const k of [...shuffled(['reload', 'delay', 'spread']), 'capacity', ...(g.forceUnshuffle ? third : shuffled(third))]) apply[k]();
  // what's left of the budget buys capacity (99.5 % of wands)
  if (g.cost > LEFTOVER_MIN && r.int(0, 1000) < 995) {
    g.capacity += g.cost / (g.shuffle ? LEFTOVER_PER_SLOT_SHUFFLED : LEFTOVER_PER_SLOT_UNSHUFFLED);
    g.cost = 0;
  }
  g.capacity = Math.floor(clamp(g.capacity, CAPACITY_MIN, CAPACITY_MAX));
  if (g.reload >= SLOW_RELOAD_FRAMES) {   // slow-recharging wands cast more at once
    do g.spellsPerCast++; while (r.int(0, 100) < EXTRA_CAST_P);
    if (r.int(0, 100) < SPREAD_CASTS_P) {
      let n = g.capacity;
      for (let i = 0; i < SPREAD_CASTS_TRIES; i++) n = Math.min(n, r.int(g.spellsPerCast, g.capacity));
      g.spellsPerCast = n;
    }
  }
  g.spellsPerCast = clamp(g.spellsPerCast, 1, g.capacity);
  return g;
}

// the tier's spells of a kind, weighted by their spawn probability at Noita level `level`
function weighted(level, types) {
  return Object.entries(SPELL_POOL).filter(([, s]) => types.includes(s.type) && s.levels.includes(level))
    .map(([id, s]) => [s.probs[s.levels.indexOf(level)], id]);
}
function action(r, level, types) {
  // Noita falls back to a lower level when nothing of the kind spawns at this one
  for (let l = level; l >= 0; l--) {
    const rows = weighted(l, types);
    if (rows.length) return pick(r, rows)[1];
  }
  return 'spark';
}

// wand_add_random_cards: the deck it comes with
function deckFor(r, g, tier) {
  const level = tier - 1;
  let bullet = action(r, level, [P]);
  let count = clamp(r.int(0.51 * g.capacity, g.capacity), 1, g.capacity - 1);
  const randomBullets = r.int(0, 100) < tier * 10 - 5;
  const cards = [];
  if (r.int(0, 100) < 50) {   // structured: [multicast] [multicast] [modifier] bullets
    let extra = level;
    while (r.int(1, 10) === 10) bullet = action(r, ++extra, [P]);
    if (count < 3) {
      if (count > 1 && r.int(0, 100) < 20) { cards.push(action(r, level, [M])); count--; }
    } else {
      if (r.int(0, 100) < 40) { cards.push(action(r, level, [D])); count--; }
      if (count > 3 && r.int(0, 100) < 40) { cards.push(action(r, level, [D])); count--; }
      if (r.int(0, 100) < 80) { cards.push(action(r, level, [M])); count--; }
    }
    for (let i = 0; i < count; i++) cards.push(bullet);
  } else {
    const good = r.int(5, 45);
    let goods = 0;
    for (let i = 0; i < count; i++) {
      if (r.int(0, 100) < good && count > 2) {
        cards.push(goods === 0 && g.spellsPerCast === 1 ? action(r, level, [D]) : action(r, level, r.int(0, 100) < 83 ? [M] : [D]));
        goods++;
      } else {
        cards.push(bullet);
        if (randomBullets) bullet = action(r, level, [P]);
      }
    }
  }
  return repair(cards, g.capacity, bullet);
}

// Noita wraps a deck that runs short (a multicast at the end draws from the
// top); our compiler wants every expression complete, so finish the deck: add
// the wand's bullet while there's room, else drop the first formation/modifier.
function repair(cards, capacity, bullet, config) {
  cards = cards.slice(0, capacity);
  for (let guard = 0; guard < 4 * CAPACITY_MAX && cards.length; guard++) {
    if (!compileWand(cards, { capacity, ...config }).errors.length) return cards;
    if (cards.length < capacity) { cards.push(bullet); continue; }
    const i = cards.findIndex((id) => SPELL_POOL[id]?.type !== P);
    cards.splice(i < 0 ? cards.length - 1 : i, 1);
  }
  return cards.length ? cards : [bullet];
}

const toSeconds = (frames, [lo, hi]) => Math.round(clamp(frames * FRAME_S, lo, hi) * 1000) / 1000;
// a wand's look: a stand-in for Noita's GetWand sprite match (longer for more slots, a purple light when rare)
const HUES = { 1: 30, 2: 200, 3: 280 };
function lookOf(r, g, tier) {
  return { tier, rare: g.rare, slots: g.capacity, length: 0.9 + Math.min(g.capacity, 12) * 0.05,
    hue: (HUES[tier] + r.int(-20, 20) + 360) % 360, gem: g.rare ? '#8000ff' : `hsl(${r.int(0, 359)} 80% 65%)` };
}

// generateWand(tier, seed): a Noita wand of tier 1..3, its deck preloaded. Deterministic per seed.
export function generateWand(tier, seed = 0) {
  tier = clamp(Math.round(Number(tier) || 1), 1, TIERS);
  const r = rng(hashSeed('wand', tier, seed));
  const g = gunData(r, tier);
  const config = {
    manaMax: Math.round(clamp(g.manaMax, ...CONFIG_BOUNDS.manaMax)),
    manaRegen: Math.round(clamp(g.regen, ...CONFIG_BOUNDS.manaRegen)),
    castDelay: toSeconds(g.delay, CONFIG_BOUNDS.castDelay),
    recharge: toSeconds(g.reload, CONFIG_BOUNDS.recharge),
    capacity: g.capacity,
    shuffle: g.shuffle,
    spellsPerCast: g.spellsPerCast,
  };
  const cards = deckFor(r, g, tier);
  const main = SPELL_BY_ID[cards.find((id) => SPELL_POOL[id]?.type === P) ?? cards[0]];
  return {
    id: `gen-${tier}-${hashSeed(seed).toString(36)}`, name: `${g.rare ? 'Rare ' : ''}${(main?.name ?? 'Spark bolt').replace(/^Create /, '')} wand`,
    tier, cards, config, look: lookOf(r, g, tier),
    // Noita stats with no slot in our wands yet (kept for the shop's card and a later pass)
    noita: { spreadDegrees: g.spread, rare: g.rare },
  };
}

// starting_wand.lua ("Bolt staff"): 2–3 slots, recharge 20–28 f, cast delay
// 9–15 f, 80–130 mana at 25–40/s, unshuffled, 1–3 spark bolts.
export function starterWand(seed = 0) {
  const r = rng(hashSeed('starter', seed));
  const capacity = r.int(2, 3);
  const config = { manaMax: r.int(80, 130), manaRegen: r.int(25, 40), castDelay: toSeconds(r.int(9, 15), CONFIG_BOUNDS.castDelay),
    recharge: toSeconds(r.int(20, 28), CONFIG_BOUNDS.recharge), capacity, shuffle: 0, spellsPerCast: 1 };
  return { id: `starter-${hashSeed(seed).toString(36)}`, name: 'Bolt staff', tier: 1,
    cards: Array(Math.min(r.int(1, 3), capacity)).fill('spark'), config,
    look: { tier: 1, rare: false, slots: capacity, length: 1, hue: 30, gem: '#efcf79' } };
}

// Noita's second starter is a 1-slot bomb wand; its numbers aren't in the data
// mirror's Lua (an entity file), so it shares the Bolt staff's and holds a bomb.
export function bombWand(seed = 0) {
  const w = starterWand(`bomb-${seed}`);
  return { ...w, id: `bomb-${hashSeed(seed).toString(36)}`, name: 'Bomb wand', cards: ['bomb'], config: { ...w.config, capacity: 1 } };
}

// randomSpell(tier, seed): a spell id as a shop or a spell pickup at tier 1..3
// offers it (generate_shop_item.lua: GetRandomAction(level = tier), any type).
export function randomSpell(tier, seed = 0) {
  tier = clamp(Math.round(Number(tier) || 1), 1, TIERS);
  return action(rng(hashSeed('spell', tier, seed)), tier, [P, M, D, U, T]);
}

// spellPrice(tier, id) / wandPrice(tier, wand): gold, as Noita's shops ask
export function spellPrice(tier, id, { sale = false } = {}) {
  const level = clamp(Math.round(Number(tier) || 1), 1, TIERS);
  const base = SPELL_POOL[id]?.price ?? SPELL_POOL.spark.price;
  const price = Math.max(Math.floor((base * SPELL_PRICE_SHARE + SPELL_PRICE_PER_LEVEL2 * level * level) / PRICE_ROUND) * PRICE_ROUND, SPELL_PRICE_MIN);
  return sale ? price * SALE : price;
}
export function wandPrice(tier, wand = null, { sale = false } = {}) {
  const level = clamp(Math.round(Number(tier) || 1), 1, TIERS);
  const r = rng(hashSeed('price', level, wand?.id ?? ''));
  const scale = 0.5 * level + 0.5 * level * level;
  const price = WAND_PRICE_BASE + scale * WAND_PRICE_PER_LEVEL + r.int(-WAND_PRICE_JITTER, WAND_PRICE_JITTER) * PRICE_ROUND;
  return sale ? price * SALE : price;
}

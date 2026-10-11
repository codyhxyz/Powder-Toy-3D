// Node check for Noita's procedural wands (src/pov/wands/generate.js):
// determinism, per-tier stat ranges, every generated deck compiles, prices.
import assert from 'node:assert/strict';
import { SPELL_BY_ID } from '../src/pov/wands/catalog.js';
import { compileWand, CONFIG_BOUNDS } from '../src/pov/wands/compiler.js';
import { generateWand, starterWand, bombWand, randomSpell, spellPrice, wandPrice, SPELL_POOL, unpooled, TIERS } from '../src/pov/wands/generate.js';

const N = 400;   // wands per tier
assert.deepEqual(unpooled(), [], 'every spell has a Noita pool entry');
for (const id of Object.keys(SPELL_POOL)) assert(SPELL_BY_ID[id], `pool entry ${id} is a spell`);

assert.deepEqual(generateWand(2, 1234), generateWand(2, 1234), 'same seed, same wand');
assert.deepEqual(generateWand(1, 'mines:3'), generateWand(1, 'mines:3'));
assert.notDeepEqual(generateWand(1, 1).config, generateWand(1, 2).config);
assert.equal(randomSpell(2, 9), randomSpell(2, 9));

const summary = [];
for (let tier = 1; tier <= TIERS; tier++) {
  const s = { tier, mana: [Infinity, -Infinity], regen: [Infinity, -Infinity], capacity: [Infinity, -Infinity],
    delay: [Infinity, -Infinity], recharge: [Infinity, -Infinity], perCast: [Infinity, -Infinity], shuffled: 0, capSum: 0, manaSum: 0 };
  const ids = new Set();
  for (let seed = 0; seed < N; seed++) {
    const w = generateWand(tier, seed);
    ids.add(w.id);
    assert.equal(w.tier, tier);
    assert(w.name.endsWith('wand'), w.name);
    const result = compileWand(w.cards, w.config);
    assert.deepEqual(result.errors, [], `tier ${tier} seed ${seed}: ${w.cards.join(',')}`);
    for (const [key, [lo, hi]] of Object.entries(CONFIG_BOUNDS)) {
      assert(w.config[key] >= lo && w.config[key] <= hi, `${key} ${w.config[key]} in bounds`);
      assert.equal(result.config[key], w.config[key], `${key} survives compilation unchanged`);
    }
    assert(w.cards.length >= 1 && w.cards.length <= w.config.capacity);
    assert(w.config.spellsPerCast <= w.config.capacity);
    const c = w.config;
    // Noita ranges (gun_procedural.lua): mana_max ≥ 50, charge ≥ 10, capacity 2..26
    assert(c.manaMax >= 50 && c.manaRegen >= 10 && c.capacity >= 2 && c.capacity <= 26, JSON.stringify(c));
    // mana_max ≤ (50 + 150·level + 50)·3 (the slow charger), charge ≤ (50·level + 5·level)·5 (the fast one)
    assert(c.manaMax <= (100 + 150 * tier) * 3 && c.manaRegen <= 55 * tier * 5, JSON.stringify(c));
    for (const [k, v] of [['mana', c.manaMax], ['regen', c.manaRegen], ['capacity', c.capacity], ['delay', c.castDelay], ['recharge', c.recharge], ['perCast', c.spellsPerCast]]) {
      s[k][0] = Math.min(s[k][0], v); s[k][1] = Math.max(s[k][1], v);
    }
    s.shuffled += c.shuffle; s.capSum += c.capacity; s.manaSum += c.manaMax;
  }
  assert(ids.size > N * 0.95, 'seeds give distinct ids');
  summary.push(s);
}
// higher tiers: more mana and more slots on average (Noita's budget grows 30 → 40 → 60)
for (let i = 1; i < summary.length; i++) {
  assert(summary[i].manaSum > summary[i - 1].manaSum, 'mana grows with tier');
  assert(summary[i].capSum > summary[i - 1].capSum * 0.95, 'capacity does not shrink with tier');
}
assert(summary[0].capSum / N < 8, 'tier 1 capacity is small');

const starter = starterWand(7);
assert.deepEqual(compileWand(starter.cards, starter.config).errors, []);
assert(starter.config.capacity >= 2 && starter.config.capacity <= 3 && starter.cards.every((id) => id === 'spark'));
assert(starter.config.manaMax >= 80 && starter.config.manaMax <= 130 && starter.config.shuffle === 0);
assert.deepEqual(compileWand(bombWand(7).cards, bombWand(7).config).errors, []);

// prices: generate_shop_item.lua
assert.equal(spellPrice(1, 'spark'), 100);          // floor((100·0.3 + 70)/10)·10
assert.equal(spellPrice(2, 'spark'), 310);          // floor((30 + 280)/10)·10
assert.equal(spellPrice(3, 'bomb'), 690);           // floor((60 + 630)/10)·10
assert.equal(spellPrice(1, 'spark', { sale: true }), 50);
for (let tier = 1; tier <= TIERS; tier++) {
  const mid = 50 + (0.5 * tier + 0.5 * tier * tier) * 210;
  for (let seed = 0; seed < 50; seed++) {
    const p = wandPrice(tier, generateWand(tier, seed));
    assert(p >= mid - 150 && p <= mid + 150 && p % 10 === 0, `wand price ${p} at tier ${tier}`);
  }
  for (let seed = 0; seed < 200; seed++) {
    const id = randomSpell(tier, seed);
    assert(SPELL_BY_ID[id], id);
  }
}

for (const s of summary) {
  console.log(`tier ${s.tier}: mana ${s.mana.join('–')} (avg ${Math.round(s.manaSum / N)}), regen ${s.regen.join('–')}, slots ${s.capacity.join('–')} (avg ${(s.capSum / N).toFixed(1)}), `
    + `delay ${s.delay.join('–')} s, recharge ${s.recharge.join('–')} s, spells/cast ${s.perCast.join('–')}, shuffled ${Math.round(s.shuffled / N * 100)}%`);
}
console.log(`wand generation checks passed: ${N * TIERS} wands compile, deterministic seeds, Noita ranges, shop prices`);

// Descent's run inventory (wands/descentRun.js): four slots, a full hand swaps with the held wand, a spell bag.
{
  const { descentWands: d, WAND_SLOTS } = await import('../src/pov/wands/descentRun.js');
  const drops = [], refreshes = [];
  d.on('drop', (w) => drops.push(w.id));
  d.on('refresh', () => refreshes.push(1));
  d.reset(5);
  assert.equal(d.wands.length, 2, "Noita's two starting wands");
  for (const w of d.wands) assert.deepEqual(compileWand(w.cards, w.config).errors, []);
  for (let seed = 0; seed < WAND_SLOTS - 2; seed++) assert.equal(d.give(generateWand(1, seed)).dropped, null);
  assert.equal(d.wands.length, WAND_SLOTS);
  d.held = 1;
  const old = d.wands[1].id, got = d.give(generateWand(2, 77));
  assert.equal(got.slot, 1);
  assert.equal(got.dropped.id, old);
  assert.deepEqual(drops, [old], 'the swapped wand drops');
  assert.equal(d.give({ cards: ['nope'], config: {} }), null, 'a bad wand is refused');
  assert(d.giveSpell('spark') && !d.giveSpell('nope'));
  assert(d.edit(1, ['spark', 'spark'], []));
  assert.deepEqual(d.wands[1].cards, ['spark', 'spark']);
  assert.deepEqual(d.bag, []);
  d.refresh();
  assert.equal(refreshes.length, 1);
  console.log('descent run inventory checks passed: 4 slots, swap drops the held wand, spell bag, edit, refresh');
}

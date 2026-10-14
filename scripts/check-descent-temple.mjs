// Node checks for the Holy Mountain's pure parts (src/pov/descent): gold math,
// shop stock determinism and Noita's pricing. No browser, no GPU.
//   node scripts/check-descent-temple.mjs
import assert from 'node:assert/strict';
import { createPurse, siteNuggets, splitGold, enemyGold, NUGGET, NUGGETS_PER_SITE, ENEMY_GOLD_DEFAULT } from '../src/pov/descent/gold.js';
import { rollShop, buy, SHOP_WANDS } from '../src/pov/descent/shop.js';
import { mixSeed, hashString, rng } from '../src/rng.js';
import * as gen from '../src/pov/descent/stubs.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };

ok('rng is deterministic and in [0, 1)', () => {
  const a = rng(42), b = rng(42);
  for (let i = 0; i < 1000; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
  assert.notEqual(mixSeed(1, 2), mixSeed(2, 1));
  assert.equal(hashString('descentMines'), hashString('descentMines'));
});

ok('splitGold uses Noita denominations, largest first', () => {
  assert.deepEqual(splitGold(270), [200, 50, 10, 10]);
  assert.deepEqual(splitGold(20), [10, 10]);
  assert.deepEqual(splitGold(5), []);
  for (const a of [0, 10, 30, 60, 200, 470, 1230]) assert.equal(splitGold(a).reduce((s, x) => s + x, 0), a);
});

ok('site nuggets: tier 1 all 10s, deeper ones bigger, deterministic', () => {
  for (let s = 0; s < 200; s++) assert.deepEqual(siteNuggets(1, s), Array(NUGGETS_PER_SITE).fill(NUGGET.SMALL));
  assert.deepEqual(siteNuggets(3, 99), siteNuggets(3, 99));
  const sum = (t) => { let x = 0; for (let s = 0; s < 500; s++) x += siteNuggets(t, s).reduce((a, b) => a + b, 0); return x; };
  assert.ok(sum(1) < sum(2) && sum(2) < sum(3), 'deeper sites hold more gold');
});

ok('enemy gold by spawner kind', () => {
  assert.equal(enemyGold('enemy'), 20);
  assert.equal(enemyGold('giantworm'), 200);
  assert.equal(enemyGold('nope'), ENEMY_GOLD_DEFAULT);
});

ok('purse: add, spend refuses overdraft, reset', () => {
  const p = createPurse();
  p.add(10); p.add(50);
  assert.equal(p.gold, 60);
  assert.equal(p.spend(100), false); assert.equal(p.gold, 60);
  assert.equal(p.spend(60), true); assert.equal(p.gold, 0);
  p.add(-5); assert.equal(p.gold, 0);
  p.reset(); assert.equal(p.gold, 0);
});

ok("Noita's shop price formula", () => {
  // price = max(floor((cost × 0.30 + 70 × level) / 10) × 10, 10)
  assert.equal(gen.shopPrice(100, 1), 100);    // a Spark Bolt in the first temple
  assert.equal(gen.shopPrice(200, 2), 200);
  assert.equal(gen.shopPrice(0, 0), 10);
  for (const id of ['spark', 'bomb', 'black-hole']) for (const t of [1, 2, 3]) {
    const p = gen.spellPrice(id, t);
    assert.ok(p % 10 === 0 && p >= 10, `${id} t${t}: ${p}`);
    if (t > 1) assert.ok(p > gen.spellPrice(id, t - 1), 'deeper costs more');
  }
});

ok('shop stock: deterministic per seed, 5 pedestals, wand or spell shop', () => {
  const a = rollShop(2, 1234, 5, gen), b = rollShop(2, 1234, 5, gen);
  assert.deepEqual(a, b);
  assert.equal(a.length, 5);
  let wandShops = 0;
  for (let s = 0; s < 400; s++) {
    const st = rollShop(1, mixSeed(s, 7), 5, gen);
    const wands = st.filter((x) => x.kind === 'wand').length;
    assert.ok(wands === 0 || wands === SHOP_WANDS, `wands ${wands}`);
    if (wands) wandShops++;
    for (const it of st) {
      assert.ok(it.price >= 10 && it.price % 10 === 0);
      if (it.kind === 'spell') assert.equal(typeof it.spell, 'string');
      else assert.ok(Array.isArray(it.wand.cards) && it.wand.config.manaMax > 0);
    }
  }
  assert.ok(wandShops > 140 && wandShops < 260, `about half are wand shops: ${wandShops}/400`);
});

ok('buy: enough gold buys once, too little refuses and takes nothing', () => {
  const [item] = rollShop(1, 5, 1, gen);
  const p = createPurse(item.price - 10);
  assert.equal(buy(item, p), 'poor'); assert.equal(p.gold, item.price - 10); assert.ok(!item.sold);
  p.add(10);
  assert.equal(buy(item, p), 'bought'); assert.equal(p.gold, 0);
  p.add(1000);
  assert.equal(buy(item, p), 'sold'); assert.equal(p.gold, 1000);
});

console.log(`\n${n} checks passed`);

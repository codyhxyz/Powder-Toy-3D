// Node checks for Descent's items (docs/descent-contract.md, "Items"): potion
// flasks (src/pov/descent/flasks.js) and treasure chests (chests.js) roll the
// same things from the same site, their materials are real liquids, every
// chest wand compiles, the levels carry their chest and potion sites, and the
// run's item slots (wands/descentRun.js) keep flasks across a level switch
// (runSnapshot) and empty on a new run. No browser.
//   node scripts/check-descent-items.mjs
import assert from 'node:assert/strict';
import { E, ELEMENTS, K } from '../src/elements.js';
import { PX as NOITA_PX } from '../src/pov/player.js';
import { POTION_BANDS, rollPotion, makeFlask, FLASK_CELLS } from '../src/pov/descent/flasks.js';
import { rollChest, CHEST_NUGGETS, CHEST_ROLLS } from '../src/pov/descent/chests.js';
import { DESCENT_LEVELS } from '../src/world/scenes/descent/levels.js';
import { generateWand, randomSpell } from '../src/pov/wands/generate.js';
import { compileWand } from '../src/pov/wands/compiler.js';
import { SPELL_BY_ID } from '../src/pov/wands/catalog.js';
import { descentWands, POTION_SLOTS } from '../src/pov/wands/descentRun.js';
import { runSnapshot, runLost } from '../src/pov/descent/switch.js';

let n = 0, failed = 0;
const ok = (name, fn) => { try { fn(); n++; console.log('ok ', name); } catch (err) { failed++; console.log('FAIL', name, '\n  ', err.message); } };
const SAMPLES = 3000;

ok('potion materials are liquids this game has', () => {
  for (const key of Object.values(POTION_BANDS).flat()) {
    assert.ok(E[key] !== undefined, `${key} is an element`);
    assert.equal(ELEMENTS[E[key]].kind, K.LIQUID, `${key} is a liquid`);
  }
});
ok('a flask holds what the flask tool holds (Noita 1000 units at its pixel size)', () => {
  assert.equal(FLASK_CELLS, Math.round(1000 * NOITA_PX ** 3));
  const f = makeFlask('ACID', 'x');
  assert.equal(f.cells.length, FLASK_CELLS);
  assert.ok(f.cells.every((c) => c[0] === E.ACID && c[3] >= 0 && c[3] < 1));
});
ok('rollPotion: the same site rolls the same potion', () => {
  for (let i = 0; i < 200; i++) for (const t of [1, 2, 3]) assert.equal(rollPotion(t, `s${i}`), rollPotion(t, `s${i}`));
  assert.deepEqual(makeFlask('WATER', 'a').cells, makeFlask('WATER', 'a').cells);
});
ok('rollPotion: mostly common, rare ones rarer, deeper levels more magic', () => {
  const band = (key) => Object.entries(POTION_BANDS).find(([, l]) => l.includes(key))[0];
  const share = (t) => {
    const c = { common: 0, uncommon: 0, rare: 0 };
    for (let i = 0; i < SAMPLES; i++) c[band(rollPotion(t, `site-${i}`))]++;
    return c;
  };
  const s1 = share(1), s3 = share(3);
  console.log('    tier 1', s1, ' tier 3', s3);
  assert.ok(s1.common > s1.uncommon && s1.uncommon > s1.rare && s1.rare > 0);
  assert.ok(s3.rare > s1.rare && s3.common < s1.common);
  // every material turns up
  const seen = new Set();
  for (let i = 0; i < SAMPLES; i++) seen.add(rollPotion(3, `all-${i}`));
  assert.equal(seen.size, Object.values(POTION_BANDS).flat().length);
});
ok('rollChest: deterministic, always gold, wands compile, spells exist', () => {
  let wands = 0, spells = 0, potions = 0;
  for (let i = 0; i < 300; i++) for (const t of [1, 2, 3]) {
    const site = `descentMines:chest:${i}`;
    const a = rollChest(t, site);
    assert.deepEqual(a, rollChest(t, site));
    const gold = a.filter((x) => x.kind === 'gold');
    assert.ok(gold.length >= CHEST_NUGGETS[0], 'a chest always holds gold');
    assert.ok(a.length <= CHEST_NUGGETS[1] + CHEST_ROLLS * Math.max(CHEST_NUGGETS[0], 2));
    for (const x of a) {
      if (x.kind === 'wand') { wands++; const w = generateWand(t, x.seed); assert.equal(compileWand(w.cards, w.config).errors.length, 0); assert.deepEqual(w, generateWand(t, x.seed)); }
      if (x.kind === 'spell') { spells++; assert.ok(SPELL_BY_ID[randomSpell(t, x.seed)]); }
      if (x.kind === 'potion') { potions++; assert.equal(x.material, rollPotion(t, x.seed)); }
    }
  }
  console.log(`    900 chests: ${wands} wands, ${spells} spells, ${potions} potions`);
  assert.ok(wands > 0 && spells > 0 && potions > 0);
});
ok('levels.js: each level has 2–3 chests, 6 potions, ~25 gold sites', () => {
  for (const L of DESCENT_LEVELS) {
    assert.ok(L.chests.length >= 2 && L.chests.length <= 3, `${L.key} chests ${L.chests.length}`);
    assert.equal(L.potions.length, 6);
    assert.ok(L.loot.filter((l) => l.kind === 'gold').length >= 25);
    assert.equal(L.loot.filter((l) => l.kind === 'wand').length, 5);
    assert.equal(L.loot.filter((l) => l.kind === 'spell').length, 6);
  }
});
ok('the run keeps its flasks: item slots, poured contents, a level switch, a throw, a new run', () => {
  descentWands.reset(1);
  assert.equal(descentWands.potions.length, 0);
  const L = DESCENT_LEVELS[0];
  const picks = L.potions.map((s, i) => makeFlask(rollPotion(L.tier, `${L.key}:potion:${i}`), `${L.key}:potion:${i}`));
  for (let i = 0; i < POTION_SLOTS; i++) assert.equal(descentWands.givePotion(picks[i]), i);
  assert.equal(descentWands.givePotion(picks[4]), -1, 'Noita\'s four item slots: the fifth is refused');
  // the flask tool poured half of slot 1 out (tools/index.js keepPotion)
  descentWands.setPotionCells(1, descentWands.potions[1].cells.slice(0, 60));
  const before = runSnapshot({ wands: descentWands });
  // a level switch: the world is replaced and the tools' loads emptied, but the run's state is module state
  const after = runSnapshot({ wands: descentWands });
  assert.deepEqual(runLost(before, after), []);
  assert.equal(after.potions[1], `${picks[1].material}:60`);
  // the run's copy is its own: changing what was given doesn't reach it
  picks[0].cells.length = 0;
  assert.equal(descentWands.potions[0].cells.length, FLASK_CELLS);
  // a thrown flask is gone
  descentWands.removePotion(2);
  assert.equal(descentWands.potions.length, POTION_SLOTS - 1);
  assert.ok(runLost(after, runSnapshot({ wands: descentWands })).includes('potions'));
  // taken sites stay taken for the run, a new run empties it all
  descentWands.markTaken(`${L.key}:potion:0`);
  assert.ok(descentWands.taken(`${L.key}:potion:0`));
  let resets = 0;
  const off = descentWands.on('reset', () => resets++);
  descentWands.reset(2);
  off();
  assert.equal(resets, 1);
  assert.equal(descentWands.potions.length, 0);
  assert.ok(!descentWands.taken(`${L.key}:potion:0`));
});
ok('a chest\'s wand goes out as a pickup (descentWands.place)', () => {
  const got = [];
  const off = descentWands.on('place', (x) => got.push(x));
  descentWands.place({ kind: 'wand', wand: generateWand(1, 'c'), world: [1, 2, 3], site: 'c' });
  off();
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].world, [1, 2, 3]);
});

console.log(failed ? `${failed} of ${n + failed} failed` : `${n} checks passed`);
process.exit(failed ? 1 : 0);

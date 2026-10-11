// Pure Node: validates plans, not GPU effects, projectile scheduling or visuals.
// Run: node scripts/check-wand-compiler.mjs
import assert from 'node:assert/strict';
import { SPELLS, SPELL_BY_ID, PRESETS, DEFAULT_CONFIG } from '../src/pov/wands/catalog.js';
import { compileWand, LIMITS } from '../src/pov/wands/compiler.js';
import { E } from '../src/elements.js';

const valid = (cards, config) => {
  const result = compileWand(cards, config);
  assert.deepEqual(result.errors, [], JSON.stringify(cards));
  assert.ok(result.casts.length);
  return result;
};
const invalid = (cards, config, message) => {
  const result = compileWand(cards, config);
  assert.ok(result.errors.length, `Expected invalid: ${JSON.stringify(cards)}`);
  assert.deepEqual(result.casts, [], 'Invalid plans must not expose fireable roots');
  if (message) assert.match(result.errors.join(' '), message);
  return result;
};
const visit = (node, fn) => {
  fn(node);
  node.children?.forEach((child) => visit(child, fn));
  if (node.payload) visit(node.payload, fn);
};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

assert.equal(new Set(SPELLS.map((spell) => spell.id)).size, SPELLS.length);
assert.equal(new Set(PRESETS.map((preset) => preset.id)).size, PRESETS.length);
const required = ['mining-vacuum', 'tunnel-cutter', 'acid-shotgun', 'spark-machinegun',
  'stored-scrap-machinegun', 'recoil-flying', 'water-extinguisher', 'liquid-sponge',
  'stored-lava-mortar', 'remote-black-hole', 'double-explosion', 'delayed-second-explosion',
  'ice-bridge', 'cave-lantern', 'powder-and-ignition', 'teleport'];
for (const id of required) assert.ok(PRESETS.some((preset) => preset.id === id), id);
const recipe = (id) => {
  const p = PRESETS.find((p) => p.id === id);
  return valid(p.cards, p.config).casts[0];
};
const cutter = recipe('tunnel-cutter');
assert.ok(cutter.children[0].params.radius < SPELL_BY_ID.dig.params.radius);
assert.ok(cutter.children[0].params.power > SPELL_BY_ID.dig.params.power);
assert.equal(cutter.children[1].effect, 'light');
assert.equal(recipe('remote-black-hole').trigger, 'timer');
assert.equal(recipe('remote-black-hole').payload.effect, 'erase', 'Black holes must excavate, not merely attract');
assert.equal(recipe('cave-lantern').trigger, 'timer', 'A lantern must deploy in open air');
for (const preset of PRESETS) {
  assert.ok(Number.isInteger(preset.slot) && preset.slot >= 1 && preset.slot <= 10);
  const plan = valid(preset.cards, preset.config);
  assert.ok(plan.stats.maxCastMana <= plan.config.manaMax, `${preset.id} must be fireable from full mana`);
  assert.ok(plan.stats.nodeCount <= LIMITS.nodes);
  assert.ok(plan.stats.maxDepth <= LIMITS.depth);
  assert.ok(plan.stats.castDelays.every((delay) => delay >= LIMITS.minCooldown));
  for (const root of plan.casts) visit(root, (node) => {
    assert.ok(['projectile', 'beam', 'touch', 'field', 'self', 'multi', 'burst'].includes(node.op));
    for (const value of Object.values(node.params)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
    if (node.params.material) assert.ok(Object.hasOwn(E, node.params.material));
    if (node.params.trail) assert.ok(Object.hasOwn(E, node.params.trail));
  });
  if (preset.sandboxReservoir) {
    assert.ok(Object.hasOwn(E, preset.sandboxReservoir.material));
    assert.ok(preset.sandboxReservoir.count > 0 && preset.sandboxReservoir.label.includes('Sandbox'));
    assert.ok(preset.cards.some((id) => SPELL_BY_ID[id].params?.stored));
  }
}
// Every editor entry is usable, not just the cards exercised by presets.
for (const spell of SPELLS) {
  assert.ok(spell.name && spell.description && spell.category);
  const args = spell.op === 'modifier' ? ['spark'] : spell.op === 'trigger' ? ['carrier', 'explosion']
    : spell.arity ? Array(spell.arity).fill('spark') : [];
  valid([spell.id, ...args]);
}

for (const cards of [null, {}, 'spark', [], [null], [5], [{}], ['missing'], ['__proto__'], ['constructor'], Array(2)]) invalid(cards);
for (const config of [null, [], 'bad', { manaMax: NaN }, { manaRegen: Infinity }, { castDelay: -Infinity }, { recharge: '1' }, { capacity: undefined }]) invalid(['spark'], config);
const clamped = valid(['spark'], { manaMax: -5, manaRegen: -10, castDelay: 0, recharge: 1e20, capacity: 99, shuffle: 7, spellsPerCast: 0 });
assert.deepEqual(clamped.config, { manaMax: 1, manaRegen: 0, castDelay: 0.02, recharge: 60, capacity: 64, shuffle: 1, spellsPerCast: 1 });
assert.equal(valid(['spark'], { spellsPerCast: 2.7, shuffle: 0.5 }).config.spellsPerCast, 2);
assert.equal(valid(['spark'], { shuffle: 0.5 }).config.shuffle, 0);
invalid(['spark'], { shuffle: true });
assert.equal(valid(['spark'], { capacity: 1.9 }).config.capacity, 1);
assert.deepEqual(valid(['spark']).config, DEFAULT_CONFIG);
invalid(Array(33).fill('spark'), undefined, /capacity/);
invalid(Array(65).fill('spark'), { capacity: 1000 }, /capacity/);
invalid(Array(100000).fill('missing'), undefined, /capacity/);
valid(Array(64).fill('spark'), { capacity: 64 });
for (const cards of [['wide'], ['multi-2', 'spark'], ['multi-3', 'spark', 'spark'], ['burst'], ['impact', 'carrier'], ['timer'], ['expiry', 'dig', 'spark'], ['impact', 'multi-2', 'spark', 'spark', 'explosion'], ['impact', 'impact', 'carrier', 'spark', 'spark']]) invalid(cards);
invalid(['spark', 'wide']); // no wrapping back to the first card
invalid([...Array(LIMITS.depth).fill('wide'), 'spark'], { capacity: 64 }, /depth/);
valid([...Array(LIMITS.depth - 1).fill('wide'), 'spark']);
const big = valid([...Array(4).fill('burst'), 'spark']);
assert.equal(big.stats.nodeCount, 121);
invalid([...Array(5).fill('burst'), 'spark'], undefined, /Expanded/);
invalid([...Array(3).fill(['burst', 'burst', 'burst', 'burst', 'spark']).flat()], undefined, /Expanded/);

let plan = valid(['wide', 'impact', 'carrier', 'explosion']);
assert.equal(plan.casts[0].params.radius, 2);
assert.equal(plan.casts[0].payload.params.radius, 6, 'Outer modifier must not leak into payload');
plan = valid(['impact', 'wide', 'carrier', 'power', 'explosion', 'spark']);
assert.equal(plan.casts.length, 2);
assert.equal(plan.casts[0].params.radius, 2);
assert.equal(plan.casts[0].payload.params.power, 70);
assert.equal(plan.casts[0].params.power, 0);
assert.equal(plan.casts[1].params.radius, 1, 'Modifiers must not leak into successive roots');
plan = valid(['wide', 'multi-2', 'spark', 'impact', 'carrier', 'explosion']);
assert.deepEqual(plan.casts[0].children.map((node) => node.params.radius), [2, 2]);
assert.equal(plan.casts[0].children[1].payload.params.radius, 6);
plan = valid(['multi-2', 'wide', 'spark', 'spark']);
assert.deepEqual(plan.casts[0].children.map((node) => node.params.radius), [2, 1]);
plan = valid(['focused', 'scatter', 'spark']);
assert.deepEqual(plan.casts[0].children.map((node) => node.params.spread), [0, 0, 0]);
plan = valid(['scatter', 'impact', 'carrier', 'explosion']);
assert.equal(plan.casts[0].children.length, 3);
assert.equal(plan.casts[0].params.mana, 3 + 3 * (3 + 2 + 20));
assert.equal(plan.casts[0].children[0].params.mana, 25, 'Each child total includes prepaid payload');
assert.notEqual(plan.casts[0].children[0].payload, plan.casts[0].children[1].payload);
plan.casts[0].children[0].payload.params.power = 999;
assert.equal(plan.casts[0].children[1].payload.params.power, 35, 'Expanded copies must be independent');
assert.equal(SPELL_BY_ID.explosion.params.power, 35, 'Compilation must not mutate catalog');

plan = valid(['wide', 'burst', 'spark']);
assert.equal(plan.stats.totalMana, 6 + 2 + 3 * 5);
assert.equal(valid(['burst', 'wide', 'spark']).stats.totalMana, 2 + 3 * (6 + 5));
assert.equal(plan.casts[0].params.interval, 0.09);
plan = valid(['timer', 'carrier', 'impact', 'carrier', 'explosion']);
assert.equal(plan.casts[0].trigger, 'timer');
assert.equal(plan.casts[0].params.delay, 0.6);
assert.equal(plan.casts[0].payload.trigger, 'impact');
assert.equal(plan.stats.totalMana, 30);
assert.equal(plan.stats.nodeCount, 3);
assert.equal(plan.stats.maxDepth, 3);
plan = valid(['impact', 'carrier', 'multi-2', 'explosion', 'explosion', 'rapid', 'spark']);
assert.equal(plan.stats.totalMana, 56);
assert.equal(plan.stats.maxCastMana, 47);
close(plan.casts[0].params.castDelay, 0.2);
close(plan.stats.castDelays[0], 0.38);
close(plan.stats.castDelays[1], 0.06);
close(plan.stats.recharge, 0.65);
plan = valid([...Array(10).fill('rapid'), ...Array(4).fill('quick-recharge'), 'spark']);
assert.equal(plan.stats.castDelays[0], 0.02);
assert.equal(plan.stats.recharge, 0.02);
plan = valid(['burst', 'explosion'], { castDelay: 30, recharge: 60 });
assert.equal(plan.stats.castDelays[0], 30);
assert.equal(plan.stats.recharge, 60);
assert.equal(valid([...Array(8).fill('wide'), 'spark']).casts[0].params.radius, 24);
assert.equal(valid([...Array(8).fill('speed'), 'spark']).casts[0].params.speed, 240);

console.log(`wand compiler: ${PRESETS.length} presets, ${SPELLS.length} cards; validation, arity, bounds, scope, prepaid costs and cooldown checks passed`);

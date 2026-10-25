import test from 'node:test';
import assert from 'node:assert/strict';
import { ELEMENTS, K, E, elementRow, TOOLS } from '../src/elements.js';
import { MATERIAL_TAGS, describeTag, materialTags, validateTraits, materialTransitions } from '../src/materialTraits.js';
import { createExhibitCatalog, requirementsForTags, STORAGE_REQUIREMENTS, EFFECT_KEYS } from '../src/lab/catalog.js';
import { elementFacts } from '../src/lab/facts.js';
import { NUCLEAR, EMITTERS } from '../src/rays.js';
import { PHASE_ROWS } from '../src/v2/phase.js';
const el = key => ELEMENTS[E[key]];
const fact = (key, id) => elementFacts(el(key)).find(f => f.key === id);

test('catalog covers every registry row exactly once, including air and hidden terrain', () => {
  const catalog = createExhibitCatalog(), materials = catalog.filter(e => e.type === 'material');
  assert.equal(materials.length, ELEMENTS.length);
  for (const e of ELEMENTS) {
    assert.equal(materials.filter(c => c.elementId === e.id && c.key === e.key).length, 1, e.key);
  }
  assert.ok(materials.some(e => e.key === 'EMPTY'));
  assert.ok(materials.some(e => e.key === 'NOITA_LUSH'));
  assert.equal(materials.filter(e => e.key === 'METAL').length, 1);
  assert.equal(catalog.length, ELEMENTS.length + EFFECT_KEYS.length);
});
test('only named photon, neutron and spark effects are admitted from tools', () => {
  const catalog = createExhibitCatalog(), effects = catalog.filter(e => e.category === 'effect');
  assert.deepEqual(effects.map(e => e.key), ['PHOTON', 'NEUTRON', 'SPARK']);
  for (const e of effects) {
    assert.equal(e.elementId, null); assert.ok(e.toolId < 0);
    assert.equal(e.status, 'plaque-only'); assert.ok(e.reason);
  }
  assert.ok(!catalog.some(e => e.key === 'HEAT' || e.key === 'ERASE'));
  assert.throws(() => createExhibitCatalog([...ELEMENTS, TOOLS[0]]), /tools are not materials/);
  assert.deepEqual(elementFacts(TOOLS[0]), []);
});
test('an appended synthetic element needs no catalog list or palette edit', () => {
  const synthetic = elementRow({ key: 'TEST_NEW', name: 'New material', kind: K.LIQUID, dens: 13, cap: 1, cond: 0.01 }, ELEMENTS.length);
  const entry = createExhibitCatalog([...ELEMENTS, synthetic]).find(e => e.key === synthetic.key);
  assert.equal(entry.elementId, synthetic.id);
  assert.ok(entry.tags.includes('liquid')); assert.ok(entry.requirements.includes('basin'));
  assert.throws(() => createExhibitCatalog([...ELEMENTS, synthetic, synthetic]), /Duplicate/);
});
test('tag vocabulary is readable and malformed, unknown or redundant author tags fail', () => {
  for (const key of Object.keys(MATERIAL_TAGS)) {
    const description = describeTag(key); assert.ok(description.label && description.description && description.group);
    requirementsForTags([key]); // Every validated tag must have an explicit storage policy.
  }
  for (const traits of [null, 'growing', {}, [null], [{}], ['growng'], ['__proto__'], ['liquid']]) {
    assert.throws(() => materialTags({ ...el('WOOD'), traits }), /traits|material tag/);
  }
  assert.deepEqual(validateTraits(['growing', 'growing']), ['growing']);
  assert.throws(() => requirementsForTags(['unsupported']), /Unknown material tag/);
  assert.throws(() => requirementsForTags(null), /array/);
});
test('combined hazards compose rather than override requirements', () => {
  const synthetic = elementRow({ key: 'TEST_COMBO', name: 'Combined hazards', kind: K.GAS,
    cap: 1, cond: 0.01, acid: true, elec: 3, ignite: 100, blast: { P: 1 }, traits: ['decaying', 'growing', 'replicating', 'matter-consuming', 'potion'] }, ELEMENTS.length);
  const entry = createExhibitCatalog([synthetic])[0];
  for (const key of ['sealed', 'corrosion-resistant', 'electrical-isolation', 'ignition-separation', 'pressure-shielding', 'replenishment', 'growth-isolation', 'replication-isolation', 'matter-isolation', 'body-isolation']) {
    assert.ok(entry.requirements.includes(key), key);
  }
  assert.equal(new Set(entry.requirements).size, entry.requirements.length);
  assert.equal(entry.status, 'plaque-only');
});
test('nuclear and spontaneous emission membership comes from actual nuclear data', () => {
  for (const e of ELEMENTS) {
    const n = NUCLEAR[e.key], tags = materialTags(e);
    assert.equal(tags.includes('radioactive'), !!(n?.fF > 0 || n?.fT > 0), e.key);
    assert.equal(tags.includes('neutron-emitter'), EMITTERS[e.key] > 0, e.key);
  }
  assert.ok(!materialTags(el('WATER')).includes('radioactive'));
  assert.ok(materialTags(el('PLUTONIUM')).includes('neutron-emitter'));
  assert.ok(!materialTags(el('URANIUM')).includes('neutron-emitter'));
});
test('unsupported storage is plaque-only with reasons; no entry claims indefinite safety', () => {
  for (const entry of createExhibitCatalog()) {
    const unsupported = entry.requirements.filter(key => !STORAGE_REQUIREMENTS[key].supported);
    if (unsupported.length) {
      assert.equal(entry.status, 'plaque-only', entry.key);
      for (const key of unsupported) assert.ok(entry.reason.includes(STORAGE_REQUIREMENTS[key].reason));
    } else {
      assert.equal(entry.status, 'candidate'); assert.match(entry.reason, /no recipe is proven safe indefinitely/);
    }
  }
  assert.match(createExhibitCatalog().find(e => e.key === 'ICE').reason, /Temperature control is not implemented/);
  assert.equal(createExhibitCatalog().find(e => e.key === 'DUST').status, 'plaque-only');
});
test('facts distinguish boiling products, decomposition and explicit zero-degree transitions', () => {
  assert.match(fact('ACID', 'hot').chips[0], /Boils/);
  assert.deepEqual(fact('ACID', 'hot').products.map(p => p.key).sort(), ['CAUSTIC_GAS', 'STEAM']);
  const decomposition = elementRow({ key: 'TEST_DECOMPOSE', name: 'Decomposition fixture', kind: K.POWDER, dens: 10, cap: 1, cond: 0.01, hot: { T: 200, into: [['CO2', 0.5], ['ASH', 0.5]] } }, ELEMENTS.length);
  const decomposed = elementFacts(decomposition).find(f => f.key === 'hot');
  assert.match(decomposed.chips[0], /Decomposes/);
  assert.deepEqual(decomposed.products, [{ key: 'CO2', share: 0.5 }, { key: 'ASH', share: 0.5 }]);
  assert.equal(fact('SLIME', 'cold').temperature, 0);
  assert.equal(fact('WATER', 'cold').temperature, 0);
  assert.equal(fact('ICE', 'hot').temperature, 0);
  assert.ok(!fact('ROCK', 'melt'));
  assert.ok(!fact('ROCK', 'hot'));
  for (const key of ['WATER', 'ICE', 'SNOW', 'STEAM', 'CLOUD']) {
    assert.deepEqual(materialTransitions(el(key)), { hot: PHASE_ROWS[E[key]].hot ?? null, cold: PHASE_ROWS[E[key]].cold ?? null });
  }
  const override = { ...el('WATER'), cold: { T: -2, into: 'ICE' } };
  assert.equal(elementFacts(override).find(f => f.key === 'cold').temperature, -2);
});
test('buoyancy facts are conditional, not a blanket gas rises claim', () => {
  assert.match(fact('STEAM', 'buoyancy').chips[0], /^Rises/);
  assert.match(fact('MERCURY_VAPOR', 'buoyancy').chips[0], /^Sinks/);
  assert.ok(!fact('CLOUD', 'buoyancy'));
});
test('semantic exceptions expose active non-table behaviors and cards use fact tuples', () => {
  for (const [key, trait] of [['DUST', 'airborne-explosive'], ['VOID', 'matter-consuming'], ['CLONE', 'replicating'], ['PCLN', 'replicating'], ['PLANT', 'growing'], ['MOSS', 'growing'], ['FUNGUS', 'growing'], ['FIRE', 'decaying'], ['SLIME', 'biological'], ['HEALTHIUM', 'potion']]) {
    assert.ok(materialTags(el(key)).includes(trait), key);
  }
  for (const e of ELEMENTS) for (const record of elementFacts(e)) {
    assert.ok(record.key); assert.equal(record.chips.length, 3);
    assert.ok(record.chips.every(v => typeof v === 'string'));
  }
});

test('ordinary materials are geometric candidates, not wildcard victims or phase-control obligations', () => {
  const catalog = createExhibitCatalog();
  for (const key of ['SAND', 'WATER', 'CO2', 'WOOD']) {
    const entry = catalog.find(e => e.key === key);
    assert.equal(entry.status, 'candidate', key);
    assert.ok(!entry.requirements.includes('thermal-control'), key);
    assert.ok(!entry.requirements.includes('pressure-shielding'), key);
    assert.equal(entry.category, { SAND: 'powder', WATER: 'liquid', CO2: 'gas', WOOD: 'solid' }[key]);
  }
  assert.ok(!materialTags(el('SAND')).includes('reactive'));
  assert.ok(materialTags(el('ANTIMATTER')).includes('reactive'));
  assert.ok(materialTags(el('WATER')).includes('reactive')); // Specific pair chemistry still counts.
  assert.ok(materialTags(el('LAVA')).includes('hot'));
  assert.ok(materialTags(el('ICE')).includes('cold'));
  assert.ok(materialTags(el('LIQUID_NITROGEN')).includes('cryogenic'));
  assert.ok(!materialTags(el('ICE')).includes('cryogenic'));
});

test('actual ambient transition instability requires control, unlike a remote threshold', () => {
  const unstable = elementRow({ key: 'TEST_UNSTABLE', name: 'Ambient unstable', kind: K.SOLID, cap: 1, cond: 0.01, hot: { T: 10, into: 'WATER' } }, ELEMENTS.length);
  const entry = createExhibitCatalog([unstable])[0];
  assert.ok(entry.tags.includes('thermally-unstable'));
  assert.ok(entry.requirements.includes('thermal-control'));
  assert.equal(entry.status, 'plaque-only');
  for (const kind of [999, '__proto__', '3', null]) assert.throws(() => materialTags({ ...unstable, kind }), /unsupported material kind/);
});

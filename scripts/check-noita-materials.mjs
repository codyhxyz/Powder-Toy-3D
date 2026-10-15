import assert from 'node:assert/strict';
import route from '../src/world/scenes/descent/terrainRoute.json' with { type: 'json' };
import { E, ELEMENTS, K, R } from '../src/elements.js';

const native = new Map(route.palette.map(p => [p.name, p.element]));
for (const [name, key] of [
  ['snowrock_static', 'NOITA_SNOWROCK'], ['rock_vault', 'NOITA_VAULT'],
  ['templebrick_static', 'NOITA_TEMPLE'], ['soil_lush', 'NOITA_LUSH'],
]) {
  assert.equal(native.get(name), E[key], `${name}: retain the native terrain class`);
  const element = ELEMENTS[E[key]];
  assert.equal(element.kind, K.SOLID, `${name}: source terrain must not collapse as loose powder`);
  assert.equal(element.render, R.OPAQUE, `${name}: opaque rock must not become transparent ice`);
  assert.equal(element.melt, 0, `${name}: do not melt source rock at freezing temperature`);
}
for (const p of route.palette) {
  assert.ok(ELEMENTS[p.element], p.name);
  assert.equal(p.element === E.EMPTY, p.name === 'air', `${p.name}: never silently replace material with air`);
}
assert.ok(ELEMENTS.length <= 256);
console.log('Noita materials: native bulk terrain is opaque solid matter; only native air maps to EMPTY.');

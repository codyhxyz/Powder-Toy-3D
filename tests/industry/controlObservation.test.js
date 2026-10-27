import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { E } from '../../src/elements.js';
import { ELEC, LAMP_DC, sparkLevel } from '../../src/electricity.js';
import { CONTROL_PARTS } from '../../src/industry/controlParts.js';

const source = readFileSync(new URL('../../src/industry/index.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('  function controlProbeOverrides('), source.indexOf('  function inspectHovered()'));
const load = parts => new Function('CONTROL_PARTS', 'ELEC', 'LAMP_DC', 'sparkLevel',
  `${helpers}\nreturn { controlProbeOverrides, observedControlPart };`)(parts, ELEC, LAMP_DC, sparkLevel);
const cell = [12, 4, 18];
const observation = material => ({ freshness: 'fresh', evidence: {
  control: { active: false, sample: { material, temperatureC: 200, life: 0, ctype: 0 } }, regions: {},
} });
test('every Factory control resolves from its actual native material without region probes', () => {
  const { observedControlPart, controlProbeOverrides } = load(CONTROL_PARTS);
  for (const [key, part] of Object.entries(CONTROL_PARTS)) {
    const observed = observedControlPart(observation(part.material), cell);
    assert.equal(observed.type, key); assert.deepEqual([observed.x, observed.y, observed.z], cell);
  }
  assert.equal(observedControlPart(observation(E.WATER), cell), null);
  assert.equal(observedControlPart({ ...observation(E.BUTTON), freshness: 'stale' }, cell), null);
  assert.equal(observedControlPart({ freshness: 'fresh', evidence: { control: { sample: null } } }, cell), null);
  for (const type of ['belt', 'pump', 'separator', 'hearth', 'gate']) assert.deepEqual(controlProbeOverrides({ type }, cell), {});
  assert.deepEqual(controlProbeOverrides({ type: 'control-cell' }, cell), {
    regions: {}, guard: { base: [0, 0, 0], material: -1, port: cell, powered: true },
  });
});
test('future whitelist entries need no controller codebook changes', () => {
  const future = Object.freeze({ ...CONTROL_PARTS,
    FUTURE_WATER_PART: Object.freeze({ key: 'FUTURE_WATER_PART', material: E.WATER, cost: 1 }),
    FUTURE_SAND_PART: Object.freeze({ key: 'FUTURE_SAND_PART', material: E.SAND, cost: 1 }),
  });
  const { observedControlPart } = load(future);
  assert.equal(observedControlPart(observation(E.WATER), cell).type, 'FUTURE_WATER_PART');
  assert.equal(observedControlPart(observation(E.SAND), cell).type, 'FUTURE_SAND_PART');
  assert.equal(source.includes('controlCodes'), false);
  assert.equal(source.includes('controlPart${index}'), false);
});

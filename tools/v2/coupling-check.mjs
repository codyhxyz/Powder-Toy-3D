// CPU-only checks at the material/contact/liquid integration boundary.
import assert from 'node:assert/strict';
import { E, ELEMENTS } from '../../src/elements.js';
import { FULL, MAX_FILL, makeMaterial, energyOf, withEnergy, advectReference, cTq, cFill, ctypeOf, withPayload, payloadOf } from '../../src/v2/layout.js';
import { phaseOffsetEnergy } from '../../src/v2/phase.js';
import { v2BlockWGSL } from '../../src/shaders/v2.js';
import { columnWaterWGSL } from '../../src/shaders/v2/columns.js';
import { gridLayout } from '../../src/sim.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';

for (const type of [E.GOLD, E.GLASS, E.METAL]) {
  const temperature = ELEMENTS[type].melt;
  const source = makeMaterial(type, temperature);
  const lava = makeMaterial(E.LAVA, temperature, FULL, type);
  assert.equal(energyOf(source), energyOf(lava), 'melting preserves enthalpy at the source melting point');
  assert.equal(cTq(withEnergy(lava, energyOf(lava)).core), cTq(lava.core));
  for (const fill of [1, FULL, MAX_FILL]) {
    const before = [makeMaterial(E.LAVA, temperature + 100, fill, type), makeMaterial(0, temperature + 100)];
    const after = advectReference(before, [{ from: 0, to: 1, amount: fill }], true);
    assert.equal(energyOf(after[0]) + energyOf(after[1]), energyOf(before[0]) + energyOf(before[1]));
    assert.equal(cFill(after[1].core), fill);
    assert.equal(ctypeOf(after[1].core), type);
    assert.equal(cTq(after[1].core), cTq(before[0].core), 'dry receiver uses incoming formation energy');
  }
  assert.notEqual(phaseOffsetEnergy(E.LAVA, FULL, type), undefined);
}
const mixed = [makeMaterial(E.LAVA, 1800, FULL, E.GOLD), makeMaterial(E.LAVA, 1800, FULL, E.GLASS)];
const refused = advectReference(mixed, [{ from: 0, to: 1, amount: 1000 }], true);
assert.deepEqual(refused.map(m => cFill(m.core)), [FULL, FULL], 'incompatible lava remains at its source');
const oil = [makeMaterial(E.OIL, 20, FULL, 11), makeMaterial(E.OIL, 20, FULL, 22), makeMaterial(0)];
const dominant = advectReference(oil, [{ from: 0, to: 2, amount: 1 }, { from: 1, to: 2, amount: 2 }]);
assert.equal(ctypeOf(dominant[2].core), 22, 'CPU oracle matches strongest incoming face');
const wet = [withPayload(makeMaterial(E.WATER), 3608), makeMaterial(0)];
assert.equal(payloadOf(advectReference(wet, [{ from: 0, to: 1, amount: 1 }])[1].core), 3608, 'fresh water carries a spark, not fuel');

const g = gridLayout(32, 32, 32);
const block = v2BlockWGSL(g, contactWGSL);
assert(block.indexOf('requests[i] = pending[i]') > block.indexOf('// Gas ageing'), 'pending events must move before contact sees them');
assert(block.includes('let dU = motionDensity(hi)'));
assert(block.includes('return contactDensity(c)'));
assert(!block.includes('cid(lo) == cid(hi)'), 'same gas with different temperatures can convect');
// runs are single-subtype and two runs of different subtypes never share a segment
assert(columnWaterWGSL.includes('if (liq == id && sub == probeSub(probe) && r1 == y)'), 'a subtype change ends a run');
assert(columnWaterWGSL.includes('(liquidSub(c) << 16u)'), 'the scan reads a cell\'s subtype'); assert(columnWaterWGSL.includes('(code & 0xffff00u)'), 'a summary keeps its subtype');
assert(columnWaterWGSL.includes('(recLiq(ra) != recLiq(rb) || recSub(ra) != recSub(rb))'), 'real WGSL rejects incompatible lava');
console.log('native coupling: typed lava enthalpy/transport, strongest-face tags, freshwater sparks, pending ownership and buoyancy passed');

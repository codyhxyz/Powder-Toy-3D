import assert from 'node:assert/strict';
import test from 'node:test';
import { E } from '../../src/elements.js';
import { lineMoltenCargoComplete } from '../../tools/fixtures/industry-line.js';

test('successive native melt collections must still contain the entire declared batch', () => {
  const melt = () => ({ id: E.LAVA, ctype: E.METAL, temperature: 1510 });
  const cargo = [melt(), melt()];
  assert.equal(lineMoltenCargoComplete(cargo, 4), false);
  cargo.push(melt(), melt());
  assert.equal(lineMoltenCargoComplete(cargo, 4), true);
  assert.equal(lineMoltenCargoComplete(cargo, 2), false);
  assert.equal(lineMoltenCargoComplete(cargo.slice(0, 2), 2), true);
});

test('solid, foreign and extra cargo cannot satisfy molten-metal batch evidence', () => {
  const cargo = Array.from({ length: 4 }, () => ({ id: E.LAVA, ctype: E.METAL }));
  assert.equal(lineMoltenCargoComplete([], 0), false);
  assert.equal(lineMoltenCargoComplete([...cargo, cargo[0]], 4), false);
  assert.equal(lineMoltenCargoComplete([{ id: E.METAL, ctype: 0 }, ...cargo.slice(1)], 4), false);
  assert.equal(lineMoltenCargoComplete([{ id: E.LAVA, ctype: E.STONE }, ...cargo.slice(1)], 4), false);
});

import assert from 'node:assert/strict';
import { characterForMode } from '../src/pov/character.js';

for (const mode of ['slayer', 'ctf', 'koth', 'infection']) {
  for (const choice of [undefined, 'real', 'stick', 'invalid']) {
    assert.equal(characterForMode(mode, choice), 'spartan', `${mode}/${choice}`);
  }
}
for (const mode of ['sandbox', 'siege', undefined]) {
  assert.equal(characterForMode(mode, 'stick'), 'stick');
  for (const choice of [undefined, 'real', 'invalid', null]) {
    assert.equal(characterForMode(mode, choice), 'real');
  }
}
console.log('PASS loading/gameplay character selection: Halo armor, saved preference, invalid preference');

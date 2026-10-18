// CPU only: preserve the complete block history, not just final material IDs.
import assert from 'node:assert/strict';
import { E } from '../../src/elements.js';
import * as C from '../../src/v2/contact.js';

const q = t => Math.round((t + 273.25) * 4);
const cells = Array.from({ length: 8 }, () => C.ctNew(E.EMPTY, q(500), 65536));
cells[0] = C.ctNew(E.WOOD, q(500), 65536);
cells[0].burning = 1; cells[0].life = 2048;
cells[2] = C.ctNew(E.SMOKE, q(500), 65536); cells[2].life = 6;
const cores = cells.map(c => C.packContact(c).core);
cores[2][2] = 0x12340000;
const original = new Uint32Array(cores[2]);
const dead = C.ctStep(C.unpackContact(original), [cells[0], cells[3], cells[6]], 0);
assert.equal(dead.id, E.EMPTY);
const seed = (Math.imul(48, 2654435761) ^ 2) | 0;
const plume = C.ctPlume(cells[0], dead, seed, 1);
assert.equal(plume.b.id, E.SMOKE);
assert.equal(C.packContact(plume.b, original).core[2], 0x12340000);
assert.equal(C.packContact(plume.b, C.packContact(dead, original).core).core[2], 0,
  'intermediate canonical packing is not equivalent');
const out = C.contactReference(cores, new Int32Array(8), 48);
assert.equal(out.cores[2][0] & 255, E.SMOKE);
assert.equal(out.cores[2][2], 0x12340000);
console.log('Contact opaque history: tick48 SMOKE→EMPTY→SMOKE retains original word2; staged packing counterexample covered');

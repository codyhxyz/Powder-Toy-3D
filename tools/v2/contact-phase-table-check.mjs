// CPU-only execution of the actual emitted lookup bodies through a restricted
// scalar syntax adapter. This does not emulate Metal or establish a speedup.
import assert from 'node:assert/strict';
import { ELEMENTS, E } from '../../src/elements.js';
import { PHASE_ROWS, phaseOffsetPerQuantum } from '../../src/v2/phase.js';
import { v2Table, v2BlockWGSL, v2RuntimeBlockWGSL, nativeDynamicsHead } from '../../src/shaders/v2.js';
import { contactWGSL } from '../../src/shaders/v2/contact.js';
import { contactPhaseLookups } from '../../src/shaders/v2/contactPhase.js';
import { phaseWGSL } from '../../src/shaders/v2/phase.js';
import { gridLayout } from '../../src/sim.js';

const names = ['phaseHotQ', 'phaseColdQ', 'phaseHotLatent', 'phaseColdLatent',
  'phaseOffsetPerQuantum', 'phaseCapacityPerQuantum', 'phaseLavaOffsetPerQuantum'];
function declaration(source, name) {
  const signature = `fn ${name}(id:u32)->i32 {`;
  assert.equal(source.split(signature).length, 2, `${name}: unique declaration`);
  const start = source.indexOf(signature);
  let depth = 1, end = start + signature.length;
  for (; depth; end++) {
    assert(end < source.length);
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  return source.slice(start, end);
}
const words = new Uint32Array(v2Table().buffer);
let reads = 0;
const vectors = Array.from({length: words.length / 4}, (_, i) =>
  Object.fromEntries([...'xyzw'].map((key, j) => [key, words[4 * i + j]])));
const EV = new Proxy(vectors, {get(target, key) {
  assert(/^\d+$/.test(String(key)), 'only indexed loads');
  assert(Number(key) < target.length, 'no out-of-range EV read');
  reads++;
  return target[key];
}});
const expected = (name, id) => {
  if (id >= ELEMENTS.length) return 0;
  const row = PHASE_ROWS[id];
  return ({
    phaseHotQ: row.hotQ, phaseColdQ: row.coldQ,
    phaseHotLatent: row.hotLatent, phaseColdLatent: row.coldLatent,
    phaseOffsetPerQuantum: row.offset,
    phaseCapacityPerQuantum: Math.max(1, Math.round(ELEMENTS[id].cap * 64)),
    phaseLavaOffsetPerQuantum: phaseOffsetPerQuantum(E.LAVA, id),
  })[name];
};
const g = gridLayout(16,16,16);
let comparisons = 0, negatives = 0;
for (const compact of [false, true]) {
  const original = v2BlockWGSL(g, contactWGSL, compact);
  const candidate = v2RuntimeBlockWGSL(g, contactWGSL, compact);
  let restored = candidate;
  for (const name of names) {
    const emitted = declaration(candidate, name);
    assert(!candidate.includes(`${name}Table`), 'constant array removed only from candidate');
    const originalPair = phaseWGSL.match(new RegExp(`const ${name}Table = [^\\n]+\\nfn ${name}\\(id:u32\\)->i32 \\{[^\\n]+\\}`))?.[0];
    assert(originalPair);
    restored = restored.replace(emitted, originalPair);
    // The adapter only removes WGSL integer syntax. The actual branches,
    // addresses, fields and arithmetic execute unchanged over packed raw u32.
    const body = emitted.slice(emitted.indexOf('{') + 1, -1)
      .replaceAll('bitcast<i32>', 'i32').replace(/\bvar\b/g, 'let')
      .replace(/\b(\d+)u\b/g, '$1');
    assert(!/[<>]|vec|array|\b(?:fn|u32|i32)\s*:/.test(body.replace(/>=|<|i32/g, '')), 'restricted scalar adapter');
    const evaluate = new Function('id', 'EV', 'i32', body);
    for (const id of [...Array.from({length:256}, (_, i) => i), 0x7fffffff, 0x80000000, 0xffffffff]) {
      reads = 0;
      const actual = evaluate(id, EV, value => value | 0);
      assert.equal(actual, expected(name, id), `${name}(${id}), compact=${compact}`);
      if (id >= ELEMENTS.length) assert.equal(reads, 0, 'guard before EV load');
      negatives += actual < 0;
      comparisons++;
    }
    assert(emitted.includes('return 0;'), 'signed typed-zero return retained');
  }
  assert.equal(restored, original, 'every nonlookup byte unchanged, including energyFits and full CTRow snapshots');
  assert.equal((candidate.match(/var<storage,/g) ?? []).length, (original.match(/var<storage,/g) ?? []).length);
  assert.equal((candidate.match(/var<uniform>/g) ?? []).length, (original.match(/var<uniform>/g) ?? []).length);
  const cap = original.match(/const MATERIAL_CAP = [^\n]+/)[0];
  assert(candidate.includes(cap), 'unguarded MATERIAL_CAP and its unknown-ID behavior untouched');
  assert.throws(() => contactPhaseLookups(candidate), /exactly once/);
}
assert(negatives > 0, 'actual signed negative offsets exercised');
for (const custom of ['', '// custom contact', `${contactWGSL}\n// not exact production`]) {
  for (const compact of [false, true]) assert.equal(v2RuntimeBlockWGSL(g, custom, compact), v2BlockWGSL(g, custom, compact));
}
for (const name of names) assert(nativeDynamicsHead(g).includes(`${name}Table`), 'prefix-only dynamics retains original scalar arrays');
console.log(`${comparisons} emitted phase lookup comparisons passed; raw signed fields, absent transitions, lava formation, unknown guards and unchanged nonlookup/default/custom/dynamics emission checked`);

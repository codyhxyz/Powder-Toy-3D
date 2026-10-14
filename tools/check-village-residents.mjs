import assert from 'node:assert/strict';
import { RESIDENTS, hydrateMemory, createConversation, advanceConversation, residentFurniture } from '../src/pov/village/residents.js';

const original = [
  ['Maple', 'bear', 1, '#c59471', '#c87362', 0.85],
  ['Clover', 'rabbit', 2, '#e8d8b8', '#8da76b', 1.3],
  ['Pippin', 'cat', 3, '#d9a66a', '#679fab', 1.1],
];
assert.deepEqual(RESIDENTS.map(r => [r.name, r.species, r.home, r.color, r.shirt, r.pitch]), original);
const voice = [/shavings|kettle|sanded/, /sprouted|seedlings|fern/, /clock|gadget|seat/];
const allLines = new Set();
for (const [index, resident] of RESIDENTS.entries()) {
  const first = createConversation(resident);
  assert.match(first.text, voice[index]);
  assert.equal(first.memory.visits, 1);
  const lines = new Set([first.text]);
  for (const bad of [undefined, null, '', '{broken', 'null', '[]', 17, { version: 99 }, { version: 1, resident: 'Other' }]) {
    assert.equal(hydrateMemory(bad, resident).visits, 0);
    assert.equal(createConversation(resident, bad).text, first.text);
  }
  const dirty = { version: 1, resident: resident.name, visits: -5, node: '__proto__',
    lastTopic: 'constructor', lastChoice: {}, rotations: { stool: Infinity } };
  const clean = hydrateMemory(dirty, resident);
  assert.equal(clean.visits, 0);
  assert.equal(clean.node, 'topics');
  assert.equal(clean.lastChoice, null);
  let memory = first.memory;
  for (let i = 0; i < 4; i++) {
    const next = createConversation(resident, memory);
    lines.add(next.text);
    assert.equal(next.memory.visits, memory.visits + 1);
    if (i === 0) assert.notEqual(next.text, first.text);
    memory = next.memory;
  }
  assert.ok(createConversation(resident, memory).text.length > first.text.length);
  for (const option of first.choices) {
    const snapshot = JSON.stringify(first.memory);
    const branch = advanceConversation(resident, first.memory, option.id);
    assert.equal(JSON.stringify(first.memory), snapshot, 'pure input');
    assert.equal(branch.memory.visits, 1, 'choices are not visits');
    assert.equal(branch.memory.lastTopic, option.id);
    lines.add(branch.text);
    assert.equal(branch.choices.length, 2);
    assert.notEqual(branch.choices[0].label, branch.choices[1].label);
    assert.deepEqual(advanceConversation(resident, branch.memory, 'invalid'), branch);
    const outcomes = branch.choices.map(choice => {
      const result = advanceConversation(resident, branch.memory, choice.id);
      lines.add(result.text);
      assert.equal(result.memory.lastChoice, choice.id);
      assert.equal(result.memory.node, 'topics');
      assert.deepEqual(hydrateMemory(JSON.stringify(result.memory), resident), result.memory);
      const remembered = createConversation(resident, result.memory);
      lines.add(remembered.text);
      assert.notEqual(remembered.text, createConversation(resident, { ...result.memory, lastChoice: null }).text);
      const repeated = advanceConversation(resident, result.memory, option.id);
      assert.notEqual(repeated.text, branch.text, 'topic rotates');
      lines.add(repeated.text);
      const doubleClick = advanceConversation(resident, result.memory, choice.id);
      assert.deepEqual(doubleClick.memory, result.memory);
      return result.text;
    });
    assert.notEqual(...outcomes);
  }
  const day = createConversation(resident, null, { hour: 8 });
  const night = createConversation(resident, null, { hour: 21 });
  assert.notEqual(day.text, night.text);
  lines.add(day.text); lines.add(night.text);
  const empty = createConversation(resident, null, { home: resident.home, furniture: [] });
  const furnished = createConversation(resident, null, { home: resident.home, furniture: residentFurniture(resident.home) });
  assert.notEqual(empty.text, furnished.text);
  assert.notEqual(furnished.text, first.text);
  assert.equal(createConversation(resident, null, { home: 0, furniture: [] }).text, first.text);
  assert.equal(createConversation(resident, null, null).text, first.text);
  assert.deepEqual(advanceConversation(resident, first.memory, '__proto__'), first);
  assert.ok(lines.size >= 15, `${resident.name}: 15+ accessible authored lines`);
  for (const line of lines) {
    assert.ok(!allLines.has(line), 'no cross-resident duplicated dialogue');
    allLines.add(line);
  }
}
assert.throws(() => createConversation('Unknown'), RangeError);
assert.equal(hydrateMemory(createConversation('Maple').memory, 'Clover').visits, 0);

// Independent dimensions, cross-checked against production metadata.
const dimensions = { chair: [2, 2], bed: [4, 6], sofa: [6, 3], table: [4, 4], lamp: [2, 2], plant: [2, 2], shelf: [4, 2], desk: [4, 2] };
const dresser = { left: 4, right: 8, back: 4.5, front: 7.5 };
const intersects = (a, b, gap = 0) => a.left < b.right + gap && a.right + gap > b.left && a.back < b.front + gap && a.front + gap > b.back;
const ids = new Set(), signatures = new Set();
for (const home of [1, 2, 3]) {
  const pieces = residentFurniture(home);
  assert.ok(pieces.length >= 6);
  signatures.add(JSON.stringify(pieces.map(({ kind, x, z, rotation }) => [kind, x, z, rotation])));
  const rectangles = [];
  for (const piece of pieces) {
    assert.ok(piece.id.startsWith(['', 'cottage', 'botanical', 'workshop'][home]));
    assert.ok(!ids.has(piece.id)); ids.add(piece.id);
    const { ITEMS } = await import('../src/pov/village/catalog.js');
    const spec = ITEMS[piece.kind];
    assert.ok(spec && dimensions[spec.family], `known catalog kind ${piece.kind}`);
    assert.equal(spec.theme, ['', 'cottage', 'botanical', 'workshop'][home]);
    assert.ok(Number.isInteger(piece.rotation) && piece.rotation >= 0 && piece.rotation <= 3);
    let [w, d] = dimensions[spec.family];
    assert.deepEqual([spec.w, spec.d], [w, d]);
    if (piece.rotation % 2) [w, d] = [d, w];
    const b = { left: piece.x - w / 2, right: piece.x + w / 2, back: piece.z - d / 2, front: piece.z + d / 2 };
    assert.ok(b.left >= -9 && b.right <= 9 && b.back >= -9 && b.front <= 9, piece.id);
    assert.ok(!intersects(b, { left: -2, right: 2, back: -10, front: 10 }), `aisle/spawn/door: ${piece.id}`);
    for (const other of [dresser, ...rectangles]) assert.ok(!intersects(b, other, 0.25), `clearance: ${piece.id}`);
    rectangles.push(b);
  }
  pieces[0].x = 99;
  assert.notEqual(residentFurniture(home)[0].x, 99, 'fresh mutable layout copy');
}
assert.equal(signatures.size, 3);
assert.deepEqual(residentFurniture(0), []);
console.log(`Village residents: 3 voices, ${allLines.size} distinct dialogue samples; memory, branching, context and 3 room layouts passed.`);

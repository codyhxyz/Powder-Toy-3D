// CPU-only scalar phase lookup regression. No browser, device or GPU.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ELEMENTS, E } from '../../src/elements.js';
import { PHASE_ROWS, phaseOffsetPerQuantum } from '../../src/v2/phase.js';
import { phaseWGSL } from '../../src/shaders/v2/phase.js';
import { wgslGroupingErrors } from './wgsl-grouping.mjs';

// Decode the emitted array and bounds/load source independently of field().
function decode(source, name) {
  assert.equal([...source.matchAll(new RegExp(`\\bfn ${name}\\s*\\(`, 'g'))].length, 1, `${name}: unique function`);
  const fn = source.match(new RegExp(`fn ${name}\\(id:u32\\)->i32 \\{([^}]*\\}[^}]*?)\\}`));
  assert.ok(fn, `${name}: unchanged signature and guarded scalar load`);
  const body = fn[1].match(/^\s*if\(id>=(\d+)u\)\{return 0;\} return (\w+)\[id\];\s*$/);
  assert.ok(body, `${name}: only explicit unsigned bounds guard then indexed return; no switch or conversion`);
  const bound = Number(body[1]), table = body[2];
  assert.equal(table, `${name}Table`, `${name}: distinct scalar table`);
  assert.equal([...source.matchAll(new RegExp(`\\bconst ${table}\\b`, 'g'))].length, 1, `${name}: unique const array`);
  const array = source.match(new RegExp(`const ${table} = array<i32, (\\d+)>\\(([^]*?)\\);`));
  assert.ok(array, `${name}: constant i32 array`);
  assert.equal(Number(array[1]), bound, `${name}: array size matches guard`);
  assert.match(array[2], /^-?\d+(?:,-?\d+)*$/, `${name}: only exact signed integer literals, including zero`);
  const values = array[2].split(',').map(Number);
  assert.equal(values.length, bound, `${name}: all array entries explicit`);
  assert.ok(source.indexOf(array[0]) < source.indexOf(fn[0]), `${name}: table precedes helper`);
  return { text: `${array[0]}\n${fn[0]}`, values, bound };
}
function checkField(source, name, expected) {
  const decoded = decode(source, name);
  assert.equal(decoded.bound, expected.length, `${name}: exact row count`);
  const lookup = id => id >= decoded.bound ? 0 : decoded.values[id];
  for (const [id, value] of expected.entries()) {
    assert.ok(Number.isInteger(decoded.values[id]) && decoded.values[id] >= -2147483648 && decoded.values[id] <= 2147483647, `${name}(${id}): i32 value`);
    assert.equal(lookup(id), value, `${name}(${id}): exact integer value`);
  }
  for (const value of new Set([0, Math.min(...expected), Math.max(...expected), ...expected.filter(v => v < 0)])) {
    const id = expected.indexOf(value);
    if (id >= 0) assert.equal(lookup(id), value, `${name}: zero/negative/min/max value ${value}`);
  }
  for (const id of [expected.length, expected.length + 1, 255, 0x7fffffff, 0x80000000, 0xffffffff]) {
    assert.equal(lookup(id), 0, `${name}(${id}): invalid u32 default`);
  }
  return decoded;
}

// Negative controls cover missing/extra/reordered entries, fractional/out-of-i32
// values, changed guard/default/index/table, and unguarded or switch fallbacks.
const fixture = `const fixtureTable = array<i32, 5>(0,7,-3,-2147483648,2147483647);
fn fixture(id:u32)->i32 { if(id>=5u){return 0;} return fixtureTable[id]; }`;
const fixtureValues = [0, 7, -3, -2147483648, 2147483647];
checkField(fixture, 'fixture', fixtureValues);
for (const bad of [
  fixture.replace('0,7,-3,', '7,-3,'),
  fixture.replace('0,7,-3,', '0,7,7,-3,'),
  fixture.replace('0,7,-3,', '0,-3,7,'),
  fixture.replace('0,7,-3,', '0,7.0,-3,'),
  fixture.replace('2147483647)', '2147483648)'),
  fixture.replace('id>=5u', 'id>=4u'),
  fixture.replace('id>=5u', 'id>5u'),
  fixture.replace('return 0;', 'return 1;'),
  fixture.replace('fixtureTable[id]', 'fixtureTable[id+1u]'),
  fixture.replace('return fixtureTable[id]', 'return otherTable[id]'),
  fixture.replace('if(id>=5u){return 0;} ', ''),
  fixture.replace('if(id>=5u){return 0;} return fixtureTable[id];', 'return fixtureTable[id]; if(id>=5u){return 0;}'),
  fixture.replace('if(id>=5u){return 0;} return fixtureTable[id];', 'switch id { default: { return 0; } }'),
  `${fixture}\n${fixture}`,
]) assert.throws(() => checkField(bad, 'fixture', fixtureValues), assert.AssertionError);

assert.equal(PHASE_ROWS.length, ELEMENTS.length);
assert.equal(E.LAVA, 10, 'existing lava lookup source ID');
// Independent existing CPU reference; no reads from the shader generator.
const expected = {
  phaseHotQ: PHASE_ROWS.map(row => row.hotQ),
  phaseColdQ: PHASE_ROWS.map(row => row.coldQ),
  phaseHotLatent: PHASE_ROWS.map(row => row.hotLatent),
  phaseColdLatent: PHASE_ROWS.map(row => row.coldLatent),
  phaseOffsetPerQuantum: PHASE_ROWS.map(row => row.offset),
  phaseCapacityPerQuantum: ELEMENTS.map(element => Math.max(1, Math.round(element.cap * 64))),
  phaseLavaOffsetPerQuantum: PHASE_ROWS.map((_, id) => phaseOffsetPerQuantum(E.LAVA, id)),
};
assert.equal(Object.keys(expected).length, 7);
assert.deepEqual(wgslGroupingErrors(phaseWGSL), [], 'Chromium-compatible expression grouping');
assert.ok(!/\b(?:enable|requires|switch)\b|@(?:group|binding)\(/.test(phaseWGSL), 'no extensions, switches or bindings');
const functions = []; let zeroCount = 0, negativeCount = 0;
for (const [name, values] of Object.entries(expected)) {
  const decoded = checkField(phaseWGSL, name, values);
  functions.push(decoded.text);
  const zeros = values.filter(value => value === 0).length;
  const negatives = values.filter(value => value < 0).length;
  zeroCount += zeros; negativeCount += negatives;
  console.log(`${name}: ${values.length} IDs exact; ${zeros} zero entries; ${negatives} negative values; min/max ${Math.min(...values)}/${Math.max(...values)}`);
}
assert.ok(zeroCount > 0 && negativeCount > 0, 'actual tables exercise zeros and negative integers');
assert.ok(expected.phaseLavaOffsetPerQuantum.some(value => value < 0), 'Lava exercises signed offsets');

// Dynamic indexing fixture validates constant-array grammar and all seven
// signed return channels on CPU Naga, including i32 extremes in the control.
const dir = mkdtempSync(join(tmpdir(), 'phase-table-'));
try {
  const source = `${functions.join('\n')}\n${fixture}\n@group(0) @binding(0) var<storage,read_write> result:array<i32>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid:vec3u) {
${Object.keys(expected).map((name, i) => `result[gid.x*8u+${i}u]=${name}(gid.x);`).join('\n')}
result[gid.x*8u+7u]=fixture(gid.x);
}`;
  assert.deepEqual(wgslGroupingErrors(source), []);
  const file = join(dir, 'phase-tables.wgsl'); writeFileSync(file, source);
  const naga = spawnSync('naga', [file], { encoding: 'utf8' });
  if (naga.error) throw naga.error;
  assert.equal(naga.status, 0, naga.stderr);
  console.log(`Phase lookups: ${PHASE_ROWS.length * functions.length} exact i32 entries (${PHASE_ROWS.length * functions.length * 4} bytes); seven bounds guards, zero switches; dynamic arrays CPU Naga valid; no GPU`);
} finally { rmSync(dir, { recursive: true, force: true }); }

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

// Decode the emitted WGSL itself, not the generator's grouping implementation.
function decode(source, name) {
  const functions = [...source.matchAll(new RegExp(`fn ${name}\\(id:u32\\)->i32 \\{ switch id \\{ ([^]*?\\}) \\} \\}`, 'g'))];
  assert.equal(functions.length, 1, `${name}: unchanged unique function/signature`);
  const text = functions[0][0], body = functions[0][1];
  const defaults = [...body.matchAll(/default\s*:\s*\{\s*return\s+(-?\d+)\s*;\s*\}/g)];
  assert.equal(defaults.length, 1, `${name}: single default`);
  assert.equal(Number(defaults[0][1]), 0, `${name}: invalid u32 default remains zero`);
  const casePattern = /case\s+(\d+u(?:\s*,\s*\d+u)*)\s*:\s*\{\s*return\s+(-?\d+)\s*;\s*\}/g;
  const cases = [...body.matchAll(casePattern)].map(m => ({
    ids: m[1].split(',').map(label => Number(label.trim().slice(0, -1))),
    value: Number(m[2]),
  }));
  assert.equal(body.replace(casePattern, '').replace(defaults[0][0], '').trim(), '', `${name}: only legal comma-separated u32 cases and integer returns`);
  return { text, cases, defaultValue: 0 };
}
function checkField(source, name, expected) {
  const decoded = decode(source, name), labels = new Map();
  const uniqueValues = expected.filter((value, id) => value !== 0 && expected.indexOf(value) === id);
  assert.deepEqual(decoded.cases.map(c => c.value), uniqueValues, `${name}: one case per distinct nonzero value, in first-row order`);
  for (const { ids, value } of decoded.cases) {
    assert.ok(Number.isInteger(value) && value >= -2147483648 && value <= 2147483647, `${name}: i32 value`);
    assert.notEqual(value, 0, `${name}: zero cases omitted`);
    assert.deepEqual(ids, expected.map((v, id) => v === value ? id : -1).filter(id => id >= 0), `${name}: repeated values share all IDs in row order`);
    for (const id of ids) {
      assert.ok(id >= 0 && id < expected.length, `${name}: only valid u32 labels`);
      assert.ok(!labels.has(id), `${name}: no duplicate ID ${id}`);
      labels.set(id, value);
    }
  }
  const lookup = id => labels.get(id) ?? decoded.defaultValue;
  for (const [id, value] of expected.entries()) {
    assert.ok(Number.isInteger(value) && value >= -2147483648 && value <= 2147483647);
    assert.equal(lookup(id), value, `${name}(${id}): exact integer value`);
    assert.equal(labels.has(id), value !== 0, `${name}(${id}): only zero IDs omitted`);
  }
  for (const id of [expected.length, expected.length + 1, 255, 0x7fffffff, 0x80000000, 0xffffffff]) {
    assert.equal(lookup(id), 0, `${name}(${id}): invalid u32 default`);
  }
  return decoded;
}

// Negative controls demonstrate detection of duplicate labels/value groups,
// explicit zeros, omitted nonzero IDs, changed defaults and row-order changes.
const fixture = 'fn fixture(id:u32)->i32 { switch id { case 1u, 2u: { return 7; } case 3u: { return -3; } default: { return 0; } } }';
const fixtureValues = [0, 7, 7, -3, 0];
checkField(fixture, 'fixture', fixtureValues);
for (const bad of [
  fixture.replace('1u, 2u', '1u, 1u, 2u'),
  fixture.replace('1u, 2u: { return 7; }', '1u: { return 7; } case 2u: { return 7; }'),
  fixture.replace('case 1u', 'case 0u: { return 0; } case 1u'),
  fixture.replace('1u, 2u', '1u'),
  fixture.replace('return 0;', 'return 1;'),
  fixture.replace('1u, 2u', '2u, 1u'),
]) assert.throws(() => checkField(bad, 'fixture', fixtureValues), assert.AssertionError);

assert.equal(PHASE_ROWS.length, ELEMENTS.length);
assert.equal(PHASE_ROWS.length, 91);
assert.equal(E.LAVA, 10, 'existing lava lookup source ID');
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
assert.ok(!/\b(?:enable|requires)\b|@(?:group|binding)\(/.test(phaseWGSL), 'no extensions or bindings');
const functions = []; let caseCount = 0, zeroCount = 0, negativeCount = 0, sharedCount = 0;
for (const [name, values] of Object.entries(expected)) {
  const decoded = checkField(phaseWGSL, name, values);
  functions.push(decoded.text); caseCount += decoded.cases.length;
  const zeros = values.filter(value => value === 0).length;
  const negatives = values.filter(value => value < 0).length;
  zeroCount += zeros; negativeCount += negatives;
  sharedCount += decoded.cases.filter(c => c.ids.length > 1).length;
  console.log(`${name}: ${values.length} IDs exact; ${decoded.cases.length} cases; ${zeros} zero IDs omitted; ${negatives} negative values`);
}
assert.ok(zeroCount > 0 && negativeCount > 0 && sharedCount > 0, 'actual table exercises zeros, negative integers and repeated values');
assert.ok(caseCount < PHASE_ROWS.length * functions.length, 'source switch case count reduced');

// Dynamic lookup fixture validates comma case syntax on CPU Naga, retaining
// every scalar function and signed return channel without arithmetic stubs.
const dir = mkdtempSync(join(tmpdir(), 'phase-table-'));
try {
  const source = `${functions.join('\n')}\n@group(0) @binding(0) var<storage,read_write> result:array<i32>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid:vec3u) {
${Object.keys(expected).map((name, i) => `result[gid.x*7u+${i}u]=${name}(gid.x);`).join('\n')}
}`;
  assert.deepEqual(wgslGroupingErrors(source), []);
  const file = join(dir, 'phase-tables.wgsl'); writeFileSync(file, source);
  const naga = spawnSync('naga', [file], { encoding: 'utf8' });
  if (naga.error) throw naga.error;
  assert.equal(naga.status, 0, naga.stderr);
  console.log(`Phase lookup cases: ${PHASE_ROWS.length * functions.length} -> ${caseCount}; seven dynamic scalar lookups CPU Naga valid; no GPU`);
} finally { rmSync(dir, { recursive: true, force: true }); }

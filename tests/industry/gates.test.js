import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packCells, unpackCells } from '../../src/saves/format.js';
import { E } from '../../src/elements.js';
import {
  GATE_APERTURE_CELLS, GATE_OWNER_MARKER, GATE_STATUS, GATE_CLOSED_AUDIT_SECONDS,
  GATE_RETRY_SECONDS, GATE_SIGNAL_POLL_SECONDS, gateGeometry, validateGateDevice,
  gateRequestsClosed, resolveGateTransition, gateWGSL, WGSL_CHECK, createGatePhysics,
} from '../../src/industry/gates.js';

const BOUNDS = { nx: 64, ny: 64, nz: 64 };
const device = (changes = {}) => ({ id: 'g-1', type: 'gate', x: 20, y: 20, z: 20, rotation: 0, ...changes });
const cells = kind => Array(GATE_APERTURE_CELLS).fill(kind);
const owned = cells('owned');
const empty = cells('empty');
const foreign = cells('foreign');
test('the real gate kernel passes Naga type validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'industry-gate-wgsl-'));
  try {
    const file = join(dir, 'gate.wgsl');
    writeFileSync(file, gateWGSL({ nx: 128, ny: 128, nz: 128 }));
    const result = spawnSync('naga', [file], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
function fakeSim() {
  const requests = [], slots = new Map();
  const ring = {
    buffer: {}, next() {
      const slot = slots.size;
      slots.set(slot, deferred());
      return slot;
    },
    read(slot) { return slots.get(slot).promise; },
    answer(i, values) { slots.get(requests[i].params.slot).resolve(new Float32Array(values).buffer); },
  };
  const gpu = {
    layout: () => ({}), readback: { ring: () => ring }, bindGroup: () => ({}),
    kernel: () => ({ ready: Promise.resolve() }), flush() {},
  };
  const sim = { g: { nx: 32, ny: 32, nz: 32 }, gpu, L: { TABLES: [], STATE_RW: [] }, tables: {}, bindRW: {}, version: 0,
    header: () => ({}), wake() {}, _dispatch(_kernel, _size, args) { requests.push(args); } };
  return { sim, requests, answer: (i, result) => ring.answer(i, result) };
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('timed out waiting for async GPU stub operation');
}

test('gate marker is exact f32 and ownership always includes WALL plus marker', async () => {
  assert.equal(GATE_OWNER_MARKER, 1048573);
  assert.equal(new Float32Array([GATE_OWNER_MARKER])[0], GATE_OWNER_MARKER);
  const source = await readFile(new URL('../../src/elements.js', import.meta.url), 'utf8');
  const wall = source.match(/\{ key: 'WALL',[\s\S]*?desc:/)?.[0] ?? '';
  assert.match(wall, /kind: K\.SOLID/);
  assert.match(wall, /acidProof: true/);
  assert.doesNotMatch(wall, /\b(?:life|melt|hot|cold|ignite|burnRate|conducts|elec)\s*:/);
  const code = gateWGSL({ nx: 32, ny: 32, nz: 32 });
  assert.match(code, /eid\(a\) == E_WALL && a\.z == INDUSTRY_GATE_OWNER_TAG/);
  assert.match(code, /INDUSTRY_GATE_OWNER_TAG: f32 = 1048573\.0/);
  assert.match(code, /f32\(E_WALL\), a\.y, INDUSTRY_GATE_OWNER_TAG, fract\(a\.w\)/);
  assert.match(code, /f32\(E_EMPTY\), airT\(\), 0\.0, fract\(a\.w\)/);
  const a = new Float32Array([E.WALL, 420.25, GATE_OWNER_MARKER, 0.375]);
  const b = new Float32Array([0, 0, 0, 0]);
  const packed = packCells([1, 1, 1], () => 0, [a, b]);
  const restoredA = new Float32Array(4), restoredB = new Float32Array(4);
  unpackCells([1, 1, 1], () => 0, packed, [restoredA, restoredB]);
  assert.deepEqual(restoredA, a, 'save cell packing preserves marker and seed bits exactly');
  assert.deepEqual(restoredB, b);
});

test('native react/move/rest paths do not assign WALL life-marker semantics', async () => {
  const paths = ['../shaders/react.js', '../shaders/move.js', '../electricity.js', '../shaders/common.js'];
  const sources = await Promise.all(paths.map(path => readFile(new URL(`../../src/${path.replace('../', '')}`, import.meta.url), 'utf8')));
  for (const source of sources.slice(0, 3)) assert.doesNotMatch(source, /(?:id|eid\(a\))\s*==\s*E_WALL|E_WALL\s*&&/);
  assert.match(sources[3], /if \(LIFE_BANK\(id\).*a\.z != 0\.0\)/);
  assert.match(sources[3], /return true;\s*}\s*\/\/ FLAG_SELF/);
});

test('gate transition table distinguishes empty, foreign, blocked, and damaged apertures', () => {
  assert.deepEqual(resolveGateTransition({ mode: 'open', aperture: empty }), {
    status: GATE_STATUS.OPEN, gateClosed: false, desiredClosed: false, write: 'none', changed: false,
  });
  assert.equal(resolveGateTransition({ mode: 'open', aperture: foreign }).status, GATE_STATUS.OPEN);
  assert.deepEqual(resolveGateTransition({ mode: 'closed', aperture: empty }), {
    status: GATE_STATUS.CLOSED, gateClosed: true, desiredClosed: true, write: 'place-owned', changed: true,
  });
  assert.equal(resolveGateTransition({ mode: 'closed', aperture: foreign }).status, GATE_STATUS.BLOCKED);
  assert.equal(resolveGateTransition({ mode: 'closed', aperture: ['foreign', ...cells('empty').slice(1)] }).write, 'none');
  assert.equal(resolveGateTransition({ mode: 'closed', aperture: empty, expectedClosed: true }).status, GATE_STATUS.DAMAGED);
  const partial = ['owned', ...cells('empty').slice(1)];
  for (const mode of ['open', 'closed']) {
    const result = resolveGateTransition({ mode, aperture: partial, expectedClosed: mode === 'open' });
    assert.equal(result.status, GATE_STATUS.DAMAGED);
    assert.equal(result.write, 'none');
  }
  assert.deepEqual(resolveGateTransition({ aperture: partial, remove: true }), {
    status: GATE_STATUS.OPEN, gateClosed: false, desiredClosed: false, write: 'erase-owned', changed: true,
  });
  assert.equal(resolveGateTransition({ aperture: empty, remove: true }).changed, false);
  assert.equal(resolveGateTransition({ mode: 'open', aperture: owned }).write, 'erase-owned');
});

test('gate mode and native signal semantics are energized-open / absent-close', () => {
  assert.equal(gateRequestsClosed('open', false), false);
  assert.equal(gateRequestsClosed('closed', true), true);
  assert.equal(gateRequestsClosed('signal', true), false);
  assert.equal(gateRequestsClosed('signal', false), true);
  assert.equal(resolveGateTransition({ mode: 'signal', energized: true, aperture: empty }).status, GATE_STATUS.OPEN);
  assert.equal(resolveGateTransition({ mode: 'signal', energized: false, aperture: empty }).status, GATE_STATUS.CLOSED);
  assert.throws(() => gateRequestsClosed('toggle', true), /mode/);
});

test('gate aperture, base, across vector and port rotate together and remain bounded', () => {
  const axes = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]];
  for (let rotation = 0; rotation < 4; rotation++) {
    const g = gateGeometry(device({ rotation }), BOUNDS);
    assert.equal(g.aperture.length, 12);
    assert.equal(new Set(g.aperture.map(p => p.join(','))).size, 12);
    assert.equal(g.base.length, 16);
    assert.deepEqual(g.across, axes[rotation]);
    assert.ok(g.aperture.every(p => p[1] >= 21 && p[1] <= 23));
    assert.ok(g.aperture.every(p => p.every(n => n >= 0 && n < 64)));
    assert.ok(g.port.every(n => n >= 0 && n < 64));
    assert.equal(validateGateDevice(device({ rotation }), BOUNDS).gateMode, 'open');
  }
  assert.throws(() => gateGeometry(device({ x: 61 }), BOUNDS), /fit/);
  assert.throws(() => gateGeometry(device({ y: 61 }), BOUNDS), /fit/);
  assert.throws(() => gateGeometry(device({ rotation: 4 }), BOUNDS), /geometry/);
  assert.throws(() => gateGeometry(device({ x: 0 }), BOUNDS), /port/);
  assert.throws(() => gateGeometry(device({ rotation: 2, x: 60 }), BOUNDS), /port/);
  assert.throws(() => validateGateDevice(device({ gateMode: 'pulse' }), BOUNDS), /mode/);
  assert.throws(() => validateGateDevice(device({ gateClosed: 1 }), BOUNDS), /closure/);
});

test('gate WGSL is one bounded preflight followed by all-or-none writes', () => {
  const code = gateWGSL({ nx: 32, ny: 32, nz: 32 });
  assert.match(code, /@compute @workgroup_size\(1\)/);
  assert.match(code, /for \(var y = 0; y < 3; y\+\+\)[\s\S]*for \(var x = 0; x < 4; x\+\+\)/);
  assert.match(code, /allEmpty = false/);
  assert.match(code, /eid\(a\) != E_EMPTY/);
  assert.ok(code.indexOf('var inBounds = true') < code.indexOf('writeGateCell(gateCell(x, y), true)'));
  assert.match(code, /ownedCount > 0 \|\| P\.expectedClosed != 0u/);
  assert.match(code, /P\.gateMode == 2u && !gateSignal\(P\.port\)/);
  assert.match(code, /markGateNeighbours\(p\)/);
  assert.match(code, /if \(id == E_BATTERY\)[\s\S]*if \(id == E_SWITCH\)[\s\S]*sparkLive\(id, floor\(a\.w\)\)/);
  assert.deepEqual(WGSL_CHECK[0].dispatch(), [1, 1, 1]);
  assert.deepEqual(WGSL_CHECK[0].layouts().at(-1), [{ binding: 0, buffer: { type: 'storage' } }]);
  assert.equal(GATE_RETRY_SECONDS, 0.25);
  assert.equal(GATE_SIGNAL_POLL_SECONDS, 0.1);
  assert.equal(GATE_CLOSED_AUDIT_SECONDS, 1);
});

test('pending close is fenced from dismantle; removal waits and erases only tagged cells', async () => {
  const fake = fakeSim(), events = [];
  const gates = createGatePhysics({ getSim: () => fake.sim, onState: (id, result) => events.push([id, result]) });
  const d = device({ x: 2, y: 4, z: 4 });
  await gates.ready;
  gates.step(1 / 60, [d]);
  await waitFor(() => fake.requests.length === 1);
  assert.equal(gates.pending, 1);
  const removing = gates.remove(d);
  assert.ok(gates.pending > 0);
  fake.answer(0, [2, 1, 1, 1]);
  await waitFor(() => fake.requests.length === 2);
  assert.equal(events.length, 0, 'stale close result must not reach the controller');
  assert.equal(fake.requests[1].params.operation, 1);
  fake.answer(1, [1, 0, 1, 0]);
  const result = await removing;
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.equal(result.status, GATE_STATUS.OPEN);
  assert.equal(gates.pending, 0);
  assert.equal(events.length, 0);
  gates.dispose();
});

test('simulation replacement discards stale async gate callbacks and binds new state', async () => {
  const first = fakeSim(), second = fakeSim();
  let current = first.sim;
  const events = [];
  const gates = createGatePhysics({ getSim: () => current, onState: (_id, result) => events.push(result) });
  const d = device({ x: 2, y: 4, z: 4 });
  await gates.ready;
  gates.step(1 / 60, [d]);
  await waitFor(() => first.requests.length === 1);
  current = second.sim;
  gates.step(1 / 60, [d]);
  assert.equal(events.length, 0);
  first.answer(0, [2, 1, 1, 1]);
  await waitFor(() => gates.pending === 0);
  gates.step(1 / 60, [d]);
  await waitFor(() => second.requests.length === 1);
  second.answer(0, [2, 1, 1, 1]);
  await waitFor(() => events.length === 1);
  assert.equal(events[0].status, GATE_STATUS.CLOSED);
  gates.reset();
  assert.equal(gates.status(d.id), null);
  gates.dispose();
});

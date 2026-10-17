// CPU-only witness for column-run water (src/shaders/v2/columns.js): the emitted col* bodies executed on
// production-format cells (tools/v2/column-wgsl.mjs). Pins (1) the executable subset (no bit operations, no
// integer division outside the f32 functions) and the constants the WGSL embeds, (2) exact custody of mass,
// signed energy and fuel through every pack, fall and transfer, with several liquids, lava subtypes and
// temperatures, (3) rest: a settled world is an exact fixed point that certifies idle, woken or not,
// (4) migration: unpacked columns (a partial cell under full ones, water mid-air, open water compressed by
// the substep model) settle with exact totals, and (5) the bench's single-liquid gates at their unchanged
// thresholds. No GPU, browser or World variant of the application.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnWaterWGSL, COLUMN, pairOrder } from '../../src/shaders/v2/columns.js';
import { E } from '../../src/elements.js';
import * as L from '../../src/v2/layout.js';
import { ColumnGrid, TRANSLATED, FLOAT, wgslFunction, constants } from './column-wgsl.mjs';
import { TESTS } from '../outcomes/tests/index.js';
import { runTest } from '../outcomes/run.js';
import { createEngine } from '../outcomes/engine-column-wgsl.js';

test('the executed functions stay in the scalar subset; the WGSL embeds the model constants', () => {
  for (const name of TRANSLATED) {
    const body = wgslFunction(columnWaterWGSL, name).body.replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(body.replace(/&&|\|\|/g, ''), /[&|^~]|<<|>>/, `${name}: a bit operation`);
    if (!FLOAT.includes(name)) assert.doesNotMatch(body, /[^/]\/[^/]|%/, `${name}: integer division`);
    assert.doesNotMatch(body, /\.[xyzw]\b/, `${name}: a vector component`);
  }
  const c = constants(columnWaterWGSL);
  for (const [k, v] of Object.entries({ COL_ACC: COLUMN.ACC, COL_G: COLUMN.G, COL_H_CAP: COLUMN.H_CAP, COL_COMP: COLUMN.COMP, COL_QMIN: COLUMN.QMIN,
    COL_FILM: COLUMN.FILM, COL_DEADQ: COLUMN.DEADQ, COL_STALL: COLUMN.STALL, COL_Q_MAX: COLUMN.Q_MAX, COL_VT: COLUMN.VT })) assert.equal(c[k], v, k);
  assert.ok(COLUMN.Q_MAX < 65504, 'a lane fits f16');
  // one flux stage of every face first, then both parities of both axes, the axes alternating
  for (const tick of [1, 2]) {
    const order = pairOrder(tick);
    assert.deepEqual(order.map(o => o[1]), [0, 1, 1, 1, 1]);
    assert.deepEqual(order.slice(1).map(o => o[0]), tick & 1 ? [2, 2, 0, 0] : [0, 0, 2, 2]);
    assert.deepEqual(order.slice(1).map(o => o[2]), [0, 1, 0, 1]);
  }
});

function walls(w) {
  for (let y = 0; y < w.ny; y++) for (let z = 0; z < w.nz; z++) for (let x = 0; x < w.nx; x++)
    if (y === 0 || x === 0 || z === 0 || x === w.nx - 1 || z === w.nz - 1) w.set(x, y, z, E.WALL);
}
function exact(w, ticks, label) {
  const t0 = w.totals();
  for (let t = 0; t < ticks; t++) {
    w.step();
    const t1 = w.totals();
    assert.equal(t1.mass, t0.mass, `${label}: mass at tick ${t}`);
    assert.equal(t1.energy, t0.energy, `${label}: energy at tick ${t}`);
    assert.equal(t1.fuel, t0.fuel, `${label}: fuel at tick ${t}`);
  }
}

test('custody: exact mass, energy and fuel through packs, falls and transfers of several liquids', () => {
  const w = new ColumnGrid(16, 16, 8);
  walls(w);
  // a hot-and-cold dam break, a falling oil slab over it, a mud mound, side-by-side lava subtypes
  for (let y = 1; y < 10; y++) for (let z = 1; z < 7; z++) for (let x = 1; x < 5; x++) w.set(x, y, z, E.WATER, { T: 5 + 9 * y + x });
  for (let y = 12; y < 14; y++) for (let z = 2; z < 5; z++) for (let x = 6; x < 10; x++) w.set(x, y, z, E.OIL, { T: 80 });
  w.set(6, 5, 5, E.WATER, { fill: Math.floor(L.FULL / 3), T: 60 });
  for (let y = 1; y < 4; y++) for (let z = 1; z < 3; z++) for (let x = 11; x < 14; x++) w.set(x, y, z, E.MUD, { T: 30 });
  for (let y = 1; y < 3; y++) for (let x = 11; x < 15; x++) { w.set(x, y, 5, E.LAVA, { T: 1700, ctype: E.STONE }); w.set(x, y, 6, E.LAVA, { T: 1500, ctype: E.GLASS }); }
  // a compressed cell, as the substep model left it
  w.set(2, 1, 2, E.WATER, { fill: L.FULL + 4321, T: 15 });
  exact(w, 240, 'mixed');
  // lava subtypes never merged: every lava cell still holds one of the two
  for (let i = 0; i < w.n; i++) if (L.cid(w.cores[i]) === E.LAVA) assert.ok([E.STONE, E.GLASS].includes(L.ctypeOf(w.cores[i])));
});

test('migration: unpacked columns settle packed, compressed open water rises, all exactly', () => {
  const w = new ColumnGrid(8, 16, 8);
  walls(w);
  // a partial cell under full ones, water painted mid-air, and open water compressed 5 % (the 180 Hz model's)
  w.set(3, 1, 3, E.WATER, { fill: L.FULL / 4, T: 40 }); w.set(3, 2, 3, E.WATER, { T: 10 }); w.set(3, 3, 3, E.WATER, { T: 90 });
  w.set(5, 9, 5, E.WATER, { T: 50 }); w.set(5, 10, 5, E.WATER, { fill: L.FULL / 2 });
  for (let z = 1; z < 7; z++) for (let x = 1; x < 3; x++) w.set(x, 1, z, E.WATER, { fill: L.FULL + (L.FULL >> 4) });
  exact(w, 300, 'migration');
  // packed: in every column every liquid cell under a liquid cell is full
  for (let z = 1; z < 7; z++) for (let x = 1; x < 7; x++) for (let y = 1; y < 15; y++) {
    const c = w.cores[w.at(x, y, z)], above = w.cores[w.at(x, y + 1, z)];
    if (L.isLiquid(L.cid(c)) && L.isLiquid(L.cid(above))) assert.equal(L.cFill(c), L.FULL, `${x},${y},${z} packed`);
  }
});

test('rest: a settled lake certifies idle and stays an exact fixed point, woken or not', () => {
  const w = new ColumnGrid(16, 16, 16);
  walls(w);
  for (let y = 1; y < 6; y++) for (let z = 1; z < 15; z++) for (let x = 1; x < 15; x++) w.set(x, y, z, E.WATER, { T: 10 + 4 * y });
  w.set(7, 6, 7, E.WATER, { fill: L.FULL / 2 });
  let t = 0;
  while (w.idleAt < 0 && t < 1800) { w.step(); t++; }
  assert.ok(w.idleAt >= 0, 'certifies idle');
  const cores = w.cores.map(c => Array.from(c)), banks = Int32Array.from(w.banks);
  for (let k = 0; k < 30; k++) { w.busyIn.fill(1); w.step(); }
  w.cores.forEach((c, i) => assert.deepEqual(Array.from(c), cores[i], `cell ${i} moved at rest`));
  assert.deepEqual(Int32Array.from(w.banks), banks);
});

test('the bench single-liquid gates at unchanged thresholds (U-tube, partial, puddle, yield)', async () => {
  for (const name of ['utube', 'partial', 'puddle', 'yield']) {
    const r = await runTest(TESTS.find(t => t.name === name), createEngine(), { seed: 1 });
    assert.equal(r.status, 'pass', `${name}: ${JSON.stringify(r.checks ?? r.reason)}`);
  }
});

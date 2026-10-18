// CPU-only witness for liquids under radial gravity (src/shaders/v2/columns.js RADIAL): the emitted col*
// bodies executed on production-format cells (tools/v2/column-wgsl.mjs). Pins (1) each cell's pull is
// mDown's (src/shaders/v2/modes.js: the dominant axis of the vector toward the centre, its ties to y, then x),
// (2) a spill on a planet spreads into a lens level about the centre and certifies idle, with exact mass,
// energy and fuel every tick and nothing left standing on air, on all six faces alike, (3) the outcome
// bench's radialSpread passes on this engine and fails on radial gravity as it was at 7f9b2f1c (the red
// variant: liquids held still). Vertical gravity runs none of this code (the kernels branch on
// P.gravMode 2 first); tools/v2/column-wgsl-check.mjs pins it unchanged. No GPU, browser or World variant.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { E } from '../../src/elements.js';
import * as L from '../../src/v2/layout.js';
import { gravityAt } from '../../src/v2/modes.js';
import { ColumnGrid } from './column-wgsl.mjs';
import { radialSpread } from '../outcomes/tests/radial.js';
import { runTest } from '../outcomes/run.js';
import { createEngine } from '../outcomes/engine-column-wgsl.js';

// modes.js mDown, from the shared force (gravityAt): the axis of the largest component, ties to y then x
function mDown(p, dims) {
  const g = gravityAt(p, dims, { gravMode: 2, gravity: 19.6 }), a = g.map(Math.abs);
  let axis = 1;
  if (a[0] > a[1] && a[0] >= a[2]) axis = 0;
  if (a[2] > a[1] && a[2] > a[0]) axis = 2;
  return [axis, Math.sign(g[axis])];
}

test("each cell's pull is mDown's: the dominant axis toward the centre, the same ties", () => {
  for (const [nx, ny, nz] of [[16, 16, 16], [16, 8, 24], [9, 7, 11]]) {
    const w = new ColumnGrid(nx, ny, nz, { gravMode: 2 });
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const [axis, sign] = mDown([x + 0.5, y + 0.5, z + 0.5], [nx, ny, nz]), a = w.ctx.colRadAxis(x, y, z);
      assert.deepEqual([a, w.ctx.colRadSign(x, y, z, a)], [axis, sign], `${nx}×${ny}×${nz} cell ${x},${y},${z}`);
    }
  }
});

const N = 32, LO = 8, HI = 23;   // a 16³ planet at the centre of a 32³ box
// the six faces' towers: 2×2 at the face's centre, 4 cells out from it, along the face's normal
const FACES = [[1, 1], [1, -1], [0, 1], [0, -1], [2, 1], [2, -1]];
function tower([axis, side]) {
  const cells = [];
  for (let k = 0; k < 4; k++) for (let u = 15; u <= 16; u++) for (let v = 15; v <= 16; v++) {
    const p = [0, 0, 0], [a, b] = [0, 1, 2].filter(i => i !== axis);
    p[axis] = side > 0 ? HI + 1 + k : LO - 1 - k; p[a] = u; p[b] = v;
    cells.push(p);
  }
  return cells;
}
// the water over one face: each column's depth along the normal and the head at its surface (its distance
// to the centre, cells)
function lens(w, [axis, side]) {
  const [a, b] = [0, 1, 2].filter(i => i !== axis), cols = [];
  for (let u = LO; u <= HI; u++) for (let v = LO; v <= HI; v++) {
    let m = 0;
    for (let k = 0; k < N / 2 - (HI - LO + 1) / 2; k++) {
      const p = [0, 0, 0]; p[axis] = side > 0 ? HI + 1 + k : LO - 1 - k; p[a] = u; p[b] = v;
      const c = w.cores[w.at(...p)];
      if (L.isLiquid(L.cid(c))) m += L.cFill(c) / L.FULL;
    }
    if (!m) continue;
    const s = [0, 0, 0]; s[axis] = side > 0 ? HI + 1 + m : LO - m; s[a] = u + 0.5; s[b] = v + 0.5;
    cols.push({ m, head: Math.hypot(...s.map(x => x - N / 2)) });
  }
  return cols;
}
function planet(faces, opts = {}) {
  const w = new ColumnGrid(N, N, N, { gravMode: 2, ...opts });
  for (let y = LO; y <= HI; y++) for (let z = LO; z <= HI; z++) for (let x = LO; x <= HI; x++) w.set(x, y, z, E.WALL);
  // a warm and a cold half, so the custody check sees energy move with the water
  for (const f of faces) for (const p of tower(f)) w.set(...p, E.WATER, { T: 5 + 3 * (p[0] + p[2]) });
  return w;
}
// liquid whose pull's next cell is air: on the GPU radialDrip throws it as particles (this engine has none)
function standingOnAir(w) {
  let n = 0;
  for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    if (!L.isLiquid(L.cid(w.cores[w.at(x, y, z)]))) continue;
    const a = w.ctx.colRadAxis(x, y, z), p = [x, y, z]; p[a] += w.ctx.colRadSign(x, y, z, a);
    if (L.cid(w.cores[w.at(...p)]) === E.EMPTY) n++;
  }
  return n;
}

test('a spill on every face of a planet spreads into a lens level about the centre, exactly, and rests', () => {
  const w = planet(FACES), t0 = w.totals();
  let t = 0;
  for (; w.idleAt < 0 && t < 600; t++) {
    w.step();
    const t1 = w.totals();
    assert.equal(t1.mass, t0.mass, `mass at tick ${t}`); assert.equal(t1.energy, t0.energy, `energy at tick ${t}`); assert.equal(t1.fuel, t0.fuel, `fuel at tick ${t}`);
    assert.equal(standingOnAir(w), 0, `liquid on air at tick ${t}`);
  }
  assert.ok(w.idleAt >= 0, 'certifies idle within 10 s');
  const shapes = FACES.map(f => lens(w, f));
  for (const [i, cols] of shapes.entries()) {
    const deep = cols.filter(c => c.m >= 0.25), heads = deep.map(c => c.head);
    // each face keeps its own 16 cells (the lenses never reach a seam): its packing and sideways faces leak nothing
    assert.ok(Math.abs(cols.reduce((s, c) => s + c.m, 0) - 16) < 1e-9, `face ${FACES[i]}: its 16 cells`);
    assert.ok(cols.length >= 16, `face ${FACES[i]}: spreads (${cols.length} columns)`);
    assert.ok(Math.max(...heads) - Math.min(...heads) < 1 / 300, `face ${FACES[i]}: level to under 0.1 mm (${Math.max(...heads) - Math.min(...heads)} cells)`);
    // not flat: under a pull toward the centre the surface curves with the planet (the face's middle deepest)
    assert.ok(Math.max(...cols.map(c => c.m)) > Math.min(...deep.map(c => c.m)) + 0.1, `face ${FACES[i]}: curved, not flat`);
  }
  // the six pyramids' rules are one rule turned: every lens has the same footprint
  assert.deepEqual(shapes.map(c => c.length), shapes.map(() => shapes[0].length), 'the same lens on every face');
  // and the rest is an exact fixed point, woken or not
  const cores = w.cores.map(c => Array.from(c));
  for (let k = 0; k < 30; k++) { w.busyIn.fill(1); w.step(); }
  w.cores.forEach((c, i) => assert.deepEqual(Array.from(c), cores[i], `cell ${i} moved at rest`));
});

test('the outcome bench: radialSpread passes, and fails on radial gravity as it was at 7f9b2f1c', async () => {
  const now = await runTest(radialSpread, createEngine(), { seed: 1 });
  assert.equal(now.status, 'pass', JSON.stringify(now.criteria));
  const before = await runTest(radialSpread, createEngine({ stillRadial: true }), { seed: 1 });
  assert.equal(before.status, 'fail', 'the red variant');
  const failed = before.criteria.filter(c => !c.ok).map(c => c.name);
  // (a tower held still is level by symmetry: it fails on spreading)
  assert.ok(failed.includes('spreads (wet columns)'), `held still: ${failed}`);
});

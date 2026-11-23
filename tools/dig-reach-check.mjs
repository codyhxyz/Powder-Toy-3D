// CPU regression: a held rapid miner must not follow stale GPU picks past reach.
// node tools/dig-reach-check.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { digger, BLOCK, biteSize, biteCells, resizeBite, wheelBite, bitesByWheel, biteStatus, blockMin, biteBox, boxCells } from '../src/pov/tools/dig.js';
import { BITE_MIN, BITE_MAX, BITE_NOTCHES, biteLabel } from '../src/pov/constants.js';
import { E } from '../src/elements.js';
import { holdFor } from '../src/pov/holds.js';

function fixture(face, distance, diagonal = false) {
  const axis = face >> 1, sign = face % 2 === 0 ? -1 : 1;
  const cell = new THREE.Vector3(24, 24, 24);
  const point = cell.clone().addScalar(0.5);
  point.setComponent(axis, cell.getComponent(axis) + (sign < 0 ? 1 : 0));
  const dir = new THREE.Vector3().setComponent(axis, sign);
  if (diagonal) dir.setComponent((axis + 1) % 3, 1);
  dir.normalize();
  const ctx = {
    eye: point.clone().addScaledVector(dir, -distance), dir,
    aim: { valid: true, cell, face, dist: distance, id: E.ROCK },
    sim: { g: { nx: 64, ny: 64, nz: 64 } },
  };
  const tool = digger({ owner: 'reach-check' }, { power: 30, limit: 52, tools: ['pickaxe', 'shovel'], reach: 5 });
  const bites = [];
  const transfer = { take(_load, request) { bites.push(request.cells); return Promise.resolve(request.cells.length); } };
  const strike = () => {
    const target = tool.target(ctx);
    if (target) tool.blow(ctx, target, {}, transfer);
    return target;
  };
  return { tool, ctx, strike, bites };
}

for (let face = 0; face < 6; face++) {
  for (const diagonal of [false, true]) {
    const f = fixture(face, 4.5, diagonal);
    try {
      assert.ok(f.strike(), 'the original face is in reach');
      for (let i = 0; i < 6; i++) assert.equal(f.strike(), null, 'stale aim cannot tunnel beyond reach');
      assert.equal(f.bites.length, 1);
      assert.equal(f.bites[0].length, BLOCK ** 3);
    } finally { f.tool.dispose(); }
  }
  const near = fixture(face, 0.5);
  try {
    const first = near.strike();
    const second = near.strike();
    assert.ok(first && second, 'stale-pick advance still works inside reach');
    assert.equal(first.min.distanceTo(second.min), BLOCK);
    assert.equal(near.strike(), null, 'third face exceeds reach');
    assert.equal(near.bites.length, 2);
  } finally { near.tool.dispose(); }
  const slanted = fixture(face, 1.5, true);
  try {
    assert.ok(slanted.strike());
    assert.equal(slanted.strike(), null, 'reach measures along the ray, not only along the face axis');
  } finally { slanted.tool.dispose(); }
  for (const scale of [0.2, 7]) {
    const exact = fixture(face, 2);
    exact.ctx.dir.multiplyScalar(scale);
    try {
      assert.ok(exact.strike());
      assert.ok(exact.strike(), 'advanced face exactly at reach is accepted with a nonunit ray');
      assert.equal(exact.strike(), null, 'nonunit ray cannot extend reach');
    } finally { exact.tool.dispose(); }
    const angled = fixture(face, 1.5, true);
    angled.ctx.dir.multiplyScalar(scale);
    try {
      assert.ok(angled.strike());
      assert.equal(angled.strike(), null, 'oblique nonunit ray keeps world-distance reach');
    } finally { angled.tool.dispose(); }
  }
}
// The bite's size (the wheel): the player's tools take a bite of any size from one cell to the block;
// the block is the lattice's, a smaller one sits on the crosshair; an NPC's keep the block.
{
  const grid = { nx: 64, ny: 64, nz: 64 };
  const NEAR = 1e-9;
  // looking straight at face `face` of `cell`, at the point (u, v) of it (0..1 across its two other axes)
  const aimAt = (cell, face, u = 0.5, v = 0.5) => {
    const axis = face >> 1, out = face % 2 === 0 ? 1 : -1;
    const point = cell.clone();
    point.setComponent(axis, cell.getComponent(axis) + (out > 0 ? 1 : 0));
    point.setComponent((axis + 1) % 3, cell.getComponent((axis + 1) % 3) + u);
    point.setComponent((axis + 2) % 3, cell.getComponent((axis + 2) % 3) + v);
    const dir = new THREE.Vector3().setComponent(axis, -out);
    return { eye: point.clone().addScaledVector(dir, -2), dir, point, aim: { valid: true, cell, face, dist: 2, id: E.SAND }, sim: { g: grid } };
  };
  const bite = (owner, cell, face, u, v) => {
    const tool = digger({ owner }, { power: 6, tools: ['shovel'], reach: 15 });
    let cells = null;
    const transfer = { take(_load, request) { cells = request.cells; return Promise.resolve(cells.length); } };
    try {
      const ctx = aimAt(cell, face, u, v), t = tool.target(ctx);
      assert.ok(t, 'sand in reach is a target');
      tool.blow(ctx, t, {}, transfer);
      return { t, cells, ctx };
    } finally { tool.dispose(); }
  };
  const span = (cells, a) => [Math.min(...cells.map((c) => c[a])), Math.max(...cells.map((c) => c[a]))];
  const setSize = (s) => { resizeBite(s - biteSize()); assert.ok(Math.abs(biteSize() - s) < NEAR, `size ${s}`); };
  const CELLS = [new THREE.Vector3(24, 24, 24), new THREE.Vector3(25, 26, 23), new THREE.Vector3(31, 20, 29)];

  assert.equal(biteSize(), BLOCK, 'the block is the default');
  assert.equal(resizeBite(1), null, 'no bigger than the block');
  // the block: the lattice's, wherever on the face you look
  for (const cell of CELLS) for (let face = 0; face < 6; face++) for (const [u, v] of [[0.5, 0.5], [0.05, 0.95]]) {
    const { t, cells } = bite(null, cell, face, u, v);
    assert.equal(t.size, BLOCK);
    assert.equal(cells.length, BLOCK ** 3);
    assert.deepEqual(cells[0], cell.toArray(), 'nearest first: the aimed cell');
    const axis = face >> 1, lattice = blockMin(cell);
    for (let a = 0; a < 3; a++) {
      const [lo, hi] = span(cells, a);
      assert.equal(hi - lo, BLOCK - 1);
      if (a !== axis) assert.equal(lo, lattice.getComponent(a), 'across the face it is the lattice square');
      else assert.equal(face % 2 === 0 ? hi : lo, cell.getComponent(a), 'it starts at the aimed face');
    }
    assert.equal(bite('npc', cell, face, u, v).cells.length, BLOCK ** 3);
  }
  // the finest: the aimed cell alone, wherever on its face you look (its edges too)
  setSize(BITE_MIN);
  assert.equal(resizeBite(-1), null, 'no finer than one cell');
  assert.equal(biteSize('npc'), BLOCK, "an NPC's bite stays the block");
  assert.equal(biteCells(), 1);
  assert.equal(biteCells('npc'), BLOCK ** 3);
  for (const cell of CELLS) for (let face = 0; face < 6; face++) for (const [u, v] of [[0.5, 0.5], [0, 0], [1, 1], [0, 1], [0.3, 0.9]]) {
    const { cells } = bite(null, cell, face, u, v);
    assert.deepEqual(cells, [cell.toArray()], 'a one-cell bite is the aimed cell');
    assert.equal(bite('npc', cell, face, u, v).cells.length, BLOCK ** 3);
    const b = biteBox(cell, face, BITE_MIN, aimAt(cell, face, u, v).eye, aimAt(cell, face, u, v).dir, true);
    const axis = face >> 1, out = face % 2 === 0 ? 1 : -1;
    const against = cell.clone().setComponent(axis, cell.getComponent(axis) + out);
    assert.deepEqual(boxCells(b.min, b.max, grid, against), [against.toArray()], 'a one-cell block is the cell against the face');
  }
  // between: a box of that side centred on the crosshair, that deep behind the face; the cells with their centres in it
  for (const [s, deep, cases] of [
    [1.4, 1, [[0.5, 0.5, [0, 0], [0, 0]], [0.9, 0.5, [0, 1], [0, 0]], [0.1, 0.9, [-1, 0], [0, 1]]]],
    [2, 2, [[0.3, 0.8, [-1, 0], [0, 1]], [0.8, 0.3, [0, 1], [-1, 0]]]],
    [2.2, 2, [[0.5, 0.5, [-1, 1], [-1, 1]], [0.9, 0.1, [0, 1], [-1, 0]]]],
    [2.8, 3, [[0.5, 0.5, [-1, 1], [-1, 1]]]],
  ]) {
    setSize(s);
    assert.equal(biteCells(), Math.round(s ** 3));
    for (const cell of CELLS) for (let face = 0; face < 6; face++) for (const [u, v, du, dv] of cases) {
      const { t, cells, ctx } = bite(null, cell, face, u, v);
      const axis = face >> 1, ua = (axis + 1) % 3, va = (axis + 2) % 3;
      assert.ok(cells.some((c) => c.join() === cell.toArray().join()), 'the aimed cell is in it');
      assert.deepEqual(span(cells, ua), du.map((d) => cell.getComponent(ua) + d), `size ${s} across, looking at ${u}`);
      assert.deepEqual(span(cells, va), dv.map((d) => cell.getComponent(va) + d), `size ${s} across, looking at ${v}`);
      const [lo, hi] = span(cells, axis);
      assert.equal(hi - lo + 1, deep, `size ${s} is ${deep} deep`);
      assert.equal(face % 2 === 0 ? hi : lo, cell.getComponent(axis), 'it starts at the aimed face');
      // the outline: the box itself, its side `s`, centred where you look
      for (let a = 0; a < 3; a++) assert.ok(Math.abs(t.hi.getComponent(a) - t.lo.getComponent(a) - s) < NEAR, 'the box is s a side');
      for (const a of [ua, va]) assert.ok(Math.abs((t.lo.getComponent(a) + t.hi.getComponent(a)) / 2 - ctx.point.getComponent(a)) < NEAR, 'centred on the crosshair');
      // a block built there: the same square across, out from the face
      const b = biteBox(cell, face, s, ctx.eye, ctx.dir, true);
      for (const a of [ua, va]) { assert.equal(b.min.getComponent(a), t.min.getComponent(a)); assert.equal(b.max.getComponent(a), t.max.getComponent(a)); }
      assert.equal(face % 2 === 0 ? b.min.getComponent(axis) : b.max.getComponent(axis) - 1, cell.getComponent(axis) + (face % 2 === 0 ? 1 : -1), 'a block stands against the face');
      assert.equal(b.max.getComponent(axis) - b.min.getComponent(axis), deep);
    }
  }
  // a held fine dig goes on to the cells behind the one just dug (the aim is a pick a frame or two late)
  setSize(BITE_MIN);
  for (let face = 0; face < 6; face++) {
    const f = fixture(face, 0.5);
    f.tool.dispose();
    const tool = digger({ owner: null }, { power: 30, limit: 52, tools: ['pickaxe', 'shovel'], reach: 5 });
    const transfer = { take: (_l, r) => Promise.resolve(r.cells.length) };
    try {
      const first = tool.target(f.ctx); tool.blow(f.ctx, first, {}, transfer);
      const second = tool.target(f.ctx); tool.blow(f.ctx, second, {}, transfer);
      assert.equal(first.min.distanceTo(second.min), 1, 'the next cell in');
      assert.equal(tool.target(f.ctx).min.distanceTo(first.min), 2);
    } finally { tool.dispose(); }
  }
  setSize(BLOCK);

  // the wheel (ctx.wheelTurn: notches and parts of one, + toward you): away is bigger, toward smaller,
  // as far as it turned; the player's only; one notice reads the size out
  const said = [];
  const env = { owner: null, feedback: { toast: (text, opts) => { said.push([text, opts.replace]); return 'notice'; } } }, npc = { owner: 'npc', feedback: env.feedback };
  const notch = (BITE_MAX - BITE_MIN) / BITE_NOTCHES;
  assert.equal(bitesByWheel(env), true);
  assert.equal(bitesByWheel(npc), false);
  wheelBite(env, { wheelTurn: -1 });
  assert.equal(said.length, 0, 'at the block a notch bigger says nothing');
  wheelBite(npc, { wheelTurn: 1 });
  wheelBite(env, { wheelTurn: 0 });
  wheelBite(env, {});
  assert.equal(biteSize(), BLOCK, "an NPC's wheel and a still wheel change nothing");
  wheelBite(env, { wheelTurn: 1 });
  assert.ok(Math.abs(biteSize() - (BLOCK - notch)) < NEAR, 'a notch toward you: a notch smaller');
  assert.deepEqual(said.at(-1), [`Dig and build size: ${biteLabel(BLOCK - notch)}`, null]);
  assert.equal(biteStatus(env, 'SAND ×12'), `SAND ×12 · ${biteLabel(BLOCK - notch)}`);
  assert.equal(biteStatus(env, null), biteLabel(BLOCK - notch));
  assert.equal(biteStatus(npc, 'SAND ×12'), 'SAND ×12');
  wheelBite(env, { wheelTurn: 0.25 });
  assert.ok(Math.abs(biteSize() - (BLOCK - 1.25 * notch)) < NEAR, 'a quarter notch moves it a quarter as far');
  assert.equal(said.at(-1)[1], 'notice', 'the same notice takes the new size');
  wheelBite(env, { wheelTurn: BITE_NOTCHES });
  assert.equal(biteSize(), BITE_MIN, 'it stops at one cell');
  assert.equal(said.at(-1)[0], `Dig and build size: ${biteLabel(BITE_MIN)}`);
  const n = said.length;
  wheelBite(env, { wheelTurn: 1 });
  assert.equal(said.length, n, 'at one cell a notch smaller says nothing');
  for (let i = 0; i < BITE_NOTCHES; i++) wheelBite(env, { wheelTurn: -1 });
  assert.equal(biteSize(), BLOCK, 'the notches back up land on the block exactly');
  assert.equal(biteStatus(env, 'SAND ×12'), 'SAND ×12');
  for (let i = 0; i < BITE_NOTCHES; i++) wheelBite(env, { wheelTurn: 1 });
  assert.equal(biteSize(), BITE_MIN, 'and the notches down on one cell exactly');
  wheelBite(env, { wheelTurn: -BITE_NOTCHES });
  assert.equal(biteSize(), BLOCK, 'back at the default for the checks below');
  assert.deepEqual([BITE_MIN, 1.5, BLOCK].map(biteLabel), ['0.3 m', '0.45 m', '0.9 m']);
}
const grip = holdFor('jackhammer');
assert.equal(grip.right.palm[0], -1, 'right palm faces inward');
assert.equal(grip.left.palm[0], 1, 'left palm faces inward');
console.log('PASS: stale mining reach on six faces, diagonal rays, in-reach continuation, a wheel-set bite of any size from one cell to the block, mirrored jackhammer grip');

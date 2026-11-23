// CPU regression: a held rapid miner must not follow stale GPU picks past reach.
// node tools/dig-reach-check.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { digger, BLOCK, biteSize, toggleBite, toggleToolBite, biteStatus, blockMin } from '../src/pov/tools/dig.js';
import { BITE_FINE, biteLabel } from '../src/pov/constants.js';
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
// The bite's size (the tool mode key): the player's tools take the block or, fine, the aimed cell;
// an NPC's keep the block.
{
  const aimAt = (cell, face) => ({
    eye: cell.clone().addScalar(0.5).add(new THREE.Vector3(0, 2, 0)), dir: new THREE.Vector3(0, -1, 0),
    aim: { valid: true, cell, face, dist: 1.5, id: E.SAND },
    sim: { g: { nx: 64, ny: 64, nz: 64 } },
  });
  const bite = (owner, cell, face) => {
    const tool = digger({ owner }, { power: 6, tools: ['shovel'], reach: 15 });
    let cells = null;
    const transfer = { take(_load, request) { cells = request.cells; return Promise.resolve(cells.length); } };
    try {
      const ctx = aimAt(cell, face), t = tool.target(ctx);
      assert.ok(t, 'sand in reach is a target');
      tool.blow(ctx, t, {}, transfer);
      return { t, cells };
    } finally { tool.dispose(); }
  };
  assert.equal(biteSize(), BLOCK, 'the big bite is the default');
  const sizes = [];
  for (const n of [BLOCK, BITE_FINE]) {
    assert.equal(biteSize(), n);
    assert.equal(biteSize('npc'), BLOCK, "an NPC's bite stays the block");
    for (const cell of [new THREE.Vector3(24, 24, 24), new THREE.Vector3(25, 26, 23), new THREE.Vector3(31, 20, 29)]) {
      for (let face = 0; face < 6; face++) {
        const { t, cells } = bite(null, cell, face);
        assert.equal(t.size, n);
        assert.equal(cells.length, n ** 3, `a size-${n} bite is ${n}³ cells`);
        assert.ok(cells.some(([x, y, z]) => x === cell.x && y === cell.y && z === cell.z), 'the bite holds the aimed cell');
        assert.deepEqual(cells[0], cell.toArray(), 'nearest first: the aimed cell');
        // n deep behind the aimed face, the n-cell lattice square across it
        const axis = face >> 1, lattice = blockMin(cell, undefined, n);
        for (let a = 0; a < 3; a++) {
          const lo = Math.min(...cells.map((c) => c[a])), hi = Math.max(...cells.map((c) => c[a]));
          assert.equal(hi - lo, n - 1);
          if (a !== axis) assert.equal(lo, lattice.getComponent(a), 'across the face it is the lattice square');
          else assert.equal(face % 2 === 0 ? hi : lo, cell.getComponent(a), 'it starts at the aimed face');
        }
        assert.equal(bite('npc', cell, face).cells.length, BLOCK ** 3);
      }
    }
    sizes.push(biteLabel(n));
    if (n === BLOCK) assert.equal(toggleBite(), BITE_FINE, 'the key flips the block to fine');
  }
  assert.deepEqual(sizes, ['0.9 m', '0.3 m']);
  // the key's handler: flips the size, toasts it, marks the status, and is the player's only
  const said = [];
  const env = { owner: null, feedback: { toast: (text) => said.push(text) } };
  assert.equal(biteStatus(env, 'SAND ×12'), 'SAND ×12 · 0.3 m');
  assert.equal(biteStatus(env, null), '0.3 m');
  assert.equal(biteStatus({ owner: 'npc' }, 'SAND ×12'), 'SAND ×12');
  assert.equal(toggleToolBite({ owner: 'npc' }), false);
  assert.equal(biteSize(), BITE_FINE, "an NPC's tool doesn't flip the player's size");
  assert.equal(toggleToolBite(env), true);
  assert.equal(said.at(-1), 'Block size: 0.9 m');
  assert.equal(biteStatus(env, 'SAND ×12'), 'SAND ×12');
  assert.equal(toggleToolBite(env), true);
  assert.equal(said.at(-1), 'Fine size: 0.3 m');
  toggleToolBite(env);
  assert.equal(biteSize(), BLOCK, 'back at the default for the checks below');
}
const grip = holdFor('jackhammer');
assert.equal(grip.right.palm[0], -1, 'right palm faces inward');
assert.equal(grip.left.palm[0], 1, 'left palm faces inward');
console.log('PASS: stale mining reach on six faces, diagonal rays, in-reach continuation, block and fine bite sizes, mirrored jackhammer grip');

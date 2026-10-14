// CPU regression: a held rapid miner must not follow stale GPU picks past reach.
// node tools/dig-reach-check.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { digger, BLOCK } from '../src/pov/tools/dig.js';
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
}
const grip = holdFor('jackhammer');
assert.equal(grip.right.palm[0], -1, 'right palm faces inward');
assert.equal(grip.left.palm[0], 1, 'left palm faces inward');
console.log('PASS: stale mining reach on six faces, diagonal rays, in-reach continuation, mirrored jackhammer grip');

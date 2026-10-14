// CPU reference for dirtyFrag's recent-centre shortcut. No browser/GPU.
import assert from 'node:assert/strict';
import { AGE, FIELD_EMA_SETTLE, GI_RECENT, GI_NEAR_DILATE, FIELDS_DILATE, WORK_DILATE } from '../src/shaders/fields.js';

const side = 32; // the brick grid of a 128³ simulation
const ages = new Uint32Array(side ** 3);
const index = (x, y, z) => x + side * (y + side * z);
const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < side && y < side && z < side;
const bit = (x, y, z) => 1 << ((x + 1) + 3 * (y + 1) + 9 * (z + 1));
const offsets = [];
for (let z = -WORK_DILATE; z <= WORK_DILATE; z++)
  for (let y = -WORK_DILATE; y <= WORK_DILATE; y++)
    for (let x = -WORK_DILATE; x <= WORK_DILATE; x++) {
      let fields = 0;
      for (let fz = -1; fz <= 1; fz++) for (let fy = -1; fy <= 1; fy++) for (let fx = -1; fx <= 1; fx++)
        if (Math.max(Math.abs(x - fx), Math.abs(y - fy), Math.abs(z - fz)) <= FIELDS_DILATE) fields |= bit(fx, fy, fz);
      const distance = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
      offsets.push({ x, y, z, distance, fields, ema: distance <= 1 ? bit(x, y, z) : 0 });
    }
let checked = 0, seed = 42;
for (const pattern of ['awake', 'mixed', 'sparse']) {
  for (let i = 0; i < ages.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    ages[i] = pattern === 'awake' ? 0 : pattern === 'sparse' && (seed >>> 24) > 3 ? AGE.MAX
      : [0, FIELD_EMA_SETTLE - 1, FIELD_EMA_SETTLE, GI_RECENT - 1, GI_RECENT, AGE.MAX][(seed >>> 24) % 6];
    if (i % 3 === 0) ages[i] |= AGE.FRESH; // age flag bits are not part of its value
  }
  for (let z = 0; z < side; z++) for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    if ((ages[index(x, y, z)] & AGE.MASK) >= Math.min(FIELD_EMA_SETTLE, GI_RECENT)) continue;
    let near = WORK_DILATE + 1, em = 0, fm = 0, gi = false, fastEm = 0;
    for (const o of offsets) {
      if (!inside(x + o.x, y + o.y, z + o.z)) continue;
      const age = ages[index(x + o.x, y + o.y, z + o.z)] & AGE.MASK;
      if (age < FIELD_EMA_SETTLE) { near = Math.min(near, o.distance); em |= o.ema; fm |= o.fields; }
      if (age < GI_RECENT && o.distance <= GI_NEAR_DILATE) gi = true;
    }
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (inside(x + dx, y + dy, z + dz) && (ages[index(x + dx, y + dy, z + dz)] & AGE.MASK) < FIELD_EMA_SETTLE)
        fastEm |= bit(dx, dy, dz);
    }
    assert.equal(near, 0);
    assert.equal(gi, true);
    assert.equal(em, fastEm);
    assert.equal(fm, (1 << 27) - 1);
    checked++;
  }
}
assert(checked > ages.length, 'must cover mixed ages, not just the fully awake case');
console.log(`dirty fast path: ${checked} recent bricks match full dilation, including grid boundaries and age flags`);

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFold, foldWGSL } from '../src/world/scenes/descent/terrainFold.js';

const config = {
  sourceMinX: -4608, sourceWidth: 9216, cellScale: 1,
  angleStart: -Math.PI / 2, angleSpan: Math.PI * 1.5,
  thickness: 48, shellThickness: 2, margin: 32,
};
const fold = createFold(config), top = 992, height = 320;
const close = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const vectorClose = (a, b) => { assert.ok(a && b); a.forEach((v, i) => close(v, b[i])); };
const hash = (a) => createHash('sha256').update(a).digest('hex');
let state = 17;
const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);

// Every original coordinate has one inverse, including all material-fiber depths.
for (let i = 0; i < 20000; i++) {
  const source = [config.sourceMinX + .01 + random() * (config.sourceWidth - .02),
    top + .01 + random() * (height - .02), (random() - .5) * (config.thickness - .02)];
  vectorClose(fold.inverse(fold.forward(source, top, height), top, height), source);
  const world = fold.forward(source, top, height);
  assert.equal(fold.classify(world, top, height), 'source');
  const adjacent = fold.forward([source[0], source[1] + 256, source[2]], top + 256, height);
  // Changing bands must only change local Y. Global source geography stays put.
  vectorClose(adjacent, world);
  const handoff = fold.forward(source, top + 256, height);
  close(handoff[0], world[0]); close(handoff[2], world[2]);
  close(handoff[1], world[1] + 256);
  close(handoff[1] - (top + 256 + height), world[1] - (top + height), 1e-7);
}

// No collapsed inner hinge, self-contact, or zero-width crop is accepted.
for (const patch of [
  { angleSpan: Math.PI * 2 }, { angleSpan: 0 }, { cellScale: 0 },
  { thickness: 10000 }, { sourceWidth: 0 }, { sourceMinX: NaN },
  { sourceMinX: .5 }, { sourceWidth: 12.3 },
  { angleSpan: Math.PI * 2 - .0001 }, { shellThickness: 0 },
]) assert.throws(() => createFold({ ...config, ...patch }));

// Explicit caps, not native material: both radial sides and both arc ends.
const mid = config.sourceMinX + config.sourceWidth / 2, sy = top + 100;
for (const sign of [-1, 1]) {
  assert.equal(fold.classify(fold.forward([mid, sy, sign * 23.9], top, height), top, height), 'source');
  assert.equal(fold.classify(fold.forward([mid, sy, sign * 24.5], top, height), top, height), 'cap');
  assert.equal(fold.classify(fold.forward([mid, sy, sign * 26.5], top, height), top, height), 'outside');
}
for (const sx of [config.sourceMinX - .5, config.sourceMinX + config.sourceWidth + .5]) {
  const world = fold.forward([sx, sy, 0], top, height);
  assert.equal(fold.classify(world, top, height), 'cap');
  assert.equal(fold.inverse(world, top, height), null);
}
assert.equal(fold.classify([0, -1, 0], top, height), 'outside');
assert.equal(fold.classify([0, height, 0], top, height), 'outside');

// The source atlas is independent of the choice of fold.
const source = Uint8Array.from({ length: 64 * height }, (_, i) => i % 11);
const before = hash(source);
const smallConfig = { ...config, sourceMinX: 0, sourceWidth: 64, thickness: 4, shellThickness: 1, margin: 8 };
const shapes = [createFold({ ...smallConfig, angleSpan: Math.PI }),
  createFold({ ...smallConfig, angleSpan: Math.PI * 1.5 })];
const sample = (f, data, world) => {
  const p = f.inverse(world, top, height);
  if (!p) return null;
  return data[Math.floor(p[1] - top) * 64 + Math.floor(p[0])];
};
for (const f of shapes) {
  for (let y = 0; y < height; y += 7) for (let x = 0; x < 64; x++) {
    const world = f.forward([x + .5, top + y + .5, .2], top, height);
    assert.equal(sample(f, source, world), source[y * 64 + x]);
  }
}
assert.equal(hash(source), before);

// A source edit affects exactly its own fiber, not a secretly added connection.
const altered = source.slice(), changed = 93 * 64 + 31;
altered[changed] = 99;
for (const f of shapes) for (let y = 90; y < 97; y++) for (let x = 28; x < 35; x++) {
  for (const depth of [-1.5, 0, 1.5]) {
    const world = f.forward([x + .5, top + y + .5, depth], top, height);
    assert.equal(sample(f, source, world) !== sample(f, altered, world), y * 64 + x === changed);
  }
}

// The tangential Jacobian cannot change sign: the ribbon has no hidden fold-over.
for (let x = config.sourceMinX + 1; x < config.sourceMinX + config.sourceWidth - 1; x += 13) {
  for (const depth of [-23.9, 0, 23.9]) {
    const a = fold.forward([x, sy, depth], top, height);
    const b = fold.forward([x + .01, sy, depth], top, height);
    const distance = Math.hypot(b[0] - a[0], b[2] - a[2]);
    close(distance / .01, 1 + depth / fold.radius, 1e-6);
  }
}
assert.ok(fold.size[0] % 16 === 0 && fold.size[2] % 16 === 0);
assert.equal(foldWGSL.includes('sdWord'), false, 'coordinate math must not invent or sample terrain');
let skipped = 0, columns = 0;
for (let z = 0; z < fold.size[2]; z += 64) for (let x = 0; x < fold.size[0]; x += 64) {
  columns++;
  if (fold.mayContainCellsXZ([x,z],[x+64,z+64],2)) continue;
  skipped++;
  for (let dz = -2; dz < 66; dz += 4) for (let dx = -2; dx < 66; dx += 4) {
    assert.equal(fold.classify([x+dx+.5,100,z+dz+.5],top,height), 'outside', 'culling must not remove source or caps');
  }
}
assert.ok(skipped / columns > .85, 'do not generate empty square-world corners around a thin folded map');
// The published fold holds the inflation: deepest envelope, a backdrop skin, then the cap.
const published = JSON.parse(readFileSync(new URL('../src/world/scenes/descent/terrainRoute.json', import.meta.url), 'utf8'));
const inflated = createFold(published.fold), deep = published.inflation.maxHalfDepth;
assert.equal(published.fold.thickness, 2 * (deep + published.inflation.backdropMargin));
for (const sign of [-1, 1]) {
  assert.equal(inflated.classify(inflated.forward([mid, sy, sign * deep], top, height), top, height), 'source');
  assert.equal(inflated.classify(inflated.forward([mid, sy, sign * (published.fold.thickness / 2 - .1)], top, height), top, height), 'source');
  assert.equal(inflated.classify(inflated.forward([mid, sy, sign * (published.fold.thickness / 2 + .5)], top, height), top, height), 'cap');
}
console.log(`Noita fold: 20,000 round trips, caps, band coordinates, immutable source, perturbation fibers, non-overlap; ${skipped}/${columns} provably empty far columns skipped.`);

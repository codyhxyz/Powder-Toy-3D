import assert from 'node:assert/strict';
import test from 'node:test';
import { pickUncovered } from './signsDeclutter.js';

const box = (x0, y0, w, h, dist, extra = {}) => ({ x0, y0, x1: x0 + w, y1: y0 + h, dist, ...extra });

test('the nearer of two overlapping plates keeps its text', () => {
  const near = box(0, 0, 100, 20, 5), far = box(50, 5, 100, 20, 9);
  const keep = pickUncovered([far, near], 0);
  assert.ok(keep.has(near));
  assert.ok(!keep.has(far));
});

test('separate plates all stay readable', () => {
  const a = box(0, 0, 100, 20, 5), b = box(200, 0, 100, 20, 9);
  assert.equal(pickUncovered([a, b], 0).size, 2);
});

test('the gap pads the overlap test', () => {
  const a = box(0, 0, 100, 20, 5), b = box(104, 0, 100, 20, 9);
  assert.equal(pickUncovered([a, b], 0).size, 2);
  assert.equal(pickUncovered([a, b], 6).size, 1);
});

test('a pinned plate (editing, hovered) wins over a nearer one', () => {
  const near = box(0, 0, 100, 20, 1), held = box(50, 5, 100, 20, 30, { pinned: true });
  const keep = pickUncovered([near, held], 0);
  assert.ok(keep.has(held));
  assert.ok(!keep.has(near));
});

test('a plate that was readable survives a graze from a nearer one', () => {
  const near = box(0, 0, 100, 20, 5);
  const grazed = box(98, 0, 100, 20, 9, { kept: true });
  assert.ok(pickUncovered([near, grazed], 0).has(grazed));
  assert.ok(!pickUncovered([near, { ...grazed, kept: false }], 0).has(grazed));
});

test('a chain of overlaps resolves greedily by distance', () => {
  const a = box(0, 0, 100, 20, 1), b = box(80, 0, 100, 20, 2), c = box(160, 0, 100, 20, 3);
  const keep = pickUncovered([c, b, a], 0);
  assert.ok(keep.has(a) && !keep.has(b) && keep.has(c));
});

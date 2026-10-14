import assert from 'node:assert/strict';
import { resolveCharacterMotion as resolve } from '../src/pov/village/characterCollision.js';

const resident = { x: 0, z: 0, radius: 1.4 };
const near = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const clear = (p, obstacles, radius = 1.4) => {
  for (const o of obstacles) assert.ok(Math.hypot(p.x - o.x, p.z - o.z) >= radius + o.radius - 1e-7);
};
let cases = 0;
function test(name, fn) {
  fn();
  cases++;
  console.log(`PASS ${name}`);
}
test('front/back/diagonal approach with realistic silhouette radii', () => {
  for (const angle of [0, Math.PI, Math.PI / 2, -Math.PI / 2, Math.PI / 4]) {
    const p = resolve({ x: 8 * Math.cos(angle), z: 8 * Math.sin(angle) }, { x: 0, z: 0 }, 1.4, [resident]);
    assert.equal(p.blocked, true);
    near(Math.hypot(p.x, p.z), 2.8);
  }
});
test('high-speed crossing cannot tunnel', () => {
  const p = resolve({ x: -100000, z: 0 }, { x: 100000, z: 0 }, 1.4, [resident]);
  near(p.x, -2.8);
  assert.equal(p.blocked, true);
});
test('oblique collision retains tangential sliding', () => {
  const p = resolve({ x: -6, z: 1 }, { x: 6, z: 1 }, 1.4, [resident]);
  assert.equal(p.blocked, true);
  assert.ok(p.z > 1);
  clear(p, [resident]);
});
test('tangent and outward motion remain free', () => {
  assert.deepEqual(resolve({ x: -6, z: 2.8 }, { x: 6, z: 2.8 }, 1.4, [resident]), { x: 6, z: 2.8, blocked: false });
  assert.deepEqual(resolve({ x: -2.8, z: 0 }, { x: -6, z: 0 }, 1.4, [resident]), { x: -6, z: 0, blocked: false });
});
test('multiple circles catch the slide and narrow gap', () => {
  const obstacles = [resident, { x: -2, z: 4, radius: 1.4 }];
  for (const list of [obstacles, [...obstacles].reverse()]) {
    const p = resolve({ x: -8, z: 1 }, { x: 20, z: 1 }, 1.4, list);
    assert.equal(p.blocked, true);
    clear(p, list);
  }
  const gate = [{ x: 0, z: -2, radius: 1.4 }, { x: 0, z: 2, radius: 1.4 }];
  const p = resolve({ x: -20, z: 0 }, { x: 20, z: 0 }, 1.4, gate);
  clear(p, gate);
  assert.ok(p.x < 0);
});
test('initial overlaps are stable, non-deepening, and never forcibly shoved', () => {
  assert.deepEqual(resolve({ x: 0, z: 0 }, { x: 0, z: 0 }, 1.4, [resident]), { x: 0, z: 0, blocked: true });
  assert.deepEqual(resolve({ x: 0, z: 0 }, { x: 5, z: 0 }, 1.4, [resident]), { x: 5, z: 0, blocked: true });
  const inward = resolve({ x: -1, z: 0 }, { x: 5, z: 0 }, 1.4, [resident]);
  near(inward.x, -1);
  assert.deepEqual(resolve({ x: -1, z: 0 }, { x: -5, z: 0 }, 1.4, [resident]), { x: -5, z: 0, blocked: true });
});
test('stationary clear, configurable/zero radii and immutable inputs', () => {
  const from = Object.freeze({ x: -5, z: 0 }), to = Object.freeze({ x: 5, z: 0 });
  const obstacles = Object.freeze([Object.freeze({ x: 0, z: 0, radius: 2 })]);
  assert.deepEqual(resolve(from, from, 1.4, obstacles), { ...from, blocked: false });
  near(resolve(from, to, 0.5, obstacles).x, -2.5);
  near(resolve(from, to, 0, obstacles).x, -2);
  assert.deepEqual(resolve(from, to, 0, []), { ...to, blocked: false });
});
test('defensive nonfinite inputs', () => {
  assert.deepEqual(resolve({ x: 3, z: 4 }, { x: Infinity, z: 0 }, 1, []), { x: 3, z: 4, blocked: true });
  assert.deepEqual(resolve(null, { x: 1, z: 1 }, 1), { x: 0, z: 0, blocked: true });
  assert.equal(resolve({ x: 0, z: 0 }, { x: 1, z: 1 }, -1).blocked, true);
  assert.deepEqual(resolve({ x: 0, z: 0 }, { x: 1, z: 1 }, 1, [null, { x: NaN, z: 0, radius: 1 }]), { x: 1, z: 1, blocked: false });
});
test('deterministic randomized clear starts never end inside circles', () => {
  let seed = 7331;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 2000; i++) {
    const obstacles = Array.from({ length: 8 }, () => ({ x: random() * 20 - 10, z: random() * 20 - 10, radius: random() * 2 }));
    const from = { x: -20, z: random() * 30 - 15 };
    const to = { x: 100 * random(), z: random() * 100 - 50 };
    const p = resolve(from, to, 1.4, obstacles);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
    clear(p, obstacles);
  }
});
console.log(`Character collision: ${cases} CPU tests passed.`);

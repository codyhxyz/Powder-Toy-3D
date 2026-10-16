// CPU draft shared by the analytical checks. NOT imported by the application.
import assert from 'node:assert/strict';
import { v2FluxWGSL, G_MS2, FULL } from '../../src/shaders/v2.js';
import { MAX_FILL } from '../../src/v2/layout.js';
import { CELL_M } from '../../src/scale.js';
import { gridLayout } from '../../src/sim.js';
const source = v2FluxWGSL(gridLayout(128, 128, 128));
export const nominalComp = Math.fround(Number(source.match(/\bconst COMP: f32 = ([\d.e+-]+);/)[1]));
export const sound2 = G_MS2 * CELL_M / nominalComp; // Frozen reference stiffness.
assert(nominalComp > 0 && Number.isFinite(sound2));

export function elastic(y) {
  return Math.abs(y) < 1e-3
    ? y * y * (0.5 + y * (1 / 3 + y * (1 / 8 + y * (1 / 30 + y / 144))))
    : y + (y - 1) * Math.expm1(y);
}
function pressureRemainder(x) {
  return Math.abs(x) < 1e-3
    ? x * x * (0.5 + x * (-1 / 3 + x * (1 / 4 + x * (-1 / 5 + x * (1 / 6 - x / 7)))))
    : x - Math.log1p(x);
}
export function reconstruct(f, k) {
  assert(Number.isFinite(f) && f >= 0 && f <= MAX_FILL / FULL);
  assert(Number.isFinite(k) && k >= 0);
  const threshold = k ? Math.expm1(k) / k : 1;
  const partial = f <= threshold;
  const alpha = partial ? (k ? Math.log1p(k * f) / k : f) : 1;
  const a = partial ? Math.log1p(k * f) : k + Math.log(f / threshold);
  const pi = partial ? (k ? pressureRemainder(k * f) / k : 0) : f - 1;
  const energy = partial ? f * a - pi : elastic(Math.log(f)) + f * (k - Math.log(threshold));
  return { f, k, alpha, a, pi, energy,
    bottom: Math.expm1(a), top: a > k ? Math.expm1(a - k) : 0 };
}
export const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
export const subtract = (a, b) => a.map((x, i) => x - b[i]);
export function state(f, velocity, k = nominalComp) {
  assert(f > 0 && velocity.length === 3 && velocity.every(Number.isFinite));
  const r = reconstruct(f, k);
  return { ...r, velocity, conserved: [f, ...velocity.map(u => f * u)],
    entropy: [r.a - dot(velocity, velocity) / 2, ...velocity],
    totalEnergy: r.energy + f * dot(velocity, velocity) / 2, potential: r.pi * velocity[0] };
}
// [Pi]/[a] is a mean normalized mass, NOT intrinsic material density.
// Evaluate close states without subtracting nearly equal pressures/enthalpies.
export function meanFill(l, r) {
  assert.equal(l.k, r.k);
  let lo = l.f, hi = r.f;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) return lo;
  const k = l.k, threshold = k ? Math.expm1(k) / k : 1;
  const covered = (a, b) => a === b ? a : (b - a) / Math.log1p((b - a) / a);
  const partial = (a, b) => {
    if (!k) return (a + b) / 2;
    const x = k * (b - a) / (1 + k * a);
    return a + (1 + k * a) / k * pressureRemainder(x) / Math.log1p(x);
  };
  if (lo >= threshold) return covered(lo, hi);
  if (hi <= threshold) return partial(lo, hi);
  const da = k ? Math.log1p(k * (threshold - lo) / (1 + k * lo)) : 0;
  const db = Math.log1p((hi - threshold) / threshold);
  return (partial(lo, threshold) * da + covered(threshold, hi) * db) / (da + db);
}
// One horizontal face, three momentum components. No vertical/free-surface solver.
export function flux(l, r) {
  const u = l.velocity.map((x, i) => (x + r.velocity[i]) / 2);
  const mass = meanFill(l, r) * u[0], pressure = (l.pi + r.pi) / 2;
  return [mass, ...u.map((v, i) => mass * v + (i === 0 ? pressure : 0))];
}

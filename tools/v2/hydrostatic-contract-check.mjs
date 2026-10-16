// CPU-only constitutive/face algebra, not a World variant or time integrator.
// Draft: linear liquid EOS + hydrostatic reconstruction along vertical gravity.
// See docs/v2/evidence/liquid-head-contract.md. No production code uses this.
import assert from 'node:assert/strict';
import { SUB, TICK_HZ, FULL } from '../../src/shaders/v2.js';
import { CELL_M } from '../../src/scale.js';
import { nominalComp, sound2, elastic, reconstruct, dot, subtract, state, flux, meanFill } from './hydrostatic-reference.mjs';

function near(a, b, label, scale = Math.max(Math.abs(a), Math.abs(b), 1e-30)) {
  assert(Number.isFinite(a) && Number.isFinite(b), label);
  assert(Math.abs(a - b) <= 2e-11 * scale, `${label}: ${a} vs ${b}`);
}
function integrate(depth, fn) {
  const n = 128;
  let sum = fn(0) + fn(depth);
  for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * fn(depth * i / n);
  return sum * depth / (3 * n);
}
let geometryCases = 0;
for (const k of [0, nominalComp / 8, nominalComp, 2 * nominalComp]) {
  const threshold = k ? Math.expm1(k) / k : 1;
  for (const f of [0, 1 / FULL, 0.125, 0.5, 1, threshold - 1 / FULL, threshold, threshold + 1 / FULL, 2, 8, 16]) {
    const r = reconstruct(f, k), logDensity = z => r.a - k * z;
    const mass = integrate(r.alpha, z => Math.exp(logDensity(z)));
    const traction = integrate(r.alpha, z => Math.expm1(logDensity(z)));
    const stored = integrate(r.alpha, z => elastic(logDensity(z)) + k * z * Math.exp(logDensity(z)));
    near(mass, f, 'independent density-volume integral');
    near(traction, r.pi, 'occupied side-face pressure integral');
    near(stored, r.energy, 'elastic plus gravitational energy integral');
    near(r.bottom - r.top, k * f, 'vertical pressure force balances actual mass weight', Math.max(r.bottom, r.top, k * f, 1e-30));
    near(f * r.a - r.energy, r.pi, 'Legendre pressure', Math.max(f * r.a, r.energy, r.pi, 1e-30));
    assert(r.energy >= 0 && r.alpha >= 0 && r.alpha <= 1);
    if (k) {
      const inverse = r.a <= k ? Math.expm1(r.a) / k : threshold * Math.exp(r.a - k);
      near(inverse, f, 'mass/head inverse');
    }
    geometryCases++;
  }
  // Shared hydrostatic surface: no global reservoir scan, only local reconstruction.
  if (k) for (const surface of [0.2, 0.9, 1.5, 4, 10]) {
    const fillAt = bottom => {
      const a = Math.max(0, k * (surface - bottom));
      return a <= k ? Math.expm1(a) / k : threshold * Math.exp(a - k);
    };
    for (let bottom = 0; bottom < 10; bottom++) {
      const lower = reconstruct(fillAt(bottom), k), upper = reconstruct(fillAt(bottom + 1), k);
      near(lower.top, upper.bottom, 'shared interface pressure at rest', Math.max(lower.bottom, upper.bottom, 1e-30));
    }
  }
}
assert.equal(reconstruct(0.25, 0).a, reconstruct(0.75, 0).a);
assert.notEqual(reconstruct(0.25, 0).alpha, reconstruct(0.75, 0).alpha);
// Zero-gravity head alone CANNOT recover occupied volume. Fill remains authoritative.

let faceCases = 0;
for (const k of [0, nominalComp]) {
  const states = [1 / FULL, 0.125, 0.5, 1, 1 + 1 / FULL, 2, 8, 16].flatMap(f =>
    [[0, 0, 0], [0.37, -0.2, 0.1], [-0.4, 0.3, -0.2]].map(u => state(f, u, k)));
  for (const l of states) for (const r of states) {
    const f = flux(l, r), dw = subtract(r.entropy, l.entropy), du = subtract(r.conserved, l.conserved);
    const dpsi = r.potential - l.potential, work = dot(dw, f);
    near(work, dpsi, 'coupled semidiscrete entropy identity', Math.max(1, Math.abs(work), Math.abs(dpsi)));
    const convex = dot(dw, du);
    assert(convex >= -2e-11 * Math.max(1, Math.abs(convex)));
    const speed = 1 + Math.max(Math.abs(l.velocity[0]), Math.abs(r.velocity[0]));
    const dissipative = f.map((x, i) => x - speed * du[i] / 2);
    const residual = dot(dw, dissipative) - dpsi;
    near(residual, -speed * convex / 2, 'semidiscrete dissipation budget', Math.max(1, Math.abs(residual)));
    assert(residual <= 2e-11);
    faceCases++;
  }
  for (const s of states) {
    const actual = flux(s, s), expected = [s.f * s.velocity[0],
      ...s.velocity.map((u, i) => s.f * s.velocity[0] * u + (i === 0 ? s.pi : 0))];
    actual.forEach((x, i) => near(x, expected[i], 'direct equal-state flux consistency', Math.max(1, Math.abs(x))));
  }
  const fc = k ? Math.expm1(k) / k : 1;
  for (const [a, b] of [[fc - 1 / FULL, fc + 1 / FULL], [fc - 1e-12, fc + 1e-12], [2, 2 + 1e-12], [0.5, 0.5 + 1e-12]]) {
    const l = state(a, [0, 0, 0], k), r = state(b, [0, 0, 0], k), mean = meanFill(l, r);
    assert(mean >= a - 1e-14 && mean <= b + 1e-14);
    near(mean, meanFill(r, l), 'near-coincident mean symmetry');
    if (r.a !== l.a) {
      const inverse = t => {
        const a = l.a + t * (r.a - l.a);
        return k && a <= k ? Math.expm1(a) / k : fc * Math.exp(a - k);
      };
      const cut = k && l.a < k && r.a > k ? (k - l.a) / (r.a - l.a) : 1;
      const reference = integrate(cut, inverse) + integrate(1 - cut, t => inverse(t + cut));
      near(mean, reference, 'near-coincident mean against independent enthalpy quadrature');
    }
  }
}

// Two explicit counterexamples block a GPU handoff of the semidiscrete formula.
const l = state(2, [0.37, 0, 0]), r = state(0.5, [0.37, 0, 0]), f = flux(l, r);
const tau = Math.sqrt(sound2) / (TICK_HZ * SUB * CELL_M);
const rounded = [...f];
rounded[0] = Math.floor(f[0] * tau * FULL) / (tau * FULL);
const quantizedResidual = dot(subtract(r.entropy, l.entropy), rounded) - (r.potential - l.potential);
assert(quantizedResidual > 1e-10, 'independently flooring accepted mass can inject mechanical energy');

const ring = [state(0.25, [0.4, 0, 0]), state(1.25, [-0.3, 0, 0]), state(3, [0.2, 0, 0])];
const faces = ring.map((s, i) => flux(s, ring[(i + 1) % ring.length]));
const rates = ring.map((s, i) => subtract(faces[(i + 2) % ring.length], faces[i]));
near(ring.reduce((sum, s, i) => sum + dot(s.entropy, rates[i]), 0), 0, 'ring semidiscrete energy derivative', 1);
const step = 1e-3, before = ring.reduce((sum, s) => sum + s.totalEnergy, 0);
const after = ring.reduce((sum, s, i) => {
  const u = s.conserved.map((x, j) => x + step * rates[i][j]);
  return sum + state(u[0], u.slice(1).map(p => p / u[0])).totalEnergy;
}, 0);
assert(after > before + 1e-10, 'forward Euler does not inherit semidiscrete energy conservation');
console.log(`${geometryCases} hydrostatic geometry/integral cases; ${faceCases} coupled horizontal-face algebra cases passed.`);
console.log(`Rejection examples: mass-floor entropy residual=${quantizedResidual}; forward-Euler energy increase=${after - before}.`);
console.log('Face algebra only; finite quantized stepping is checked separately. No 3-D transport, GPU or new velocity capability.');

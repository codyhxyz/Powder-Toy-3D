// CPU-only constitutive/face algebra, not a World variant or time integrator.
// Draft: linear liquid EOS + hydrostatic reconstruction along vertical gravity.
// See docs/v2/evidence/liquid-head-contract.md. No production code uses this.
import assert from 'node:assert/strict';
import { v2FluxWGSL, G_MS2, SUB, TICK_HZ, FULL } from '../../src/shaders/v2.js';
import { MAX_FILL } from '../../src/v2/layout.js';
import { CELL_M } from '../../src/scale.js';
import { gridLayout } from '../../src/sim.js';

const source = v2FluxWGSL(gridLayout(128, 128, 128));
const nominalComp = Math.fround(Number(source.match(/\bconst COMP: f32 = ([\d.e+-]+);/)[1]));
const sound2 = G_MS2 * CELL_M / nominalComp; // Fixed reference stiffness, not retied to solver dt.
assert(nominalComp > 0 && Number.isFinite(sound2));
function near(a, b, label, scale = Math.max(Math.abs(a), Math.abs(b), 1e-30)) {
  assert(Number.isFinite(a) && Number.isFinite(b), label);
  assert(Math.abs(a - b) <= 2e-11 * scale, `${label}: ${a} vs ${b}`);
}
// exp(y)*y-exp(y)+1, evaluated without cancellation near zero.
function elastic(y) {
  return Math.abs(y) < 1e-3
    ? y * y * (0.5 + y * (1 / 3 + y * (1 / 8 + y * (1 / 30 + y / 144))))
    : y + (y - 1) * Math.expm1(y);
}
// x-log(1+x), also cancellation-free near zero.
function pressureRemainder(x) {
  return Math.abs(x) < 1e-3
    ? x * x * (0.5 + x * (-1 / 3 + x * (1 / 4 + x * (-1 / 5 + x * (1 / 6 - x / 7)))))
    : x - Math.log1p(x);
}
function reconstruct(f, k) {
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

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const subtract = (a, b) => a.map((x, i) => x - b[i]);
function state(f, velocity, k = nominalComp) {
  assert(f > 0);
  const r = reconstruct(f, k);
  return { ...r, velocity, conserved: [f, ...velocity.map(u => f * u)],
    entropy: [r.a - dot(velocity, velocity) / 2, ...velocity],
    totalEnergy: r.energy + f * dot(velocity, velocity) / 2, potential: r.pi * velocity[0] };
}
// One HORIZONTAL face, with 3-vector momentum. Not a vertical/free-surface solver.
function flux(l, r) {
  assert.equal(l.k, r.k);
  const da = r.a - l.a;
  const meanDensity = da ? (r.pi - l.pi) / da : (l.f + r.f) / 2;
  const u = l.velocity.map((x, i) => (x + r.velocity[i]) / 2);
  const mass = meanDensity * u[0], pressure = (l.pi + r.pi) / 2;
  return [mass, ...u.map((v, i) => mass * v + (i === 0 ? pressure : 0))];
}
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
console.log('No accepted quantized time update, 3-D geometry, GPU implementation, hole/SPLASH result or new velocity capability.');

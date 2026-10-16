// ONE finite CPU reference step on a wet, one-material horizontal periodic ring.
// No World, native ABI, time loop, thermal/payload admission or GPU implementation.
import assert from 'node:assert/strict';
import { FULL, SUB, TICK_HZ } from '../../src/shaders/v2.js';
import { MAX_FILL } from '../../src/v2/layout.js';
import { CELL_M } from '../../src/scale.js';
import { nominalComp, sound2, state, flux, dot, subtract } from './hydrostatic-reference.mjs';

// Candidate reference representation only: signed i32 Q24 momentum in units of
// fullCellMass*c. It is NOT an approved cross-material/native persistence format.
const PQ = 2 ** 24, IMIN = -(2 ** 31), IMAX = 2 ** 31 - 1;
const nominalTau = Math.sqrt(sound2) / (TICK_HZ * SUB * CELL_M);
function nearest(x) {
  const lo = Math.floor(x), fraction = x - lo;
  return fraction < 0.5 ? lo : fraction > 0.5 ? lo + 1 : lo % 2 === 0 ? lo : lo + 1;
}
const input = (fill, u, known = true) => ({
  fill, momentum: u.map(v => nearest(fill / FULL * v * PQ)), momentumKnown: known,
});
const decode = (c, k) => state(c.fill / FULL, c.momentum.map(p => p / PQ / (c.fill / FULL)), k);
const energy = cells => cells.reduce((sum, s) => sum + s.totalEnergy, 0);
const totals = cells => [cells.reduce((sum, c) => sum + c.fill, 0),
  ...[0, 1, 2].map(a => cells.reduce((sum, c) => sum + c.momentum[a], 0))];
function step(cells, k = nominalComp) {
  const refuse = reason => ({ accepted: false, reason, cells });
  if (cells.some(c => c.momentumKnown !== true)) return refuse('unknown momentum');
  if (cells.some(c => !Number.isSafeInteger(c.fill) || c.fill <= 0 || c.fill > MAX_FILL ||
    !Array.isArray(c.momentum) || c.momentum.length !== 3 ||
    c.momentum.some(p => !Number.isInteger(p) || p < IMIN || p > IMAX))) return refuse('unsupported representation');
  const old = cells.map(c => decode(c, k)), n = cells.length;
  assert.equal(n, 3, 'this gate covers exactly one three-cell ring');
  const faces = old.map((l, i) => {
    const r = old[(i + 1) % n], speed = 1 + Math.max(Math.abs(l.velocity[0]), Math.abs(r.velocity[0]));
    return { speed, mean: l.velocity.map((u, a) => (u + r.velocity[a]) / 2),
      flux: flux(l, r).map((x, a) => x - speed * (r.conserved[a] - l.conserved[a]) / 2) };
  });
  // Explicit reference CFL ceiling, not a fitted physical parameter.
  // Report all required refinements; do NOT call this one native substep.
  const refinements = Math.max(1, Math.ceil(nominalTau * Math.max(...faces.map(f => f.speed)) / 0.25));
  const tau = nominalTau / refinements;
  const raw = old.map((s, i) => s.conserved.map((x, a) =>
    x + tau * (faces[(i + n - 1) % n].flux[a] - faces[i].flux[a])));
  if (raw.some(u => u.some(x => !Number.isFinite(x)) || u[0] <= 0 || u[0] > MAX_FILL / FULL)) return refuse('reference capacity');
  const reference = raw.map(u => state(u[0], u.slice(1).map(p => p / u[0]), k));

  // Calculate a Taylor bound BEFORE rounding or examining the proposed result.
  // Each mass error <= two faces * half a fill quantum. Each momentum error
  // includes the coupled mass correction plus two half-Q24 roundoff errors.
  let budget = 0;
  const bounds = [];
  for (let i = 0; i < n; i++) {
    const s = reference[i], left = faces[(i + n - 1) % n], right = faces[i];
    const ef = 1 / FULL;
    const ep = left.mean.map((u, a) => (Math.abs(u) + Math.abs(right.mean[a])) / (2 * FULL) + 1 / PQ);
    const fmin = s.f - ef;
    if (fmin <= 0) return refuse('rounding bound reaches dry state');
    const epNorm = Math.hypot(...ep), pMax = Math.hypot(...s.conserved.slice(1)) + epNorm;
    const umax = pMax / fmin, aPrime = Math.max(k, 1 / fmin);
    const limit = Math.abs(s.entropy[0]) * ef + dot(s.velocity.map(Math.abs), ep) +
      0.5 * (aPrime * ef * ef + (epNorm + umax * ef) ** 2 / fmin);
    budget += limit;
    bounds.push({ reference: s, ef, ep, limit });
  }
  const before = energy(old), referenceEnergy = energy(reference);
  const arithmeticSlack = 1024 * Number.EPSILON * Math.max(1, before, referenceEnergy, budget);
  if (referenceEnergy > before + arithmeticSlack) return refuse('unrounded energy gain');

  const transfers = faces.map(f => {
    const dm = nearest(tau * f.flux[0] * FULL);
    const error = dm / FULL - tau * f.flux[0];
    return [dm, ...f.mean.map((u, a) => nearest((tau * f.flux[a + 1] + error * u) * PQ))];
  });
  if (transfers.some(t => t.some(x => !Number.isSafeInteger(x)))) return refuse('transfer representation');
  const proposed = cells.map((c, i) => {
    const l = transfers[(i + n - 1) % n], r = transfers[i];
    return { ...c, fill: c.fill + l[0] - r[0],
      momentum: c.momentum.map((p, a) => p + l[a + 1] - r[a + 1]) };
  });
  if (proposed.some(c => c.fill <= 0 || c.fill > MAX_FILL ||
    c.momentum.some(p => p < IMIN || p > IMAX))) return refuse('quantized capacity');
  const after = energy(proposed.map(c => decode(c, k)));
  if (Math.abs(after - referenceEnergy) > budget + arithmeticSlack ||
    after > before + budget + arithmeticSlack) return refuse('mechanical rounding budget');
  // Only this commit point publishes the complete proposal; no partial stores.
  return { accepted: true, cells: proposed, before, after, referenceEnergy, budget,
    arithmeticSlack, tau, refinements, transfers, bounds };
}

let accepted = 0, worstBudget = 0, maxRefinements = 0;
for (const k of [0, nominalComp]) {
  const transitionFill = Math.floor((k ? Math.expm1(k) / k : 1) * FULL);
  for (const cells of [
    [input(FULL, [0, 0, 0]), input(FULL, [0, 0, 0]), input(FULL, [0, 0, 0])],
    ...(k ? [[input(transitionFill, [0, 0, 0]), input(transitionFill, [0, 0, 0]), input(transitionFill, [0, 0, 0])]] : []),
    [input(FULL / 4, [0.4, 0.12, -0.08]), input(5 * FULL / 4, [-0.3, 0.2, 0.07]), input(3 * FULL, [0.2, -0.1, 0.03])],
    [input(FULL / 2, [0.2, 0.7, -0.4]), input(FULL, [-0.2, -0.3, 0.1]), input(2 * FULL, [0.4, 0.2, -0.2])],
  ]) {
    const saved = structuredClone(cells), result = step(cells, k);
    assert(result.accepted, result.reason);
    assert.deepEqual(cells, saved, 'reference input never mutated');
    assert.deepEqual(totals(result.cells), totals(cells), 'integer mass and all momentum components conserve exactly');
    assert(result.cells.every(c => c.fill > 0 && c.fill <= MAX_FILL &&
      c.momentum.every(p => Number.isInteger(p) && p >= IMIN && p <= IMAX)));
    assert(Math.abs(result.after - result.referenceEnergy) <= result.budget + result.arithmeticSlack);
    assert(result.after <= result.before + result.budget + result.arithmeticSlack);
    for (const b of result.bounds) for (let bits = 0; bits < 16; bits++) {
      const f = b.reference.f + (bits & 1 ? b.ef : -b.ef);
      const p = b.reference.conserved.slice(1).map((x, a) => x + (bits & (2 << a) ? b.ep[a] : -b.ep[a]));
      const corner = state(f, p.map(x => x / f), k).totalEnergy;
      assert(Math.abs(corner - b.reference.totalEnergy) <= b.limit + result.arithmeticSlack,
        'independent full-quantum error-box corner respects precomputed Taylor bound');
    }
    if (cells.every(c => c.momentum.every(p => p === 0))) {
      assert.deepEqual(result.cells, cells, 'declared uniform rest is exactly unchanged');
    } else {
      assert(result.transfers.some(t => t[0] !== 0), 'accepted step moves nonzero quantized mass');
      for (const a of [1, 2]) assert(result.cells.some((c, i) => c.momentum[a] !== cells[i].momentum[a]),
        'tangential momentum actually transfers');
      assert(result.before - result.after > result.budget, 'moving samples have nonvacuous dissipative margin');
    }
    accepted++;
    worstBudget = Math.max(worstBudget, result.budget);
    maxRefinements = Math.max(maxRefinements, result.refinements);
  }
}
for (const [reason, cells] of [
  ['reference capacity', [input(MAX_FILL, [0.4, 0.1, 0]), input(MAX_FILL - 1, [0, 0, 0]), input(MAX_FILL, [-0.4, 0, 0.1])]],
  ['unknown momentum', [input(FULL, [0, 0, 0], false), input(FULL, [0, 0, 0]), input(FULL, [0, 0, 0])]],
  ['unsupported representation', [input(0, [0, 0, 0]), input(FULL, [0, 0, 0]), input(FULL, [0, 0, 0])]],
  ['unsupported representation', [{ ...input(FULL, [0, 0, 0]), momentum: [IMAX + 1, 0, 0] }, input(FULL, [0, 0, 0]), input(FULL, [0, 0, 0])]],
  ['rounding bound reaches dry state', [input(1, [0, 0, 0]), input(1, [0, 0, 0]), input(1, [0, 0, 0])]],
]) {
  const saved = structuredClone(cells), result = step(cells);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, reason, 'refuse for the intended condition, not an unrelated failure');
  assert.equal(result.cells, cells, 'refusal keeps the original authority');
  assert.deepEqual(cells, saved, 'no material or momentum stores before admission');
}
console.log(`${accepted} independent one-step cases accepted; exact integer mass/3-D momentum conservation; 5 atomic refusals.`);
console.log(`Worst calculated energy-rounding budget=${worstBudget}; maximum one-axis refinement=${maxRefinements} per native substep.`);
console.log('CPU Q24 reference only: not a native ABI, 3-D solver, thermal/payload admission, long-run energy bound or GPU result.');

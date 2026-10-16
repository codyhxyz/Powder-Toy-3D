// CPU algebraic gates, not a fluid solver, World variant or GPU acceptance.
// Pressure potential below treats the EXISTING head difference as a force
// potential. A new model must justify that interpretation and its time update.
// No damping, limiter, film rule, pressure impulse or f16 flux update is modeled.
import assert from 'node:assert/strict';
import { v2FluxWGSL, FULL, SUB, TICK_HZ, G_MS2 } from '../../src/shaders/v2.js';
import { MAX_FILL } from '../../src/v2/layout.js';
import { CELL_M, dynamicsRows } from '../../src/v2/dynamics-reference.js';
import { E } from '../../src/elements.js';
import { gridLayout } from '../../src/sim.js';

const code = v2FluxWGSL(gridLayout(128, 128, 128));
const compLiteral = code.match(/\bconst COMP: f32 = ([\d.e+-]+);/);
assert(compLiteral, 'compression coefficient must come from the emitted shader');
const comp = Math.fround(Number(compLiteral[1]));
assert(comp > 0 && Number.isFinite(comp));
assert.equal(Number(code.match(/\bconst FULLF: f32 = ([\d.e+-]+);/)[1]), FULL);
const signature = 'fn headOf(c: vec4u) -> f32 {', start = code.indexOf(signature);
assert(start >= 0);
let end = start + signature.length, depth = 1;
for (; depth; end++) {
  assert(end < code.length);
  if (code[end] === '{') depth++;
  if (code[end] === '}') depth--;
}
// Execute the actual scalar body with f32 inputs/constants, but JS arithmetic.
// This checks mathematical coupling, NOT Metal's intermediate rounding.
const emittedHead = new Function('c', 'FULLF', 'COMP', 'isLiq', 'cFill', 'f32',
  code.slice(start + signature.length, end - 1));
const head = q => emittedHead({ fill: q, liquid: true }, FULL, comp, c => c.liquid, c => c.fill, Math.fround);
assert.equal(emittedHead({ fill: FULL, liquid: false }, FULL, comp, c => c.liquid, c => c.fill, Math.fround), 0);

// Exact rational primitive A(f)=integral_0^f head(s) ds, for integer fill.
// Decode the emitted f32 COMP into its exact dyadic fraction.
const bits = new Uint32Array(new Float32Array([comp]).buffer)[0];
const exponent = ((bits >>> 23) & 255) - 127 - 23;
assert(((bits >>> 23) & 255) > 0 && ((bits >>> 23) & 255) < 255);
const mantissa = BigInt((bits & 0x7fffff) | 0x800000);
const cn = exponent >= 0 ? mantissa << BigInt(exponent) : mantissa;
const cd = exponent >= 0 ? 1n : 1n << BigInt(-exponent);
const full = BigInt(FULL), denominator = 2n * full * full * cn;
function potential(q) {
  assert(Number.isSafeInteger(q) && q >= 0 && q <= MAX_FILL);
  const n = BigInt(q);
  if (n <= full) return cn * n * n;
  const d = n - full;
  return cn * full * full + 2n * cn * full * d + cd * d * d;
}
function headIntegral(a, b) {
  if (b < a) return -headIntegral(b, a);
  const cuts = a < FULL && b > FULL ? [a, FULL, b] : [a, b];
  let sum = 0;
  for (let i = 1; i < cuts.length; i++) {
    sum += (cuts[i] - cuts[i - 1]) / FULL * (head(cuts[i]) + head(cuts[i - 1])) / 2;
  }
  return sum;
}
function near(a, b, label, scale = Math.max(1, Math.abs(a), Math.abs(b))) {
  assert(Number.isFinite(a) && Number.isFinite(b), label);
  assert(Math.abs(a - b) <= 128 * Number.EPSILON * scale, `${label}: ${a} vs ${b}`);
}
const fills = [0, 1, FULL / 8, FULL / 2, FULL - 1, FULL, FULL + 1, 2 * FULL, 8 * FULL, MAX_FILL];
let workCases = 0;
for (const a of fills) for (const b of fills) {
  const exact = Number(potential(b) - potential(a)) / Number(denominator);
  near(exact, headIntegral(a, b), 'primitive versus actual emitted head');
  if (a === 0 || b === MAX_FILL) continue;
  for (const amount of new Set([1, Math.min(a, MAX_FILL - b), Math.min(a, MAX_FILL - b, FULL / 8)])) {
    const delta = potential(a - amount) + potential(b + amount) - potential(a) - potential(b);
    const available = (potential(a) - potential(a - amount)) - (potential(b + amount) - potential(b));
    assert.equal(delta + available, 0n, 'two-cell pressure work in exact integer-fill arithmetic');
    workCases++;
  }
}
// Under this head-drive interpretation, the proposal e'(f)=head(f)/f gives
// e=f below full fill, hence U=f²: twice the required mass-conserving work.
const a = 3 * FULL / 4, b = FULL / 4, amount = FULL / 8;
const headWork = headIntegral(a - amount, a) - headIntegral(b, b + amount);
const proposedWork = (a * a + b * b - (a - amount) ** 2 - (b + amount) ** 2) / FULL ** 2;
assert.equal(proposedWork, 2 * headWork);
assert.notEqual(proposedWork, headWork, 'do not approve the proposed potential without reconciling head semantics');

const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const kinetic = (m, p) => m ? dot(p, p) / (2 * m) : 0;
let mixingCases = 0;
const mass = dynamicsRows[E.WATER].mass;
for (const resident of [0, mass / FULL, mass / 8, mass, 16 * mass]) {
  for (const packet of [mass / FULL, mass / 8, mass]) {
    for (const u of [[0, 0, 0], [3, -2, 7]]) for (const v of [[0, -19.6, 0], [-4, 5, -6], u]) {
      const pr = u.map(x => x * resident), pp = v.map(x => x * packet);
      const total = pr.map((x, i) => x + pp[i]), combined = resident + packet;
      const before = kinetic(resident, pr) + kinetic(packet, pp), after = kinetic(combined, total);
      const relative = u.map((x, i) => x - v[i]);
      const loss = resident * packet / (2 * combined) * dot(relative, relative);
      near(before - after, loss, 'inelastic mixing loss', Math.max(before, after, 1));
      for (let axis = 0; axis < 3; axis++) near(combined * (total[axis] / combined), pr[axis] + pp[axis], 'all momentum components');
      // No thermal-bank credit is introduced by this mechanical identity.
      mixingCases++;
    }
  }
}

// If A is used as the barotropic energy, p=f*head-A and c²=g*ell*f*head'.
// The current COMP stability argument cannot simply be reused for that model.
const dt = 1 / (TICK_HZ * SUB), fmax = MAX_FILL / FULL;
const courant = Math.sqrt(G_MS2 * CELL_M * fmax / comp) * dt / CELL_M;
assert(courant > 1, 'the proposed explicit nearest-neighbor update needs a new stability argument');
for (const substeps of [SUB, 2 * SUB, 4 * SUB]) {
  const step = 1 / (TICK_HZ * substeps), tiedComp = 4 * G_MS2 / CELL_M * step * step;
  near(Math.sqrt(G_MS2 * CELL_M * fmax / tiedComp) * step / CELL_M, Math.sqrt(fmax) / 2,
    'more substeps do not help if COMP is retied to dt²');
}
console.log(`${workCases} exact head-potential bookkeeping cases; ${mixingCases} 3-D mixing identities passed.`);
console.log(`Conditional head-as-enthalpy gates: proposed energy differs by 2x; maximum-fill acoustic Courant=${courant.toFixed(6)}.`);
console.log('CPU algebra only. Coupled pressure/advection, quantized momentum, hole/SPLASH and GPU acceptance remain unproved.');

// CPU-only: the particle pool's live bits are exact for every sweep. A sweep
// reads a slot's record only where its bit is set, so it must be set wherever
// the record's ID is nonzero. 1. Audit of every generated dynamics module: a
// record store at a spawn index (a free-list slot, a ray's slot) is followed
// by noteLive on that index; a store at a sweep's own slot happens only after
// that record was seen live. Restores set every bit. 2. A model of spawns,
// retirements and the preparation's clearing of stale bits, in any order a
// tick allows: the free list read through the bits equals the serial oracle's
// over the records. A spawn without noteLive, or a preparation that clears a
// live slot's bit, must break it.
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { nativeDynamicsHead, v2ActLayout } from '../../src/shaders/v2.js';
import { particlesWGSL, PARTICLE_STAGES } from '../../src/shaders/v2/particles.js';
import { blastsWGSL, BLAST_STAGES } from '../../src/shaders/v2/blasts.js';
import { airWGSL, AIR_STAGES } from '../../src/shaders/v2/air.js';
import { jetsWGSL, JET_STAGES } from '../../src/shaders/v2/jets.js';
import { nativeForceCommitWGSL } from '../../src/v2/nativeForcing.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { PARTICLE_CAP as CAP } from '../../src/v2/dynamics-reference.js';

const g = gridLayout(16, 8, 8), params = { wgsl: 'struct AuditParams { tick: u32 }', name: 'AuditParams' };
const modules = [
  ...PARTICLE_STAGES.map(s => [`particles ${s}`, particlesWGSL(g, nativeDynamicsHead, s)]),
  ...BLAST_STAGES.map(s => [`blasts ${s}`, blastsWGSL(g, nativeDynamicsHead, s)]),
  ...AIR_STAGES.map(s => [`air ${s}`, airWGSL(g, nativeDynamicsHead, s)]),
  ...JET_STAGES.map(s => [`jets ${s}`, jetsWGSL(g, s)]),
  ...['plan', 'particles'].map(s => [`forcing ${s}`, nativeForceCommitWGSL(g, params, s)]),
];
const functions = code => code.replace(/\/\/[^\n]*/g, '').split(/\n(?=fn |@compute)/);
let spawns = 0, updates = 0;
function audit(name, code) { for (const fn of functions(code)) {
  for (const m of fn.matchAll(/\bparticles\[([a-z]+)\]\s*=(?!=)/g)) {
    const index = m[1], after = fn.slice(m.index, m.index + 200);
    if (index === 't' || index === 'i') {
      // a sweep's own slot: the record was read live (ID nonzero) before any store
      const before = fn.slice(0, m.index);
      assert.ok(/(\.id ?== ?0u|slotLive\()/.test(before), `${name}: a store at ${index} not behind a live read`); updates++;
    } else { assert.ok(after.includes(`noteLive(${index})`), `${name}: a spawn at ${index} without noteLive`); spawns++; }
  }
} }
for (const [name, code] of modules) audit(name, code);
assert.ok(spawns >= 4, `the audit sees dSpawn, children, rayEmit and the jets' spawn (${spawns})`);
assert.throws(() => audit('red', 'fn red() {\n  particles[dest]=born;\n}'), /without noteLive/);
assert.match(PhysicsV2.prototype.noteAllCells.toString(), /layout\.plive/);
assert.match(NativeDynamics.prototype.restoreDynamicState.toString(), /noteAllCells/);
const L = v2ActLayout(g);
assert.ok(L.plive >= L.words && L.allocated - L.plive === CAP / 32, 'a live bit a pool slot, after the saved words');

// 2. the model: records (ID or 0) and bits; the operations a tick and a restore can do.
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const N = 512; // slots modelled; the bit rules are per slot
function run(seed, variant = {}) {
  const random = rng(seed), id = new Uint32Array(N), bits = new Uint8Array(N);
  const freeList = viaBits => { const out = []; for (let s = 0; s < N; s++) if ((viaBits && !bits[s]) || id[s] === 0) out.push(s); return out.join(); };
  for (let step = 0; step < 400; step++) {
    const r = random();
    if (r < 0.3) { // a spawn into the lowest free slot (dSpawn, children, rayEmit, the jets)
      const s = id.findIndex(x => x === 0); if (s >= 0) { id[s] = 1 + Math.floor(random() * 1e6); if (!variant.silentSpawn) bits[s] = 1; }
    } else if (r < 0.55) { // a retirement (integrate, impact, deposit), noted or not
      const live = [...id.keys()].filter(s => id[s]); if (live.length) { const s = live[Math.floor(random() * live.length)]; id[s] = 0; if (random() < 0.7) bits[s] = 0; }
    } else if (r < 0.75) { // freeCount: reads bit-set slots, clears the dead ones
      for (let s = 0; s < N; s++) if (bits[s] && (id[s] === 0 || variant.clearLive)) bits[s] = 0;
    } else if (r < 0.77) bits.fill(1); // a restore
    if (freeList(true) !== freeList(false)) return false;
    for (let s = 0; s < N; s++) if (id[s] && !bits[s]) return false;
  }
  return true;
}
for (let seed = 1; seed <= 50; seed++) assert.ok(run(seed), `live bits lost a live slot: seed ${seed}`);
for (const [what, variant] of [['a spawn without noteLive', { silentSpawn: true }], ['a preparation that clears a live bit', { clearLive: true }]]) {
  let broke = false; for (let seed = 1; seed <= 50 && !broke; seed++) broke = !run(seed, variant);
  assert.ok(broke, `${what} must break the live bits`);
}
// holdCOM: the held set's mass-weighted sums in ascending slot order, now visiting only set bits
// (lowest first) instead of every slot: the same f32 additions in the same order.
const fr = Math.fround;
function com(slots, bits, viaBits) {
  let mass = 0, x = 0, count = 0;
  const visit = i => { const p = slots[i]; if (!p) return; mass = fr(mass + p.m); x = fr(x + fr(p.x * p.m)); count++; };
  if (!viaBits) { for (let i = 0; i < slots.length; i++) if (bits[i >> 5] >>> (i & 31) & 1) visit(i); }
  else for (let w = 0; w < bits.length; w++) { let live = bits[w]; while (live) { const i = w * 32 + (31 - Math.clz32(live & -live)); live = (live & (live - 1)) >>> 0; visit(i); } }
  return [mass, x, count].join();
}
for (let seed = 1; seed <= 20; seed++) {
  const random = rng(seed), slots = Array.from({ length: 1024 }, () => random() < 0.1 ? { m: fr(random() * 3), x: fr(random() * 100 - 50) } : null);
  const bits = new Uint32Array(32); slots.forEach((p, i) => { if (p || random() < 0.05) bits[i >> 5] |= 1 << (i & 31); });
  assert.equal(com(slots, bits, true), com(slots, bits, false), `holdCOM order changed: seed ${seed}`);
}
const holdCOM = particlesWGSL(g, nativeDynamicsHead, 'holdCOM');
assert.match(holdCOM, /let i=w\*32u\+firstTrailingBit\(live\); live&=live-1u;/);
console.log(`particle live bits: ${spawns} spawns noted and ${updates} live-slot stores audited across ${modules.length} modules; 50 models exact; 3 red variants caught`);

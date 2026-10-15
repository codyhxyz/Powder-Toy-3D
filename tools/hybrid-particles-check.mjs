// CPU-only ownership and renderer contract checks (also runs shared smooth checks).
import assert from 'node:assert/strict';
import { fixture, reflect, g } from './hybrid-smooth-check.mjs';
import { createHybridParticles } from '../src/gfx/hybrid/particles.js';
import { particleOwns, particleCompaction, particleCapacity, PARTICLE_OWNERSHIP, particleMeshWGSL, particleDrawWGSL, particleShadowWGSL } from '../src/shaders/hybrid/particles.js';
assert.deepEqual(PARTICLE_OWNERSHIP.channels, [2, 3]);
assert.equal(PARTICLE_OWNERSHIP.liquids, false);
for (const ch of [-1, 0, 1, 2, 3]) {
  const center = [3, 3, 3], key = p => p.join(','), cells = new Map([[key(center), ch]]);
  const at = p => cells.get(key(p)) ?? -1;
  assert.equal(particleOwns(center, [32, 32, 32], at), ch === 2 || ch === 3);
  if (ch < 2) continue;
  // Each direction includes face, edge and diagonal brick boundaries.
  for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    if (!(x || y || z)) continue;
    const q = center.map((v, i) => v + [x, y, z][i]);
    cells.set(key(q), ch); assert(!particleOwns(center, [32, 32, 32], at));
    cells.set(key(q), ch === 2 ? 3 : 2); assert(particleOwns(center, [32, 32, 32], at));
    cells.delete(key(q));
  }
}
for (const p of [[0, 5, 5], [31, 5, 5], [5, 5, 0], [5, 5, 31]]) {
  const at = q => q.join() === p.join() ? 2 : -1;
  assert(particleOwns(p, [32, 32, 32], at));
  assert(!particleOwns(p, [32, 32, 32], at, true));
}
assert.equal(particleCapacity(100, 32 * 10), 10);
assert.deepEqual(particleCompaction(11, 10).args, [96, 0, 0, 0]);
assert.equal(particleCompaction(10, 10).args[1], 10);
for (const code of [particleMeshWGSL(g), particleDrawWGSL(g), particleShadowWGSL()]) reflect(code);
const f = fixture(false), p = createHybridParticles(f.gpu, f.sim, { capacity: 2, ownershipReady: true });
assert(!p.update({ revision: 1, ownershipReady: true }));
f.sim.derived.particleSplit = true;
assert(p.update({ revision: 1 })); assert(p.stats.pending); assert(!p.stats.fallbackRequired);
assert(p.draw({})); assert(p.drawShadow({}, { matrix: Array(16).fill(0) }));
assert.deepEqual(f.log.slice(0, 3).map(x => x.name), ['hybrid.particles.compact', 'hybrid.particles.finish', 'hybrid.particles.draw']);
f.reads.at(-1).resolve(new Uint32Array([3, 1, 2, 0]).buffer);
await Promise.resolve();
assert.equal(p.stats.count, 3); assert(p.stats.overflow); assert(!p.draw({}));
assert(p.update({ revision: 2 })); assert(p.draw({}));
f.sim.derived.world = [32, 32, 32]; assert(!p.draw({}));
p.dispose(); p.dispose();
assert(f.buffers.every(b => b.destroyed)); assert(f.rings.every(r => r.closed));
console.log('PASS particles CPU: exact 26-neighbour/cross-brick/diagonal and halo ownership, liquids excluded, actual Derived mode required, bounded same-frame draw/shadow, overflow suppression, static reflection <=8 storage, disposal');

// CPU-only ownership and renderer contract checks (also runs shared smooth checks).
import assert from 'node:assert/strict';
import { fixture, reflect, g } from './hybrid-smooth-check.mjs';
import { createHybridParticles } from '../src/gfx/hybrid/particles.js';
import { particleOwns, particleCompaction, particleCapacity, PARTICLE_MESH_LAYOUT, PARTICLE_OWNERSHIP, particleMeshWGSL, particleDrawWGSL, particleShadowWGSL } from '../src/shaders/hybrid/particles.js';
assert.deepEqual(PARTICLE_OWNERSHIP.channels, [0, 1, 2, 3]);
assert.equal(PARTICLE_OWNERSHIP.liquids, true);
for (const ch of [-1, 0, 1, 2, 3]) {
  const center = [3, 3, 3], key = p => p.join(','), cells = new Map([[key(center), ch]]);
  const at = p => cells.get(key(p)) ?? -1;
  assert.equal(particleOwns(center, [32, 32, 32], at), ch >= 0);
  if (ch < 0) continue;
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
assert.equal(PARTICLE_MESH_LAYOUT.length + 3, 8); // explicit TABLES + STATE_RO + mesh
for (const code of [particleMeshWGSL(g), particleDrawWGSL(g), particleShadowWGSL()]) {
  const r = reflect(code);
  for (const vs of r.entry.vertex) assert(!vs.resources.some(resource => resource.name === 'TB'), 'vertex must not access fragment-only element tables');
}
assert.match(particleDrawWGSL(g), /hpChannel\(instance.id\) < 2/);
assert.match(particleShadowWGSL(), /hpChannel\(particles\[ii\].id\) == 0/);
assert.match(particleMeshWGSL(g), /opticalArgs\[0\] = vec4u\(3u/);
assert.match(particleMeshWGSL(g), /opticalArgs\[1\] = vec4u\(6u, select\(n, 0u, overflow\)/);
// In a 2³ tile every pair are 26-neighbours, hence at most one per
// channel. This periodic construction attains the four/eight bound.
const channelAt = ([x,y,z]) => z % 2 ? -1 : (x % 2) + 2 * (y % 2);
let owned = 0;
for (let z=0;z<4;z++) for (let y=0;y<4;y++) for (let x=0;x<4;x++) {
  owned += Number(particleOwns([x,y,z],[4,4,4],channelAt));
}
assert.equal(owned,64/2);
const defaultFixture=fixture(true), defaultParticles=createHybridParticles(defaultFixture.gpu,defaultFixture.sim);
assert(defaultParticles.guaranteedCapacity);
assert.equal(defaultParticles.resources.capacity,g.slots/2);
assert.equal(defaultParticles.resources.opticalArgs.size,32);
defaultParticles.dispose();
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
console.log('PASS particles CPU: all-four 26-neighbour ownership, tight half-slot capacity, liquid opaque/shadow exclusion, indirect optical offsets/counts, actual split required, overflow suppression, Naga/render reflection and <=8 explicit compute storage, disposal');

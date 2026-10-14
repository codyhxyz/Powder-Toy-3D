// Canonical native readback shared by harness and app adapters. No legacy A/B.
import { cellSlot } from '../../src/shaders/common.js';
import { E, ELEMENTS, K } from '../../src/elements.js';
import { FULL, lifeScale } from '../../src/v2/layout.js';
import { unpackContact } from '../../src/v2/contact.js';
import { unpackParticle, PARTICLE_BYTES, PHOTON_TAG, ballistic, dynamicsRows, DT, GRAVITY, CELL_M } from '../../src/v2/dynamics-reference.js';
import { fallCells, G_TICK, TICK_HZ, v2Rows } from '../../src/shaders/v2.js';
import { tally } from './lib.js';

// Isolated pending the production persistent-inertia helper (src/v2/fall.js).
export const gridFallVelocity = core => ELEMENTS[core[0] & 255]?.kind === K.POWDER
  ? Math.min((core[0] >>> 24) * G_TICK, v2Rows()[core[0] & 255].vt) * CELL_M * TICK_HZ : 0;
export const nativeFall = (id, seconds) => ELEMENTS[id]?.kind === K.POWDER ? fallCells(id, Math.round(seconds * TICK_HZ)) : null;
export function nativeFlight(id, [vx, vy], seconds) {
  const row = dynamicsRows[id];
  if (!row || ![K.POWDER, K.LIQUID, K.GAS].includes(row.kind)) return null;
  let position = [0, 0, 0], velocity = [vx * CELL_M, vy * CELL_M, 0];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    // particles.js integrate: implicit quadratic drag in still air, then ballistic motion.
    const divisor = 1 + GRAVITY / row.terminal ** 2 * Math.hypot(...velocity) * DT;
    ({ position, velocity } = ballistic(position, velocity.map(v => v / divisor), DT, row.kind === K.GAS ? 0 : GRAVITY));
  }
  return position.slice(0, 2);
}

// All copies are recorded before awaiting, so core, signed bank, particles and
// the CURRENT air ping-pong index describe one recording boundary.
export async function readNativeState(v2) {
  v2.sync();
  const d = v2.dynamics;
  if (!v2.isReady || !v2.contactReady || !d?.isReady) throw new Error('outcomes: integrated native physics is not ready');
  const origin = [v2.sim.origin.x, v2.sim.origin.y, v2.sim.origin.z];
  const buffers = [v2.cells, v2.aux, d.particles, d.air[d.airIndex]];
  const [cells, banks, particles, air] = await Promise.all(buffers.map(b => v2.gpu.readback.buffer(b, 0, b.size)));
  return { layout: v2.g, origin, cells, banks, particles, air };
}

export function toGrid({ layout: l, origin = [0, 0, 0], cells, banks, particles, air }) {
  const { nx, ny, nz } = l, n = nx * ny * nz;
  const words = new Uint32Array(cells), bank = new Int32Array(banks), a = new Float32Array(air);
  const g = { nx, ny, nz, id: new Int32Array(n), amount: new Float32Array(n), gridAmount: new Float32Array(n),
    T: new Float32Array(n), burning: new Uint8Array(n), pressure: new Float32Array(n),
    moving: new Uint8Array(n), velocityKnown: new Uint8Array(n).fill(1), vel: new Float32Array(n * 3), airVel: new Float32Array(n * 3),
    bank: new Int32Array(n), ctype: new Uint8Array(n), life: new Float32Array(n), particles: [] };
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const i = x + nx * (z + nz * y), s = cellSlot(l, x, y, z), core = words.subarray(s * 4, s * 4 + 4);
    const c = unpackContact(core, bank[s]), b = (s >> 6) * 8;
    g.id[i] = c.id; g.T[i] = c.tq * 0.25 - 273.25; g.bank[i] = c.bank;
    g.ctype[i] = c.ctype; g.life[i] = c.life / lifeScale(c.id); g.burning[i] = c.burning;
    if (ELEMENTS[c.id]?.kind === K.LIQUID) g.amount[i] = g.gridAmount[i] = c.fill / FULL;
    g.pressure[i] = a[b + 3]; g.airVel.set(a.subarray(b, b + 3), i * 3);
    // Grid liquids encode face impulses, not a cell-vector velocity. Never reinterpret
    // these as SI velocity; air velocity belongs only to air/gas, not stationary solids.
    if ([K.EMPTY, K.GAS].includes(ELEMENTS[c.id]?.kind)) g.vel.set(a.subarray(b, b + 3), i * 3);
    else if (ELEMENTS[c.id]?.kind === K.POWDER) g.vel[i * 3 + 1] = -gridFallVelocity(core);
    else if (ELEMENTS[c.id]?.kind === K.LIQUID && (core[2] !== 0 || (core[3] & 65535) !== 0)) {
      // Three packed face fluxes are NOT a unique cell velocity. Fail numerical
      // velocity assertions honestly rather than report flowing liquid as still.
      g.vel.fill(NaN, i * 3, i * 3 + 3); g.velocityKnown[i] = 0;
    }
    g.moving[i] = g.vel.subarray(i * 3, i * 3 + 3).some(v => v !== 0) ? 1 : 0;
  }
  const bytes = new Uint8Array(particles);
  for (let offset = 0; offset + PARTICLE_BYTES <= bytes.byteLength; offset += PARTICLE_BYTES) {
    const p = unpackParticle(bytes.subarray(offset, offset + PARTICLE_BYTES)), id = p.core[0] & 255;
    if (!p.id || id === E.EMPTY || id >= PHOTON_TAG) continue; // rays and heat carriers are not matter
    const c = unpackContact(p.core, p.bank), liquid = ELEMENTS[id]?.kind === K.LIQUID;
    const [x, y, z] = p.position.map((v, axis) => v - origin[axis]), [vx, vy, vz] = p.velocity;
    const mass = liquid ? c.fill / FULL : 1;
    g.particles.push({ x, y, z, vx, vy, vz, mass, id, particleId: p.id, T: c.tq * 0.25 - 273.25,
      bank: p.bank, life: c.life / lifeScale(id), ctype: c.ctype, burning: c.burning });
    // Keep the resident id/temperature/velocity intact in mixed cells. Particle
    // metadata is losslessly available above, including particles outside the window.
    if (liquid && x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz)
      g.amount[Math.floor(x) + nx * (Math.floor(z) + nz * Math.floor(y))] += mass;
  }
  return g;
}

export function nativeTally(g, engine) {
  // Ordinary tally cannot attribute overlapping unlike liquids or out-of-window
  // particles. Count resident fills first and each material packet exactly once.
  const c = tally({ ...g, amount: g.gridAmount }, engine);
  for (const p of g.particles) if (engine.kindOf(p.id) === 'liquid') {
    const name = engine.nameOf(p.id); c.liquid[name] = (c.liquid[name] ?? 0) + p.mass;
  }
  return c;
}

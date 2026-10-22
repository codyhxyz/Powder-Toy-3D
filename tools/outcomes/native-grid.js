// Canonical native readback shared by harness and app adapters. No legacy A/B.
import { cellSlot } from '../../src/shaders/common.js';
import { E, ELEMENTS, K } from '../../src/elements.js';
import { FULL, lifeScale } from '../../src/v2/layout.js';
import { unpackContact } from '../../src/v2/contact.js';
import { unpackParticle, PARTICLE_BYTES, PHOTON_TAG, ballistic, dynamicsRows, DT, GRAVITY, CELL_M, packetFlight } from '../../src/v2/dynamics-reference.js';
import { fallCells, TICK_HZ } from '../../src/shaders/v2.js';
import { fallVelocity } from '../../src/v2/fall.js';
import { tally } from './lib.js';
import { nativeModes } from '../../src/v2/modes.js';
import { EDGE } from '../../src/simModes.js';

export const gridFallVelocity = fallVelocity;
export const nativeFall = (id, seconds) => ELEMENTS[id]?.kind === K.POWDER ? fallCells(id, Math.round(seconds * TICK_HZ)) : null;
export function nativeFlight(id, [vx, vy], seconds) {
  const row = dynamicsRows[id];
  if (!row || ![K.POWDER, K.LIQUID, K.GAS].includes(row.kind)) return null;
  let position = [0, 0, 0], velocity = [vx * CELL_M, vy * CELL_M, 0];
  // particles.js integrate in still air: V1's law a V1 step at a time (dPacketFlight; dynamics-reference.js packetFlight)
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const s = packetFlight(id, velocity);
    position = position.map((p, a) => p + s.moved[a]); velocity = s.velocity;
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
  return { layout: v2.g, origin, cells, banks, particles, air, loop: nativeModes(v2.sim).edge === EDGE.LOOP };
}

// Resident liquid velocity under column-run water (src/shaders/v2/columns.js), m/s, from the runs' own
// state (docs/v2/water-cost-first-principles.md, "Momentum, jets, splashes"): horizontal from each face
// segment's depth-averaged flux, the f16 lane at the segment's bottom in the -side column, at every row the
// segment spans, a cell's the mean of its two faces' (a MAC average); vertical from a falling run's fall
// speed (its bottom's y lane). A supported run is a hydrostatic column with no vertical momentum: its
// cells' vertical velocity is zero and known. A cell marked to launch (a negative y lane, mid-tick only)
// is unknown. core(x, y, z) is a cell's four words or null outside; loop wraps x and z (loop edges).
const LANE_MS = TICK_HZ * CELL_M / FULL;
const f16 = new Float16Array(1), u16 = new Uint16Array(f16.buffer);
const half = (bits) => { u16[0] = bits; return f16[0]; };
export const laneOf = (core, axis) => half(axis === 0 ? core[2] & 65535 : axis === 1 ? core[2] >>> 16 : core[3] & 65535);
export function columnLiquidVelocity({ nx, ny, nz, loop = false }, core, vel, known) {
  const kind = (c) => (c ? ELEMENTS[c[0] & 255]?.kind ?? K.SOLID : K.SOLID);
  const sub = (c) => ((c[0] & 255) === E.LAVA ? (c[1] >>> 24) & 255 : 0);
  // a column's domains bottom up (columns.js colScan): { y0, top, r1, liq, sub, falling }
  const domains = new Array(nx * nz);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const out = [];
    let y = 0;
    while (y < ny) {
      const k0 = kind(core(x, y, z));
      if (k0 !== K.EMPTY && k0 !== K.LIQUID) { y++; continue; }
      const o0 = y; let d = { y0: y, top: y, r1: y, liq: 0, sub: 0, falling: false };
      for (; y < ny; y++) {
        const c = core(x, y, z), k = kind(c);
        if (k !== K.EMPTY && k !== K.LIQUID) break;
        if (k !== K.LIQUID) continue;
        const id = c[0] & 255;
        if (d.liq === id && d.sub === sub(c) && d.r1 === y) { d.r1 = y + 1; continue; }
        if (d.liq || y > o0) { d.top = y; out.push(d); }
        d = { y0: y, top: y, r1: y + 1, liq: id, sub: sub(c), falling: y > o0 && kind(core(x, y - 1, z)) === K.EMPTY };
      }
      d.top = y; out.push(d);
    }
    domains[z * nx + x] = out;
  }
  const at = (x, z, y) => {
    if (loop) { x = ((x % nx) + nx) % nx; z = ((z % nz) + nz) % nz; }
    if (x < 0 || z < 0 || x >= nx || z >= nz) return null;
    for (const d of domains[z * nx + x]) if (y >= d.y0 && y < d.top) return { d, x, z };
    return null;
  };
  // the face between column (x, z) and the next along the axis, at row y
  const face = (x, y, z, axis) => {
    const a = at(x, z, y), b = at(x + (axis === 0 ? 1 : 0), z + (axis === 2 ? 1 : 0), y);
    if (!a || !b || a.d.falling || b.d.falling || (!a.d.liq && !b.d.liq)) return 0;
    return laneOf(core(a.x, Math.max(a.d.y0, b.d.y0), a.z), axis) * LANE_MS;
  };
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) for (const d of domains[z * nx + x]) {
    if (!d.liq) continue;
    const bottom = core(x, d.y0, z), fall = laneOf(bottom, 1);
    for (let y = d.y0; y < d.r1; y++) {
      const i = x + nx * (z + nz * y), c = core(x, y, z);
      if (laneOf(c, 1) < 0) { vel.fill(NaN, 3 * i, 3 * i + 3); known[i] = 0; continue; }
      known[i] = 1;
      if (d.falling) { vel[3 * i] = 0; vel[3 * i + 1] = fall > 0 ? -fall * TICK_HZ * CELL_M : 0; vel[3 * i + 2] = 0; continue; }
      vel[3 * i] = 0.5 * (face(x - 1, y, z, 0) + face(x, y, z, 0));
      vel[3 * i + 1] = 0;
      vel[3 * i + 2] = 0.5 * (face(x, y, z - 1, 2) + face(x, y, z, 2));
    }
  }
}
export function toGrid({ layout: l, origin = [0, 0, 0], cells, banks, particles, air, loop = false }) {
  const { nx, ny, nz } = l, n = nx * ny * nz;
  const words = new Uint32Array(cells), bank = new Int32Array(banks), a = new Float32Array(air);
  // Complete motion is not published (moving stays null); liquid velocity comes from the column runs.
  const g = { nx, ny, nz, id: new Int32Array(n), amount: new Float32Array(n), gridAmount: new Float32Array(n),
    T: new Float32Array(n), burning: new Uint8Array(n), pressure: new Float32Array(n),
    moving: null, velocityKnown: new Uint8Array(n).fill(1), vel: new Float32Array(n * 3), airVel: new Float32Array(n * 3),
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
  }
  // resident liquid: the column runs' own momentum (columnLiquidVelocity)
  columnLiquidVelocity({ nx, ny, nz, loop }, (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? null
    : words.subarray(cellSlot(l, x, y, z) * 4, cellSlot(l, x, y, z) * 4 + 4)), g.vel, g.velocityKnown);
  const bytes = new Uint8Array(particles);
  const particleWords = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + PARTICLE_BYTES <= bytes.byteLength; offset += PARTICLE_BYTES) {
    // Empty canonical slots need no object/core allocation during a census.
    if (particleWords.getUint32(offset + 12, true) === 0) continue;
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

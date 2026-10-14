// CPU specification and shared constants for native dynamics. Units: world cells,
// seconds, m/s, J and Pa. No legacy state is read by the native kernels.
import { ELEMENTS, E, K } from '../elements.js';
import { CELL_M } from '../scale.js';
import { energyOf, withEnergy, energyFits, makeMaterial, cTq, AIR_CAPACITY_Q } from './layout.js';
export { CELL_M };
export const PARTICLE_CAP = 65536;
export const PARTICLE_BYTES = 48;
export const DT = 1 / 60;
export const GRAVITY = 19.6; // TF2's ~2 g, docs/v2.md §5.1.
export const BLAST_SCALE = 1e-3; // Deliberate miniature TNT scale, R10.
export const AIR = Object.freeze({ edge: 4 * CELL_M, rho: 1.225, sound: 50,
  substeps: 8, loss: 0.9999, diffusion: 0.04, pQuantum: 0.02, vQuantum: 0.0002,
  scalarQuantum: 1e-7, quietTicks: 8, gasPressure: 1.225 * 50 ** 2 / 64 });
export const EVENT = Object.freeze({ DETONATE: 1, GAS: 2, NEUTRON: 4 });
export const PHOTON_TAG = 254;
export const NEUTRON_TAG = 255; // Particle-only, never a grid element.
if (ELEMENTS.length >= PHOTON_TAG) throw new Error('Native neutron tag collides with a material');
const SPECIFIC_J = { TNT: 4.184e6, C4: 5.858e6, NITRO: 6.28e6, GUNPOWDER: 3e6,
  THERMITE: 3.9e6, PROPANE: 46.4e6 };
export const dynamicsRows = ELEMENTS.map(e => ({
  id: e.id, kind: e.kind, mass: Math.max(e.dens * 100 * CELL_M ** 3, 0.001),
  // TPT hardness is retained as the gameplay fracture energy, now explicitly J.
  toughness: e.breakInto ? e.hard : 1e30, breakInto: e.breakInto ? E[e.breakInto] : -1,
  strength: e.breakInto ? e.hard / CELL_M ** 2 : 1e30,
  terminal: ({ ASH: 3, SNOW: 3, SAWDUST: 4, DUST: 3 })[e.key] ?? 55,
  lift: ({ ASH: 1, DUST: 1, SNOW: 2, SAWDUST: 2 })[e.key] ?? 12,
  energy: e.blast ? Math.max(e.dens * 100 * CELL_M ** 3, 0.001) * (SPECIFIC_J[e.key] ?? 3e6) * BLAST_SCALE : 0,
  product: e.blast ? E[e.blast.into ?? 'FIRE'] : 0,
  productCtype: e.blast?.of ? E[e.blast.of] : 0,
  productT: e.blast?.T ?? 20,
}));
export function hash32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
export function stableId(position, tick, rule = 0) {
  return hash32((Math.imul(position[0] | 0, 73856093) ^ Math.imul(position[1] | 0, 19349663) ^
    Math.imul(position[2] | 0, 83492791) ^ Math.imul(tick, 2654435761) ^ rule) >>> 0) || 1;
}
export const claimKey = (id, tick) => hash32((id ^ Math.imul(tick, 2654435761)) >>> 0);
export function packParticle({ position, velocity, id, core, bank }) {
  const bytes = new ArrayBuffer(PARTICLE_BYTES), v = new DataView(bytes);
  for (let a = 0; a < 3; a++) { v.setFloat32(a * 4, position[a], true); v.setFloat32(16 + a * 4, velocity[a], true); }
  v.setUint32(12, id, true);
  for (let a = 0; a < 4; a++) v.setUint32(28 + a * 4, core[a], true);
  v.setInt32(44, bank, true);
  return bytes;
}
export function unpackParticle(bytes) {
  const v = new DataView(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, PARTICLE_BYTES);
  return { position: [0, 4, 8].map(i => v.getFloat32(i, true)), id: v.getUint32(12, true),
    velocity: [16, 20, 24].map(i => v.getFloat32(i, true)),
    core: [28, 32, 36, 40].map(i => v.getUint32(i, true)), bank: v.getInt32(44, true) };
}
export function ballistic(position, velocity, dt = DT, gravity = GRAVITY) {
  return { position: position.map((p, a) => p + (velocity[a] * dt - (a === 1 ? 0.5 * gravity * dt * dt : 0)) / CELL_M),
    velocity: velocity.map((v, a) => v - (a === 1 ? gravity * dt : 0)) };
}
// Amanatides/Woo, including all crossed voxels, irrespective of speed. Ties
// walk one face at a time in x,y,z order (the WGSL uses the same convention).
export function sweep(from, to, occupied) {
  const d = to.map((x, a) => x - from[a]), cell = from.map(Math.floor), step = d.map(Math.sign);
  const inv = d.map(x => x ? Math.abs(1 / x) : Infinity);
  const next = d.map((x, a) => x ? ((cell[a] + (x > 0 ? 1 : 0) - from[a]) / x) : Infinity);
  let t = 0, previous = [...cell];
  for (;;) {
    if (occupied(cell)) return { cell: [...cell], previous, t };
    let axis = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
    if (next[axis] > 1) return null;
    previous = [...cell]; t = next[axis]; cell[axis] += step[axis]; next[axis] += inv[axis];
  }
}
export function resolveDeposits(particles, tick, empty, deposit) {
  const claims = new Map();
  for (const p of particles) {
    if (!empty(p.target)) continue;
    const key = p.target.join(','), prev = claims.get(key);
    if (!prev || claimKey(p.id, tick) < claimKey(prev.id, tick) ||
      (claimKey(p.id, tick) === claimKey(prev.id, tick) && p.id < prev.id)) claims.set(key, p);
  }
  for (const p of claims.values()) deposit(p.target, { core: [...p.core], bank: p.bank });
  return particles.filter(p => claims.get(p.target.join(',')) !== p);
}
export function allocateSources(sources, pool, capacity = PARTICLE_CAP) {
  // Canonical source order, not dispatch/list order. At capacity leave the
  // authoritative source intact; an event producer must retain its request.
  let free = 0;
  for (const source of [...sources].sort((a, b) => a.slot - b.slot)) {
    while (free < capacity && pool[free]?.id) free++;
    if (free === capacity) { source.retry = true; continue; }
    pool[free++] = { ...source.particle, core: [...source.particle.core] };
    source.material = null; source.retry = false;
  }
}
export function impact(core, velocity, target, amount = 1) {
  const row = dynamicsRows[core[0] & 255], t = dynamicsRows[target[0] & 255];
  const energy = 0.5 * row.mass * amount * velocity.reduce((s, v) => s + v * v, 0);
  const broken = row.kind !== K.LIQUID && t.breakInto >= 0 && energy >= t.toughness;
  return { energy, broken, remaining: energy - (broken ? t.toughness : 0) };
}
export function blastPlan(source, targets, solidAt, energy) {
  const plans = targets.map(target => {
    const hit = sweep(source.map(x => x + 0.5), target.map(x => x + 0.5), p =>
      !p.every((x, a) => x === source[a]) && !p.every((x, a) => x === target[a]) && solidAt(p));
    const r2 = Math.max(0.25, target.reduce((s, x, a) => s + (x - source[a]) ** 2, 0));
    return { target, energy: hit ? 0 : energy * 0.5 / (4 * Math.PI * r2) };
  });
  const sum = plans.reduce((s, p) => s + p.energy, 0), scale = Math.min(1, energy * 0.5 / Math.max(sum, 1e-30));
  return plans.map(p => ({ ...p, energy: p.energy * scale }));
}
// Finite-volume one-axis scalar reference. Each face is evaluated ONCE and
// exchanged with opposite signs: neither diffusion nor upwind advection
// creates heat or gas. Closed domain by default.
export function exchangeScalar(values, velocities, dt, { diffusion = AIR.diffusion, edge = AIR.edge } = {}) {
  const out = [...values];
  for (let i = 0; i + 1 < values.length; i++) {
    const adv = Math.max(-1 / 12, Math.min(1 / 12, (velocities[i] + velocities[i + 1]) * 0.5 * dt / edge));
    const gradient = values[i] - values[i + 1];
    const flux = (Math.abs(gradient) < AIR.scalarQuantum ? 0 : diffusion * dt / edge ** 2 * gradient) +
      adv * (adv >= 0 ? values[i] : values[i + 1]);
    out[i] -= flux; out[i + 1] += flux;
  }
  return out;
}
export function airSource(state, count) {
  return { ...state, pressure: state.pressure + count * AIR.gasPressure, gas: state.gas + count / 64, quiet: 0 };
}
export function airQuiet(state, neighbors = []) {
  return [state, ...neighbors].every(s => Math.abs(s.pressure) < AIR.pQuantum &&
    s.velocity.every(v => Math.abs(v) < AIR.vQuantum)) ? Math.min(AIR.quietTicks, state.quiet + 1) : 0;
}

// Exact native energy twins of the WGSL handoff. The stationary grid's air
// carrier is NOT part of a flying material packet; its bank still is.
export const particleEnergy = m => energyOf(m)-BigInt(AIR_CAPACITY_Q)*BigInt(cTq(m.core));
export function extractPacket(m) {
  return { packet:{core:new Uint32Array(m.core),bank:m.bank},
    source:makeMaterial(0,cTq(m.core)*0.25-273.25,0,0) };
}
export function depositPacket(packet, destination) {
  const energy=particleEnergy(packet)+energyOf(destination);
  return energyFits(packet,energy) ? withEnergy(packet,energy) : null;
}
export function fractureMaterial(material, product) {
  const after={core:new Uint32Array(material.core),bank:material.bank};
  after.core[0]=(after.core[0]&0xffffff00)|product;
  return energyFits(after,energyOf(material)) ? withEnergy(after,energyOf(material)) : null;
}
export function chargeEnergy(material) {
  const id=material.core[0]&255,row=dynamicsRows[id];
  return row.energy*(row.kind===K.LIQUID ? (material.core[1]&0xffffff)/65536 : 1);
}
export const pressureEnergy = p => p*p*AIR.edge**3/(2*AIR.rho*AIR.sound**2);
export const addBlastPressure = (p,energy) => Math.sqrt(p*p+2*AIR.rho*AIR.sound**2*energy*0.25/AIR.edge**3);
export function refractDirection(direction,normal,ratio) {
  const dot=direction.reduce((s,x,i)=>s+x*normal[i],0),k=1-ratio*ratio*(1-dot*dot);
  if(k<0) return direction.map((x,i)=>x-2*dot*normal[i]);
  return direction.map((x,i)=>ratio*x-(ratio*dot+Math.sqrt(k))*normal[i]);
}

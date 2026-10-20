// CPU specification and shared constants for native dynamics. Units: world cells,
// seconds, m/s, J and Pa. No legacy state is read by the native kernels.
import { ELEMENTS, E, K } from '../elements.js';
import { CELL_M } from '../scale.js';
import { PHYS } from '../physics.js';
import { contactVacuum, specialExplosion } from './contact.js';
import { impactFoam } from './foam.js';
import { energyOf, withEnergy, energyFits, makeMaterial, cTq, withPayload, payloadOf, share, packetOwnedEnergy, withPacketEnergy, packetEnergyFits } from './layout.js';
import { AIR, BLAST_SCALE, GUNPOWDER_ENERGY_J, GUNPOWDER_PRESSURE, LEGACY_PRESSURE_PA, legacyPressureToPa, specialBlastEnergy } from './pressure.js';
export { AIR, BLAST_SCALE, GUNPOWDER_ENERGY_J, GUNPOWDER_PRESSURE, LEGACY_PRESSURE_PA, legacyPressureToPa, specialBlastEnergy };
export { CELL_M };
export const PARTICLE_CAP = 65536;
export const PARTICLE_BYTES = 48;
export const DT = 1 / 60;
export const GRAVITY = 19.6; // TF2's ~2 g, docs/v2.md §5.1.
export const singularityVacuumPa = core => legacyPressureToPa(contactVacuum(core));
export const EVENT = Object.freeze({ DETONATE: 1, GAS: 2, NEUTRON: 4 });
export const PHOTON_TAG = 254;
export const NEUTRON_TAG = 255; // Particle-only, never a grid element.
if (ELEMENTS.length >= PHOTON_TAG) throw new Error('Native neutron tag collides with a material');
const SPECIFIC_J = { TNT: 4.184e6, C4: 5.858e6, NITRO: 6.28e6, GUNPOWDER: 3e6,
  THERMITE: 3.9e6, PROPANE: 46.4e6 };
// V1 react.js crush (elements.js crush { P, into, of }): past P of air pressure on it (the
// highest of its own, none for a solid, and its open neighbours') a cell becomes pickOut(into),
// keeping its temperature, with its product's spawn life; a LAVA product's ctype is `of` (or the
// cell's own element: react.js ctypeOf). pa: P in Pa; outs: [id, cumulative share] as
// elements.js mechanisms() draws them ('SAME' stays itself); null without a crush.
function crushPhaseOf(e) {
  if (!e.crush) return null;
  const list = typeof e.crush.into === 'string' ? [[e.crush.into, 1]] : e.crush.into;
  const total = list.reduce((sum, [, w]) => sum + w, 0);
  let at = 0;
  const outs = list.map(([key, w]) => [key === 'SAME' ? e.id : E[key], at += w / total]);
  outs[outs.length - 1][1] = 1;
  if (outs.some(([id]) => !Number.isInteger(id))) throw new Error(`${e.key}.crush: unknown product`);
  return { pa: e.crush.P * LEGACY_PRESSURE_PA, outs, of: e.crush.of ? E[e.crush.of] : e.id };
}
export const dynamicsRows = ELEMENTS.map(e => ({
  id: e.id, kind: e.kind, mass: Math.max(e.dens * 100 * CELL_M ** 3, 0.001),
  // TPT hardness is retained as the gameplay fracture energy, now explicitly J.
  toughness: e.breakInto ? e.hard : 1e30, breakInto: e.breakInto ? E[e.breakInto] : -1,
  // V1 react.js breaking: the air pressure difference across a solid past
  // hard·P_BREAK_PER_HARD (legacy pressure, here in Pa) breaks it.
  strength: e.breakInto ? e.hard * PHYS.P_BREAK_PER_HARD * LEGACY_PRESSURE_PA : 1e30,
  // V1 react.js: an explosive goes off under more than blast.crushP air pressure (Pa here).
  crush: e.blast?.crushP ? e.blast.crushP * LEGACY_PRESSURE_PA : 0,
  crushPhase: crushPhaseOf(e),
  terminal: ({ ASH: 3, SNOW: 3, SAWDUST: 4, DUST: 3 })[e.key] ?? 55,
  lift: ({ ASH: 1, DUST: 1, SNOW: 2, SAWDUST: 2 })[e.key] ?? 12,
  energy: e.key==='DUST' ? specialBlastEnergy(PHYS.DUST_P) : e.blast ? Math.max(e.dens * 100 * CELL_M ** 3, 0.001) * (SPECIFIC_J[e.key] ?? 3e6) * BLAST_SCALE : 0,
  product: e.key==='DUST' ? E.FIRE : e.key==='SINGULARITY' ? E.FIRE : e.blast ? E[e.blast.into ?? 'FIRE'] : 0,
  productCtype: e.blast?.of ? E[e.blast.of] : 0,
  productT: e.key==='DUST' ? PHYS.DUST_FLAME_T : e.key==='SINGULARITY' ? PHYS.SING_BURST_T : e.blast?.T ?? 20,
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
function canonicalParticleBefore(a,b) {
  const words=p=>new Uint32Array(packParticle({...p,position:p.position??p.target.map(x=>x+0.5),velocity:p.velocity??[0,0,0]}));
  const aw=words(a),bw=words(b);
  for(let i=0;i<12;i++) if(aw[i]!==bw[i]) return aw[i]<bw[i];return false;
}
export function resolveDeposits(particles, tick, empty, deposit) {
  const claims = new Map();
  for (const p of particles) {
    if (!empty(p.target)) continue;
    const key = p.target.join(','), prev = claims.get(key);
    if (!prev || claimKey(p.id, tick) < claimKey(prev.id, tick) ||
      (claimKey(p.id, tick) === claimKey(prev.id, tick) && canonicalParticleBefore(p,prev))) claims.set(key, p);
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
export const particleEnergy = packetOwnedEnergy;
export function extractPacket(m) {
  return { packet:{core:new Uint32Array(m.core),bank:m.bank},
    source:makeMaterial(0,cTq(m.core)*0.25-273.25,0,0) };
}
export function extractPartialPacket(source,amount) {
  const total=source.core[1]&0xffffff;
  if(!Number.isInteger(amount) || amount<1 || amount>total) throw new RangeError('particle extraction amount');
  if(amount===total) return extractPacket(source);
  let packet={core:new Uint32Array(source.core),bank:source.bank},rest={core:new Uint32Array(source.core),bank:source.bank};
  packet.core[1]=(packet.core[1]&0xff000000)|amount;rest.core[1]=(rest.core[1]&0xff000000)|(total-amount);
  if(!(ELEMENTS[source.core[0]&255].elec>0)) {
    const fuel=Number(share(payloadOf(source.core),0,amount,total));
    packet=withPayload(packet,fuel);rest=withPayload(rest,payloadOf(source.core)-fuel);
  }
  const e=share(particleEnergy(source),0,amount,total);
  if(!packetEnergyFits(packet,e)) return null;packet=withPacketEnergy(packet,e);
  const remaining=energyOf(source)-particleEnergy(packet);if(!energyFits(rest,remaining)) return null;
  return {packet,source:withEnergy(rest,remaining)};
}
export function depositPacket(packet, destination, {speed2=0}={}) {
  const energy=particleEnergy(packet)+energyOf(destination);if(!energyFits(packet,energy)) return null;
  const after=withEnergy(packet,energy);
  if(dynamicsRows[packet.core[0]&255].kind===K.LIQUID) {
    const foam=impactFoam({incoming:packet.core[0]>>>24,resident:0,amount:packet.core[1]&0xffffff,fill:0,speed2});
    after.core[0]=(after.core[0]&0xffffff)|(foam<<24);
  }
  return after;
}
export function fractureMaterial(material, product) {
  const after={core:new Uint32Array(material.core),bank:material.bank};
  after.core[0]=(after.core[0]&0xffffff00)|product;
  return energyFits(after,energyOf(material)) ? withEnergy(after,energyOf(material)) : null;
}
export function chargeEnergy(material) {
  const id=material.core[0]&255,row=dynamicsRows[id];
  const special=specialExplosion(material.core,GUNPOWDER_ENERGY_J);if(special) return special.energyJ;
  return row.energy*(row.kind===K.LIQUID ? (material.core[1]&0xffffff)/65536 : 1);
}
export const pressureEnergy = p => p*p*AIR.edge**3/(2*AIR.rho*AIR.sound**2);
export const addBlastPressure = (p,energy) => Math.sqrt(p*p+2*AIR.rho*AIR.sound**2*energy*0.25/AIR.edge**3);
export function refractDirection(direction,normal,ratio) {
  const dot=direction.reduce((s,x,i)=>s+x*normal[i],0),k=1-ratio*ratio*(1-dot*dot);
  if(k<0) return direction.map((x,i)=>x-2*dot*normal[i]);
  return direction.map((x,i)=>ratio*x-(ratio*dot+Math.sqrt(k))*normal[i]);
}

export function holdVelocities(particles, destination, strength=12, dt=DT) {
  let mass=0;const offset=[0,0,0],mean=[0,0,0];
  for(const p of particles) {
    const m=p.mass;mass+=m;
    for(let a=0;a<3;a++) { offset[a]+=(p.position[a]-destination[a])*m;mean[a]+=p.velocity[a]*m; }
  }
  if(!mass) return [];
  const omega=Math.max(1,Math.min(60,strength)),step=Math.max(0,Math.min(.1,dt)),decay=Math.exp(-omega*step);
  for(let a=0;a<3;a++) mean[a]/=mass;
  const desired=mean.map((v,a)=>(v-omega*(v+omega*offset[a]/mass*CELL_M)*step)*decay);
  return particles.map(p=>desired.map((v,a)=>v+(p.velocity[a]-mean[a])*Math.exp(-2*omega*step)));
}

// Scalar/pressure/velocity twin of one air substep in a closed rectangular
// fixture. Faces are evaluated in canonical order, just like air.js aFlux.
export function airStepReference(cells,dims,{airMode=0,ambientHeat=true}={}) {
  const [nx,ny,nz]=dims,dt=DT/AIR.substeps,dx=AIR.edge;
  const vOn=[0,1,4].includes(airMode),pOn=[0,2,4].includes(airMode);
  const input=cells.map(a=>({...a,velocity:vOn?[...a.velocity]:[0,0,0],pressure:pOn?a.pressure:0,heat:ambientHeat?a.heat:0}));
  const idx=(x,y,z)=>x+nx*(z+nz*y),loss=AIR.loss**(1/AIR.substeps);
  const flux=(l,r,axis)=>{
    const lv=[...l.velocity,l.pressure],rv=[...r.velocity,r.pressure];
    const acoustic=lv.map((v,i)=>-0.5*AIR.sound*(rv[i]-v));
    acoustic[axis]+=(lv[3]+rv[3])/(2*AIR.rho);acoustic[3]+=AIR.rho*AIR.sound**2*(lv[axis]+rv[axis])/2;
    const courant=Math.max(-1/12,Math.min(1/12,(lv[axis]+rv[axis])*0.5*dt/dx));
    const donor=courant>=0?l:r;
    const vp=acoustic.map((v,i)=>v*dt/dx+(i<3?donor.velocity[i]*courant:0));
    const scalars=['heat','gas'].map((field,i)=>{
      if(i===0&&!ambientHeat || i===1&&!pOn&&!vOn) return 0;
      const gradient=r[field]-l[field];
      return courant*donor[field]-(Math.abs(gradient)<AIR.scalarQuantum?0:AIR.diffusion*dt/dx**2*gradient);
    });return {vp,scalars};
  };
  const out=input.map(a=>({...a,velocity:[...a.velocity]}));
  for(let y=0;y<ny;y++)for(let z=0;z<nz;z++)for(let x=0;x<nx;x++) {
    const i=idx(x,y,z),before=input[i],vp=[...before.velocity,before.pressure],scalar=[before.heat,before.gas];
    for(let axis=0;axis<3;axis++)for(const sign of [-1,1]) {
      const q=[x,y,z];q[axis]+=sign;if(q.some((v,a)=>v<0||v>=dims[a]))continue;
      const other=input[idx(...q)],f=sign>0?flux(before,other,axis):flux(other,before,axis);
      for(let a=0;a<4;a++)vp[a]-=sign*f.vp[a];vp[axis]+=sign*before.pressure/AIR.rho*dt/dx;
      for(let a=0;a<2;a++)scalar[a]-=sign*f.scalars[a];
    }
    out[i].velocity=vOn?(airMode===4?[...before.velocity]:vp.slice(0,3).map(v=>v*loss)):[0,0,0];
    out[i].pressure=pOn?(airMode===4?before.pressure:vp[3]*loss):0;
    out[i].heat=ambientHeat?scalar[0]:0;out[i].gas=scalar[1];
  }return out;
}

export function bodyCoupledVelocity(request,position,id,tick=0) {
  const row=dynamicsRows[id];if(!row || id===0 || row.kind===K.SOLID || (request.only>=0 && request.only!==id) ||
    position.some((x,a)=>x<request.lo[a] || x>request.hi[a])) return null;
  const radial=[position[0]-(request.lo[0]+request.hi[0])/2,position[2]-(request.lo[2]+request.hi[2])/2];
  const len=Math.hypot(...radial);let outward;
  if(len>1e-6) outward=radial.map(x=>x/len);
  else { const id=stableId(position.map(Math.floor),tick,0x424f4459),r=(hash32(id^Math.imul(tick,2654435761)^31)>>>8)/16777216;
    outward=[Math.cos(r*2*Math.PI),Math.sin(r*2*Math.PI)]; }
  const ahead=request.ahead??[0,0],direction=[outward[0]+ahead[0],request.lift??0,outward[1]+ahead[1]];
  const norm=Math.max(1e-6,Math.hypot(...direction)),push=row.kind===K.POWDER?request.pushPowder:request.pushFluid;
  return request.velocity.map((v,a)=>v+direction[a]/norm*push);
}

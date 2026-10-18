import { E, ELEMENTS, K } from '../elements.js';
// §4.3 Monahan lifetimes; Noita/TPT local-material decoration, not a fluid force.
// All liquids participate; no Whitewater setting or render-frame clock.
export const FOAM_ROWS = ELEMENTS.map(e => ({ gain: e.kind === K.LIQUID ? 1 : 0, tau: e.id === E.SALTWATER ? 3.85 : 2.54 }));
export function decayFoam(foam,tick,slot=0,id=E.WATER) {
  const period=Math.round(FOAM_ROWS[id].tau*60),phase=(tick+slot)%period;
  return foam-(Math.floor((phase+1)*foam/period)-Math.floor(phase*foam/period));
}
/** Accepted impact only, once per deposited packet. Kinetic energy per mass
 * scales as speed²; entrainment starts at1m/s (§4.2). 70% incoherent fraction
 * supplies bounded foam coverage, not another energy ledger or mass source. */
export function impactFoam({ incoming=0, resident=0, amount, fill=0, speed2 }) {
  if(amount<=0) return resident;
  const entrained=0.7*Math.max(0,speed2-1)/(1+Math.max(0,speed2));
  return Math.min(255,Math.floor((resident*fill+(incoming+255*entrained)*amount)/(fill+amount)));
}
export const impactFoamWGSL = /* wgsl */ `
fn impactFoam(incoming: u32, resident: u32, amount: u32, fill: u32, speed2: f32) -> u32 {
  if (amount == 0u) { return resident; }
  let entrained = 0.7 * max(0.0, speed2 - 1.0) / (1.0 + max(0.0, speed2));
  return u32(min(255.0, (f32(resident)*f32(fill) + (f32(incoming)+255.0*entrained)*f32(amount))/f32(fill+amount)));
}
`;

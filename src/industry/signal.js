import { E } from '../elements.js';
import { ELEC, isLive } from '../electricity.js';

// Old Factory latches retain their meaning; authored supply circuits terminate
// in a non-transmitting CONTACTOR rather than reading intermittent sparks.
export function industrySignalActive({ id, life = 0, ctype = 0 }) {
  if (id === E.BATTERY) return true;
  if (id === E.SWITCH) return life === ELEC.SWITCH_ON;
  if (id === E.CONTACTOR) return life > 0;
  return !!isLive(id, ctype);
}

export const industrySignalWGSL = /* wgsl */ `
fn industrySignalActive(a: vec4f) -> bool {
  let id = eid(a);
  if (id == E_BATTERY) { return true; }
  if (id == E_SWITCH) { return a.z == SWITCH_ON; }
  if (id == E_CONTACTOR) { return a.z > 0.0; }
  return sparkLive(id, floor(a.w));
}
`;

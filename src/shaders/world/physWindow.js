import { SUPER_CELLS } from '../common.js';
import { decoViewWGSL } from '../gfx/deco.js';

/** MarchParams' physics-window fields for a simulation (physics' window, at its origin in the world). */
export const physParams = (sim) => {
  const o = sim.origin, g = sim.g;
  return {
    physOrigin: [o?.x ?? 0, o?.y ?? 0, o?.z ?? 0], physSize: [g.nx, g.ny, g.nz],
    physSuper: [g.nx / SUPER_CELLS.x, g.ny / SUPER_CELLS.y, g.nz / SUPER_CELLS.z], physRing: g.ring ?? 0,
  };
};

export const physWindowWGSL = /* wgsl */ `
// ---- physics' window (P.physOrigin, P.physSize), indexed at run time ----
// (its slot layout from P.physSuper, as the prelude's slotOf has it from its constants: the
// march's own reads bake in no window size)
fn inPhys(c: vec3i) -> bool {
  let q = c - P.physOrigin;
  return all(q >= vec3i(0)) && all(q < P.physSize);
}
fn physSlot(c: vec3i) -> u32 {
  let p = c - P.physOrigin;
  let b = p >> vec3u(2u);
  let s = b / SUPER_B;
  let k = b - s * SUPER_B;
  let st = s.x + P.physSuper.x * (s.z + P.physSuper.z * s.y);
  let l = p & vec3i(3);
  // (a ringed window's brick numbers rotate by its ring: shaders/common.js brickId)
  let n = u32(16 * P.physSuper.x * P.physSuper.y * P.physSuper.z);
  let id = (u32(st * 16 + k.x + 4 * (k.z + 2 * k.y)) + P.physRing) % n;
  return id * 64u + u32(l.x + 4 * (l.y & 1) + 8 * (l.z + 4 * (l.y >> 1u)));
}
`;

export function decoWorld() {
  return decoViewWGSL({ outside: '!inPhys(c)', slot: 'physSlot(c)' });
}

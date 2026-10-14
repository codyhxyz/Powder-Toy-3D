import { EDIT_FIELDS, EDIT_SCRATCH_BINDING, LAYOUT, editKernelWGSL } from './common.js';
import { uniformStruct } from '../gpu/params.js';

// Sandustry: machines act on grains, never item inventories. Control is TPT's
// existing spark automaton, including a direct battery or enabled SWCH.
export const MACHINE_GUARD_FIELDS = {
  guardBase: 'vec3i', guardMaterial: 'i32',
  guardPort: 'vec3i', guardPowered: 'u32',
};
export const machineGuardWGSL = /* wgsl */ `
fn machineEnabled(base: vec3i, material: i32, port: vec3i, controlled: u32) -> bool {
  if (material < 0) { return true; }
  for (var z = 0; z < 4; z++) {
    for (var x = 0; x < 4; x++) {
      let p = base + vec3i(x, 0, z);
      if (!inGrid(p)) { return false; }
      if (eid(fetchA(p)) != material) { return false; }
    }
  }
  if (controlled == 0u) { return true; }
  if (!inGrid(port)) { return false; }
  let a = fetchA(port);
  let id = eid(a);
  if (id == E_BATTERY) { return true; }
  if (id == E_SWITCH) { return a.z == SWITCH_ON; }
  return sparkLive(id, floor(a.w));
}
`;
export const INDUSTRY_KIND = Object.freeze({ belt: 0, separator: 1, lift: 2, miner: 3, heater: 4 });
export const IndustryParams = uniformStruct('IndustryParams', {
  ...EDIT_FIELDS, ...MACHINE_GUARD_FIELDS,
  forward: 'vec3i', right: 'vec3i', corner: 'vec3i',
  kind: 'u32', selectedId: 'i32', dt: 'f32', drill: 'u32',
});
export const industryUpdateWGSL = /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  if (!machineEnabled(P.guardBase, P.guardMaterial, P.guardPort, P.guardPowered)) { return; }
  let id = eid(a);
  if (id == E_EMPTY) { return; }
  let rel = p - P.corner;
  let x = dot(vec3f(rel), vec3f(P.right));
  let z = dot(vec3f(rel), vec3f(P.forward));
  let y = rel.y;
  if (P.kind == 3u) {
    // Sandustry's excavator discharges onto the line behind it. Its own deck
    // carries debris back; otherwise the first cut merely piles up on the robot.
    if (x >= 0.0 && x <= 3.0 && z >= 0.0 && z <= 3.0 && y == 1 && KIND(id) == K_POWDER) {
      *oB = vec4f(-vec3f(P.forward) * 0.6 + vec3f(0.0, max(b.y, 0.0), 0.0), b.w);
      return;
    }
    // A finite four-cell reach, one face layer per pulse. Intervening solids
    // occlude the drill; debris is left at the struck cell (Noita excavation).
    if (P.drill == 0u || x < 0.0 || x > 3.0 || y < 1 || y > 3 || z < 4.0 || z > 7.0) { return; }
    if (KIND(id) != K_SOLID || BREAKINTO(id) < 0) { return; }
    for (var k = 4; k < i32(z); k++) {
      let q = P.corner + P.right * i32(x) + vec3i(0, y, 0) + P.forward * k;
      if (!inGrid(q)) { return; }
      if (KIND(eid(fetchA(q))) == K_SOLID) { return; }
    }
    (*oA).x = f32(BREAKINTO(id));
    (*oA).z = 0.0;
    (*oA).w = fract(a.w);
    *oB = vec4f(-vec3f(P.forward) * 0.35 + vec3f(0.0, 0.1, 0.0), b.w);
    return;
  }
  if (x < 0.0 || x > 3.0 || z < 0.0 || z > 3.0) { return; }
  if (P.kind == 4u) {
    // TPT heat tool, including the refractory hearth. Heating only the charge
    // leaves a cold deck that sinks heat faster than it arrives at normal speed.
    // The 2200 C cap stays below tungsten's melting point; native conduction,
    // latent heat and phase changes still handle the material.
    if (y >= 0 && y <= 3 && a.y < 2200.0) { (*oA).y = min(2200.0, a.y + 7200.0 * P.dt); }
    return;
  }
  // Only grains actually touching the intact deck. No remote force on a
  // suspended stream, no moving liquids or solids as if they were items.
  if (y != 1 || KIND(id) != K_POWDER) { return; }
  let under = p - vec3i(0, 1, 0);
  if (!inGrid(under) || KIND(eid(fetchA(under))) != K_SOLID) { return; }
  if (P.kind == 2u) {
    *oB = vec4f(b.x, 1.0, b.z, b.w);
  } else {
    var direction = P.forward;
    if (P.kind == 1u && id != P.selectedId) { direction = P.right; }
    *oB = vec4f(vec3f(direction) * 0.6 + vec3f(0.0, max(b.y, 0.0), 0.0), b.w);
  }
}
`;
export const INDUSTRY_EDIT = {
  params: IndustryParams, reads: 'neighbours', decls: machineGuardWGSL, update: industryUpdateWGSL,
};
export const WGSL_CHECK = [{
  name: 'industry', kind: 'compute', code: g => editKernelWGSL(g, INDUSTRY_EDIT),
  layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, [{ binding: EDIT_SCRATCH_BINDING, buffer: { type: 'storage' } }]],
  dispatch: () => [1, 1, 1],
}];

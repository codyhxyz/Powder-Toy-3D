import { prelude, STATE_OPTS, LAYOUT } from '../shaders/common.js';
import { uniformStruct } from '../gpu/params.js';
import { RING_LAYOUT, ringWGSL } from '../shaders/povBody.js';
import { baseMaterial } from './catalog.js';
import { deviceHeight } from './validation.js';
import { PUMP_BACKPLATE_TAG } from './pumpStructure.js';

const Params = uniformStruct('IndustryConstruction', { at: 'vec3i', material: 'i32', mode: 'u32', slot: 'u32', height: 'i32', hearth: 'u32', pump: 'u32', rotation: 'u32' });
// One invocation tests the entire machine before writing any cell. Unlike a
// brush or sixteen independent transfers this cannot leave half a paid deck.
export const constructionWGSL = g => /* wgsl */ `
${prelude(g, STATE_OPTS.STATE_RW)}
${Params.wgsl}
@group(3) @binding(1) var<uniform> P: IndustryConstruction;
const INDUSTRY_PUMP_BACKPLATE_TAG: f32 = ${PUMP_BACKPLATE_TAG}.0;
${ringWGSL()}
fn hearthStructureCell(x: i32, y: i32, z: i32) -> bool {
  return y == 0 || (y >= 1 && y <= 3 && (x == 0 || x == 3 || z == 0 || (z == 3 && y == 1)));
}
fn rotateLocal(x: i32, z: i32) -> vec2i {
  if (P.rotation == 1u) { return vec2i(3 - z, x); }
  if (P.rotation == 2u) { return vec2i(3 - x, 3 - z); }
  if (P.rotation == 3u) { return vec2i(z, 3 - x); }
  return vec2i(x, z);
}
@compute @workgroup_size(1)
fn main() {
  var clear = true;
  for (var z = 0; z < 4; z++) { for (var y = 0; y < P.height; y++) { for (var x = 0; x < 4; x++) {
    let c = P.at + vec3i(x,y,z);
    if (!inGrid(c)) { clear = false; }
    else if (eid(fetchA(c)) != E_EMPTY) { clear = false; }
  } } }
  // 0 probe, 1 place, 2 dismantle. Removal never erases fallen ore or liquid.
  if ((clear && P.mode == 1u) || P.mode == 2u) {
    if (P.hearth != 0u) {
      for (var z = 0; z < 4; z++) { for (var y = 0; y < 4; y++) { for (var x = 0; x < 4; x++) {
        if (!hearthStructureCell(x, y, z)) { continue; }
        let r = rotateLocal(x, z);
        let c = P.at + vec3i(r.x, y, r.y);
        if (!inGrid(c)) { continue; }
        let a = fetchA(c); let b = fetchB(c);
        if (P.mode == 2u && eid(a) != P.material) { continue; }
        ownLegacy(slotOf(c));
        let id = select(P.material, E_EMPTY, P.mode == 2u);
        let out = vec4f(f32(id), airT(), 0.0, fract(a.w));
        if (writeCell(c, a, b, fetchF(c), out, vec4f(0.0,0.0,0.0,b.w))) { markBrick(brickId(c >> vec3u(2u))); }
      } } }
    } else {
      // Preserve the original 16-cell deck and material-only removal semantics.
      for (var z = 0; z < 4; z++) { for (var x = 0; x < 4; x++) {
        let c = P.at + vec3i(x,0,z);
        if (!inGrid(c)) { continue; }
        let a = fetchA(c); let b = fetchB(c);
        if (P.mode == 2u && eid(a) != P.material) { continue; }
        ownLegacy(slotOf(c));
        let id = select(P.material, E_EMPTY, P.mode == 2u);
        let out = vec4f(f32(id), airT(), 0.0, fract(a.w));
        if (writeCell(c, a, b, fetchF(c), out, vec4f(0.0,0.0,0.0,b.w))) { markBrick(brickId(c >> vec3u(2u))); }
      } }
      // Only explicitly constructed pumps receive this owned tungsten plate.
      // Legacy registrations are not healed; demolition claims only our tagged cells.
      if (P.pump != 0u) {
        for (var y = 1; y <= 6; y++) { for (var x = 0; x < 4; x++) {
          let r = rotateLocal(x, 3);
          let c = P.at + vec3i(r.x, y, r.y);
          if (!inGrid(c)) { continue; }
          let a = fetchA(c); let b = fetchB(c);
          let owned = eid(a) == E_TUNGSTEN && a.z == INDUSTRY_PUMP_BACKPLATE_TAG;
          if (P.mode == 2u && !owned) { continue; }
          ownLegacy(slotOf(c));
          let id = select(E_TUNGSTEN, E_EMPTY, P.mode == 2u);
          let marker = select(INDUSTRY_PUMP_BACKPLATE_TAG, 0.0, P.mode == 2u);
          let out = vec4f(f32(id), airT(), marker, fract(a.w));
          if (writeCell(c, a, b, fetchF(c), out, vec4f(0.0,0.0,0.0,b.w))) { markBrick(brickId(c >> vec3u(2u))); }
        } }
      }
    }
  }
  ringOut[P.slot] = vec4f(select(0.0, 1.0, clear || P.mode == 2u), 0.0, 0.0, 0.0);
}`;

export function createConstruction(app) {
  const sim = app.sim, gpu = app.gpu;
  const layout = gpu.layout('industry construction result', RING_LAYOUT);
  const ring = gpu.readback.ring('industry construction', 16, 8);
  const group = gpu.bindGroup(layout, [{ binding: 0, resource: { buffer: ring.buffer } }], 'industry construction result');
  const kernel = gpu.kernel({ name: 'industryConstruction', code: constructionWGSL(sim.g), params: Params,
    layouts: [sim.L.TABLES, sim.L.STATE_RW, layout], workgroupSize: [1, 1, 1] });
  return {
    ready: kernel.ready,
    async run(d, mode) {
      await kernel.ready;
      if (app.sim !== sim || sim.disposed) return false;
      const slot = ring.next();
      sim._dispatch(kernel, [1, 1, 1], { bind: [sim.tables, sim.bindRW, group], header: sim.header(),
        params: { at: [d.x, d.y, d.z], material: baseMaterial(d.type), mode, slot, height: deviceHeight(d),
          hearth: d.type === 'hearth' ? 1 : 0, pump: d.type === 'pump' ? 1 : 0, rotation: d.rotation } });
      if (mode) { sim.version++; sim.wake(); }
      app.requestRender();
      // Also works on an explicitly parked test page, without a frame pump.
      gpu.flush('industry construction');
      return new Float32Array(await ring.read(slot))[0] === 1;
    },
  };
}

export const WGSL_CHECK = [{ name: 'industryConstruction', kind: 'compute', code: constructionWGSL,
  layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, RING_LAYOUT], dispatch: () => [1, 1, 1] }];

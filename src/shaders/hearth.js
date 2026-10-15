import { E } from '../elements.js';
import {
  HEARTH_ENERGY_PER_LIFE, HEARTH_IGNITION_TARGET, HEARTH_IGNITION_TEMPERATURE,
  HEARTH_LAYOUT, HEARTH_MAX_FUEL_TEMPERATURE, HEARTH_MAX_STEP_SECONDS,
  HEARTH_STEPS_PER_SECOND,
} from '../industry/hearth.js';

// This fragment has no new uniforms. The caller supplies existing Industry
// corner/right/forward/dt fields and calls it only after machineEnabled's base
// and control guard succeeds. It layers a paid, local forced-draft firebox on
// physical fuel life; TPT still owns all native melting/cooling transitions.
const f32 = n => Number.isInteger(n) ? `${n}.0` : String(n);
const regionWGSL = (name, r) => `fn ${name}(x: f32, y: f32, z: f32) -> bool {
  return x >= ${f32(r.x[0])} && x <= ${f32(r.x[1])}
    && y >= ${f32(r.y[0])} && y <= ${f32(r.y[1])}
    && z >= ${f32(r.z[0])} && z <= ${f32(r.z[1])};
}`;
export const HEARTH_UNIFORM_FIELDS = Object.freeze({});
export const hearthUpdateWGSL = /* wgsl */ `
const HEARTH_IGNITION_T: f32 = ${f32(HEARTH_IGNITION_TEMPERATURE)};
const HEARTH_IGNITION_TARGET_T: f32 = ${f32(HEARTH_IGNITION_TARGET)};
const HEARTH_ENERGY_PER_LIFE: f32 = ${f32(HEARTH_ENERGY_PER_LIFE)};
const HEARTH_SOURCE_MAX_T: f32 = ${f32(HEARTH_MAX_FUEL_TEMPERATURE)};
const HEARTH_STEPS_PER_SECOND: f32 = ${f32(HEARTH_STEPS_PER_SECOND)};
const HEARTH_MAX_STEP_SECONDS: f32 = ${f32(HEARTH_MAX_STEP_SECONDS)};

${regionWGSL('hearthFuelCell', HEARTH_LAYOUT.firebox)}
${regionWGSL('hearthChargeCell', HEARTH_LAYOUT.charge)}
${regionWGSL('hearthOutletCell', HEARTH_LAYOUT.outlet)}
fn hearthFinite(value: f32) -> bool {
  return value == value && abs(value) < 1.0e30;
}

// Call only for this hearth after the existing Industry base/control guard.
// Each firing cell consumes its own saved life and heats only itself; native
// conduction carries that finite budget into the charge. There is no recipe
// counter, no remote heat grant, and no SCRAP→LAVA shortcut.
fn hearthUpdate(p: vec3i, a: vec4f, b: vec4f, corner: vec3i, right: vec3i,
    forward: vec3i, dt: f32, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let rel = p - corner;
  let x = dot(vec3f(rel), vec3f(right));
  let y = f32(rel.y);
  let z = dot(vec3f(rel), vec3f(forward));
  let id = eid(a);
  if (hearthFuelCell(x, y, z) && (id == E_COAL || id == E_BROKENCOAL)
      && dt > 0.0 && hearthFinite(dt) && hearthFinite(a.y) && hearthFinite(a.z) && a.z > 0.0) {
    let cap = CAP(id);
    if (cap > 0.0 && hearthFinite(cap)) {
      var consumed = 0.0;
      if (a.y < HEARTH_IGNITION_T) {
        // The paid starter reaches above native conduction loss, so it can
        // transition into the ordinary paid burn branch on the next step.
        let sparkEnergy = (HEARTH_IGNITION_TARGET_T - a.y) * cap;
        consumed = min(a.z, sparkEnergy / HEARTH_ENERGY_PER_LIFE);
      } else {
        consumed = min(a.z, BURNRATE(id) * HEARTH_STEPS_PER_SECOND * min(dt, HEARTH_MAX_STEP_SECONDS));
      }
      let budget = consumed * HEARTH_ENERGY_PER_LIFE;
      let headroom = max(0.0, (HEARTH_SOURCE_MAX_T - a.y) * cap);
      let applied = min(budget, headroom);
      // Native combustion already spends fuel; charge only for the extra heat delivered.
      if (applied < budget) { consumed = applied / HEARTH_ENERGY_PER_LIFE; }
      (*oA).y = a.y + applied / cap;
      (*oA).z = max(0.0, a.z - consumed);
    }
  }
  // TPT's native phase rules make LAVA. This only points existing melt toward
  // the buildable +forward spout/outlet; it never changes a charge's element.
  if (id == E_LAVA && (hearthChargeCell(x, y, z) || hearthOutletCell(x, y, z))) {
    *oB = vec4f(vec3f(forward) * 0.3 + vec3f(0.0, max(b.y, 0.0), 0.0), b.w);
  }
}
`;

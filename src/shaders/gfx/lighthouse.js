import { LIGHTHOUSE } from '../../gfx/lighthouseMath.js';
import { glf } from '../../glsl.js';

// One directional local light, using the current renderer's falloff and DDA.
// It creates neither density nor an overlay. Only real surfaces/media call it.
export const lighthouseGLSL = ({ far = false } = {}) => /* wgsl */ `
fn beaconPosition() -> vec3f { return FU.beacon.xyz - vec3f(H.origin); }
fn beaconPower(p: vec3f) -> vec3f {
  if (FU.beaconDir.w <= 0.0 || FU.beacon.w <= 0.0) { return vec3f(0.0); }
  let dv = p - beaconPosition();
  let d2 = dot(dv, dv);
  if (d2 >= FU.beacon.w * FU.beacon.w || d2 < 4.0) { return vec3f(0.0); }
  let cone = smoothstep(${glf(LIGHTHOUSE.outer)}, ${glf(LIGHTHOUSE.inner)}, dot(dv * inverseSqrt(d2), FU.beaconDir.xyz));
  if (cone <= 0.0) { return vec3f(0.0); }
  let cell = vec3i(FU.beaconCell.xyz) - H.origin;
  if (inGrid(cell)) {
    if (eid(fetchA(cell)) != E_CRYSTAL) { return vec3f(0.0); }
  }
  return vec3f(${LIGHTHOUSE.color.map(glf).join(', ')}) * (${glf(LIGHTHOUSE.intensity)} * FU.beaconDir.w * cone * lampFall(d2, FU.beacon.w, ${glf(LIGHTHOUSE.radius)}));
}
fn beaconVisible(p: vec3f) -> bool {
  let dv = beaconPosition() - p;
  let d = length(dv);
  let rd = safeDir(dv / max(d, 1e-4));
  // The lens/crystal is transparent; stop short of the emitter itself.
  let end = max(d - 2.0, 0.0);
  let hit = boxHit(p, rd);
  let a = max(hit.x, 0.0);
  let b = min(hit.y, end);
  if (b > a + 0.002) {
    var hc: vec3i;
    var hn: vec3f;
    // Same DDA as local lamps, but a lighthouse crosses the whole window.
    // A ray crosses at most NX+NY+NZ faces; no whole-world voxel march.
    if (traceNearSteps(p + rd * (a + 0.001), rd, b - a - 0.002, true, LAMP_SELF_SKIP, NX + NY + NZ + 3, &hc, &hn) >= 0.0) { return false; }
  }
  ${far ? `if (FU.far != 0u) {
    // Actual far occupancy, not generated terrain/scenery. Bounded coarse
    // shadow: narrow distant walls can fall between samples. The far field
    // is smoothed over 8 cells, so avoid receiver/emitter self-shadow there.
    var dims = vec3i(textureDimensions(tFarGrid));
    if (FU.sourceAppearance.y > 0u) { dims.y = i32(FU.sourceAppearance.x); }
    for (var i = 0; i < ${LIGHTHOUSE.farSamples}; i++) {
      let t = mix(8.0, max(d - 8.0, 8.0), (f32(i) + 0.5) / ${glf(LIGHTHOUSE.farSamples)});
      if (t >= end) { break; }
      let q = p + rd * t;
      if (inGrid(vec3i(floor(q)))) { continue; }
      let bc = vec3i(floor((q + vec3f(H.origin)) / f32(BS)));
      if (any(bc < vec3i(0)) || any(bc >= dims)) { continue; }
      let packed = textureLoad(tFarGrid, bc, 0);
      if ((packed.r & 255u) >= 128u) { return false; }
    }
  }` : ''}
  return true;
}
fn beaconIrradiance(p: vec3f) -> vec3f {
  let power = beaconPower(p);
  // Cull daylight, darkness, range and cone BEFORE tracing/sampling.
  if (max(power.r, max(power.g, power.b)) <= 0.0) { return vec3f(0.0); }
  if (!beaconVisible(p)) { return vec3f(0.0); }
  return power;
}
fn beaconDiffuse(p: vec3f, ng: vec3f, n: vec3f) -> vec3f {
  let ro = p + ng * LAMP_START;
  let dv = beaconPosition() - ro;
  let nl = max(dot(n, dv) * inverseSqrt(max(dot(dv, dv), 1e-8)), 0.0);
  if (nl <= 0.0) { return vec3f(0.0); }
  return beaconIrradiance(ro) * nl;
}
`;

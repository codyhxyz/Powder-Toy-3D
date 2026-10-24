import { LIGHTHOUSE } from '../../gfx/lighthouseMath.js';
import { glf } from '../../glsl.js';

// One directional local light, using the current renderer's falloff and DDA.
// It creates neither density nor an overlay. Only real surfaces/media call it.
export const lighthouseGLSL = () => /* wgsl */ `
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
// The beam's shadow ray from p: the window's stretch of the line to the
// emitter, stopping short of it (the lens/crystal is transparent). trace:
// whether there is a stretch to march (else the window has nothing between).
// lampShade marches it from its lamps' traceNearSteps call site, beaconVisible
// from its own: Metal inlines every call, and each copy of the march cost
// the World volume ~0.3 s of its cold build (2026-10-21).
struct BeaconRay { o: vec3f, d: vec3f, len: f32, trace: bool }
// Same DDA as local lamps, but a lighthouse crosses the whole window.
// A ray crosses at most NX+NY+NZ faces; no whole-world voxel march. A
// function, not a const: the World view reads NX..NZ at run time
// (common.js WORLD_RUNTIME_GRID), and a const can't hold those.
fn beaconMaxSteps() -> i32 { return NX + NY + NZ + 3; }
fn beaconRay(p: vec3f) -> BeaconRay {
  let dv = beaconPosition() - p;
  let d = length(dv);
  let rd = safeDir(dv / max(d, 1e-4));
  let end = max(d - 2.0, 0.0);
  let hit = boxHit(p, rd);
  let a = max(hit.x, 0.0);
  let b = min(hit.y, end);
  return BeaconRay(p + rd * (a + 0.001), rd, b - a - 0.002, b > a + 0.002);
}
fn beaconVisible(p: vec3f) -> bool {
  let r = beaconRay(p);
  var hc: vec3i;
  var hn: vec3f;
  return !r.trace || !(traceNearSteps(r.o, r.d, r.len, true, LAMP_SELF_SKIP, beaconMaxSteps(), &hc, &hn) >= 0.0);
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

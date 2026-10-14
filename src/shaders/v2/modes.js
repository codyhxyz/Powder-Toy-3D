// Shared native per-dispatch modes. P must include MODE_FIELDS; coordinates are
// local cells, force is m/s². TPT radial gravity has constant magnitude.
export const modeWGSL = /* wgsl */ `
fn mEdge(p: vec3i) -> vec3i {
  if (P.edge == 2u) { let n=vec3i(NX,NY,NZ); return ((p%n)+n)%n; }
  return p;
}
fn mGravity(p: vec3f) -> vec3f {
  if (P.gravMode == 1u || P.gravity == 0.0) { return vec3f(0); }
  if (P.gravMode == 0u) { return vec3f(0,-P.gravity,0); }
  let d=0.5*vec3f(f32(NX),f32(NY),f32(NZ))-p;
  if (dot(d,d)==0.0) { return vec3f(0); }
  return normalize(d)*P.gravity;
}
fn mPotential(p: vec3f) -> f32 {
  if (P.gravMode == 1u) { return 0.0; }
  if (P.gravMode == 2u) { return length(p-0.5*vec3f(f32(NX),f32(NY),f32(NZ)))*P.gravity/19.6; }
  return p.y*P.gravity/19.6;
}
// Oriented local face potential difference. A periodic seam is adjacent, not
// an artificial height jump of NY cells in uniform vertical gravity.
fn mFaceDrive(p: vec3i, axis: i32) -> f32 {
  var d=vec3f(0); d[axis]=1.0;
  if (P.gravMode != 2u) { return mGravity(vec3f(p)+0.5)[axis]/19.6; }
  return mPotential(vec3f(p)+0.5)-mPotential(vec3f(mEdge(p+vec3i(d)))+0.5);
}
fn mDown(p: vec3f) -> vec3i {
  let g=mGravity(p); let a=abs(g); var axis=1u;
  if (a.x>a.y && a.x>=a.z) { axis=0u; }
  if (a.z>a.y && a.z>a.x) { axis=2u; }
  var d=vec3i(0); d[axis]=i32(sign(g[axis])); return d;
}
// Rotate a 2³ partition internally (a bijection). This never rotates its
// ownership, so neighbouring radial blocks cannot race or overlap.
fn mBlockOffset(o: vec3i, down: vec3i) -> vec3i {
  var p=o;
  if (down.x!=0) { p=vec3i(o.y,o.x,o.z); if (down.x>0) { p.x=1-p.x; } }
  else if (down.z!=0) { p=vec3i(o.x,o.z,o.y); if (down.z>0) { p.z=1-p.z; } }
  else if (down.y>0) { p.y=1-p.y; }
  return p;
}
fn mAirVelocity() -> bool { return P.airMode==0u || P.airMode==1u || P.airMode==4u; }
fn mAirPressure() -> bool { return P.airMode==0u || P.airMode==2u || P.airMode==4u; }
fn mAirHeat() -> bool { return P.ambientHeat!=0u; }
`;

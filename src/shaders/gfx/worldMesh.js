// Opaque-only capture. Never accept a proxy depth for glass/alpha/liquid.
export const worldMeshCutWGSL = /* wgsl */ `
fn meshDepthHere() -> f32 {
  let hi=vec2i(textureDimensions(worldPackedMesh))-1;
  let mesh=worldMeshAt(clamp(vec2i(floor(gFragCoord)),vec2i(0),hi));
  return select(1.0,mesh.depth,(mesh.coverageFlags&1u)!=0u);
}
fn meshCutT(rd: vec3f) -> f32 {
  if (P.meshCut==0u) { return MESH_CUT_NONE; }
  return meshCutAt(meshDepthHere(),P.meshInv,P.meshRes,rd);
}
fn meshCutDepth(d: f32) -> f32 {
  if (P.meshCut==0u) { return d; }
  return min(d,meshDepthHere());
}
`;

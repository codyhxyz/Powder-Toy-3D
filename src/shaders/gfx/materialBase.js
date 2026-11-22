// Opaque material record and table defaults shared by the march and raster shaders.
export const matBaseWGSL = /* wgsl */ `
struct Mat {
  alb: vec3f,     // diffuse albedo (dielectrics) or F0 (metals)
  g: vec3f,       // gradient of the bump height, grid units (perturbs the normal)
  emit: vec3f,
  tang: vec3f,
  sssCol: vec3f,
  rough: f32, metal: f32, f0: f32, sss: f32, glint: f32, glintDens: f32, cav: f32, aniso: f32, trans: f32,
  slopeVar: f32,  // the bump's slope variance a pixel covers but can't show, per axis (specular AA: aaRough)
  sourceNormal: vec3f, sourceKind: u32, sourceFlags: u32,
}
// Element id's table values, untextured and not glowing.
fn matBase(id: i32) -> Mat {
  var m: Mat;
  m.alb = ALBEDO(id); m.g = vec3f(0.0); m.tang = vec3f(1.0, 0.0, 0.0); m.sssCol = vec3f(1.0);
  m.rough = ROUGH(id); m.metal = METAL(id);
  m.f0 = (IOR(id) - 1.0) / (IOR(id) + 1.0); m.f0 *= m.f0;
  m.sss = SSS(id); m.glint = GLINT(id); m.glintDens = 1.0; m.cav = 1.0; m.aniso = 0.0; m.trans = 0.0;
  m.emit = vec3f(0.0);
  return m;
}
const WOOD_TOP_EDGE: vec2f = vec2f(0.6, 0.9);   // |n.y| range over which a face turns into end grain
fn woodEndGrain(n: vec3f) -> f32 { return smoothstep(WOOD_TOP_EDGE.x, WOOD_TOP_EDGE.y, abs(n.y)); }
`;

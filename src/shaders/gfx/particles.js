// Particles: cells of a smooth channel that are too isolated to form a
// surface (airborne grains, droplets, spray) are drawn as explicit shapes.
export const particlesGLSL = /* glsl */ `
// Intersect the particle in cell (element id, channel ch, state a) with the
// ray, for t in [tMin, tMaxv). Returns the hit distance, normal and chord
// length through the particle (used for absorption in droplets).
bool particleHit(ivec3 cell, int id, int ch, vec4 a, vec3 ro, vec3 rd, float tMin, float tMaxv,
                 out float t, out vec3 n, out float chord) {
  t = 0.0; n = vec3(0.0); chord = 0.0;
  vec3 c = vec3(cell) + 0.5 + (hash33(vec3(cell) * 1.37 + fract(a.w) * 91.0) - 0.5) * 0.12;
  float r = ch == CH_LIQUID ? 0.42 : 0.4;
  vec3 oc = ro - c;
  float b = dot(oc, rd), h = b * b - dot(oc, oc) + r * r;
  if (h <= 0.0) return false;
  float sq = sqrt(h);
  t = -b - sq;
  if (t < tMin || t >= tMaxv) return false;
  n = normalize(ro + rd * t - c);
  chord = 2.0 * sq;
  return true;
}
`;

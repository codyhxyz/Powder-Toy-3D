// Participating media: smoke, steam and fire as continuous density volumes
// (from the blurred media fields), plus hot air in the heat view.
export const mediaGLSL = /* glsl */ `
// Heat shimmer: hot air has a lower refractive index, so rays bend. Returns
// the (possibly perturbed) primary ray direction for the box span [t0, t1].
vec3 hazeBend(vec3 ro, vec3 rd, float t0, float t1) {
  return rd;
}

// Integrate the media over the ray segment [ta, tb] with one jittered sample
// (TAA averages the jitter). Returns the opacity added, for depth decisions.
float mediaSegment(vec3 ro, vec3 rd, float ta, float tb, float jit, inout vec3 col, inout vec3 trans) {
  float seg = tb - ta;
  if (seg <= 1e-4) return 0.0;
  vec3 p = ro + rd * (ta + seg * jit);
  vec4 m = mediaField(p);
  float T = AMBIENT + m.w * HEAT_RANGE;
  float sS = SIGMA[E_SMOKE].x * 2.5 * m.x, sT = SIGMA[E_STEAM].x * 2.5 * m.y;
  float sig = sS + sT;
  float alpha = 1.0 - exp(-sig * seg);
  if (alpha > 1e-4) {
    vec3 alb = (COLOR[E_SMOKE] * sS + COLOR[E_STEAM] * sT) / sig;
    vec3 sunVis = uShadows ? sunShadow(p) : vec3(1.0);
    vec3 light = vec3(0.3, 0.34, 0.4) + SUN_COL * 0.6 * sunVis + sampleLight(p) * uLightGain;
    col += trans * alpha * alb * light;
  }
  // flames: blackbody emission of the local gas temperature
  if (m.z > 1e-3) {
    vec3 e = blackbody(T) * pow(T / 1000.0, 2.0) * m.z * 2.2;
    col += trans * e * seg;
  }
  trans *= (1.0 - alpha) * exp(-0.12 * m.z * seg);
  return alpha + m.z * 0.2;
}
`;

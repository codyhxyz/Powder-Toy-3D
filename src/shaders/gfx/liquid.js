// Transparent media: liquids (smooth surfaces) and crisp glass.
export const liquidGLSL = /* glsl */ `
float fresnelSchlick(float cosi, float ior) {
  float f0 = (1.0 - ior) / (1.0 + ior);
  f0 *= f0;
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosi, 0.0, 1.0), 5.0);
}

// Radiance arriving along reflected direction r at an interface at p.
vec3 envReflect(vec3 p, vec3 r, vec3 sunVis) {
  return skyColor(r) + SUN_COL * sunVis * pow(max(dot(r, uSun), 0.0), 400.0) * 6.0;
}

// Light scattered toward the eye inside a liquid/glass, per unit (1 - transmittance).
vec3 interiorScatter(int id, vec3 p, vec3 sunVis, float T) {
  vec3 amb = vec3(0.3, 0.35, 0.42) + SUN_COL * sunVis * max(uSun.y, 0.0) * 0.6 + sampleLight(p) * uLightGain;
  return COLOR[id] * amb * (RCLASS[id] == R_GLASS ? 0.15 : 0.55) + incandescence(T);
}

// Beer–Lambert through a segment of length seg inside element id.
void absorbSegment(int id, vec3 p, float seg, vec3 sunVis, float T, inout vec3 col, inout vec3 trans) {
  vec3 att = exp(-SIGMA[id] * seg);
  col += trans * (1.0 - att) * interiorScatter(id, p, sunVis, T);
  trans *= att;
}

// Which liquid is at p (the cell itself, else a neighbour), for absorption.
int liquidIdAt(vec3 p, int fallback) {
  ivec3 c = ivec3(floor(p));
  for (int i = 0; i < 7; i++) {
    ivec3 q = c;
    if (i > 0) q[(i - 1) >> 1] += ((i & 1) == 1) ? -1 : 1;
    if (outside(q)) continue;
    int id = eid(cellA(q));
    if (SURFCH[id] == CH_LIQUID) return id;
  }
  return fallback;
}

// Refraction at a smooth liquid surface. n = outward normal of the liquid.
// Updates the ray (restarting just past the interface) and returns true if
// the ray now travels inside the liquid (entering, or total internal reflection).
bool liquidInterface(vec3 hp, vec3 n, bool entering, int id, inout vec3 ro, inout vec3 rd,
                     inout vec3 col, inout vec3 trans, inout vec3 mediumLight) {
  float ior = IOR[id];
  if (entering) {
    if (dot(n, rd) > 0.0) n = -n;
    float F = fresnelSchlick(-dot(n, rd), ior);
    mediumLight = uShadows ? sunShadow(hp + n * 0.5) : vec3(1.0);
    col += trans * F * envReflect(hp, reflect(rd, n), mediumLight);
    trans *= 1.0 - F;
    rd = refract(rd, n, 1.0 / ior);
    ro = hp + rd * 0.03;
    return true;
  }
  if (dot(n, rd) < 0.0) n = -n;
  vec3 rt = refract(rd, -n, ior);
  if (dot(rt, rt) < 1e-6) {           // total internal reflection
    rd = reflect(rd, -n);
    ro = hp + rd * 0.03;
    return true;
  }
  trans *= 1.0 - fresnelSchlick(dot(rt, n), ior);
  rd = rt;
  ro = hp + rd * 0.03;
  return false;
}
`;

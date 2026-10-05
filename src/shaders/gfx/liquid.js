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

// Light scattered toward the eye inside a liquid or glass, per unit
// (1 - transmittance): the scattered share of the extinction (SCATALB) of the
// light arriving at p. sunVis is the sun's visibility there, including its
// fade through the liquid above (the tracer refreshes it with depth); sky
// light fades the same way, but never below a floor, so shaded liquid
// still shows its body colour.
#define SKY_IN_FLOOR 0.25   // share of the sky light that reaches liquid in shade
#define SUN_IN_GAIN 0.6     // sunlight scattered per unit of sun elevation
vec3 interiorScatter(int id, vec3 p, vec3 sunVis, float T) {
  vec3 L = skyAmbient(vec3(0.0, 1.0, 0.0)) * mix(vec3(SKY_IN_FLOOR), vec3(1.0), sunVis)
         + SUN_COL * sunVis * max(uSun.y, 0.0) * SUN_IN_GAIN + sampleLight(p) * uLightGain;
  return SCATALB[id] * L + incandescence(T);
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

// Wind ripples on open liquid: a slowly drifting two-octave value-noise
// height field tilts the normal of upward-facing surfaces by a few degrees
// (the surface itself doesn't move), breaking up an otherwise perfect mirror
// of the sky. Fades out before it would alias.
#define RIPPLE_FREQ 0.3        // cycles per cell, first octave
#define RIPPLE_SLOPE 0.05      // height-field slope per unit noise gradient
#define RIPPLE_DRIFT 0.6       // noise-space speed, per second
#define RIPPLE_UP_LO 0.6       // n.y where ripples start ...
#define RIPPLE_UP_HI 0.9       // ... and reach full strength
#define RIPPLE_EPS 0.1         // finite-difference step, noise space
#define RIPPLE_OCT2 2.1        // second octave: frequency multiple (half the height) ...
#define RIPPLE_OCT2_DRIFT 1.3  // ... drift multiple ...
#define RIPPLE_OCT2_SHIFT 7.3  // ... and offset, so it doesn't line up with the first
#define RIPPLE_LOD_LO 0.25     // finer octave's cycles per pixel where ripples start to fade ...
#define RIPPLE_LOD_HI 0.6      // ... and where they're gone
float rippleH(vec2 q, float t) {
  return vnoise(vec3(q, t)) + 0.5 * vnoise(vec3(q * RIPPLE_OCT2 + RIPPLE_OCT2_SHIFT, t * RIPPLE_OCT2_DRIFT));
}
vec3 liquidRipple(vec3 p, vec3 n) {
  float k = smoothstep(RIPPLE_UP_LO, RIPPLE_UP_HI, n.y)
          * (1.0 - smoothstep(RIPPLE_LOD_LO, RIPPLE_LOD_HI, footprint(p) * RIPPLE_FREQ * RIPPLE_OCT2));
  if (k <= 0.0) return n;
  vec2 q = p.xz * RIPPLE_FREQ;
  float t = uTime * RIPPLE_DRIFT;
  float h = rippleH(q, t);
  vec2 g = vec2(rippleH(q + vec2(RIPPLE_EPS, 0.0), t) - h, rippleH(q + vec2(0.0, RIPPLE_EPS), t) - h) / RIPPLE_EPS;
  return normalize(n - vec3(g.x, 0.0, g.y) * RIPPLE_SLOPE * k);
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

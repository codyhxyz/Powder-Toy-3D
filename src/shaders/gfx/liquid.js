// Transparent media: liquids (smooth surfaces) and crisp glass.
export const liquidGLSL = /* glsl */ `
float fresnelSchlick(float cosi, float ior) {
  float f0 = (1.0 - ior) / (1.0 + ior);
  f0 *= f0;
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosi, 0.0, 1.0), 5.0);
}

// Radiance arriving along reflected direction r at an interface at p: the sky
// plus the sun's highlight (a tight lobe standing in for the sun's disc).
#define SUN_GLINT_EXP 400.0   // sharpness of the highlight lobe
#define SUN_GLINT_GAIN 6.0    // its peak, relative to the sun's colour
vec3 envReflect(vec3 p, vec3 r, vec3 sunVis) {
  return skyColor(r) + SUN_COL * sunVis * pow(max(dot(r, uSun), 0.0), SUN_GLINT_EXP) * SUN_GLINT_GAIN;
}

// Offsets off a transparent interface (cells): a ray restarts IFACE_NUDGE past
// it, and the sun's visibility and which liquid is there are read IFACE_PROBE
// to either side (half a cell: clear of the surface, still in its cell).
#define IFACE_NUDGE 0.03
#define IFACE_PROBE 0.5

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
#define LIQ_ID_PROBES 7   // cells tried: p's own, then its 6 face neighbours
int liquidIdAt(vec3 p, int fallback) {
  ivec3 c = ivec3(floor(p));
  for (int i = 0; i < LIQ_ID_PROBES; i++) {
    ivec3 q = c;
    if (i > 0) q[(i - 1) >> 1] += ((i & 1) == 1) ? -1 : 1;
    if (outside(q)) continue;
    int id = eid(fetchA(q));
    if (SURFCH[id] == CH_LIQUID) return id;
  }
  return fallback;
}

// Wind ripples on open liquid: a slowly drifting two-octave value-noise
// height field tilts the normal of upward-facing surfaces by a few degrees
// (the surface itself doesn't move), breaking up an otherwise perfect mirror
// of the sky. Fades out before it would alias.
#define RIPPLE_FREQ 0.3        // cycles per cell, first octave
#define RIPPLE_SLOPE 0.035     // height-field slope per unit noise gradient
#define RIPPLE_DRIFT 0.6       // noise-space speed, per second
#define RIPPLE_UP_LO 0.6       // n.y where ripples start ...
#define RIPPLE_UP_HI 0.9       // ... and reach full strength
#define RIPPLE_EPS 0.1         // finite-difference step, noise space
#define RIPPLE_OCT2 2.1        // second octave: frequency multiple ...
#define RIPPLE_OCT2_AMP 0.5    // ... height multiple ...
#define RIPPLE_OCT2_DRIFT 1.3  // ... drift multiple ...
#define RIPPLE_OCT2_SHIFT 7.3  // ... and offset, so it doesn't line up with the first
#define RIPPLE_LOD_LO 0.25     // finer octave's cycles per pixel where ripples start to fade ...
#define RIPPLE_LOD_HI 0.6      // ... and where they're gone
float rippleH(vec2 q, float t) {
  return vnoise(vec3(q, t)) + RIPPLE_OCT2_AMP * vnoise(vec3(q * RIPPLE_OCT2 + RIPPLE_OCT2_SHIFT, t * RIPPLE_OCT2_DRIFT));
}
vec3 liquidRipple(vec3 p, vec3 n) {
  float k = smoothstep(RIPPLE_UP_LO, RIPPLE_UP_HI, n.y)
          * (1.0 - smoothstep(RIPPLE_LOD_LO, RIPPLE_LOD_HI, footprint(p) * RIPPLE_FREQ * RIPPLE_OCT2));
  if (k <= 0.0) return n;
  vec2 q = worldPos(p).xz * RIPPLE_FREQ;   // anchored in the world
  float t = uTime * RIPPLE_DRIFT;
  float h = rippleH(q, t);
  vec2 g = vec2(rippleH(q + vec2(RIPPLE_EPS, 0.0), t) - h, rippleH(q + vec2(0.0, RIPPLE_EPS), t) - h) / RIPPLE_EPS;
  return normalize(n - vec3(g.x, 0.0, g.y) * RIPPLE_SLOPE * k);
}

// ---- reflections of the scene ----
// Where a liquid surface reflects a lot (grazing views: Fresnel climbs fast
// past ~60°), the reflected ray is traced through the grid to the first
// opaque thing (crisp voxels, opaque smooth surfaces, the floor); liquids,
// glass and media along it are skipped. Elsewhere the sky stands in, which is
// mostly what such a surface shows. Blended over a Fresnel range so the
// switch doesn't show.
#define REFL_F_LO 0.04      // Fresnel reflectance where traced reflections start ...
#define REFL_F_HI 0.1       // ... and take over
#define REFL_MAX_STEPS 32   // DDA steps (cells or skipped bricks) before falling back to the sky
#define REFL_START 0.05     // start offset off the surface, cells
#define REFL_PROBE 0.5      // a smooth hit's element is looked up this far inside it, then twice that
#define REFL_NORMAL_STEP 0.5   // forward-difference step of a reflected smooth hit's normal, cells
// What the reflection shows of a hit: the element's albedo lit by the sun
// (facing only, no cast shadows) and the sky, plus its own glow when hot.
// Reflections are dimmed by Fresnel and wobbled by ripples, so texture
// detail, shadows, AO and the glow it receives wouldn't show for the cost.
vec3 reflShade(vec4 a, vec3 n) {
  int id = eid(a);
  return ALBEDO[id] * (SUN_COL * max(dot(n, uSun), 0.0) + skyAmbient(n)) + incandescence(a.y);
}
vec3 reflectTrace(vec3 ro, vec3 rd, vec3 sunVis) {
  rd = safeDir(rd);
  ivec3 istp = ivec3(sign(rd));
  vec3 tDelta = abs(1.0 / rd);
  ivec3 cell = ivec3(floor(ro));
  vec3 tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  float tEnter = 0.0;
  int ax = 1;   // entry face axis: unknown in the start cell
  ivec3 lastB = ivec3(-1);
  int flags = 0;
  vec4 phiA = surfField(ro);
  bool stale = false;
  for (int i = 0; i < REFL_MAX_STEPS; i++) {
    if (outside(cell)) break;
    ivec3 bc = cell / BS;
    if (bc != lastB) { lastB = bc; flags = brickInfo(bc); }
    // only bricks with something opaque can stop it
    if (!brickOpaque(flags)) {
      // an empty brick may sit in a larger empty region: cross all of it
      ax = flags == 0 ? skipEmpty(bc, ro, rd, istp, cell, tMax, tEnter) : skipBrick(bc, ro, rd, istp, cell, tMax, tEnter);
      stale = true;
      continue;
    }
    float tExit = min(tMax.x, min(tMax.y, tMax.z));
    vec4 a = fetchA(cell);
    int id = eid(a);
    if (isCrisp(id)) {
      if (RCLASS[id] != R_GLASS) {
        vec3 nh = vec3(0.0);
        nh[ax] = -float(istp[ax]);
        float th = tEnter;
        if (crispHit(cell, id, ro, rd, tEnter, tExit, th, nh)) return reflShade(a, nh);
      }
      stale = true;
    } else if (brickSurf(flags)) {
      if (stale) phiA = surfField(ro + rd * tEnter);
      vec4 phiB = surfField(ro + rd * tExit);
      float tOp = NO_HIT;
      int ch = -1;
      for (int c = 1; c < 4; c++) {
        float t = surfCross(ro, rd, c, true, tEnter, tExit, tExit, phiA[c], phiB[c], phiB[c]);
        if (t < tOp) { tOp = t; ch = c; }
      }
      if (ch > 0) {
        vec3 hp = ro + rd * tOp;
        // forward difference: the field is SURF_ISO at hp
        const vec2 e = vec2(REFL_NORMAL_STEP, 0.0);
        vec3 gr = vec3(surfField(hp + e.xyy)[ch], surfField(hp + e.yxy)[ch], surfField(hp + e.yyx)[ch]) - SURF_ISO;
        vec3 n = dot(gr, gr) > 1e-10 ? -normalize(gr) : -rd;
        ivec3 c1 = clamp(ivec3(floor(hp - n * REFL_PROBE)), ivec3(0), GRID - 1);
        vec4 ah = fetchA(c1);
        if (SURFCH[eid(ah)] != ch) ah = fetchA(clamp(ivec3(floor(hp - n * (2.0 * REFL_PROBE))), ivec3(0), GRID - 1));
        return reflShade(ah, n);
      }
      phiA = phiB;
      stale = false;
    } else {
      stale = true;
    }
    ax = argmin3(tMax);
    tEnter = tExit;
    cell[ax] += istp[ax];
    tMax[ax] += tDelta[ax];
  }
  if (cell.y < 0 && rd.y < 0.0) return shadeFloor(ro - rd * (ro.y / rd.y), rd);
  return envReflect(ro, rd, sunVis);
}

// Refraction at a smooth liquid surface. n = outward normal of the liquid.
// Updates the ray (restarting just past the interface) and returns true if
// the ray now travels inside the liquid (entering, or total internal reflection).
// mirror: trace the scene in the reflection (else the sky only).
bool liquidInterface(vec3 hp, vec3 n, bool entering, int id, bool mirror, inout vec3 ro, inout vec3 rd,
                     inout vec3 col, inout vec3 trans, inout vec3 mediumLight) {
  float ior = IOR[id];
  if (entering) {
    if (dot(n, rd) > 0.0) n = -n;
    float F = fresnelSchlick(-dot(n, rd), ior);
    mediumLight = uShadows ? sunShadow(hp + n * IFACE_PROBE) : vec3(1.0);
    vec3 r = reflect(rd, n);
    vec3 env = envReflect(hp, r, mediumLight);
    float wr = mirror ? smoothstep(REFL_F_LO, REFL_F_HI, F) : 0.0;
    if (wr > 0.0) env = mix(env, reflectTrace(hp + n * REFL_START, r, mediumLight), wr);
    col += trans * F * env;
    trans *= 1.0 - F;
    rd = refract(rd, n, 1.0 / ior);
    ro = hp + rd * IFACE_NUDGE;
    return true;
  }
  if (dot(n, rd) < 0.0) n = -n;
  vec3 rt = refract(rd, -n, ior);
  if (dot(rt, rt) < 1e-6) {           // total internal reflection
    rd = reflect(rd, -n);
    ro = hp + rd * IFACE_NUDGE;
    return true;
  }
  trans *= 1.0 - fresnelSchlick(dot(rt, n), ior);
  rd = rt;
  ro = hp + rd * IFACE_NUDGE;
  return false;
}
`;

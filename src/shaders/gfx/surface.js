// Opaque surfaces: per-element solid textures (world-space, so nothing
// reveals the grid), bevelled crisp voxels, and energy-conserving PBR shading.
//
// Pipeline for a hit: gatherSurf (smooth surfaces) or crispSurf (voxels and
// grains) builds a Surf from the material function matOf(); shadeSurf lights it.
export const surfaceGLSL = /* glsl */ `
uniform float uMatDetail;   // 1 = textured materials, 0 = flat albedo (A/B and fallback)
uniform float uBevel;       // crisp-voxel edge radius in cells (0 = sharp cubes)
uniform float uGlints;      // 1 = sun glints on grains

const float PI_S = 3.14159265;

struct Surf {
  vec3 p;       // hit point (grid units)
  vec3 n;       // shading normal (geometry + material bump)
  vec3 ng;      // geometric normal (field gradient / voxel face / bevel)
  int id;       // dominant element
  int ch;       // smooth channel, or -1 for a crisp voxel face
  ivec3 cell;   // dominant cell
  ivec3 face;   // axis-aligned face normal (crisp voxels, for faceAO)
  vec3 albedo;  // diffuse albedo, or F0 for metals
  float T;      // temperature, blended across cells
  float rough;
  float metal;
  float seed;   // per-cell random in [0, 1)
  float f0;     // dielectric normal-incidence reflectance (from the IOR)
  float sss;    // wrap / subsurface amount
  vec3 sssCol;  // tint of light that scattered deep (snow: blue)
  float glint;  // fraction of the sun's specular that arrives as glints
  float glintDens; // glint facets per cell
  float cav;    // cavity (micro) occlusion from the texture, 1 = open
  float aniso;  // brushed anisotropy along tang (0 = isotropic)
  vec3 tang;
  float trans;  // backlit translucency (leaves)
  vec3 emit;    // emitted radiance (incandescence)
};

// ---- view: set once per pixel by the tracer, in uniform control flow ----
vec3 gEye = vec3(0.0);
float gPixAng = 0.002;
void surfView(vec3 eye, vec3 rd) {
  gEye = eye;
  gPixAng = clamp(max(length(dFdx(rd)), length(dFdy(rd))), 1e-5, 0.05);
}
// size of a pixel at p, in grid units
float footprint(vec3 p) { return distance(p, gEye) * gPixAng; }
// weight of detail with spatial frequency f (cycles per cell): fades out
// before it would alias (Nyquist = 0.5 cycles per pixel)
float lodFade(float f, float fp) { return 1.0 - smoothstep(0.15, 0.4, f * fp); }

// ---- material noise (all world space; the lattice is rotated so it never lines up with the grid) ----
const mat3 M_ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

// Value noise with its analytic gradient: (value in [0, 1], d/dx, d/dy, d/dz).
vec4 mNoiseD(vec3 x) {
  vec3 i = floor(x), f = x - i;
  vec3 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), g = hash13(i + vec3(1, 0, 1)), h = hash13(i + vec3(0, 1, 1)), k = hash13(i + vec3(1, 1, 1));
  float k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d, k5 = a - c - e + h, k6 = a - b - e + g;
  float k7 = -a + b + c - d + e - g - h + k;
  return vec4(a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
              du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
                        k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
                        k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y));
}
// noise of q = J p, gradient with respect to p
vec4 mNoiseJ(vec3 p, mat3 J, vec3 off) {
  vec4 n = mNoiseD(J * p + off);
  return vec4(n.x, transpose(J) * n.yzw);
}

// fBm with gradient, centred on 0 (about ±0.45). Base frequency f cycles per
// cell; octaves finer than the pixel footprint fp fade out instead of aliasing.
vec4 mFbmD(vec3 p, float f, int oct, float fp) {
  vec4 s = vec4(0.0);
  float a = 0.5;
  mat3 J = M_ROT * f;
  for (int i = 0; i < 4; i++) {
    if (i >= oct) break;
    float lw = lodFade(f, fp);
    if (lw <= 0.0) break;
    vec4 n = mNoiseD(J * p + float(i) * 7.31);
    s += a * lw * vec4(n.x - 0.5, transpose(J) * n.yzw);
    J = M_ROT * J * 2.03;
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}

// Cellular (Worley) noise: (F1, distance to the border with the second
// nearest cell, two hashes of the nearest cell). ge = gradient of that border
// distance, r1 = vector to the nearest seed.
vec4 mCell(vec3 p, out vec3 ge, out vec3 r1) {
  vec3 i = floor(p), f = p - i;
  float d1 = 1e9, d2 = 1e9;
  vec3 s1 = vec3(0.0), s2 = vec3(1.0), c1 = vec3(0.0);
  for (int k = 0; k < 27; k++) {
    vec3 o = vec3(float(k % 3), float((k / 3) % 3), float(k / 9)) - 1.0;
    vec3 r = o + hash33(i + o) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; s2 = s1; d1 = d; s1 = r; c1 = i + o; }
    else if (d < d2) { d2 = d; s2 = r; }
  }
  vec3 u = normalize(s2 - s1 + 1e-6);
  ge = -u;
  r1 = s1;
  return vec4(sqrt(d1), dot(0.5 * (s1 + s2), u), hash13(c1 * 1.31 + 4.7), hash13(c1 * 0.71 + 9.2));
}

float dSmooth(float a, float b, float x) {   // derivative of smoothstep(a, b, x)
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return 6.0 * t * (1.0 - t) / (b - a);
}

// ---- materials ----
struct Mat {
  vec3 alb;     // diffuse albedo (dielectrics) or F0 (metals)
  vec3 g;       // gradient of the bump height, grid units (perturbs the normal)
  vec3 emit;
  vec3 tang;
  vec3 sssCol;
  float rough, metal, f0, sss, glint, glintDens, cav, aniso, trans;
};

Mat mixMat(Mat a, Mat b, float k) {
  a.alb = mix(a.alb, b.alb, k); a.g = mix(a.g, b.g, k); a.emit = mix(a.emit, b.emit, k);
  a.tang = mix(a.tang, b.tang, k); a.sssCol = mix(a.sssCol, b.sssCol, k);
  a.rough = mix(a.rough, b.rough, k); a.metal = mix(a.metal, b.metal, k); a.f0 = mix(a.f0, b.f0, k);
  a.sss = mix(a.sss, b.sss, k); a.glint = mix(a.glint, b.glint, k); a.glintDens = mix(a.glintDens, b.glintDens, k);
  a.cav = mix(a.cav, b.cav, k); a.aniso = mix(a.aniso, b.aniso, k); a.trans = mix(a.trans, b.trans, k);
  return a;
}

// Lava freezes back into its ctype at MELT - 150 °C (shaders/react.js).
float solidusOf(float ctype) {
  int ct = int(ctype);
  if (ct <= 0 || ct >= NE || MELT[ct] <= 0.0) ct = E_STONE;
  return MELT[ct] - 150.0;
}

// The look of element id at world point p (grid units) on a surface with
// normal n, temperature T (°C). fp = pixel footprint (grid units) for LOD.
Mat matOf(int id, vec3 p, vec3 n, float T, float ctype, float fp) {
  Mat m;
  m.alb = ALBEDO[id]; m.g = vec3(0.0); m.tang = vec3(1.0, 0.0, 0.0); m.sssCol = vec3(1.0);
  m.rough = ROUGH[id]; m.metal = METAL[id];
  m.f0 = (IOR[id] - 1.0) / (IOR[id] + 1.0); m.f0 *= m.f0;
  m.sss = SSS[id]; m.glint = GLINT[id]; m.glintDens = 3.0; m.cav = 1.0; m.aniso = 0.0; m.trans = 0.0;
  // anything hot glows (blackbody); lava does its own thing below
  m.emit = incandescence(T);
  if (uMatDetail < 0.5) return m;

  if (id == E_SAND) {
    vec4 lo = mFbmD(p, 0.3, 2, fp);            // patches (sorting, damp/dry)
    vec4 gr = mFbmD(p, 3.2, 3, fp);            // clumps of grains
    float sp = vnoise(M_ROT * p * 11.0 + 3.7); // single grains of other minerals
    float spw = lodFade(11.0, fp);
    m.alb *= (1.0 + 0.28 * lo.x + 0.35 * gr.x) * (1.0 - spw * 0.6 * smoothstep(0.74, 0.86, sp))
           * (1.0 + spw * 0.25 * smoothstep(0.26, 0.14, sp));
    m.g = 0.11 * gr.yzw + 0.35 * lo.yzw;
    m.cav = 1.0 + 0.5 * gr.x;
    m.glintDens = 3.0;
  } else if (id == E_STONE) {
    // gravel: rounded pebbles of mixed rock with dark crevices between them
    vec3 ge, r1;
    const float fs = 1.7;
    vec4 c = mCell(p * fs, ge, r1);
    float lw = lodFade(fs * 1.5, fp);
    float e4 = c.y * 4.0;
    float hh = sqrt(clamp(e4, 0.0, 1.0));
    float dh = e4 < 1.0 ? 2.0 / max(hh, 0.2) : 0.0;
    vec4 gr = mFbmD(p, 5.0, 2, fp);
    m.g = lw * (0.1 * dh * ge * fs + 0.25 * r1 * fs) + 0.05 * gr.yzw;
    vec3 tint = c.w > 0.72 ? vec3(1.18, 1.0, 0.8) : (c.w < 0.2 ? vec3(0.9, 0.95, 1.05) : vec3(1.0));
    m.alb *= mix(vec3(1.0), (0.5 + 1.0 * c.z) * tint, lw) * (1.0 + 0.3 * gr.x);
    m.cav = mix(1.0, mix(0.3, 1.0, hh), lw);
    m.rough += 0.2 * (c.z - 0.5) * lw;
  } else if (id == E_SNOW) {
    vec4 lo = mFbmD(p, 0.22, 2, fp);           // soft drifts
    vec4 gr = mFbmD(p, 2.6, 2, fp);            // crystal clusters
    m.alb *= 1.0 + 0.03 * lo.x + 0.03 * gr.x;
    m.g = 0.6 * lo.yzw + 0.04 * gr.yzw;
    m.sssCol = vec3(0.8, 0.94, 1.12);          // deep-scattered light: ice absorbs red
    m.glintDens = 2.5;
  } else if (id == E_GUNPOWDER) {
    vec4 gr = mFbmD(p, 4.0, 2, fp);
    m.alb *= 1.0 + 0.8 * gr.x;
    m.g = 0.12 * gr.yzw;
    m.cav = 1.0 + 0.6 * gr.x;
    m.glintDens = 3.5;
  } else if (id == E_ASH) {
    vec4 lo = mFbmD(p, 0.45, 3, fp);
    float sp = vnoise(M_ROT * p * 6.0 + 1.3);
    float spk = lodFade(6.0, fp) * smoothstep(0.76, 0.86, sp);   // charcoal bits
    m.alb *= 1.0 + 0.25 * lo.x;
    m.alb = mix(m.alb, vec3(0.025, 0.024, 0.023), spk);
    m.rough = mix(m.rough, 0.6, spk);
    m.g = 0.15 * lo.yzw;
    m.cav = 1.0 + 0.4 * lo.x;
  } else if (id == E_WOOD) {
    // bark: plates split by deep furrows, with the grain running along y
    const mat3 WJ = mat3(1.21, 0.0, 0.7, 0.0, 0.16, 0.0, -0.7, 0.0, 1.21);
    vec4 b1 = mNoiseJ(p, WJ, vec3(0.0));
    vec4 b2 = mNoiseJ(p, WJ * 3.3, vec3(11.0));
    float lw1 = lodFade(1.4, fp), lw2 = lodFade(4.6, fp);
    float fur = abs(2.0 * b1.x - 1.0);          // 0 along the furrows
    vec3 gfur = 2.0 * sign(2.0 * b1.x - 1.0) * b1.yzw;
    float sf = smoothstep(0.0, 0.4, fur);
    m.alb *= mix(1.0, mix(0.4, 1.15, sf), lw1) * (1.0 + lw2 * 0.3 * (b2.x - 0.5));
    m.g = lw1 * 0.12 * gfur + lw2 * 0.03 * b2.yzw;
    m.cav = mix(1.0, mix(0.45, 1.0, sf), lw1);
    // end grain on top faces: pale wood with growth rings
    float top = smoothstep(0.6, 0.9, abs(n.y));
    if (top > 0.0) {
      float r = 9.0 * vnoise(M_ROT * vec3(p.x, 0.0, p.z) * 0.07) + 0.5 * vnoise(M_ROT * p * 0.9);
      float ring = smoothstep(0.0, 0.3, abs(fract(r) - 0.5) * 2.0);
      vec3 endg = vec3(0.36, 0.22, 0.12) * mix(0.62, 1.0, mix(1.0, ring, lodFade(1.0, fp)));
      m.alb = mix(m.alb, endg, top);
      m.g *= 1.0 - top;
      m.cav = mix(m.cav, 1.0, top);
      m.rough = mix(m.rough, 0.65, top);
    }
  } else if (id == E_PLANT) {
    // leafy clumps: each cellular cell is a leaf facing its own way
    vec3 ge, r1;
    const float fs = 2.3;
    vec4 c = mCell(p * fs, ge, r1);
    float lw = lodFade(fs * 1.5, fp);
    vec3 tilt = hash33(vec3(c.z, c.w, 0.37) * 157.0) - 0.5;
    m.g = lw * (1.3 * tilt + 0.3 * r1 * fs);
    float gap = smoothstep(0.0, 0.12, c.y);
    m.cav = mix(1.0, mix(0.2, 1.0, gap), lw);
    vec3 hue = mix(vec3(0.8, 1.0, 0.6), vec3(1.3, 1.1, 0.55), c.z);   // blue-green .. yellow-green
    m.alb *= mix(vec3(1.0), hue * (0.65 + 0.7 * c.w), lw);
    m.sssCol = vec3(0.85, 1.15, 0.55);
    m.trans = 1.0;
  } else if (id == E_METAL) {
    // brushed steel: fine grooves along a fixed world direction, anisotropic highlight
    const vec3 BD = vec3(1.0, 0.1, 0.35);
    vec3 t = normalize(BD - n * dot(n, BD) + 1e-5);
    vec3 b = cross(n, t);
    float u = dot(p, t), w = dot(p, b);
    float s1 = vnoise(vec3(u * 0.7, w * 7.0, 0.5)), s2 = vnoise(vec3(u * 1.3, w * 23.0, 7.5));
    float l1 = lodFade(7.0, fp), l2 = lodFade(23.0, fp);
    vec4 lo = mFbmD(p, 0.35, 2, fp);           // smudges, faint oxide
    float br = l1 * (s1 - 0.5) + 0.6 * l2 * (s2 - 0.5);
    m.rough = ROUGH[id] + 0.12 * lo.x + 0.12 * br;
    m.alb *= 1.0 + 0.1 * lo.x + 0.08 * br;
    m.tang = t; m.aniso = 0.7;
    // hot steel grows a dark oxide scale (explicitly a look, not simulated)
    float ox = smoothstep(400.0, 900.0, T);
    m.alb *= mix(1.0, 0.3, ox); m.rough = mix(m.rough, 0.75, ox); m.aniso *= 1.0 - ox;
  } else if (id == E_CLONE) {
    vec4 lo = mFbmD(p, 0.8, 2, fp);            // gently hammered gold
    m.g = 0.08 * lo.yzw;
    m.rough += 0.1 * lo.x;
  } else if (id == E_WALL) {
    // concrete: blotchy mottling, sandy grit and the odd air-bubble pit
    vec4 lo = mFbmD(p, 0.18, 3, fp);
    vec4 gr = mFbmD(p, 3.0, 2, fp);
    vec4 pt = mNoiseJ(p, M_ROT * 1.9, vec3(5.3));
    float lwp = lodFade(6.0, fp);
    float pit = smoothstep(0.8, 0.88, pt.x) * lwp;
    m.alb *= (1.0 + 0.45 * lo.x + 0.2 * gr.x) * (1.0 - 0.45 * pit);
    m.g = 0.12 * lo.yzw + 0.04 * gr.yzw - lwp * 0.05 * dSmooth(0.8, 0.88, pt.x) * pt.yzw;
    m.cav = (1.0 - 0.6 * pit) * (1.0 + 0.3 * gr.x);
    m.rough += 0.08 * gr.x;
  } else if (id == E_ROCK) {
    // weathered basalt: lumpy relief, joint blocks with cracks, faint strata
    vec4 lo = mFbmD(p, 0.2, 3, fp);
    vec4 gr = mFbmD(p, 2.6, 2, fp);
    vec3 ge, r1;
    const float fs = 0.55;
    vec4 c = mCell(p * fs, ge, r1);
    float lwc = lodFade(fs * 4.0, fp);
    float crack = 1.0 - smoothstep(0.0, 0.05, c.y);
    float sh = smoothstep(0.0, 0.3, c.y);
    float band = vnoise(vec3(p.x * 0.05, p.y * 0.4, p.z * 0.05));
    m.alb *= (1.0 + 0.4 * lo.x + 0.3 * gr.x) * mix(1.0, (0.8 + 0.4 * c.z) * (1.0 - 0.6 * crack), lwc)
           * mix(vec3(0.92, 0.95, 1.0), vec3(1.1, 1.0, 0.9), band);
    m.g = 0.7 * lo.yzw + 0.08 * gr.yzw + lwc * 0.3 * dSmooth(0.0, 0.3, c.y) * ge * fs;
    m.cav = mix(1.0, 0.4 + 0.6 * sh, lwc) * (1.0 + 0.3 * gr.x);
    m.rough += 0.1 * gr.x;
  } else if (id == E_LAVA) {
    // Molten above the solidus, a cooling crust near it. The crust radiates
    // and drops far below the bulk temperature; its cracks show the melt.
    float Ts = solidusOf(ctype);
    vec4 sk = mFbmD(p + vec3(0.0, uTime * 0.12, 0.0), 0.4, 2, fp);   // churning skin
    float x = (T - Ts) / 450.0 + 0.6 * sk.x;   // 0 = at the solidus, 1 = fully molten
    float crust = 1.0 - smoothstep(0.2, 0.8, x);
    vec3 ge, r1;
    const float fs = 0.8;
    vec4 c = mCell(p * fs, ge, r1);            // crust plates
    float lwc = lodFade(fs * 4.0, fp);
    float w = mix(0.22, 0.04, crust);          // crack half-width: cracks close as it cools
    float crk = mix(1.0 - smoothstep(0.5 * w, w, c.y), 1.6 * w, 1.0 - lwc);
    float melt = max(1.0 - crust, crust * crk);   // visible fraction of exposed melt
    float Tsurf = mix(T, min(T, 450.0 + 0.8 * (T - Ts)), crust);
    m.emit = mix(incandescence(Tsurf), incandescence(T + 90.0 * sk.x), melt);
    float solid = crust * (1.0 - crk);
    m.alb = mix(vec3(0.05, 0.035, 0.025), ALBEDO[id] * (0.75 + 0.5 * c.z), solid);
    m.rough = mix(0.25, 0.85, solid);
    m.g = solid * lwc * 0.2 * dSmooth(0.0, 0.35, c.y) * ge * fs + (1.0 - crust) * 0.1 * sk.yzw;
    m.cav = mix(1.0, 0.5 + 0.5 * smoothstep(0.0, 0.35, c.y), solid * lwc);
  }
  return m;
}

// Base colour of an element at world point p (kept for callers that only need a colour).
vec3 albedoOf(int id, vec3 p, float seed) {
  return matOf(id, p, vec3(0.0, 1.0, 0.0), AMBIENT, 0.0, 0.0).alb;
}

void applyMat(inout Surf s, Mat m) {
  s.albedo = max(m.alb, vec3(0.0)); s.rough = clamp(m.rough, 0.04, 1.0); s.metal = m.metal; s.f0 = m.f0;
  s.sss = m.sss; s.sssCol = m.sssCol; s.glint = m.glint; s.glintDens = m.glintDens;
  s.cav = clamp(m.cav, 0.0, 1.0); s.aniso = m.aniso; s.tang = m.tang; s.trans = m.trans; s.emit = m.emit;
  // bump: tilt the normal by the tangential part of the height gradient
  vec3 gt = m.g - s.ng * dot(s.ng, m.g);
  float gl = length(gt);
  if (gl > 1.5) gt *= 1.5 / gl;
  s.n = normalize(s.ng - gt);
}

// Surface record for a smooth-channel hit: blend the material of the cells of
// that channel around the point, weighted trilinearly. The two most common
// elements get a full material each; their border is broken up with noise so
// it doesn't follow the cell lattice.
Surf gatherSurf(vec3 hp, vec3 n, int ch) {
  Surf s;
  s.p = hp; s.n = n; s.ng = n; s.ch = ch; s.id = E_EMPTY; s.cell = ivec3(floor(hp - n * 0.5)); s.seed = 0.0;
  s.face = ivec3(0, 1, 0);
  vec3 q = hp - n * 0.4 - 0.5;
  ivec3 c0 = ivec3(floor(q));
  vec3 f = q - vec3(c0);
  int id1 = -1, id2 = -1;
  float w1 = 0.0, w2 = 0.0, T = 0.0, wsum = 0.0, wbest = -1.0, ct1 = 0.0, ct2 = 0.0;
  for (int i = 0; i < 8; i++) {
    ivec3 o = ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    ivec3 c = c0 + o;
    if (outside(c)) continue;
    vec4 a = cellA(c);
    int id = eid(a);
    if (SURFCH[id] != ch) continue;
    vec3 wv = mix(1.0 - f, f, vec3(o));
    float w = wv.x * wv.y * wv.z + 1e-3;
    T += w * a.y;
    wsum += w;
    if (id1 < 0 || id == id1) {
      id1 = id; w1 += w;
      if (w > wbest) { wbest = w; s.cell = c; s.seed = fract(a.w); ct1 = floor(a.w); }
    } else if (id2 < 0 || id == id2) {
      if (id2 < 0) ct2 = floor(a.w);
      id2 = id; w2 += w;
    }
  }
  if (wsum == 0.0) {
    // the smoothed surface spilled past its own cells: look a bit deeper
    ivec3 cc = ivec3(floor(hp - n * 0.9));
    for (int i = 0; i < 27 && wsum == 0.0; i++) {
      ivec3 c = cc + ivec3(i % 3, (i / 3) % 3, i / 9) - 1;
      if (outside(c)) continue;
      vec4 a = cellA(c);
      int id = eid(a);
      if (SURFCH[id] != ch) continue;
      id1 = id; w1 = 1.0; T = a.y; wsum = 1.0; s.cell = c; s.seed = fract(a.w); ct1 = floor(a.w);
    }
  }
  if (wsum == 0.0) {
    id1 = ch == CH_LIQUID ? E_WATER : (ch == CH_MOLTEN ? E_LAVA : (ch == CH_GRANULAR ? E_SAND : E_PLANT));
    w1 = 1.0; T = AMBIENT; wsum = 1.0;
  }
  if (w2 > w1) { int ti = id1; id1 = id2; id2 = ti; float tw = w1; w1 = w2; w2 = tw; float tc = ct1; ct1 = ct2; ct2 = tc; }
  s.id = id1;
  s.T = T / wsum;
  float fp = footprint(hp);
  Mat m = matOf(id1, hp, n, s.T, ct1, fp);
  if (id2 >= 0) {
    float r = w2 / (w1 + w2);
    float k = smoothstep(0.25, 0.75, r + (vnoise(M_ROT * hp * 1.7 + 2.9) - 0.5) * 0.6);
    if (k > 0.0) m = mixMat(m, matOf(id2, hp, n, s.T, ct2, fp), k);
  }
  applyMat(s, m);
  return s;
}

// ---- crisp voxels: bevelled boxes ----
// A crisp neighbour that a voxel's face is flush with (the floor counts; glass doesn't).
bool flushNb(ivec3 c) {
  if (c.y < 0) return true;
  if (outside(c)) return false;
  int id = eid(cellA(c));
  return isCrisp(id) && RCLASS[id] != R_GLASS;
}

// Ray vs rounded box (Inigo Quilez): centred at the origin, inner half-size b,
// radius r. Returns the entry t, -1 on a miss, -2 if ro is inside the bounds.
float rboxHit(vec3 ro, vec3 rd, vec3 b, float r) {
  vec3 m = 1.0 / rd;
  vec3 nn = m * ro;
  vec3 k = abs(m) * (b + r);
  vec3 t1 = -nn - k, t2 = -nn + k;
  float tN = max(max(t1.x, t1.y), t1.z);
  float tF = min(min(t2.x, t2.y), t2.z);
  if (tN > tF || tF < 0.0) return -1.0;
  if (tN < 0.0) return -2.0;
  float t = tN;
  vec3 pos = ro + t * rd;
  vec3 s = sign(pos);
  ro *= s; rd *= s; pos *= s;
  pos -= b;
  pos = max(pos.xyz, pos.yzx);
  if (min(min(pos.x, pos.y), pos.z) < 0.0) return t;   // a flat face
  vec3 oc = ro - b;
  vec3 dd = rd * rd, oo = oc * oc, od = oc * rd;
  float ra2 = r * r;
  t = 1e20;
  { float bb = od.x + od.y + od.z, c = oo.x + oo.y + oo.z - ra2, h = bb * bb - c;
    if (h > 0.0) t = -bb - sqrt(h); }
  { float a = dd.y + dd.z, bb = od.y + od.z, c = oo.y + oo.z - ra2, h = bb * bb - a * c;
    if (h > 0.0) { h = (-bb - sqrt(h)) / a; if (h > 0.0 && h < t && abs(ro.x + rd.x * h) < b.x) t = h; } }
  { float a = dd.z + dd.x, bb = od.z + od.x, c = oo.z + oo.x - ra2, h = bb * bb - a * c;
    if (h > 0.0) { h = (-bb - sqrt(h)) / a; if (h > 0.0 && h < t && abs(ro.y + rd.y * h) < b.y) t = h; } }
  { float a = dd.x + dd.y, bb = od.x + od.y, c = oo.x + oo.y - ra2, h = bb * bb - a * c;
    if (h > 0.0) { h = (-bb - sqrt(h)) / a; if (h > 0.0 && h < t && abs(ro.z + rd.z * h) < b.z) t = h; } }
  return t > 1e19 ? -1.0 : t;
}

// Shape of a crisp voxel: the ray enters the cell at tEnter through face
// normal n. The voxel is a box with rounded edges, but only where it is
// exposed: on sides with a flush crisp neighbour the box reaches past the cell,
// so a wall of many voxels is one flat slab with rounded outer edges (concave
// edges stay sharp). Returns false if the shape is missed within [tEnter, tExit).
bool crispHit(ivec3 cell, int id, vec3 ro, vec3 rd, float tEnter, float tExit, inout float t, inout vec3 n) {
  float R = uBevel;
  if (R <= 0.0 || RCLASS[id] == R_GLASS) return true;
  vec3 lo = vec3(0.0), hi = vec3(1.0);
  for (int k = 0; k < 3; k++) {
    ivec3 e = ivec3(0);
    e[k] = 1;
    if (flushNb(cell - e)) lo[k] = -R;
    if (flushNb(cell + e)) hi[k] = 1.0 + R;
  }
  vec3 b = 0.5 * (hi - lo) - R;
  vec3 c = vec3(cell) + 0.5 * (lo + hi);
  vec3 pe = ro + rd * tEnter - c;
  if (length(max(abs(pe) - b, 0.0)) <= R + 1e-4) return true;   // entered through a flat part
  float tb = tEnter - 1.0;
  float th = rboxHit(ro + rd * tb - c, rd, b, R);
  if (th == -2.0) return true;
  if (th < 0.0) return false;
  th += tb;
  if (th < tEnter - 1e-4 || th >= tExit) return false;
  t = max(th, tEnter);
  vec3 ph = ro + rd * t - c;
  vec3 q = max(abs(ph) - b, 0.0);
  if (dot(q, q) > 1e-12) n = sign(ph) * normalize(q);
  return true;
}

// Surface record for a crisp voxel, or (with ch set by the caller) a grain.
Surf crispSurf(ivec3 cell, int id, vec4 a, vec3 hp, vec3 n) {
  Surf s;
  s.p = hp; s.n = n; s.ng = n; s.ch = -1; s.id = id; s.cell = cell; s.seed = fract(a.w); s.T = a.y;
  vec3 an = abs(n);
  s.face = an.x >= an.y && an.x >= an.z ? ivec3(int(sign(n.x)), 0, 0)
         : (an.y >= an.z ? ivec3(0, int(sign(n.y)), 0) : ivec3(0, 0, int(sign(n.z))));
  // an isolated grain carries its texture with it (its seed moves with the grain)
  vec3 tp = SURFCH[id] >= 0 ? hp - vec3(cell) + s.seed * 61.0 : hp;
  applyMat(s, matOf(id, tp, n, a.y, floor(a.w), footprint(hp)));
  return s;
}

// ---- shading ----
// Split-sum environment BRDF, analytic fit (Karis 2014): (scale, bias) on F0.
vec2 envBRDF(float nv, float rough) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

// Height-correlated Smith visibility, V = G2 / (4 n·l n·v).
float smithV(float nl, float nv, float a) {
  float a2 = a * a;
  float gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  float gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

// GGX specular BRDF times n·l, optionally anisotropic: grooves along t are
// smoother along t than across, so the highlight stretches across them.
vec3 ggxSpecA(vec3 n, vec3 v, vec3 l, float rough, vec3 F0, vec3 t, float aniso) {
  float nl = dot(n, l);
  if (nl <= 0.0) return vec3(0.0);
  vec3 h = normalize(v + l);
  float nv = max(dot(n, v), 1e-4), nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
  float a = max(rough * rough, 2e-3);
  float D;
  if (aniso > 0.0) {
    vec3 b = normalize(cross(n, t));
    t = cross(b, n);
    float at = max(a * (1.0 - aniso), 2e-3), ab = max(a * (1.0 + aniso), 2e-3);
    float th = dot(t, h) / at, bh = dot(b, h) / ab;
    float d = th * th + bh * bh + nh * nh;
    D = 1.0 / (PI_S * at * ab * d * d);
    a = sqrt(at * ab);
  } else {
    float a2 = a * a;
    float d = nh * nh * (a2 - 1.0) + 1.0;
    D = a2 / (PI_S * d * d);
  }
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
  return D * smithV(nl, nv, a) * F * nl;
}
vec3 ggxSpec(vec3 n, vec3 v, vec3 l, float rough, vec3 F0) {
  return ggxSpecA(n, v, l, rough, F0, vec3(1.0, 0.0, 0.0), 0.0);
}

// Glints: a world-space lattice of tiny mirror facets (one disc per lattice
// cell around a jittered centre) whose normals are drawn from the material's
// GGX distribution. A facet lights up when it reflects the sun into the eye
// (within an angular tolerance standing in for the sun's disc plus facet
// curvature). The result is normalised so its expected value equals the
// smooth GGX lobe it replaces (an unbiased estimator), so it converges to the
// same brightness when averaged (TAA, distance). A cheap stand-in for Deliot &
// Belcour 2023 (no multi-scale binomial counting: we fade out instead).
vec3 glintSpec(vec3 p, vec3 n, vec3 v, vec3 l, float rough, vec3 F0, float dens) {
  vec3 q = M_ROT * p * dens + 0.5;
  vec3 ci = floor(q);
  vec3 h1 = hash33(ci);
  float cov = 1.0 - smoothstep(0.17, 0.25, length(q - ci - (0.25 + 0.5 * h1)));
  float nl = dot(n, l);
  if (cov <= 0.0 || nl <= 0.0) return vec3(0.0);
  vec3 h2 = hash33(ci + 41.7);
  float a = max(rough * rough, 2e-3);
  float phi = 6.2831853 * h2.x;
  float ct = sqrt((1.0 - h2.y) / (1.0 + (a * a - 1.0) * h2.y));
  float st = sqrt(max(1.0 - ct * ct, 0.0));
  vec3 t1 = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 m = (t1 * cos(phi) + cross(n, t1) * sin(phi)) * st + n * ct;
  vec3 h = normalize(v + l);
  const float DELTA = 0.12;                        // angular tolerance (radians)
  const float OMEGA = PI_S * DELTA * DELTA * 0.5;  // integral of the kernel below
  const float COV = 0.034;                         // mean disc coverage of a lattice cell
  float x = length(m - h) / DELTA;
  float k = max(1.0 - x * x, 0.0);
  if (k <= 0.0) return vec3(0.0);
  float nv = max(dot(n, v), 1e-4), nh = max(dot(n, h), 1e-3), vh = max(dot(v, h), 0.0);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
  return F * smithV(nl, nv, a) * nl * k * cov / (nh * OMEGA * COV);
}

// Diffuse of a rough (powdery) surface relative to Lambert, times n·l: Fujii's
// improved qualitative Oren–Nayar (sigma = facet slope spread, radians).
// Flatter than Lambert and brighter toward the sun (back-scattering).
float orenNayar(float nl, float nv, float lv, float sigma) {
  float s = lv - nl * nv;
  float t = s > 0.0 ? max(max(nl, nv), 1e-3) : 1.0;
  float A = 1.0 / (1.0 + (0.5 - 2.0 / (3.0 * PI_S)) * sigma);
  return max(nl, 0.0) * A * (1.0 + sigma * s / t);
}

vec3 shadeSurf(Surf s, vec3 rd) {
  vec3 v = -rd;
  vec3 ng = s.ng;
  float ao = s.ch >= 0 ? fieldAO(s.p, ng) : faceAO(s.cell, s.face, s.p);
  vec3 local = sampleLight(s.p + ng * 0.75) * uLightGain;
  Probe gi = surfProbe(s.p, ng);
  // keep the bumped normal on the visible side
  vec3 n = s.n;
  float nvr = dot(n, v);
  if (nvr < 0.05) n = normalize(n + v * (0.05 - nvr));
  float nv = clamp(dot(n, v), 1e-4, 1.0);
  vec3 l = uSun;
  float nl = dot(n, l), ngl = dot(ng, l);
  float w = s.sss;
  vec3 sh = vec3(0.0);
  if (max(nl, ngl) + w > 0.0) sh = uShadows ? sunShadow(s.p, ng) : vec3(1.0);
  float aoT = ao * s.cav;

  // specular layer (F0) and the energy it takes from the diffuse one
  // (multiple-scattering GGX after Fdez-Agüera 2019)
  vec3 F0 = mix(vec3(s.f0), s.albedo, s.metal);
  vec2 AB = envBRDF(nv, s.rough);
  vec3 FssEss = F0 * AB.x + AB.y;
  float Ess = AB.x + AB.y;
  float Ems = 1.0 - Ess;
  vec3 Favg = F0 + (1.0 - F0) / 21.0;
  vec3 Fms = FssEss * Favg / (1.0 - Ems * Favg);
  vec3 kD = s.albedo * (1.0 - s.metal) * (1.0 - FssEss - Fms * Ems);

  // sun: diffuse (rough powders back-scatter; porous stuff wraps light past the terminator)
  float sigma = max(s.rough - 0.45, 0.0) * 1.6;
  float lam = orenNayar(nl, nv, dot(l, v), sigma);
  float wrap = max(nl + w, 0.0) / ((1.0 + w) * (1.0 + w));
  vec3 dSun = kD * mix(vec3(lam), wrap * s.sssCol, w);
  // sun: specular, with multiple-scattering energy compensation
  vec3 spec = ggxSpecA(n, v, l, s.rough, F0, s.tang, s.aniso) * (1.0 + F0 * (1.0 / max(Ess, 1e-3) - 1.0));
  float g = s.glint * uGlints * smoothstep(0.8, 2.0, 0.5 / (s.glintDens * footprint(s.p)));
  if (g > 0.0) spec = mix(spec, glintSpec(s.p, n, v, l, s.rough, F0, s.glintDens), g);
  // (SUN_COL is irradiance / pi in this renderer's units, hence the pi on the BRDF term)
  vec3 c = SUN_COL * sh * (dSun * (0.5 + 0.5 * s.cav) + PI_S * spec);

  // leaves: sunlight through a thin clump (thickness from the natural-solids field)
  if (s.trans > 0.0 && ngl < 0.0) {
    float th = surfField(s.p + l * 0.9)[CH_ORGANIC] * 0.9 + surfField(s.p + l * 2.2)[CH_ORGANIC] * 1.3;
    vec3 shT = uShadows ? sunShadow(s.p + l * 3.0) : vec3(1.0);
    c += s.trans * SUN_COL * shT * (s.albedo * s.sssCol * 1.6) * (-ngl) * exp(-2.5 * th);
  }

  // environment: specular (anisotropic lobes bend the lookup normal, rough
  // lobes reflect toward the normal), horizon- and AO-occluded. Glossy lobes
  // see the sky, dimmed by how much of it the probes say is visible; rough
  // ones blur into the probes' light (sky + bounce, already occluded).
  vec3 nb = n;
  if (s.aniso > 0.0) {
    vec3 at = cross(s.tang, v);
    nb = normalize(mix(n, cross(at, s.tang), s.aniso * clamp(5.0 * s.rough, 0.0, 1.0)));
  }
  vec3 r = reflect(rd, nb);
  r = normalize(mix(r, nb, s.rough * s.rough));
  float hor = clamp(1.0 + dot(r, ng), 0.0, 1.0);
  vec3 irr = giIrradiance(gi, n);
  vec3 envL = mix(skyColor(r) * giSkyVis(gi, n), giIrradiance(gi, r), smoothstep(0.25, 0.9, s.rough));
  float specAO = clamp(pow(nv + aoT, exp2(-16.0 * s.rough - 1.0)) - 1.0 + aoT, 0.0, 1.0);
  c += (envL * FssEss * hor * hor + irr * Fms * Ems) * specAO;
  // indirect (sky + bounce) and glow volume: diffuse
  c += kD * (irr * aoT + local * (0.35 + 0.65 * aoT));
  return c + s.emit;
}

vec3 shadeFloor(vec3 hp, vec3 rd) {
  vec2 q = hp.xz / 8.0;
  vec2 gq = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-4));
  float line = 1.0 - min(min(gq.x, gq.y), 1.0);
  vec3 alb = mix(GROUND_ALB, vec3(0.14, 0.15, 0.17), line);
  vec3 n = vec3(0.0, 1.0, 0.0);
  float ndl = max(uSun.y, 0.0);
  vec3 sh = uShadows ? sunShadow(hp, n) : vec3(1.0);
  float ao = min(faceAO(ivec3(floor(hp.x), -1, floor(hp.z)), ivec3(0, 1, 0), hp), fieldAO(vec3(hp.x, 0.0, hp.z), n));
  vec3 local = sampleLight(vec3(hp.x, 0.5, hp.z)) * uLightGain;
  vec3 irr = giIrradiance(surfProbe(vec3(hp.x, 0.0, hp.z), n), n);
  return alb * (SUN_COL * ndl * sh + irr * ao + local * (0.35 + 0.65 * ao));
}
`;

// Shared render core: state/brick/field access, the DDA helpers and the
// smooth-surface machinery (sampling, root finding, normals).
export const coreGLSL = (g) => /* glsl */ `
uniform sampler2D tA;
uniform sampler2D tB;    // velocity xyz (cells/step), air pressure
uniform sampler2D tBrick;
uniform sampler2D tLight;
uniform sampler2D tFS;   // smooth-surface fields (liquid, molten, granular, organic); 0.5 = surface
uniform sampler2D tFM;   // media fields (smoke, steam, fire, heat)
uniform int uView;
uniform bool uShadows;
uniform float uTime;
uniform float uLightGain;
uniform int uFrame;

const ivec3 GRID = ivec3(NX, NY, NZ);
#define MAX_STEPS ${g.maxSteps}

vec4 cellA(ivec3 c) { return texelFetch(tA, atlas(c), 0); }
vec4 cellB(ivec3 c) { return texelFetch(tB, atlas(c), 0); }
bool outside(ivec3 c) { return any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, GRID)); }

// Crisp elements are drawn as voxels; everything else is a field.
bool isCrisp(int id) { return id != E_EMPTY && SURFCH[id] < 0 && MEDIACH[id] < 0; }

// ---- bricks (see brickFrag in passes.js) ----
// a = 0: empty. a < 0: air only, flagged for the data views.
// a >= 1: 1 + gas fraction + 2·media + 4·smooth surface nearby (+ air flags / 65536).
float brickOcc(ivec3 bc) { return texelFetch(tBrick, brickAtlas(bc), 0).a; }
int brickBits(float occ) { return int((occ - 1.0) * 0.5); }
float brickGas(float occ) { return occ > 0.5 ? clamp(occ - 1.0 - 2.0 * float(brickBits(occ)), 0.0, 1.0) : 0.0; }
// realistic view: 0 = skip the brick, else 1 + bits (1 media, 2 surface)
int brickInfo(ivec3 bc) { float a = brickOcc(bc); return a < 0.5 ? 0 : 1 + brickBits(a); }
bool brickMedia(int f) { return f > 0 && ((f - 1) & 1) != 0; }
bool brickSurf(int f) { return f > 0 && ((f - 1) & 2) != 0; }

vec3 safeDir(vec3 rd) {
  return vec3(abs(rd.x) < 1e-6 ? 1e-6 : rd.x, abs(rd.y) < 1e-6 ? 1e-6 : rd.y, abs(rd.z) < 1e-6 ? 1e-6 : rd.z);
}
// returns (tNear, tFar, entryAxis)
vec3 boxHit(vec3 ro, vec3 rd) {
  vec3 t0 = (vec3(0.0) - ro) / rd, t1 = (vec3(GRID) - ro) / rd;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float n = max(max(tn.x, tn.y), tn.z);
  float axis = tn.x >= tn.y && tn.x >= tn.z ? 0.0 : (tn.y >= tn.z ? 1.0 : 2.0);
  return vec3(n, min(min(tf.x, tf.y), tf.z), axis);
}
int argmin3(vec3 v) { return v.x <= v.y && v.x <= v.z ? 0 : (v.y <= v.z ? 1 : 2); }

// Jump the DDA to the exit of empty brick bc. Updates cell/tMax/tEnter, returns axis crossed.
int skipBrick(ivec3 bc, vec3 ro, vec3 rd, ivec3 istp, inout ivec3 cell, inout vec3 tMax, inout float tEnter) {
  vec3 bmin = vec3(bc * BS), bmax = bmin + float(BS);
  vec3 tb = (mix(bmin, bmax, step(0.0, rd)) - ro) / rd;
  int ax = argmin3(tb);
  float tx = tb[ax];
  cell = ivec3(floor(ro + rd * tx));
  cell[ax] = istp[ax] > 0 ? int(bmax[ax]) : int(bmin[ax]) - 1;
  tMax = (vec3(cell) + step(0.0, rd) - ro) / rd;
  tEnter = tx;
  return ax;
}

// ---- continuous fields ----
// The fields live in the same Y-slice atlas as the state. Hardware bilinear
// filtering works inside a slice (clamped to the tile), and one lerp between
// two slices completes the trilinear sample: 2 taps.
vec4 fieldTex(sampler2D t, vec3 p) {
  vec3 q = clamp(p, vec3(0.5), vec3(GRID) - 0.5);
  float fy = q.y - 0.5;
  int y0 = int(fy);
  int y1 = min(y0 + 1, NY - 1);
  vec2 inv = 1.0 / vec2(textureSize(t, 0));
  vec2 o0 = vec2(float((y0 % TX) * NX), float((y0 / TX) * NZ));
  vec2 o1 = vec2(float((y1 % TX) * NX), float((y1 / TX) * NZ));
  return mix(texture(t, (o0 + q.xz) * inv), texture(t, (o1 + q.xz) * inv), fy - float(y0));
}
vec4 surfField(vec3 p) { return fieldTex(tFS, p); }
vec4 mediaField(vec3 p) { return fieldTex(tFM, p); }
vec4 surfCell(ivec3 c) { return texelFetch(tFS, atlas(c), 0); }

// Root of φ_ch(t) = 0.5 bracketed by [ta, tb] (fa, fb = φ - 0.5 at the ends,
// opposite signs). Clamped regula falsi: the field is smooth, so a few steps do.
float surfRoot(vec3 ro, vec3 rd, int ch, float ta, float tb, float fa, float fb) {
  for (int k = 0; k < 5; k++) {
    float tm = mix(ta, tb, clamp(fa / (fa - fb), 0.15, 0.85));
    float fm = surfField(ro + rd * tm)[ch] - 0.5;
    if ((fm < 0.0) == (fa < 0.0)) { ta = tm; fa = fm; } else { tb = tm; fb = fm; }
  }
  return mix(ta, tb, clamp(fa / (fa - fb), 0.0, 1.0));
}

// Outward surface normal (−∇φ) from a tetrahedral central difference. The
// step is wide on purpose: trilinear fields have creased gradients at the
// cell-centre lattice, and a wide stencil irons them out.
vec3 surfNormal(vec3 p, int ch, vec3 fallback) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.55;
  vec3 gr = k.xyy * surfField(p + k.xyy * h)[ch] + k.yyx * surfField(p + k.yyx * h)[ch]
          + k.yxy * surfField(p + k.yxy * h)[ch] + k.xxx * surfField(p + k.xxx * h)[ch];
  float l = length(gr);
  return l > 1e-5 ? -gr / l : fallback;
}
`;

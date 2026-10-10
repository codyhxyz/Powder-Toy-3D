import { lib } from './render.js';

// Coarse global illumination for the realistic view: one light probe per
// 4×4×4 brick, rebuilt every frame in two small passes at brick resolution.
//
// giSourceFrag: what each brick does to light. How much of the light crossing
//   it along x, y and z it blocks (the projected coverage of its opaque cells,
//   so a one-cell plate still blocks the light crossing it, plus the optical
//   depth of liquid, glass and smoke), and the light its exposed faces send
//   back out: albedo × (sunlight from the shadow map + last frame's probe
//   light at that brick). Feeding the probes back makes bounces add up over
//   frames.
// giGatherFrag: from each brick centre, march GI_RAYS fixed directions through
//   those bricks, collecting the light of what each ray hits and the sky or
//   ground beyond, and project it onto L1 spherical harmonics (rgb = radiance,
//   a = sky visibility). The result is blended into the probe volume over a few
//   frames (sim.js), which hides cells popping between bricks.

// Metals reflect specularly; this share of their F0 is counted as diffuse bounce.
const GI_METAL_DIFFUSE = 0.5;
// An exposed cell's sunlight is looked up this far (cells) toward the sun from its centre.
const GI_SUN_LIFT = 0.9;
export const GI_RAYS = 32;
// Steps a ray marches before it takes whatever lies beyond as open sky or
// ground: one brick each for the first GI_NEAR_STEPS, then GI_FAR_STRIDE
// bricks (distant blockers only need to be roughly right).
const GI_STEPS = 12;
const GI_NEAR_STEPS = 6;
const GI_FAR_STRIDE = 2;
// A probe whose own and six neighbouring bricks all block more than this along
// every axis is buried: no surface reads it, so it isn't traced.
const GI_BURIED = 0.99;
// A ray stops once this little of its light can still get through.
const GI_T_MIN = 0.02;
// How strongly a brick's light favours the side its lit faces point to
// (0 = the same seen from anywhere; 1 = nothing from behind its lit faces).
const GI_FACING = 1.0;

const glf = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const giSourceFrag = (g) => /* glsl */ `
${lib(g)}
layout(location = 0) out vec4 oRad;   // mean light leaving the brick's exposed faces (rgb)
layout(location = 1) out vec4 oCov;   // share of light blocked crossing the brick along x, y, z
layout(location = 2) out vec4 oDir;   // light-weighted mean normal of those faces

const float GI_METAL_DIFFUSE = ${glf(GI_METAL_DIFFUSE)};
const float GI_SUN_LIFT = ${glf(GI_SUN_LIFT)};
#define BRICK_CELLS (BS * BS * BS)
#define FACE_CELLS (BS * BS)

bool giOpaque(ivec3 c) {
  if (c.y < 0) return true;
  if (outside(c)) return false;
  return RCLASS[eid(fetchA(c))] == R_OPAQUE;
}

// Set bits in a 16-bit mask (no bitCount in GLSL ES 3.00).
float popc16(uint v) {
  v = v - ((v >> 1) & 0x5555u);
  v = (v & 0x3333u) + ((v >> 2) & 0x3333u);
  v = (v + (v >> 4)) & 0x0f0fu;
  return float((v + (v >> 8)) & 0x1fu);
}

// Bit of local cell l in a brick's 64-bit opaque mask (x fastest, then y, z).
int cellBit(ivec3 l) { return l.x + BS * l.y + FACE_CELLS * l.z; }
bool maskHas(uvec2 m, int b) { return ((b < 32 ? m.x : m.y) & (1u << (b & 31))) != 0u; }

void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  oRad = vec4(0.0); oCov = vec4(0.0); oDir = vec4(0.0);
  if (bc.y >= BY || brickOcc(bc) < 0.5) return;
  ivec3 o = bc * BS;
  // pass 1: which cells are opaque, and the extinction of the translucent ones
  uvec2 m = uvec2(0u);
  uint mx = 0u, my = 0u, mz = 0u;   // opaque cells projected along x, y, z
  float tau = 0.0;
  for (int i = 0; i < BRICK_CELLS; i++) {
    ivec3 l = ivec3(i % BS, (i / BS) % BS, i / FACE_CELLS);
    vec4 a = fetchA(o + l);
    int id = eid(a);
    if (id == E_EMPTY) continue;
    if (RCLASS[id] != R_OPAQUE) {
      tau += dot(SIGMA[id], vec3(1.0 / 3.0)) * (id == E_SMOKE ? clamp(a.z, 0.0, 1.0) : 1.0);
      continue;
    }
    if (i < 32) m.x |= 1u << i; else m.y |= 1u << (i - 32);
    mx |= 1u << (l.y + BS * l.z);
    my |= 1u << (l.x + BS * l.z);
    mz |= 1u << (l.x + BS * l.y);
  }
  vec3 cov = vec3(popc16(mx), popc16(my), popc16(mz)) / float(FACE_CELLS);
  // translucent matter: mean extinction per cell times the brick's width
  float trans = exp(-tau * float(BS) / float(BRICK_CELLS));
  oCov = vec4(1.0 - (1.0 - cov) * trans, 0.0);
  if (m == uvec2(0u)) return;

  // pass 2: light leaving the exposed faces (neighbours inside the brick come from the mask)
  ivec2 ba = brickAtlas(bc);   // last frame's light here: sky and bounce on the faces
  Probe pr = Probe(texelFetch(tGI0, ba, 0), texelFetch(tGI1, ba, 0), texelFetch(tGI2, ba, 0), texelFetch(tGI3, ba, 0));
  vec3 rad = vec3(0.0), dir = vec3(0.0);
  float nf = 0.0;
  for (int i = 0; i < BRICK_CELLS; i++) {
    if (!maskHas(m, i)) continue;
    ivec3 l = ivec3(i % BS, (i / BS) % BS, i / FACE_CELLS);
    ivec3 c = o + l;
    vec3 alb = vec3(-1.0);   // fetched once, if a face is exposed
    float sunVis = -1.0;     // likewise
    for (int f = 0; f < 6; f++) {
      ivec3 fn = ivec3(0);
      fn[f >> 1] = (f & 1) == 0 ? 1 : -1;
      ivec3 ln = l + fn;
      bool inBrick = all(greaterThanEqual(ln, ivec3(0))) && all(lessThan(ln, ivec3(BS)));
      if (inBrick ? maskHas(m, cellBit(ln)) : giOpaque(c + fn)) continue;
      if (alb.x < 0.0) {
        int id = eid(fetchA(c));
        alb = ALBEDO[id] * (1.0 - METAL[id] * (1.0 - GI_METAL_DIFFUSE));
      }
      vec3 nrm = vec3(fn);
      vec3 e = giIrradiance(pr, nrm);
      float nl = dot(nrm, uSun);
      if (nl > 0.0) {
        if (sunVis < 0.0) sunVis = uShadows ? dot(sunShadow(vec3(c) + 0.5 + uSun * GI_SUN_LIFT), vec3(1.0 / 3.0)) : 1.0;
        e += SUN_COL * nl * sunVis;
      }
      vec3 L = alb * e;
      rad += L;
      dir += nrm * dot(L, vec3(1.0 / 3.0));
      nf += 1.0;
    }
  }
  if (nf > 0.0) {
    oRad = vec4(rad / nf, 0.0);
    float lum = dot(rad, vec3(1.0 / 3.0));
    oDir = vec4(lum > 0.0 ? dir / lum : vec3(0.0), 0.0);
  }
}
`;

// far: GLSL defining farBeyond(P, Q, d, open), what a ray from P that ended
// at Q sees past it toward d (a massive world's far field: shaders/far.js),
// where open says whether the sky is open that way; none for a grid that is
// its whole world (then: beyond, the sky or the floor around the box).
export const giGatherFrag = (g, far = '') => /* glsl */ `
${lib(g)}${far}
uniform sampler2D tGIRad;
uniform sampler2D tGICov;
uniform sampler2D tGIDir;
layout(location = 0) out vec4 oSH0;
layout(location = 1) out vec4 oSHx;
layout(location = 2) out vec4 oSHy;
layout(location = 3) out vec4 oSHz;

uniform int uParity;   // probes with (x + y + z + uParity) odd are traced this frame; -1 = all
#define GI_RAYS ${GI_RAYS}
#define GI_STEPS ${GI_STEPS}
#define GI_NEAR_STEPS ${GI_NEAR_STEPS}
const float GI_FAR_STRIDE = ${glf(GI_FAR_STRIDE)};
const float GI_BURIED = ${glf(GI_BURIED)};
const float GI_T_MIN = ${glf(GI_T_MIN)};
const float GI_FACING = ${glf(GI_FACING)};

// Ray i of GI_RAYS spread evenly over the sphere (Fibonacci lattice, y up).
vec3 giDir(int i) {
  float y = 1.0 - (2.0 * float(i) + 1.0) / float(GI_RAYS);
  float r = sqrt(max(1.0 - y * y, 0.0));
  float a = float(i) * GOLDEN_ANGLE;
  return vec3(r * cos(a), y, r * sin(a));
}

// What a ray from P (cells) toward d sees once it has left the bricks: the
// sky, or below the horizon the floor (in the box, with its sun shadow) and
// the ground around it.
vec3 beyond(vec3 P, vec3 d) {
  if (d.y >= 0.0) return skyColor(d);
  vec3 pf = P + d * (-P.y / d.y);
  vec3 grid = vec3(GRID);
  bool onFloor = pf.x >= 0.0 && pf.z >= 0.0 && pf.x < grid.x && pf.z < grid.z;
  float sun = uShadows && onFloor ? dot(sunShadow(vec3(pf.x, 0.0, pf.z)), vec3(1.0 / 3.0)) : 1.0;
  return GROUND_ALB * (SUN_COL * max(uSun.y, 0.0) * sun + uSkyUp);
}

void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  oSH0 = vec4(0.0); oSHx = vec4(0.0); oSHy = vec4(0.0); oSHz = vec4(0.0);
  if (bc.y >= BY) return;
  // half the probes per frame, alternating (the blend into the volume smooths it)
  if (uParity >= 0 && ((bc.x + bc.y + bc.z + uParity) & 1) == 0) discard;
  ivec3 bmax = ivec3(BX, BY, BZ);
  float blk = 1.0;
  for (int k = 0; k < 7; k++) {
    ivec3 b = bc;
    if (k > 0) b[(k - 1) >> 1] += (k & 1) == 1 ? 1 : -1;
    if (any(lessThan(b, ivec3(0))) || any(greaterThanEqual(b, bmax))) { blk = 0.0; break; }
    vec3 cv = texelFetch(tGICov, brickAtlas(b), 0).xyz;
    blk = min(blk, min(cv.x, min(cv.y, cv.z)));
  }
  if (blk > GI_BURIED) return;
  vec3 pc = vec3(bc) + 0.5;   // probe, in bricks
  vec3 s0 = vec3(0.0), sx = vec3(0.0), sy = vec3(0.0), sz = vec3(0.0);
  vec4 sv = vec4(0.0);
  for (int i = 0; i < GI_RAYS; i++) {
    vec3 d = giDir(i);
    vec3 d2 = d * d;
    float T = 1.0;
    vec3 L = vec3(0.0);
    vec3 q = pc;
    // the probe's own brick is skipped: surfaces read the probes from in front of them
    for (int k = 0; k < GI_STEPS; k++) {
      q += k < GI_NEAR_STEPS ? d : d * GI_FAR_STRIDE;
      ivec3 b = ivec3(floor(q));
      if (any(lessThan(b, ivec3(0))) || any(greaterThanEqual(b, bmax))) break;
      ivec2 ta = brickAtlas(b);
      float a = dot(texelFetch(tGICov, ta, 0).xyz, d2);
      if (a <= 0.0) continue;
      vec3 nd = texelFetch(tGIDir, ta, 0).xyz;
      if (k >= GI_NEAR_STEPS) a = 1.0 - pow(1.0 - a, GI_FAR_STRIDE);   // the stride crosses that many such bricks
      L += T * a * texelFetch(tGIRad, ta, 0).rgb * max(1.0 - GI_FACING * dot(nd, d), 0.0);
      T *= 1.0 - a;
      if (T < GI_T_MIN) break;
    }
${far && `    float open = 1.0;
`}    if (T >= GI_T_MIN) L += T * ${far ? 'farBeyond(pc * float(BS), q * float(BS), d, open)' : 'beyond(pc * float(BS), d)'};
    float vis = d.y > 0.0 ? T${far && ' * open'} : 0.0;
    vec4 y = vec4(SH_Y0, SH_Y1 * d);
    s0 += L * y.x; sx += L * y.y; sy += L * y.z; sz += L * y.w;
    sv += vis * y;
  }
  float w = 4.0 * PI_L / float(GI_RAYS);   // Monte Carlo weight: sphere area per ray
  oSH0 = vec4(s0, sv.x) * w;
  oSHx = vec4(sx, sv.y) * w;
  oSHy = vec4(sy, sv.z) * w;
  oSHz = vec4(sz, sv.w) * w;
}
`;

import { prelude } from './common.js';
import { raysGLSL } from '../rays.js';

// The fast-particle passes (docs/particles.md, src/raysLayer.js). Particles
// live in a list: slot j is texel (j % RAY_TEX, j / RAY_TEX) of four RGBA32F
// attachments,
//   L0  position (grid cells, continuous), kind (rays.js RAY_KIND; 0 = free)
//   L1  velocity (cells/step), life (steps left)
//   L2  photon: its energy share per RGB channel; neutron: x = energy (MeV).
//       w = the extra children it asks for this step (advance → spawn)
//   L3  this step's deposit: cell index (x + NX·(y + NY·z), −1 = none), heat,
//       pressure; w = the stripe cycle it last saw an emitter in (spawn)
// and a step is: advance (each particle flies, interacts, asks for children)
// into scratch, spawn (free slots take children and spontaneous neutrons)
// back into the list, then point draws: the deposits into a target laid out
// like the state (react.js adds them to its cells), the bricks holding a
// particle (activity.js keeps them awake), and after react the deposits again
// as zeros.

const listGLSL = (g) => /* glsl */ `
${prelude(g)}
${raysGLSL()}
#define RTEX int(RAY_TEX)
#define RN (RTEX * RTEX)              // slots
#define RSUB int(RAY_SUBSTEPS)
#define RCHILD int(RAY_CHILDREN)
#define ATLAS_W ${g.width}            // the state atlas (and the deposit target), texels
#define ATLAS_H ${g.height}
#define RAY_SALT 0x5a7u               // salts of the particle passes' random streams
#define RAY_SPAWN_SALT 0x5b1u
#define RAY_PAINT_SALT 0x5c3u
#define TWO_PI 6.2831853
#define THIRD (1.0 / 3.0)
uniform sampler2D tL0;
uniform sampler2D tL1;
uniform sampler2D tL2;
uniform sampler2D tL3;
ivec2 slotTexel(int j) { return ivec2(j % RTEX, j / RTEX); }
int kindOf(vec4 l0) { return int(floor(l0.w + 0.5)); }
// The element a neutron sees in a cell: molten metal keeps what it melted from (its ctype).
int matOf(vec4 a) {
  int id = eid(a);
  if (id == E_LAVA) {
    int ct = int(floor(a.w));
    if (ct > 0 && ct < NE) return ct;
  }
  return id;
}
vec3 randDir(inout uint s) {   // uniform on the sphere
  float z = 2.0 * rnd(s) - 1.0, ph = TWO_PI * rnd(s), r = sqrt(max(0.0, 1.0 - z * z));
  return vec3(r * cos(ph), r * sin(ph), z);
}
// rays.js fastShare and neutronSpeed
float fastShare(float E) { return clamp(log(E / NEUT_E_THERMAL) / log(NEUT_E_FAST / NEUT_E_THERMAL), 0.0, 1.0); }
float neutSpeed(float E) { return clamp(NEUT_V * sqrt(E / NEUT_E_FAST), NEUT_V_THERMAL, RAY_V_MAX); }
int cellIndex(ivec3 c) { return c.x + NX * (c.y + NY * c.z); }
ivec3 cellOfIndex(int i) { return ivec3(i % NX, (i / NX) % NY, i / (NX * NY)); }
float maxOf(vec3 v) { return max(v.x, max(v.y, v.z)); }
`;

const listOut = /* glsl */ `
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
`;

// Advance (target: the scratch list). Needs the state (fetchA) and uFrame.
export const raysAdvanceFrag = (g) => /* glsl */ `
${listGLSL(g)}
uniform uint uFrame;
${listOut}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int j = f.x + RTEX * f.y;
  vec4 l0 = texelFetch(tL0, f, 0), l1 = texelFetch(tL1, f, 0), l2 = texelFetch(tL2, f, 0), l3 = texelFetch(tL3, f, 0);
  int kind = kindOf(l0);
  l2.w = 0.0;
  o3 = vec4(-1.0, 0.0, 0.0, l3.w);   // no deposit (the stamp carries on)
  if (kind == RAY_NONE) { o0 = l0; o1 = l1; o2 = l2; return; }
  uint rs = pcg(uint(j) + pcg(uFrame * LCG_MUL + RAY_SALT));
  vec3 pos = l0.xyz, v = l1.xyz;
  float life = l1.w - 1.0;
  bool alive = life > 0.0;
  float heat = 0.0, pres = 0.0;
  int dep = -1, extra = 0;
  for (int s = 0; s < RSUB; s++) {
    if (!alive) break;
    vec3 np = pos + v / RAY_SUBSTEPS;
    ivec3 c = ivec3(floor(np));
    if (!inGrid(c)) { alive = false; break; }   // out of the box
    vec4 a = fetchA(c);
    int id = eid(a);
    float len = length(v) / RAY_SUBSTEPS;
    if (kind == RAY_PHOTON) {
      vec3 e = l2.rgb;
      if (RCLASS[id] != R_OPAQUE) {
        // clear matter: Beer-Lambert with the renderer's extinction, the loss as heat
        vec3 left = e * exp(-SIGMA[id] * len);
        if (left != e) { heat += dot(e - left, vec3(THIRD)) * PHOTON_HEAT; dep = cellIndex(c); }
        l2.rgb = left;
        pos = np;
        if (maxOf(left) < PHOTON_E_MIN) { heat += dot(left, vec3(THIRD)) * PHOTON_HEAT; dep = cellIndex(c); alive = false; }
        continue;
      }
      dep = cellIndex(c);
      float r = REFLECT[id];
      if (r <= 0.0) { heat += dot(e, vec3(THIRD)) * PHOTON_HEAT; alive = false; break; }
      // a metal: reflect off the faces crossed into it (the blocked ones of
      // the axis steps from the cell it's in), keep that share, the rest is heat
      ivec3 pc = ivec3(floor(pos)), d = c - pc;
      bvec3 flip = bvec3(false);
      for (int i = 0; i < 3; i++) {
        if (d[i] == 0) continue;
        ivec3 q = pc;
        q[i] += d[i];
        flip[i] = !inGrid(q) || RCLASS[eid(fetchA(q))] == R_OPAQUE;
      }
      if (!any(flip)) flip = notEqual(d, ivec3(0));   // a corner: back the way it came
      v = mix(v, -v, vec3(flip));
      heat += dot(e, vec3(THIRD)) * (1.0 - r) * PHOTON_HEAT;
      l2.rgb = e * r;
      if (maxOf(l2.rgb) < PHOTON_E_MIN) { heat += dot(l2.rgb, vec3(THIRD)) * PHOTON_HEAT; alive = false; }
      break;   // one interaction a step
    }
    // a neutron: transport through the cell's material (rays.js crossSections)
    pos = np;
    int m = matOf(a);
    float E = l2.x, w = fastShare(E), ov = sqrt(NEUT_E_THERMAL / E);
    float ss = mix(NSIG_ST[m], NSIG_SF[m], w), sa = max(NSIG_AF[m], NSIG_AT[m] * ov), sf = max(NSIG_FF[m], NSIG_FT[m] * ov);
    float st = ss + sa + sf;
    if (st <= 0.0 || rnd(rs) >= 1.0 - exp(-st * len)) continue;
    dep = cellIndex(c);
    float u = rnd(rs) * st;
    if (u < sf) {
      // fission: this slot flies on as one of the ν new fast neutrons, the
      // spawn pass starts the rest (2 plus a coin weighted ν − 2 in all)
      float nu = mix(NU_T[m], NU_F[m], w);
      extra = clamp(int(nu) - 1 + (rnd(rs) < fract(nu) ? 1 : 0), 0, RCHILD);
      heat += FISSION_HEAT;
      pres += FISSION_P;
      E = NEUT_E_FAST;
      v = randDir(rs) * neutSpeed(E);
      life = NEUT_LIFE;
    } else if (u < sf + sa) {
      heat += CAPTURE_HEAT;   // captured: its gamma rays heat the cell
      alive = false;
    } else {
      // isotropic scatter: off hydrogen it keeps a uniform share of its
      // energy; off a nucleus of mass A, at least α = ((A − 1)/(A + 1))²
      float x = rnd(rs);
      if (rnd(rs) < N_HSHARE[m]) E *= x;
      else {
        float al = (N_MASS[m] - 1.0) / (N_MASS[m] + 1.0);
        al *= al;
        E *= al + (1.0 - al) * x;
      }
      E = max(E, NEUT_E_THERMAL);
      v = randDir(rs) * neutSpeed(E);
    }
    l2.x = E;
    break;   // one interaction a step
  }
  if (!alive) kind = RAY_NONE;
  o0 = vec4(pos, float(kind));
  o1 = vec4(v, life);
  o2 = vec4(l2.xyz, float(extra));
  o3 = vec4(float(dep), heat, pres, l3.w);
}
`;

// Spawn (target: the list; reads the scratch list). A free slot j takes child
// k of slot (j − k·uStride) mod N if that one asked for k or more, else, on
// the stripe (docs/particles.md), the spontaneous fission of the cell at atlas
// texel j + N·uPhase. Needs the state (fetchA).
export const raysSpawnFrag = (g) => /* glsl */ `
${listGLSL(g)}
uniform uint uFrame;
uniform int uStride;     // odd: the children's slot bijections
uniform int uPhase;      // stripe position: frame % uCycle
uniform float uCycle;    // steps to sweep the atlas: a cell's emission probability is scaled by it
uniform float uStamp;    // this sweep's number (L3.w of a free slot that saw an emitter)
${listOut}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int j = f.x + RTEX * f.y;
  vec4 l0 = texelFetch(tL0, f, 0), l1 = texelFetch(tL1, f, 0), l2 = texelFetch(tL2, f, 0), l3 = texelFetch(tL3, f, 0);
  o3 = l3;
  if (kindOf(l0) != RAY_NONE) { o0 = l0; o1 = l1; o2 = vec4(l2.xyz, 0.0); return; }
  uint rs = pcg(uint(j) + pcg(uFrame * LCG_MUL + RAY_SPAWN_SALT));
  o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(0.0);
  for (int k = 1; k <= RCHILD; k++) {
    ivec2 pf = slotTexel((j + k * (RN - uStride)) % RN);   // (uStride in [1, RN): no negative %)
    vec4 p0 = texelFetch(tL0, pf, 0);
    if (kindOf(p0) == RAY_NONE || texelFetch(tL2, pf, 0).w < float(k)) continue;
    o0 = vec4(p0.xyz, float(RAY_NEUTRON));   // a fission neutron, from where its parent split
    o1 = vec4(randDir(rs) * neutSpeed(NEUT_E_FAST), NEUT_LIFE);
    o2 = vec4(NEUT_E_FAST, 0.0, 0.0, 0.0);
    return;
  }
  int t = j + RN * uPhase;
  if (t >= ATLAS_W * ATLAS_H) return;
  ivec3 c = cellFromFrag(ivec2(t % ATLAS_W, t / ATLAS_W));
  if (!inGrid(c)) return;
  float rate = SF_RATE[matOf(fetchA(c))];
  if (rate <= 0.0) return;
  o3.w = uStamp;
  if (rnd(rs) >= rate * uCycle) return;
  o0 = vec4(vec3(c) + vec3(rnd(rs), rnd(rs), rnd(rs)), float(RAY_NEUTRON));
  o1 = vec4(randDir(rs) * neutSpeed(NEUT_E_FAST), NEUT_LIFE);
  o2 = vec4(NEUT_E_FAST, 0.0, 0.0, 0.0);
}
`;

// Paint particles (target: the list): free slots in [uCursor, uCursor +
// uCount) take a new particle of uKind somewhere in the brush, flying in a
// random direction.
export const raysPaintFrag = (g) => /* glsl */ `
${listGLSL(g)}
uniform uint uFrame;
uniform int uCursor;
uniform int uCount;
uniform int uKind;
uniform vec3 uCenter;
uniform float uRadius;
uniform int uShape;     // 0 sphere, 1 cube (passes.js paintFrag)
${listOut}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int j = f.x + RTEX * f.y;
  vec4 l0 = texelFetch(tL0, f, 0);
  o0 = l0; o1 = texelFetch(tL1, f, 0); o2 = texelFetch(tL2, f, 0); o3 = texelFetch(tL3, f, 0);
  if ((j + RN - uCursor) % RN >= uCount || kindOf(l0) != RAY_NONE) return;   // (uCursor in [0, RN))
  uint rs = pcg(uint(j) + pcg(uFrame * LCG_MUL + RAY_PAINT_SALT));
  vec3 d = uShape == 0 ? randDir(rs) * uRadius * pow(rnd(rs), THIRD)
                       : (vec3(rnd(rs), rnd(rs), rnd(rs)) * 2.0 - 1.0) * uRadius;
  vec3 p = clamp(uCenter + d, vec3(0.0), vec3(NX, NY, NZ) - 0.001);
  bool photon = uKind == RAY_PHOTON;
  o0 = vec4(p, float(uKind));
  o1 = vec4(randDir(rs) * (photon ? min(PHOTON_V, RAY_V_MAX) : neutSpeed(NEUT_E_FAST)), photon ? PHOTON_LIFE : NEUT_LIFE);
  o2 = photon ? vec4(1.0, 1.0, 1.0, 0.0) : vec4(NEUT_E_FAST, 0.0, 0.0, 0.0);
  o3 = vec4(-1.0, 0.0, 0.0, o3.w);
}
`;

// Count (two passes, as activity.js superRowsFrag/superShareFrag): per row of
// the list, then in all: x = live particles, y = slots that saw an emitter in
// the sweep uStamp.
export const raysRowsFrag = (g) => /* glsl */ `
${listGLSL(g)}
uniform float uStamp;
out vec4 oC;
void main() {
  int v = int(gl_FragCoord.x);
  vec2 n = vec2(0.0);
  for (int u = 0; u < RTEX; u++) {
    ivec2 f = ivec2(u, v);
    n += vec2(kindOf(texelFetch(tL0, f, 0)) != RAY_NONE ? 1.0 : 0.0, texelFetch(tL3, f, 0).w == uStamp ? 1.0 : 0.0);
  }
  oC = vec4(n, 0.0, 1.0);
}
`;
export const raysTotalFrag = (g) => /* glsl */ `
${listGLSL(g)}
uniform sampler2D tRows;
out vec4 oC;
void main() {
  vec4 n = vec4(0.0);
  for (int v = 0; v < RTEX; v++) n += texelFetch(tRows, ivec2(v, 0), 0);
  oC = n;
}
`;

// Point draws over the list (one vertex per slot, gl_VertexID), into a target
// of the state's layout (deposits) or the bricks' (occupancy). A slot with
// nothing to draw is put outside the clip volume.
const OFF_CLIP = 'vec4(2.0, 2.0, 2.0, 1.0)';
export const raysDepositVert = (g) => /* glsl */ `
${listGLSL(g)}
out vec2 vDep;
void main() {
  gl_PointSize = 1.0;
  vec4 l3 = texelFetch(tL3, slotTexel(gl_VertexID), 0);
  vDep = l3.yz;
  if (l3.x < 0.0) { gl_Position = ${OFF_CLIP}; return; }
  vec2 t = vec2(atlas(cellOfIndex(int(l3.x + 0.5)))) + 0.5;
  gl_Position = vec4(t / vec2(ATLAS_W, ATLAS_H) * 2.0 - 1.0, 0.0, 1.0);
}
`;
// uZero: write zeros (after react has taken them), with blending off
export const raysDepositFrag = /* glsl */ `
precision highp float;
in vec2 vDep;
uniform bool uZero;
out vec4 oC;
void main() { oC = uZero ? vec4(0.0) : vec4(vDep, 0.0, 0.0); }
`;
export const raysBrickVert = (g) => /* glsl */ `
${listGLSL(g)}
void main() {
  gl_PointSize = 1.0;
  vec4 l0 = texelFetch(tL0, slotTexel(gl_VertexID), 0);
  if (kindOf(l0) == RAY_NONE) { gl_Position = ${OFF_CLIP}; return; }
  ivec3 c = clamp(ivec3(floor(l0.xyz)), ivec3(0), ivec3(NX, NY, NZ) - 1);
  vec2 t = vec2(brickAtlas(c / BS)) + 0.5;
  gl_Position = vec4(t / vec2(BTX * BX, ${g.bheight}.0) * 2.0 - 1.0, 0.0, 1.0);
}
`;
export const raysBrickFrag = /* glsl */ `
precision highp float;
out vec4 oC;
void main() { oC = vec4(1.0); }
`;

// Drawing them (a three.js ShaderMaterial on THREE.Points in the volume's
// space, so positions are grid cells): photons in their colour, neutrons a
// faint cyan, fast ones brighter.
export const RAY_LOOK = {
  POINT_CELLS: 0.7,        // a point's diameter, cells
  POINT_MIN_PX: 1.5,       // ...and its limits on screen, px
  POINT_MAX_PX: 24,
  PHOTON_GLOW: 2.5,        // brightness of a white photon (additive, linear)
  NEUT_GLOW: 0.5,          // ...of a fast neutron; a thermal one is NEUT_THERMAL_GLOW of that
  NEUT_THERMAL_GLOW: 0.4,
  NEUT_COLOR: [0.015, 0.75, 1.0],   // TPT NEUT's #20E0FF, linear
};
const lookGLSL = Object.entries(RAY_LOOK).map(([k, v]) => `#define RAY_${k} ${Array.isArray(v) ? `vec3(${v.join(', ')})` : v.toFixed(3)}`).join('\n');
export const raysDrawVert = /* glsl */ `
${raysGLSL().split('\n').filter((l) => l.startsWith('#define')).join('\n')}
${lookGLSL}
#define RTEX int(RAY_TEX)
uniform sampler2D tL0;
uniform sampler2D tL2;
uniform float uPointPx;   // px per (cell · 1/view distance): the projection's scale
out vec3 vCol;
void main() {
  ivec2 f = ivec2(gl_VertexID % RTEX, gl_VertexID / RTEX);
  vec4 l0 = texelFetch(tL0, f, 0);
  int kind = int(floor(l0.w + 0.5));
  if (kind == RAY_NONE) { gl_Position = ${OFF_CLIP}; gl_PointSize = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(l0.xyz, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uPointPx * RAY_POINT_CELLS / max(-mv.z, 1e-3), RAY_POINT_MIN_PX, RAY_POINT_MAX_PX);
  vec4 l2 = texelFetch(tL2, f, 0);
  float fast = clamp(log(l2.x / NEUT_E_THERMAL) / log(NEUT_E_FAST / NEUT_E_THERMAL), 0.0, 1.0);
  vCol = kind == RAY_PHOTON ? l2.rgb * RAY_PHOTON_GLOW
       : RAY_NEUT_COLOR * RAY_NEUT_GLOW * mix(RAY_NEUT_THERMAL_GLOW, 1.0, fast);
}
`;
export const raysDrawFrag = /* glsl */ `
in vec3 vCol;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float k = 1.0 - r2;
  gl_FragColor = vec4(vCol * k * k, 1.0);
}
`;

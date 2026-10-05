import { prelude } from './common.js';
import { materialsGLSL } from '../gfx/materials.js';

// Render fields: continuous versions of the blocky state, rebuilt once per
// frame for the renderer only (the simulation never reads them).
//
// 1. EMA pass: per cell, one-hot occupancy of each smooth-surface channel,
//    media densities and heat, blended toward the previous frame's values
//    (temporal smoothing, so cells swapping every sim step don't shimmer).
// 2. Three separable 5-tap Gaussian passes (x, y, z) with a per-channel
//    radius. The last pass normalises by the blurred "non-crisp" weight, so
//    walls, the floor and the box sides count neither way: a liquid film one
//    cell deep keeps its height, and surfaces meet walls at a clean angle.
//
// 3. Thin-feature boost: six separable passes over the 3-cell neighbourhood.
//    The first three (x, y, z) smooth the cubic channels (liquids) with the
//    B-spline's lattice weights, which is what the tracer's cubic sample reads
//    at a cell centre (other channels pass through), and find whether the
//    channel holds any of the 3³ cells right now. The last three find each
//    channel's local peak of that. Next to current matter, a feature whose
//    peak is under the channel's bulk peak (gfx/materials.js bulkPeak,
//    bulkPeakCubic) is scaled up so its surface sits THIN_RADIUS from the cell
//    centre instead of blurring away: lone grains and droplets, one-cell
//    trunks, films, streams. Ghosts of cells that moved on hold no matter now,
//    so they still fade with the EMA.
//
// Attachments (RGBA): 0 = surface channels (liquid, molten, granular,
// organic), 1 = media (smoke, steam, fire, heat), 2 = non-crisp weight, one
// copy per surface channel since each channel has its own blur radius (the
// media share the liquid kernel and its weight).
// Final output: 0 = surface φ (0.5 is the surface), 1 = media densities,
// 2 = thin mask, rising from 0 to 1 with a channel's boost (THIN_MASK_LO..HI).
// Only cubic channels need it: the tracer reads them cubic only there (bulk
// surfaces read the same either way, and trilinear is 8x cheaper).

export const fieldEmaFrag = (g) => /* glsl */ `
${prelude(g)}
${materialsGLSL()}
uniform sampler2D tA;
uniform sampler2D tP0;
uniform sampler2D tP1;
uniform vec4 uEmaS;
uniform vec4 uEmaM;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec3 p = cellFromFrag(f);
  if (p.y >= NY) { o0 = o1 = o2 = vec4(0.0); return; }
  vec4 a = texelFetch(tA, f, 0);
  int id = eid(a);
  vec4 s = vec4(0.0), m = vec4(0.0);
  int ch = SURFCH[id], md = MEDIACH[id];
  bool crisp = id != E_EMPTY && ch < 0 && md < 0;
  if (ch >= 0) s[ch] = 1.0;
  if (md == MD_SMOKE) m.x = clamp(a.z, 0.0, 1.0);
  else if (md == MD_STEAM) m.y = 1.0;
  else if (md == MD_FIRE) m.z = 0.4 + 0.6 * clamp(a.z, 0.0, 1.0);
  if (!crisp) m.w = clamp((a.y - AMBIENT) / HEAT_RANGE, 0.0, 1.0);
  o0 = mix(texelFetch(tP0, f, 0), s, uEmaS);
  o1 = mix(texelFetch(tP1, f, 0), m, uEmaM);
  o2 = vec4(crisp ? 0.0 : 1.0);
}
`;

export const fieldBlurFrag = (g, final) => /* glsl */ `
${prelude(g)}
uniform sampler2D t0;
uniform sampler2D t1;
uniform sampler2D t2;
uniform int uAxis;
uniform vec4 uW[5];   // per-tap weights, one per surface channel (media use .x)
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
${final ? '' : 'layout(location = 2) out vec4 o2;'}
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  if (p.y >= NY) { o0 = o1 = vec4(0.0); ${final ? '' : 'o2 = vec4(0.0);'} return; }
  ivec3 dir = uAxis == 0 ? ivec3(1, 0, 0) : (uAxis == 1 ? ivec3(0, 1, 0) : ivec3(0, 0, 1));
  vec4 s = vec4(0.0), m = vec4(0.0), d = vec4(0.0);
  for (int i = 0; i < 5; i++) {
    ivec3 q = p + dir * (i - 2);
    if (!inGrid(q)) continue;   // outside the box = crisp
    ivec2 t = atlas(q);
    vec4 w = uW[i];
    s += w * texelFetch(t0, t, 0);
    m += w.x * texelFetch(t1, t, 0);
    d += w * texelFetch(t2, t, 0);
  }
${final ? `
  // normalise; deep inside crisp solids there is nothing to normalise by
  vec4 ok = step(vec4(0.02), d);
  o0 = ok * s / max(d, vec4(0.02));
  o1 = ok.x * m / max(d.x, 0.02);
` : `
  o0 = s; o1 = m; o2 = d;
`}
}
`;

// Stages 0-2 (x, y, z): lattice smoothing of φ (stage 0 reads φ and the
// state, later stages their predecessor) and the occupancy, dilated.
// Stages 3-5 (x, y, z): local peak of the smoothed field, occupancy passed
// along; stage 5 applies the boost to φ, passes the media through and writes
// the thin mask.
export const BOOST_STAGES = 6;
export const fieldBoostFrag = (g, stage) => /* glsl */ `
${prelude(g)}
${materialsGLSL()}
uniform sampler2D t0;   // stage 0: φ, else the previous stage's field
uniform sampler2D t1;   // stage 0: state A, else the occupancy so far
${stage < 3 ? 'uniform vec4 uS;      // per-channel centre weight of the lattice smoothing (1 = none)' : ''}
${stage === 5 ? `uniform sampler2D tPhi;
uniform sampler2D tMed;
uniform vec4 uBulk;     // per-channel bulk peak` : ''}
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;   // ${stage < 5 ? 'the scratch targets have three attachments: unused' : 'thin mask'}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec3 p = cellFromFrag(f);
  o2 = vec4(0.0);
  if (p.y >= NY) { o0 = o1 = vec4(0.0); return; }
  const ivec3 dir = ivec3(${['1, 0, 0', '0, 1, 0', '0, 0, 1'][stage % 3]});
  vec4 acc = vec4(0.0), occ = vec4(0.0);
  for (int i = -1; i <= 1; i++) {
${stage < 3 ? `    // clamped to the edge, like the tracer's cubic sample
    ivec3 q = clamp(p + dir * i, ivec3(0), ivec3(NX, NY, NZ) - 1);
    ivec2 t = atlas(q);
    acc += (i == 0 ? uS : 0.5 * (1.0 - uS)) * texelFetch(t0, t, 0);
${stage === 0 ? `    int ch = SURFCH[eid(texelFetch(t1, t, 0))];
    if (ch >= 0) occ[ch] = 1.0;` : '    occ = max(occ, texelFetch(t1, t, 0));'}` : `    ivec3 q = p + dir * i;
    if (inGrid(q)) acc = max(acc, texelFetch(t0, atlas(q), 0));`}
  }
${stage >= 3 ? '  occ = texelFetch(t1, f, 0);' : ''}
${stage === 5 ? `  vec4 k = max(vec4(1.0), uBulk / max(acc, vec4(THIN_MIN_PEAK)));
  vec4 boosted = step(0.5, occ);
  o0 = texelFetch(tPhi, f, 0) * mix(vec4(1.0), k, boosted);
  o1 = texelFetch(tMed, f, 0);
  o2 = boosted * smoothstep(vec4(THIN_MASK_LO), vec4(THIN_MASK_HI), k);` : `  o0 = acc;
  o1 = occ;`}
}
`;

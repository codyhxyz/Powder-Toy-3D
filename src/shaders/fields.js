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
// Attachments (RGBA): 0 = surface channels (liquid, molten, granular,
// organic), 1 = media (smoke, steam, fire, heat), 2 = non-crisp weight, one
// copy per surface channel since each channel has its own blur radius (the
// media share the liquid kernel and its weight).
// Final output: 0 = surface φ (0.5 is the surface), 1 = media densities.

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

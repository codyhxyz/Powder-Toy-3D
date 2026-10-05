import { prelude } from './common.js';
import { MEDIA_FLOOR } from '../gfx/materials.js';

// Brush: spawns elements / applies tools inside a sphere or cube.
export const paintFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tA;
uniform sampler2D tB;
uniform uint uFrame;
uniform vec3 uCenter;
uniform float uRadius;
uniform int uShape;     // 0 sphere, 1 cube
uniform int uTool;      // element id, or negative tool id
uniform float uRate;    // spawn density multiplier
uniform bool uReplace;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;

void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  vec4 a = texelFetch(tA, ivec2(gl_FragCoord.xy), 0);
  vec4 b = texelFetch(tB, ivec2(gl_FragCoord.xy), 0);
  oA = a; oB = b;
  if (p.y >= NY) return;

  vec3 d = vec3(p) + 0.5 - uCenter;
  float r = uShape == 0 ? length(d) : max(abs(d.x), max(abs(d.y), abs(d.z)));
  if (r > uRadius) return;
  float falloff = 1.0 - smoothstep(uRadius * 0.6, uRadius + 0.001, r);

  uint rs = seed3(p, uFrame, 0xb7u);
  int id = eid(a);

  if (uTool >= 0) {
    if (id == uTool) return;
    if (id != E_EMPTY && !uReplace) return;
    if (rnd(rs) > SPAWNDENS[uTool] * uRate) return;
    float T = SPAWNT[uTool];
    float ctype = uTool == E_LAVA ? float(E_STONE) : 0.0;
    oA = vec4(float(uTool), T, SPAWNLIFE[uTool], ctype + rnd(rs) * 0.999);
    float vy = KIND[uTool] == K_POWDER || KIND[uTool] == K_LIQUID ? -0.3 : 0.0;
    oB = vec4(0.0, vy, 0.0, b.w);
  } else if (uTool == T_ERASE) {
    oA = vec4(float(E_EMPTY), AMBIENT, 0.0, rnd(rs) * 0.999);
    oB = vec4(0.0, 0.0, 0.0, b.w);
  } else if (uTool == T_HEAT) {
    oA.y = min(a.y + 30.0 * falloff, 6000.0);
  } else if (uTool == T_COOL) {
    oA.y = max(a.y - 30.0 * falloff, -273.15);
  } else if (uTool == T_BLAST) {
    oB.w = b.w + 6.0 * falloff;
  }
}
`;

// Initialise both MRT attachments from uploaded data textures.
export const copyFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tA;
uniform sampler2D tB;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  oA = texelFetch(tA, ivec2(gl_FragCoord.xy), 0);
  oB = texelFetch(tB, ivec2(gl_FragCoord.xy), 0);
}
`;

// Brick pass: one texel per 4×4×4 brick. rgb = average emitted light (lava,
// fire, glowing-hot metal), later blurred into a coarse light volume.
// a also carries what each brick holds, and flags for what the data views draw
// in air (1 warmer/colder than ambient, 2 pressure, 4 moving):
//   0                          empty
//   1 + gas/64 + 2·media + 4·surf + flags/65536
//                              holds matter (gas = steam/smoke cells), or a
//                              smooth surface / media field reaches into it.
//                              The render fields are already blurred, so a brick
//                              next to a surface or plume sees them in its own
//                              cells: the skip map is dilated for free. The
//                              flags sit below the 1/64 step.
//   -(1 + flags/8)             only air, but air a data view draws; the
//                              realistic view, picking and the shadow map
//                              skip it like an empty brick (they test a < 0.5)
export const brickFrag = (g) => /* glsl */ `
${prelude(g)}
#define MEDIA_FLOOR ${MEDIA_FLOOR}   // gas density the renderer treats as none (gfx/materials.js)
uniform sampler2D tA;
uniform sampler2D tB;
uniform sampler2D tFS;
uniform sampler2D tFM;
uniform sampler2D tFT;   // thin-feature mask (x: liquid)
out vec4 oC;

// A hot opaque cell lights its surroundings only through its open faces: buried
// lava or a conduit of hot rock casts no light. Per open face it counts as the
// brick-deep column under a flat surface did when every hot cell counted.
#define GLOW_FACE_GAIN float(BS)
float openFaces(ivec3 c) {
  float n = 0.0;
  for (int k = 0; k < 6; k++) {
    ivec3 q = c;
    q[k >> 1] += (k & 1) == 0 ? -1 : 1;
    if (q.y < 0) continue;                       // the floor
    if (!inGrid(q)) { n += 1.0; continue; }      // open sky past the box
    if (RCLASS[eid(texelFetch(tA, atlas(q), 0))] != R_OPAQUE) n += 1.0;
  }
  return n;
}

void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  if (bc.y >= BY) { oC = vec4(0.0); return; }
  float occ = 0.0, gas = 0.0, surf = 0.0, media = 0.0, opaque = 0.0, thin = 0.0;
  int flags = 0;
  int liq0 = E_EMPTY;     // first liquid-look element seen (liquids and ice)
  bool mixed = false;     // a second one too
  vec3 em = vec3(0.0);
  ivec3 o = bc * BS;
  for (int z = 0; z < BS; z++)
  for (int y = 0; y < BS; y++)
  for (int x = 0; x < BS; x++) {
    ivec2 t = atlas(o + ivec3(x, y, z));
    vec4 a = texelFetch(tA, t, 0);
    vec4 s = texelFetch(tFS, t, 0);
    vec4 m = texelFetch(tFM, t, 0);
    int id = eid(a);
    if (id != E_EMPTY) occ = 1.0;
    else if (abs(a.y - AMBIENT) > 3.0) flags |= 1;
    if (id == E_STEAM || id == E_SMOKE) gas += 1.0;
    surf = max(surf, max(max(s.x, s.y), max(s.z, s.w)));
    // something opaque (not liquid, glass or gas) here or in an opaque surface field
    if (id != E_EMPTY && KIND[id] != K_GAS && RCLASS[id] != R_LIQUID && RCLASS[id] != R_GLASS) opaque = 1.0;
    opaque = max(opaque, max(s.y, max(s.z, s.w)));
    thin = max(thin, texelFetch(tFT, t, 0).x);
    if (RCLASS[id] == R_LIQUID || id == E_ICE) {
      if (liq0 == E_EMPTY) liq0 = id;
      else if (id != liq0) mixed = true;
    }
    media = max(media, max(m.x, max(m.y, m.z)));
    if (id == E_FIRE) em += blackbody(a.y) * (0.6 + a.y / 1500.0) * 1.5;
    else if (id != E_EMPTY && KIND[id] != K_GAS && a.y > INCAND_T0) {
      // the light of the visible skin (metals have none to speak of)
      vec3 e = incandescence(a.y - (id == E_METAL ? 0.0 : INCAND_SKIN_DROP));
      if (dot(e, e) > 0.0) em += e * (RCLASS[id] == R_OPAQUE ? openFaces(o + ivec3(x, y, z)) * GLOW_FACE_GAIN : 1.0);
    }
  }
  // Pressure and air velocity are smooth fields, so the brick's 2×2×2 core is
  // a good enough sample (a full second pass over B would double this pass).
  float pm = 0.0, vm = 0.0;
  for (int z = 1; z < 3; z++)
  for (int y = 1; y < 3; y++)
  for (int x = 1; x < 3; x++) {
    vec4 b = texelFetch(tB, atlas(o + ivec3(x, y, z)), 0);
    pm = max(pm, abs(b.w));
    vm = max(vm, dot(b.xyz, b.xyz));
  }
  if (pm > 0.04) flags |= 2;
  if (vm > 0.05 * 0.05) flags |= 4;
  const float FIELD_HERE = 0.03;   // a surface field this strong may hold a surface nearby
  bool hasSurf = surf > FIELD_HERE, hasMedia = media > MEDIA_FLOOR, hasOpaque = opaque > FIELD_HERE;
  float air = flags > 0 ? -1.0 - float(flags) / 8.0 : 0.0;
  float matter = 1.0 + gas / 64.0 + (hasMedia ? 2.0 : 0.0) + (hasSurf ? 4.0 : 0.0) + (hasOpaque ? 8.0 : 0.0)
               + (thin > 0.0 ? 16.0 : 0.0) + (mixed ? 32.0 : 0.0) + float(flags) / 65536.0;
  oC = vec4(em / 64.0, (occ > 0.0 || hasSurf || hasMedia) ? matter : air);
}
`;

// Separable 5-tap blur over the brick grid (axis 0/1/2).
export const blurFrag = (g) => /* glsl */ `
${prelude(g)}
uniform sampler2D tSrc;
uniform int uAxis;
out vec4 oC;
void main() {
  ivec3 bc = brickFromFrag(ivec2(gl_FragCoord.xy));
  if (bc.y >= BY) { oC = vec4(0.0); return; }
  ivec3 dir = uAxis == 0 ? ivec3(1, 0, 0) : (uAxis == 1 ? ivec3(0, 1, 0) : ivec3(0, 0, 1));
  ivec3 hi = ivec3(BX, BY, BZ) - 1;
  const float W[5] = float[5](0.10, 0.22, 0.36, 0.22, 0.10);
  vec3 s = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    ivec3 q = bc + dir * (i - 2);
    if (any(lessThan(q, ivec3(0))) || any(greaterThan(q, hi))) continue;
    s += texelFetch(tSrc, brickAtlas(q), 0).rgb * W[i];
  }
  oC = vec4(s * 1.15, 1.0);
}
`;

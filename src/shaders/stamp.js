import { prelude } from './common.js';
import { MAX_FOOT } from '../constructions/runtime.js';

export { MAX_FOOT };

// Stamp pass: writes a construction (a small 3D texture) into the grid.
//
// Stamp texel: x = element id + 1 (0 leaves the cell alone, 1 carves air),
// y = temperature, z = ctype, w = 1 when the cell is part of the base and may
// grow a footing. A footing column extends that cell's element straight down,
// but only through cells that can't bear weight (air, gas, liquid) and only if
// it reaches ground within uFoot cells, so a house on a slope gets a plinth and
// one in a lake stands on stilts, while one placed in mid-air simply floats.
export const stampFrag = (g) => /* glsl */ `
${prelude(g)}
precision highp sampler3D;
uniform sampler2D tA;
uniform sampler2D tB;
uniform sampler3D tStamp;
uniform ivec3 uOrigin;
uniform ivec3 uSize;
uniform int uFoot;
uniform uint uSeed;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;

bool bearsWeight(ivec3 c) {
  int id = eid(texelFetch(tA, atlas(c), 0));
  return id != E_EMPTY && KIND[id] != K_GAS && KIND[id] != K_LIQUID;
}

void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec3 p = cellFromFrag(f);
  vec4 a = texelFetch(tA, f, 0);
  vec4 b = texelFetch(tB, f, 0);
  oA = a; oB = b;
  if (p.y >= NY) return;
  ivec3 q = p - uOrigin;
  if (q.x < 0 || q.z < 0 || q.x >= uSize.x || q.z >= uSize.z || q.y >= uSize.y || q.y < -uFoot) return;

  vec4 s;
  if (q.y >= 0) {
    s = texelFetch(tStamp, q, 0);
  } else {
    s = texelFetch(tStamp, ivec3(q.x, 0, q.z), 0);
    if (s.w < 0.5) return;
    // nothing that bears weight between this cell and the base...
    for (int i = 1; i <= ${MAX_FOOT}; i++) {
      int y = uOrigin.y - i;
      if (y < p.y) break;
      if (bearsWeight(ivec3(p.x, y, p.z))) return;
    }
    // ...and ground somewhere below it, within reach
    bool ground = false;
    for (int i = 1; i <= ${MAX_FOOT}; i++) {
      int y = uOrigin.y - i;
      if (i > uFoot) break;
      if (y < 0 || bearsWeight(ivec3(p.x, y, p.z))) { ground = true; break; }
    }
    if (!ground) return;
  }
  if (s.x < 0.5) return;

  int id = int(s.x + 0.5) - 1;
  uint rs = seed3(p, uSeed, 0x57a3u);
  oA = vec4(float(id), s.y, SPAWNLIFE[id], s.z + rnd(rs) * 0.999);
  oB = vec4(0.0, 0.0, 0.0, b.w);
}
`;

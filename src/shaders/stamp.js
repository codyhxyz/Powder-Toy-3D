import { prelude, stateOutGLSL, copyThroughMain } from './common.js';
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
uniform sampler3D tStamp;
uniform ivec3 uAt;     // grid cell of the stamp's low corner
uniform ivec3 uSize;
uniform int uFoot;
uniform uint uSeed;
${stateOutGLSL}

bool bearsWeight(ivec3 c) {
  int id = eid(fetchA(c));
  return id != E_EMPTY && KIND[id] != K_GAS && KIND[id] != K_LIQUID;
}

void stamp(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  ivec3 q = p - uAt;
  if (q.x < 0 || q.z < 0 || q.x >= uSize.x || q.z >= uSize.z || q.y >= uSize.y || q.y < -uFoot) return;

  vec4 s;
  if (q.y >= 0) {
    s = texelFetch(tStamp, q, 0);
  } else {
    s = texelFetch(tStamp, ivec3(q.x, 0, q.z), 0);
    if (s.w < 0.5) return;
    // nothing that bears weight between this cell and the base...
    for (int i = 1; i <= ${MAX_FOOT}; i++) {
      int y = uAt.y - i;
      if (y < p.y) break;
      if (bearsWeight(ivec3(p.x, y, p.z))) return;
    }
    // ...and ground somewhere below it, within reach
    bool ground = false;
    for (int i = 1; i <= ${MAX_FOOT}; i++) {
      int y = uAt.y - i;
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
${copyThroughMain('stamp')}`;

// Many stamps in one pass: the world window's trees (world/window.js,
// docs/scaling.md D11), which would otherwise cost a full-grid pass each.
// Stamp i is the box of tStamps at x offset uStampBox[i].w, size
// uStampBox[i].xyz, placed with its low corner at grid cell uStampAt[i], with
// footing depth and seed uStampFoot[i], uStampSeed[i]; it reads like stampFrag.
// Where stamps overlap the later one wins, as if stamped one after another.
// Footings read the state from before the pass (one after another, they could
// meet an earlier stamp's cells; trees stand too far apart for that). Only
// cells whose brick column is set in tColMask (r > 0.5; one texel per grid
// brick column x, z) are written: a window shift plants only the columns it
// visits for the first time.
export const MAX_STAMPS = 32;
export const stampManyFrag = (g) => /* glsl */ `
${prelude(g)}
precision highp sampler3D;
#define MAX_STAMPS ${MAX_STAMPS}
#define STAMP_RNG_SALT 0x57a3u   // a stamped cell's colour seed (stampFrag's stream)
uniform sampler3D tStamps;
uniform sampler2D tColMask;
uniform int uStampCount;
uniform ivec3 uStampAt[MAX_STAMPS];
uniform ivec4 uStampBox[MAX_STAMPS];
uniform int uStampFoot[MAX_STAMPS];
uniform uint uStampSeed[MAX_STAMPS];
${stateOutGLSL}

bool bearsWeight(ivec3 c) {
  int id = eid(fetchA(c));
  return id != E_EMPTY && KIND[id] != K_GAS && KIND[id] != K_LIQUID;
}

// Does a footing reach down from base height y0 to grid cell p (stampFrag's rule)?
bool footing(ivec3 p, int y0, int foot) {
  for (int i = 1; i <= ${MAX_FOOT}; i++) {
    int y = y0 - i;
    if (y < p.y) break;
    if (bearsWeight(ivec3(p.x, y, p.z))) return false;
  }
  for (int i = 1; i <= ${MAX_FOOT}; i++) {
    int y = y0 - i;
    if (i > foot) break;
    if (y < 0 || bearsWeight(ivec3(p.x, y, p.z))) return true;
  }
  return false;
}

void stampMany(ivec3 p, vec4 a, vec4 b, inout vec4 oA, inout vec4 oB) {
  if (texelFetch(tColMask, p.xz / BS, 0).r < 0.5) return;
  for (int i = 0; i < MAX_STAMPS; i++) {
    if (i >= uStampCount) break;
    ivec3 q = p - uStampAt[i];
    ivec4 box = uStampBox[i];
    int foot = uStampFoot[i];
    if (q.x < 0 || q.z < 0 || q.x >= box.x || q.z >= box.z || q.y >= box.y || q.y < -foot) continue;
    vec4 s = texelFetch(tStamps, ivec3(box.w + q.x, max(q.y, 0), q.z), 0);
    if (q.y < 0 && (s.w < 0.5 || !footing(p, uStampAt[i].y, foot))) continue;
    if (s.x < 0.5) continue;
    int id = int(s.x + 0.5) - 1;
    uint rs = seed3(p, uStampSeed[i], STAMP_RNG_SALT);
    oA = vec4(float(id), s.y, SPAWNLIFE[id], s.z + rnd(rs) * SEED_MAX);
    oB = vec4(0.0, 0.0, 0.0, b.w);
  }
}
${copyThroughMain('stampMany')}`;

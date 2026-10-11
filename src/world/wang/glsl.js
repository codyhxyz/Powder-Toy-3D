import { E } from '../../elements.js';
import { MAT, MAT_NAMES, MAT_COUNT, COL, SIDE_PORTS, WANG_OUT, WANG_NO_TEMP, compileKit } from './kit.js';
import { SOLID_TILE } from './tiling.js';

// The GPU sampler of a baked Wang tiling (bake.js): GLSL to include after the
// prelude in a scene's glsl(g). It defines
//   int wangCell(ivec3 w)      the kit's material code at world cell w (MAT in
//                              kit.js; WANG_OUT outside the tiled region): two
//                              texel fetches (the unit's placement, the tile's
//                              cell) and a few compares for the ports
//   int wangElement(int code)  the element (elements.js id) a code is, by the kit's palette
//   float wangTemp(int code)   the °C the kit lays it down at (its temps), else WANG_NO_TEMP
// and declares the uniforms bakeWang's uniforms() binds:
//   tWangAtlas   usampler3D R8UI: every tile's cells in its canonical frame
//   tWangPlace   usampler3D RGBA8UI: per unit (x, k, layer) its tile, transform, ports
//   uWangOrigin  ivec3: the region's low corner in world cells
//   uWangUnits   ivec3: the region in units (x, layers, z)
// Its CPU twin is tiling.js makeSampler (bake.js wangCellJS): keep them in step.
export function wangGLSL(rawKit) {
  const kit = rawKit.geom && rawKit.tiles[0]?.accepts ? rawKit : compileKit(rawKit);
  const G = kit.geom;
  const elemOf = (name) => {
    const id = E[kit.palette[name]];
    if (id === undefined) throw new Error(`wang: kit ${kit.name} palette ${name}: no element ${kit.palette[name]}`);
    return id;
  };
  const palette = MAT_NAMES.slice(0, MAT_COUNT).map(elemOf);
  const temps = MAT_NAMES.slice(0, MAT_COUNT).map((n) => (kit.temps?.[n] ?? WANG_NO_TEMP).toFixed(1));
  return /* glsl */ `
precision highp usampler3D;
uniform usampler3D tWangAtlas;
uniform usampler3D tWangPlace;
uniform ivec3 uWangOrigin;
uniform ivec3 uWangUnits;
#define WANG_U ${G.U}
#define WANG_H ${G.H}
#define WANG_BORDER ${G.BORDER}
#define WANG_FLOOR ${G.FLOOR}
#define WANG_HIGH_FLOOR ${G.HIGH_FLOOR}
#define WANG_DOOR_W ${G.DOOR_W}
#define WANG_DOOR_H ${G.DOOR_H}
#define WANG_PORT_DEPTH ${G.PORT_DEPTH}
#define WANG_PORT_DEPTH_SIDE ${G.PORT_DEPTH_SIDE}
#define WANG_FRAME_DEPTH ${G.FRAME_DEPTH}
#define WANG_RAIL_GAUGE ${G.RAIL_GAUGE}
#define WANG_SHAFT_W ${G.SHAFT_W}
#define WANG_SHAFT_CUT ${G.SHAFT_CUT}
#define WANG_JITTER ${G.JITTER}
#define WANG_OPEN ${G.OPEN ? 1 : 0}
#define WANG_SPINE ${G.SPINE ?? 0}
#define WANG_JITTER_BIT 16u
#define WANG_SIDE_PORTS ${SIDE_PORTS}
#define WANG_COL_RAIL ${COL.RAIL}
#define WANG_COL_HIGH ${COL.HIGH}
#define WANG_SOLID_TILE ${SOLID_TILE}u
#define WANG_ATLAS_PER_COL ${Math.floor(256 / G.U)}
#define WANG_XF_TRANSPOSE 4u
#define WANG_XF_SECOND 8u
#define WANG_OUT ${WANG_OUT}
${MAT_NAMES.map((n) => `#define WANG_${n} ${MAT[n]}`).join('\n')}
const int WANG_PALETTE[${MAT_COUNT}] = int[${MAT_COUNT}](${palette.join(', ')});
int wangElement(int code) { return code >= 0 && code < ${MAT_COUNT} ? WANG_PALETTE[code] : ${E.ROCK}; }
#define WANG_NO_TEMP ${WANG_NO_TEMP.toFixed(1)}
const float WANG_TEMP[${MAT_COUNT}] = float[${MAT_COUNT}](${temps.join(', ')});
// the temperature the kit lays a code down at (its temps), WANG_NO_TEMP for its element's own
float wangTemp(int code) { return code >= 0 && code < ${MAT_COUNT} ? WANG_TEMP[code] : WANG_NO_TEMP; }

uint wangHash(ivec3 r) {
  uint h = (uint(r.x) * 0x8da6b343u) ^ (uint(r.y) * 0xd8163841u) ^ (uint(r.z) * 0xcb1ab31fu);
  h = (h ^ (h >> 15)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12)) * 0x297a2d39u;
  return h ^ (h >> 15);
}
// The ports a placed tile has open, cut into its cell (canonical c, region-relative r)
int wangPorts(int code, int ports, ivec3 c, ivec3 r) {
  int half_ = WANG_DOOR_W / 2;
  int j = int((wangHash(r) >> WANG_JITTER_BIT) & 1u) * WANG_JITTER;
  for (int p = 0; p < WANG_SIDE_PORTS; p++) {
    int col = (ports >> (2 * p)) & 3;
    if (col == 0) continue;
    int depth, lat;
    if (p < 2) { depth = p == 0 ? c.x : 2 * WANG_U - 1 - c.x; lat = c.z - WANG_U / 2; }
    else { int unit = (p - 2) & 1; depth = p < 4 ? c.z : WANG_U - 1 - c.z; lat = c.x - unit * WANG_U - WANG_U / 2; }
    if (depth >= (p < 2 ? WANG_PORT_DEPTH : WANG_PORT_DEPTH_SIDE)) continue;
    int yb = col == WANG_COL_HIGH ? WANG_HIGH_FLOOR : WANG_FLOOR;
    if (c.y < yb || c.y >= yb + WANG_DOOR_H + j || lat < -half_ - j || lat >= half_ + j) continue;
    if (c.y >= yb + WANG_DOOR_H || lat < -half_ || lat >= half_) { code = WANG_AIR; continue; }
    if (depth == WANG_FRAME_DEPTH && (lat == -half_ || lat == half_ - 1 || c.y == yb + WANG_DOOR_H - 1)) return WANG_BEAM;
    if (col == WANG_COL_RAIL && c.y == yb && (lat == -WANG_RAIL_GAUGE / 2 || lat == WANG_RAIL_GAUGE / 2 - 1)) return WANG_RAIL;
    return WANG_AIR;
  }
  for (int p = 0; p < 4; p++) {
    if (((ports >> (2 * WANG_SIDE_PORTS + p)) & 1) == 0) continue;
    int unit = p & 1;
    int dx = c.x - unit * WANG_U - WANG_U / 2, dz = c.z - WANG_U / 2, sh = WANG_SHAFT_W / 2;
    if (dx < -sh || dx >= sh || dz < -sh || dz >= sh) continue;
    if (p >= 2 ? c.y >= WANG_H - WANG_BORDER : c.y < (WANG_OPEN == 1 ? WANG_SPINE + 1 : WANG_FLOOR + WANG_SHAFT_CUT)) return WANG_AIR;
  }
  return code;
}
int wangCell(ivec3 w) {
  ivec3 r = w - uWangOrigin;
  if (any(lessThan(r, ivec3(0)))) return WANG_OUT;
  ivec3 u = ivec3(r.x / WANG_U, r.y / WANG_H, r.z / WANG_U);
  if (any(greaterThanEqual(u, uWangUnits))) return WANG_OUT;
  uvec4 q = texelFetch(tWangPlace, ivec3(u.x, u.z, u.y), 0);
  if (q.r == WANG_SOLID_TILE) return WANG_ROCK;
  uint xf = q.g & 7u;
  bool tr = (xf & WANG_XF_TRANSPOSE) != 0u;
  ivec3 a = u;
  if ((q.g & WANG_XF_SECOND) != 0u) { if (tr) a.z -= 1; else a.x -= 1; }
  ivec3 l = r - ivec3(a.x * WANG_U, a.y * WANG_H, a.z * WANG_U);
  int ca = tr ? l.z : l.x, cb = tr ? l.x : l.z;
  ivec3 c = ivec3((xf & 1u) != 0u ? 2 * WANG_U - 1 - ca : ca, l.y, (xf & 2u) != 0u ? WANG_U - 1 - cb : cb);
  int tile = int(q.r);
  ivec3 t0 = ivec3(0, (tile / WANG_ATLAS_PER_COL) * WANG_H, (tile % WANG_ATLAS_PER_COL) * WANG_U);
  int code = int(texelFetch(tWangAtlas, t0 + c, 0).r);
  // an open kit's caps (kit.js openCap)
  if (WANG_OPEN == 1 && ((u.y == uWangUnits.y - 1 && c.y >= WANG_H - WANG_BORDER) || (u.y == 0 && c.y < WANG_FLOOR))) code = WANG_ROCK;
  return wangPorts(code, int(q.b) | (int(q.a) << 8), c, r);
}
`;
}

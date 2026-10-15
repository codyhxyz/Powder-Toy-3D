import { E } from '../../elements.js';
import { MAT, MAT_NAMES, MAT_COUNT, COL, SIDE_PORTS, WANG_OUT, WANG_NO_TEMP, compileKit } from './kit.js';
import { SOLID_TILE } from './tiling.js';

// The GPU sampler of a baked Wang tiling (bake.js): WGSL to include after the
// prelude and the scene's head in a scene's glsl(g) (the name is the GLSL
// version's, docs/webgpu.md W2). It defines
//   fn wangCell(w: vec3i) -> i32      the kit's material code at world cell w (MAT in
//                                     kit.js; WANG_OUT outside the tiled region): two
//                                     data reads (the unit's placement, the tile's
//                                     cell) and a few compares for the ports
//   fn wangElement(code: i32) -> i32  the element (elements.js id) a code is, by the kit's palette
//   fn wangTemp(code: i32) -> f32     the °C the kit lays it down at (its temps), else WANG_NO_TEMP
// and reads the scene's uniform fields WANG_FIELDS and its data (sdWord,
// scenes/sceneGpu.js), as wangData lays them out: the palette (a word a code),
// the temps (f32 bits a code), the placement (a word a unit: tile, transform,
// the port colours' two bytes; unit (x, layer, z) at x + nx · (z + nz ·
// layer)) and the atlas (four cells a word: every tile's cells in its
// canonical frame). Its CPU twin is tiling.js makeSampler (bake.js
// wangCellJS): keep them in step.
export const WANG_FIELDS = {
  uWangOrigin: 'vec3i',    // the region's low corner in world cells
  uWangUnits: 'vec3i',     // the region in units (x, layers, z)
  uWangPlaceAt: 'u32',     // the placement's first word in SD
  uWangAtlasAt: 'u32',     // the atlas's first word in SD
  uWangAX: 'i32',          // the atlas's size along x and y, cells
  uWangAY: 'i32',
};
export function wangGLSL(rawKit) {
  const kit = rawKit.geom && rawKit.tiles[0]?.accepts ? rawKit : compileKit(rawKit);
  const G = kit.geom;
  return /* wgsl */ `
const WANG_U: i32 = ${G.U};
const WANG_H: i32 = ${G.H};
const WANG_BORDER: i32 = ${G.BORDER};
const WANG_FLOOR: i32 = ${G.FLOOR};
const WANG_HIGH_FLOOR: i32 = ${G.HIGH_FLOOR};
const WANG_DOOR_W: i32 = ${G.DOOR_W};
const WANG_DOOR_H: i32 = ${G.DOOR_H};
const WANG_PORT_DEPTH: i32 = ${G.PORT_DEPTH};
const WANG_PORT_DEPTH_SIDE: i32 = ${G.PORT_DEPTH_SIDE};
const WANG_FRAME_DEPTH: i32 = ${G.FRAME_DEPTH};
const WANG_RAIL_GAUGE: i32 = ${G.RAIL_GAUGE};
const WANG_SHAFT_W: i32 = ${G.SHAFT_W};
const WANG_SHAFT_CUT: i32 = ${G.SHAFT_CUT};
const WANG_JITTER: i32 = ${G.JITTER};
const WANG_OPEN: i32 = ${G.OPEN ? 1 : 0};
const WANG_SPINE: i32 = ${G.SPINE ?? 0};
const WANG_JITTER_BIT: u32 = 16u;
const WANG_SIDE_PORTS: i32 = ${SIDE_PORTS};
const WANG_COL_RAIL: i32 = ${COL.RAIL};
const WANG_COL_HIGH: i32 = ${COL.HIGH};
const WANG_SOLID_TILE: u32 = ${SOLID_TILE}u;
const WANG_ATLAS_PER_COL: i32 = ${Math.floor(256 / G.U)};
const WANG_XF_TRANSPOSE: u32 = 4u;
const WANG_XF_SECOND: u32 = 8u;
const WANG_OUT: i32 = ${WANG_OUT};
const WANG_MAT_COUNT: i32 = ${MAT_COUNT};
${MAT_NAMES.map((n) => `const WANG_${n}: i32 = ${MAT[n]};`).join('\n')}
const WANG_NO_TEMP: f32 = ${WANG_NO_TEMP.toFixed(1)};
// the element a code is (the kit's palette: SD's first MAT_COUNT words)
fn wangElement(code: i32) -> i32 {
  if (code >= 0 && code < WANG_MAT_COUNT) { return bitcast<i32>(sdWord(u32(code))); }
  return ${E.ROCK};
}
// the temperature the kit lays a code down at (its temps), WANG_NO_TEMP for its element's own
fn wangTemp(code: i32) -> f32 {
  if (code >= 0 && code < WANG_MAT_COUNT) { return bitcast<f32>(sdWord(u32(WANG_MAT_COUNT + code))); }
  return WANG_NO_TEMP;
}

fn wangHash(r: vec3i) -> u32 {
  var h = (u32(r.x) * 0x8da6b343u) ^ (u32(r.y) * 0xd8163841u) ^ (u32(r.z) * 0xcb1ab31fu);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  return h ^ (h >> 15u);
}
// The ports a placed tile has open, cut into its cell (canonical c, region-relative r)
fn wangPorts(code_in: i32, ports: i32, c: vec3i, r: vec3i) -> i32 {
  return materialId(wangPortsMaterial(code_in, ports, c, r));
}
fn wangPortsMaterial(code_in: i32, ports: i32, c: vec3i, r: vec3i) -> i32 {
  var code = code_in;
  let half_ = WANG_DOOR_W / 2;
  let j = i32((wangHash(r) >> WANG_JITTER_BIT) & 1u) * WANG_JITTER;
  for (var p = 0; p < WANG_SIDE_PORTS; p++) {
    let col = (ports >> u32(2 * p)) & 3;
    if (col == 0) { continue; }
    var depth: i32;
    var lat: i32;
    if (p < 2) {
      depth = select(2 * WANG_U - 1 - c.x, c.x, p == 0);
      lat = c.z - WANG_U / 2;
    } else {
      let unit = (p - 2) & 1;
      depth = select(WANG_U - 1 - c.z, c.z, p < 4);
      lat = c.x - unit * WANG_U - WANG_U / 2;
    }
    if (depth >= select(WANG_PORT_DEPTH_SIDE, WANG_PORT_DEPTH, p < 2)) { continue; }
    let yb = select(WANG_FLOOR, WANG_HIGH_FLOOR, col == WANG_COL_HIGH);
    if (c.y < yb || c.y >= yb + WANG_DOOR_H + j || lat < -half_ - j || lat >= half_ + j) { continue; }
    if (c.y >= yb + WANG_DOOR_H || lat < -half_ || lat >= half_) { code = WANG_AIR; continue; }
    if (depth == WANG_FRAME_DEPTH && (lat == -half_ || lat == half_ - 1 || c.y == yb + WANG_DOOR_H - 1)) { return materialWord(WANG_BEAM, select(AP_PLANK_Y, select(AP_PLANK_X, AP_PLANK_Z, p < 2), c.y == yb + WANG_DOOR_H - 1)); }
    if (col == WANG_COL_RAIL && c.y == yb && (lat == -WANG_RAIL_GAUGE / 2 || lat == WANG_RAIL_GAUGE / 2 - 1)) { return WANG_RAIL; }
    return WANG_AIR;
  }
  for (var p = 0; p < 4; p++) {
    if (((ports >> u32(2 * WANG_SIDE_PORTS + p)) & 1) == 0) { continue; }
    let unit = p & 1;
    let dx = c.x - unit * WANG_U - WANG_U / 2;
    let dz = c.z - WANG_U / 2;
    let sh = WANG_SHAFT_W / 2;
    if (dx < -sh || dx >= sh || dz < -sh || dz >= sh) { continue; }
    var cut: bool;
    if (p >= 2) { cut = c.y >= WANG_H - WANG_BORDER; }
    else { cut = c.y < select(WANG_FLOOR + WANG_SHAFT_CUT, WANG_SPINE + 1, WANG_OPEN == 1); }
    if (cut) { return WANG_AIR; }
  }
  return code;
}
fn wangCell(w: vec3i) -> i32 {
  return materialId(wangCellMaterial(w));
}
fn wangCellMaterial(w: vec3i) -> i32 {
  let r = w - SU.uWangOrigin;
  if (any(r < vec3i(0))) { return WANG_OUT; }
  let u = vec3i(r.x / WANG_U, r.y / WANG_H, r.z / WANG_U);
  if (any(u >= SU.uWangUnits)) { return WANG_OUT; }
  let qw = sdWord(SU.uWangPlaceAt + u32(u.x + SU.uWangUnits.x * (u.z + SU.uWangUnits.z * u.y)));
  let q = vec4u(qw & 255u, (qw >> 8u) & 255u, (qw >> 16u) & 255u, qw >> 24u);
  if (q.r == WANG_SOLID_TILE) { return WANG_ROCK; }
  let xf = q.g & 7u;
  let tr = (xf & WANG_XF_TRANSPOSE) != 0u;
  var a = u;
  if ((q.g & WANG_XF_SECOND) != 0u) { if (tr) { a.z -= 1; } else { a.x -= 1; } }
  let l = r - vec3i(a.x * WANG_U, a.y * WANG_H, a.z * WANG_U);
  let ca = select(l.x, l.z, tr);
  let cb = select(l.z, l.x, tr);
  let c = vec3i(select(ca, 2 * WANG_U - 1 - ca, (xf & 1u) != 0u), l.y, select(cb, WANG_U - 1 - cb, (xf & 2u) != 0u));
  let tile = i32(q.r);
  let t0 = vec3i(0, (tile / WANG_ATLAS_PER_COL) * WANG_H, (tile % WANG_ATLAS_PER_COL) * WANG_U);
  let ac = t0 + c;
  let ai = u32(ac.x + SU.uWangAX * (ac.y + SU.uWangAY * ac.z));
  let packed = i32((sdWord(SU.uWangAtlasAt + (ai >> 2u)) >> ((ai & 3u) * 8u)) & 255u);
  let axis = packed >> 6u;
  var code = materialWord(packed & 63, select(AP_NONE, AP_PLANK_X + axis - 1, axis != 0));
  // an open kit's caps (kit.js openCap)
  if (WANG_OPEN == 1 && ((u.y == SU.uWangUnits.y - 1 && c.y >= WANG_H - WANG_BORDER) || (u.y == 0 && c.y < WANG_FLOOR))) { code = WANG_ROCK; }
  let word = wangPortsMaterial(code, i32(q.b) | (i32(q.a) << 8u), c, r);
  var appearance = materialAppearance(word);
  if (tr) {
    if (appearance == AP_PLANK_X) { appearance = AP_PLANK_Z; }
    else if (appearance == AP_PLANK_Z) { appearance = AP_PLANK_X; }
  }
  return materialWord(materialId(word), appearance);
}
`;
}

/**
 * A bake's tables and tiling as the scene's integer data (SD) and the
 * uniform fields that find them (WANG_FIELDS): the palette and temps, the
 * placement, the atlas.
 * @param {{ kit: object, units: number[], origin: number[], atlas: { data: Uint8Array, dims: number[] }, placement: Uint8Array }} bake
 */
export function wangData({ kit, units, origin, atlas, placement }) {
  const palette = MAT_NAMES.slice(0, MAT_COUNT).map((n) => E[kit.palette[n]]);
  const temps = MAT_NAMES.slice(0, MAT_COUNT).map((n) => kit.temps?.[n] ?? WANG_NO_TEMP);
  const nPlace = units[0] * units[1] * units[2], nAtlas = Math.ceil(atlas.data.length / 4);
  const words = new Uint32Array(2 * MAT_COUNT + nPlace + nAtlas);
  words.set(Uint32Array.from(palette, (v) => v >>> 0), 0);
  new Float32Array(words.buffer, MAT_COUNT * 4, MAT_COUNT).set(temps);
  words.set(new Uint32Array(placement.buffer.slice(placement.byteOffset, placement.byteOffset + nPlace * 4)), 2 * MAT_COUNT);
  const packedAtlas = atlas.material ?? atlas.data;
  new Uint8Array(words.buffer, (2 * MAT_COUNT + nPlace) * 4, packedAtlas.length).set(packedAtlas);
  return {
    words,
    values: {
      uWangOrigin: origin, uWangUnits: units, uWangPlaceAt: 2 * MAT_COUNT, uWangAtlasAt: 2 * MAT_COUNT + nPlace,
      uWangAX: atlas.dims[0], uWangAY: atlas.dims[1],
    },
  };
}

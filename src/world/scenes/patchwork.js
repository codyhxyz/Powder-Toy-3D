import * as THREE from 'three';
import { WORLD_SEED } from '../generator.js';
import {
  PATCH_TILE, PATCH_TILE_BITS, PATCH_PRESETS, PATCH_LAB, PATCH_VOLCANO, PATCH_ISLAND, PATCH_MAP,
  PATCH_PALETTE_MAX, PATCH_AIR, PatchPalette, presetState, bakePreset, tileMap, tileOf, inTile, presetAt,
  islandGroundTwin,
} from './patchworkBake.js';
import { bakeIslandState } from './patchworkIsland.js';

// Patchwork: the world as a grid of box-sized tiles, each an exact copy of a
// box preset (lab, volcano or island; patchworkBake.js tileMap picks which),
// so you can walk out of one familiar scene into the next. Tiles meet edge to
// edge: a tile's sea beside its neighbour's air is generated as it is in the
// box, and flows once simulated.
//
// The presets are baked once into one byte per cell (patchworkBake.js): a
// Data3DTexture PATCH_TILE wide and tall with the three presets one after
// another along its depth (R8UI, 6.3 MB), whose bytes index a palette of the
// exact states (RGBA32F, 256 × 1). sceneCell looks up the tile's preset in a
// uniform map, then two texel fetches. Lab and volcano are built on the CPU
// (buildPreset, the first time anything asks); the island is generated on the
// GPU, so prepare() bakes it (patchworkIsland.js): until then its tiles are
// air and ground() uses the generator's JS twin there.

// The world's levels (params). There is no one open sea: the volcano's sea
// stands 8 cells deep, the island's 18, the lab has none, and each is matter
// in the tiles that hold it (so the far field and GI see it as it is). The far
// view and GI would put a sea at P.sea under every lab tile too, so none.
const PATCH_SEA = 0;      // cells: no open sea (scenes/index.js: 0 for none)
const PATCH_FLOOR = 0;    // cells: the lab and the volcano's sea stand on the world's bottom, no rock under them
// Salt of the cells' colour seeds (seedWorld's stream).
const PATCH_SALT_CELL = 0x9a7d;
// Palette texture: entries per row (one row holds them all).
const PATCH_PALETTE_W = PATCH_PALETTE_MAX;

// ---------------------------------------------------------------- the bake
// One bake, shared by every world and pass: the cells, the palette, and each
// preset's ground (per column, for ground()). The island's slice is for one
// world seed at a time (islandSeed; null till prepare() bakes it).
let bake = null;
function baked() {
  if (bake) return bake;
  const T = PATCH_TILE;
  const cells = new Uint8Array(T * T * T * PATCH_PRESETS.length);
  const palette = new PatchPalette();
  const ground = [];
  for (const k of [PATCH_LAB, PATCH_VOLCANO]) {
    const { g, A } = presetState(PATCH_PRESETS[k]);
    ground[k] = bakePreset(k, A, g, cells, palette);
  }
  const tex = new THREE.Data3DTexture(cells, T, T, T * PATCH_PRESETS.length);
  tex.format = THREE.RedIntegerFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  const palTex = new THREE.DataTexture(palette.data, PATCH_PALETTE_W, PATCH_PALETTE_MAX / PATCH_PALETTE_W,
    THREE.RGBAFormat, THREE.FloatType);
  palTex.minFilter = palTex.magFilter = THREE.NearestFilter;
  palTex.needsUpdate = true;
  bake = {
    cells, palette, ground, tex, palTex,
    shared: palette.count,      // palette entries of lab and volcano (the island's follow)
    islandSeed: null, islandTwin: new Map(), pending: new Map(),
  };
  return bake;
}

// The island tile's ground for world seed `seed`: the bake's once it is done, else the twin's.
function islandGround(seed) {
  const b = baked();
  if (b.islandSeed === seed) return b.ground[PATCH_ISLAND];
  if (!b.islandTwin.has(seed)) b.islandTwin.set(seed, islandGroundTwin(seed));
  return b.islandTwin.get(seed);
}

// Bake the island for world seed `seed` into the island slice (replacing the
// one there), on the GPU.
async function bakeIsland(renderer, seed) {
  const b = baked();
  const { g, A } = await bakeIslandState(renderer, seed);
  b.palette.truncate(b.shared);
  b.ground[PATCH_ISLAND] = bakePreset(PATCH_ISLAND, A, g, b.cells, b.palette);
  b.islandSeed = seed;
  b.tex.needsUpdate = true;
  b.palTex.needsUpdate = true;
}

// ---------------------------------------------------------------- the scene
export const patchwork = {
  key: 'patchwork',
  label: 'Patchwork',
  params: ({ size, seed }) => ({
    size,
    seed: (seed ?? WORLD_SEED) >>> 0,   // the island tiles are the box island of this seed
    sea: PATCH_SEA,
    floor: PATCH_FLOOR,
  }),
  glsl: () => /* glsl */ `
#define PATCH_TILE ${PATCH_TILE}            // cells per tile edge (a box preset at box size), and the world's height
#define PATCH_TILE_BITS ${PATCH_TILE_BITS}         // log2(PATCH_TILE): tiles are addressed by shifts and masks
#define PATCH_MAP_X ${PATCH_MAP[0]}             // tiles across the world, x and z (the map repeats past them)
#define PATCH_MAP_Z ${PATCH_MAP[1]}
#define PATCH_PALETTE_W ${PATCH_PALETTE_W}       // palette entries per row of its texture
#define PATCH_AIR ${PATCH_AIR}u                // the palette's still air
#define PATCH_SALT_CELL ${PATCH_SALT_CELL}u        // the cells' colour seed stream
uniform uint uPatchSeed;                        // the world seed
uniform int uPatchMap[PATCH_MAP_X * PATCH_MAP_Z];   // each tile's preset, x fastest
precision highp usampler3D;
uniform usampler3D uPatchCells;                 // the baked presets: a palette index per cell, preset k at depth k·PATCH_TILE
uniform sampler2D uPatchPalette;                // the states: (id, °C, life, ctype)
void sceneCell(ivec3 w, out vec4 A, out vec4 B) {
  // the tile and the cell in it: shifts and masks floor negative cells too
  ivec2 t = w.xz >> PATCH_TILE_BITS, l = w.xz & (PATCH_TILE - 1);
  ivec2 m = t & ivec2(PATCH_MAP_X - 1, PATCH_MAP_Z - 1);
  int k = uPatchMap[m.x + PATCH_MAP_X * m.y];
  uint e = w.y >= 0 && w.y < PATCH_TILE ? texelFetch(uPatchCells, ivec3(l.x, w.y, l.y + PATCH_TILE * k), 0).r : PATCH_AIR;
  vec4 s = texelFetch(uPatchPalette, ivec2(int(e) % PATCH_PALETTE_W, int(e) / PATCH_PALETTE_W), 0);
  float seed = float(seedWorld(w, uPatchSeed, PATCH_SALT_CELL)) * UINT_TO_UNIT * SEED_MAX;
  A = vec4(s.xyz, s.w + seed);
  B = vec4(0.0);
}
`,
  uniforms(P) {
    const b = baked();
    return {
      uPatchSeed: { value: P.seed },
      uPatchMap: { value: tileMap(P.seed) },
      uPatchCells: { value: b.tex },
      uPatchPalette: { value: b.palTex },
    };
  },
  // Centred on the seam between the two tiles at the world's middle (along
  // x): every seam joins two different presets (tileMap), and the window sees
  // half of each.
  start(P) {
    const tx = Math.floor(P.size[0] / PATCH_TILE / 2), tz = Math.floor(P.size[2] / PATCH_TILE / 2);
    return [tx * PATCH_TILE, (tz + 0.5) * PATCH_TILE];
  },
  ground(x, z, P) {
    const cx = Math.floor(x), cz = Math.floor(z);
    const k = presetAt(P.seed, ...tileOf(cx, cz));
    const [lx, lz] = inTile(cx, cz);
    const g = k === PATCH_ISLAND ? islandGround(P.seed) : baked().ground[k];
    return g[lx + PATCH_TILE * lz];
  },
  // The island tiles' bake (patchworkIsland.js): GPU passes and a readback.
  prepare(renderer, P) {
    const b = baked();
    if (b.islandSeed === P.seed) return Promise.resolve();
    if (!b.pending.has(P.seed)) {
      b.pending.set(P.seed, bakeIsland(renderer, P.seed).finally(() => b.pending.delete(P.seed)));
    }
    return b.pending.get(P.seed);
  },
  dispose() {
    if (!bake) return;
    bake.tex.dispose();
    bake.palTex.dispose();
    bake = null;
  },
};

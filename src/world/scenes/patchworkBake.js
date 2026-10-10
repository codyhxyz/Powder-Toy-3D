import { E, ELEMENTS, K } from '../../elements.js';
import { gridLayout, cellTexel, Simulation } from '../../sim.js';
import { buildPreset } from '../../presets.js';
import { WORLD_SIZE } from '../../shaders/far.js';
import { pcg, worldParams, heightAt } from '../generator.js';

// The patchwork scene's CPU half (scenes/patchwork.js): which box preset each
// tile of the world holds, and the presets baked into the compact form its
// GLSL samples.
//
// A tile is a box preset at box size, the world's full height on a side, so a
// tile is exactly what the Scene row loads into a 128³ box. Every cell of a
// baked preset is one byte: an index into a palette of the distinct states
// (element, °C, life, ctype) the presets hold, kept as exact floats. Three
// presets hold a few dozen distinct states (the island's frozen rock warms
// over a few cells, one state per height), so the byte has room to spare, and
// a cell costs 1 byte of GPU memory instead of the state's 16. The colour seed
// isn't kept: the scene hashes it from the world cell (seedWorld), as the
// generator does (the presets draw theirs from Math.random anyway).

// Cells per tile edge: a box preset at box size (app.js SIZES '128'), as tall
// as the world.
export const PATCH_TILE = WORLD_SIZE[1];
// The presets the tiles hold, in their order in the baked texture.
export const PATCH_PRESETS = ['lab', 'volcano', 'island'];
export const PATCH_LAB = 0, PATCH_VOLCANO = 1, PATCH_ISLAND = 2;
// Tiles across the world (x, z): the tile map's size. A world larger than
// this repeats it.
export const PATCH_MAP = [WORLD_SIZE[0] / PATCH_TILE, WORLD_SIZE[2] / PATCH_TILE];
// Palette entries: as many as a byte indexes.
export const PATCH_PALETTE_MAX = 256;
// Palette entry 0 is still air (what the presets start from: Simulation.blankState).
export const PATCH_AIR = 0;
// Hash salt of the tile map's random stream (the world seed's).
export const PATCH_SALT_MAP = 0x9a7c;

// The GLSL addresses tiles with shifts and masks (exact for negative cells,
// where GLSL's % is undefined), so the tile and the map are powers of two.
const pow2 = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
if (!pow2(PATCH_TILE) || !PATCH_MAP.every(pow2)) {
  throw new Error(`patchwork: tile ${PATCH_TILE} and map ${PATCH_MAP} must be powers of two`);
}
export const PATCH_TILE_BITS = Math.log2(PATCH_TILE);

// ---------------------------------------------------------------- tile map
// Which preset each tile holds: a random proper colouring of the tile grid,
// so no tile is the same preset as the one beside it on any side (every seam
// joins two different scenes, and there are no runs). Tiles are chosen row by
// row (x fastest), each from the presets the tiles before it in its row and
// its column aren't (with three presets there is always one left): by a hash
// of the tile and the world seed, unless one of them is already more than
// PATCH_BALANCE_SLACK tiles behind the other, which then gets it, so each
// preset holds about a third of the world.
export const PATCH_BALANCE_SLACK = 2;   // tiles
const mapCache = new Map();
export function tileMap(seed) {
  if (mapCache.has(seed)) return mapCache.get(seed);
  const [mx, mz] = PATCH_MAP, n = PATCH_PRESETS.length;
  const map = new Int32Array(mx * mz), count = new Array(n).fill(0);
  const stream = pcg((seed + PATCH_SALT_MAP) >>> 0);
  for (let tz = 0; tz < mz; tz++)
    for (let tx = 0; tx < mx; tx++) {
      const i = tx + mx * tz;
      const left = tx > 0 ? map[i - 1] : -1, before = tz > 0 ? map[i - mx] : -1;
      let options = [];
      for (let k = 0; k < n; k++) if (k !== left && k !== before) options.push(k);
      const least = Math.min(...options.map((k) => count[k]));
      if (options.some((k) => count[k] > least + PATCH_BALANCE_SLACK)) options = options.filter((k) => count[k] === least);
      const k = options[pcg((tx + pcg((tz + stream) >>> 0)) >>> 0) % options.length];
      map[i] = k;
      count[k]++;
    }
  mapCache.set(seed, map);
  return map;
}
// The tile holding world column (x, z) ([tx, tz], any integers), and the
// column inside it ([lx, lz]): the GLSL's shifts and masks.
export const tileOf = (x, z) => [x >> PATCH_TILE_BITS, z >> PATCH_TILE_BITS];
export const inTile = (x, z) => [x & (PATCH_TILE - 1), z & (PATCH_TILE - 1)];
// The preset at tile (tx, tz) of world seed `seed` (the map repeats past its edge).
export function presetAt(seed, tx, tz) {
  const [mx, mz] = PATCH_MAP;
  return tileMap(seed)[(tx & (mx - 1)) + mx * (tz & (mz - 1))];
}

// ---------------------------------------------------------------- presets
// A box preset's state at box size, as buildPreset (src/presets.js) makes it:
// { g, A, B }, the atlas-layout arrays Simulation.load() would get. buildPreset
// runs against a stand-in with the box's layout that keeps what it loads, so
// no GPU is needed (only lab and volcano: the island is generated on the GPU,
// scenes/patchworkIsland.js).
export function presetState(name) {
  const g = gridLayout(PATCH_TILE, PATCH_TILE, PATCH_TILE);
  let state = null;
  buildPreset(name, {
    g,
    blankState: () => Simulation.prototype.blankState.call({ g }),
    cellTexel: (x, y, z) => cellTexel(g, x, y, z),
    load: (A, B) => { state = { g, A, B }; },
  });
  return state;
}

// The palette: each distinct (element, °C, life, ctype) once, as RGBA floats
// (data, PATCH_PALETTE_MAX entries), in the order first met.
export class PatchPalette {
  constructor() {
    this.data = new Float32Array(PATCH_PALETTE_MAX * 4);
    this.keys = new Map();
    this.count = 0;
    const air = ELEMENTS[E.EMPTY];
    this.add(E.EMPTY, air.temp, air.life, 0);   // PATCH_AIR
  }

  // The entry for a state (made if new). The values are float32s already
  // (they come from state arrays), so the key is exact.
  add(id, T, life, ctype) {
    const key = `${id},${T},${life},${ctype}`;
    let m = this.keys.get(key);
    if (m !== undefined) return m;
    if (this.count >= PATCH_PALETTE_MAX) throw new Error(`patchwork: more than ${PATCH_PALETTE_MAX} distinct cell states`);
    m = this.count++;
    this.data.set([id, T, life, ctype], m * 4);
    this.keys.set(key, m);
    return m;
  }

  // Forget the entries from n on (a preset baked again).
  truncate(n) {
    for (const [key, m] of this.keys) if (m >= n) this.keys.delete(key);
    this.data.fill(0, n * 4);
    this.count = n;
  }
}

// Does element id stand as ground (the top of the topmost solid or liquid
// matter is a scene's ground)?
const GROUND_KINDS = new Set([K.SOLID, K.POWDER, K.LIQUID]);
const isGround = (id) => GROUND_KINDS.has(ELEMENTS[id]?.kind);

// The index of cell (x, y, z) of preset k in the baked cells (a Data3DTexture
// PATCH_TILE wide and tall, the presets one after another along its depth).
export const cellIndex = (k, x, y, z) => ((z + PATCH_TILE * k) * PATCH_TILE + y) * PATCH_TILE + x;

// Bake preset k from its state array A (layout g) into cells (one byte per
// cell) with palette entries from `palette`. Returns its ground: per column
// (x + PATCH_TILE·z) the top of its topmost solid or liquid matter, in cells.
export function bakePreset(k, A, g, cells, palette) {
  const T = PATCH_TILE;
  const ground = new Uint8Array(T * T);
  for (let z = 0; z < T; z++)
    for (let x = 0; x < T; x++) {
      let top = 0, pid = -1, pT = 0, pl = 0, pc = 0, pm = PATCH_AIR;
      for (let y = 0; y < T; y++) {
        const i = cellTexel(g, x, y, z) * 4;
        const id = A[i], t = A[i + 1], life = A[i + 2], ctype = Math.floor(A[i + 3]);
        // runs up a column mostly repeat: look the state up only when it changes
        if (id !== pid || t !== pT || life !== pl || ctype !== pc) {
          pm = palette.add(id, t, life, ctype);
          pid = id; pT = t; pl = life; pc = ctype;
        }
        cells[cellIndex(k, x, y, z)] = pm;
        if (isGround(id)) top = y + 1;
      }
      ground[x + T * z] = top;
    }
  return ground;
}

// ---------------------------------------------------------------- the island
// The island box preset is the generator's world the size of the box, with
// the box's own world seed (app.js loadPreset: loadIsland), snow and all.
export const islandParams = (seed) => worldParams({ size: [PATCH_TILE, PATCH_TILE, PATCH_TILE], seed });

// The island's ground from the generator's JS twin (heightAt: within a cell
// of the GPU's, without trees), for before its GPU bake is done.
export function islandGroundTwin(seed) {
  const P = islandParams(seed), T = PATCH_TILE;
  const ground = new Uint8Array(T * T);
  for (let z = 0; z < T; z++)
    for (let x = 0; x < T; x++) ground[x + T * z] = Math.max(Math.floor(heightAt(x, z, P) + 0.5), P.sea);
  return ground;
}

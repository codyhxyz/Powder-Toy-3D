// CPU checks of the patchwork world scene (src/world/scenes/patchwork.js):
//   - its lab and volcano tiles, read back through a JS mirror of its
//     sceneCell (the same shifts, masks and fetches), match buildPreset's box
//     state cell by cell: element, temperature, life and ctype, exactly;
//   - world cells anywhere (negative, past the map, above and below the
//     world) decode to the preset their tile's map entry names, at the cell's
//     place in the tile;
//   - the tile map, for many seeds: no tile is the preset of a neighbour on
//     any side, every preset has a fair share, the same seed gives the same
//     map, and seeds differ;
//   - ground() matches a scan of buildPreset's state for lab and volcano tiles
//     (island tiles: within the world, from the generator's twin until a GPU
//     bake), and start() sits on a seam between two different presets;
//   - the bake is the same twice (the presets' Math.random seeds don't leak in);
//   - prepare() against a stand-in renderer: the island's passes and readback,
//     and the read-back state lands in the island tiles and their ground.
// The island's GPU passes themselves need a GPU, so they aren't checked here.
// No GPU: fine on battery.
//
//   node tools/scene-patch-check.mjs
import { gridLayout, cellTexel, Simulation } from '../src/sim.js';
import { buildPreset } from '../src/presets.js';
import { ELEMENTS, K } from '../src/elements.js';
import { WORLD_SIZE } from '../src/shaders/far.js';
import { WORLD_SEED, treesIn, TREE } from '../src/world/generator.js';
import { patchwork } from '../src/world/scenes/patchwork.js';
import {
  PATCH_TILE as T, PATCH_TILE_BITS, PATCH_MAP, PATCH_PRESETS, PATCH_ISLAND, PATCH_AIR, PATCH_PALETTE_MAX, tileMap,
  islandParams,
} from '../src/world/scenes/patchworkBake.js';

const SEEDS = 200;                 // tile maps checked
const SHARE_MIN = 0.28;            // each preset's share of a map's tiles is at least this...
const SHARE_MAX = 0.4;             // ...and at most this
const DISTINCT_MIN = 0.95;         // share of seed pairs (s, s + 1) whose maps differ
const RANDOM_CELLS = 200000;       // world cells decoded at random places
const REACH = 3;                   // ...up to this many worlds out on each side (the map repeats)

let failures = 0;
const fail = (msg) => { failures++; if (failures <= 20) console.log(`FAIL ${msg}`); };

// buildPreset's own box state, from a stand-in of its own (not the scene's)
function reference(name) {
  const g = gridLayout(T, T, T);
  let out;
  buildPreset(name, {
    g, blankState: () => Simulation.prototype.blankState.call({ g }),
    cellTexel: (x, y, z) => cellTexel(g, x, y, z), load: (A) => { out = A; },
  });
  return { g, A: out };
}
const refs = { lab: reference('lab'), volcano: reference('volcano') };
// the box state of cell (x, y, z) of a preset: [id, °C, life, ctype]
const refCell = (name, x, y, z) => {
  const { g, A } = refs[name], i = cellTexel(g, x, y, z) * 4;
  return [A[i], A[i + 1], A[i + 2], Math.floor(A[i + 3])];
};

// the scene's uniforms: its baked textures and map
const P = patchwork.params({ size: WORLD_SIZE, seed: WORLD_SEED });
const U = patchwork.uniforms(P);
const cells = U.uPatchCells.value.image.data;
// JS mirror of sceneCell (patchwork.js) with uniforms u, without the seed: [id, °C, life, ctype]
function sceneCell(map, x, y, z, u = U) {
  const cells = u.uPatchCells.value.image.data, pal = u.uPatchPalette.value.image.data;
  const palW = u.uPatchPalette.value.image.width;
  const tx = x >> PATCH_TILE_BITS, tz = z >> PATCH_TILE_BITS, lx = x & (T - 1), lz = z & (T - 1);
  const mx = tx & (PATCH_MAP[0] - 1), mz = tz & (PATCH_MAP[1] - 1);
  const k = map[mx + PATCH_MAP[0] * mz];
  const e = y >= 0 && y < T ? cells[((lz + T * k) * T + y) * T + lx] : PATCH_AIR;
  const i = ((e % palW) + palW * Math.floor(e / palW)) * 4;
  return [pal[i], pal[i + 1], pal[i + 2], pal[i + 3]];
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- the palette
const used = new Set(cells);
console.log(`palette: ${Math.max(...used) + 1} of ${PATCH_PALETTE_MAX} entries used by lab and volcano`);
if (!same(Array.from(U.uPatchPalette.value.image.data.subarray(0, 4)), [0, ELEMENTS[0].temp, ELEMENTS[0].life, 0])) fail('palette entry 0 is not still air');

// ---- lab and volcano tiles, every cell, through sceneCell at a tile holding each
const map = U.uPatchMap.value;
for (const name of ['lab', 'volcano']) {
  const k = PATCH_PRESETS.indexOf(name);
  const at = map.indexOf(k);
  if (at < 0) { fail(`the map has no ${name} tile`); continue; }
  const ox = (at % PATCH_MAP[0]) * T, oz = Math.floor(at / PATCH_MAP[0]) * T;
  let bad = 0;
  for (let z = 0; z < T; z++)
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const got = sceneCell(map, ox + x, y, oz + z), want = refCell(name, x, y, z);
        if (!same(got, want) && bad++ < 5) fail(`${name} (${x}, ${y}, ${z}): got ${got}, buildPreset has ${want}`);
      }
  console.log(`${name}: ${T ** 3} cells ${bad ? `${bad} differ` : 'match buildPreset exactly'}`);
}

// ---- world cells anywhere decode to their tile's preset at their place in it
let rs = 12345;   // a fixed LCG stream (Numerical Recipes' constants), so failures repeat
const rand = () => ((rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296);
const span = (n) => Math.floor((rand() * (2 * REACH + 1) - REACH) * n);
let checked = 0;
for (let i = 0; i < RANDOM_CELLS; i++) {
  const x = span(WORLD_SIZE[0]), z = span(WORLD_SIZE[2]), y = Math.floor(rand() * (T + 2)) - 1;
  const tx = Math.floor(x / T), tz = Math.floor(z / T);
  const mx = ((tx % PATCH_MAP[0]) + PATCH_MAP[0]) % PATCH_MAP[0], mz = ((tz % PATCH_MAP[1]) + PATCH_MAP[1]) % PATCH_MAP[1];
  const k = map[mx + PATCH_MAP[0] * mz];
  if (k === PATCH_ISLAND) continue;
  const lx = x - tx * T, lz = z - tz * T;
  const want = y < 0 || y >= T ? [0, ELEMENTS[0].temp, ELEMENTS[0].life, 0] : refCell(PATCH_PRESETS[k], lx, y, lz);
  if (!same(sceneCell(map, x, y, z), want)) fail(`world cell (${x}, ${y}, ${z}) isn't ${PATCH_PRESETS[k]} (${lx}, ${y}, ${lz})`);
  checked++;
}
console.log(`world cells: ${checked} at random places (lab and volcano tiles) checked`);

// ---- the tile map
const [MX, MZ] = PATCH_MAP;
let distinct = 0;
const shares = PATCH_PRESETS.map(() => [1, 0]);
for (let s = 0; s < SEEDS; s++) {
  const seed = s === 0 ? WORLD_SEED : s;
  const m = tileMap(seed);
  for (let tz = 0; tz < MZ; tz++)
    for (let tx = 0; tx < MX; tx++) {
      const k = m[tx + MX * tz];
      if (tx + 1 < MX && m[tx + 1 + MX * tz] === k) fail(`seed ${seed}: tiles (${tx}, ${tz}) and (${tx + 1}, ${tz}) are both ${PATCH_PRESETS[k]}`);
      if (tz + 1 < MZ && m[tx + MX * (tz + 1)] === k) fail(`seed ${seed}: tiles (${tx}, ${tz}) and (${tx}, ${tz + 1}) are both ${PATCH_PRESETS[k]}`);
    }
  PATCH_PRESETS.forEach((name, k) => {
    const share = m.filter((v) => v === k).length / m.length;
    shares[k][0] = Math.min(shares[k][0], share);
    shares[k][1] = Math.max(shares[k][1], share);
    if (share < SHARE_MIN || share > SHARE_MAX) fail(`seed ${seed}: ${name} is ${(share * 100).toFixed(0)}% of the tiles`);
  });
  if (!same(Array.from(m), Array.from(patchwork.uniforms(patchwork.params({ size: WORLD_SIZE, seed })).uPatchMap.value))) {
    fail(`seed ${seed}: the uniform's map isn't tileMap's`);
  }
  if (!same(Array.from(m), Array.from(tileMap(s + 1)))) distinct++;
}
if (distinct < DISTINCT_MIN * SEEDS) fail(`only ${distinct} of ${SEEDS} neighbouring seeds give different maps`);
console.log(`tile map: ${SEEDS} seeds, no neighbours alike; shares ${PATCH_PRESETS.map((n, k) => `${n} ${shares[k].map((v) => (v * 100).toFixed(0)).join('-')}%`).join(', ')}`);
const show = (m) => Array.from({ length: MZ }, (_, tz) => Array.from(m.subarray(tz * MX, (tz + 1) * MX)).map((k) => 'LVI'[k]).join(' ')).reverse().join('\n  ');
console.log(`  the default world's (z up, L lab, V volcano, I island):\n  ${show(map)}`);

// ---- ground() and start()
const isGround = (id) => [K.SOLID, K.POWDER, K.LIQUID].includes(ELEMENTS[id]?.kind);
for (let tz = 0; tz < MZ; tz++)
  for (let tx = 0; tx < MX; tx++) {
    const k = map[tx + MX * tz];
    for (let z = 0; z < T; z++)
      for (let x = 0; x < T; x++) {
        const got = patchwork.ground(tx * T + x, tz * T + z, P);
        if (k === PATCH_ISLAND) {
          if (!(got >= 0 && got <= T)) fail(`island ground(${tx * T + x}, ${tz * T + z}) = ${got}`);
          continue;
        }
        let want = 0;
        for (let y = 0; y < T; y++) if (isGround(refCell(PATCH_PRESETS[k], x, y, z)[0])) want = y + 1;
        if (got !== want) fail(`${PATCH_PRESETS[k]} ground(${tx * T + x}, ${tz * T + z}) = ${got}, buildPreset's top is ${want}`);
      }
  }
console.log('ground: every column checked');
const [sx, sz] = patchwork.start(P, [T, T]);
const left = map[Math.floor((sx - 1) / T) + MX * Math.floor(sz / T)], right = map[Math.floor(sx / T) + MX * Math.floor(sz / T)];
if (sx % T !== 0 || left === right) fail(`start (${sx}, ${sz}) isn't on a seam between two presets`);
console.log(`start: (${sx}, ${sz}), between ${PATCH_PRESETS[left]} and ${PATCH_PRESETS[right]}`);

// ---- the bake is the same twice
const first = Uint8Array.from(cells);
patchwork.dispose();
const again = patchwork.uniforms(P).uPatchCells.value.image.data;
if (!same(first, again)) fail('a second bake differs from the first');

// ---- prepare() against a stand-in renderer: the island's passes run in
// loadIsland's order (columns, fill, a stamp per tree), the state read back
// is the last one written, and what it reads lands in the island tiles and
// their ground. The stand-in's readback hands over the volcano's box state
// (any known state does), so the island tiles must decode to it.
{
  const passes = [];
  let read = null, target = null;
  const renderer = {
    getRenderTarget: () => target,
    setRenderTarget: (t) => { target = t; },
    render: (scene) => passes.push({ name: scene.children[0].material.name, target }),
    compileAsync: async () => {},
    readRenderTargetPixelsAsync: async (t, x, y, w, h, buf, face, index) => { read = { t, index, w, h }; buf.set(refs.volcano.A); },
  };
  const U2 = patchwork.uniforms(P), version = U2.uPatchCells.value.version;
  await patchwork.prepare(renderer, P);
  await patchwork.prepare(renderer, P);   // baked: nothing to do
  const names = passes.map((p) => p.name);
  const trees = treesIn(-TREE.REACH, -TREE.REACH, T + TREE.REACH, T + TREE.REACH, islandParams(P.seed)).length;
  if (names[0] !== 'column' || names[1] !== 'fill' || names.slice(2).some((n) => n !== 'stamp') || names.length - 2 > trees) {
    fail(`island passes ${names.slice(0, 4).join(', ')}... (${names.length}; ${trees} trees)`);
  }
  if (!read || read.t !== passes.at(-1).target || read.index !== 0 || read.w !== refs.volcano.g.width) fail('the island readback is not the last state written (attachment 0, whole atlas)');
  if (target !== null) fail('prepare() left the renderer on its own target');
  if (U2.uPatchCells.value.version === version) fail('the island bake did not re-upload the cells');
  const m2 = U2.uPatchMap.value, at = m2.indexOf(PATCH_ISLAND);
  const ox = (at % MX) * T, oz = Math.floor(at / MX) * T;
  let bad = 0;
  for (let z = 0; z < T; z++)
    for (let x = 0; x < T; x++) {
      let want = 0;
      for (let y = 0; y < T; y++) {
        const r = refCell('volcano', x, y, z);
        if (isGround(r[0])) want = y + 1;
        if (!same(sceneCell(m2, ox + x, y, oz + z, U2), r) && bad++ < 5) fail(`island tile (${x}, ${y}, ${z}) is ${sceneCell(m2, ox + x, y, oz + z, U2)}, read back ${r}`);
      }
      if (patchwork.ground(ox + x, oz + z, P) !== want && bad++ < 5) fail(`island ground(${ox + x}, ${oz + z}) isn't the read-back state's`);
    }
  console.log(`prepare: ${names.length} island passes (${names.length - 2} trees stamped), its readback baked into the island tiles${bad ? ` (${bad} wrong)` : ''}`);
}
patchwork.dispose();

console.log(failures ? `${failures} failure(s)` : 'patchwork OK');
process.exit(failures ? 1 : 0);

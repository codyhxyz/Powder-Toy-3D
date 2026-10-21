// CPU check: the sea past a map's edge (gfx/edgeSea.js, gfx/overlays.js skyWGSL).
// - Which edges' masks the scenes give: the island's, Tinker Creek's and the
//   Giant Volcano's sea reaches their whole edge; the Volcano Isles' only part
//   of it; the Lab Complex and Descent have no sea.
// - The sky shader's lookup (its JS twin, edgeSeaIndex) finds the sample a
//   point past each side lies off, corners included.
// - The small maps (one box each, boxEdgeSea from their cells as built; the
//   Islet's from the island scene's twin): the Islet's and the Volcano's water
//   reaches the whole of the box's edge, the Lab, Quarry, Dam Valley and Empty
//   have none there. The sea's footprint is the box and its surface the top
//   of the water in the box's edge columns, in the box's grid cells, and a
//   ray past the wall meets it there (no step at the wall).
// - With Naga installed (CI: deploy.yml), the sky and floor grid shaders validate.
//   node tools/check-edge-sea.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edgeSeaMask, edgeSeaIndex, sceneEdgeSea, boxEdgeSea, edgeSeaParams, EDGE_SEA_SAMPLES, EDGE_SEA_SIDES, EDGE_SEA_VEC4 } from '../src/gfx/edgeSea.js';
import { skyWGSL, gridWGSL, SkyParams, GridParams } from '../src/gfx/overlays.js';
import { WORLD_SCENES, sceneByKey } from '../src/world/scenes/index.js';
import { worldParams } from '../src/world/generator.js';
import { buildPreset } from '../src/presets.js';
import { E, K, ELEMENTS } from '../src/elements.js';
import { MAPS } from '../src/maps.js';

const ALL = EDGE_SEA_SIDES * EDGE_SEA_SAMPLES;
const OUT = 40;   // cells past the edge a test point lies

const mapOf = (key) => MAPS.find((m) => m.key === key);
const sceneOf = (m) => WORLD_SCENES.find((s) => s.key === m.scene);
async function maskOf(key) {
  const m = mapOf(key), scene = sceneOf(m), P = scene.params({ size: m.dims, seed: 0 });
  if (P.sea > 0 && scene.prepare) await scene.prepare(P);
  return edgeSeaMask(scene, P);
}

// 1. the scenes' edges
for (const key of ['island', 'willowCove', 'giantVolcano']) {
  const m = await maskOf(key);
  assert.equal(m?.count, ALL, `${key}: its sea reaches the whole edge`);
  assert.equal(m.words.length, EDGE_SEA_VEC4);
}
const volcano = await maskOf('volcanoWorld');
assert.ok(volcano && volcano.count > 0 && volcano.count < ALL, `volcanoWorld: sea at part of the edge (${volcano?.count}/${ALL})`);
for (const key of ['labWorld', 'descent']) assert.equal(await maskOf(key), null, `${key}: no sea, none past the edge`);
// the mask's bits are the edge's columns: a scene with land on one side only
const halfLand = { ground: (x, z, P) => (x < 1 ? P.sea + 5 : P.sea) };   // the x = 0 side (3) is land (its column centres at 0.5; the others' start at 1)
const half = edgeSeaMask(halfLand, { size: [2048, 128, 1024], sea: 16 });
assert.equal(half.count, ALL - EDGE_SEA_SAMPLES, 'one side of land drops just its samples');
const bitOf = (words, i) => ((words[i >>> 7][(i >>> 5) & 3] >>> (i & 31)) & 1) === 1;
for (let i = 0; i < EDGE_SEA_SAMPLES; i++) assert.ok(!bitOf(half.words, 3 * EDGE_SEA_SAMPLES + i) && bitOf(half.words, i), `sample ${i}`);
assert.equal(edgeSeaMask(halfLand, { size: [2048, 128, 1024], sea: 0 }), null, 'no sea level, no sea');

// 2. the lookup: a point past each side, off sample i, is that sample's bit; corners belong to the side they are furthest past
const foot = [-300, -100, 724, 924];   // a window's grid: the world from -origin to size - origin
const [x0, z0, x1, z1] = foot, wx = x1 - x0, wz = z1 - z0;
for (let i = 0; i < EDGE_SEA_SAMPLES; i += 37) {
  const u = (i + 0.5) / EDGE_SEA_SAMPLES;
  assert.equal(edgeSeaIndex(foot, [x0 + u * wx, z0 - OUT]), i, 'side 0 (z min)');
  assert.equal(edgeSeaIndex(foot, [x1 + OUT, z0 + u * wz]), EDGE_SEA_SAMPLES + i, 'side 1 (x max)');
  assert.equal(edgeSeaIndex(foot, [x0 + u * wx, z1 + OUT]), 2 * EDGE_SEA_SAMPLES + i, 'side 2 (z max)');
  assert.equal(edgeSeaIndex(foot, [x0 - OUT, z0 + u * wz]), 3 * EDGE_SEA_SAMPLES + i, 'side 3 (x min)');
}
assert.equal(edgeSeaIndex(foot, [x0 - OUT, z0 - 2 * OUT]), 0, 'past the corner, further past z min: its first sample');
assert.equal(edgeSeaIndex(foot, [x1 + 2 * OUT, z1 + OUT]), 2 * EDGE_SEA_SAMPLES - 1, 'further past x max: its last sample');

// 3. the small maps: each box's cells as its map builds them (presets.js, on a
// stand-in for the simulation that keeps them instead of uploading them), the
// Islet's from the island scene (world/gpu.js loadIsland fills the box from
// worldParams of its size and the world seed)
const STATE_RGBA = 4;   // floats a texel of state A: id, °C, life, ctype (sim.js load)
const ORIGIN = { x: 0, y: 0, z: 0 };   // a box's grid: the map, from its corner
function boxCells(m) {
  const [nx, ny, nz] = m.dims, texel = (x, y, z) => (y * nz + z) * nx + x;
  let A = null;
  const sim = { g: { nx, ny, nz }, cellTexel: texel, load(a) { A = a; },
    blankState: () => [new Float32Array(nx * ny * nz * STATE_RGBA), new Float32Array(nx * ny * nz * STATE_RGBA)] };
  if (m.preset === 'empty') A = sim.blankState()[0];   // (app.js: sim.clear, a blank state)
  else buildPreset(m.preset, sim);
  return (x, y, z) => A[texel(x, y, z) * STATE_RGBA];
}
const isletP = (m) => worldParams({ size: m.dims });
// the sky shader's pastEdge: grid point h outside the footprint
const pastEdge = (f, h) => h[0] < f[0] || h[1] < f[1] || h[0] > f[2] || h[1] > f[3];
const boxSeaOf = (m) => (m.preset === 'island' ? sceneEdgeSea(sceneByKey('island'), isletP(m)) : boxEdgeSea(boxCells(m), m.dims));
const small = MAPS.filter((m) => m.preset);
assert.deepEqual(small.map((m) => m.key).sort(), ['damValley', 'empty', 'islet', 'lab', 'quarry', 'volcano'], 'the small maps this checks');
const seas = Object.fromEntries(small.map((m) => [m.key, boxSeaOf(m)]));
for (const key of ['islet', 'volcano']) {
  assert.equal(seas[key]?.count, ALL, `${key}: its sea reaches the box's whole edge`);
  assert.equal(seas[key].words.length, EDGE_SEA_VEC4);
}
for (const key of ['lab', 'quarry', 'damValley', 'empty']) assert.equal(seas[key], null, `${key}: no water at the box's edge, no sea past it`);
// the water's surface at the wall, from the cells themselves: the cell over the
// topmost water of each edge column the mask has as sea (the Islet's: the
// island twin's ground, the top of its water)
const ground = (idAt, ny) => (x, z) => {
  for (let y = ny - 1; y >= 0; y--) { const k = ELEMENTS[idAt(x, y, z)]?.kind; if (k === K.SOLID || k === K.POWDER || k === K.LIQUID) return y + 1; }
  return 0;
};
const volcanoMap = small.find((m) => m.key === 'volcano'), isletMap = small.find((m) => m.key === 'islet');
const tops = {
  volcano: ground(boxCells(volcanoMap), volcanoMap.dims[1]),
  islet: (x, z) => sceneByKey('island').ground(x + 0.5, z + 0.5, isletP(isletMap)),
};
for (const m of [volcanoMap, isletMap]) {
  const [nx, , nz] = m.dims, s = seas[m.key];
  const p = edgeSeaParams(s, m.dims, ORIGIN);
  assert.deepEqual(p.foot.map((v) => v + 0), [0, 0, nx, nz], `${m.key}: the sea's footprint is the box, in its grid cells`);   // (+ 0: -0, the origin negated, is 0)
  assert.equal(p.mask, s.words);
  for (let i = 0; i < nx; i++) for (const [x, z] of [[i, 0], [i, nz - 1], [0, i], [nx - 1, i]]) {
    assert.equal(tops[m.key](x, z), p.seaY, `${m.key}: the water's top at edge column ${x}, ${z} is the sea's surface (no step at the wall)`);
  }
  // a ray from over the box out past its wall (the sky shader's, in its JS twin): it meets the sea
  // past the edge, off the bit of the edge it lies past; one down into the box meets none there
  const cam = [nx / 2, p.seaY + nx / 2, nz / 2];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7]]) {
    const len = Math.hypot(dx, dz, 1 / 2), rd = [dx / len, -1 / 2 / len, dz / len];
    const t = (p.seaY - cam[1]) / rd[1], h = [cam[0] + rd[0] * t, cam[2] + rd[2] * t];
    assert.ok(t > 0 && pastEdge(p.foot, h) && bitOf(s.words, edgeSeaIndex(p.foot, h)), `${m.key}: a ray past the wall toward ${dx}, ${dz} meets the sea`);
  }
  assert.ok(!pastEdge(p.foot, [cam[0], cam[2]]), `${m.key}: straight down is the box's own water, not the sky's sea`);
}
assert.equal(seas.volcano.sea, tops.volcano(0, 0), 'Volcano: its sea level is its water\'s, as built');
assert.equal(seas.islet.sea, isletP(isletMap).sea, 'Islet: its sea level is the island scene\'s');
// the level is the commonest water top; lower water at the edge (a river) is
// sea at that level, as a wet beach is; higher ground, liquid or not, isn't
{
  const N = 16, idAt = (x, y, z) => (x === 0 && z > 0 && z < N - 1 ? (y < 2 ? E.WATER : E.EMPTY)   // a low stretch on x = 0
    : x === N - 1 && z > 0 && z < N - 1 ? (y < 9 ? E.STONE : E.EMPTY)                              // land on x = max
    : z === 0 && x < N / 2 ? (y < 6 ? E.LAVA : E.EMPTY)                                            // lava, higher, on half of z = 0
    : (y < 4 ? E.WATER : E.EMPTY));
  const b = boxEdgeSea(idAt, [N, N, N]);
  assert.equal(b.sea, 4, 'the commonest water top');
  const sideCount = (side) => { let n = 0; for (let i = 0; i < EDGE_SEA_SAMPLES; i++) n += bitOf(b.words, side * EDGE_SEA_SAMPLES + i) ? 1 : 0; return n; };
  assert.equal(sideCount(3), EDGE_SEA_SAMPLES * (N - 1) / N, 'lower water at the edge: sea, at the level (bar its corner column, the lava\'s)');
  assert.ok(sideCount(1) < EDGE_SEA_SAMPLES * 2 / N + 1, 'land at the edge: no sea past it (bar its corners)');
  assert.ok(sideCount(0) > EDGE_SEA_SAMPLES / 2 - EDGE_SEA_SAMPLES / N && sideCount(0) < EDGE_SEA_SAMPLES, 'lava above the level at the edge: no sea past it');
  assert.equal(boxEdgeSea(() => E.STONE, [N, N, N]), null, 'all ground: no sea');
}
// the box's grid cells are FrameUniforms' (gfx/uniforms.js: the eye through the
// inverse of the volume's model; app.js build/placeVolume: a uniform scale, the
// box centred on the scene's origin): the floor grid shader's inverse of that
// model, (scene - model[3]) / model[0][0], puts the box's corners at the
// footprint's
{
  const BOX_SCENE_SPAN = 10;   // app.js build: scale = 10 / max(nx, nz)
  const [nx, , nz] = volcanoMap.dims, scale = BOX_SCENE_SPAN / Math.max(nx, nz);
  const model = [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, -nx / 2 * scale, 0, -nz / 2 * scale, 1];   // column-major
  const toScene = (c) => [c[0] * scale + model[12], c[1] * scale + model[13], c[2] * scale + model[14]];
  const toCell = (w) => [(w[0] - model[12]) / model[0], (w[2] - model[14]) / model[0]];
  const p = edgeSeaParams(seas.volcano, volcanoMap.dims, ORIGIN), f = p.foot.map((v) => v + 0);
  for (const c of [[f[0], 0, f[1]], [f[2], 0, f[3]]]) assert.deepEqual(toCell(toScene(c)).map((v) => v + 0), [c[0], c[2]], 'the floor grid finds the box\'s corners');
}

// 4. the shaders: their params pack, and Naga validates them when installed
assert.ok(SkyParams.size >= 16 * (2 + EDGE_SEA_VEC4), 'SkyParams holds the mask');
SkyParams.pack({ foot, seaY: 18, sea: 1, mask: volcano.words });
GridParams.pack({ model: new Array(16).fill(0), half: 1, step: 1, divisions: 2, lit: 1, ...edgeSeaParams(seas.volcano, volcanoMap.dims, ORIGIN), sea: 1 });
let naga = false;
try { execFileSync('naga', ['--version'], { stdio: 'pipe' }); naga = true; } catch { /* not installed: CI has it */ }
if (naga) {
  const dir = mkdtempSync(join(tmpdir(), 'edge-sea-'));
  try {
    for (const [name, code] of [['sky', skyWGSL], ['grid', gridWGSL]]) {
      const path = join(dir, `${name}.wgsl`);
      writeFileSync(path, code());
      execFileSync('naga', [path], { stdio: 'pipe' });   // CPU parsing/validation only
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(`edge sea CPU: scene masks (whole edge, part, none), side/corner lookup, small maps (Islet and Volcano whole edge, the rest none; box footprint and water level), SkyParams and GridParams passed${naga ? '; Naga validated the sky and floor grid shaders' : ''}`);

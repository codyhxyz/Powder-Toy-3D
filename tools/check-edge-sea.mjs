// CPU check: the sea past a World's edge (gfx/edgeSea.js, gfx/overlays.js skyWGSL).
// - Which edges' masks the scenes give: the island's, Tinker Creek's and the
//   Giant Volcano's sea reaches their whole edge; the Volcano Isles' only part
//   of it; the Lab Complex and Descent have no sea.
// - The sky shader's lookup (its JS twin, edgeSeaIndex) finds the sample a
//   point past each side lies off, corners included.
// - The sea fades into the horizon through the same air as the land: the sky
//   shader carries the volume's haze (shaders/farShared.js farAirWGSL) and
//   draws the sea through t cells of it.
// - With Naga installed (CI: deploy.yml), the sky shader validates.
//   node tools/check-edge-sea.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edgeSeaMask, edgeSeaIndex, EDGE_SEA_SAMPLES, EDGE_SEA_SIDES, EDGE_SEA_VEC4 } from '../src/gfx/edgeSea.js';
import { skyWGSL, SkyParams } from '../src/gfx/overlays.js';
import { WORLD_SCENES } from '../src/world/scenes/index.js';
import { MAPS } from '../src/maps.js';
import { farAirWGSL, volumeHazeGLSL } from '../src/shaders/farShared.js';

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

// 3. the shader: its params pack, the land's haze on the sea, and Naga validates it when installed
assert.ok(skyWGSL().includes(farAirWGSL) && volumeHazeGLSL.includes(farAirWGSL), 'the sky pass and the volume share one haze');
assert.match(skyWGSL(), /edgeSea\(h\)\) \{ c = farHazeAir\(seaColor\(rd\), rd, t, SEA_AIR_LIT\); \}/, 'the sea is seen through t cells of air');
assert.ok(SkyParams.size >= 16 * (2 + EDGE_SEA_VEC4), 'SkyParams holds the mask');
SkyParams.pack({ foot, seaY: 18, sea: 1, mask: volcano.words });
let naga = false;
try { execFileSync('naga', ['--version'], { stdio: 'pipe' }); naga = true; } catch { /* not installed: CI has it */ }
if (naga) {
  const dir = mkdtempSync(join(tmpdir(), 'edge-sea-'));
  try {
    const path = join(dir, 'sky.wgsl');
    writeFileSync(path, skyWGSL());
    execFileSync('naga', [path], { stdio: 'pipe' });   // CPU parsing/validation only
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(`edge sea CPU: scene masks (whole edge, part, none), side/corner lookup and SkyParams passed${naga ? '; Naga validated the sky shader' : ''}`);

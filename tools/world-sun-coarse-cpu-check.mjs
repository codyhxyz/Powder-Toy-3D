// The WORLD renderer's coarse far-tile sun shadow (world/worldSunRings.js,
// shaders/worldSunCoarse.js), CPU only:
// - the coarse writer's WGSL passes Naga and the sampler budget, at every
//   World size class, and reads no atlas page (it can never ask for a brick);
// - its CPU twin puts a flat ground's shadow depth where the geometry does;
// - the error the near ring is derived from (WORLD_SUN_COARSE_ERR) holds on
//   Island's real terrain: the coarse heightfield's terrain shadow against the
//   ground twin read at every cell column, its edges' mean shift in cells,
//   and almost no lit cell falsely shaded (shadow acne);
// - the rings: the eye's own tile is always full detail, a tile past the
//   sharpen ring never is unless already sharp.
//   node --test tools/world-sun-coarse-cpu-check.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { WGSL_CHECK, worldSunCoarse } from '../src/shaders/worldSunCoarse.js';
import { checkPipeline } from './check-sampler-budget.mjs';
import { WORLD_SCENES } from '../src/world/scenes/index.js';
import { WORLD_SIZE } from '../src/shaders/farShared.js';
import { worldColumnTops } from '../src/world/worldSunForecast.js';
import { worldSunProjection, WORLD_SUN_TILE, WORLD_SUN_PITCH } from '../src/world/worldSun.js';
import { worldCoarseCasters, coarseSunDepth, coarseHeightAt, worldSunRings, worldSunTileDistance,
  WORLD_SUN_COARSE_ERR, WORLD_SUN_COARSE_BIAS, WORLD_SUN_NEAR_RADIUS, WORLD_SUN_SHARPEN_RADIUS, LOD_REF_PIXEL_RAD } from '../src/world/worldSunRings.js';
import { GEOM_ERR_PX_FULL } from '../src/gfx/lodFade.js';

test('coarse writer: Naga, sampler budget, no atlas reads', () => {
  assert.equal(spawnSync('naga', ['--version']).status, 0, 'CPU Naga CLI required');
  const dir = mkdtempSync('/tmp/tpt-world-sun-coarse-');
  try {
    for (const c of WGSL_CHECK()) {
      const code = c.code();
      assert.deepEqual(checkPipeline({ code, groups: c.layouts(), kind: 'compute' }).problems, [], c.name);
      assert.doesNotMatch(code, /worldBook|worldStateA|worldPage|worldRequest\(/, `${c.name} reads the atlas`);
      const path = `${dir}/${c.name}.wgsl`; writeFileSync(path, code);
      const r = spawnSync('naga', [path, `${dir}/out.spv`], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(worldSunCoarse({ nx: 64, ny: 64, nz: 64 }), worldSunCoarse({ nx: 64, ny: 64, nz: 64, sourceAppearance: true }), 'the coarse writer depends on the world size only');
});

test('coarse CPU twin: a flat ground shades at its biased surface; the floor past it', () => {
  const size = [256, 64, 256], dims = [64, 64], h = 20;
  const casters = { heights: new Float32Array(dims[0] * dims[1]).fill(h), dims, maxTop: h, size };
  const d = [-0.6, -0.7, -0.3].map((n, _, a) => n / Math.hypot(...a)), o = [200, 60, 150];
  const t = coarseSunDepth(casters, o, d), y = o[1] + d[1] * t;
  assert.ok(Math.abs(y - (h - WORLD_SUN_COARSE_BIAS)) < 1e-6, `hit at y ${y}`);
  assert.ok(Math.abs(coarseHeightAt(casters, 33.3, 77.7) - (h - WORLD_SUN_COARSE_BIAS)) < 1e-9);
  const empty = { ...casters, heights: new Float32Array(dims[0] * dims[1]), maxTop: 0 };
  assert.ok(Math.abs(coarseSunDepth(empty, o, d) - o[1] / -d[1]) < 1e-6, 'floor depth');
});

// The measurement WORLD_SUN_COARSE_ERR is taken from (worldSunRings.js).
const SUNS = [[0.55, 0.62, 0.32], [0.8, 0.3, 0.5]];   // 44° and 18° up
const REGION = 192, MARGIN = 64, MARCH = 0.25, ACNE_SHARE = 0.01;
test('Island: the coarse terrain shadow\'s edge error stays under WORLD_SUN_COARSE_ERR, with almost no acne', async () => {
  const scene = WORLD_SCENES.find((s) => s.key === 'island'), size = scene.size ?? WORLD_SIZE, P = scene.params({ size, seed: 0 });
  await scene.prepare?.(P);
  const tops = worldColumnTops({ size, scene, P }), sea = P.sea ?? 0;
  for (const [cx, cz] of [scene.start(P, [128, 128]), P.center ?? [size[0] / 2, size[2] / 2]]) {
    const x0 = Math.max(MARGIN, Math.floor(cx - REGION / 2)), z0 = Math.max(MARGIN, Math.floor(cz - REGION / 2));
    // the coarse heightfield of the region and its margin only (the twin costs ~23 µs a column)
    const bx0 = Math.floor((x0 - MARGIN) / 4), bz0 = Math.floor((z0 - MARGIN) / 4), bn = (REGION + 2 * MARGIN) / 4 + 2;
    const dims = [Math.ceil(size[0] / 4), Math.ceil(size[2] / 4)], heights = new Float32Array(dims[0] * dims[1]);
    for (let z = bz0; z < bz0 + bn; z++) for (let x = bx0; x < bx0 + bn; x++) heights[x + dims[0] * z] = tops.top(x, z);
    const casters = { heights, dims, maxTop: Math.max(...heights), size };
    const fine = new Map(), g = (x, z) => { const k = Math.floor(x) + size[0] * Math.floor(z); let h = fine.get(k); if (h === undefined) { h = Math.floor(scene.ground(Math.floor(x) + 0.5, Math.floor(z) + 0.5, P)); if (sea > 0 && h <= sea) h = sea; fine.set(k, h); } return h; };
    for (const raw of SUNS) {
      const sun = raw.map((n) => n / Math.hypot(...raw));
      const map = (under) => {
        const out = new Uint8Array(REGION * REGION);
        for (let z = 0; z < REGION; z++) for (let x = 0; x < REGION; x++) {
          const px = x0 + x + 0.5, pz = z0 + z + 0.5, py = g(px, pz) + 0.05;
          let lit = 1;
          for (let t = 1; t < 4 * MARGIN; t += MARCH) { const qy = py + sun[1] * t; if (qy > casters.maxTop + 1) break; if (under(px + sun[0] * t, qy, pz + sun[2] * t)) { lit = 0; break; } }
          out[x + REGION * z] = lit;
        }
        return out;
      };
      const ref = map((x, y, z) => y < g(x, z)), coarse = map((x, y, z) => y < coarseHeightAt(casters, x, z));
      let edges = 0, wrong = 0, acne = 0, lit = 0;
      for (let z = 0; z < REGION; z++) for (let x = 0; x < REGION; x++) {
        const i = x + REGION * z;
        if (x + 1 < REGION && ref[i] !== ref[i + 1]) edges++;
        if (z + 1 < REGION && ref[i] !== ref[i + REGION]) edges++;
        if (ref[i] !== coarse[i]) wrong++;
        if (ref[i]) { lit++; if (!coarse[i]) acne++; }
      }
      const shift = wrong / Math.max(1, edges);
      console.log(`Island at [${Math.round(cx)}, ${Math.round(cz)}], sun ${(Math.asin(sun[1]) * 180 / Math.PI).toFixed(0)}° up: edge shift ${shift.toFixed(2)} cells, acne ${(100 * acne / lit).toFixed(2)}% of lit cells`);
      assert.ok(shift <= WORLD_SUN_COARSE_ERR, `edge shift ${shift} > ${WORLD_SUN_COARSE_ERR}`);
      assert.ok(acne <= ACNE_SHARE * lit, `${acne} of ${lit} lit cells falsely shaded`);
    }
  }
});

test('rings: near radius from the screen-error rule; the eye\'s tile is full detail; past the sharpen ring stays coarse', () => {
  assert.ok(Math.abs(WORLD_SUN_NEAR_RADIUS - WORLD_SUN_COARSE_ERR / (GEOM_ERR_PX_FULL * LOD_REF_PIXEL_RAD)) < 1e-9);
  assert.ok(WORLD_SUN_SHARPEN_RADIUS > WORLD_SUN_NEAR_RADIUS);
  const size = [1024, 128, 1024], p = worldSunProjection(size, SUNS[0]), cam = [300, 40, 700], n = p.tiles[2] * p.tiles[3];
  const all = Array.from({ length: n }, (_, i) => i), r = worldSunRings(p, cam, all, { sharpen: 1 });
  const eye = all.find((i) => worldSunTileDistance(p, cam, i) === 0);
  assert.ok(r.fine.includes(eye), 'the eye\'s own tile is full detail');
  for (const i of r.fine) assert.ok(worldSunTileDistance(p, cam, i) <= WORLD_SUN_SHARPEN_RADIUS);
  assert.equal(r.sharpened.length, 1);
  assert.equal(r.fine.length + r.coarse.length, n);
  const far = r.coarse.find((i) => worldSunTileDistance(p, cam, i) > WORLD_SUN_SHARPEN_RADIUS);
  assert.ok(worldSunRings(p, cam, all, { sharp: new Set([far]) }).fine.includes(far), 'a sharp tile stays sharp');
  assert.deepEqual(worldSunRings(p, cam, all, { coarse: false }).coarse, [], 'no ground twin: every tile full detail');
  // span sanity: a tile is WORLD_SUN_TILE texels of WORLD_SUN_PITCH cells
  assert.ok(Math.abs(WORLD_SUN_TILE * WORLD_SUN_PITCH - 106.6) < 0.1);
});

test('the coarse heightfield builds from the twin for every World scene that has one', async () => {
  const scene = WORLD_SCENES.find((s) => s.key === 'labWorld'), size = scene.size ?? WORLD_SIZE, P = scene.params({ size, seed: 0 });
  const c = await worldCoarseCasters({ size, tops: worldColumnTops({ size, scene, P }), yieldEvery: null });
  assert.deepEqual(c.dims, [size[0] / 4, size[2] / 4]);
  assert.ok(c.heights.every(Number.isFinite) && c.maxTop > 0 && c.maxTop <= size[1]);
  assert.equal(await worldCoarseCasters({ size, tops: null }), null);
});

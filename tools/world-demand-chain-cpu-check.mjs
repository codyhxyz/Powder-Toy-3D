// A WORLD load's demand must settle and stay bounded: on Island's real terrain
// (from its start and from its highest hill) and on Descent's first level, the
// CPU model of the load loop (tools/world-demand-model.mjs) must reach a
// complete first frame within WORLD_LOAD_ATTEMPTS attempts, with the sun set
// known before the first one. Fails on the chain of 2026-10-22, where every
// brick (sun casters included) was a GI SOURCE, each SOURCE's sun taps pulled
// in the next tiles and each SOURCE's own probe the next gathers: Island never
// finished loading (17 attempts to 24 tiles, then a probe chain, no frame).
// And its first attempt must be bounded (WORLD_FIRST_ATTEMPT_BRICKS), every
// sun tile the view reads drawn full detail or coarse (world/worldSunRings.js):
// fails on aeef0d0c, whose forecast asked for every visible tile's full-detail
// casters up front (Island from a hill: 30 tiles, 821k bricks, then Chrome ran
// out of GPU memory, 2026-10-22).
// And the light bounce's demand stays inside its near ring of the eye
// (world/worldGIRing.js): fails on b48dd7e4, whose gathers asked for every
// brick to the world's edge (Island's start 417k bricks in all, its hill 790k,
// Descent's first level 824k), and every load within its whole-load budget.
// CPU only: no browser, no GPU.
//   node --test tools/world-demand-chain-cpu-check.mjs
//   node tools/world-demand-chain-cpu-check.mjs --report [scene]   (per-attempt rows, every policy)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { PerspectiveCamera, Vector3 } from 'three';
import { WORLD_SCENES } from '../src/world/scenes/index.js';
import { WORLD_SIZE } from '../src/shaders/farShared.js';
import { demandWorld, modelLoad } from './world-demand-model.mjs';
import { LOAD_FLAG_MS } from '../src/loadWatch.js';
import { worldCoarseCasters, coarseSunDepth, WORLD_SUN_COARSE_NO_HIT } from '../src/world/worldSunRings.js';
import { worldColumnTops } from '../src/world/worldSunForecast.js';
import { WORLD_SUN_PITCH, WORLD_SUN_TILE } from '../src/world/worldSun.js';
import { WORLD_GI_NEAR_RADIUS, worldGIBrickNear } from '../src/world/worldGIRing.js';

const ROOT = new URL('../public', import.meta.url).pathname;
const localFetch = async (url) => new Response(await readFile(ROOT + String(url).split('?')[0]));
const SUN = [0.55, 0.62, 0.32];          // a mid-morning sun, ~46 degrees up (world-sun-forecast-cpu-check.mjs)
const EYE_LIFT = 6;                      // cells: a player's eye over the ground (1.8 m at 0.3 m a cell)
const PITCH = -8 * Math.PI / 180;        // looking a little down, inland
const VFOV = 70;                         // degrees
const VIEW = [256, 144];                 // model pixels: a brick at the far shore still spans one
// The goal (2026-10-22): the eye's demand, its sun tiles' casters, the gathers'
// SOURCES and their tiles' casters: a first attempt, one for what the view and
// the gathers find, one for the sun those SOURCES need.
export const WORLD_LOAD_ATTEMPTS = 3;
// The first attempt's bricks: its CELL stage, at the ~85 µs a brick real Chrome
// measured (Island, 2026-10-22: 821k bricks in 70 s), inside half the time
// after which the load watch calls a load stuck (loadWatch.js LOAD_FLAG_MS),
// the rest of the load the other half: 264k bricks, well under the 449k
// origin/main reached.
const CELL_US_PER_BRICK = 85;
export const WORLD_FIRST_ATTEMPT_BRICKS = Math.floor(LOAD_FLAG_MS / 2 * 1e3 / CELL_US_PER_BRICK);
// A whole load's bricks: its CELL stage in the same half of the load watch's
// time (Island start and Descent's first level, with the light bounce's near
// ring, world/worldGIRing.js; before it Island's start asked for 417k and
// Descent's 824k, the GI gathers reading to the world's edge).
export const WORLD_LOAD_BRICKS = WORLD_FIRST_ATTEMPT_BRICKS;
// What real Chrome held without running out of GPU memory, and never
// finished (Island, 2026-10-22: 449,215 bricks; 821k ran it out of memory):
// no load may ask for more, the hill's view included.
export const WORLD_HELD_BRICKS = 449215;
// The hill camera: the highest ground on a grid this many cells apart.
const HILL_GRID = 16;
// The hill's load is modelled to completion within this many attempts (it settles in 4; b48dd7e4's in 5).
const HILL_ATTEMPTS = 6;

// where: 'start' (the scene's start, looking at its centre) or 'hill' (its
// highest ground, looking at its start: most of the map in view).
async function camera(scene, where = 'start') {
  const size = scene.size ?? WORLD_SIZE, P = scene.params({ size, seed: 0 });
  await scene.prepare?.(P);
  const start = scene.start(P, [128, 128]);
  let [x, z] = start;
  if (where === 'hill') {
    let best = -Infinity;
    for (let gz = HILL_GRID / 2; gz < size[2]; gz += HILL_GRID) for (let gx = HILL_GRID / 2; gx < size[0]; gx += HILL_GRID) {
      const h = scene.ground(gx, gz, P);
      if (h > best && h + EYE_LIFT < size[1]) { best = h; x = gx; z = gz; }
    }
  }
  const cam = [x, scene.ground(x, z, P) + EYE_LIFT, z];
  const centre = where === 'hill' ? start : P.center ?? [size[0] / 2, size[2] / 2], yaw = Math.atan2(centre[1] - z, centre[0] - x);
  const fw = [Math.cos(yaw) * Math.cos(PITCH), Math.sin(PITCH), Math.sin(yaw) * Math.cos(PITCH)];
  const c = new PerspectiveCamera(VFOV, VIEW[0] / VIEW[1], 0.1, 1e5);
  c.position.set(...cam); c.lookAt(cam[0] + fw[0], cam[1] + fw[1], cam[2] + fw[2]); c.updateMatrixWorld(); c.updateProjectionMatrix();
  const viewProj = c.projectionMatrix.clone().multiply(c.matrixWorldInverse).toArray();
  const model = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], rays = [];
  for (let j = 0; j < VIEW[1]; j++) for (let i = 0; i < VIEW[0]; i++) {
    const p = new Vector3((i + 0.5) / VIEW[0] * 2 - 1, 1 - (j + 0.5) / VIEW[1] * 2, 1).unproject(c).sub(c.position).normalize();
    rays.push([p.x, p.y, p.z]);
  }
  return { size, P, cam, rays, values: { cam, viewProj, model } };
}
async function load(scene, policy, log, where = 'start') {
  const saved = globalThis.fetch;
  if (scene.sourceRegion) globalThis.fetch = localFetch;
  try {
    const { size, P, cam, rays, values } = await camera(scene, where);
    const w = demandWorld({ size, scene, P, sun: SUN });
    const r = await modelLoad(w, { cam, rays, values, sun: SUN, ...policy, log });
    return { ...r, w, cam };
  } finally { globalThis.fetch = saved; }
}

const scenes = WORLD_SCENES.filter((s) => typeof s.ground === 'function' && (!s.sourceRegion || existsSync(`${ROOT}/local-maps/noita-terrain/${s.sourceRegion.file}`)));
// Island, and Descent's first level when its converted map is present (the
// model's matter is the ground twin's heightfield, so its caves are solid:
// the counts are its surface's). Before rings Descent's model blew the heap.
const DESCENT_START = JSON.parse(await readFile(new URL('../src/world/scenes/descent/terrainRoute.json', import.meta.url), 'utf8')).startScene;
const picked = ['island', DESCENT_START].map((k) => scenes.find((s) => s.key === k)).filter(Boolean);
// Island from its hill: its first attempt is bounded and every tile shadowed,
// and since the light bounce's near ring its gathers ask for nothing past it
// (b48dd7e4's asked for 283k bricks across the island, 790k in all). It still
// takes 4 attempts and ~446k bricks: ~324k of them are the eye's own walk
// through unloaded air over the whole island (the model's view stage) and 9
// sun tiles its grazing view finds that forecastViewTiles misses: the next
// fix, view-side; gated under what Chrome held, not settled in 3 yet.
const CAMERAS = { island: { start: { settle: true }, hill: { settle: false } } };
const POLICIES = {
  'before forecast (fceb7605)': { forecast: 'none', sources: 'all', resetBirths: false },
  'casters forecast (186cefd7)': { forecast: 'eye', sources: 'all', resetBirths: false },
  'demand chain (aeef0d0c)': { forecast: 'view', sources: 'eligible', resetBirths: true },
  'sun rings (b48dd7e4)': { forecast: 'view', sources: 'eligible', resetBirths: true, rings: true },
  'this fix': { forecast: 'view', sources: 'eligible', resetBirths: true, rings: true, giRing: WORLD_GI_NEAR_RADIUS },
};
// Every brick the light bounce asked for lies inside its near ring of the eye.
const farAsked = (r) => [...r.giAsked].filter((i) => !worldGIBrickNear(r.cam, r.w.brick(i)));

if (process.argv.includes('--report')) {
  const only = process.argv[process.argv.indexOf('--report') + 1];
  const policyOnly = process.argv.includes('--policy') ? process.argv[process.argv.indexOf('--policy') + 1] : null;
  const where = process.argv.includes('--camera') ? process.argv[process.argv.indexOf('--camera') + 1] : 'start';
  for (const scene of picked.filter((s) => !only || s.key === only)) for (const [name, policy] of Object.entries(POLICIES).filter(([n]) => !policyOnly || n === policyOnly)) {
    const t0 = performance.now();
    const r = await load(scene, { ...policy, maxAttempts: 30 }, (row) => console.log(`  ${scene.key} ${where} | ${name} | att ${row.attempt} ${row.stage}: req ${row.requirements} (support ${row.support}) sun ${row.sunTiles} coarse ${row.coarseTiles} sources ${row.sources} gathers ${row.gathers}`), where);
    console.log(`${scene.key} ${where} | ${name}: ${r.done ? 'complete' : 'NOT complete'} after ${r.attempts} attempts, ${r.requirements} bricks, ${r.sunTiles} sun tiles (${r.coarseTiles} coarse), ${r.sources} sources, ${r.gathers} gathers, view-found tiles ${r.viewTiles} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }
} else {
  for (const scene of picked) for (const [where, { settle }] of Object.entries(CAMERAS[scene.key] ?? { start: { settle: true } })) test(`${scene.key} from its ${where}: ${settle ? `a load settles within ${WORLD_LOAD_ATTEMPTS} attempts and ${WORLD_LOAD_BRICKS} bricks, ` : `a load stays under the ${WORLD_HELD_BRICKS} bricks Chrome held, `}its first attempt under ${WORLD_FIRST_ATTEMPT_BRICKS} bricks, its light bounce asks for nothing past its near ring, every sun tile shadowed`, async () => {
    const rows = [];
    const r = await load(scene, { ...POLICIES['this fix'], maxAttempts: settle ? WORLD_LOAD_ATTEMPTS + 1 : HILL_ATTEMPTS }, (row) => rows.push(row), where);
    console.log(`${scene.key} ${where}: ${rows.map((row) => `att ${row.attempt} ${row.stage} req ${row.requirements} (support ${row.support}) sun ${row.sunTiles} coarse ${row.coarseTiles} src ${row.sources} gat ${row.gathers}`).join(' | ')} | total ${r.requirements}, light bounce asked ${r.giAsked.size}`);
    if (settle) assert(r.done, `not complete after ${r.attempts} attempts (${r.requirements} bricks, ${r.sunTiles} sun tiles)`);
    if (settle) assert(r.attempts <= WORLD_LOAD_ATTEMPTS, `${r.attempts} attempts`);
    assert(r.done, `not complete after ${r.attempts} attempts`);
    assert(r.requirements <= (settle ? WORLD_LOAD_BRICKS : WORLD_HELD_BRICKS), `the load asks for ${r.requirements} bricks`);
    assert.deepEqual(farAsked(r), [], 'the light bounce asked for bricks past its near ring');
    assert(rows[0].requirements <= WORLD_FIRST_ATTEMPT_BRICKS, `first attempt asks for ${rows[0].requirements} bricks`);
    // the view's own sun set is known up front: the scene's feedback adds no tile
    if (settle) assert.equal(r.viewTiles, 0, `the view asked for ${r.viewTiles} sun tiles the forecast missed`);
    // No tile without a shadow source: every tile is full detail with its
    // casters asked for, or coarse with a heightfield depth at every texel row.
    const forecast = new Set(r.forecastTiles);
    for (const i of r.fineTiles) assert(forecast.has(i), `full-detail tile ${i} has no casters asked for`);
    const size = r.w.size, casters = await worldCoarseCasters({ size, tops: worldColumnTops({ size, scene, P: r.w.P }), yieldEvery: null });
    if (r.coarse.length) assert(casters, 'coarse tiles without a ground twin');
    const { u, v, sun } = r.w.projection.basis, [x0, y0, tw] = r.w.projection.tiles, span = WORLD_SUN_TILE * WORLD_SUN_PITCH, depth = r.w.projection.depth[0];
    for (const tile of r.coarse) for (const k of [0.25, 0.5, 0.75]) {
      const a = (x0 + tile % tw + k) * span, b = (y0 + Math.floor(tile / tw) + k) * span, o = [0, 1, 2].map((m) => u[m] * a + v[m] * b + sun[m] * depth);
      const t = coarseSunDepth(casters, o, sun.map((n) => -n));
      assert(Number.isFinite(t) && t > 0 && t <= WORLD_SUN_COARSE_NO_HIT, `coarse tile ${tile}: depth ${t}`);
    }
  });
  test('the light bounce before its ring is what this check catches: Island from its hill (b48dd7e4) asks for SOURCES across the island, past what Chrome held', async () => {
    const island = picked.find((s) => s.key === 'island');
    const r = await load(island, { ...POLICIES['sun rings (b48dd7e4)'], maxAttempts: HILL_ATTEMPTS }, null, 'hill');
    assert(r.requirements > WORLD_HELD_BRICKS, `b48dd7e4's hill load asked for only ${r.requirements} bricks`);
    assert(farAsked(r).length > 0, 'b48dd7e4\'s gathers asked for nothing past the ring');
  });
  test('the chain before rings is what this check catches: Island from its hill asks for every visible tile\'s casters up front', async () => {
    const island = picked.find((s) => s.key === 'island'), rows = [];
    await load(island, { ...POLICIES['demand chain (aeef0d0c)'], maxAttempts: 1 }, (row) => rows.push(row), 'hill');
    assert(rows[0].requirements > WORLD_FIRST_ATTEMPT_BRICKS, `aeef0d0c's first attempt asked for only ${rows[0].requirements} bricks`);
  });
  test('today\'s chain is what this check catches: every brick a SOURCE does not settle', async () => {
    const island = picked.find((s) => s.key === 'island');
    const r = await load(island, { ...POLICIES['casters forecast (186cefd7)'], maxAttempts: WORLD_LOAD_ATTEMPTS + 1 });
    assert(!r.done || r.attempts > WORLD_LOAD_ATTEMPTS, `the 186cefd7 policy settled in ${r.attempts}`);
  });
}

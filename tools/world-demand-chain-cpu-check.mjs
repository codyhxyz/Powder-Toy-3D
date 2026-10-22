// A WORLD load's demand must settle: on Island's real terrain, the
// CPU model of the load loop (tools/world-demand-model.mjs) must reach a
// complete first frame within WORLD_LOAD_ATTEMPTS attempts, with the sun set
// known before the first one. Fails on the chain of 2026-10-22, where every
// brick (sun casters included) was a GI SOURCE, each SOURCE's sun taps pulled
// in the next tiles and each SOURCE's own probe the next gathers: Island never
// finished loading (17 attempts to 24 tiles, then a probe chain, no frame).
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

async function camera(scene) {
  const size = scene.size ?? WORLD_SIZE, P = scene.params({ size, seed: 0 });
  await scene.prepare?.(P);
  const [x, z] = scene.start(P, [128, 128]), cam = [x, scene.ground(x, z, P) + EYE_LIFT, z];
  const centre = P.center ?? [size[0] / 2, size[2] / 2], yaw = Math.atan2(centre[1] - z, centre[0] - x);
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
async function load(scene, policy, log) {
  const saved = globalThis.fetch;
  if (scene.sourceRegion) globalThis.fetch = localFetch;
  try {
    const { size, P, cam, rays, values } = await camera(scene);
    const w = demandWorld({ size, scene, P, sun: SUN });
    return await modelLoad(w, { cam, rays, values, sun: SUN, ...policy, log });
  } finally { globalThis.fetch = saved; }
}

const scenes = WORLD_SCENES.filter((s) => typeof s.ground === 'function' && (!s.sourceRegion || existsSync(`${ROOT}/local-maps/noita-terrain/${s.sourceRegion.file}`)));
// Island only: the model's matter is the ground twin's heightfield, and
// Descent is a cave world its twin cannot describe (its model blew the heap,
// 2026-10-22); its loads go through the same code.
const picked = ['island'].map((k) => scenes.find((s) => s.key === k)).filter(Boolean);
const POLICIES = {
  'before forecast (fceb7605)': { forecast: 'none', sources: 'all', resetBirths: false },
  'casters forecast (186cefd7)': { forecast: 'eye', sources: 'all', resetBirths: false },
  'this fix': { forecast: 'view', sources: 'eligible', resetBirths: true },
};

if (process.argv.includes('--report')) {
  const only = process.argv[process.argv.indexOf('--report') + 1];
  const policyOnly = process.argv.includes('--policy') ? process.argv[process.argv.indexOf('--policy') + 1] : null;
  for (const scene of picked.filter((s) => !only || s.key === only)) for (const [name, policy] of Object.entries(POLICIES).filter(([n]) => !policyOnly || n === policyOnly)) {
    const t0 = performance.now();
    const r = await load(scene, { ...policy, maxAttempts: 30 }, (row) => console.log(`  ${scene.key} | ${name} | att ${row.attempt} ${row.stage}: req ${row.requirements} sun ${row.sunTiles} sources ${row.sources} gathers ${row.gathers}`));
    console.log(`${scene.key} | ${name}: ${r.done ? 'complete' : 'NOT complete'} after ${r.attempts} attempts, ${r.requirements} bricks, ${r.sunTiles} sun tiles, ${r.sources} sources, ${r.gathers} gathers, view-found tiles ${r.viewTiles} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }
} else {
  for (const scene of picked) test(`${scene.key}: a load settles within ${WORLD_LOAD_ATTEMPTS} attempts, its sun set known up front`, async () => {
    const rows = [];
    const r = await load(scene, { ...POLICIES['this fix'], maxAttempts: WORLD_LOAD_ATTEMPTS + 1 }, (row) => rows.push(row));
    console.log(`${scene.key}: ${rows.map((row) => `att ${row.attempt} ${row.stage} req ${row.requirements} sun ${row.sunTiles} src ${row.sources} gat ${row.gathers}`).join(' | ')}`);
    assert(r.done, `not complete after ${r.attempts} attempts (${r.requirements} bricks, ${r.sunTiles} sun tiles)`);
    assert(r.attempts <= WORLD_LOAD_ATTEMPTS, `${r.attempts} attempts`);
    // the view's own sun set is known up front: the scene's feedback adds no tile
    assert.equal(r.viewTiles, 0, `the view asked for ${r.viewTiles} sun tiles the forecast missed`);
  });
  test('today\'s chain is what this check catches: every brick a SOURCE does not settle', async () => {
    const island = picked.find((s) => s.key === 'island');
    const r = await load(island, { ...POLICIES['casters forecast (186cefd7)'], maxAttempts: WORLD_LOAD_ATTEMPTS + 1 });
    assert(!r.done || r.attempts > WORLD_LOAD_ATTEMPTS, `the 186cefd7 policy settled in ${r.attempts}`);
  });
}

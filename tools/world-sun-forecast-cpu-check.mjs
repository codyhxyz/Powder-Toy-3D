// The sun-caster forecast (src/world/worldSunForecast.js) against each World
// scene's own ground twin: for the sun tiles around a player at the scene's
// start, the forecast must hold every brick a resident texel walk crosses
// (else the load still restarts once for its casters), and fewer than the blind
// walk asks for today (a brick it has no page for is walked through, down to
// the world's floor). Reference walks are 3x denser than the forecast's rays
// and stop on the twin's ground at four points per brick column.
// CPU only: no browser, no GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { WORLD_SCENES } from '../src/world/scenes/index.js';
import { WORLD_SIZE } from '../src/shaders/farShared.js';
import { worldSunProjection, WORLD_SUN_PITCH, WORLD_SUN_TILE } from '../src/world/worldSun.js';
import { worldColumnTops, forecastSunCasters, forecastEyeTiles, walkWorldBricks, FORECAST_SUN_SPACING } from '../src/world/worldSunForecast.js';
import { BRICK } from '../src/shaders/common.js';

const ROOT = new URL('../public', import.meta.url).pathname;
// Descent's map data is local (public/local-maps), so CI checks the scenes it has.
const localFetch = async (url) => new Response(await readFile(ROOT + String(url).split('?')[0]));
const SUN = [0.55, 0.62, 0.32];          // a mid-morning sun, ~46 degrees up
const REFERENCE_STEP = FORECAST_SUN_SPACING / 3;
const EYE_LIFT = 6;                      // cells: a player's eye over the ground
const RING = 1;                          // tiles around the eye's: the scene's first wave

async function model(scene) {
  const size = scene.size ?? WORLD_SIZE, P = scene.params({ size, seed: 0 }), dims = size.map((n) => n / BRICK);
  await scene.prepare?.(P);
  const [x, z] = scene.start(P, [128, 128]), cam = [x, scene.ground(x, z, P) + EYE_LIFT, z];
  const projection = worldSunProjection(size, SUN), [, , w, h] = projection.tiles, tiles = new Set();
  for (const e of forecastEyeTiles(projection, cam)) for (let dy = -RING; dy <= RING; dy++) for (let dx = -RING; dx <= RING; dx++) {
    const tx = e % w + dx, ty = Math.floor(e / w) + dy;
    if (tx >= 0 && ty >= 0 && tx < w && ty < h) tiles.add(tx + w * ty);
  }
  const tops = worldColumnTops({ size, scene, P }), forecast = new Set();
  await forecastSunCasters({ size, direction: SUN, tiles: [...tiles], tops, mark: (i) => forecast.add(i), yieldEvery: null });
  const ground = new Map(), exact = (cx, cz) => {
    const k = cx + size[0] * cz;
    if (!ground.has(k)) { const g = scene.ground(cx, cz, P); ground.set(k, P.sea > 0 && g <= P.sea ? 0 : g); }
    return ground.get(k);
  };
  const { u, v, sun } = projection.basis, span = WORLD_SUN_TILE * WORLD_SUN_PITCH, d = sun.map((s) => -s);
  const blind = new Set(), needed = new Set();
  for (const tile of tiles) {
    const a0 = (projection.tiles[0] + tile % w) * span, b0 = (projection.tiles[1] + Math.floor(tile / w)) * span;
    for (let b = b0 + REFERENCE_STEP / 2; b < b0 + span; b += REFERENCE_STEP) for (let a = a0 + REFERENCE_STEP / 2; a < a0 + span; a += REFERENCE_STEP) {
      const o = [0, 1, 2].map((k) => u[k] * a + v[k] * b + sun[k] * projection.depth[0]);
      walkWorldBricks(size, o, d, (bx, by, bz) => { blind.add(bx + dims[0] * (by + dims[1] * bz)); return false; });
      walkWorldBricks(size, o, d, (bx, by, bz) => {
        needed.add(bx + dims[0] * (by + dims[1] * bz));
        for (let k = 0; k < 4; k++) if (by * BRICK < exact(bx * BRICK + (k & 1 ? 3 : 1), bz * BRICK + (k & 2 ? 3 : 1))) return true;
        return false;
      });
    }
  }
  return { tiles: tiles.size, forecast, blind, needed, missed: [...needed].filter((i) => !forecast.has(i)).length };
}

const scenes = WORLD_SCENES.filter((s) => typeof s.ground === 'function' && (!s.sourceRegion || existsSync(`${ROOT}/local-maps/noita-terrain/${s.sourceRegion.file}`)));
const picked = ['island', 'willowCove', 'labWorld', 'volcanoWorld', 'giantVolcano'].map((k) => scenes.find((s) => s.key === k)).filter(Boolean);
const descent = scenes.find((s) => s.sourceRegion);
if (descent) picked.push(descent);
for (const scene of picked) test(`${scene.key}: forecast holds every caster a resident sun walk needs, below the blind walk's ask`, async () => {
  const saved = globalThis.fetch;
  if (scene.sourceRegion) globalThis.fetch = localFetch;
  try {
    const m = await model(scene);
    assert(m.tiles > 1 && m.needed.size > 0, 'tiles with casters');
    assert.equal(m.missed, 0, `${m.missed} of ${m.needed.size} casters missed (a restart)`);
    assert(m.forecast.size < m.blind.size, `forecast ${m.forecast.size} >= blind ${m.blind.size}`);
    console.log(`${scene.key}: ${m.tiles} tiles, casters needed ${m.needed.size}, forecast ${m.forecast.size}, blind walk asks ${m.blind.size}`);
  } finally { globalThis.fetch = saved; }
});

test('eye tiles are the point probe\'s four bilinear taps, clipped to the grid', () => {
  const size = [16, 8, 8], projection = worldSunProjection(size, [1, 1, 1]);
  assert.deepEqual(forecastEyeTiles(projection, [0, 0, 0]), [0, 1, 2, 3]);   // on a tile corner
  assert.deepEqual(forecastEyeTiles(projection, [NaN, 0, 0]), []);
  assert.deepEqual(forecastEyeTiles(projection, null), []);
});

test('a scene without a ground twin forecasts nothing', () => {
  assert.equal(worldColumnTops({ size: [16, 8, 8], scene: {}, P: {} }), null);
});

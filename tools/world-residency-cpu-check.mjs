// A big map's view keeps the ground it shows when memory fills: old bricks the
// camera has left go first (world/worldResidency.js), never the ones on screen.
// CPU only: the actual World owner (wire/worldRender.js installWorldRender) over
// the actual Source/Fields/CELL/Atlas/lighting path (tools/world-render-owner-fixture.mjs).
//
// Island from God view, live 2026-10-23 (9abecfef): half the island a flat grey
// hole. Every brick ever loaded stayed in each load's demand, held, so once
// they filled the page budget the budget dropped the ground on screen instead.
// Here a camera high over the map (past the near ring, as God view is) looks
// down at one patch, then the next, round the map twice, each patch about half
// the budget; every tick accepted and displayed as the renderer does:
//   - every brick in the camera's frustum has a CELL page after its tick;
//   - the lighting rows held stay within WORLD_RESIDENT_SHARE of the budget
//     plus the tick's own asks.
//
//   node tools/world-residency-cpu-check.mjs [--verbose]
import assert from 'node:assert/strict';
import { Frustum, Matrix4, PerspectiveCamera, Box3, Vector3 } from 'three';
import { setup, settle, post } from './world-render-owner-fixture.mjs';
import { READY, worldBrickIndex } from '../src/world/renderAtlas.js';
import { worldPageBudget, WORLD_CELL_PAGE_BYTES, WORLD_LIGHT_PAGE_BYTES, WORLD_GPU_MEMORY_SHARE } from '../src/world/worldViewRing.js';
import { WORLD_RESIDENT_SHARE } from '../src/world/worldResidency.js';

const VERBOSE = process.argv.includes('--verbose');
// A world SIZE cells square, 8 tall (two brick rows), seen from EYE_Y cells up
// (past the view's near ring, ~110 cells, as God view is) through a FOV-degree lens.
const SIZE = 256, EYE_Y = 180, FOV = 40;
// The patches the camera looks down at in turn, round the map twice.
const PATCHES = [[64, 64], [192, 64], [192, 192], [64, 192]], TICKS = 2 * PATCHES.length;
// The page budget: each patch's ~1.9k bricks are about half of it, so the
// patches seen before fill it by the third.
const BUDGET_PAGES = 4000;

const gb = BUDGET_PAGES * (WORLD_CELL_PAGE_BYTES + WORLD_LIGHT_PAGE_BYTES) / (WORLD_GPU_MEMORY_SHARE * 1024 ** 3);
Object.defineProperty(globalThis.navigator, 'deviceMemory', { value: gb, configurable: true });
const budget = worldPageBudget({ deviceMemoryGB: gb });

const f = await setup({ size: [SIZE, 8, SIZE], feedback: false });
const atlas = f.owner.atlas, wb = [SIZE / 4, 2, SIZE / 4];
const warn = console.warn;
console.warn = (m, ...rest) => { if (VERBOSE || !/over its GPU page budget/.test(String(m))) warn(m, ...rest); };
const rows = [];
let displayed = null;
try {
  for (let k = 0; k < TICKS; k++) {
    const [px, pz] = PATCHES[k % PATCHES.length], eye = [px, EYE_Y, pz];
    const camera = new PerspectiveCamera(FOV, 1, 1, 1000);
    camera.position.set(...eye); camera.up.set(0, 0, -1); camera.lookAt(px, 0, pz); camera.updateMatrixWorld();
    const viewProj = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new Frustum().setFromProjectionMatrix(viewProj), box = new Box3();
    const shown = [];
    for (let z = 0; z < wb[2]; z++) for (let y = 0; y < wb[1]; y++) for (let x = 0; x < wb[0]; x++)
      if (frustum.intersectsBox(box.set(new Vector3(x * 4, y * 4, z * 4), new Vector3(x * 4 + 4, y * 4 + 4, z * 4 + 4)))) shown.push([x, y, z]);
    const demand = shown.map((brick) => ({ brick, channels: READY.CELL }));
    const values = { cam: eye, viewProj: viewProj.toArray(), model: new Matrix4().toArray() };
    let c;
    try { c = await settle(f.gpu, f.owner.request({ ...f.frame, values }, demand)); }
    catch (e) { assert.fail(`tick ${k} (${demand.length} bricks shown): ${e.message}`); }
    assert(await settle(f.gpu, f.owner.accept(c, post(c))), `tick ${k} accepted`);
    displayed?.release(); displayed = c;
    const missing = shown.filter((b) => !atlas.live.cell.has(worldBrickIndex(atlas.bookLayout, b))).length;
    const row = { tick: k, shown: shown.length, missing, rows: f.owner.metadata.size, live: atlas.live.cell.size };
    rows.push(row); if (VERBOSE) console.log(JSON.stringify(row));
    assert.equal(missing, 0, `tick ${k}: ${missing} of the ${shown.length} bricks on screen have no page (the grey hole)`);
    assert(row.rows <= Math.floor(budget.cell * WORLD_RESIDENT_SHARE) + shown.length, `tick ${k}: ${row.rows} lighting rows held, past the residency share`);
  }
} finally { console.warn = warn; displayed?.release(); await f.close(); }
console.log(`PASS the ground on screen keeps its pages when memory fills (budget ${budget.cell} pages):`
  + ` shown ${rows.map((r) => r.shown).join('/')}, rows held ${rows.map((r) => r.rows).join('/')}, none on screen missing`);

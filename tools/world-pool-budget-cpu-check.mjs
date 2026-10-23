// A big map's CELL page pool stays under its GPU page budget tick after tick
// while the world changes. CPU only: the actual World owner
// (wire/worldRender.js installWorldRender) over the actual Source/Fields/CELL/
// Atlas/lighting path (tools/world-render-owner-fixture.mjs), its page budget
// the one a device of this little memory gets (world/worldViewRing.js
// worldPageBudget, from navigator.deviceMemory, as in Chrome).
//
// Descent (real Chrome, 2026-10-22, build f30ae08a): ~40 s after its first
// frame every transaction threw "WORLD page budget: cell pool of 1067442 pages
// past 1048576". A re-pack of the bricks a tick changed holds a second page for
// each while the displayed frame's snapshot holds the first, and the bricks the
// budget never drops (inside the near ring, a record's, a glow core's) are no
// bound on how many that is. Here, ticks of churn (a physics-sized change box
// around an eye that moves, the demand moving with it, every tick accepted and
// displayed as the renderer does) on a world whose demand is past its budget:
//   - no tick throws;
//   - the pool's pages (live, pending, superseded and pinned, retiring) never
//     pass its budget, and its capacity never grows past it;
//   - the oldest snapshot's superseded pages are taken back when the pool is
//     full, and an expired snapshot refuses new bindings.
//
//   node tools/world-pool-budget-cpu-check.mjs [--ticks N] [--verbose]
import assert from 'node:assert/strict';
import { setup, settle, post } from './world-render-owner-fixture.mjs';
import { READY, WORLD_SNAPSHOT_EXPIRED } from '../src/world/renderAtlas.js';
import { worldPageBudget, WORLD_CELL_PAGE_BYTES, WORLD_LIGHT_PAGE_BYTES, WORLD_GPU_MEMORY_SHARE } from '../src/world/worldViewRing.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? +args[i + 1] : d; };
const VERBOSE = args.includes('--verbose');
// A world SIZE cells square, 8 tall (two brick rows), an eye at EYE_Y.
const SIZE = 256, EYE_Y = 6;
const TICKS = opt('ticks', 8);
// The demand: every brick within DEMAND_RADIUS cells of the eye (past the
// view's near ring, ~110 cells, some of it can be dropped).
const DEMAND_RADIUS = 130;
// The page budget: a device whose memory share holds this many demanded pages
// (the demand above is 5.3k-6.6k bricks, so it is past it from the first load).
const BUDGET_PAGES = 4000;   // (base 8e7b7e66: tick 1 throws "cell pool of 8266 pages past 8000")
// Each tick the eye moves this many cells, and a change box this many cells a
// side around it changes (V2's window, 128 cells, noted whole every step: v2/physics.js _ran).
const EYE_STEP = 24, CHANGE_SIDE = 128;

const gb = BUDGET_PAGES * (WORLD_CELL_PAGE_BYTES + WORLD_LIGHT_PAGE_BYTES) / (WORLD_GPU_MEMORY_SHARE * 1024 ** 3);
Object.defineProperty(globalThis.navigator, 'deviceMemory', { value: gb, configurable: true });
const budget = worldPageBudget({ deviceMemoryGB: gb }), cap = budget.pool.cell;
assert(Math.abs(budget.cell - BUDGET_PAGES) <= 1, `the fixture's budget is ${budget.cell} pages`);

// (a ground twin: the light bounce's near ring, worldGIRing.js, bounds its SOURCES as on a real map)
const f = await setup({ size: [SIZE, 8, SIZE], feedback: false, ground: () => 2 });
const atlas = f.owner.atlas, wb = [SIZE / 4, 2, SIZE / 4];
const used = () => atlas.cell.nextID - atlas.cell.free.length;
// The most pages the pool held at any reservation or growth, within a tick.
let peak = 0;
for (const name of ['reserve', 'growPool']) {
  const original = atlas[name].bind(atlas);
  atlas[name] = (...a) => { const r = original(...a); peak = Math.max(peak, used()); assert(atlas.resources.layout.capacity <= cap, `the CELL pool grew to ${atlas.resources.layout.capacity} pages, past its ${cap}`); return r; };
}
const warn = console.warn; let dropped = 0;
console.warn = (m, ...rest) => { const n = /: (\d+) farthest bricks dropped/.exec(String(m)); if (n) dropped += +n[1]; else warn(m, ...rest); };
const rows = [];
let displayed = null, expired = 0;
try {
  for (let k = 0; k < TICKS; k++) {
    const eye = [SIZE / 4 + (k * EYE_STEP) % (SIZE / 2), EYE_Y, SIZE / 2];
    if (k) { const h = CHANGE_SIDE / 2; f.source.noteContentChange({ lo: [eye[0] - h, 0, eye[2] - h], hi: [eye[0] + h, 8, eye[2] + h] }); f.sim.version++; }
    const demand = [{ brick: eye.map((n, i) => Math.min(Math.floor(n / 4), wb[i] - 1)), channels: READY.GI_SOURCE | READY.GI }];
    for (let z = 0; z < wb[2]; z++) for (let y = 0; y < wb[1]; y++) for (let x = 0; x < wb[0]; x++)
      if (Math.hypot(x * 4 + 2 - eye[0], z * 4 + 2 - eye[2]) < DEMAND_RADIUS) demand.push({ brick: [x, y, z], channels: READY.CELL });
    peak = used();
    let c;
    try { c = await settle(f.gpu, f.owner.request({ ...f.frame, values: { cam: eye } }, demand)); }
    catch (e) { assert.fail(`tick ${k} (${demand.length} bricks asked, pool ${used()} of ${cap} pages): ${e.message}`); }
    assert(await settle(f.gpu, f.owner.accept(c, post(c))), `tick ${k} accepted`);
    // the renderer's displayed frame: held until the next one is (worldRenderFrame.js displayedMainFrame)
    if (displayed?.snapshot.expired) {
      expired++;
      assert.throws(() => displayed.snapshot.bindings({}, { size: 1e9 }), new RegExp(WORLD_SNAPSHOT_EXPIRED.slice(0, 20)));
    }
    displayed?.release(); displayed = c;
    const row = { tick: k, asked: demand.length, peak, used: used(), live: atlas.live.cell.size, capacity: atlas.resources.layout.capacity };
    rows.push(row); if (VERBOSE) console.log(JSON.stringify(row));
    assert(peak <= cap, `tick ${k}: the CELL pool held ${peak} pages, past its budget of ${cap}`);
  }
} finally { console.warn = warn; displayed?.release(); await f.close(); }
assert(dropped > 0, 'the fixture is past its budget: the farthest bricks degrade');
assert(expired > 0, 'a full pool took a displayed snapshot\'s superseded pages back at least once');
console.log(`PASS a big map's CELL pool stays under its page budget through ${TICKS} ticks of churn (budget ${budget.cell} pages, pool ${cap}):`
  + ` peak pages a tick ${rows.map((r) => r.peak).join('/')}; live ${rows.map((r) => r.live).join('/')}; ${dropped} farthest bricks degraded, ${expired} displayed snapshots expired, no throw`);

// The world window's budgets on the default World, the Island (tools/budget-
// check.mjs, docs/webgpu.md I1, J4, G1), beside world.mjs's Lab Complex: its
// own page, so `--unit world-island` boots only it (a world's boot is minutes
// here). Through a 64-wide window (?win=64), parked (manual mode). Unlike the
// Lab's, the island's moves run its prepass before the fill and the leaving
// slab's kernel, keep the bricks its trees stand in, bring them back, and
// plant the trees of the columns they visit first.
//
// The moves go along x the way more trees stand (two steps out), after a
// warm-up out and back: one move that restores the bricks its warm-up kept
// (the restore's upload, its edit), then one into columns never visited (the
// trees' shapes and mask uploaded into the stamp pool, one stamp edit per
// tree). Their uploads are unordered writes (world/window.js restore,
// world/gpu.js Stamper): no command in the open encoder reads the buffers, so
// a move is one submit (with ordered writes each of these was two, and 9
// compute passes: the write flushed the move so far; a move that restores and
// plants, three), and after the warm-up nothing is allocated (the restore buffer, the
// stamp pool and the readback's staging are kept). A leaving slab that keeps
// more bricks than the readback's estimate would cost a second submit (the
// second read: world/window.js readBack); these don't. Measured here: the
// restore 8 compute passes, 14 dispatches (the Lab's 11, the island's two
// prepasses, the restore); the planting 8 and 21 (its trees one stamp each).
// A change that moves one of these numbers says why.
const delta = (a, b) => Object.fromEntries(Object.keys(b).filter((k) => typeof b[k] === 'number').map((k) => [k, b[k] - a[k]]));
const STEP = 16;   // world/window.js WIN_STEP
export default {
  unit: 'world-island',
  page: '/?map=island&view=plain&win=64',
  mode: 'manual',
  viewport: { width: 320, height: 200 },
  async ready(page) {
    await page.waitForFunction(() => window.__app?.win?.loaded || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 300000 });
    await page.evaluate(() => window.__app.test.ready());
  },
  scenarios: [
    {
      name: 'an island window move restoring the bricks a move kept (64-wide window): one submit, its readback, nothing allocated or built',
      async run(page) {
        return page.evaluate(async ([d, STEP]) => {
          const a = window.__app, w = a.win, g = a.sim.g, o = a.sim.origin, f = (0, eval)(d);
          // the way more trees stand in the slab two steps out (and the window can go)
          const trees = (s) => {
            const x0 = s > 0 ? o.x + g.nx + STEP : o.x - 2 * STEP;
            if (x0 < 0 || x0 + STEP > w.size[0]) return -1;
            return w.scene.trees.treesIn(x0, o.z, x0 + STEP, o.z + g.nz, w.P, w.candidates).length;
          };
          const s = trees(1) >= trees(-1) ? 1 : -1;
          window.__islandStep = s * STEP;
          const move = async (dx) => { w.shift(dx, 0); await a.gpu.fence(); await w.pending; };
          await move(s * STEP);
          await move(-s * STEP);
          const s0 = { ...a.gpu.stats };
          await move(s * STEP);
          return { stats: f(s0, a.gpu.stats), kept: w.last.kept, restored: w.last.restored, trees: w.last.trees };
        }, [delta.toString(), STEP]);
      },
      expect: {
        submits: 1, pipelinesCreated: 0, computePasses: { max: 8 }, dispatches: { max: 14 },
        restored: { min: 1 }, trees: 0, bytesAllocated: 0, bytesReadBack: { max: 400000 },
      },
    },
    {
      name: 'an island window move into columns never visited, planting their trees (64-wide window): one submit, its readback, nothing allocated or built',
      async run(page) {
        return page.evaluate(async (d) => {
          const a = window.__app, w = a.win, f = (0, eval)(d);
          const s0 = { ...a.gpu.stats };
          w.shift(window.__islandStep, 0);
          await a.gpu.fence();
          await w.pending;
          return { stats: f(s0, a.gpu.stats), kept: w.last.kept, restored: w.last.restored, trees: w.last.trees };
        }, delta.toString());
      },
      expect: {
        submits: 1, pipelinesCreated: 0, computePasses: { max: 8 }, dispatches: { max: 21 },
        restored: 0, trees: { min: 1 }, bytesAllocated: 0, bytesReadBack: { max: 400000 },
      },
    },
  ],
};

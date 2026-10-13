// The world window's budgets (tools/budget-check.mjs, docs/webgpu.md I1, J4,
// G1): what a window move costs in gpu.stats, in the app on a World map
// through a 64-wide window (?win=64: the container's budget), parked (manual
// mode). The Lab Complex: its scene has no trees and no prepass, so a move is
// the same work each time. A change that moves one of these numbers says why.
//
// A move (world/window.js shift), recorded into one frame: the leaving slab's
// kernel (one dispatch) and its readback (two copies: the head and a prefix of
// the cells), the far field's summary of the slab (farWin) and its field
// (farBoost), the shift (the state, the flow and its copy back, the derived
// passes' own: src/derived.js), the fill (an edit), nothing restored. The
// first move after load allocates the readback's staging; the next ones
// allocate nothing and build no pipeline. Measured here: 7 compute passes, 11
// dispatches, 139268 bytes read back (the head and the prefix: no brick of
// the Lab's leaving slab differs from its scene).
const delta = (a, b) => Object.fromEntries(Object.keys(b).filter((k) => typeof b[k] === 'number').map((k) => [k, b[k] - a[k]]));
export default {
  unit: 'world',
  page: '/?map=labWorld&view=plain&win=64',
  mode: 'manual',
  viewport: { width: 320, height: 200 },
  async ready(page) {
    await page.waitForFunction(() => window.__app?.win?.loaded || document.getElementById('error')?.textContent, null, { polling: 250, timeout: 300000 });
    await page.evaluate(() => window.__app.test.ready());
  },
  scenarios: [
    {
      name: 'a window move (64-wide window, Lab Complex): one frame, its leaving slab read back, nothing allocated or built',
      async run(page) {
        return page.evaluate(async (d) => {
          const a = window.__app, w = a.win, f = (0, eval)(d);
          // a first move out and back (the readback's staging, the far field's groups), then the measured one
          for (const dx of [16, -16]) { w.shift(dx, 0); await a.gpu.fence(); await w.pending; }
          const s0 = { ...a.gpu.stats };
          w.shift(16, 0);
          await a.gpu.fence();
          await w.pending;
          const stats = f(s0, a.gpu.stats);
          return { stats, kept: w.last.kept, restored: w.last.restored };
        }, delta.toString());
      },
      expect: {
        submits: 1, computePasses: { max: 7 }, dispatches: { max: 11 }, pipelinesCreated: 0, bytesAllocated: 0,
        bytesReadBack: { max: 140000 }, kept: 0, restored: 0,
      },
    },
  ],
};

// The app's budgets (tools/budget-check.mjs, docs/webgpu.md I1, B3, F7): what
// a box session costs, through gpu.stats and the frame loop's own count of
// animation frames (__app.loop.callbacks: the app's ticks, not a replaced
// rAF). A change that moves one of these numbers says why.
//
// The box: an empty 64³ grid in the plain view (B5: the cheapest to build),
// parked (manual mode) until a scenario runs the loop. In box mode three.js
// draws nothing, so a presented frame is one command buffer (B3).
const delta = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - a[k]]));
export default {
  unit: 'app',
  page: '/?size=64&preset=empty&view=plain',
  mode: 'manual',
  viewport: { width: 320, height: 200 },
  async ready(page) {
    await page.waitForFunction(() => window.__app?.sim, null, { polling: 100, timeout: 150000 });
    await page.evaluate(() => window.__app.test.ready());
  },
  scenarios: [
    {
      // paused, TAA off (the view converges in one frame), the loop running:
      // once the derived passes and the view have settled it stops scheduling
      // frames at all (deep idle), so a second costs nothing
      name: 'a settled box scene: no submits and no animation frames over 1 s',
      async run(page) {
        await page.evaluate(() => { const a = window.__app; a.post.settings.taa = false; a.test.resume(); });
        await page.waitForFunction(() => window.__app.loop.asleep, null, { polling: 250, timeout: 240000 });
        return page.evaluate(async (d) => {
          const a = window.__app, s0 = { ...a.gpu.stats }, c0 = a.loop.callbacks;
          await new Promise((r) => setTimeout(r, 1000));
          const out = { stats: (0, eval)(d)(s0, a.gpu.stats), callbacks: a.loop.callbacks - c0, asleep: a.loop.asleep };
          a.post.settings.taa = true;
          a.test.park();
          return out;
        }, delta.toString());
      },
      expect: { submits: 0, flushes: 0, dispatches: 0, draws: 0, callbacks: 0, asleep: true },
    },
    {
      // one presented frame of the settled box, TAA on: the scene pass (the
      // floor grid, the volume, the box's edges), TAA, the canvas; the plain
      // view is a data view (raw: no bloom, no adaptation, no compute pass)
      name: 'a box view frame: 1 submit, scene + TAA + canvas',
      run: (page) => page.evaluate(async (d) => {
        const a = window.__app, s0 = { ...a.gpu.stats };
        await a.test.renderOnce();
        return { stats: (0, eval)(d)(s0, a.gpu.stats) };
      }, delta.toString()),
      expect: { submits: 1, renderPasses: 3, computePasses: 0, dispatches: 0, draws: 5, pipelinesCreated: 0, bytesAllocated: 0 },
    },
    {
      // a stroke (its own submit: recorded outside a tick, flushed by the
      // microtask), then a frame that runs the derived passes: the dirty
      // lists, the fields, bricks, empty-space distance and glow over the
      // changed bricks, the shadow map, all in one compute pass of the frame
      name: 'a stroke, then a derived frame: 2 submits, one compute pass in the frame',
      run: (page) => page.evaluate(async (d) => {
        const a = window.__app, { E } = await import('/src/elements.js');
        const s0 = { ...a.gpu.stats };
        a.sim.paint({ center: new a.THREE.Vector3(32, 20, 32), radius: 3, shape: 0, tool: E.STONE, rate: 1, replace: false });
        await a.gpu.fence();
        const s1 = { ...a.gpu.stats };
        await a.test.renderOnce();
        const f = (0, eval)(d)(s1, a.gpu.stats);
        return { stats: (0, eval)(d)(s0, a.gpu.stats), frameSubmits: f.submits, frameComputePasses: f.computePasses };
      }, delta.toString()),
      expect: { submits: 2, renderPasses: 3, pipelinesCreated: 0, bytesAllocated: 0, frameSubmits: 1, frameComputePasses: 1 },
    },
  ],
};

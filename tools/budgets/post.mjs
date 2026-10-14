// Post's budgets (tools/budget-check.mjs, docs/webgpu.md I1, W16, F7): what a
// presented frame's post-processing costs, measured on post's harness page
// (a synthetic scene target at 400×250) through gpu.stats. A change that
// moves one of these numbers says why.
//
// Every frame here is the harness's scene pass (one draw), then post. W16's
// shape: 4 render passes of post's (the motion pass, the bloom prefilter,
// bloom's up[0], the bloom image: up[0]'s tent, which the canvas pass reads in
// one tap) and 1 compute pass (bloom down 1–5 and up 4–1, then the
// one-workgroup reduction: luminance grid, histogram, adaptation, meter),
// besides the scene and canvas passes. With TAA, three's TAAU runs between
// the motion pass and the prefilter in submits of its own (its resolve, its
// history and previous-depth copies): ours before it, its 3, ours after = 5;
// one submit without TAA when three has nothing to draw (B3).
const TAAU_SUBMITS = 5;
const frame = { submits: TAAU_SUBMITS, renderPasses: 6, computePasses: 1, dispatches: 10, draws: 6, bytesAllocated: 0, pipelinesCreated: 0 };
export default {
  unit: 'post',
  page: '/tools/harness/post.html',
  harness: true,
  scenarios: [
    {
      name: 'a presented frame (TAA, bloom, adaptation): scene + 4 render passes + canvas, 1 compute pass, three\'s TAAU',
      run: (page) => page.evaluate(() => window.__harness.run('budget:frame')),
      // param slots: the scene's draw, the motion pass, prefilter, 9 bloom mips, the reduction, up[0], the bloom
      // image (no params: the shared zero slot), the composite, and a header for each of our two submits (before
      // three's TAAU and after it)
      expect: { ...frame, bytesUploaded: { max: 18 * 256 } },
    },
    {
      name: 'TAAU (upscale 1/1.5): the same passes',
      run: (page) => page.evaluate(() => window.__harness.run('budget:taau')),
      expect: frame,
    },
    {
      name: 'E1\'s FrameUniforms reader recorded in compute(), after prepare()\'s write: no extra submit, no write flush (B3)',
      run: (page) => page.evaluate(() => window.__harness.run('frameUniforms', { route: 'hooks' })),
      // the reader's own compute pass and dispatch besides the frame's
      expect: { ...frame, computePasses: 2, dispatches: 11, writeFlushes: 0 },
    },
    {
      // adaptation off, so the reduction runs only for the meter: in 8 frames it
      // runs on 2 (every METER_INTERVAL), inside the bloom's compute pass
      name: 'night vision\'s meter rides in the post compute pass, every 4th frame',
      run: (page) => page.evaluate(() => window.__harness.run('budget:meter')),
      expect: { ...frame, metered: 2, unmeteredDispatches: 9, sceneLuma: { min: 1e-3 } },
    },
    {
      name: 'TAA off: no motion pass, no TAAU (scene, prefilter, up[0], the bloom image, canvas)',
      run: (page) => page.evaluate(() => window.__harness.run('budget:noTaa')),
      expect: { submits: 1, renderPasses: 5, computePasses: 1, dispatches: 10, draws: 5, bytesAllocated: 0 },
    },
    {
      name: 'a data view (raw): no bloom, no adaptation, no compute pass (scene, motion, TAAU, canvas)',
      run: (page) => page.evaluate(() => window.__harness.run('budget:raw')),
      expect: { submits: TAAU_SUBMITS, renderPasses: 3, computePasses: 0, dispatches: 0, draws: 3, bytesAllocated: 0 },
    },
    {
      name: 'a thumbnail (renderStill, 320×200): scene + composite',
      run: (page) => page.evaluate(() => window.__harness.run('budget:still')),
      expect: { submits: 1, renderPasses: 2, computePasses: 0, draws: 2, bytesAllocated: 0 },
    },
    {
      name: 'what post holds at 400×250 (11 bloom levels, the bloom image, state; the scene target and TAAU\'s are three\'s)',
      run: (page) => page.evaluate(() => window.__harness.run('budget:memory')),
      // 531 KB bloom levels + the 200 KB bloom image (half size) + the state and result ring (three's renderer is on
      // this page, as in the app)
      expect: { bytes: { max: 8e5 } },
    },
  ],
};

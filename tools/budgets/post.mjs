// Post's budgets (tools/budget-check.mjs, docs/webgpu.md I1, W16, F7): what a
// presented frame's post-processing costs, measured on post's harness page
// (a synthetic scene target at 400×250) through gpu.stats. A change that
// moves one of these numbers says why.
//
// Every frame here is the harness's scene pass (one draw), then post. W16's
// shape: 3 render passes of post's (TAA, the bloom prefilter, bloom's up[0])
// and 1 compute pass (bloom down 1–5 and up 4–1, then the one-workgroup
// reduction: luminance grid, histogram, adaptation, meter), besides the scene
// and canvas passes; one submit when three has nothing to draw (B3).
const frame = { submits: 1, renderPasses: 5, computePasses: 1, dispatches: 10, draws: 5, bytesAllocated: 0, pipelinesCreated: 0 };
export default {
  unit: 'post',
  page: '/tools/harness/post.html',
  harness: true,
  scenarios: [
    {
      name: 'a presented frame (TAA, bloom, adaptation): scene + 3 render passes + canvas, 1 compute pass, 1 submit',
      run: (page) => page.evaluate(() => window.__harness.run('budget:frame')),
      // param slots: the scene's draw, TAA, prefilter, 9 bloom mips, the reduction, up[0], the composite, one header
      expect: { ...frame, bytesUploaded: { max: 16 * 256 } },
    },
    {
      name: 'TAAU (upscale 1/1.5): the same passes',
      run: (page) => page.evaluate(() => window.__harness.run('budget:taau')),
      expect: frame,
    },
    {
      name: 'night vision\'s meter rides in the same reduction dispatch',
      run: (page) => page.evaluate(() => window.__harness.run('budget:meter')),
      expect: frame,
    },
    {
      name: 'TAA off: no TAA pass (scene, prefilter, up[0], canvas)',
      run: (page) => page.evaluate(() => window.__harness.run('budget:noTaa')),
      expect: { submits: 1, renderPasses: 4, computePasses: 1, dispatches: 10, draws: 4, bytesAllocated: 0 },
    },
    {
      name: 'a data view (raw): no bloom, no adaptation, no compute pass (scene, TAA, canvas)',
      run: (page) => page.evaluate(() => window.__harness.run('budget:raw')),
      expect: { submits: 1, renderPasses: 3, computePasses: 0, dispatches: 0, draws: 3, bytesAllocated: 0 },
    },
    {
      name: 'a thumbnail (renderStill, 320×200): scene + composite',
      run: (page) => page.evaluate(() => window.__harness.run('budget:still')),
      expect: { submits: 1, renderPasses: 2, computePasses: 0, draws: 2, bytesAllocated: 0 },
    },
    {
      name: 'what post holds at 400×250 (scene colour + depth, 2 history, 11 bloom levels, state)',
      run: (page) => page.evaluate(() => window.__harness.run('budget:memory')),
      // 400·250·(8 + 4) scene + 2·400·250·8 history + 531 KB bloom + the state and result ring: 3,331,768 B
      expect: { bytes: { max: 3.4e6 } },
    },
  ],
};

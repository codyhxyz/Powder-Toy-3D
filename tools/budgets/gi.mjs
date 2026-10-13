// The GI probes' budgets (tools/budget-check.mjs, docs/webgpu.md I1, J4):
// what a derived frame of the realistic view costs with its GI (shaders/gi.js,
// src/derived.js updateGI), on the GI harness page (tools/harness/gi-check.html).
// A change that moves one of these numbers says why.
export default {
  unit: 'gi',
  page: '/tools/harness/gi-check.html',
  harness: true,
  scenarios: [
    {
      name: 'a derived frame with the GI (32³, a cube and a slab): the derived frame\'s 30 dispatches and 2 direct ones, one pass, one submit',
      run: (page) => page.evaluate(() => window.__harness.run('budget:frame')),
      // derived (tools/budgets/derived.mjs): 9 indirect (×2) + 12 direct, 89 direct workgroups at 512 bricks;
      // the GI: giSource a workgroup per brick (512), giGather two probes a workgroup over half of them (128)
      expect: {
        submits: 1, flushes: 1, writeFlushes: 0, computePasses: 1, renderPasses: 0, dispatches: 32, indirectDispatches: 9,
        workgroupsDirect: 729, bytesAllocated: 0, pipelinesCreated: 0,
      },
    },
    {
      name: 'the frame after sim.resetGI(): the gather traces every probe (256 workgroups); the clears come before the pass',
      run: (page) => page.evaluate(() => window.__harness.run('budget:reset')),
      expect: {
        submits: 1, flushes: 1, writeFlushes: 0, computePasses: 1, renderPasses: 0, dispatches: 32, indirectDispatches: 9,
        workgroupsDirect: 857, bytesAllocated: 0, pipelinesCreated: 0,
      },
    },
  ],
};

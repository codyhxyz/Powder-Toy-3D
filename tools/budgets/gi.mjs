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
      name: 'a derived frame with the GI (32³, a cube and a slab): the derived frame\'s 40 dispatches, the GI\'s 3 direct and 2 indirect, one pass, one submit',
      run: (page) => page.evaluate(() => window.__harness.run('budget:frame')),
      // derived (tools/budgets/derived.mjs): 18 indirect (×2) + 4 direct, 18 direct workgroups at 512 bricks;
      // the GI: giKey 1, giSelect a thread per brick (8), giArgs 1 direct; giSource and giGather over its lists
      expect: {
        submits: 1, flushes: 1, writeFlushes: 0, computePasses: 1, renderPasses: 0, dispatches: 47, indirectDispatches: 20,
        workgroupsDirect: 28, bytesAllocated: 0, pipelinesCreated: 0,
      },
    },
    {
      name: 'the frame after sim.resetGI(): the gather traces every probe (its list); the clears come before the pass',
      run: (page) => page.evaluate(() => window.__harness.run('budget:reset')),
      expect: {
        submits: 1, flushes: 1, writeFlushes: 0, computePasses: 1, renderPasses: 0, dispatches: 47, indirectDispatches: 20,
        workgroupsDirect: 28, bytesAllocated: 0, pipelinesCreated: 0,
      },
    },
  ],
};

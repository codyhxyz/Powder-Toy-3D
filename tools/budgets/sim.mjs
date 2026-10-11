// The simulation's budgets (tools/budget-check.mjs, docs/webgpu.md I1, J4):
// what a step, a frame of steps, an asleep world and an edit cost in gpu.stats,
// on the sim harness page (tools/harness/sim-check.html). A change that moves
// one of these numbers says why.
export default {
  unit: 'sim',
  page: '/tools/harness/sim-check.html',
  harness: true,
  scenarios: [
    {
      name: 'an idle-certified world: 10 steps record nothing (docs/webgpu.md D4)',
      run: (page) => page.evaluate(() => window.__harness.run('budget:asleep', 10)),
      expect: { idle: 1, submits: 0, computePasses: 0, dispatches: 0, bytesUploaded: 0, bytesAllocated: 0 },
    },
    {
      name: 'the lab at 4 steps per frame (32³): one submit, one pass; 2 builds × 6 dispatches + 4 steps × 2 (+ the margin at odd steps)',
      run: (page) => page.evaluate(() => window.__harness.run('budget:frame', { scene: 'lab', size: 32, steps: 4 })),
      // dispatches: builds 2 × (5 direct + inert indirect ×2) = 14; steps 4 × (move ×2 + react ×2) + 2 margins = 18
      expect: {
        submits: 1, flushes: 1, writeFlushes: 0, computePasses: 1, renderPasses: 0, dispatches: 32, indirectDispatches: 10,
        bytesAllocated: 0, builds: 2, matchesLists: 1,   // the last build's steps: workgroups = what DRAWN and MOVE1 call for
      },
    },
    {
      name: 'a brush stroke: one edit dispatch, nothing allocated',
      run: (page) => page.evaluate(() => window.__harness.run('budget:paint')),
      expect: { submits: 1, dispatches: 1, computePasses: 1, bytesAllocated: 0 },
    },
  ],
};

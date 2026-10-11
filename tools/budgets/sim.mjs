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
    {
      // (src/simModes.js EDGE.LOOP: the low margin's blocks are the lists' blocks
      // seen from the far side, their one owner, so the margin isn't recorded;
      // loop edges switch quiet skipping off, so every brick is in the lists)
      name: 'the lab with loop edges at 4 steps per frame (32³): no margin dispatch',
      run: (page) => page.evaluate(() => window.__harness.run('budget:frame', { scene: 'lab', size: 32, steps: 4, modes: { edgeMode: 2 } })),
      // dispatches: builds 2 × 7 = 14; steps 4 × (move ×2 + react ×2) = 16
      expect: { submits: 1, computePasses: 1, dispatches: 30, indirectDispatches: 10, bytesAllocated: 0, builds: 2, matchesLists: 1, drawnShare: 1 },
    },
    {
      // Mix reads its partner cell (shaders/passes.js): a two-phase edit (its
      // scratch is made by the first, as any two-phase edit's). A fill reads
      // state A back (editing.js runFill: the conversion to atlas order is a
      // dispatch), uploads its mask (a byte per atlas texel, regionMask) into
      // the buffer the first fill made, and paints it in one edit.
      name: 'TPT\'s Mix after the first: two dispatches; a flood fill after the first: the read\'s and the edit\'s, its mask uploaded, nothing allocated',
      run: (page) => page.evaluate(async () => {
        const r = await window.__harness.run('budget:tools');
        return {
          mixDispatches: r.mix.dispatches, mixAllocated: r.mix.bytesAllocated,
          fillDispatches: r.fill.dispatches, fillAllocated: r.fill.bytesAllocated,
          fillUploadedMask: r.fill.bytesUploaded >= r.maskBytes ? 1 : 0, filled: r.filled > 0 ? 1 : 0,
        };
      }),
      expect: { mixDispatches: 2, mixAllocated: 0, fillDispatches: 2, fillAllocated: 0, fillUploadedMask: 1, filled: 1 },
    },
  ],
};

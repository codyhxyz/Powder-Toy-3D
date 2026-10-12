// The decoration layer's budgets (tools/budget-check.mjs, docs/webgpu.md I1,
// J4; src/deco.js, Sync log S3): what paint costs in gpu.stats, on the deco
// harness page (tools/harness/deco-check.html). A change that moves one of
// these numbers says why.
export default {
  unit: 'deco',
  page: '/tools/harness/deco-check.html',
  harness: true,
  scenarios: [
    {
      // the move carries the plane in its own dispatches (shaders/move.js): the
      // lab's 4 steps record what they record unpainted (sim's budget: 32)
      name: 'the lab at 4 steps per frame (32³) with paint carried: the same dispatches as unpainted, one submit, nothing allocated; '
        + 'a deco stroke: its two dispatches; a brush stroke over paint: its edit and the scrub\'s two',
      run: (page) => page.evaluate(() => window.__harness.run('budget:deco')),
      expect: {
        carriedDispatches: 32, plainDispatches: 32, carried: 1, carriedSubmits: 1, carriedAllocated: 0,
        strokeDispatches: 2, strokeAllocated: 0, brushDispatches: 3, brushAllocated: 0,
      },
    },
  ],
};

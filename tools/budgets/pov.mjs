// The first person's budgets (tools/budget-check.mjs, docs/webgpu.md I1, J4;
// src/pov/gpu.js, G2): what its GPU work costs in gpu.stats, on the POV
// harness page (tools/harness/pov-check.html). A change that moves one of
// these numbers says why.
export default {
  unit: 'pov',
  page: '/tools/harness/pov-check.html',
  harness: true,
  scenarios: [
    {
      // D6: an edit is one dispatch over its box; the strike reads its
      // neighbours, so it runs into the scratch and stores it (two). 11
      // families: 10 + 2.
      name: 'each POV edit family once: one dispatch (the strike two), nothing allocated, none indirect; '
        + 'a body probe one; the exact transfer one (D7, W18); the laser its reach and its apply, indirect from the reach kernel\'s args '
        + '(W17: three as gpu.stats counts, an indirect dispatch twice for Chrome\'s validation, B3); '
        + 'a readCells capture one; none allocates',
      run: (page) => page.evaluate(() => window.__harness.run('budget:pov')),
      expect: {
        povCoupleDispatches: 1, povFieldDispatches: 1, povKickDispatches: 1, povBlowDispatches: 1, povFlameDispatches: 1,
        povPhysgunDispatches: 1, povBlastDispatches: 1, povRocketDispatches: 1, povBurrowDispatches: 1, povStrikeDispatches: 2,
        povWandDispatches: 1,
        editDispatches: 12, editAllocated: 0, editIndirect: 0,
        probeDispatches: 1, probeAllocated: 0,
        transferDispatches: 1, transferAllocated: 0,
        laserDispatches: 3, laserIndirect: 1, laserAllocated: 0,
        cellsDispatches: 1, cellsAllocated: 0,
      },
    },
  ],
};

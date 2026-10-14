// The derived passes' budgets (tools/budget-check.mjs, docs/webgpu.md I1, J4):
// what a derived frame, a settled one and a window move cost in gpu.stats, on
// the derived harness page (tools/harness/derived-check.html). A change that
// moves one of these numbers says why.
export default {
  unit: 'derived',
  page: '/tools/harness/derived-check.html',
  harness: true,
  scenarios: [
    {
      name: 'a derived frame of the lab after 4 steps (32³): one submit, one pass, 18 indirect dispatches and 4 direct',
      run: (page) => page.evaluate(() => window.__harness.run('budget:frame', { scene: 'lab', size: 32, steps: 4 })),
      // indirect (×2, B3): EMA, blur ×3, boost ×3, peak, brick = 9 over the lists, brickDist ×3, light ×6 = 9 over
      // their regions (shaders/passes.js REGIONS); direct: age, dirty, dirtyArgs, boxArgs = 4.
      // Direct workgroups at 512 bricks: 8 + 8 + 1 + 1. The lists' indirect ones: a workgroup per list entry.
      expect: {
        submits: 1, flushes: 1, writeFlushes: 0, computePasses: 1, renderPasses: 0, dispatches: 40, indirectDispatches: 18,
        workgroupsDirect: 18, bytesAllocated: 0, matchesLists: 1,
      },
    },
    {
      name: 'a settled scene (32³, no change for FIELD_EMA_SETTLE frames): empty lists and regions, no indirect workgroup',
      run: (page) => page.evaluate(() => window.__harness.run('budget:settled', { scene: 'mix', size: 32 })),
      expect: { submits: 1, computePasses: 1, dispatches: 40, indirectDispatches: 18, workgroupsDirect: 18, workgroupsIndirect: 0, bytesAllocated: 0 },
    },
    {
      name: 'a window move of 16 cells along x (64×32×32, settled): only the slab and the faces re-age, not every brick',
      run: (page) => page.evaluate(() => window.__harness.run('budget:move')),
      // EMA: the slab (4 × 8 × 8 bricks) and the far face's column (1 × 8 × 8; the near one is in the slab);
      // FIELDS and WORK: those dilated by 1 and 2 bricks along x. The WebGL build rebuilt all 1,024.
      // The second move: sim.shift's 2 dispatches, the derived shift's 5 (the age pass's fold of the changes
      // pending at the move, brickShift × 3, fieldShift: the EMA and the normalised blur; the GI's only once the
      // probes are traced, U9; the carry's noteAwake only when steps ran since the last derived frame) and a
      // derived frame's 40; each copy back ends a pass (the fold opens the one brickShift continues).
      expect: { ema: 320, fields: 448, work: 576, bricks: 1024, submits: 1, dispatches: 47, computePasses: 6, bytesAllocated: 0 },
    },
  ],
};

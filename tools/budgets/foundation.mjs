// The GPU foundation's budgets (tools/budget-check.mjs, docs/webgpu.md I1):
// what the frame model costs on its own, measured on the foundation harness
// page through gpu.stats. A change that moves one of these numbers says why.
//
// Each scenario's run(page) returns { stats, …extra }; expect names a stats
// counter or an extra, with a number (exact) or { min, max }.
export default {
  unit: 'foundation',
  page: '/tools/harness/foundation.html',
  harness: true,
  scenarios: [
    {
      name: 'nothing recorded for 1 s: no work at all, no rAF callbacks (three\'s loop stopped)',
      run: (page) => page.evaluate(() => window.__harness.run('budget:idle', 1000)),
      expect: { submits: 0, computePasses: 0, renderPasses: 0, dispatches: 0, bytesUploaded: 0, bytesAllocated: 0, rafCallbacks: 0 },
    },
    {
      name: 'a frame of 10 dispatches: one submit, one compute pass',
      run: (page) => page.evaluate(() => window.__harness.run('budget:frame', 10)),
      // ten params slots and one shared header slot, 256 B each
      expect: { submits: 1, flushes: 1, writeFlushes: 0, computePasses: 1, dispatches: 10, workgroupsDirect: 10, bytesAllocated: 0, bytesUploaded: 11 * 256 },
    },
    {
      name: 'an indirect dispatch counts twice (Chrome validates it with one of its own)',
      run: (page) => page.evaluate(() => window.__harness.run('budget:indirect')),
      expect: { submits: 1, computePasses: 1, dispatches: 3, indirectDispatches: 1, workgroups: 3, bytesAllocated: 0 },
    },
    {
      name: '3000 dispatches in one frame flush once at FLUSH_DISPATCHES',
      run: (page) => page.evaluate(() => window.__harness.run('budget:flush', 3000)),
      expect: { submits: 2, computePasses: 2, dispatches: 3000, bytesAllocated: 0 },
    },
    {
      name: 'a presented frame (our canvas pass only): one submit, one render pass',
      run: (page) => page.evaluate(() => window.__harness.run('budget:present')),
      expect: { submits: 1, renderPasses: 1, draws: 1, computePasses: 0, bytesAllocated: 0 },
    },
  ],
};

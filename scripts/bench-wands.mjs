// Run: node scripts/bench-wands.mjs [iterations, default 20000]
// Deliberately separate compilation from cheap immutable-plan traversal.
// This is NOT a GPU, collision, physics or runtime scheduler benchmark.
import { performance } from 'node:perf_hooks';
import { PRESETS } from '../src/pov/wands/catalog.js';
import { compileWand } from '../src/pov/wands/compiler.js';

const iterations = Number(process.argv[2] ?? 20000);
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1000000)
  throw new Error('Iterations must be an integer from 1 to 1000000.');
const cases = [...PRESETS, { id: 'synthetic-121-node-plan', cards: ['burst', 'burst', 'burst', 'burst', 'spark'] }];
const plans = cases.map(({ cards, config }) => {
  const plan = compileWand(cards, config);
  if (plan.errors.length) throw new Error(plan.errors.join('; '));
  return plan;
});
let checksum = 0;
const visit = (node) => {
  let count = 1;
  if (node.children) for (const child of node.children) count += visit(child);
  if (node.payload) count += visit(node.payload);
  return count;
};
function compileBatch(n) {
  for (let i = 0; i < n; i++) {
    const definition = cases[i % cases.length];
    checksum += compileWand(definition.cards, definition.config).stats.nodeCount;
  }
}
function traverseBatch(n) {
  for (let i = 0; i < n; i++) {
    const plan = plans[i % plans.length];
    for (const root of plan.casts) checksum += visit(root);
  }
}
compileBatch(2000);
traverseBatch(20000);
function measure(label, fn) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    fn(iterations);
    samples.push((performance.now() - start) * 1000 / iterations);
  }
  samples.sort((a, b) => a - b);
  return { label, iterationsPerSample: iterations, samples: samples.length,
    medianMicrosecondsPerDeck: Number(samples[2].toFixed(3)),
    minMicrosecondsPerDeck: Number(samples[0].toFixed(3)),
    maxMicrosecondsPerDeck: Number(samples[4].toFixed(3)) };
}
console.log(JSON.stringify({
  environment: `${process.version} ${process.platform}/${process.arch}`,
  workload: `${PRESETS.length} presets + one synthetic 121-node plan, round-robin`,
  nodeCounts: plans.map((plan) => plan.stats.nodeCount),
  compile: measure('compile cards + validate + expand + precompute totals', compileBatch),
  traversal: measure('visit already-compiled nodes only; no scheduling/effects', traverseBatch),
  checksum,
  limitations: 'CPU-only microbenchmark. Traversal is not projectile simulation, scheduler throughput, GPU dispatch or frame time.',
}, null, 2));

// Runs one outcome test on one engine (tools/outcomes.mjs drives it in Node for
// the CPU prototype and through tools/harness/outcomes.js in a page for the
// GPU): the scene's box made fresh, the test run, its criteria turned into a
// status, and its engine disposed whatever happened.
//   pass    every criterion held
//   fail    a criterion didn't (the physics, the test's evidence says why)
//   n/a     the engine can't express the scene (an element it lacks, no thrown
//           matter, no pressure field): a pass for nobody, a fail for nobody
//   error   the scene wasn't what the test meant (a setup check), the adapter
//           threw or the test ran out of time: says nothing about physics
import { SetupError, BudgetError } from './engine.js';
import { OUTCOMES } from './thresholds.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * @param {object} test a test from ./tests/index.js
 * @param {object} engine an engine (./engine.js)
 * @param {{ seed?: number, budgetMs?: number, log?: (line: string) => void }} [opts]
 */
export async function runTest(test, engine, { seed = 1, budgetMs = 0, log = () => {}, hash = false } = {}) {
  const row = OUTCOMES[test.key ?? test.name] ?? {};
  const base = { name: test.name, title: test.title, group: test.group, phase: row.phase ?? 'P2', engine: engine.name, size: test.size, audit: test.audit, clock: engine.info.clock };
  const missing = (test.needs ?? []).filter((n) => engine.id(n) === null);
  if (missing.length) return { ...base, status: 'n/a', reason: `${engine.name} has no ${missing.join(', ')}` };
  const why = test.expressible?.(engine);
  if (why) return { ...base, status: 'n/a', reason: why };
  const t0 = now(), deadline = budgetMs ? t0 + budgetMs : Infinity;
  const advance = engine.advance.bind(engine);
  // the wall-clock budget, checked before each advance
  engine.advance = async (s) => {
    if (now() > deadline) throw new BudgetError(`over its ${Math.round(budgetMs / 1000)} s budget at ${engine.time.toFixed(2)} game s`);
    return advance(s);
  };
  try {
    await engine.create(test.size, { seed, url: test.url });
    const ctx = { log, fresh: () => engine.create(test.size, { seed, url: test.url }) };
    const r = await test.run(engine, ctx);
    // --hash: the final state's words, for a bit-identity A/B between two checkouts
    if (hash && engine.stateHash) r.stateHash = await engine.stateHash();
    const status = r.na ? 'n/a' : r.criteria.every((c) => c.ok) ? 'pass' : 'fail';
    // (an app engine knows its clock only once its page has booted)
    return { ...base, clock: engine.info.clock, status, ...r, gameSeconds: +engine.time.toFixed(3), steps: engine.steps, wallSeconds: +((now() - t0) / 1000).toFixed(1) };
  } catch (err) {
    const reason = err instanceof SetupError ? `setup: ${err.message}` : err instanceof BudgetError ? `budget: ${err.message}` : String(err?.stack ?? err);
    return { ...base, status: 'error', reason, wallSeconds: +((now() - t0) / 1000).toFixed(1) };
  } finally {
    engine.advance = advance;
    await engine.dispose();
  }
}

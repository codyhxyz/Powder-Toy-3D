// The outcome bench (docs/v2.md 2.10, 4.4, 11 "Week 0"): what the physics
// should DO, as tests that run on any engine through one adapter contract
// (tools/outcomes/engine.js): today's build (v1, the default), the CPU
// prototype (lean: tools/v2/lean-sim.mjs's World, in Node, no browser) and v2
// once P2 writes tools/outcomes/engine-v2.js. Each test is a scene, a run, a
// measurement and thresholds (tools/outcomes/thresholds.js, one table); it
// prints the measured numbers beside the threshold and beside the prototype's
// (tools/outcomes/expected-lean.json), and every test that doesn't pass prints
// its evidence (level profiles, maps, slices).
//
// Expected results: tools/outcomes/expected-<engine>.json records each test's
// status as last measured. The run exits 0 when every test passes or fails
// exactly as recorded (a recorded fail is an expected fail), and 1 when
// anything changed: a pass that broke, a recorded fail that now passes (update
// the record: --record), a test not in the record, or an error (a scene that
// wasn't what its test meant, an adapter failure, a budget overrun: never
// expected). --strict instead requires every test to pass (P2's gate for v2:
// --engine v2 --strict --phase P2; a test of a later phase is then reported but
// not required).
//
// Harness tests run in tools/harness/outcomes.html (a bare simulation; Vite in
// harness mode on --port, default 5366), batched by grid size into browser runs
// of under ~3 minutes each on SwiftShader. App tests (the default island)
// boot the game itself (Vite on --port + 1, or --app-url: any build at any
// origin, e.g. the frozen /v1/ build or a v2 candidate with --app-query
// engine=v2). In the container, numbers are SwiftShader's, not representative
// of a device: run it on the Mac (Chrome, a real GPU: --real-gpu is the
// default there) and paste the table back; on a phone or in Safari, open the
// harness page by hand (tools/harness/outcomes.html, ?run=<group>).
//
// usage: node tools/outcomes.mjs [--engine v1|lean|v2] [--group liquids,solids,...] [--tests utube,puddle]
//          [--strict [--phase P2]] [--json results.json] [--record] [--verbose] [--list]
//          [--port N] [--app-url http://127.0.0.1:N] [--app-query engine=v2] [--seed N]
//   groups: liquids, solids, fire, blasts, world, census, controls
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TESTS, GROUPS, select } from './outcomes/tests/index.js';
import { runTest } from './outcomes/run.js';
import { OUTCOMES } from './outcomes/thresholds.js';

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const ENGINE = opt('engine', 'v1');
const PORT = Number(opt('port', 5366));
const SEED = Number(opt('seed', 1));
const PHASES = ['P2', 'P3', 'P4', 'P5', 'P6'];
const PHASE = opt('phase', 'P6');
const BATCH_SECONDS = 150;   // a browser run's budget of tests' estimated cost (the ~3 minutes, less a pipeline build)
const BUDGET_MS = 240000;    // a test's own wall-clock budget, past which it is an error
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const recordPath = here(`./outcomes/expected-${ENGINE}.json`);

if (!['v1', 'lean', 'v2'].includes(ENGINE)) throw new Error(`--engine v1, lean or v2, not ${ENGINE}`);
if (!PHASES.includes(PHASE)) throw new Error(`--phase ${PHASES.join(', ')}`);
const tests = select({ tests: opt('tests', ''), groups: opt('group', '') });

if (flag('list')) {
  for (const [g, names] of Object.entries(GROUPS)) {
    console.log(`${g}:`);
    for (const n of names) { const t = TESTS.find((x) => x.name === n); console.log(`  ${n.padEnd(12)} ${OUTCOMES[t.key ?? n]?.phase ?? 'P2'}  ${t.size?.join('×') ?? t.url}  ${t.title}`); }
  }
  process.exit(0);
}

const readJSON = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const record = readJSON(recordPath);
const lean = readJSON(here('./outcomes/expected-lean.json'));

// ---------------------------------------------------------------- running
const results = [];
let adapterLine = '';
const t0 = Date.now();
const say = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s] ${s}`);

if (ENGINE === 'lean') {
  const { createEngine } = await import('./outcomes/engine-lean.js');
  const engine = createEngine();
  adapterLine = engine.info.label;
  for (const t of tests) {
    const r = (t.kind ?? 'harness') === 'app' ? { name: t.name, title: t.title, group: t.group, phase: OUTCOMES[t.key ?? t.name]?.phase, engine: 'lean', status: 'n/a', reason: 'lean is a bare simulation: this test boots the game' }
      : await runTest(t, engine, { seed: SEED });
    results.push(r);
    say(`${t.name}: ${r.status}`);
  }
} else {
  const { launchBrowser, gpuInfo } = await import('./browser.mjs');
  const { startVite } = await import('./vite-server.mjs');
  const { openHarness } = await import('./harness/open.mjs');
  const harness = tests.filter((t) => (t.kind ?? 'harness') === 'harness');
  const app = tests.filter((t) => t.kind === 'app');
  // batches: tests of one grid size share its pipeline builds; each batch is one browser run
  const batches = [];
  for (const t of harness) {
    const key = t.size.join('x');
    let b = batches.find((x) => x.key === key && x.cost + t.cost <= BATCH_SECONDS);
    if (!b) batches.push((b = { key, cost: 20, tests: [] }));
    b.tests.push(t); b.cost += t.cost;
  }
  if (batches.length) {
    const vite = await startVite({ harness: true, port: PORT });
    try {
      for (const b of batches) {
        const browser = await launchBrowser();
        const errors = [];
        try {
          say(`browser run: ${b.tests.map((t) => t.name).join(', ')} (${b.key}, ~${b.cost} s on SwiftShader)`);
          const page = await openHarness(browser, vite, `/tools/harness/outcomes.html?engine=${ENGINE}`, { errors });
          if (!adapterLine) { const g = await gpuInfo(page); adapterLine = `${g.vendor} ${g.architecture} ${g.description}${g.isFallbackAdapter ? ' (fallback adapter: SwiftShader numbers, not representative)' : ''}`; }
          for (const t of b.tests) {
            const r = await page.evaluate(([n, o]) => window.__harness.run('outcome', n, o), [t.name, { seed: SEED, budgetMs: BUDGET_MS }]);
            if (errors.length) { r.pageErrors = errors.splice(0); if (r.status !== 'error') r.status = 'error', r.reason = `page errors: ${r.pageErrors.join(' | ').slice(0, 500)}`; }
            results.push(r);
            say(`${t.name}: ${r.status} (${r.wallSeconds} s)`);
          }
        } catch (e) {
          for (const t of b.tests) if (!results.some((r) => r.name === t.name)) results.push({ name: t.name, title: t.title, group: t.group, phase: OUTCOMES[t.key ?? t.name]?.phase, engine: ENGINE, status: 'error', reason: `${e.message} ${errors.join(' | ')}`.slice(0, 800) });
          say(`browser run failed: ${e.message.slice(0, 300)}`);
        } finally { await browser.close(); }
      }
    } finally { await vite.close(); }
  }
  if (app.length) {
    const { createEngine } = await import('./outcomes/engine-app.js');
    const ownVite = opt('app-url') ? null : await startVite({ port: PORT + 1 });
    const base = opt('app-url') ?? ownVite.origin;
    try {
      for (const t of app) {
        const browser = await launchBrowser();
        const errors = [];
        try {
          say(`browser run: ${t.name} (the game at ${base}${t.url})`);
          const engine = createEngine(browser, { base, query: opt('app-query', ENGINE === 'v2' ? 'engine=v2' : ''), errors });
          const r = await runTest(t, engine, { seed: SEED, budgetMs: BUDGET_MS * 2 });
          r.engine = ENGINE;
          r.adapter = engine.info.label;
          if (errors.length) r.pageErrors = errors.slice(0, 10);
          results.push(r);
          say(`${t.name}: ${r.status} (${r.wallSeconds} s)`);
        } finally { await browser.close(); }
      }
    } finally { await ownVite?.close(); }
  }
}

// ---------------------------------------------------------------- report
const order = new Map(TESTS.map((t, i) => [t.name, i]));
results.sort((a, b) => order.get(a.name) - order.get(b.name));
const leanOf = (name, crit) => lean?.tests?.[name]?.criteria?.find((c) => c.name === crit);
const phaseOk = (p) => PHASES.indexOf(p ?? 'P2') <= PHASES.indexOf(PHASE);

console.log(`\nengine ${ENGINE}: ${adapterLine}\n`);
const verdicts = [];
for (const r of results) {
  const want = record?.tests?.[r.name]?.status;
  let verdict;
  if (flag('strict')) verdict = r.status === 'pass' ? 'ok' : phaseOk(r.phase) ? 'NOT PASSING' : `later (${r.phase})`;
  else if (r.status === 'error') verdict = 'ERROR';
  else if (!want) verdict = 'NEW (not in the record)';
  else if (want === r.status) verdict = r.status === 'fail' ? 'xfail (as recorded)' : 'ok';
  else if (want === 'fail' && r.status === 'pass') verdict = 'NOW PASSES: update the record (--record)';
  else verdict = `CHANGED: recorded ${want}, now ${r.status}`;
  const bad = !(verdict === 'ok' || verdict.startsWith('xfail') || verdict.startsWith('later'));
  verdicts.push({ name: r.name, verdict, bad });
  console.log(`${r.status.toUpperCase().padEnd(5)} ${r.name.padEnd(12)} ${(r.phase ?? '').padEnd(3)} ${r.title}`);
  console.log(`      ${r.headline ?? r.reason ?? ''}`);
  for (const c of r.criteria ?? []) {
    const l = leanOf(r.name, c.name);
    console.log(`      ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.measured}${c.unit ? ` ${c.unit}` : ''} (want ${c.threshold}${c.unit ? ` ${c.unit}` : ''}; prototype ${l ? `${l.measured}${l.unit ? ` ${l.unit}` : ''}` : lean?.tests?.[r.name]?.status === 'n/a' ? 'n/a' : '—'})`);
  }
  if (r.status === 'n/a' || r.status === 'error') console.log(`      ${r.status === 'n/a' ? 'not expressible' : 'error'}: ${String(r.reason).split('\n').slice(0, 6).join('\n      ')}`);
  console.log(`      → ${verdict}${r.wallSeconds !== undefined ? `   [${r.gameSeconds ?? 0} game s, ${r.steps ?? 0} steps, ${r.wallSeconds} s wall]` : ''}`);
  if ((r.status === 'fail' || flag('verbose')) && r.evidence?.length) for (const ev of r.evidence) console.log(`      ${ev.replace(/\n/g, '\n      ')}`);
  console.log('');
}
const failed = verdicts.filter((v) => v.bad);
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`${results.length} tests: ${count('pass')} pass, ${count('fail')} fail, ${count('n/a')} n/a, ${count('error')} error; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(failed.length ? `NOT AS RECORDED: ${failed.map((v) => `${v.name} (${v.verdict})`).join('; ')}` : flag('strict') ? 'strict: every required test passes' : 'as recorded');

if (flag('json')) {
  const out = opt('json');
  if (!out) throw new Error('--json needs a path');
  writeFileSync(out, JSON.stringify({ engine: ENGINE, adapter: adapterLine, date: new Date().toISOString(), results }, null, 1));
  console.log(`results: ${out}`);
}
if (flag('record')) {
  const errs = results.filter((r) => r.status === 'error');
  if (errs.length) { console.log(`not recording: ${errs.map((r) => r.name).join(', ')} errored`); process.exit(1); }
  const keep = record?.tests ?? {};
  for (const r of results) {
    keep[r.name] = { status: r.status, headline: r.headline ?? r.reason, criteria: (r.criteria ?? []).map(({ name, measured, unit, threshold, ok }) => ({ name, measured, unit, threshold, ok })) };
  }
  const sorted = Object.fromEntries(Object.entries(keep).sort(([a], [b]) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9)));
  writeFileSync(recordPath, `${JSON.stringify({ engine: ENGINE, adapter: adapterLine, recorded: new Date().toISOString().slice(0, 10), tests: sorted }, null, 1)}\n`);
  console.log(`recorded: ${recordPath}`);
  process.exit(0);
}
process.exit(failed.length ? 1 : 0);

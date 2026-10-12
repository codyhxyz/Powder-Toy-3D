// The outcome bench's harness page (tools/outcomes.mjs; tests in
// tools/outcomes/tests): a test's scene on a bare simulation on this page's
// WebGPU device, through the engine adapter ?engine= names (v1, today's: the
// default; v2 once P2 writes tools/outcomes/engine-v2.js).
//   __harness.run('outcome', name, { seed, budgetMs })   one test's result (tools/outcomes/run.js)
//   __harness.run('tests')                               the tests: name, group, size, cost
// By hand (the Mac's Chrome or Safari: `npm run harness`, then this page):
// ?run=liquids,throw runs those groups and tests here, one after another, and
// prints a table and the results as JSON to paste back; with no ?run= it lists
// the groups as links. Numbers from a fallback adapter (SwiftShader) aren't
// representative of a device's.
import { boot, ready, log, test } from './harness.js';
import { TESTS, GROUPS, select, byName } from '../outcomes/tests/index.js';
import { runTest } from '../outcomes/run.js';

const h = await boot({ label: 'outcomes' });
const params = new URLSearchParams(location.search);
const ENGINE = params.get('engine') ?? 'v1';

// Math.random from a seed (mulberry32, as tools/regress.mjs and sim-check.js): the blank state's cell seeds
const seedRandom = (seed) => {
  let s = seed >>> 0;
  Math.random = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

let engine = null;
try {
  const mod = ENGINE === 'v2' ? await import('../outcomes/engine-v2.js') : await import('../outcomes/engine-v1.js');
  engine = mod.createEngine(h.gpu, { seed: seedRandom });
} catch (e) {
  h.error = `engine ${ENGINE}: ${e.message}`;
  log('ERROR', h.error);
}

test('tests', () => TESTS.map((t) => ({ name: t.name, group: t.group, kind: t.kind ?? 'harness', size: t.size, cost: t.cost })));
test('outcome', async (name, opts = {}) => {
  const t = byName(name);
  if (!t) throw new Error(`no test ${name}`);
  log(`${name}: running`);
  const r = await runTest(t, engine, { ...opts, log });
  log(`${name}: ${r.status} ${r.headline ?? r.reason ?? ''}`);
  return r;
});
ready();

// ---- by hand ----
const menu = document.getElementById('menu');
const run = params.get('run');
if (!run && engine) {
  const link = (q, text) => `<a href="?engine=${ENGINE}&run=${q}">${text}</a>`;
  menu.innerHTML = `<p>Outcome bench, engine ${ENGINE}, on ${h.gpu.adapterInfo.vendor} ${h.gpu.adapterInfo.architecture}${h.gpu.adapterInfo.isFallbackAdapter ? ' (fallback adapter: numbers not representative)' : ''}.</p>
<p>Run: ${Object.keys(GROUPS).map((g) => link(g, g)).join(' · ')} · ${link(Object.keys(GROUPS).join(','), 'everything')}</p>
<p>${TESTS.filter((t) => (t.kind ?? 'harness') === 'harness').map((t) => link(t.name, t.name)).join(' · ')}</p>`;
}
if (run && engine) {
  const names = run.split(',');
  const picked = select({ groups: names.filter((n) => GROUPS[n]).join(','), tests: names.filter((n) => !GROUPS[n]).join(',') })
    .filter((t) => (t.kind ?? 'harness') === 'harness');
  const table = document.getElementById('results'), body = table.querySelector('tbody'), json = document.getElementById('json');
  table.hidden = false;
  const results = [];
  for (const t of picked) {
    const r = await runTest(t, engine, { log });
    results.push(r);
    const tr = document.createElement('tr');
    const cls = r.status === 'n/a' ? 'na' : r.status;
    tr.innerHTML = `<td>${t.name}</td><td class="${cls}">${r.status}</td><td>${(r.headline ?? r.reason ?? '').replace(/</g, '&lt;')}</td><td>${r.wallSeconds ?? ''}</td>`;
    body.appendChild(tr);
    for (const c of r.criteria ?? []) log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.measured} ${c.unit} (want ${c.threshold})`);
    if (r.status !== 'pass') for (const ev of r.evidence ?? []) log(ev);
  }
  json.hidden = false;
  json.value = JSON.stringify({ engine: ENGINE, adapter: h.gpu.adapterInfo, userAgent: navigator.userAgent, results }, null, 1);
}

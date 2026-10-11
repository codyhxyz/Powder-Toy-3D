// The sim bench (Mac checkpoint M1, docs/webgpu.md I4): pipeline creation
// times of the sim's kernels and ms per step per kernel, from timestamp
// queries, per grid and scene. The move runs in both code forms D2 weighed
// (MOVE_FORMS: the unrolled one, the WebGL build's shape, ships; the loop
// one is the alternative should the unrolled form cost on the Mac),
// alternating A B B A in chunks at the same states, since both give the same
// state (tools/sim-check.mjs --stage moves asserts it).
//
// Two kinds of creation time. The cold start: new Simulation() to sim.ready,
// with each of its pipelines' time from request to ready while all of them
// build at once (so a small kernel's figure is mostly waiting its turn). And
// each M1 pipeline alone (react, the move in each form): after the sim's
// builds have settled, one at a time, each from a module text no cache has
// seen (a trailing comment), timed from request to ready (module, layout,
// pipeline). The A/B of the forms reads the second.
// Run it from the page's button, or from a tool: __harness.run('bench', opts).

import { boot, ready, test, log } from './harness.js';
import { Simulation } from '/src/sim.js';
import { buildPreset } from '/src/presets.js';
import { moveBlockFrag, MoveParams, MOVE_FORM, MOVE_FORMS } from '/src/shaders/move.js';

const h = await boot({ label: 'sim-bench' });
const gpu = h.gpu;
const q = new URLSearchParams(location.search);

// mulberry32, as tools/regress.mjs seeds scenes
const seed = (s0) => {
  let s = s0 >>> 0;
  Math.random = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)] ?? NaN; };
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

// Unseen module texts: this page load's mark, then a count (Chrome keeps
// compiled pipelines on disk across loads, keyed by the source)
const RUN = Date.now().toString(36);
let builds = 0;

// One pipeline built alone from `desc` (a gpu.kernel descriptor): the kernel
// and its ms from request to ready
async function buildAlone(name, desc) {
  await gpu.settled();
  const n = builds++;
  const t0 = performance.now();
  const kernel = gpu.kernel({ ...desc, name: `${name} (bench ${n})`, code: `${desc.code}\n// bench ${RUN} ${n}\n` });
  await kernel.ready;
  return { kernel, ms: performance.now() - t0 };
}

// ms per step per kernel over `steps` steps (split timestamps), and wall ms
// per step; the move in whichever form under its own name, 'move'
async function timeChunk(sim, steps) {
  const timing = gpu.timing;
  await sim.gpuSync();
  timing.enabled = true;
  timing.split = true;
  const before = timing.lastFrame;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) sim.step();
  gpu.endFrame();
  await sim.gpuSync();
  const wall = (performance.now() - t0) / steps;
  for (let k = 0; k < 200 && timing.lastFrame === before; k++) await nextFrame();
  timing.enabled = false;
  timing.split = false;
  const per = {};
  for (const [name, ms] of Object.entries(timing.last)) per[name === sim.kernels.move.name ? 'move' : name] = ms / steps;
  return { wall, per };
}

/**
 * @param {{ sizes?: number[], scenes?: string[], steps?: number, chunks?: number, forms?: string[] }} [opts]
 */
async function bench({ sizes = [64, 128], scenes = ['empty', 'lab', 'volcano'], steps = 30, chunks = 4, forms = Object.keys(MOVE_FORMS) } = {}) {
  const out = { gpu: gpu.adapterInfo, timestamps: gpu.timing.supported, shipping: MOVE_FORM, grids: [] };
  for (const n of sizes) {
    await gpu.settled();
    const times = new Map(gpu.pipelines.times);
    const t0 = performance.now();
    const sim = new Simulation(gpu, n, n, n, { debug: false });
    await sim.ready;
    const grid = { n, readyMs: performance.now() - t0, concurrentMs: {}, aloneMs: {}, scenes: [] };
    // the pipelines the sim built (not found in the cache), each's time while all built at once
    for (const [name, ms] of gpu.pipelines.times) if (times.get(name) !== ms) grid.concurrentMs[name] = ms;
    // each M1 pipeline alone; the move's forms timed in the steps below are these
    grid.aloneMs.react = (await buildAlone('react', sim.kernels.react.desc)).ms;
    const moves = {};
    for (const form of forms) {
      const desc = { ...sim.kernels.move.desc, code: moveBlockFrag(sim.g, { form }), params: MoveParams };
      const b = await buildAlone(`move (${form})`, desc);
      grid.aloneMs[`move (${form})`] = b.ms;
      moves[form] = b.kernel;
    }
    const shipping = sim.kernels.move;
    for (const scene of scenes) {
      seed(12345);
      if (scene === 'empty') sim.clear(); else buildPreset(scene, sim);
      for (let i = 0; i < steps; i++) sim.step();   // past the load's forced map
      const rows = Object.fromEntries(forms.map((f) => [f, []]));
      for (let c = 0; c < chunks; c++) {
        for (const form of (c % 2 ? [...forms].reverse() : forms)) {
          sim.kernels.move = moves[form];
          rows[form].push(await timeChunk(sim, steps));
        }
      }
      sim.kernels.move = shipping;
      const counts = await sim.readCounts();
      const res = { scene, units: counts.units, drawn: counts.drawn, awake: counts.awake, forms: {} };
      for (const form of forms) {
        const kernels = {};
        for (const k of Object.keys(rows[form][0].per)) kernels[k] = median(rows[form].map((r) => r.per[k] ?? 0));
        res.forms[form] = { wallMsPerStep: median(rows[form].map((r) => r.wall)), gpuMsPerStep: kernels };
      }
      grid.scenes.push(res);
      log(`${n}³ ${scene}: drawn ${counts.drawn}/${counts.units}; ${forms.map((f) => `${f} ${res.forms[f].wallMsPerStep.toFixed(2)} ms/step`).join(', ')}`);
    }
    sim.dispose();
    out.grids.push(grid);
  }
  return out;
}

function show(r) {
  const fmt = (x) => (x === undefined ? '' : x.toFixed(x < 1 ? 3 : 1));
  let html = `<p>${r.gpu.vendor} ${r.gpu.architecture} ${r.gpu.description}${r.timestamps ? '' : ' (no timestamp-query: GPU columns empty)'}; shipping move form: ${r.shipping}</p>`;
  for (const g of r.grids) {
    html += `<h3>${g.n}³</h3><table><tr><th>alone, one at a time</th><th>ms</th></tr>`;
    for (const [k, v] of Object.entries(g.aloneMs)) html += `<tr><td>${k}</td><td>${fmt(v)}</td></tr>`;
    html += `</table><table><tr><th>cold start: ready in ${fmt(g.readyMs)} ms; each built at once with the others</th><th>ms</th></tr>`;
    for (const [k, v] of Object.entries(g.concurrentMs)) html += `<tr><td>${k}</td><td>${fmt(v)}</td></tr>`;
    html += '</table>';
    for (const s of g.scenes) {
      const forms = Object.keys(s.forms), kernels = [...new Set(forms.flatMap((f) => Object.keys(s.forms[f].gpuMsPerStep)))];
      html += `<table><tr><th>${s.scene} (drawn ${s.drawn}/${s.units})</th>${forms.map((f) => `<th>${f}</th>`).join('')}</tr>`;
      html += `<tr><td>wall ms/step</td>${forms.map((f) => `<td>${fmt(s.forms[f].wallMsPerStep)}</td>`).join('')}</tr>`;
      for (const k of kernels) html += `<tr><td>${k} (GPU ms/step)</td>${forms.map((f) => `<td>${fmt(s.forms[f].gpuMsPerStep[k])}</td>`).join('')}</tr>`;
      html += '</table>';
    }
  }
  document.getElementById('out').innerHTML = html;
}

test('bench', bench);
const opts = {
  sizes: q.get('sizes')?.split(',').map(Number), scenes: q.get('scenes')?.split(','),
  steps: q.get('steps') ? Number(q.get('steps')) : undefined, chunks: q.get('chunks') ? Number(q.get('chunks')) : undefined,
};
for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
document.getElementById('run').onclick = async () => {
  document.getElementById('note').textContent = 'running…';
  try { show(await bench(opts)); document.getElementById('note').textContent = 'done'; } catch (e) { document.getElementById('note').textContent = e.message; }
};
ready();

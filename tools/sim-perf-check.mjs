// Matched states, alternating run order, real 128³ Lab, no render loop.
// Compare an implementation candidate with its reference, including both
// ping-pong copies, flags and flow. A few hundred explicit steps, then close.
// node tools/sim-perf-check.mjs --candidate move-loop|react-tile
import { launchBrowser } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';
import { writeFile } from 'node:fs/promises';

const candidate = process.argv[process.argv.indexOf('--candidate') + 1] || 'react-tile';
if (!['move-loop', 'react-tile'].includes(candidate)) throw new Error('Unknown candidate');
let browser, vite;
try {
  browser = await launchBrowser({ lifetimeMs: 180000 });
  vite = await startVite({ harness: true });
  const page = await openHarness(browser, vite, '/tools/harness/sim.html');
  const result = await page.evaluate(async candidate => {
    const { Simulation } = await import('/src/sim.js');
    const { buildPreset } = await import('/src/presets.js');
    const { moveBlockFrag } = await import('/src/shaders/move.js');
    const { reactFrag } = await import('/src/shaders/react.js');
    const { EDGE } = await import('/src/simModes.js');
    const gpu = __harness.gpu, timing = gpu.timing;
    const seed = () => {
      let s = 12345;
      Math.random = () => {
        s |= 0; s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const sims = [new Simulation(gpu, 128, 128, 128), new Simulation(gpu, 128, 128, 128)];
    const rows = [[], []], checks = [];
    try {
      await Promise.all(sims.map(s => s.ready));
      const kind = candidate === 'move-loop' ? 'move' : 'react';
      const codes = sims.map((s, i) => candidate === 'move-loop'
        ? moveBlockFrag(s.g, { form: i ? 'loop' : 'unrolled' })
        : reactFrag(s.g, { tiled: Boolean(i) }));
      if (codes[0] === codes[1]) throw new Error('Candidate did not produce a different shader');
      for (let i = 0; i < 2; i++) {
        sims[i].kernels[kind] = gpu.kernel({ ...sims[i].kernels[kind].desc, name: `${kind} ${i ? 'candidate' : 'reference'}`, code: codes[i] });
      }
      await Promise.all(sims.map(s => s.kernels[kind].ready));
      const reset = edge => {
        for (const s of sims) { s.frame = 0; s.cur = 0; s.edgeMode = edge; seed(); buildPreset('lab', s); }
      };
      const steps = async (sim, n, measured) => {
        timing.enabled = measured; timing.split = measured;
        const t0 = performance.now();
        for (let i = 0; i < n; i++) sim.step();
        gpu.endFrame();
        await gpu.fence(); await timing.settled();
        const wall = (performance.now() - t0) / n;
        const data = { wall, gpu: Object.values(timing.last).reduce((a, b) => a + b, 0) / n,
          target: (timing.last[sim.kernels[kind].name] ?? 0) / n, coverage: timing.lastCoverage };
        timing.enabled = false; timing.split = false;
        return data;
      };
      const compare = async edge => {
        const differences = {};
        for (const name of ['A', 'B', 'F', 'flow']) {
          const buffers = await Promise.all(sims.map(s => gpu.readback.buffer(s.state[name])));
          const [a, b] = buffers.map(v => new Uint32Array(v));
          let count = 0, first = null;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { count++; first ??= { word: i, reference: a[i], candidate: b[i] }; }
          differences[name] = { count, first };
        }
        checks.push({ edge, differences });
      };
      reset(EDGE.SOLID);
      for (const s of sims) await steps(s, 32, false);
      for (let round = 0; round < 4; round++) {
        for (const i of round % 2 ? [1, 0] : [0, 1]) rows[i].push(await steps(sims[i], 8, true));
      }
      await compare(EDGE.SOLID);
      for (const edge of [EDGE.LOOP, EDGE.VOID]) {
        reset(edge);
        for (const s of sims) await steps(s, 8, false);
        await compare(edge);
      }
      return { candidate, rows, checks, errors: __harness.failures, gpu: {
        vendor: gpu.adapterInfo.vendor, description: gpu.adapterInfo.description,
      } };
    } finally { for (const s of sims) s.dispose(); }
  }, candidate);
  await browser.close(); browser = null;
  const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const summary = result.rows.map(rows => ({
    stepMs: median(rows.map(r => r.wall)), gpuMs: median(rows.map(r => r.gpu)),
    targetMs: median(rows.map(r => r.target)),
  }));
  const out = `/tmp/tpt-${candidate}-comparison.json`;
  await writeFile(out, JSON.stringify({ summary, ...result }, null, 2));
  console.log(JSON.stringify({ summary, ...result, artifact: out }, null, 2));
  if (result.errors.length || result.checks.some(c => Object.values(c.differences).some(d => d.count))
      || result.rows.flat().some(r => !r.coverage?.complete)) throw new Error('Equivalence or timing coverage failed');
} finally { await browser?.close(); await vite?.close(); }

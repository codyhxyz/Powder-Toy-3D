// GPU: V1's shock under V2 on what only the GPU runs, through the integrated native engine on the outcome
// bench's bare simulation (tools/outcomes/engine-v2.js: src/v2/physics.js with its dynamics, no app):
// nitroglycerin poured gently rests, dropped from height goes off where its run lands
// (shaders/v2/columns.js colShockLand); C-4 hit by grains thrown down at it goes off
// (shaders/v2/particles.js dShockHit, posted by blasts.js airborneEvents). The rules' CPU checks:
// tools/v2/shock-check.mjs, particle-deposition-check.mjs; a chain of explosives under their own
// blast's pressure (V1 react.js setOff, crushP): airborne-react-check.mjs 9b', blast-batch-check.mjs.
// One launch, one GPU slot. --v1 also runs the nitroglycerin drops on V1 (tools/outcomes/engine-v1.js,
// the same launch) and holds V2 to what V1 does there; without it V2 is held to V1's numbers below.
//
//   node tools/v2/shock-browser-check.mjs [--port N] [--v1]
import { launchBrowser } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';
import { openHarness } from '../harness/open.mjs';

// V1 on the same drops (--v1, 2026-10-22, Apple M-series): none of its nitroglycerin is left 2 s after the
// 12.6 m drop. It lands from 0.15 s (V1's 44 g) and is gone by 0.30 s, its chain taking all it reaches. (V1's
// 4.8 m block goes off as it lands, its liquid falling without drag past fallKE's NITRO_FALL_M, and takes
// the resting block 15 cells away with it, so V1 drops the 12.6 m block alone: 48 → 0 cells. Here V2's two
// resting blocks lie 15 and 21 cells from it, 15 from each other: V1's chain reaches that far.)
const V1_HIGH_LEFT = 0;
// V2's amounts are f32 fills and packets, V1's whole cells: what V2 may leave over V1's (cells)
const V1_MATCH_CELLS = 1;
const withV1 = process.argv.includes('--v1');
let failures = 0;
const t0 = Date.now(), at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const ok = (cond, what) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${what} [${at()}]`); };
const vite = await startVite({ harness: true });
let browser;
try {
  browser = await launchBrowser();
  const errors = [];
  const page = await openHarness(browser, vite, '/tools/harness/outcomes.html?engine=v2', { errors, timeout: 20000 });
  console.log(`harness up [${at()}]`);
  await page.evaluate(async () => {
    const { createEngine } = await import('/tools/outcomes/engine-v2.js');
    const e = createEngine(window.__harness.gpu);
    window.__shock = { e, async count(name) { const g = await e.read(), id = e.id(name); let n = 0; for (let i = 0; i < g.id.length; i++) if (g.id[i] === id) n++; return n; },
      // a liquid's amount in full cells, resting fills and flying packets once each (native-grid.js nativeTally):
      // V2's liquid spreads into thinner cells, so its cell count grows while its amount holds
      async amount(name) { return (await e.census()).liquid[e.nameOf(e.id(name))] ?? 0; } };
  });
  const createMs = await page.evaluate(async () => { const t = performance.now(); await window.__shock.e.create([32, 48, 32]); return Math.round(performance.now() - t); });
  console.log(`engine up in ${createMs} ms [${at()}]`);
  // nitroglycerin: a block resting a cell over the floor, one dropped from 16 cells (4.8 m: past R1's run
  // speed, short of NITRO_FALL_M), then one dropped from 42 cells (12.6 m), sampled every SAMPLE_S after it
  // drops while it lands and goes off (V1 at 0.25 s: 44 g, V2 at 1.35 s: 2 g): all of it, near the drop
  // (x < 16), away from it
  const nitroScene = async (WINDOWS) => {
    const { e, amount } = window.__shock, out = {}, SAMPLE_S = 0.05, END_S = 2.05;
    const split = async () => {
      const g = await e.read(), id = e.id('NITRO'), fill = g.gridAmount ?? g.amount; let near = 0, far = 0;
      for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
        const i = x + g.nx * (z + g.nz * y); if (g.id[i] === id) { if (x < 16) near += fill[i]; else far += fill[i]; } }
      for (const p of g.particles ?? []) if (p.id === id) { if (p.x < 16) near += p.mass; else far += p.mass; }
      return [+(near + far).toFixed(2), +near.toFixed(2), +far.toFixed(2)];
    };
    e.box([22, 1, 22], [25, 3, 25], 'NITRO');
    await e.advance(0.05); out.gentle0 = await amount('NITRO'); await e.advance(1); out.gentle1 = await amount('NITRO');
    e.box([22, 16, 4], [25, 18, 7], 'NITRO');
    await e.advance(0.05); out.short0 = await amount('NITRO'); await e.advance(1.5); out.short1 = await amount('NITRO');
    e.box([4, 42, 4], [7, 44, 7], 'NITRO');
    out.timeline = [];
    const t0 = e.time;
    await e.advance(0.05); out.high0 = await amount('NITRO');
    const sample = async () => out.timeline.push([+(e.time - t0).toFixed(3), ...await split()]);
    for (const [from, to] of WINDOWS) {
      if (e.time - t0 < from - 1e-6) await e.advance(from - (e.time - t0));
      for (; e.time - t0 < to + 1e-6; await e.advance(SAMPLE_S)) await sample();
    }
    await e.advance(END_S - (e.time - t0)); out.high1 = await amount('NITRO'); await sample();
    return out;
  };
  let v1 = null;
  if (withV1) {
    const p1 = await openHarness(browser, vite, '/tools/harness/outcomes.html?engine=v1', { errors, timeout: 20000 });
    await p1.evaluate(async () => {
      const { createEngine } = await import('/tools/outcomes/engine-v1.js');
      const e = createEngine(window.__harness.gpu); await e.create([32, 48, 32]);
      window.__shock = { e, async amount(name) { return (await e.census()).liquid[e.nameOf(e.id(name))] ?? 0; } };
    });
    v1 = await p1.evaluate(nitroScene, [[0.05, 0.6]]);
    await p1.evaluate(() => window.__shock.e.dispose());
    await p1.close();
    console.log(`V1: rests ${v1.gentle0} → ${v1.gentle1}, 4.8 m ${v1.short0} → ${v1.short1}, 12.6 m ${v1.high0} → ${v1.high1} [${at()}]`);
    console.log(`V1 12.6 m [s after the drop, all, near, away]: ${JSON.stringify(v1.timeline)}`);
  }
  const nitro = await page.evaluate(nitroScene, [[1.2, 1.7]]);
  console.log(`V2 12.6 m [s after the drop, all, near, away]: ${JSON.stringify(nitro.timeline)}`);
  // the amounts are sums of f32 fills: AMOUNT_EPS is far under one fill quantum and far over their rounding
  const AMOUNT_EPS = 1e-3, same = (a, b) => Math.abs(a - b) < AMOUNT_EPS, cells = (a) => a.toFixed(2);
  ok(nitro.gentle0 > 10 && same(nitro.gentle1, nitro.gentle0), `nitroglycerin poured gently rests: ${cells(nitro.gentle0)} → ${cells(nitro.gentle1)} cells of it`);
  ok(nitro.short0 > nitro.gentle1 + 10 && same(nitro.short1, nitro.short0), `dropped 4.8 m, past the run speed, it lands and rests: ${cells(nitro.short0)} → ${cells(nitro.short1)} cells of it`);
  ok(nitro.high0 > 10 && nitro.high1 < nitro.high0 / 2, `dropped from 12.6 m it goes off where it lands: ${cells(nitro.high0)} → ${cells(nitro.high1)} cells of it`);
  // and its chain through what its blast reaches leaves what V1's leaves, ejecta and all (V1 react.js setOff:
  // more than its crushP of pressure on it, resident or flying)
  const v1Left = v1 ? v1.high1 : V1_HIGH_LEFT;
  ok(nitro.high1 <= v1Left + V1_MATCH_CELLS, `as V1's chain does: ${cells(nitro.high1)} cells of it left after 2 s, V1 ${cells(v1Left)}${v1 ? ' (measured now)' : ''}`);
  // C-4 on the floor; sand thrown down at it at 25 m/s (a body-coupled launch: engine-v2.js box { v })
  const c4 = await page.evaluate(async () => {
    const { e, count } = window.__shock, out = {};
    await e.create([32, 32, 32]); // sides are whole supertiles (16×8×8, common.js gridDims)
    e.box([10, 0, 10], [13, 1, 13], 'C4');
    await e.advance(0.05); out.rest0 = await count('C4'); await e.advance(0.5); out.rest1 = await count('C4');
    e.box([10, 20, 10], [13, 22, 13], 'SAND', { v: [0, -25, 0] });
    await e.advance(0.75); out.hit = await count('C4');
    await e.dispose();
    return out;
  });
  ok(c4.rest0 > 10 && c4.rest1 === c4.rest0, `C-4 left alone stays: ${c4.rest0} → ${c4.rest1} cells`);
  ok(c4.hit < c4.rest1 / 2, `hit by grains thrown at 25 m/s it goes off: ${c4.rest1} → ${c4.hit} cells`);
  ok(!errors.length, `no page errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`);
  await page.close();
} finally {
  await browser?.close();
  await vite.close();
}
console.log(`${failures ? `${failures} FAILED` : 'all ok'} (${at()})`);
process.exit(failures ? 1 : 0);

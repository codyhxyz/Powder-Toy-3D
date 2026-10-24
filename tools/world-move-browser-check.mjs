// Headless GPU check of the physics region's move (docs/seamless-world.md, "P — physics region"), one
// slot through tools/browser.mjs, manual mode (nothing steps between moves).
// Hypothesis: a move's frame (its CPU recording, and the GPU work up to a fence) costs less with the
// window's physicsOnly switch on, because the derived passes' shift (fields, bricks, GI history) and
// occupancy's whole-window rebuild, the far field's summary and the render source's copies leave the
// move; with a world copy attached it costs less again, because the CPU tree placing and baking and its
// GPU stamps leave too. The leaving slab's coding moves out of the readback's landing into slices.
// Cells after a walk out and back are identical with the switch on and off.
// Segments, each N moves east then N back: old (switch off), physics only (switch on, generator fill),
// world copy (switch on, a synthetic copy: tools/world-copy-stub.mjs; content is not the map's, timing only).
// usage: node tools/world-move-browser-check.mjs [--map island] [--win 128] [--moves 4]
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MAP = opt('map', 'island'), WIN = +opt('win', 128), N = +opt('moves', 4);
const BOOT_MS = 16000;   // of the 25 s slot: past this the run gives up rather than overrun it

const vite = await startVite();
let b = null, failures = 0;
const errs = [];
try {
  b = await launchBrowser();
  const p = await newTestPage(b, { mode: 'manual', viewport: { width: 320, height: 200 } });
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.stack || e).slice(0, 600)));
  const t0 = Date.now();
  await p.goto(vite.url(`/?map=${MAP}&view=plain&win=${WIN}`));
  await p.waitForFunction(() => window.__app?.win?.loaded && window.__app.sim.nativeCapabilities?.world && !window.__app.win.blocker()
    || document.getElementById('error')?.textContent, null, { polling: 100, timeout: BOOT_MS });
  const failed = await p.evaluate(() => document.getElementById('error')?.textContent || null);
  if (failed) throw new Error(`boot: ${failed.slice(0, 300)}`);
  console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const res = await p.evaluate(async (N) => {
    const a = window.__app, w = a.win, sim = a.sim, g = sim.g;
    const settle = async () => { for (let i = 0; i < 100; i++) { const bl = w.blocker(); if (!bl) return; await bl; } throw new Error('window stays blocked'); };
    const cells = async () => (await sim.readState())[0];
    const step = async (dir) => {
      await settle(); await a.gpu.fence();
      const f = [sim.origin.x + g.nx / 2 + dir * 21, sim.origin.z + g.nz / 2];
      const t0 = performance.now(), m = w.update(f[0], f[1]), t1 = performance.now();
      if (!m) throw new Error(`no move from ${sim.origin.x}`);
      await a.gpu.fence();
      const t2 = performance.now();
      while (w.storeReads.size) await w.storeReads.values().next().value;
      const t3 = performance.now();
      w.leaveQueue.flush();
      const t4 = performance.now(), L = w.last;
      return { cpu: t1 - t0, synced: t2 - t0, land: t3 - t2, code: t4 - t3, trees: L.trees, bakeMs: L.bakeMs, kept: L.kept, longest: w.leaveQueue.longestMs };
    };
    const walk = async () => { const out = [], back = []; for (let i = 0; i < N; i++) out.push(await step(1)); for (let i = 0; i < N; i++) back.push(await step(-1)); return { out, back }; };
    const segment = async (label, physicsOnly) => {
      w.physicsOnly = physicsOnly;
      const before = await cells(), o = sim.origin.x, r = await walk(), after = await cells();
      let diff = 0; for (let k = 0; k < before.length; k++) if (!Object.is(before[k], after[k])) diff++;
      if (sim.origin.x !== o) throw new Error(`${label}: the walk did not come back`);
      return { label, ...r, diffFloats: diff };
    };
    const out = [];
    out.push(await segment('old', false));
    out.push(await segment('physics only', true));
    try {
    const { syntheticWorldCopy, STUB_COPY_WGSL } = await import('/tools/world-copy-stub.mjs');
    const { wcWord } = await import('/src/shaders/world/cellWord.js');
    const { ELEMENTS } = await import('/src/elements.js');
    const STONE = ELEMENTS.findIndex((e) => e.key === 'STONE');
    const copy = syntheticWorldCopy(a.gpu, w.size, (x, y) => wcWord(y < 10 ? STONE : 0, 0, 20, 0));
    await w.attachWorldCopy(copy, { wgsl: STUB_COPY_WGSL });
    w.physicsOnly = true;
    out.push({ label: 'world copy', ...(await walk()) });
    } catch (e) { out.push({ label: 'world copy', error: String(e.message ?? e).slice(0, 400) }); }
    return out;
  }, N);
  const med = (v) => { const s = [...v].sort((x, y) => x - y); return s[s.length >> 1]; };
  const f = (v) => v.toFixed(2);
  for (const s of res) {
    if (s.error) { failures++; console.log(`FAIL ${s.label}: ${s.error}`); continue; }
    const all = [...s.out, ...s.back];
    console.log(`${s.label.padEnd(13)} cpu median ${f(med(all.map((m) => m.cpu)))} ms (max ${f(Math.max(...all.map((m) => m.cpu)))}), `
      + `synced median ${f(med(all.map((m) => m.synced)))} ms (max ${f(Math.max(...all.map((m) => m.synced)))}), `
      + `landing ${f(med(all.map((m) => m.land)))} ms, coding ${f(med(all.map((m) => m.code)))} ms, trees ${all.reduce((n, m) => n + (m.trees ?? 0), 0)}, `
      + `bake ${f(med(all.map((m) => m.bakeMs ?? 0)))} ms, kept ${all.map((m) => m.kept).join(' ')}`
      + (s.diffFloats !== undefined ? `; out and back: ${s.diffFloats} floats differ` : ''));
  }
  const [old, phys] = res;
  if (phys.diffFloats !== 0) { failures++; console.log(`FAIL physics-only walk out and back changed ${phys.diffFloats} floats (old: ${old.diffFloats})`); }
  if (errs.length) { failures++; console.log(`FAIL page errors:\n  ${errs.join('\n  ')}`); }
  await p.close();
} catch (e) {
  failures++;
  console.log(`FAIL ${e.message}`);
  if (errs.length) console.log(errs.join('\n'));
} finally {
  await b?.close();
  await vite.close();
}
console.log(failures ? 'world-move-browser-check: failed' : 'world-move-browser-check: ok');
process.exit(failures ? 1 : 0);

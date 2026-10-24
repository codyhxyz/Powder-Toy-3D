// Headless GPU check of the physics region's move (docs/seamless-world.md, "P — physics region"), one
// slot through tools/browser.mjs, manual mode (nothing steps between moves).
// Hypothesis: a move's frame (its CPU recording, and the GPU work up to a fence) costs less with the
// window's physicsOnly switch on, because the derived passes' shift (fields, bricks, GI history) and
// occupancy's whole-window rebuild, the far field's summary and the render source's copies leave the
// move; with a world copy attached it costs less again, because the CPU tree placing and baking and its
// GPU stamps leave too. The leaving slab's coding moves out of the readback's landing into slices.
// Cells after a walk out and back are identical with the switch on and off. Of a physics-only move's GPU
// time (timestamps a pass a dispatch), most is the leaving diff's and the fill's scene evaluation over the
// slab; the window's shift copy alone stays under 1 ms (so no ring addressing).
// Hypothesis (P2's slot 1, 2026-10-24, per pass with the timing frame closed by hand): of a physics-only
// world-copy move's ~10 ms of GPU, the shift's whole-window copies (V2's cores and banks out to a scratch and
// back, ~170 MB; the flow out and back, 64 MB; the requests through the dynamics' work, 32 MB) are ~3-4 ms
// (the shift kernels plus the time between passes, where the copies run); the leaving diff's and the fill's
// scene evaluation over the slab ~2-4 ms each. Copies first: ping-pong or ring. Scenes first: off the frame.
// Slot 1 found the copies first: of a world-copy move's 8.1 ms span, ~6.6 ms were whole-window passes and
// the copies between them; the slab's scene work ~2.3 ms. So ring addressing (src/sim.js _shiftRing).
// Hypothesis (slot 2, --ring): a ringed move's span drops to ~2.5-3 ms, the whole-window passes
// (nativeWindowshift, v2window_move's SHIFT, flowShift) and the copies between passes gone; what is left is
// the slab's (the scene's prepass ~1.3, the native leave ~0.6, the copy fill ~0.4, the gathers, the enter
// kernels, actShift, the restore's clears). Walks out and back leave 0 V2 words different; ticks are
// deterministic, a walk doesn't change them, and their hash is an unringed page's (slot 3).
// Segments, each N moves east then N back: old (switch off), physics only (switch on, generator fill),
// world copy (switch on, a synthetic copy: tools/world-copy-stub.mjs; content is not the map's, timing only).
// usage: node tools/world-move-browser-check.mjs [--map island] [--win 128] [--moves 4]
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MAP = opt('map', 'island'), WIN = +opt('win', 128), N = +opt('moves', 4), TOP = +opt('top', 14);
const SEGMENTS = new Set(opt('segments', 'old,physics,copy').split(','));
// --ring: the page boots with the physics-only switch on (?physicsOnly=1), so its grid is ringed from
// construction (world/physicsRegion.js ringedFor); 'old' then has no meaning and is skipped.
const RING = args.includes('--ring'), TICKS = +opt('ticks', 40), BASELINE = args.includes('--baseline');
const BASELINE_BY_MS = 12000;   // the unringed page starts only this soon after launch (its boot and ticks fit the slot)
const BOOT_MS = 16000;   // of the 25 s slot: past this the run gives up rather than overrun it

// One page: boot (ringed or not), the segments, the results printed at once (a later page may run out the slot).
async function page(ring, SEG) {
  const errs = [];
  try {
    const p = await newTestPage(b, { mode: 'manual', viewport: { width: 320, height: 200 } });
    p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
    p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.stack || e).slice(0, 600)));
    const t0 = Date.now();
    await p.goto(vite.url(`/?map=${MAP}&view=plain&win=${WIN}${ring ? '&physicsOnly=1' : ''}`));
    await p.waitForFunction(() => window.__app?.win?.loaded && window.__app.sim.nativeCapabilities?.world && !window.__app.win.blocker()
      || document.getElementById('error')?.textContent, null, { polling: 100, timeout: BOOT_MS });
    const failed = await p.evaluate(() => document.getElementById('error')?.textContent || null);
    if (failed) throw new Error(`boot: ${failed.slice(0, 300)}`);
    console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const res = await p.evaluate(async ({ N, SEG, TICKS }) => {
      const a = window.__app, w = a.win, sim = a.sim, g = sim.g;
      const settle = async () => { for (let i = 0; i < 100; i++) { const bl = w.blocker(); if (!bl) return; await bl; } throw new Error('window stays blocked'); };
      const cells = async () => (await sim.readState())[0];
      // GPU time by pass (gpu/timing.js, a pass a dispatch), the frames a move's fence covers
      const T = a.gpu.timing, timed = T.supported;
      let frames = [];
      if (timed) { T.enabled = true; T.split = true; T.onFrame = (fr) => frames.push(fr); }
      const fenceMs = [];
      for (let i = 0; i < 5; i++) { const t = performance.now(); await a.gpu.fence(); fenceMs.push(performance.now() - t); }
      const step = async (dir, axis = 0) => {
        await settle(); await a.gpu.fence();
        // (manual mode never ends a frame: close the timing frame by hand, so a move's passes are one frame)
        if (timed) { T._endFrame(a.gpu.frameNo); await T.settled(); }
        await new Promise((r) => setTimeout(r, 20)); frames = [];
        const f = [sim.origin.x + g.nx / 2 + (axis ? 0 : dir * 21), sim.origin.z + g.nz / 2 + (axis ? dir * 21 : 0)];
        const t0 = performance.now(), m = w.update(f[0], f[1]), t1 = performance.now();
        if (!m) throw new Error(`no move from ${sim.origin.x}`);
        await a.gpu.fence();
        const t2 = performance.now();
        if (timed) { T._endFrame(a.gpu.frameNo); await T.settled(); }
        while (w.storeReads.size) await w.storeReads.values().next().value;
        const t3 = performance.now();
        w.leaveQueue.flush();
        const t4 = performance.now(), L = w.last;
        await new Promise((r) => setTimeout(r, 40));
        const passes = {};
        let spanMs = null, untimed = 0;
        for (const fr of frames) {
          untimed += fr.coverage?.missing?.length ?? 0;
          // the time between passes (copies, clears: they write no timestamps), credited to the pass after it
          const order = fr.passes.filter((ps) => ps.gpu !== null && ps.start !== null).sort((x, y) => x.start - y.start);
          let end = order.length ? order[0].start : 0;
          for (const ps of order) {
            const gap = ps.start - end;
            if (gap > 0.005) passes[`(between, before ${ps.name})`] = (passes[`(between, before ${ps.name})`] ?? 0) + gap;
            end = Math.max(end, ps.start + ps.gpu);
          }
          if (fr.coverage?.spanMs != null) spanMs = (spanMs ?? 0) + fr.coverage.spanMs;
          for (const ps of fr.passes) if (ps.gpu !== null) passes[ps.name] = (passes[ps.name] ?? 0) + ps.gpu;
        }
        const gpuMs = Object.entries(passes).filter(([n]) => !n.startsWith('(between')).reduce((x, [, y]) => x + y, 0);
        return { cpu: t1 - t0, synced: t2 - t0, land: t3 - t2, code: t4 - t3, trees: L.trees, bakeMs: L.bakeMs, kept: L.kept, longest: w.leaveQueue.longestMs, gpuMs, spanMs, untimed, frames: frames.length, passes };
      };
      const walk = async (axis = 0) => { const out = [], back = []; for (let i = 0; i < N; i++) out.push(await step(1, axis)); for (let i = 0; i < N; i++) back.push(await step(-1, axis)); return { out, back }; };
      const segment = async (label, physicsOnly, axis = 0) => {
        w.physicsOnly = physicsOnly;
        const before = await cells(), core0 = await raw(), o = [sim.origin.x, sim.origin.z], r = await walk(axis), after = await cells(), core1 = await raw();
        let diff = 0; for (let k = 0; k < before.length; k++) if (!Object.is(before[k], after[k])) diff++;
        let diffWords = 0; for (let k = 0; k < core0.length; k++) if (core0[k] !== core1[k]) diffWords++;
        if (sim.origin.x !== o[0] || sim.origin.z !== o[1]) throw new Error(`${label}: the walk did not come back`);
        return { label, ...r, diffFloats: diff, diffWords };
      };
      // V2's own words (cores, then banks + decoration), bit for bit
      const raw = async () => {
        const v2 = sim.compact; await a.gpu.fence();
        const [c, b] = await Promise.all([a.gpu.readback.buffer(v2.cells, 0, v2.cells.size), a.gpu.readback.buffer(v2.aux, 0, g.slots * 4)]);
        const out = new Uint32Array(c.byteLength / 4 + g.slots); out.set(new Uint32Array(c)); out.set(new Uint32Array(b), c.byteLength / 4); return out;
      };
      const out = [];
      out.push({ label: 'fence', fenceMs, timed, ringed: sim.ringed, ring: g.ring });
      // the logical state's hash (readState: atlas order, whatever the ring), for runs to compare
      const hash = async () => { const [A, B] = await sim.readState(); let h = 0x811c9dc5; for (const f of [A, B]) { const u = new Uint32Array(f.buffer, f.byteOffset, f.length); for (let k = 0; k < u.length; k++) h = Math.imul(h ^ u[k], 16777619) >>> 0; } return h.toString(16); };
      const tryPush = async (label, fn) => { try { out.push(await fn()); } catch (e) { out.push({ label, error: String(e.message ?? e).slice(0, 400) }); } };
      if (SEG.includes('old')) await tryPush('old', () => segment('old', false));
      if (SEG.includes('physics')) await tryPush('physics only', () => segment('physics only', true, 1));   // (along z: columns no move has planted yet)
      if (SEG.includes('ticks')) await tryPush('ticks', async () => {
        // Ticks from a fresh load (twice: is a run deterministic?), and after a walk out and back: the same
        // hash means the moves left nothing behind that physics reads. Across pages (ringed or not) the hashes
        // compare too: physics doesn't depend on where its cells are laid out.
        w.physicsOnly = true;
        const o = [sim.origin.x, 0, sim.origin.z], fresh = async () => { await settle(); w.load(o); await a.gpu.fence(); };
        const run = async () => { a.test.step(TICKS); await a.gpu.fence(); return hash(); };
        await fresh(); const h0 = await hash(), h1 = await run();
        await fresh(); const h2 = await run();
        await fresh(); await walk(0); const hw = await hash(), h3 = await run();
        return { label: 'ticks', h0, h1, h2, hw, h3, origin: o };
      });
      if (SEG.includes('copy')) try {
      const { syntheticWorldCopy, STUB_COPY_WGSL } = await import('/tools/world-copy-stub.mjs');
      const { wcWord } = await import('/src/shaders/world/cellWord.js');
      const { ELEMENTS } = await import('/src/elements.js');
      const STONE = ELEMENTS.findIndex((e) => e.key === 'STONE');
      const copy = syntheticWorldCopy(a.gpu, w.size, (x, y) => wcWord(y < 10 ? STONE : 0, 0, 20, 0));
      await w.attachWorldCopy(copy, { wgsl: STUB_COPY_WGSL });
      w.physicsOnly = true;
      // (the window filled from the copy, as a world copy's load fills it: walking back then brings back
      // what the copy and the stores hold, which is what left)
      await settle(); w.load([sim.origin.x, 0, sim.origin.z]); await a.gpu.fence();
      out.push(await segment('world copy', true));
      } catch (e) { out.push({ label: 'world copy', error: String(e.message ?? e).slice(0, 400) }); }
      return out;
    }, { N, SEG, TICKS });
    const med = (v) => { const s = [...v].sort((x, y) => x - y); return s[s.length >> 1]; };
    const f = (v) => v.toFixed(2);
    for (const s of res) {
      if (s.label === 'fence') { console.log(`empty fence: median ${f(med(s.fenceMs))} ms; GPU timestamps ${s.timed ? 'on' : 'unsupported'}; ringed ${s.ringed} (ring ${s.ring})`); continue; }
      if (s.error) { failures++; console.log(`FAIL ${s.label}: ${s.error}`); continue; }
      if (s.label === 'ticks') {
        console.log(`ticks (${TICKS} from a load at ${s.origin}): loaded ${s.h0}, run 1 ${s.h1}, run 2 ${s.h2}${s.h1 === s.h2 ? ' (deterministic)' : ' (NOT deterministic)'}; `
          + `after a walk out and back ${s.hw}${s.hw === s.h0 ? ' (= loaded)' : ' (≠ loaded)'}, its run ${s.h3}${s.h3 === s.h1 ? ' (= run 1)' : ' (≠ run 1)'}`);
        if (s.h1 === s.h2 && (s.h3 !== s.h1 || s.hw !== s.h0)) { failures++; console.log('FAIL ticks: a walk out and back changed what physics does'); }
        continue;
      }
      const all = [...s.out, ...s.back];
      console.log(`${s.label.padEnd(13)} cpu median ${f(med(all.map((m) => m.cpu)))} ms (max ${f(Math.max(...all.map((m) => m.cpu)))}), `
        + `synced median ${f(med(all.map((m) => m.synced)))} ms (max ${f(Math.max(...all.map((m) => m.synced)))}), `
        + `landing ${f(med(all.map((m) => m.land)))} ms, coding ${f(med(all.map((m) => m.code)))} ms, trees ${all.reduce((n, m) => n + (m.trees ?? 0), 0)}, `
        + `bake ${f(med(all.map((m) => m.bakeMs ?? 0)))} ms, kept ${all.map((m) => m.kept).join(' ')}`
        + (s.diffFloats !== undefined ? `; out and back: ${s.diffFloats} floats, ${s.diffWords} V2 words differ` : ''));
      const names = [...new Set(all.flatMap((m) => Object.keys(m.passes ?? {})))];
      const top = names.map((n) => [n, med(all.map((m) => m.passes?.[n] ?? 0))]).sort((x, y) => y[1] - x[1]).slice(0, TOP);
      console.log(`  GPU median ${f(med(all.map((m) => m.gpuMs ?? 0)))} ms in passes (max ${f(Math.max(...all.map((m) => m.gpuMs ?? 0)))}), `
        + `span median ${f(med(all.map((m) => m.spanMs ?? NaN)))} ms, frames ${all.map((m) => m.frames).join(' ')}, untimed passes ${all.reduce((n, m) => n + (m.untimed ?? 0), 0)}`);
      for (const [n, v] of top) console.log(`    ${f(v).padStart(7)}  ${n}`);
    }
    for (const s of res) if (s.label !== 'fence' && s.label !== 'old' && !s.error && (s.diffFloats || s.diffWords)) {
      failures++; console.log(`FAIL ${s.label}: the walk out and back changed ${s.diffFloats} floats, ${s.diffWords} V2 words`);
    }
    if (errs.length) { failures++; console.log(`FAIL page errors:\n  ${errs.join('\n  ')}`); }
    await p.close();
    return res;
  } catch (e) {
    if (errs.length) console.log(`page errors (${ring ? 'ringed' : 'unringed'}):\n  ${errs.join('\n  ')}`);
    throw e;
  }
}

const vite = await startVite();
let b = null, failures = 0;
try {
  b = await launchBrowser();
  const launched = Date.now();
  const res = await page(RING, [...SEGMENTS]);
  // the same ticks on an unringed page, when the slot has room: physics doesn't depend on the layout
  if (BASELINE && Date.now() - launched < BASELINE_BY_MS) {
    const base = (await page(false, ['ticks'])).find((r) => r.label === 'ticks'), mine = res.find((r) => r.label === 'ticks');
    if (base?.h1 && mine?.h1) {
      console.log(`layout (ticks from ${base.origin} / ${mine.origin}): unringed run ${base.h1}, ringed run ${mine.h1}${base.h1 === mine.h1 ? ' (same physics)' : ' (DIFFER)'}`);
      if (base.h1 !== mine.h1 && base.h1 === base.h2 && mine.h1 === mine.h2) { failures++; console.log('FAIL ring addressing changed what physics does'); }
    }
  } else if (BASELINE) console.log(`(no room left in the slot for the unringed page: ${((Date.now() - launched) / 1000).toFixed(1)} s in)`);
} catch (e) {
  failures++;
  console.log(`FAIL ${e.message}`);
} finally {
  await b?.close();
  await vite.close();
}
console.log(failures ? 'world-move-browser-check: failed' : 'world-move-browser-check: ok');
process.exit(failures ? 1 : 0);

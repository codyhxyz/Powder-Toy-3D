// (scratch, W2) Island, still camera: the world copy's writeback cost and changed bricks per frame, still and
// busy, and one stroke reaching the copy.
// Hypothesis: with the GPU-driven writeback, recordWriteback's CPU cost on a still scene is ~0 (skipped while V2
// rests, else ~10 dispatch encodes, well under 0.5 ms) against 20.8 ms before; its GPU passes total < 0.5 ms;
// changed bricks per writeback are ~0 still and tens to hundreds with water falling; F's changes shrink to the
// changed 16³ nodes; a wood stroke in the air (a solid: it stays where painted) shows up in the copy within a few frames.
// (2026-10-24 run 3 painted STONE, a powder: it fell out of the probed cell before the first read.)
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';
const map = process.argv[2] ?? 'island';
const vite = await startVite();
let browser = null;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'visual', viewport: { width: 960, height: 600 } });
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || t.startsWith('W2 ')) console.error('[page]', t.slice(0, 1500)); });
  await page.goto(vite.url(`/?map=${map}`));
  const t0 = Date.now();
  await page.waitForFunction(() => window.__app?.sim && window.__app.view?.volumeDrawn && window.__app.worldView?.worldCopy?.built, null, { polling: 200, timeout: 14000 });
  console.error(`ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const r = await page.evaluate(async () => {
    const app = window.__app, wv = app.worldView, wc = wv.worldCopy, sim = app.sim, gpu = app.gpu;
    const { E } = await import('/src/elements.js');
    const sleep = (ms) => new Promise((d) => setTimeout(d, ms));
    const acc = { wb: [], fields: [], light: [], boxes: [], gpu: [] };
    const wrap = (o, k, key) => { const f = o[k].bind(o); o[k] = (...a) => { const t = performance.now(); const r = f(...a); acc[key].push(performance.now() - t); return r; }; };
    wrap(wc, 'recordWriteback', 'wb'); wrap(wv.fields, 'update', 'fields'); wrap(wv.light, 'update', 'light');
    const cs = wc.changesSince.bind(wc);
    wc.changesSince = (rev) => { const b = cs(rev); acc.boxes.push(b.length); return b; };
    const s = (a) => { const d = [...a].sort((x, y) => x - y); return a.length ? { n: a.length, p50: +d[d.length >> 1].toFixed(3), max: +d.at(-1).toFixed(3), sum: +a.reduce((x, y) => x + y, 0).toFixed(1) } : { n: 0 }; };
    const reset = () => { for (const k in acc) acc[k] = []; };
    const snap = () => ({ ...(wc.gpuStats ?? {}) });
    const per = (a, b) => { const n = b.writebacks - a.writebacks; return n > 0 ? { writebacks: n, candPer: +((b.cand - a.cand) / n).toFixed(1), changedPer: +((b.changed - a.changed) / n).toFixed(1), seedsPer: +((b.seeds - a.seeds) / n).toFixed(1), dilPer: +((b.dil - a.dil) / n).toFixed(1) } : { writebacks: 0 }; };
    const phase = async (ms) => {
      reset();
      const a = snap(), f0 = performance.now();
      let frames = 0;
      await new Promise((done) => { const f = (now) => { frames++; if (now - f0 < ms) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); });
      await sleep(120);   // (the last change list's read)
      return { fps: +(frames / (ms / 1000)).toFixed(1), wb: s(acc.wb), fields: s(acc.fields), light: s(acc.light), boxesPerUpdate: s(acc.boxes), gpuCounts: per(a, snap()) };
    };
    // GPU time of the world copy's passes (each dispatch its own timed pass)
    const gpuTime = async (ms) => {
      if (!gpu.timing?.supported) return null;
      const frames = [];
      gpu.timing.split = true; gpu.timing.enabled = true;
      gpu.timing.onFrame = ({ passes }) => {
        let wcMs = 0, n = 0, fieldsMs = 0;
        for (const p of passes) { const d = p.gpu; if (d == null) continue; if (p.name.startsWith('world copy')) { wcMs += d; n++; } else if (/field/i.test(p.name)) fieldsMs += d; }
        frames.push({ wcMs, n, fieldsMs });
      };
      await sleep(ms);
      gpu.timing.onFrame = null; gpu.timing.enabled = false; gpu.timing.split = false;
      const withWc = frames.filter((f) => f.n);
      return { frames: frames.length, framesWithWriteback: withWc.length, writebackGpuMs: s(withWc.map((f) => f.wcMs)), passes: s(withWc.map((f) => f.n)) };
    };
    const out = { origin: [sim.origin.x, sim.origin.y, sim.origin.z], window: [sim.g.nx, sim.g.ny, sim.g.nz], asleep: app.physics.v2?.asleep };
    const log = (k, v) => { out[k] = v; console.log(`W2 ${k} ${(performance.now() / 1000).toFixed(1)} ${JSON.stringify(v)}`); };
    for (let i = 0; i < 20 && !wc.gpuStats; i++) await sleep(50);   // (the first change list read: the sums' base)
    log('start', { origin: out.origin, asleep: out.asleep, stats: wc.gpuStats, writebacks: wc.gpuWritebacks });
    log('still', await phase(1500));
    log('stillGpu', await gpuTime(500));
    // a stroke: stone in the air above the window's middle, then read back from the copy
    const c = { x: sim.g.nx / 2 + 2, y: sim.g.ny - 24, z: sim.g.nz / 2 + 2 };
    const world = [c.x + sim.origin.x, c.y + sim.origin.y, c.z + sim.origin.z];
    const cellOf = async () => {
      const [BX, BY] = wc.L.bricks, bi = (world[0] >> 2) + BX * ((world[1] >> 2) + BY * (world[2] >> 2));
      const e = new Uint32Array(await gpu.readback.buffer(wc.buf.table, bi * 4, 4))[0];
      if (!(e & 0x80000000)) return e & 255;
      const slot = (e & 0x7fffffff) >>> 0, li = (world[0] & 3) + 4 * ((world[1] & 3) + 4 * (world[2] & 3));
      return new Uint32Array(await gpu.readback.buffer(wc.buf.pool, (slot * 64 + li) * 4, 4))[0] & 255;
    };
    const before = await cellOf();
    sim.paint({ center: c, radius: 2, shape: 0, tool: E.WOOD, rate: 1, replace: true });
    app.requestRender?.();
    let after = before, waited = 0;
    for (; waited < 1500 && after === before; waited += 100) { await sleep(100); after = await cellOf(); }
    log('stroke', { world, before, after, wood: E.WOOD, result: app.sim.nativeInteractionResult, reachedMs: after === E.WOOD ? waited : null });
    // busy: water poured high up, falling and spreading
    for (let i = 0; i < 4; i++) sim.paint({ center: { x: c.x - 10 + 6 * i, y: sim.g.ny - 12, z: c.z - 8 }, radius: 4, shape: 0, tool: E.WATER, rate: 1, replace: false });
    app.requestRender?.();
    log('busy', await phase(1200));
    log('busyGpu', await gpuTime(400));
    log('end', { retries: wc.retries ?? 0, capacity: wc.capacity, bump: wc.bumpRead, over: wc.overflow });
    return out;
  });
  console.log(JSON.stringify(r));
} finally { await browser?.close(); await vite.close(); }

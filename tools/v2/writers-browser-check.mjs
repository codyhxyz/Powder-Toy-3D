// Real-GPU: V2's native writers on a liquid pool (src/v2/nativePaint.js createNativeEditKernel). Heat over a
// pool of whole cells under a film (an eighth of a cell) keeps every fill, flux word and bank it didn't heat;
// water poured on the film fills the air above it with whole cells and leaves the film's cells alone; a flood
// fill reads V2's ids (a byte a texel) and fills its region natively; a save and its load give V2's exact words
// back. No V1 export, import or V1 write on the way. One GPU slot; run only when the shared launcher permits it.
// node tools/v2/writers-browser-check.mjs
import { launchBrowser, newTestPage, ready } from '../browser.mjs';
import { startVite } from '../vite-server.mjs';

const t0 = Date.now();
const vite = await startVite({ warmupEntries: ['/src/main.js', '/src/app.js', '/src/v2/nativePaint.js', '/src/v2/interactions.js', '/src/editing.js', '/src/v2/layout.js'] });
console.log(`info vite warm in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
let browser, failed = false;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 320, height: 240 } });
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.log('page error:', e.message); });
  page.on('console', m => { if (m.type() === 'log' && /^(ok|FAIL|info) /.test(m.text())) console.log(m.text()); });
  await page.goto(vite.url('/?size=64&preset=empty&physics=v2'));
  await ready(page);
  console.log(`info app up at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const result = await page.evaluate(async () => {
    const a = __app, { E, TOOLS } = await import('/src/elements.js');
    const { cellSlot } = await import('/src/shaders/common.js');
    const { makeMaterial, cid, cFill, FULL } = await import('/src/v2/layout.js');
    const tool = k => TOOLS.find(t => t.key === k).id;
    const t = performance.now(), info = m => console.log(`info ${((performance.now() - t) / 1000).toFixed(1)} s ${m}`);
    a.test.park(); a.settings.paused = true;
    const sim = a.sim, gpu = a.gpu, v2 = a.physics.v2;
    await v2.ready;
    const out = [], check = (ok, message) => { out.push(`${ok ? 'ok' : 'FAIL'} ${message}`); return ok; };
    const legacy = /^(v2bridge|v2import|v2externalEvents|paint|toAtlas|fromAtlas)$/, passes = [];
    const prev = sim.onPass; sim.onPass = (name, i) => { passes.push(name); prev?.(name, i); };
    // the scene: air at 20 °C; a pool x, z 20..27 of whole water cells (y 1, 2) under a film (y 3), each with a bank
    const g = sim.g, words = new Uint32Array(g.slots * 4), banks = new Int32Array(g.slots), air = makeMaterial(E.EMPTY, 20).core, pool = [];
    for (let s = 0; s < g.slots; s++) words.set(air, s * 4);
    for (let z = 20; z < 28; z++) for (let x = 20; x < 28; x++) for (let y = 1; y <= 3; y++) {
      const m = makeMaterial(E.WATER, 22, y < 3 ? FULL : FULL / 8), s = cellSlot(g, x, y, z);
      m.core[2] = (0x3c003c00 ^ x) >>> 0; words.set(m.core, s * 4); banks[s] = x - z; pool.push([x, y, z]);
    }
    const scene = gpu.createBuffer({ label: 'writers check cells', size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    gpu.queue.writeBuffer(scene, 0, words);
    v2.restore(scene); gpu.queue.writeBuffer(v2.aux, 0, banks); v2.sync();
    const read = async () => ({ core: new Uint32Array(await gpu.readback.buffer(v2.cells, 0, g.slots * 16)), bank: new Int32Array(await gpu.readback.buffer(v2.aux, 0, g.slots * 4)) });
    const cell = (st, p) => { const s = cellSlot(g, ...p); return { core: st.core.slice(s * 4, s * 4 + 4), bank: st.bank[s] }; };
    const same = (x, y) => x.bank === y.bank && x.core.every((w, i) => w === y.core[i]);
    const wait = async () => { gpu.flush('writers check'); await gpu.queue.onSubmittedWorkDone(); };
    let before = await read();
    check(same(cell(before, [24, 3, 24]), { core: (() => { const m = makeMaterial(E.WATER, 22, FULL / 8); m.core[2] = (0x3c003c00 ^ 24) >>> 0; return m.core; })(), bank: 0 }), 'the scene is in place');
    // 1. Heat over the pool
    passes.length = 0;
    while (!sim.paint({ center: { x: 24, y: 3, z: 24 }, radius: 3, shape: 0, tool: tool('HEAT'), rate: 1 })) await new Promise(r => setTimeout(r, 25));
    await wait(); info('heat');
    let now = await read(), heated = 0, kept = true, outside = true;
    for (const p of pool) {
      const b = cell(before, p), n = cell(now, p);
      if (cFill(n.core) !== cFill(b.core) || n.core[2] !== b.core[2]) kept = false;
      const d = Math.hypot(p[0] + 0.5 - 24, p[1] + 0.5 - 3, p[2] + 0.5 - 24);
      if (d > 3.5 && !same(n, b)) outside = false;
      if (d < 2 && n.core[0] !== b.core[0]) heated++;
    }
    check(heated > 0, `heat warmed ${heated} cells in the brush`);
    check(kept, 'every heated cell keeps its fill and flux (a film stays a film)');
    check(outside, 'cells out of the brush bit-exact');
    check(passes.includes('nativePaintCommit') && !passes.some(p => legacy.test(p)), `native only (${[...new Set(passes)].join(', ')})`);
    check(sim.version === v2.seenVersion, 'nothing of V1\'s to import');
    // 2. Water on the film: air above takes whole cells, the film's cells are left alone (V1 spawns into air only)
    before = now; passes.length = 0;
    sim.paint({ center: { x: 24, y: 5, z: 24 }, radius: 2, shape: 0, tool: E.WATER, rate: 1 });
    await wait(); info('water');
    now = await read();
    const poured = cell(now, [24, 5, 24]);
    check(cid(poured.core) === E.WATER && cFill(poured.core) === FULL, 'water into air: a whole cell');
    check(pool.every(p => same(cell(now, p), cell(before, p))), 'the pool and its film untouched by water poured on it');
    check(!passes.some(p => legacy.test(p)), 'native only');
    // 3. A flood fill of the air under y = 6 with oil, from a corner
    before = now; passes.length = 0;
    const filled = await a.fill({ cell: [4, 4, 4], id: E.EMPTY, maxY: 6, stroke: { tool: E.OIL, radius: 1, shape: 0, rate: 100, replace: false } });
    await wait(); info('fill');
    now = await read();
    check(filled?.count > 0 && cid(cell(now, [4, 4, 4]).core) === E.OIL && cFill(cell(now, [4, 4, 4]).core) === FULL, `the fill filled its region (${filled?.count ?? filled?.error} cells)`);
    check(pool.every(p => same(cell(now, p), cell(before, p))), 'the pool untouched by the fill around it');
    check(passes.includes('nativeIds') && !passes.some(p => legacy.test(p)), `the fill read V2's ids (${[...new Set(passes)].join(', ')})`);
    // 4. Save and load: V2's exact words back, without V1's cells written for V2 to replace
    before = now; passes.length = 0;
    const meta = await a.saveGame('writers-browser-check');
    check(!!meta, 'saved');
    const loaded = meta && await a.openSave(meta.id);
    check(!!loaded, 'loaded');
    const v2b = a.physics.v2;
    await wait(); info('save/load');
    now = { core: new Uint32Array(await gpu.readback.buffer(v2b.cells, 0, g.slots * 16)), bank: new Int32Array(await gpu.readback.buffer(v2b.aux, 0, g.slots * 4)) };
    let diff = 0; for (let s = 0; s < g.slots; s++) if (now.bank[s] !== before.bank[s] || [0, 1, 2, 3].some(k => now.core[s * 4 + k] !== before.core[s * 4 + k])) diff++;
    check(diff === 0, `the load gave every core and bank back exactly (${diff} cells differ)`);
    check(!passes.some(p => legacy.test(p)), `no V1 export, write or import (${[...new Set(passes)].join(', ')})`);
    sim.onPass = prev;
    return { out };
  });
  for (const line of result.out) console.log(line);
  if (result.out.some(l => l.startsWith('FAIL')) || errors.length) failed = true;
} catch (e) {
  failed = true; console.log('FAIL', e.message);
} finally {
  await browser?.close();
  await vite.close();
  console.log(`slot ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
process.exitCode = failed ? 1 : 0;

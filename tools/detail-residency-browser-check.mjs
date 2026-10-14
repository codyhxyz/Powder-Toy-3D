// Real GPU counterpart to detail-residency-check: reuse the same buffers on
// window round trips, but replace them after an edit. No simulation steps.
import assert from 'node:assert/strict';
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const browser = await launchBrowser();
let vite;
try {
  vite = await startVite();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 320, height: 200 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(vite.url('/?map=labWorld&win=64'));
  await ready(page);
  await page.waitForFunction(() => __app.win?.loaded, null, { timeout: 120000 });
  const result = await page.evaluate(async () => {
    const a = __app, d = a.win.far.detail, f = a.win.far, sim = a.sim, gpu = a.gpu;
    a.test.park();
    f.queue = []; // the fixture only needs one live-derived mesh
    await Promise.all([d.stage.build(), d.pipe.build(), d.depthPipe.build()]);
    const x = sim.origin.x, z = sim.origin.z;
    const job = { key: Math.floor(x / 32) + d.nx * Math.floor(z / 32), x, z, step: 1, distance: 1 };
    d.visible = true;
    d.wanted = [job];
    let builds = 0;
    let lastIds;
    const accept = d.accept.bind(d);
    d.accept = data => { lastIds = data.ids; return accept(data); };
    const dispatch = d.stage.dispatch.bind(d.stage);
    d.stage.dispatch = (...args) => { builds++; return dispatch(...args); };
    const settle = async () => {
      await gpu.fence();
      const until = performance.now() + 20000;
      while (d.pending && performance.now() < until) await new Promise(r => setTimeout(r, 10));
      if (d.pending || d.failed) throw new Error('detail worker did not finish');
    };
    d.tick(); await settle();
    const entry = d.entries.get(job.key);
    if (!entry?.count) throw new Error('fixture needs a nonempty live mesh');
    const mask = d.mask[job.key], revision = d.revisions[job.key];
    for (const dx of [16, 16, -16, -16]) {
      const before = { dx, version: sim.version, observed: d.simVersion, dirty: d.dirty.has(job.key), builds };
      a.win.shift(dx, 0);
      await gpu.fence();
      await a.win.pending;
      d.tick(); await settle();
      if (d.entries.get(job.key) !== entry || d.mask[job.key] !== mask) throw new Error(`movement discarded the cached mesh: ${JSON.stringify({ before, version: sim.version, observed: d.simVersion, builds, revision: d.revisions[job.key] })}`);
    }
    const movementBuilds = builds;
    const { E } = await import('/src/elements.js');
    sim.paint({ center: new a.THREE.Vector3(8, sim.g.ny - 12, 8), radius: 3, shape: 1, tool: E.GOLD, rate: 1, replace: true });
    a.win.shift(16, 0);
    const staleRetained = d.entries.get(job.key) === entry && entry.step === 0 && d.mask[job.key] === mask;
    await gpu.fence();
    await a.win.pending;
    d.tick(); await settle();
    const replacement = d.entries.get(job.key);
    return { movementBuilds, builds, staleRetained, replaced: replacement !== entry,
      revised: d.revisions[job.key] > revision, gold: lastIds.includes(E.GOLD),
      bytes: d.bytes, failure: gpu.failure?.message ?? null };
  });
  assert.equal(result.movementBuilds, 1, 'four window moves must reuse the initial mesh');
  assert.equal(result.builds, 2, 'only the actual edit requests a replacement');
  assert(result.staleRetained && result.replaced && result.revised && result.gold);
  assert.equal(result.failure, null);
  assert.deepEqual(errors, []);
  console.log('PASS:', JSON.stringify(result));
} finally {
  await browser.close();
  await vite?.close();
}

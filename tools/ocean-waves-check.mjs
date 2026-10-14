// Actual water cells, not a rendering-only wave. Full 128³ production window.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const out = '/tmp/tpt-physical-ocean-waves-check';
mkdirSync(out, { recursive: true });
const vite = await startVite();
let browser;
try {
  browser = await launchBrowser();
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 960, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if ((m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text()))
        || /GPU (validation|internal)/.test(m.text())) { errors.push(m.text()); console.error(m.text()); }
  });
  await page.goto(vite.url('/?map=island&win=128'));
  await ready(page);
  const seeded = await page.evaluate(async () => {
    const a = window.__app, s = a.sim, w = a.win;
    await a.test.ready();
    a.test.park();
    a.settings.oceanWaves = 'off';
    await w.waves.prepare();
    const { E } = await import('/src/elements.js');
    const { waveSource } = await import('/src/world/waves.js');
    const source = waveSource(w);
    const [before] = await s.readState();
    const fired = w.waves.step('large');
    const [after, velocity] = await s.readState();
    let beforeWater = 0, afterWater = 0, lifted = 0, solidsChanged = 0, moving = 0;
    for (let z = 0; z < s.g.nz; z++) for (let y = 0; y < s.g.ny; y++) for (let x = 0; x < s.g.nx; x++) {
      const i = s.cellTexel(x, y, z) * 4;
      if (before[i] === E.WATER) beforeWater++;
      if (after[i] === E.WATER) {
        afterWater++;
        if (before[i] === E.EMPTY && y >= w.P.sea) lifted++;
        if (Math.hypot(...velocity.slice(i, i + 3)) > 0.1) moving++;
      }
      if (before[i] !== E.EMPTY && before[i] !== E.WATER)
        for (let c = 0; c < 4; c++) if (before[i + c] !== after[i + c]) solidsChanged++;
    }
    const off = w.waves.step('off');
    window.waveSeedState = after;
    a.autoRes.enabled = false;
    a.settings.upscale = 'native';
    a.day.fixed = { az: 115, el: 36 };
    const v = a.volume.position, scale = a.scale, [x, z] = source.center;
    const point = (dx, y, dz) => new a.THREE.Vector3(x + dx, y, z + dz).multiplyScalar(scale).add(v);
    a.camera.position.copy(point(-45, w.P.sea + 40, 60));
    a.controls.target.copy(point(0, w.P.sea, 0));
    a.controls.update();
    w.far.queue = w.far.queue.slice(-49);
    while (w.far.queue.length) { w.far.sceneChunks(1); await a.gpu.fence(); }
    await w.far.buildView();
    return { fired, off, source, beforeWater, afterWater, lifted, solidsChanged, moving };
  });
  console.log('seed', seeded);
  assert.equal(seeded.fired, true);
  assert.equal(seeded.off, false);
  assert.equal(seeded.beforeWater, seeded.afterWater, 'a wave relocates water, never creates or deletes it');
  assert.equal(seeded.solidsChanged, 0, 'terrain and structures are untouched');
  assert.ok(seeded.lifted > 100 && seeded.moving > 100, 'a real crest with momentum was seeded');
  await render(page);
  await page.screenshot({ path: `${out}/crest.png` });
  const evolved = await page.evaluate(async () => {
    const a = window.__app;
    const pulses = a.win.waves.pulses;
    a.test.step(48);
    const [after] = await a.sim.readState();
    let changed = 0;
    for (let i = 0; i < after.length; i += 4) if (after[i] !== window.waveSeedState[i]) changed++;
    const offPulses = a.win.waves.pulses - pulses;
    // Exercise the production test-step hook, not a direct driver call.
    a.win.waves.lastFrame = a.sim.frame - 720;
    a.settings.oceanWaves = 'gentle';
    a.test.step(1);
    a.settings.oceanWaves = 'off';
    return { changed, offPulses, onPulses: a.win.waves.pulses - pulses };
  });
  assert.ok(evolved.changed > 100, 'existing physics moves the seeded water');
  assert.equal(evolved.offPulses, 0, 'Off stops new waves while existing water still moves');
  assert.equal(evolved.onPulses, 1, 'ordinary simulation stepping generates a new wave');
  await render(page);
  await page.screenshot({ path: `${out}/wash.png` });
  const offshore = await page.evaluate(async () => {
    const a = window.__app, { E } = await import('/src/elements.js');
    const results = {};
    for (const level of ['gentle', 'large']) {
      a.worldLoad([0, 0, 0]);
      const [before] = await a.sim.readState();
      const fired = a.win.waves.step(level);
      const [after] = await a.sim.readState();
      let delta = 0, lifted = 0;
      for (let i = 0; i < before.length; i += 4) {
        delta += Number(after[i] === E.WATER) - Number(before[i] === E.WATER);
        if (before[i] === E.EMPTY && after[i] === E.WATER) lifted++;
      }
      results[level] = { fired, delta, lifted };
    }
    return results;
  });
  assert.equal(offshore.gentle.delta, 0);
  assert.equal(offshore.large.delta, 0);
  assert.ok(offshore.gentle.lifted > 100 && offshore.large.lifted > offshore.gentle.lifted,
    'both offshore levels seed conserved water; Large displaces more');
  await page.keyboard.press(',');
  await page.getByRole('button', { name: 'Gentle', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__app.settings.oceanWaves), 'gentle');
  await page.getByRole('button', { name: 'Ocean waves: Off', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__app.settings.oceanWaves), 'off');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('powder-toy-3d:settings')).oceanWaves === 'off');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('powder-toy-3d:settings')).oceanWaves), 'off');
  assert.deepEqual(errors, []);
  console.log('PASS conserved shore/offshore crests, physics, Off, simulation hook and saved setting', evolved, offshore, out);
} finally {
  await browser?.close();
  await vite.close();
}

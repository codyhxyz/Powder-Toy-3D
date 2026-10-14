// Compare the in-game action with the original demo's CPU initialization.
// Full-size physics; no recurring generator or replacement waveform.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const out = '/tmp/tpt-wave-demo-check';
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
  await page.evaluate(async () => {
    await __app.test.ready();
    __app.test.park();
    window.waveStart = __app.sim.origin.toArray();
    __app.win.update = () => {}; // The demo camera is a shot, not a walking player.
    __app.autoRes.enabled = false;
    __app.settings.upscale = 'native';
    __app.settings.detail_liquidFoam = true;
    __app.applyDetail();
    __app.day.fixed = { az: 115, el: 36 };
  });
  for (const kind of ['shore', 'ocean']) {
    const version = await page.evaluate(async kind => {
      const a = __app, s = a.sim;
      a.worldLoad(kind === 'ocean' ? [0, 0, 0] : window.waveStart);
      const { E, ELEMENTS } = await import('/src/elements.js');
      const [beforeA, beforeB] = await s.readState();
      const A = beforeA.slice(), B = beforeB.slice(), sea = a.win.P.sea;
      const { nx, ny, nz } = s.g;
      // Kept independent of waveDemo.js: these are the original demo's values.
      const d = kind === 'shore' ? [.646, .763] : [.15, .989];
      const center = kind === 'shore' ? 124 : 60;
      const amplitude = kind === 'shore' ? 8 : 16;
      const width = kind === 'shore' ? 10 : 13;
      const smooth = v => { v = Math.max(0, Math.min(1, v)); return v * v * (3 - 2 * v); };
      for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        if (beforeA[s.cellTexel(x, sea - 1, z) * 4] !== E.WATER) continue;
        const along = x * d[0] + z * d[1];
        const fade = smooth(Math.min(x, nx - 1 - x, z, nz - 1 - z) / 12);
        const crest = Math.exp(-(((along - center) / width) ** 2));
        const trough = Math.exp(-(((along - center - width * 1.9) / (width * 1.45)) ** 2));
        const top = sea + fade * amplitude * (crest - .4 * trough);
        for (let y = 2; y < Math.min(ny, sea + amplitude + 2); y++) {
          const i = s.cellTexel(x, y, z) * 4, was = A[i];
          if (was !== 0 && was !== E.WATER) continue;
          const id = y + .5 < top ? E.WATER : 0;
          if (id !== was) { A[i] = id; A[i + 1] = ELEMENTS[id].temp; A[i + 2] = ELEMENTS[id].life; }
          if (id === E.WATER) {
            const kick = crest * fade * Math.exp(Math.min(0, (y - sea) / 10));
            B[i] = -d[0] * .9 * kick; B[i + 2] = -d[1] * .9 * kick;
            B[i + 1] = .2 * kick * Math.tanh((along - center) / width); B[i + 3] = 0;
          } else B.fill(0, i, i + 4);
        }
      }
      window.waveExpected = { A, B, beforeA, beforeB };
      return s.version;
    }, kind);
    await page.keyboard.press(',');
    await page.getByRole('button', { name: kind === 'shore' ? 'Create shore wave' : 'Create offshore wave', exact: true }).click();
    await page.waitForFunction(version => __app.sim.version > version, version);
    const match = await page.evaluate(async () => {
      const a = __app, s = a.sim, [A, B] = await s.readState(), e = window.waveExpected;
      let ids = 0, changed = 0, maxState = 0, maxVelocity = 0;
      for (let i = 0; i < A.length; i += 4) {
        if (A[i] !== e.A[i]) ids++;
        if (A[i] !== e.beforeA[i]) changed++;
        // .w contains the engine's write flags; the material state must match.
        for (let c = 0; c < 3; c++) maxState = Math.max(maxState, Math.abs(A[i + c] - e.A[i + c]));
        for (let c = 0; c < 4; c++) maxVelocity = Math.max(maxVelocity, Math.abs(B[i + c] - e.B[i + c]));
      }
      return { ids, changed, maxState, maxVelocity, undo: s.canUndo };
    });
    console.log(kind, match);
    assert.equal(match.ids, 0, `${kind}: exact demo water occupancy`);
    assert.equal(match.maxState, 0, `${kind}: exact demo material state`);
    assert.ok(match.maxVelocity < 1e-5, `${kind}: original momentum, within float32 precision`);
    assert.ok(match.changed > 100 && match.undo, 'real water changed, with Undo');
    await page.evaluate(async kind => {
      const a = __app, f = a.win.far;
      f.queue = f.queue.slice(-49);
      while (f.queue.length) { f.sceneChunks(1); await a.gpu.fence(); }
      await f.buildView();
      const cam = kind === 'shore' ? [[20, 32, 113], [94, 19, 83]] : [[106, 37, 110], [49, 20, 48]];
      const point = v => new a.THREE.Vector3(...v).multiplyScalar(a.scale).add(a.volume.position);
      a.camera.position.copy(point(cam[0])); a.controls.target.copy(point(cam[1]));
      a.controls.update();
      document.querySelectorAll('body > :not(canvas):not(script)').forEach(el => { el.style.visibility = 'hidden'; });
      a.renderer.domElement.style.visibility = 'visible';
    }, kind);
    await render(page);
    await page.screenshot({ path: `${out}/${kind}-000.png` });
    const evolved = await page.evaluate(async () => {
      const a = __app;
      a.test.step(72);
      const [A] = await a.sim.readState();
      let changed = 0;
      for (let i = 0; i < A.length; i += 4) if (A[i] !== window.waveExpected.A[i]) changed++;
      return changed;
    });
    assert.ok(evolved > 100, 'normal simulation carries the crest');
    await render(page);
    await page.screenshot({ path: `${out}/${kind}-072.png` });
    const undone = await page.evaluate(async () => {
      const a = __app, before = window.waveExpected.beforeA;
      a.sim.undo();
      const [A] = await a.sim.readState();
      let different = 0;
      for (let i = 0; i < A.length; i += 4) if (A[i] !== before[i]) different++;
      document.querySelectorAll('body > :not(canvas):not(script)').forEach(el => { el.style.visibility = ''; });
      return different;
    });
    assert.equal(undone, 0, 'Undo restores the original water');
  }
  assert.deepEqual(errors, []);
  console.log('PASS both in-game demo actions match the original shape and momentum, evolve physically, and undo.', out);
} finally {
  await browser?.close();
  await vite.close();
}

// Decoration layer check (src/deco.js, README "Decoration"): paint falls with
// its sand, nothing empty keeps paint, the brush replacing matter wipes it,
// undo brings it back, a window shift and return in World keeps it, and the
// views draw it (screenshots with --shots).
// usage: node tools/deco-check.mjs [--port 5277] [--shots dir]   (needs a dev server on that port)
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5277');
const shots = opt('shots', null);
const FALL_STEPS = 240;   // long enough for a blob dropped near the top to land and settle

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'manual', viewport: { width: 960, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  // (a dev page without `npm run relay` fails to reach it: not an error of ours, as in activity-check)
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' && !t.startsWith('Failed to load resource')) || /GL_INVALID|WebGL:/.test(t)) errors.push(t.slice(0, 300));
  });
  await page.goto(`http://localhost:${port}/?size=128&preset=empty&test=manual`);
  await ready(page);

  // counts: decorated cells of each element, and painted empty cells
  const COUNT = async () => page.evaluate(async () => {
    const sim = window.__app.sim, { ELEMENTS } = await import('/src/elements.js');
    const [a] = sim.readState(), d = sim.deco?.read();
    const out = { empty: 0 };
    if (!d) return out;
    const { nx, ny, nz } = sim.g;
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const t = sim.cellTexel(x, y, z) * 4;
      if (!(d[t] || d[t + 1] || d[t + 2] || d[t + 3])) continue;
      const id = Math.round(a[t]);
      if (id === 0) out.empty++;
      else out[ELEMENTS[id].key] = (out[ELEMENTS[id].key] ?? 0) + 1;
    }
    return out;
  });
  const steps = (n) => page.evaluate((k) => { for (let i = 0; i < k; i++) window.__app.sim.step(); }, n);

  // a blob of sand high in the box, painted, then dropped
  await page.evaluate(async () => {
    const a = window.__app, { E, DECO_ID0 } = await import('/src/elements.js'), V = a.camera.position.constructor;
    const { setDecoColor } = await import('/src/deco.js');
    a.sim.paint({ center: new V(64, 100, 64), radius: 6, shape: 1, tool: E.SAND, rate: 1, replace: true });
    setDecoColor([40, 120, 230, 255]);
    a.sim.paint({ center: new V(64, 100, 64), radius: 6, shape: 1, tool: DECO_ID0, rate: 1, replace: false });
  });
  const before = await COUNT();
  check('the deco brush paints the sand', before.SAND > 0, JSON.stringify(before));
  await steps(FALL_STEPS);
  const after = await COUNT();
  check('paint falls with its sand', after.SAND === before.SAND, `${before.SAND} → ${after.SAND}`);
  check('nothing empty keeps paint', after.empty === 0, `${after.empty}`);
  if (shots) { await render(page); await page.screenshot({ path: `${shots}/deco-real.png` }); }
  // plain view, then display off
  if (shots) {
    await page.evaluate(() => { window.__app.settings.view = 0; });
    await page.keyboard.press('0');
    await render(page); await page.screenshot({ path: `${shots}/deco-plain.png` });
    await page.keyboard.press('1');
  }
  await page.keyboard.press('Control+b');
  check('Ctrl+B hides decoration', !(await page.evaluate(async () => (await import('/src/deco.js')).decoView.show)));
  if (shots) { await render(page); await page.screenshot({ path: `${shots}/deco-hidden.png` }); }
  await page.keyboard.press('Control+b');

  // the brush replacing painted sand with water wipes the paint there; undo brings it back
  await page.evaluate(async () => {
    const a = window.__app, { E } = await import('/src/elements.js'), V = a.camera.position.constructor;
    a.sim.snapshot();
    a.sim.paint({ center: new V(64, 2, 64), radius: 8, shape: 1, tool: E.WATER, rate: 1, replace: true });
  });
  const wiped = await COUNT();
  check('replacing matter wipes its paint', (wiped.SAND ?? 0) < after.SAND && !wiped.WATER, JSON.stringify(wiped));
  await page.evaluate(() => window.__app.sim.undo());
  const undone = await COUNT();
  check('undo brings the paint back', undone.SAND === after.SAND, `${undone.SAND}`);

  check('no page or GL errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  // World: paint a patch of ground, slide the window away from it until it has
  // left, then back: the paint comes back with the ground (src/deco.js leave/enter)
  await page.goto(`http://localhost:${port}/?size=world&test=manual`);
  await ready(page);
  await page.waitForFunction(() => window.__app.win?.loaded, null, { polling: 200, timeout: 180000 });
  const world = await page.evaluate(async () => {
    const a = window.__app, win = a.win, sim = a.sim, V = a.camera.position.constructor;
    const { DECO_ID0, E } = await import('/src/elements.js');
    const { WIN_STEP } = await import('/src/world/window.js');
    const count = () => { const d = sim.deco?.read(); let n = 0; if (d) for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
    const settle = async () => { while (win.pending || sim.deco?.pending) await new Promise((r) => setTimeout(r, 50)); };
    // a block of wall at the window's low x edge, which leaves first, painted
    const at = new V(8, sim.g.ny / 2, sim.g.nz / 2);
    sim.paint({ center: at, radius: 6, shape: 1, tool: E.WALL, rate: 1, replace: true });
    sim.paint({ center: at, radius: 6, shape: 1, tool: DECO_ID0, rate: 1, replace: false });
    const painted = count();
    const away = Math.ceil(24 / WIN_STEP) + 1;
    for (let i = 0; i < away; i++) { win.shift(WIN_STEP, 0); await settle(); }
    const gone = count(), stored = sim.deco?.store.size ?? 0;
    for (let i = 0; i < away; i++) { win.shift(-WIN_STEP, 0); await settle(); }
    return { painted, gone, stored, back: count() };
  });
  check('World: the paint leaves with its bricks', world.painted > 0 && world.gone === 0 && world.stored > 0, JSON.stringify(world));
  check('World: and comes back with them', world.back === world.painted, JSON.stringify(world));
  check('no page or GL errors in World', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}
console.log(fails ? `${fails} failure(s)` : 'deco check OK');
process.exit(fails ? 1 : 0);

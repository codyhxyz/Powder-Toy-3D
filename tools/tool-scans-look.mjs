// Scanned tool stills (models.js SCANS): each tool in first person at rest and
// a moment into its action (a dig, a swing, a shot), then in third person from
// in front of the body, once its scan has replaced its parts.
// For judging grip, size, orientation and light by eye. Writes
// tools-<tool>-fp.png, -fp-act.png and -tp.png to --shots, and prints which
// scans were on. Keep --tools short: the run has one 25 s GPU slot.
// usage: node tools/tool-scans-look.mjs --port 6871 --shots dir --tools SHOVEL,AXE [--fp 0] [--tp 0]   (needs a dev server)
import { launchBrowser, newTestPage, render } from './browser.mjs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '6871');
const shots = opt('shots', '.');
const tools = opt('tools', 'SHOVEL').split(',');
const thirdPerson = opt('tp', '1') !== '0';
const firstPerson = opt('fp', '1') !== '0';
const W = 960, H = 600;
const SPAWN = [64, 0, 64.5];
const YAW = -Math.PI / 2;                 // look along +x
const PITCH = -0.35;                      // down a little: at the ground a dig or a swing reaches
const SCAN_WAIT_MS = 8000;                // ms for a scan to load and compile before the still is taken anyway
// the third-person still's camera: metres in front of the body, to its right, up from the feet, and the height it looks at
const TP_VIEW = [1.6, -0.9, 1.3, 1.1];
const ACT_MS = 70;                        // ms into the action for its still

const b = await launchBrowser();
try {
  const p = await newTestPage(b, { mode: 'preview', viewport: { width: W, height: H } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' || /scan failed/.test(m.text())) errs.push(m.text().slice(0, 300)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
  await p.goto(`http://localhost:${port}/?preset=empty`, { timeout: 120000 });
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 120000 });
  const ev = (fn, arg) => p.evaluate(fn, arg);
  await p.addStyleTag({ content: 'body *{visibility:hidden !important} canvas[data-engine]{visibility:visible !important}' });
  await p.mouse.move(W / 2, H / 2);
  await p.keyboard.press('v');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 20000 }).catch(() => {});
  await ev(([spawn, yaw, pitch]) => {
    const a = window.__app, V = a.camera.position.constructor;
    a.pov.test.assumeLocked = true; a.pov.player.spawn(new V(...spawn)); a.pov.setLook(yaw, pitch);
  }, [SPAWN, YAW, PITCH]);
  // the scans fetched at once, not each on its first draw (the game's own lazy load), to fit the slot
  await ev(async (keys) => {
    const { prefetchScan } = await import('/src/pov/models.js');
    const { gearByKey } = await import('/src/pov/tools/catalog.js');
    await Promise.all(keys.map((k) => prefetchScan(gearByKey(k).model)));
  }, tools);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(shots, { recursive: true });
  // a tool's model where `root` holds it: whether its scan is on and its parts hidden
  const scanned = (where) => ev(([where]) => {
    const a = window.__app.pov;
    const root = where === 'tp' ? a.held.group : a.viewmodel;
    let on = null;
    root.traverse((o) => { if (o.name === window.__scanModel) on = { scan: !!o.getObjectByName('scan'), parts: o.children[0].visible }; });
    return { model: window.__scanModel, ...(on ?? { scan: false }) };
  }, [where]);
  const waitScan = async (where) => { const t0 = Date.now(); await waitScanned(where); return Date.now() - t0; };
  const waitScanned = (where) => p.waitForFunction((where) => {
    const a = window.__app.pov, root = where === 'tp' ? a.held.group : a.viewmodel;
    let done = false;
    root.traverse((o) => { if (o.name === window.__scanModel && o.getObjectByName('scan') && !o.children[0].visible) done = true; });
    return done;
  }, where, { timeout: SCAN_WAIT_MS }).catch(() => {});
  for (const key of firstPerson ? tools : []) {
    await ev(async ([k, yaw, pitch]) => {
      const { gearByKey } = await import('/src/pov/tools/catalog.js');
      window.__scanModel = `viewmodel-${gearByKey(k).model}`;
      const a = window.__app.pov; a.toolbelt.select(k); a.setLook(yaw, pitch);
    }, [key, YAW, PITCH]);
    const ms = await waitScan('fp');
    await render(p);
    await p.screenshot({ path: `${shots}/tools-${key.toLowerCase()}-fp.png` });
    await ev(() => window.__app.test.resume());
    await p.mouse.down();
    await p.waitForTimeout(ACT_MS);
    await render(p);
    await p.screenshot({ path: `${shots}/tools-${key.toLowerCase()}-fp-act.png` });
    await p.mouse.up();
    await ev(() => window.__app.test.resume());
    console.log('fp', JSON.stringify(await scanned('fp')), `scan on after ${ms} ms`);
  }
  if (thirdPerson) {
    await p.waitForFunction(() => window.__app.pov.figure.loaded, null, { timeout: 8000 }).catch(() => {});
    await p.keyboard.press('F5');
    await p.waitForTimeout(1200);   // (the camera's swing out to the shoulder)
    for (const key of tools) {
      await ev(async ([k, yaw]) => {
        const { gearByKey } = await import('/src/pov/tools/catalog.js');
        window.__scanModel = `viewmodel-${gearByKey(k).model}`;
        const a = window.__app.pov; a.toolbelt.select(k); a.setLook(yaw, 0);
      }, [key, YAW]);
      await waitScan('tp');
      await p.waitForTimeout(400);
      await render(p);
      // from the front and to the left of the body (tools/tp-held-look.mjs's front view), at the hands
      await ev(([fwd, right, up, at]) => {
        const a = window.__app, root = a.pov.figure.real?.root ?? a.pov.figure.root;
        const s = root.getWorldScale(new a.THREE.Vector3()).x / 0.3;   // world units per metre (a cell is 0.3 m)
        const feet = root.getWorldPosition(new a.THREE.Vector3());
        const yaw = a.pov.camera.look.yaw;
        const f = new a.THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), r = new a.THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
        a.camera.position.copy(feet).addScaledVector(f, fwd * s).addScaledVector(r, right * s).add(new a.THREE.Vector3(0, up * s, 0));
        a.camera.lookAt(feet.clone().add(new a.THREE.Vector3(0, at * s, 0)));
        a.camera.updateMatrixWorld();
        a.test.render();
      }, TP_VIEW);
      await p.screenshot({ path: `${shots}/tools-${key.toLowerCase()}-tp.png` });
      await ev(() => window.__app.test.resume());
      console.log('tp', JSON.stringify(await scanned('tp')));
    }
  }
  console.log(errs.length ? errs.slice(0, 8).join('\n') : 'no errors');
} finally {
  await b.close();
}

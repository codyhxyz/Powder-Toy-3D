// Third-person held-tool stills: every tool in the realistic body's hands, from
// the game's own over-the-shoulder camera and from the front and the side, for
// judging the hold by eye. Writes <tag>-<tool>-{tp,front,side}.png to --shots.
// usage: node tools/tp-held-look.mjs --port 5417 --shots dir [--tag after] [--tools AXE,SMG] [--pitch 0]   (needs a dev server)
import { launchBrowser, newTestPage, render } from './browser.mjs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5417');
const shots = opt('shots', '.');
const tag = opt('tag', 'shot');
const pitch = Number(opt('pitch', '0'));
const W = 1100, H = 700;
const SPAWN = [64, 0, 64.5];
const YAW = -Math.PI / 2;                 // look along +x
const ALL = ['SHOVEL', 'PICKAXE', 'AXE', 'KNIFE', 'TROWEL', 'BUCKET', 'FLASK', 'GUN', 'SMG', 'SNIPER', 'LASER', 'BOMB', 'ROCKET',
  'BURROWER', 'PHYSGUN', 'BLOWTORCH', 'SCANNER', 'POGO', 'TORCH', 'LANTERN', 'HOOK', 'TOOLGUN'];
const tools = opt('tools', ALL.join(',')).split(',');
// the outside views: [name, metres in front of the body, metres to its right, metres up from the feet]
const VIEWS = [['front', 1.9, -1.1, 1.25], ['side', 0.25, 2.3, 1.15]];
const LOOK_AT_M = 1.05;                   // metres up from the feet the outside views look at
const SETTLE_MS = 900;                    // ms for a tool's pose to blend in

const b = await launchBrowser();
try {
  const p = await newTestPage(b, { mode: 'preview', viewport: { width: W, height: H } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
  await p.goto(`http://localhost:${port}/?preset=empty`, { timeout: 120000 });
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 120000 });
  await p.waitForTimeout(1500);
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const wait = (ms) => p.waitForTimeout(ms);
  await p.addStyleTag({ content: 'body *{visibility:hidden !important} canvas[data-engine]{visibility:visible !important}' });
  await p.mouse.move(W / 2, H / 2);
  await p.keyboard.press('v');   // V drops in (keys-check)
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 }).catch(() => {});
  await ev(([spawn, yaw, pitch]) => {
    const a = window.__app, V = a.camera.position.constructor;
    a.pov.test.assumeLocked = true; a.pov.player.spawn(new V(...spawn)); a.pov.setLook(yaw, pitch);
  }, [SPAWN, YAW, pitch]);
  await p.waitForFunction(() => window.__app.pov.figure.loaded, null, { timeout: 30000 }).catch(() => {});
  await p.keyboard.press('F5');
  await wait(1500);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(shots, { recursive: true });
  for (const key of tools) {
    await ev(([k, yaw, pitch]) => { const a = window.__app.pov; a.toolbelt.select(k); a.setLook(yaw, pitch); }, [key, YAW, pitch]);
    await wait(SETTLE_MS);
    await render(p);
    await p.screenshot({ path: `${shots}/${tag}-${key}-tp.png` });
    for (const [name, fwd, right, up] of VIEWS) {
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
      }, [fwd, right, up, LOOK_AT_M]);
      await p.screenshot({ path: `${shots}/${tag}-${key}-${name}.png` });
    }
    await ev(() => window.__app.test.resume());
  }
  console.log(errs.length ? errs.slice(0, 8).join('\n') : 'no errors');
} finally {
  await b.close();
}

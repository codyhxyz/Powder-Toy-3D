// Third-person dig stills: the shovel's dig and toss gestures (holds.js GESTURES)
// on the realistic body, from the side and from the front, each frozen at a few
// moments of the gesture, for judging the motion by eye. Writes
// <gesture>-<view>-<ms>.png to <outDir>.
// usage: node tools/tp-dig-look.mjs <outDir> [--port 5521]   (runs its own Vite on --port)
import { mkdirSync } from 'node:fs';
import { launchBrowser, newTestPage } from './browser.mjs';
import { startVite } from './vite-server.mjs';

const args = process.argv.slice(2);
const out = args[0] ?? 'tp-dig-look';
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('port', '5521'));
mkdirSync(out, { recursive: true });
const W = 900, H = 700;
const SPAWN = [64, 0, 64.5];
const YAW = -Math.PI / 2;                 // look along +x
const PITCH = -0.35;                      // rad: looking at the ground ahead, as digging does
// the outside views: [name, metres in front of the body, metres to its right, metres up from the feet] (tp-held-look's)
const VIEWS = [['side', 0.6, 3.2, 0.9], ['front', 2.4, -1.4, 1.1]];
const POSE_MS = 400;                     // ms the app runs with a pose pinned before the stills
const LOOK_AT_M = 0.8;                    // metres up from the feet the views look at
// [gesture, its span (s: the shovel's REFIRE / THROW_REFIRE), moments to freeze (s)]
const GESTURES = [['dig', 0.15, [0, 0.03, 0.065, 0.11, 0.15]], ['toss', 0.2, [0.03, 0.09, 0.14]]];

const vite = await startVite({ port });
const b = await launchBrowser();
try {
  const p = await newTestPage(b, { mode: 'preview', viewport: { width: W, height: H } });
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
  await p.goto(vite.url('/?preset=empty'), { timeout: 120000 });
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 120000 });
  await p.waitForTimeout(1500);
  const ev = (fn, arg) => p.evaluate(fn, arg);
  await p.addStyleTag({ content: 'body *{visibility:hidden !important} canvas[data-engine]{visibility:visible !important}' });
  await p.mouse.move(W / 2, H / 2);
  await p.keyboard.press('v');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 }).catch(() => {});
  await ev(([spawn, yaw, pitch]) => {
    const a = window.__app, V = a.camera.position.constructor;
    a.pov.test.assumeLocked = true; a.pov.player.spawn(new V(...spawn)); a.pov.setLook(yaw, pitch);
  }, [SPAWN, YAW, PITCH]);
  await p.waitForFunction(() => window.__app.pov.figure.loaded, null, { timeout: 30000 }).catch(() => {});
  await p.keyboard.press('F5');
  await ev(([yaw, pitch]) => { const a = window.__app.pov; a.toolbelt.select('SHOVEL'); a.setLook(yaw, pitch); }, [YAW, PITCH]);
  await p.waitForTimeout(1500);
  // the shovel's hand (the viewmodel group whose gesture held.js plays), its gesture pinned at
  // `since`: the tool's own `since += dt` and a new dig's reset can't move it
  const freeze = (name, span, since) => ev(([name, span, since]) => {
    let hand = null;
    window.__app.pov.viewmodel.traverse((o) => { if (o.userData.gesture?.name !== undefined) hand = o; });
    if (!hand) return false;
    const g = { name, span };
    Object.defineProperty(g, 'since', { get: () => since, set() {}, enumerable: true });
    hand.userData.gesture = g;
    return true;
  }, [name, span, since]);
  for (const [name, span, moments] of GESTURES) {
    for (const since of moments) {
      if (!(await freeze(name, span, since))) { console.log('no shovel hand with a gesture'); break; }
      await ev(() => window.__app.test.resume());
      await p.waitForTimeout(POSE_MS);   // the body takes the pose (held.js runs every frame)
      for (const [view, fwd, right, up] of VIEWS) {
        await ev(([fwd, right, up, at]) => {
          const a = window.__app, root = a.pov.figure.real?.root ?? a.pov.figure.root;
          a.test.park();
          const s = root.getWorldScale(new a.THREE.Vector3()).x / 0.3;   // world units per metre (a cell is 0.3 m)
          const feet = root.getWorldPosition(new a.THREE.Vector3());
          const yaw = a.pov.camera.look.yaw;
          const f = new a.THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), r = new a.THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
          a.camera.position.copy(feet).addScaledVector(f, fwd * s).addScaledVector(r, right * s).add(new a.THREE.Vector3(0, up * s, 0));
          a.camera.lookAt(feet.clone().add(new a.THREE.Vector3(0, at * s, 0)));
          a.camera.updateMatrixWorld();
          a.test.render();
        }, [fwd, right, up, LOOK_AT_M]);
        await p.screenshot({ path: `${out}/${name}-${view}-${Math.round(since * 1000)}.png` });
      }
    }
  }
  console.log(errs.length ? errs.join('\n') : 'no page errors');
} finally {
  await b.close();
  await vite.close();
}

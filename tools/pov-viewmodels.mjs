// POV viewmodel check (Gunplay v2): every tool's model shows,
// it doesn't clip into a wall you stand against, the spring recoil overshoots
// and settles, and the tools announce their actions on the POV event bus.
// usage: node tools/pov-viewmodels.mjs [--port 5242] [--sheet out.jpg]   (needs a dev server)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5242');
const sheet = opt('sheet', null);
const W = 960, H = 600;
const THUMB = 0.4;   // contact-sheet frames, as a share of the viewport

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
await p.goto(`http://localhost:${port}/?preset=empty`);
await p.waitForFunction(() => window.__app?.pov, null, { timeout: 20000 });
await p.waitForTimeout(1500);

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const settle = (ms) => p.waitForTimeout(ms);
const frames = [];
const grab = async (label) => { if (sheet) frames.push({ label, data: (await p.screenshot({ type: 'jpeg', quality: 80 })).toString('base64') }); };
const paint = (tool, c, r, shape = 1, times = 1, replace = false) => ev(async ([tool, c, r, shape, times, replace]) => {
  const { E } = await import('/src/elements.js');
  const a = window.__app;
  for (let i = 0; i < times; i++) a.sim.paint({ center: new a.camera.position.constructor(...c), radius: r, shape, tool: E[tool], rate: 1, replace });
}, [tool, c, r, shape, times, replace]);
// stand at feet (x, z) looking along yaw (rad; −π/2 faces +x), pitch (rad)
const stand = (x, z, yaw = -Math.PI / 2, pitch = 0) => ev(([x, z, yaw, pitch]) => {
  const a = window.__app;
  a.pov.player.spawn(a.pov.player.pos.clone().set(x, 0, z));
  a.pov.setLook(yaw, pitch);
}, [x, z, yaw, pitch]);
const slot = async (n) => { await p.keyboard.press(String(n)); await settle(200); };
const click = async (button = 'left', hold = 80) => { await p.mouse.down({ button }); await settle(hold); await p.mouse.up({ button }); };

// the POV event log
await ev(async () => {
  const { povEvents } = await import('/src/pov/events.js');
  window.__vmLog = [];
  for (const n of ['tool:action', 'impact', 'gun:fire', 'gun:dry']) {
    povEvents.on(n, (e) => window.__vmLog.push({ n, ...e, point: e.point?.toArray?.(), normal: e.normal?.toArray?.(),
      muzzleWorld: e.muzzleWorld?.toArray?.(), origin: e.origin?.toArray?.(), dir: e.dir?.toArray?.() }));
  }
});
const log = () => ev(() => window.__vmLog.splice(0));

// ---- drop in
await p.mouse.move(W / 2, H / 2);
await p.keyboard.press('f');
await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 10000 }).catch(() => {});
await ev(() => { window.__app.pov.test.assumeLocked = true; });
check('dropped in', (await ev(() => window.__app.pov.mode)) === 'on');

// ---- every tool's model loads and shows (in the open)
const MODEL = ['shovel', 'bucket', 'axe', 'gun', 'physgun'];
await stand(30, 64, -Math.PI / 2, -0.05);
for (let i = 0; i < MODEL.length; i++) {
  await slot(i + 1);
  await p.waitForFunction((k) => window.__app.pov.viewmodel.getObjectByName(`viewmodel-${k}`), MODEL[i], { timeout: 8000 }).catch(() => {});
  await settle(400);
  const seen = await ev((k) => {
    const vm = window.__app.pov.viewmodel, obj = vm.getObjectByName(`viewmodel-${k}`);
    if (!obj) return { loaded: false };
    let visible = vm.visible, meshes = 0, layerOk = true;
    for (let o = obj; o; o = o.parent) visible &&= o.visible;
    obj.traverse((o) => { if (o.isMesh) { meshes++; layerOk &&= o.layers.mask === 1 << 5; } });
    return { loaded: true, visible, meshes, layerOk };
  }, MODEL[i]);
  check(`${MODEL[i]} model loads and shows`, seen.loaded && seen.visible && seen.meshes > 0 && seen.layerOk, JSON.stringify(seen));
  await grab(MODEL[i]);
}

// ---- nose to a wall: the gun stays whole (drawn after the world, with its own depth)
await paint('WALL', [40, 6, 64], 6, 1);
await settle(400);
await slot(4);
await stand(33.2, 64, -Math.PI / 2, 0);
await settle(800);
const gap = await ev(() => { const pl = window.__app.pov.player; return +(34 - (pl.pos.x + 0.8)).toFixed(2); });
await grab('gun, nose to wall');
console.log(`     body face to wall: ${gap} cells`);

// ---- spring recoil: fire, sample the rig's offset every frame
await stand(30, 90, -Math.PI / 2, 0.02);
await settle(600);
await log();
// headless frames are slow and uneven: sample after every rig update (game time), not on a wall clock
const SAMPLE_FRAMES = 40;
const samplesP = ev((n) => new Promise((done) => {
  const rig = window.__app.pov.viewmodel.userData.rig;
  const orig = rig.update, out = [];
  let t = 0;
  rig.update = (ctx) => {
    orig(ctx);
    t += ctx.dt;
    const s = rig.state.spring;
    out.push([+t.toFixed(3), s.z, s.pitch]);
    if (out.length >= n) { rig.update = orig; done(out); }
  };
}), SAMPLE_FRAMES);
await click();
const samples = await samplesP;
const zs = samples.map((s) => s[1]), ps = samples.map((s) => s[2]);
const peak = Math.max(...zs), under = Math.min(...zs), end = Math.abs(zs.at(-1)) + Math.abs(ps.at(-1));
check('recoil kicks back', peak > 0.1, `peak ${peak.toFixed(3)} cells, pitch peak ${Math.max(...ps).toFixed(3)} rad`);
check('recoil overshoots past rest', under < -0.01, `overshoot ${under.toFixed(3)} cells (${(-under / peak * 100).toFixed(0)}%)`);
check('recoil settles', end < 1e-3, `|z|+|pitch| after ${samples.at(-1)[0]} s: ${end.toExponential(1)}`);
console.log('     z(t):', samples.filter((_, i) => i % 3 === 0).map(([t, z]) => `${t}:${z.toFixed(3)}`).join(' '));
const fire = (await log()).find((e) => e.n === 'gun:fire');
check('gun:fire carries muzzleWorld', fire?.muzzleWorld?.every(Number.isFinite), JSON.stringify(fire?.muzzleWorld));
await settle(400);
await grab('gun after a shot');

// ---- tool emits
// shovel: dig sand, dump it
await paint('SAND', [36, 2, 30], 2.5, 0, 12);
await stand(32, 30, -Math.PI / 2, -0.7);
await settle(900);
await slot(1);
await p.mouse.down(); await settle(1000); await p.mouse.up();
await settle(300);
await ev(() => window.__app.pov.setLook(Math.PI / 2, -0.4));
await settle(500);
await grab('shovel with a load');
await settle(200);
await click('right');
await settle(600);
// shovel on WALL: refused
await stand(33.2, 64, -Math.PI / 2, -0.2);
await settle(500);
await p.mouse.down(); await settle(400); await p.mouse.up();
let L = await log();
const acts = (tool) => L.filter((e) => e.n === 'tool:action' && e.tool === tool).map((e) => e.action);
check('shovel: dig, dump, refuse', ['dig', 'dump', 'refuse'].every((a) => acts('shovel').includes(a)), acts('shovel').join(','));

// axe: wood (breaks) then rock (refused)
await paint('WOOD', [36.5, 4, 110.5], 1.5, 1);
await paint('ROCK', [36.5, 4, 116.5], 1.5, 1);
await stand(33, 110.5, -Math.PI / 2, -0.1);
await settle(600);
await slot(3);
await click(); await settle(600);
console.log('     axe lastHit', await ev(() => JSON.stringify(window.__app.pov.toolbelt.tool(2).lastHit)));
await grab('axe swing');
await stand(33, 116.5, -Math.PI / 2, -0.1);
await settle(600);
await click(); await settle(600);
L = await log();
const impacts = L.filter((e) => e.n === 'impact');
check('axe: swing, impact (wood breaks), refuse (rock)', acts('axe').filter((a) => a === 'swing').length === 2
  && impacts.length === 2 && impacts[0].broke === true && impacts[1].broke === false && acts('axe').includes('refuse'),
  `${acts('axe').join(',')} | impacts ${impacts.map((e) => `${e.source}:${e.id}:${e.broke}`).join(' ')}`);

// physgun: grab, fling; grab, release
await paint('SAND', [44, 2, 40], 3, 0, 15);
await stand(34, 40, -Math.PI / 2, -0.25);
await settle(1200);
await slot(5);
await p.mouse.down();
await settle(900);
await grab('physgun holding');
await click('right');
await p.mouse.up();
await settle(300);
await click('left', 500);
await settle(300);
L = await log();
check('physgun: grab, fling, release', ['grab', 'fling', 'release'].every((a) => acts('physgun').includes(a)), acts('physgun').join(','));

// bucket: a pool to scoop from and pour back
await ev(async () => { const a = window.__app; const { E } = await import('/src/elements.js');
  const V = a.camera.position.constructor;
  a.sim.paint({ center: new V(96, 3, 64), radius: 11, shape: 1, tool: E.WALL, rate: 1, replace: true });
  a.sim.paint({ center: new V(96, 4, 64), radius: 10, shape: 1, tool: E.ERASE, rate: 1, replace: true });
  for (let i = 0; i < 4; i++) a.sim.paint({ center: new V(96, 3, 64), radius: 9.5, shape: 1, tool: E.WATER, rate: 1, replace: false });
});
await settle(2000);
await ev(() => { const a = window.__app; a.pov.player.spawn(a.pov.player.pos.clone().set(96, 9, 64)); a.pov.setLook(-Math.PI / 2, -0.6); });
await slot(2);
await settle(2000);
const swim = await ev(() => window.__app.pov.player.inLiquid);
await click('left', 400);
await settle(800);
await grab(`bucket${swim ? ' (swimming)' : ''}`);
await stand(70, 64, -Math.PI / 2, -0.3);   // pour on dry ground
await settle(800);
await grab('bucket, full');
await p.mouse.down({ button: 'right' }); await settle(1000); await p.mouse.up({ button: 'right' });
await settle(800);
L = await log();
check('bucket: scoop, pour', ['scoop', 'pour'].every((a) => acts('bucket').includes(a)), `${acts('bucket').join(',')}${swim ? ' (swimming)' : ''}`);

// ---- contact sheet
if (sheet) {
  const html = `<body style="margin:0;background:#111;display:flex;flex-wrap:wrap;width:${Math.ceil(W * THUMB) * 3}px">${frames.map((f) => `
    <figure style="margin:0;position:relative"><img src="data:image/jpeg;base64,${f.data}" style="width:${W * THUMB}px;display:block">
    <figcaption style="position:absolute;left:6px;top:4px;color:#fff;font:600 12px sans-serif;text-shadow:0 0 3px #000">${f.label}</figcaption></figure>`).join('')}</body>`;
  const q = await b.newPage({ viewport: { width: Math.ceil(W * THUMB) * 3, height: 100 } });
  await q.setContent(html);
  await q.screenshot({ path: sheet, type: 'jpeg', quality: 70, fullPage: true });
}

console.log(errs.length ? `console errors:\n  ${[...new Set(errs)].slice(0, 8).join('\n  ')}` : 'no console errors');
console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
await b.close();
process.exit(fails ? 1 : 0);

// Headless check of the POV keys that speak other games' language: V noclip
// (in and out of the body, Garry's Mod), F and F5 first or third person
// (Skyrim, Minecraft), C held zooms with the wheel (Minecraft's zoom mods,
// pov/zoom.js), Ctrl swims down (the Source games' duck) and guards Ctrl+W.
// usage: node tools/keys-check.mjs [--port 5193] [--shots dir]   (needs a dev server)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5193');
const shots = opt('shots', null);
const W = 960, H = 600;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
// (the multiplayer relay isn't running locally: its refused connection isn't ours)
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const wait = (ms) => p.waitForTimeout(ms);
const shot = async (name) => { if (shots) await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 70, scale: 'css' }); };
const mode = () => ev(() => window.__app.pov.mode);
const until = (fn, ms) => p.waitForFunction(fn, null, { timeout: ms, polling: 50 }).then(() => true, () => false);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

try {
  // an empty box: the lab's enemy would kill the body partway through
  await p.goto(`http://localhost:${port}/?size=128&preset=empty`);
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  await wait(2000);
  await p.mouse.move(W / 2, H * 0.62);
  await wait(200);

  // ---- V drops in (noclip off), V pops out (noclip on)
  await p.keyboard.press('v');
  check('V drops in', await until(() => window.__app.pov.mode === 'on', 30000), await mode());
  await ev(() => { window.__app.pov.test.assumeLocked = true; window.__marker = 1; });
  await p.mouse.move(W / 2, H / 2);
  await wait(400);
  const fov0 = await ev(() => window.__app.settings.povFov);

  // ---- F and F5: first or third person, and F5 doesn't reload
  await p.keyboard.press('f');
  await wait(1000);
  const tp = await ev(() => {
    const a = window.__app, pl = a.pov.player, s = a.scale;
    const eye = pl.pos.clone().setY(pl.pos.y + 5).multiplyScalar(s).add(a.volume.position);
    return { third: a.pov.camera.third, d: a.camera.position.distanceTo(eye) / s, mode: a.pov.mode };
  });
  check('F swaps to third person', tp.third && tp.d > 6 && tp.mode === 'on', JSON.stringify(tp));
  await p.keyboard.press('F5');
  await wait(800);
  const fp = await ev(() => ({ third: window.__app.pov.camera.third, marker: window.__marker, mode: window.__app.pov.mode }));
  check('F5 swaps back to first person, without reloading', !fp.third && fp.marker === 1 && fp.mode === 'on', JSON.stringify(fp));

  // ---- C: hold to zoom ÷4, the wheel zooms further while held, the look slows with the view
  const turn = () => ev(() => { const c = window.__app.pov.camera, y0 = c.look.yaw; c.turn(100, 0); const d = y0 - c.look.yaw; c.setLook(y0, c.look.pitch); return d; });
  const yaw1 = await turn();
  const slot0 = await ev(() => window.__app.pov.toolbelt?.selectedKey ?? null);
  await shot('keys-plain');
  await p.keyboard.down('c');
  const early = [];
  for (let i = 0; i < 4; i++) { await wait(60); early.push(+(await ev(() => window.__app.camera.fov)).toFixed(1)); }
  await wait(1000);
  const fovZ = await ev(() => window.__app.camera.fov);
  check('C held: the view narrows to a quarter, eased in', near(fovZ, fov0 / 4, 0.6) && early[0] > fovZ + 1, `${fovZ.toFixed(2)}° (setting ${fov0}°), first frames ${early.join(' ')}`);
  const yawZ = await turn();
  check('zoomed, the look slows with the view', near(yawZ / yaw1, fovZ / fov0, 0.05), `ratio ${(yawZ / yaw1).toFixed(3)} vs fov ${(fovZ / fov0).toFixed(3)}`);
  await shot('keys-zoomed');
  // headless can't lock the pointer, so the wheel goes to what's under it: bare canvas, off the hotbar's stacks
  const bare = [W * 0.08, H * 0.35];
  await p.mouse.move(...bare);
  const under = await ev(([x, y]) => document.elementFromPoint(x, y)?.tagName, bare);
  check('the mouse is over the canvas for the wheel', under === 'CANVAS', under);
  await p.mouse.wheel(0, -120); await wait(260);
  await p.mouse.wheel(0, -120); await wait(900);
  const fovS = await ev(() => window.__app.camera.fov);
  const slot1 = await ev(() => window.__app.pov.toolbelt?.selectedKey ?? null);
  check('wheel up twice while held: ×1.5 a notch', near(fovS, fov0 / 9, 0.4), `${fovS.toFixed(2)}° (want ${(fov0 / 9).toFixed(2)})`);
  check('...and the wheel did not change tool', slot1 === slot0, `${slot0} → ${slot1}`);
  await shot('keys-zoomed-more');
  await p.keyboard.up('c');
  await wait(800);
  const fovR = await ev(() => window.__app.camera.fov);
  check('C released: back to the plain view', near(fovR, fov0, 0.6), `${fovR.toFixed(2)}°`);
  await p.keyboard.down('c'); await wait(1200);
  const fovAgain = await ev(() => window.__app.camera.fov);
  await p.keyboard.up('c'); await wait(800);
  check('the scrolling is forgotten on letting go (Zoomify)', near(fovAgain, fov0 / 4, 0.6), `${fovAgain.toFixed(2)}°`);
  await p.mouse.wheel(0, 120); await wait(300);
  const slot2 = await ev(() => window.__app.pov.toolbelt?.selectedKey ?? null);
  check('without C the wheel picks tools again', slot2 !== slot0, `${slot0} → ${slot2}`);

  // ---- Ctrl: swim down, movement still counts while it's held, leaving asks first
  await ev(() => {
    const pl = window.__app.pov.player, update = pl.update;
    pl.update = (dt, input) => { window.__input = { down: input.down, x: input.move.x, z: input.move.z }; return update.call(pl, dt, input); };
  });
  const unloadAsks = () => ev(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; });
  const asksBefore = await unloadAsks();
  await p.keyboard.down('Control');
  await p.keyboard.down('d');
  await wait(200);
  const inp = await ev(() => window.__input);
  const asksHeld = await unloadAsks();
  await p.keyboard.up('d');
  await p.keyboard.up('Control');
  await wait(200);
  const inp2 = await ev(() => window.__input);
  check('Ctrl swims down, D still moves while it is held', inp.down && Math.hypot(inp.x, inp.z) > 0.5, JSON.stringify(inp));
  check('let go, no more swimming down', !inp2.down, JSON.stringify(inp2));
  check('leaving asks only while Ctrl is held', !asksBefore && asksHeld, `before ${asksBefore}, held ${asksHeld}`);
  check('C no longer swims down', await (async () => { await p.keyboard.down('c'); await wait(150); const d = await ev(() => window.__input.down); await p.keyboard.up('c'); return !d; })());

  check('the body lived through the checks', await ev(() => !window.__app.pov.player.dead), await ev(() => window.__app.pov.player.cause ?? ''));

  // ---- V out; F from the god view drops in too
  await wait(900);
  await p.keyboard.press('v');
  check('V pops out to the god view', await until(() => window.__app.pov.mode === 'off', 15000), await mode());
  check('...the orbit camera is back', await ev(() => window.__app.controls.enabled && window.__app.camera.fov < 60));
  await wait(400);
  await p.keyboard.press('f');
  check('F from the god view drops in too', await until(() => window.__app.pov.mode === 'on', 30000), await mode());
  await ev(() => { window.__app.pov.test.assumeLocked = true; });
  check('...in first person still', await ev(() => !window.__app.pov.camera.third));
  await p.keyboard.press('v');
  check('V pops out again', await until(() => window.__app.pov.mode === 'off', 15000), await mode());

  // ---- the shortcut sheet and the POV hint teach the new keys
  const texts = await ev(() => ({
    help: [...document.querySelectorAll('.help .key')].map((r) => r.textContent).join(' | '),
    hint: document.querySelector('.pov-hint')?.textContent ?? '',
  }));
  check('shortcut sheet: V noclip, F view, C zoom, Ctrl swim down',
    /Noclip[^|]*V/.test(texts.help) && /First or third person\s*F/.test(texts.help) && /Zoom[^|]*C/.test(texts.help) && /Swim down\s*Ctrl/.test(texts.help), texts.help.slice(0, 0));
  check('POV hint: zoom, third person, noclip', /C zoom/.test(texts.hint) && /F third person/.test(texts.hint) && /V noclip/.test(texts.hint), texts.hint);
} finally {
  if (errs.length) { console.log('page errors:'); errs.slice(0, 8).forEach((e) => console.log('  ' + e)); }
  check('no page errors', !errs.length);
  await b.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);

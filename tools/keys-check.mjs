// Headless check of the POV keys that speak other games' language: V in and
// out of the body (Garry's Mod's noclip key; F drops in too, from the god
// view), F5 first or third person (Minecraft), Z held zooms with the wheel
// (Minecraft's zoom mods, pov/zoom.js), C held crouches (Source's duck:
// half height, a third of the speed, stays down under a low ceiling; swims
// down in liquid), F kicks; and the body choice is Realistic | Stickman.
// usage: node tools/keys-check.mjs [--port 5193] [--shots dir]   (needs a dev server)
import { chromium } from 'playwright';
import { E, ELEMENTS } from '../src/elements.js';
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
  await p.goto(`http://localhost:${port}/?size=128&preset=empty`, { timeout: 120000 });
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

  check('the body defaults to Realistic, with no Wizard to pick', await ev(() =>
    window.__app.settings.character === 'real' && window.__app.pov.figure.showing !== 'wizard'));

  // ---- F5: first or third person, without reloading; F leaves the view alone
  await p.keyboard.press('f');
  await wait(300);
  check('F in the body leaves the view alone (it is the kick)', await ev(() => !window.__app.pov.camera.third && window.__app.pov.mode === 'on'));
  await p.keyboard.press('F5');
  await wait(1000);
  const tp = await ev(() => {
    const a = window.__app, pl = a.pov.player, s = a.scale;
    const eye = pl.pos.clone().setY(pl.pos.y + 5).multiplyScalar(s).add(a.volume.position);
    return { third: a.pov.camera.third, d: a.camera.position.distanceTo(eye) / s, mode: a.pov.mode };
  });
  check('F5 swaps to third person', tp.third && tp.d > 6 && tp.mode === 'on', JSON.stringify(tp));
  await p.keyboard.press('F5');
  await wait(800);
  const fp = await ev(() => ({ third: window.__app.pov.camera.third, marker: window.__marker, mode: window.__app.pov.mode }));
  check('F5 swaps back to first person, without reloading', !fp.third && fp.marker === 1 && fp.mode === 'on', JSON.stringify(fp));

  // ---- Z: hold to zoom ÷4, the wheel zooms further while held, the look slows with the view
  const turn = () => ev(() => { const c = window.__app.pov.camera, y0 = c.look.yaw; c.turn(100, 0); const d = y0 - c.look.yaw; c.setLook(y0, c.look.pitch); return d; });
  const yaw1 = await turn();
  const slot0 = await ev(() => window.__app.pov.toolbelt?.selectedKey ?? null);
  await shot('keys-plain');
  await p.keyboard.down('z');
  const early = [];
  for (let i = 0; i < 4; i++) { await wait(60); early.push(+(await ev(() => window.__app.camera.fov)).toFixed(1)); }
  await wait(1000);
  const fovZ = await ev(() => window.__app.camera.fov);
  check('Z held: the view narrows to a quarter, eased in', near(fovZ, fov0 / 4, 0.6) && early[0] > fovZ + 1, `${fovZ.toFixed(2)}° (setting ${fov0}°), first frames ${early.join(' ')}`);
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
  await p.keyboard.up('z');
  await wait(800);
  const fovR = await ev(() => window.__app.camera.fov);
  check('Z released: back to the plain view', near(fovR, fov0, 0.6), `${fovR.toFixed(2)}°`);
  await p.keyboard.down('z'); await wait(1200);
  const fovAgain = await ev(() => window.__app.camera.fov);
  await p.keyboard.up('z'); await wait(800);
  check('the scrolling is forgotten on letting go (Zoomify)', near(fovAgain, fov0 / 4, 0.6), `${fovAgain.toFixed(2)}°`);
  await p.mouse.wheel(0, 120); await wait(300);
  const slot2 = await ev(() => window.__app.pov.toolbelt?.selectedKey ?? null);
  check('without Z the wheel picks tools again', slot2 !== slot0, `${slot0} → ${slot2}`);

  // ---- C: swims down (the crouch key), movement still counts while it's held
  await ev(() => {
    const pl = window.__app.pov.player, update = pl.update;
    pl.update = (dt, input) => { window.__input = { down: input.down, x: input.move.x, z: input.move.z }; return update.call(pl, dt, input); };
  });
  await p.keyboard.down('c');
  await p.keyboard.down('d');
  await wait(200);
  const inp = await ev(() => window.__input);
  await p.keyboard.up('d');
  await p.keyboard.up('c');
  await wait(200);
  const inp2 = await ev(() => window.__input);
  check('C swims down (in liquid), D still moves while it is held', inp.down && Math.hypot(inp.x, inp.z) > 0.5, JSON.stringify(inp));
  check('let go, no more swimming down', !inp2.down, JSON.stringify(inp2));
  check('Z does not swim down', await (async () => { await p.keyboard.down('z'); await wait(150); const d = await ev(() => window.__input.down); await p.keyboard.up('z'); return !d; })());
  // ---- C held crouches: half the height, the eye down, a third of the speed
  const body = () => ev(() => { const a = window.__app, pl = a.pov.player; return { h: pl.height, eye: pl.eyeHeight, crouch: pl.crouch, camY: a.camera.position.y / a.scale, x: pl.pos.x, z: pl.pos.z, y: pl.pos.y, speed: Math.hypot(pl.vel.x, pl.vel.z), ground: pl.onGround }; });
  await wait(400);
  const stand = await body();
  await p.keyboard.down('c'); await wait(700);
  const low = await body();
  check('C crouches to half height, the eye and camera down', near(low.h, stand.h / 2, 0.15) && near(low.eye, stand.eye * 28 / 64, 0.15) && stand.camY - low.camY > 2,
    `height ${stand.h.toFixed(2)} → ${low.h.toFixed(2)}, eye ${stand.eye.toFixed(2)} → ${low.eye.toFixed(2)}, camera −${(stand.camY - low.camY).toFixed(2)} cells`);
  await p.keyboard.down('w'); await wait(1200);
  const slow = (await body()).speed;
  await p.keyboard.up('c'); await wait(1200);
  const walk = (await body()).speed;
  await p.keyboard.up('w'); await wait(400);
  check('crouched walking is a third of the speed', walk > 1 && near(slow / walk, 1 / 3, 0.08), `${slow.toFixed(2)} vs ${walk.toFixed(2)} cells/s (×${(slow / walk).toFixed(2)})`);
  // under a slab of wall between the crouched and the standing height: stays down until out of it
  await p.keyboard.down('c'); await wait(700);
  const at = await body();
  await ev(([wall, T, life, x0, z0, y0, y1, half]) => {
    const sim = window.__app.sim, g = sim.g, [A, B] = sim.blankState();
    for (let y = y0; y < y1; y++) for (let z = z0 - half; z <= z0 + half; z++) for (let x = x0 - half; x <= x0 + half; x++) {
      if (x < 0 || z < 0 || x >= g.nx || z >= g.nz) continue;
      const i = sim.cellTexel(x, y, z) * 4;
      A[i] = wall; A[i + 1] = T; A[i + 2] = life; A[i + 3] = 0.5;
    }
    sim.load(A, B);
  }, [E.WALL, ELEMENTS[E.WALL].temp, ELEMENTS[E.WALL].life, Math.floor(at.x), Math.floor(at.z), 3, 6, 4]);
  await wait(500);
  await p.keyboard.up('c'); await wait(700);
  const roofed = await body();
  check('under a low ceiling, letting go of C stays crouched', roofed.h < 3, `height ${roofed.h.toFixed(2)} (ceiling at 3)`);
  await p.keyboard.down('d'); await wait(3500); await p.keyboard.up('d'); await wait(700);
  const out = await body();
  check('...and stands once out from under it', near(out.h, stand.h, 0.1), `height ${out.h.toFixed(2)}, moved ${Math.hypot(out.x - at.x, out.z - at.z).toFixed(1)} cells`);

  // ---- F kicks (pov/kick.js: the 'kick' event)
  await ev(() => { window.__kicks = 0; window.__app.pov.events.on('kick', () => { window.__kicks++; }); });
  await p.keyboard.press('f'); await wait(800);
  check('F kicks', (await ev(() => window.__kicks)) > 0, `${await ev(() => window.__kicks)} kick event(s)`);

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
  check('shortcut sheet: V god view, F5 view, Z zoom, C crouch',
    /God view[^|]*V/.test(texts.help) && /First or third person\s*F5/.test(texts.help) && /Zoom[^|]*Z/.test(texts.help) && /Crouch[^|]*C/.test(texts.help), texts.help.slice(0, 0));
  check('POV hint: Z zoom, F5 third person, V god view, C crouch, F kick', /Z zoom/.test(texts.hint) && /F5 third person/.test(texts.hint) && /V god view/.test(texts.hint) && /C crouch/.test(texts.hint) && /F kick/.test(texts.hint), texts.hint);
  check('settings offer Realistic and Stickman only', await ev(() => !document.querySelector('.drawer button[data-value="wizard"]') && !!document.querySelector('.drawer button[data-value="real"]')));
} finally {
  if (errs.length) { console.log('page errors:'); errs.slice(0, 8).forEach((e) => console.log('  ' + e)); }
  check('no page errors', !errs.length);
  await b.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);

// Gunplay v2 end-to-end check: every piece together through the real shell.
// A long-range shot through glass (ballistics + strike), the sound, effects,
// feedback and viewmodel it sets off, and the realistic body in third person.
// usage: node tools/gp-integration.mjs [--port 5296] [--shots dir]   (needs a dev server)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5296');
const shots = opt('shots', null);
const W = 960, H = 600;
const RANGE = 60;   // cells from the shooter to the pane

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
await p.goto(`http://localhost:${port}/?preset=empty`);
await p.waitForFunction(() => window.__app?.pov, null, { timeout: 30000 });
await p.waitForTimeout(1500);

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const wait = (ms) => p.waitForTimeout(ms);
const shot = async (name) => { if (shots) await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 70 }); };
const census = () => ev(async () => {
  const { ELEMENTS } = await import('/src/elements.js');
  return Object.fromEntries(Object.entries(window.__app.sim.census()).map(([k, v]) => [ELEMENTS[k].key, v.n]));
});

// record every POV event
await ev(async () => {
  const { povEvents } = await import('/src/pov/events.js');
  window.__evs = [];
  for (const n of ['gun:fire', 'gun:dry', 'round:move', 'round:end', 'impact', 'tool:action', 'player:step']) povEvents.on(n, (x) => window.__evs.push([n, x.broke ?? x.action ?? '']));
});

// drop in, realistic body
await ev(() => { window.__app.settings.figure = 'real'; });
await p.mouse.move(W / 2, H / 2);
await wait(300);
await p.keyboard.press('f');
await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 15000 }).catch(() => {});
check('dropped in', (await ev(() => window.__app.pov.mode)) === 'on');
await ev(() => { window.__app.pov.test.assumeLocked = true; });

// a glass pane far down range
await ev(async ([range]) => {
  const a = window.__app, { E } = await import('/src/elements.js'), V = a.camera.position.constructor;
  a.sim.paint({ center: new V(20 + range, 5, 64.5), radius: 3, shape: 1, tool: E.GLASS, rate: 1, replace: true });
  a.pov.player.spawn(new V(20, 0, 64.5));
  a.pov.setLook(-Math.PI / 2, 0);
}, [RANGE]);
await wait(1200);
await p.keyboard.press('3');   // the Guns slot: the pistol (a key press also starts the audio)
await wait(1500);   // models load
const vm = await ev(() => {
  const rig = window.__app.pov.viewmodel.userData.rig;
  const gun = window.__app.pov.toolbelt;
  let meshes = 0;
  window.__app.pov.viewmodel.traverse((o) => { if (o.isMesh && o.visible) meshes++; });
  return { rig: !!rig, meshes };
});
check('gun model loaded on the rig', vm.rig && vm.meshes > 0, JSON.stringify(vm));

const c0 = await census();
await p.mouse.down(); await wait(60); await p.mouse.up();
await wait(120);
await shot('fire');
await wait(1500);
const c1 = await census();
const evs = await ev(() => window.__evs.map((e) => e[0]));
const count = (n) => evs.filter((e) => e === n).length;
check('gun:fire emitted', count('gun:fire') === 1, `${count('gun:fire')}`);
check('round flew and ended', count('round:move') > 0 && count('round:end') === 1, `moves ${count('round:move')}`);
check('impact at range', count('impact') >= 1);
check(`glass broke at ${RANGE} cells`, (c1.SHARDS ?? 0) > (c0.SHARDS ?? 0), `GLASS ${c0.GLASS}→${c1.GLASS}, SHARDS ${c0.SHARDS ?? 0}→${c1.SHARDS ?? 0}, SCRAP ${c0.SCRAP ?? 0}→${c1.SCRAP ?? 0}`);
check('the round adds no matter (no SCRAP slug)', (c1.SCRAP ?? 0) === (c0.SCRAP ?? 0));
const audio = await ev(async () => { const m = await import('/src/pov/audio.js'); const s = m.stats(); return { ctx: s.context, played: s.played, last: s.last.map((l) => l.name ?? l[0] ?? l).slice(-6) }; });
check('sound played', audio.played > 0, JSON.stringify(audio));
const vfx = await ev(() => window.__app.pov.vfx?.counts?.());
check('vfx ran', !!vfx, JSON.stringify(vfx));

// walk a little: footsteps
await p.keyboard.down('w'); await wait(1500); await p.keyboard.up('w');
check('footsteps', (await ev(() => window.__evs.filter((e) => e[0] === 'player:step').length)) > 0);

// third person: the realistic body
await p.keyboard.press('F5');
await wait(1200);
const body = await ev(() => { const f = window.__app.pov.figure; return { choice: f?.choice ?? window.__app.settings.figure, real: !!(f?.real ?? f?.isReal ?? f?.loaded) }; });
console.log('     body:', JSON.stringify(body));
await shot('third');
await p.keyboard.press('F5');
await p.keyboard.press('v');
await p.waitForFunction(() => window.__app.pov.mode === 'off', null, { timeout: 15000 }).catch(() => {});
check('popped out', (await ev(() => window.__app.pov.mode)) === 'off');

console.log(errs.length ? `console errors:\n  ${[...new Set(errs)].slice(0, 8).join('\n  ')}` : 'no console errors');
console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
await b.close();
process.exit(fails ? 1 : 0);

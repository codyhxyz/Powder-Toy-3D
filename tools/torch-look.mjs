// Torch look stills: the held torch and a thrown one at night (and one by day),
// with rock pillars ahead at 2, 4, 6 and 8 m, for judging the torch's model,
// flame and reach by eye. Writes <tag>-*.png to --shots.
// usage: node tools/torch-look.mjs --port 5417 --shots dir [--tag after]   (needs a dev server)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5417');
const shots = opt('shots', '.');
const tag = opt('tag', 'shot');
const W = 1280, H = 800;
const MIDNIGHT_STEPS = 42000;   // gfx/daylight.js: midnight with the 10 am start (as lights-check)
const SPAWN = [20, 0, 64.5];
const PILLARS_M = [2, 4, 6, 8]; // metres ahead (−x) of the eye
const CELL_M = 0.3;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
await p.goto(`http://localhost:${port}/?preset=empty`);
await p.waitForFunction(() => window.__app?.pov, null, { timeout: 90000 });
await p.waitForTimeout(1500);
const ev = (fn, arg) => p.evaluate(fn, arg);
const wait = (ms) => p.waitForTimeout(ms);
const shot = (name, clip) => p.screenshot({ path: `${shots}/${tag}-${name}.png`, clip });
await p.addStyleTag({ content: 'body *{visibility:hidden !important} canvas[data-engine]{visibility:visible !important}' });

await ev(async ([steps, spawn, pillars, cellM]) => {
  const a = window.__app, { E } = await import('/src/elements.js'), V = a.camera.position.constructor;
  a.day.clock = steps;
  for (const m of pillars) {
    const x = spawn[0] + m / cellM;
    for (let y = 1; y < 10; y += 2) a.sim.paint({ center: new V(x, y, spawn[2] + (m % 4 ? 3 : -3)), radius: 1.5, shape: 1, tool: E.ROCK, rate: 1, replace: true });
  }
  a.sim.paint({ center: new V(spawn[0] + 11 / cellM, 6, spawn[2]), radius: 6, shape: 1, tool: E.ROCK, rate: 1, replace: true });
}, [MIDNIGHT_STEPS, SPAWN, PILLARS_M, CELL_M]);
await p.mouse.move(W / 2, H / 2);
await p.keyboard.press('f');
await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 20000 }).catch(() => {});
await ev((spawn) => { const a = window.__app, V = a.camera.position.constructor; a.pov.test.assumeLocked = true; a.pov.player.spawn(new V(...spawn)); a.pov.setLook(-Math.PI / 2, -0.12); }, SPAWN);
await wait(1500);
await ev(() => window.__app.pov.toolbelt.select('SHOVEL'));
await wait(800);
await shot('night-none');
await ev(() => window.__app.pov.toolbelt.select('TORCH'));
await wait(1500);
for (let i = 0; i < 3; i++) { await shot(`night-held-${i}`); await wait(110); }
await shot('night-held-crop', { x: W * 0.5, y: H * 0.25, width: W * 0.5, height: H * 0.75 });
// turning: the flame trails
await ev(async () => { const a = window.__app; for (let i = 0; i < 8; i++) { a.pov.setLook(-Math.PI / 2 + i * 0.05, -0.12); await new Promise((r) => requestAnimationFrame(r)); } });
await shot('night-held-turning', { x: W * 0.5, y: H * 0.25, width: W * 0.5, height: H * 0.75 });
await ev(() => window.__app.pov.setLook(-Math.PI / 2, -0.12));
await wait(600);
// look down at it
await ev(() => window.__app.pov.setLook(-Math.PI / 2, -1.2));
await wait(600);
await shot('night-held-down');
await ev(() => window.__app.pov.setLook(-Math.PI / 2, -0.12));
await wait(400);
// a thrown torch on the ground ahead, seen from where you stand
await ev(() => window.__app.pov.setLook(-Math.PI / 2, -0.5));
await p.mouse.down({ button: 'right' }); await wait(40); await p.mouse.up({ button: 'right' });
await wait(1500);
await ev(() => { const a = window.__app; a.pov.toolbelt.select('SHOVEL'); a.pov.setLook(-Math.PI / 2, -0.25); });
await wait(900);
for (let i = 0; i < 2; i++) { await shot(`night-thrown-${i}`); await wait(150); }
const counts = await ev(() => window.__app.pov.vfx?.counts?.() ?? null);
// by day
await ev(() => { window.__app.day.clock = 0; window.__app.pov.toolbelt.select('TORCH'); window.__app.pov.setLook(-Math.PI / 2, -0.12); });
await wait(1500);
await shot('day-held');
// the hotbar icon (models.js modelIcon), at 4× for a look
const icon = await ev(async () => (await import('/src/pov/models.js')).modelIcon('torch'));
const { writeFileSync } = await import('node:fs');
writeFileSync(`${shots}/${tag}-icon.png`, Buffer.from(icon.split(',')[1], 'base64'));
console.log('vfx', JSON.stringify(counts));
console.log(errs.length ? errs.slice(0, 8).join('\n') : 'no errors');
await b.close();

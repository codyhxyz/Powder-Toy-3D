// Headless view tool: load a preset, optionally run the sim for a while, pause,
// place the camera and screenshot. Prints console errors and a frame timing.
// usage: node tools/view.mjs <out.png> [--port 5180] [--preset lab] [--wait 6000]
//          [--cam x,y,z] [--target x,y,z] [--view 0] [--size 1280x800] [--eval "js"]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5180');
const [w, h] = opt('size', '1280x800').split('x').map(Number);
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: w, height: h } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 4000)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 2000)));
await p.goto(`http://localhost:${port}/?preset=${opt('preset', 'lab')}`);
await p.waitForTimeout(+opt('wait', 6000));
const res = await p.evaluate(async ([cam, target, view, js]) => {
  const a = window.__app;
  if (cam) a.camera.position.set(...cam.split(',').map(Number));
  if (target) a.controls.target.set(...target.split(',').map(Number));
  a.controls.update();
  if (view) a.settings.view = +view;
  if (js) await eval(js);
  await new Promise((r) => setTimeout(r, 700));
  // average frame time over 30 frames
  const t0 = performance.now();
  for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));
  return { frameMs: +((performance.now() - t0) / 30).toFixed(2) };
}, [opt('cam'), opt('target'), opt('view'), opt('eval')]);
await p.screenshot({ path: out });
console.log(JSON.stringify(res), errs.length ? '\n' + errs.join('\n') : '');
await b.close();

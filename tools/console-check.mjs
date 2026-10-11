// GPU check of the scripting console (src/console, docs/console.md): opens it
// with ` in an empty 128³ box and runs Lua through the real write pass and
// readbacks. 'manual' mode: the app loop is parked and the view never draws,
// so the frames are driven here, the way app.js's loop calls the console
// (scripts.tick, beforeStep / sim.step / afterStep, endFrame). That checks the
// simulation side only, and keeps working when the view can't. tools/check-console.mjs
// covers the same API on the CPU; this checks the GPU half (shaders/script.js,
// the supertile reads, sync and async) and the panel.
// usage: node tools/console-check.mjs --port 47391 [--shots dir]   (needs a dev or preview server)
import { launchBrowser, newTestPage, ready } from './browser.mjs';
import { E } from '../src/elements.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '47391');
const shots = opt('shots', null);
const W = 1100, H = 700;
const N = 128;
const idx = (x, y, z) => (z * N + y) * N + x;

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info !== '' ? `  ${info}` : ''}`); };

const browser = await launchBrowser();
try {
  const p = await newTestPage(browser, { mode: 'manual', viewport: { width: W, height: H } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|relay/i.test(m.text())) errs.push(m.text().slice(0, 400)); });
  p.on('pageerror', (e) => errs.push(`PAGEERROR ${String(e).slice(0, 600)}`));
  await p.goto(`http://localhost:${port}/?size=128&preset=empty`, { timeout: 120000 });
  await ready(p);
  await p.waitForTimeout(1500);
  const menuShown = () => p.evaluate(() => { const m = document.querySelector('.mm'); return !!m && m.checkVisibility(); });
  const menuBefore = await menuShown();

  // ` opens it; Lua loads lazily
  await p.mouse.move(W / 2, H / 2);
  const t0 = Date.now();
  await p.keyboard.press('Backquote');
  check('` opens the console', await p.evaluate(() => window.__app.scripts.open));
  check('Lua loads on first open', await p.waitForFunction(() => document.querySelector('.console-log')?.textContent.includes('Lua 5.3'), null, { timeout: 30000 }).then(() => true, () => false),
    `${Date.now() - t0} ms`);
  check('the input has focus', await p.evaluate(() => document.activeElement?.classList.contains('console-input')));

  // a command: fill the input, Enter, the new log rows and the error line
  const cmd = async (code) => {
    const before = await p.evaluate(() => document.querySelectorAll('.console-row').length);
    await p.fill('.console-input', code);
    const t = Date.now();
    await p.keyboard.press('Enter');
    await p.waitForFunction((n) => document.querySelectorAll('.console-row').length > n, before, { timeout: 15000 }).catch(() => {});
    return p.evaluate(([n, ms]) => {
      const rows = [...document.querySelectorAll('.console-row')].slice(n).filter((r) => !r.classList.contains('cmd'));
      return { out: rows.map((r) => r.textContent).join('\n'), error: document.querySelector('.console-error').textContent, ms };
    }, [before, Date.now() - t]);
  };

  let r = await cmd('sim.XRES, sim.YRES, sim.ZRES');
  check('sim.XRES, YRES, ZRES', r.out === '128, 128, 128', r.out || r.error);
  r = await cmd('sim.partCreate(-1, 64, 120, 64, elem.DEFAULT_PT_WATR)');
  check('partCreate returns the cell index (first write pass: compiles it)', r.out === String(idx(64, 120, 64)), `${r.out || r.error} in ${r.ms} ms`);
  r = await cmd('sim.cellProperty(64, 120, 64, "type"), sim.cellProperty(64, 119, 64, "type")');
  check('the GPU holds the new cell (a fresh readback)', r.out === `${E.WATER}, ${E.EMPTY}`, r.out || r.error);
  r = await cmd('local i = sim.partCreate(-1, 10, 60, 10, "WALL"); sim.partProperty(i, "temp", 500); sim.partProperty(i, "ctype", 7); return i');
  r = await cmd(`sim.partProperty(${idx(10, 60, 10)}, "temp"), sim.partProperty(${idx(10, 60, 10)}, "ctype")`);
  check('temp and ctype written on the GPU', r.out === '500, 7', r.out || r.error);
  r = await cmd('sim.partCreate(-1, 10, 60, 10, "SAND")');
  check('partCreate(-1) on matter fails', r.out === '-1', r.out || r.error);
  r = await cmd('sim.pressure(20, 20, 20, 50); return sim.pressure(20, 20, 20)');
  check('sim.pressure', r.out === '50', r.out || r.error);
  r = await cmd('sim.step(60); return sim.partID(64, 120, 64), sim.elementCount("WATR")');
  check('sim.step: the water fell (a whole-grid read finds it)', r.out === 'nil, 1', `${r.out || r.error} in ${r.ms} ms`);
  r = await cmd('local n = 0 for i in sim.parts() do n = n + 1 end return n');
  check('sim.parts()', r.out === '2', r.out || r.error);

  // undo takes back a command's writes
  await cmd('sim.partCreate(-1, 5, 5, 5, "WALL")');
  await p.evaluate(() => window.__app.undo());
  r = await cmd('sim.partID(5, 5, 5)');
  check('⌘Z undoes a command', r.out === 'nil', r.out || r.error);

  // handlers: frames driven as app.js's loop drives them (steps: 0 = paused);
  // a frame apart in real time, so the asynchronous reads can land
  const frames = (n, steps = 0) => p.evaluate(async ([n, steps]) => {
    const s = window.__app.scripts, sim = window.__app.sim;
    for (let f = 0; f < n; f++) {
      s.tick();
      for (let i = 0; i < steps; i++) { s.beforeStep(); sim.step(); s.afterStep(); }
      s.endFrame();
      await new Promise(requestAnimationFrame);
    }
  }, [n, steps]);
  await cmd('n = 0; event.register(event.tick, function() n = n + 1 end)');
  await frames(5);
  r = await cmd('n');
  check('event.tick runs every frame, paused too', r.out === '5', r.out || r.error);
  await cmd('seen = "unset"; event.register(event.tick, function() seen = sim.cellProperty(10, 60, 10, "type") end)');
  await p.evaluate(() => window.__app.scripts.world.blocks.clear());   // (earlier commands cached it synchronously)
  await frames(1);
  r = await cmd('seen');
  check('a handler\'s first read of a block is nil (requested)', r.out === 'nil', r.out || r.error);
  await frames(12);
  r = await cmd('seen');
  check('...and a later frame reads it from the asynchronous cache', r.out === String(E.WALL), r.out || r.error);
  await cmd('event.register(event.tick, function() error("boom") end)');
  await frames(1);
  check('a throwing handler is removed with a message', await p.evaluate(() => [...document.querySelectorAll('.console-row.error')].some((e) => e.textContent.includes('removed') && e.textContent.includes('boom'))));
  await cmd('event.register(event.tick, function() while true do end end)');
  await frames(1);
  check('a runaway handler is removed', await p.evaluate(() => [...document.querySelectorAll('.console-row.error')].some((e) => e.textContent.includes('ran longer'))));
  await cmd('event.register(event.beforesim, function() sim.partCreate(-1, 30, 120, 30, "SAND") end)');
  await frames(20, 4);
  r = await cmd('sim.elementCount("SAND")');
  check('event.beforesim pours a stream while running', Number(r.out) > 5, r.out || r.error);
  check('Stop scripts shows while handlers are registered', await p.evaluate(() => !document.querySelector('.console-stop').hidden));
  if (shots) await p.screenshot({ path: `${shots}/console.png` });
  await p.click('.console-stop');
  check('Stop scripts unregisters them', await p.evaluate(() => document.querySelector('.console-stop').hidden));

  // a runaway command stops at its limit
  r = await cmd('while true do end');
  check('a runaway command stops', r.error.includes('ran longer'), `${r.error} in ${r.ms} ms`);

  // keys: ` closes from the input without typing one; Esc closes without opening the map menu
  await p.keyboard.press('Backquote');
  check('` closes it', !(await p.evaluate(() => window.__app.scripts.open)));
  await p.keyboard.press('Backquote');
  check('` opens it again', await p.evaluate(() => window.__app.scripts.open && !document.querySelector('.console-input').value.includes('`')));
  await p.keyboard.press('ArrowUp');
  check('Up recalls the last command', (await p.inputValue('.console-input')) === 'while true do end');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  check('Esc closes it', !(await p.evaluate(() => window.__app.scripts.open)));
  check('...and doesn\'t open the map menu', (await menuShown()) === menuBefore);
  check('no page errors', !errs.length, errs.join(' | '));
} finally {
  await browser.close();
}
console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);

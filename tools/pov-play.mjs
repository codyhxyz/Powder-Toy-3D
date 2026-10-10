// End-to-end POV check on the merged build: drop in, walk, then use every tool
// on a scene built for it, through the real shell, body and toolbelt.
// usage: node tools/pov-play.mjs [--port 5196] [--shots dir]   (needs a dev server)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5196');
const shots = opt('shots', null);
const W = 960, H = 600;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
await p.goto(`http://localhost:${port}/?preset=empty`);
await p.waitForFunction(() => window.__app?.pov, null, { timeout: 20000 });
await p.waitForTimeout(2000);

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const shot = async (name) => { if (shots) await p.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 70 }); };
const census = () => ev(() => {
  const c = window.__app.sim.census();
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.n]));
});
const named = (c) => ev((c) => import('/src/elements.js').then(({ ELEMENTS }) =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [ELEMENTS[k].key, v]))), c);
const diff = (a, b) => { const o = {}; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = (b[k] ?? 0) - (a[k] ?? 0); if (d && k !== 'EMPTY') o[k] = d; } return o; };

// paint a solid box or a powder blob (repeated: powders spawn sparse)
const paint = (tool, c, r, shape = 1, times = 1) => ev(async ([tool, c, r, shape, times]) => {
  const { E } = await import('/src/elements.js');
  const a = window.__app;
  for (let i = 0; i < times; i++) a.sim.paint({ center: new a.camera.position.constructor(...c), radius: r, shape, tool: E[tool], rate: 1, replace: false });
}, [tool, c, r, shape, times]);
const settle = (ms) => p.waitForTimeout(ms);
// stand at feet (x, z) facing +x, pitch in radians
const stand = (x, z, pitch = 0) => ev(([x, z, pitch]) => {
  const a = window.__app;
  a.pov.player.spawn(a.pov.player.pos.clone().set(x, 0, z));
  a.pov.setLook(-Math.PI / 2, pitch);
}, [x, z, pitch]);
const TOOL_AT = { 1: 'SHOVEL', 2: 'BUCKET', 3: 'AXE', 4: 'GUN', 5: 'PHYSGUN' };   // the numbers of the old ten-slot bar
const slot = async (n) => { await ev((k) => window.__app.pov.toolbelt.select(k), TOOL_AT[n]); await settle(150); };
const click = async (button = 'left', hold = 80) => { await p.mouse.down({ button }); await settle(hold); await p.mouse.up({ button }); };
const status = () => ev(() => [...document.querySelectorAll('.hotbar-slot, [class*=hotbar] [class*=status]')].map((e) => e.textContent.trim()).filter(Boolean).join(' | '));

// ---- drop in
await p.mouse.move(W / 2, H / 2);
await settle(300);
await p.keyboard.press('f');
await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 10000 }).catch(() => {});
await ev(() => { window.__app.pov.test.assumeLocked = true; });
check('dropped in', (await ev(() => window.__app.pov.mode)) === 'on');

// ---- walk
await stand(30, 64);
await settle(500);
const w0 = await ev(() => window.__app.pov.player.pos.toArray());
const t0 = Date.now();
await p.keyboard.down('w'); await settle(1500); await p.keyboard.up('w');
const w1 = await ev(() => ({ pos: window.__app.pov.player.pos.toArray(), rate: window.__app.pov.player.stepRate }));
const walked = w1.pos[0] - w0[0];
check('walks forward', walked > 3, `${walked.toFixed(2)} cells in ${((Date.now() - t0) / 1000).toFixed(1)} s, sim ${w1.rate} steps/s`);

// ---- shovel: sand pile at the feet
await paint('SAND', [36, 2, 64], 2.5, 0, 12);
await stand(32, 64, -0.7);
await settle(800);
const s0 = await census();
await slot(1);
await p.mouse.down(); await settle(1200); await p.mouse.up();
await settle(400);
const shovelStatus = await status();
const s1 = await census();
check('shovel took sand', (s0[2] ?? 0) - (s1[2] ?? 0) > 5, `${(s0[2] ?? 0) - (s1[2] ?? 0)} grains; hotbar: ${shovelStatus}`);
await ev(() => window.__app.pov.setLook(Math.PI / 2, -0.4));   // turn around and dump
await settle(300);
await click('right');
await settle(1200);
const s2 = await census();
check('shovel dump conserves sand', (s2[2] ?? 0) === (s0[2] ?? 0), `before ${s0[2]} after ${s2[2]}`);

// ---- axe: a wooden post within reach
await paint('WOOD', [36.5, 4, 80.5], 1.5, 1);
await paint('GLASS', [36.5, 4, 86.5], 1.5, 1);
await stand(33, 80.5, -0.1);
await settle(600);
await slot(3);
const a0 = await named(await census());
for (let i = 0; i < 3; i++) { await click(); await settle(550); }
await settle(400);
const a1 = await named(await census());
check('axe chops wood into sawdust', (a1.SAWDUST ?? 0) > 0 && (a0.WOOD - (a1.WOOD ?? 0)) === (a1.SAWDUST ?? 0), JSON.stringify(diff(a0, a1)));

// ---- gun: glass pane down range, metal plate beside it
await paint('GLASS', [52.5, 5, 100.5], 3, 1);
await stand(36, 100.5, 0.02);
await settle(600);
await slot(4);
const g0 = await named(await census());
const v0 = await ev(() => window.__app.pov.player.vel.toArray());
await click();
await settle(100);
const recoil = await ev(() => window.__app.pov.player.vel.toArray());
await shot('gun-fire');
await settle(1500);
const g1 = await named(await census());
check('gun round adds no matter (no SCRAP slug)', (g1.SCRAP ?? 0) === (g0.SCRAP ?? 0), JSON.stringify(diff(g0, g1)));
check('round breaks glass into shards', (g1.SHARDS ?? 0) > (g0.SHARDS ?? 0), `shards ${g0.SHARDS ?? 0} → ${g1.SHARDS ?? 0}`);
console.log('     recoil: vel before', v0.map((v) => v.toFixed(1)).join(','), 'after', recoil.map((v) => v.toFixed(1)).join(','));
await shot('gun-after');

// ---- physgun: lift a sand blob
await paint('SAND', [44, 2, 40], 3, 0, 15);
await stand(34, 40, -0.25);
await settle(1500);
await slot(5);
await p.mouse.down();
await ev(() => window.__app.pov.setLook(-Math.PI / 2, 0.15));
await settle(2500);
const lifted = await ev(() => {
  const a = window.__app, s = a.sim.census();
  return s[2] ? { minY: s[2].minY, maxY: s[2].maxY } : null;
});
await shot('physgun-hold');
await p.mouse.up();
check('physgun lifts sand off the floor', lifted && lifted.maxY > 6, JSON.stringify(lifted));

// ---- bucket + underwater: a pool
await paint('WALL', [96, 0, 64], 12, 1);           // a basin: wall block, hollowed by water fill below
await paint('ERASE', [96, 6, 64], 10, 1);           // not quite a basin, but erase the top so we have a wall floor
await ev(async () => { const a = window.__app; const { E } = await import('/src/elements.js');
  const V = a.camera.position.constructor;
  a.sim.paint({ center: new V(96, 6, 64), radius: 11, shape: 1, tool: E.WALL, rate: 1, replace: true });
  a.sim.paint({ center: new V(96, 7, 64), radius: 10, shape: 1, tool: E.ERASE, rate: 1, replace: true });
  for (let i = 0; i < 6; i++) a.sim.paint({ center: new V(96, 6, 64), radius: 9.5, shape: 1, tool: E.WATER, rate: 1, replace: false });
});
await settle(2500);
await ev(() => { const a = window.__app; a.pov.player.spawn(a.pov.player.pos.clone().set(96, 10, 64)); a.pov.setLook(-Math.PI / 2, -0.3); });
await slot(2);
await settle(2500);
const swim = await ev(() => { const pl = window.__app.pov.player; return { y: +pl.pos.y.toFixed(2), inLiquid: pl.inLiquid, head: pl.headInLiquid, breath: +pl.breath.toFixed(2)}; });
check('in the pool', swim.inLiquid, JSON.stringify(swim));
await shot('underwater');
const b0 = await named(await census());
await click('left', 200);
await settle(600);
const bucketStatus = await status();
const b1 = await named(await census());
check('bucket scooped water', (b0.WATER ?? 0) - (b1.WATER ?? 0) > 10, `${(b0.WATER ?? 0) - (b1.WATER ?? 0)} cells; hotbar: ${bucketStatus}`);

// ---- third person, then out
await p.keyboard.press('f');
await settle(1000);
await shot('third-person');
await p.keyboard.press('f');
await p.keyboard.press('v');
await p.waitForFunction(() => window.__app.pov.mode === 'off', null, { timeout: 10000 }).catch(() => {});
check('popped out', (await ev(() => window.__app.pov.mode)) === 'off');

console.log(errs.length ? `console errors:\n  ${[...new Set(errs)].slice(0, 8).join('\n  ')}` : 'no console errors');
console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
await b.close();
process.exit(fails ? 1 : 0);

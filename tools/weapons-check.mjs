// Weapons and inventory end-to-end check (docs/pov.md "Inventory", "Guns"):
// the slot bar and its cycling, tools given from the palette, the pistol's
// click-rate fire, the SMG's spray, the sniper's scope and penetration, the
// rocket's blast, and that no shot adds matter to the world.
// usage: node tools/weapons-check.mjs [--port 5371] [--shots dir]   (needs a dev server)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5371');
const shots = opt('shots', null);
const W = 960, H = 600;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 500)));
await p.addInitScript(() => { try { localStorage.removeItem('tpt3d.pov.given'); } catch { /* */ } });
await p.goto(`http://localhost:${port}/?preset=empty`);
await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
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
const GASES = new Set(['EMPTY', 'FIRE', 'SMOKE', 'STEAM', 'CLOUD']);
const matter = (c) => Object.entries(c).filter(([k]) => !GASES.has(k)).reduce((s, [, n]) => s + n, 0);
const click = async (button = 'left') => { await p.mouse.down({ button }); await wait(40); await p.mouse.up({ button }); };
const fires = () => ev(() => window.__fires.length);

// the palette's Tools group lists every first-person tool
const tiles = await ev(() => [...document.querySelectorAll('.dock .tile')].filter((t) => +t.dataset.id <= -300).length);
check('palette Tools group lists the tools', tiles === 13, `${tiles} tiles`);
// given from the god view: it waits in the inventory
await ev(() => document.querySelector('.dock .tile[data-id="-306"]').click());   // SMG
const given = await ev(async () => (await import('/src/pov/tools/inventory.js')).inventory.owned);
check('SMG given from the palette', given.includes('SMG'), given.join(' '));

await ev(async () => {
  const { povEvents } = await import('/src/pov/events.js');
  window.__fires = []; window.__blasts = [];
  povEvents.on('gun:fire', (x) => window.__fires.push({ gun: x.gun, t: performance.now() }));
  povEvents.on('blast', (x) => window.__blasts.push(x.point));
});
await p.mouse.move(W / 2, H / 2);
await p.keyboard.press('f');
await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 20000 }).catch(() => {});
check('dropped in', (await ev(() => window.__app.pov.mode)) === 'on');
await ev(() => { window.__app.pov.test.assumeLocked = true; });
const held = () => ev(() => window.__app.pov.toolbelt.selectedKey);
check('SMG given before the drop-in is in hand', (await held()) === 'SMG', await held());
const slots = await ev(() => document.querySelectorAll('.hotbar .hb-slot').length);
check('five slots on the bar', slots === 5, `${slots}`);

// slot keys: 1 then 1 again steps through Dig; 3 cycles the guns
await p.keyboard.press('1'); const k1 = await held();
await p.keyboard.press('1'); const k1b = await held();
check('key 1 picks Dig, again steps to the next in it', k1 === 'SHOVEL' && k1b === 'PICKAXE', `${k1} → ${k1b}`);
await ev(async () => { const { inventory } = await import('/src/pov/tools/inventory.js'); inventory.give('SNIPER'); inventory.give('ROCKET'); });
check('a tool given in first person goes in hand', (await held()) === 'ROCKET', await held());
await p.keyboard.press('3'); const g1 = await held();
await p.keyboard.press('3'); const g2 = await held();
await p.keyboard.press('3'); const g3 = await held();
await p.keyboard.press('3'); const g4 = await held();
// the sniper was last in hand in Guns (given): 3 goes back to it, then on round the slot
check('key 3 returns to the last gun, then cycles the slot', [g1, g2, g3, g4].join() === 'SNIPER,GUN,SMG,SNIPER', [g1, g2, g3, g4].join());
const hold = (key) => ev((k) => window.__app.pov.toolbelt.select(k), key);
const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => (a[k] ?? 0) !== (b[k] ?? 0)).map((k) => `${k} ${a[k] ?? 0}→${b[k] ?? 0}`).join(', ');

// the range: a glass pane 30 cells out, a wood plank and a thick rock wall behind
await ev(async () => {
  const a = window.__app, { E } = await import('/src/elements.js'), V = a.camera.position.constructor;
  a.sim.paint({ center: new V(50, 6, 64.5), radius: 3, shape: 1, tool: E.GLASS, rate: 1, replace: true });
  a.pov.player.spawn(new V(20, 0, 64.5));
  a.pov.setLook(-Math.PI / 2, 0.05);
});
await wait(1500);

for (const k of ['GUN', 'SNIPER', 'ROCKET']) { await hold(k); await wait(500); await shot(`held-${k}`); }
// pistol: one click breaks glass and adds nothing
await hold('GUN');
await wait(300);
let c0 = await census();
await click();
await wait(1500);
let c1 = await census();
check('pistol breaks glass', (c1.SHARDS ?? 0) > (c0.SHARDS ?? 0), `GLASS ${c0.GLASS}→${c1.GLASS}, SHARDS ${c0.SHARDS ?? 0}→${c1.SHARDS ?? 0}`);
check('pistol adds no matter', matter(c1) === matter(c0) && (c1.SCRAP ?? 0) === (c0.SCRAP ?? 0), diff(c0, c1));

// pistol: as fast as you click (8 clicks 110 ms apart), slower held
await wait(1600);   // accuracy back
let n0 = await fires();
for (let i = 0; i < 8; i++) { await click(); await wait(70); }
let n1 = await fires();
check('pistol fires every click', n1 - n0 === 8, `${n1 - n0} of 8`);
await wait(1600);
n0 = await fires();
await p.mouse.down(); await wait(1150); await p.mouse.up();
n1 = await fires();
check('pistol held fires slower (HL2: 0.5 s)', n1 - n0 === 3, `${n1 - n0} in 1.15 s`);

// SMG: about 13 a second held
await hold('SMG');
await wait(300);
n0 = await fires();
await p.mouse.down(); await wait(1000); await p.mouse.up();
n1 = await fires();
check('SMG sprays ~13/s held', n1 - n0 >= 10 && n1 - n0 <= 15, `${n1 - n0} in 1 s`);
await shot('smg');

// sniper: scope, and a round through 5 cells of rock
await hold('SNIPER');
await wait(300);
await ev(async () => {
  const a = window.__app, { E } = await import('/src/elements.js'), V = a.camera.position.constructor;
  a.sim.paint({ center: new V(60, 6, 64.5), radius: 2.5, shape: 1, tool: E.ROCK, rate: 1, replace: true });
  a.sim.paint({ center: new V(64, 6, 64.5), radius: 2.5, shape: 1, tool: E.ROCK, rate: 1, replace: true });
});
await wait(800);
const fov0 = await ev(() => window.__app.camera.fov);
await click('right');
await wait(500);
const fov1 = await ev(() => window.__app.camera.fov);
check('sniper scopes in on right-click', fov1 < fov0 / 3, `fov ${fov0.toFixed(1)} → ${fov1.toFixed(1)}`);
await shot('scoped');
c0 = await census();
await click();
await wait(1500);
c1 = await census();
const rockGone = (c0.ROCK ?? 0) - (c1.ROCK ?? 0);
check('sniper bores through rock (after the glass and its shards)', rockGone >= 6, `ROCK ${c0.ROCK}→${c1.ROCK}, STONE ${c0.STONE ?? 0}→${c1.STONE ?? 0}`);
check('sniper adds no matter', matter(c1) === matter(c0), diff(c0, c1));
await click('right');
await wait(400);

// rocket: a crater in the rock, a blast, no matter added
await ev(() => { const a = window.__app, V = a.camera.position.constructor; a.sim.paint({ center: new V(50, 6, 64.5), radius: 4, shape: 1, tool: -1, rate: 1, replace: true }); });   // the pane's gone
await wait(500);
await p.keyboard.press('4');
check('key 4 goes back to the rocket launcher (last in hand there)', (await held()) === 'ROCKET', await held());
await wait(300);
c0 = await census();
const h0 = await ev(() => window.__app.pov.player.health);
await click();
await wait(250);
await shot('rocket');
await wait(2000);
c1 = await census();
const blasts = await ev(() => window.__blasts.length);
check('rocket goes off', blasts >= 1, `${blasts} blast(s)`);
check('rocket breaks rock', (c0.ROCK ?? 0) - (c1.ROCK ?? 0) >= 20, `ROCK ${c0.ROCK}→${c1.ROCK}, STONE ${c0.STONE ?? 0}→${c1.STONE ?? 0}`);
check('rocket adds no matter', matter(c1) === matter(c0), diff(c0, c1));
const h1 = await ev(() => window.__app.pov.player.health);
console.log(`     health after a rocket ~40 cells off: ${h0.toFixed(2)} → ${h1.toFixed(2)}`);

// a rocket at your feet: thrown, and what it costs
await wait(1000);
await ev(() => { const a = window.__app; a.pov.player.spawn(a.pov.player.pos.clone().setX(30)); a.pov.setLook(-Math.PI / 2, -1.0); });
await wait(1200);
await ev(() => { window.__hurt = {}; window.__app.pov.player.on('hurt', ({ amount, cause }) => { window.__hurt[cause] = (window.__hurt[cause] ?? 0) + amount; }); });
const before = await ev(() => ({ y: window.__app.pov.player.pos.y, h: window.__app.pov.player.health }));
await click();
let peakY = before.y;
for (let i = 0; i < 20; i++) { await wait(60); peakY = Math.max(peakY, await ev(() => window.__app.pov.player.pos.y)); }
const after = await ev(() => ({ h: window.__app.pov.player.health, dead: window.__app.pov.player.dead }));
console.log(`     rocket at the feet: rose ${(peakY - before.y).toFixed(1)} cells, health ${before.h.toFixed(2)} → ${after.h.toFixed(2)}${after.dead ? ' (dead)' : ''}`);
console.log(`     its damage by cause: ${JSON.stringify(await ev(() => window.__hurt))}`);
await shot('rocket-jump');

// Q opens the tools menu
await ev(() => { if (window.__app.pov.player.dead) window.__app.pov.player.spawn(window.__app.pov.player.pos.clone()); });
await p.keyboard.press('q');
await wait(200);
const menu = await ev(() => document.body.classList.contains('pov-menu'));
check('Q opens the tools menu', menu);
await shot('menu');
await p.keyboard.press('q');

const real = errs.filter((e) => !e.startsWith('Failed to load resource'));   // the dev server has no API (functions/)
check('no errors', real.length === 0, real.slice(0, 5).join(' | '));
console.log(fails ? `${fails} FAILED` : 'all ok');
await b.close();
process.exit(fails ? 1 : 0);

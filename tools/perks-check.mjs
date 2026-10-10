// End-to-end check of the perks (src/pov/perks.js, src/perkOrbs.js) through the
// real shell, body and toolbelt: the palette's Perks group, walking into orbs,
// stacking, the HUD row, a shrine, Faster Tools on a real tool, the Freeze
// Field, Lukki, Sand Swimmer and Revenge Explosion.
// usage: node tools/perks-check.mjs [--port 5291] [--shot file.jpg]   (needs a dev server)
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5291');
const shotPath = opt('shot', null);
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
const settle = (ms) => p.waitForTimeout(ms);

try {
  await p.goto(`http://localhost:${port}/?size=128&preset=empty`);
  await p.waitForFunction(() => window.__app?.pov && window.__app?.perkOrbs, null, { timeout: 30000 });
  await settle(1500);

  // ---- the palette
  const tiles = await ev(() => {
    const g = [...document.querySelectorAll('.group')].find((x) => x.querySelector('h4')?.textContent === 'Perks');
    return g ? [...g.querySelectorAll('.tile')].map((t) => t.getAttribute('aria-label')) : null;
  });
  check('palette has a Perks group', !!tiles && tiles.length === 13, tiles?.join(', '));

  // ---- drop in
  await p.mouse.move(W / 2, H / 2);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 15000 }).catch(() => {});
  await ev(() => { window.__app.pov.test.assumeLocked = true; });
  check('dropped in', (await ev(() => window.__app.pov.mode)) === 'on');

  const V = (x, y, z) => ({ x, y, z });
  const stand = (x, z, y = 0) => ev(([x, y, z]) => { const a = window.__app; a.pov.player.spawn(a.pov.player.pos.clone().set(x, y, z)); }, [x, y, z]);
  const orb = (key, x, z, y = 0) => ev(([key, x, y, z]) => { const a = window.__app; a.perkOrbs.add(key, a.pov.player.pos.clone().set(x, y, z)); }, [key, x, y, z]);
  const perks = () => ev(() => Object.fromEntries(window.__app.pov.player.perks.list().map(({ perk, n }) => [perk.key, n])));

  // ---- walking into orbs, stacking
  await stand(20, 20);
  await settle(400);
  await orb('FASTER_TOOLS', 20, 20);
  await settle(300);
  check('walking into an orb takes it', (await perks()).FASTER_TOOLS === 1, JSON.stringify(await perks()));
  check('the orb is gone', (await ev(() => window.__app.perkOrbs.list.length)) === 0);
  await orb('FASTER_TOOLS', 20, 20);
  await settle(300);
  check('a second one stacks', (await perks()).FASTER_TOOLS === 2);
  check('tool speed 4x after two', (await ev(() => window.__app.pov.ctx.toolRate)) === 4);
  const hud = await ev(() => [...document.querySelectorAll('.pov-perk')].map((e) => e.textContent));
  check('HUD shows the perk with its stacks', hud.length === 1 && hud[0].includes('×2'), JSON.stringify(hud));

  // ---- Faster Tools on a real tool: axe swings in 2 s held, with 4x vs none
  await ev(() => { window.__swings = 0; window.__app.pov.events.on('tool:action', (e) => { if (e.action === 'swing' && !e.by) window.__swings++; }); });
  const swings = async () => {
    await ev(() => window.__app.pov.toolbelt.select('AXE'));
    await settle(200);
    await ev(() => { window.__swings = 0; });
    await p.mouse.down();
    await settle(2000);
    await p.mouse.up();
    return ev(() => window.__swings);
  };
  const fast = await swings();
  await ev(() => window.__app.pov.player.perks.clear());
  const slow = await swings();
  check('Faster Tools: 4x the axe swings', fast >= slow * 3, `${fast} swings at 4x vs ${slow} at 1x in 2 s`);

  // ---- a shrine: take one, the others vanish
  await stand(60, 20);
  await settle(300);
  await ev(() => { const a = window.__app; a.perkOrbs.shrine(a.pov.player.pos.clone().set(60, 0, 30), new a.camera.position.constructor(1, 0, 0)); });
  check('a shrine sets three orbs', (await ev(() => window.__app.perkOrbs.list.length)) === 3);
  if (shotPath) {
    await ev(() => { const a = window.__app; a.pov.player.spawn(a.pov.player.pos.clone().set(60, 0, 20)); a.pov.setLook(Math.PI, -0.15); });
    await settle(800);
    await p.screenshot({ path: shotPath, type: 'jpeg', quality: 70 });
  }
  const before = await perks();
  await stand(60, 30);
  await settle(400);
  const after = await perks();
  check('taking one shrine orb takes one perk, the rest vanish', Object.keys(after).length >= Object.keys(before).length + 1 && (await ev(() => window.__app.perkOrbs.list.length)) === 0, JSON.stringify(after));
  await ev(() => window.__app.pov.player.perks.clear());

  // ---- Freeze Field: a pool of water freezes under you
  const census = () => ev(async () => { const { E } = await import('/src/elements.js'); const c = window.__app.sim.census(); return { water: c[E.WATER]?.n ?? 0, ice: c[E.ICE]?.n ?? 0, sand: c[E.SAND]?.n ?? 0 }; });
  await ev(async () => {
    const { E } = await import('/src/elements.js');
    const a = window.__app, C = a.camera.position.constructor;
    for (let i = 0; i < 3; i++) a.sim.paint({ center: new C(100, 1.5, 100), radius: 6, shape: 1, tool: E.WATER, rate: 1, replace: false });
  });
  await settle(1500);
  const c0 = await census();
  await stand(100, 100, 6);
  await orb('FREEZE_FIELD', 100, 100, 6);
  await settle(2500);
  const c1 = await census();
  check('Freeze Field turns water to ice', c1.ice > c0.ice + 50, `ice ${c0.ice} → ${c1.ice}, water ${c0.water} → ${c1.water}`);
  await ev(() => window.__app.pov.player.perks.clear());

  // ---- Lukki: the jet holds its tank against a wall
  await ev(async () => {
    const { E } = await import('/src/elements.js');
    const a = window.__app, C = a.camera.position.constructor;
    // a wall the full height of the box, so the climb never tops it
    for (const y of [18, 54, 90, 126]) a.sim.paint({ center: new C(30.5, y, 100.5), radius: 18, shape: 1, tool: E.WALL, rate: 1, replace: false });
  });
  const climb = async (lukki) => {
    await ev(() => window.__app.pov.player.perks.clear());
    if (lukki) await ev(() => window.__app.pov.player.perks.add('LUKKI'));
    await stand(50, 100.5, 0);   // the wall's face is at x = 49
    await ev(() => window.__app.pov.setLook(Math.PI / 2, 0));   // facing -x, the wall
    await settle(500);
    await p.keyboard.down('KeyW');
    await p.keyboard.press('Space');
    await settle(100);
    await p.keyboard.down('Space');
    await settle(2500);
    const r = await ev(() => ({ y: window.__app.pov.player.pos.y, fuel: window.__app.pov.player.jetFuel }));
    await p.keyboard.up('Space');
    await p.keyboard.up('KeyW');
    return r;
  };
  const plain = await climb(false);
  const lukki = await climb(true);
  check('Lukki: the tank holds against a wall', lukki.fuel > 0.95 && plain.fuel < 0.5, `fuel ${plain.fuel.toFixed(2)} without, ${lukki.fuel.toFixed(2)} with; height ${plain.y.toFixed(1)} vs ${lukki.y.toFixed(1)}`);
  await settle(1500);

  // ---- Sand Swimmer: inside a sand blob, the body swims instead of being stuck
  await ev(async () => {
    const { E } = await import('/src/elements.js');
    const a = window.__app, C = a.camera.position.constructor;
    for (let i = 0; i < 6; i++) a.sim.paint({ center: new C(100, 6, 40), radius: 6, shape: 1, tool: E.SAND, rate: 1, replace: true });
  });
  await settle(1500);
  await ev(() => { const pl = window.__app.pov.player; pl.perks.clear(); pl.perks.add('SAND_SWIMMER'); pl.perks.add('BREATHLESS'); });
  await stand(100, 40, 3);
  await settle(1500);
  const swim = await ev(() => { const pl = window.__app.pov.player; return { inLiquid: pl.inLiquid, liquid: pl.liquidId, y: pl.pos.y, health: pl.health }; });
  check('Sand Swimmer: in sand counts as swimming', swim.inLiquid, JSON.stringify(swim));

  // ---- Revenge Explosion: a hurt sets off a blast around you
  await ev(() => { window.__blasts = 0; window.__app.pov.events.on('blast', () => window.__blasts++); });
  await ev(() => { const pl = window.__app.pov.player; pl.perks.clear(); pl.perks.add('REVENGE_EXPLOSION'); pl.perks.add('EXPLOSION_IMMUNITY'); });
  await stand(20, 100);
  await settle(500);
  await ev(() => window.__app.pov.player.hurt(0.05, 'test'));
  await settle(300);
  const rv = await ev(() => ({ blasts: window.__blasts, health: window.__app.pov.player.health }));
  check('Revenge Explosion goes off when hurt', rv.blasts === 1, JSON.stringify(rv));

  // ---- death takes the perks
  await ev(() => window.__app.pov.player.hurt(5, 'test'));
  await settle(200);
  check('death takes the perks', (await ev(() => window.__app.pov.player.perks.list().length)) === 0);
} catch (err) {
  fails++;
  console.log('FAIL threw', String(err).slice(0, 500));
}

check('no console errors', errs.length === 0, errs.slice(0, 4).join(' || '));
await b.close();
console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);

// End-to-end check of the perks (src/pov/perks.js, src/perkOrbs.js) through the
// real shell, body and toolbelt: the Shrine construction, walking into orbs,
// stacking, the HUD row, Faster Tools on a real tool, the Freeze Field, Lukki,
// Sand Swimmer, Revenge Explosion, Slow Fall, Shrink, Night Vision, Rain Cloud (the CLOUD element on
// the GPU), and the shrine every world gets.
// usage: node tools/perks-check.mjs [--port 5291] [--shot file.jpg] [--worldshot file.jpg]
//        [--nvshot prefix] [--rainshot file.jpg]   (needs a dev server; the night-vision shots are
//        prefix-off.jpg and prefix-on.jpg; ImageMagick measures their brightness)
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5291');
const shotPath = opt('shot', null);
const worldShot = opt('worldshot', null);
const nvShot = opt('nvshot', join(tmpdir(), 'perks-nv'));
const rainShot = opt('rainshot', null);
const meanGray = (f) => +execFileSync('magick', [f, '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:']).toString();
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

  // ---- the palette: a Shrine among the constructions, no loose perks
  // (the material drawer: one category button per palette group, every tile in one swatch list)
  const pal = await ev(() => ({
    groups: [...document.querySelectorAll('.material-category')].map((b) => b.getAttribute('aria-label')),
    shrine: [...document.querySelectorAll('.material-swatch')].some((t) => /^Shrine\b/.test(t.title)),
  }));
  check('Shrine is a construction, no Perks group', pal.shrine && pal.groups.includes('Constructions') && !pal.groups.includes('Perks'), JSON.stringify(pal.groups));

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

  const setPerks = (keys) => ev((keys) => { const pl = window.__app.pov.player; pl.perks.clear(); keys.forEach((k) => pl.perks.add(k)); }, keys);
  // cells set straight into the state: [x0, x1, y0, y1, z0, z1, element key] boxes, inclusive
  const build = (boxes) => ev(async (boxes) => {
    const { E } = await import('/src/elements.js');
    const sim = window.__app.sim;
    const [a, b] = sim.readState();
    for (const [x0, x1, y0, y1, z0, z1, key] of boxes)
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const i = sim.cellTexel(x, y, z) * 4;
        a[i] = E[key]; a[i + 1] = 20; a[i + 2] = 0; b[i] = b[i + 1] = b[i + 2] = 0;
      }
    sim.load(a, b);
  }, boxes);
  // cells of each element key in a box (inclusive)
  const countIn = (box, keys) => ev(async ([[x0, x1, y0, y1, z0, z1], keys]) => {
    const { E } = await import('/src/elements.js');
    const sim = window.__app.sim;
    const [a] = sim.readState();
    const out = Object.fromEntries(keys.map((k) => [k, 0]));
    for (let x = Math.max(0, x0); x <= Math.min(sim.g.nx - 1, x1); x++)
      for (let y = Math.max(0, y0); y <= Math.min(sim.g.ny - 1, y1); y++)
        for (let z = Math.max(0, z0); z <= Math.min(sim.g.nz - 1, z1); z++) {
          const id = Math.round(a[sim.cellTexel(x, y, z) * 4]);
          for (const k of keys) if (id === E[k]) out[k]++;
        }
    return out;
  }, [box, keys]);
  const where = () => ev(() => { const pl = window.__app.pov.player; return { x: pl.pos.x, y: pl.pos.y, z: pl.pos.z, h: pl.height }; });

  // ---- Slow Fall: a long drop lands at a parachute's pace (landings never hurt; 'land' reports the speed)
  await ev(() => { window.__land = null; window.__app.pov.player.on('land', (e) => { window.__land = e.speed; }); });
  const dropLand = async (keys) => {
    await setPerks(keys);
    await ev(() => { window.__land = null; });
    await stand(100, 20, 110);
    await p.waitForFunction(() => window.__land !== null, null, { timeout: 30000 }).catch(() => {});
    return ev(() => window.__land);
  };
  const landPlain = await dropLand([]);
  const landSlow = await dropLand(['SLOW_FALL']);
  check('Slow Fall: lands at a parachute\'s 19 cells/s (5.8 m/s), not Noita\'s 175', landSlow > 15 && landSlow < 21 && landPlain > 100,
    `landing speed ${landPlain?.toFixed(1)} plain, ${landSlow?.toFixed(1)} with Slow Fall (cells/s)`);

  // ---- Shrink: a crack 2 cells wide and 3 tall in a wall; the plain body stops, the shrunk one goes through
  await build([[110, 110, 0, 24, 44, 84, 'WALL'], [110, 110, 0, 2, 64, 65, 'EMPTY']]);
  const throughCrack = async (keys) => {
    await setPerks(keys);
    await stand(105, 65, 0);
    await ev(() => window.__app.pov.setLook(-Math.PI / 2, 0));   // facing +x
    await settle(500);
    await p.keyboard.down('KeyW');
    await settle(3000);
    await p.keyboard.up('KeyW');
    return where();
  };
  const crackPlain = await throughCrack([]);
  const crackSmall = await throughCrack(['SHRINK']);
  check('Shrink: the body is half the size', Math.abs(crackSmall.h - 2.75) < 1e-6, `height ${crackSmall.h} cells`);
  check('Shrink: the plain body stops at the crack, the shrunk one gets through', crackPlain.x < 110 && crackSmall.x > 111.5,
    `x ${crackPlain.x.toFixed(2)} plain, ${crackSmall.x.toFixed(2)} shrunk (wall at 110)`);
  await setPerks([]);

  // ---- Night Vision: a walled cave lit only through a small hole in its roof
  await build([[4, 26, 0, 12, 40, 62, 'WALL'], [6, 24, 0, 10, 42, 60, 'EMPTY'], [22, 23, 11, 12, 58, 59, 'EMPTY']]);
  await stand(10, 46, 0);
  await ev(() => window.__app.pov.setLook(-Math.PI * 0.75, 0.1));   // toward the far corner, where the light comes in
  await settle(2500);
  const nvOff = await ev(() => ({ luma: window.__app.post.sceneLuma, night: window.__app.post.settings.night }));
  await p.screenshot({ path: `${nvShot}-off.jpg`, type: 'jpeg', quality: 80 });
  await setPerks(['NIGHT_VISION']);
  await settle(2500);
  const nvOn = await ev(() => { const s = window.__app.post.settings; return { luma: window.__app.post.sceneLuma, night: s.night, gain: s.nightGain }; });
  await p.screenshot({ path: `${nvShot}-on.jpg`, type: 'jpeg', quality: 80 });
  const gOff = meanGray(`${nvShot}-off.jpg`), gOn = meanGray(`${nvShot}-on.jpg`);
  check('Night Vision: switches itself on in the dark cave', nvOn.night > 0.9 && nvOn.gain > 4 && nvOff.night === 0, `${JSON.stringify(nvOff)} → ${JSON.stringify(nvOn)}`);
  // (the eyes already adapt to the dark without goggles, post.js ADAPT, so the bare view isn't black: the goggles
  // still about double what it shows)
  const NV_BRIGHTER = 1.8;
  check('Night Vision: the frame is brighter', gOn > gOff * NV_BRIGHTER, `mean grey ${gOff.toFixed(3)} → ${gOn.toFixed(3)} (${nvShot}-off/on.jpg)`);
  await stand(64, 20, 0);   // back out in daylight
  await settle(2500);
  const nvDay = await ev(() => window.__app.post.settings.night);
  check('Night Vision: off again in daylight', nvDay < 0.05, `night ${nvDay.toFixed(3)}`);
  await setPerks([]);

  // ---- Rain Cloud: real CLOUD over the head that rains on the ground around you, and follows you
  await ev(() => window.__app.pov.player.perks.add('RAIN_CLOUD'));
  await stand(90, 64, 0);
  await ev(() => window.__app.pov.setLook(0, 0.35));
  await settle(8000);
  const at0 = await where();
  const box0 = [Math.floor(at0.x) - 7, Math.floor(at0.x) + 7, 0, 30, Math.floor(at0.z) - 7, Math.floor(at0.z) + 7];
  const rain0 = await countIn(box0, ['CLOUD', 'WATER']);
  const ground0 = await countIn([box0[0], box0[1], 0, 3, box0[4], box0[5]], ['WATER']);
  if (rainShot) {   // over the shoulder (V), the cloud over the body
    await ev(() => { window.__app.pov.camera.third = true; });
    await settle(1500);
    await p.screenshot({ path: rainShot, type: 'jpeg', quality: 80 });
    await ev(() => { window.__app.pov.camera.third = false; });
  }
  check('Rain Cloud: CLOUD over your head, and its rain on the ground', rain0.CLOUD > 100 && ground0.WATER > 0, `${JSON.stringify(rain0)} within 7 cells; ${ground0.WATER} water on the ground`);
  // walk away along −x for 3 s: the cloud comes along
  await ev(() => window.__app.pov.setLook(Math.PI / 2, 0));
  await p.keyboard.down('KeyW');
  await settle(3000);
  await p.keyboard.up('KeyW');
  await settle(1500);
  const at1 = await where();
  const near = await countIn([Math.floor(at1.x) - 7, Math.floor(at1.x) + 7, 0, 30, Math.floor(at1.z) - 7, Math.floor(at1.z) + 7], ['CLOUD']);
  const left = await countIn(box0, ['CLOUD']);
  check('Rain Cloud: it follows you', near.CLOUD > 100 && at0.x - at1.x > 10, `walked ${(at0.x - at1.x).toFixed(1)} cells: ${near.CLOUD} cloud over you, ${left.CLOUD} left behind`);
  await setPerks([]);
  const whole = await ev(async () => { const { E } = await import('/src/elements.js'); const c = window.__app.sim.census(); return { cloud: c[E.CLOUD]?.n ?? 0, water: c[E.WATER]?.n ?? 0 }; });
  console.log('     (whole box:', JSON.stringify(whole), ')');

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
  const altars = await ev(() => { const a = window.__app; return a.builds.stampAt('SHRINE', a.pov.player.pos.clone().set(60, 0, 30)).map((v) => v.toArray()); });
  await settle(300);
  check('a shrine sets three orbs', (await ev(() => window.__app.perkOrbs.list.length)) === 3, JSON.stringify(altars));
  const plinths = await ev(async (alt) => { const { ELEMENTS } = await import('/src/elements.js'); return alt.map(([x, y, z]) => ELEMENTS[Math.round(window.__app.sim.readCell(Math.floor(x), y - 1, Math.floor(z))[0][0])]?.key); }, altars);
  check('each orb floats over a steel-topped plinth', plinths.every((k) => k === 'METAL'), plinths.join(','));
  if (shotPath) {
    await ev(() => { const a = window.__app; a.pov.player.spawn(a.pov.player.pos.clone().set(60, 0, 20)); a.pov.setLook(Math.PI, -0.15); });
    await settle(800);
    await p.screenshot({ path: shotPath, type: 'jpeg', quality: 70 });
  }
  const before = await perks();
  await stand(60.5, 32.85);   // against the middle plinth's front
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

  // ---- every world gets a shrine near where the god view starts
  await ev(() => window.__app.pov.exit(true));
  await p.goto(`http://localhost:${port}/?size=world&scene=island`);
  await p.waitForFunction(() => window.__app?.win?.loaded && window.__app.perkOrbs?.list.length, null, { timeout: 90000 }).catch(() => {});
  await settle(1500);
  const w = await ev(async () => {
    const { ELEMENTS } = await import('/src/elements.js');
    const a = window.__app, o = a.sim.origin;
    return a.perkOrbs.list.map((orb) => {
      const f = orb.world.clone().sub(o);
      return { key: orb.key, at: f.toArray().map((v) => +v.toFixed(1)), under: ELEMENTS[Math.round(a.sim.readCell(Math.floor(f.x), f.y - 1, Math.floor(f.z))[0][0])]?.key };
    });
  });
  check('the world has a shrine with three perks on plinths', w.length === 3 && w.every((o) => o.under === 'METAL'), JSON.stringify(w));
  if (worldShot) { await settle(3000); await p.screenshot({ path: worldShot, type: 'jpeg', quality: 70 }); }
} catch (err) {
  fails++;
  console.log('FAIL threw', String(err).slice(0, 500));
}

check('no console errors', errs.length === 0, errs.slice(0, 4).join(' || '));
await b.close();
console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);

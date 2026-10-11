// Halo's arsenal check (src/game/arsenal.js, docs/modes.md "Halo rules"): a Team
// Slayer match in the lab, headless on the GPU, and we check
//
//   the equal start   one Energy Shield stack (full), SMG + pistol carried, the SMG in hand, two grenades
//   the hotbar        restricted to the carry: 2 and 1 swap the guns, nothing else can be selected, Q does nothing
//   bots              the same carry, shield and grenades; their brain's weapons are the carry
//   a pad pickup      look at the rocket launcher on its pad, press E: it replaces the SMG, which drops;
//                     four rockets fired and it's gone, the pistol in hand
//   the end           game.end() gives the hotbar back and clears the match's fields
//
// plus no page errors.
//
// usage: node tools/arsenal-check.mjs [--url http://localhost:5422]
// Needs AC power (GPU) and a dev server (npx vite --port 5422 --strictPort).
import { launchBrowser, newTestPage, ready } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const URL = opt('url', 'http://localhost:5422');
const W = 960, H = 600;
const SPAWN_WAIT_MS = 4000;          // the respawn swoop and the first frames of the match
const ROCKET_GAP_MS = 1100;          // between clicks: the launcher's 0.8 s refire and a margin
const ROCKETS = 4;                   // arsenal.js POWER.ROCKET.shots (2 + 2)
const FLOAT_UP = 2.4;                // arsenal.js: cells the weapon floats over its pad
const STAND_OFF = 4;                 // cells from the pad the player stands to look at it

const failures = [];
const check = (ok, what, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${got !== undefined ? ` (${JSON.stringify(got)})` : ''}`); if (!ok) failures.push(what); };

const browser = await launchBrowser();
try {
  const p = await newTestPage(browser, { mode: 'preview', viewport: { width: W, height: H } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 300)); });
  await p.goto(`${URL}/?preset=lab`, { timeout: 180000 });
  await ready(p);
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  await p.mouse.move(W * 0.5, H * 0.62);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });
  await p.evaluate(() => { window.__app.pov.test.assumeLocked = true; });

  // a small match: two a side counting the player (on red), so it's quiet while we check
  await p.evaluate(() => window.__app.pov.game.start('slayer', { side: 'red', teamSize: 2 }));
  await p.waitForTimeout(SPAWN_WAIT_MS);
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });

  // ---- the equal start
  const start = await p.evaluate(() => {
    const pov = window.__app.pov, b = pov.player, tb = pov.toolbelt;
    return { carry: b.carry, grenades: b.grenades, shields: b.perks.count('ENERGY_SHIELD'), shield: b.shield, shieldMax: b.shieldMax,
      restricted: tb.restricted, held: tb.selectedKey };
  });
  check(start.carry?.join() === 'SMG,GUN', 'player carries the SMG and the pistol', start.carry);
  check(start.grenades === 2, 'player has two grenades', start.grenades);
  check(start.shields === 1 && start.shield >= start.shieldMax - 1e-6 && start.shieldMax > 1.5, 'one shield stack, full', [start.shield, start.shieldMax]);
  check(start.restricted?.join() === 'SMG,GUN', 'hotbar restricted to the carry', start.restricted);
  check(start.held === 'SMG', 'the SMG in hand', start.held);

  // ---- the hotbar: 2 / 1 swap the guns, nothing else goes in hand, Q does nothing
  await p.keyboard.press('2');
  const two = await p.evaluate(() => window.__app.pov.toolbelt.selectedKey);
  await p.keyboard.press('1');
  const one = await p.evaluate(() => window.__app.pov.toolbelt.selectedKey);
  check(two === 'GUN' && one === 'SMG', '2 holds the pistol, 1 the SMG', [two, one]);
  const shovel = await p.evaluate(() => window.__app.pov.toolbelt.select('SHOVEL'));
  check(shovel === false, 'the shovel can\'t be selected', shovel);
  await p.keyboard.press('q');
  await p.waitForTimeout(300);
  const menu = await p.evaluate(() => document.body.classList.contains('pov-menu'));
  check(!menu, 'Q opens no spawn menu', menu);

  // ---- bots: the same start, and their brain's weapons
  const bots = await p.evaluate(() => window.__app.pov.game.bots.map((n) => ({
    id: n.id, carry: n.body.carry, grenades: n.body.grenades, shields: n.body.perks.count('ENERGY_SHIELD'),
    weapons: n.agent.weapons ? [...n.agent.weapons] : null,
  })));
  check(bots.length > 0, 'bots in the match', bots.length);
  for (const b of bots) {
    check(b.carry?.join() === 'SMG,GUN' && b.grenades === 2 && b.shields === 1, `bot ${b.id}: carry, grenades, shield`, b);
    check(b.weapons?.join() === 'SMG,GUN' || (b.carry && b.weapons?.join() === b.carry.join()), `bot ${b.id}: weapons are its carry`, b.weapons);
  }

  // ---- a pad pickup: stand by the rocket launcher, look at it, press E
  const pad = await p.evaluate(() => window.__app.pov.game.arsenal.pads.find((x) => x.key === 'ROCKET'));
  check(pad?.ready, 'the lab has a ready rocket pad', pad);
  if (pad) {
    await p.evaluate(({ at, up, off }) => {
      const pov = window.__app.pov, b = pov.player;
      b.teleport(b.pos.clone().set(at[0] + off, at[1], at[2]));
      const eyeY = at[1] + b.eyeHeight, dx = -off, dy = at[1] + up - eyeY, dz = 0;
      pov.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    }, { at: pad.at, up: FLOAT_UP, off: STAND_OFF });
    await p.waitForTimeout(500);
    const focus = await p.evaluate(() => { const f = window.__app.pov.interact.focus; return f ? { title: f.title, verb: f.verb, lines: f.lines } : null; });
    check(focus?.title === 'Rocket launcher' && /drops SMG/.test(focus.verb), 'the prompt names it and what it drops', focus);
    await p.keyboard.press('e');
    await p.waitForTimeout(300);
    const took = await p.evaluate(() => {
      const pov = window.__app.pov, a = pov.game.arsenal;
      return { carry: pov.player.carry, held: pov.toolbelt.selectedKey, shots: a.holds.player?.ROCKET, drops: a.drops.map((d) => d.key), ready: a.pads.find((x) => x.key === 'ROCKET').ready };
    });
    check(took.carry?.join() === 'ROCKET,GUN' && took.held === 'ROCKET', 'the rocket launcher in place of the SMG', took);
    check(took.shots === ROCKETS && took.drops.includes('SMG') && !took.ready, 'four rockets, the SMG dropped, the pad empty', took);

    // fire them all, up into the air
    await p.evaluate(() => window.__app.pov.setLook(0, 0.7));
    for (let i = 0; i < ROCKETS; i++) {
      await p.mouse.click(W / 2, H / 2);
      await p.waitForTimeout(ROCKET_GAP_MS);
    }
    const spent = await p.evaluate(() => ({ carry: window.__app.pov.player.carry, held: window.__app.pov.toolbelt.selectedKey, holds: window.__app.pov.game.arsenal.holds.player ?? null }));
    check(spent.carry?.join() === 'GUN' && spent.held === 'GUN', 'spent: the launcher gone, the pistol in hand', spent);
  }

  // ---- the end gives everything back
  await p.evaluate(() => window.__app.pov.game.end());
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => ({ restricted: window.__app.pov.toolbelt.restricted, carry: window.__app.pov.player.carry, grenades: window.__app.pov.player.grenades,
    shields: window.__app.pov.player.perks.count('ENERGY_SHIELD'), shovel: window.__app.pov.toolbelt.select('SHOVEL') }));
  check(after.restricted === null && after.carry === null && after.grenades === null && after.shovel === true, 'the end: the hotbar back, the fields off', after);
  check(after.shields === 0, 'the end: the match\'s shield taken back', after.shields);

  check(!errs.length, 'no page errors', errs.slice(0, 5));
} finally {
  await browser.close();
}
if (failures.length) { console.log(`${failures.length} failed`); process.exitCode = 1; } else console.log('all passed');

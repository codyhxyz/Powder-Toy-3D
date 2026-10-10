// End-to-end check of the classes (src/pov/classes.js) and the class picker
// (src/pov/classPicker.js) through the real shell, body and toolbelt: comma
// opens the picker in first person (and still opens settings in the god view),
// a pick made out of the respawn room waits for the next spawn, Pyro brings
// Fire Immunity and the blowtorch in hand, a class change in the respawn room
// takes the old class's perks and keeps the shrine's, and keys this build
// doesn't have are skipped without a throw.
// usage: node tools/classes-check.mjs [--port 5403] [--shot file.jpg]   (needs a dev server; AC power)
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = opt('port', '5403');
const shotPath = opt('shot', null);
const SHOT_W = 1000;                       // px wide the screenshot is shrunk to
const W = 1100, H = 700;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
await p.addInitScript(() => { try { localStorage.removeItem('tpt3d.pov.class'); } catch { /* */ } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const ev = (fn, arg) => p.evaluate(fn, arg);
const settle = (ms) => p.waitForTimeout(ms);
const state = () => ev(() => {
  const a = window.__app, pl = a.pov.player;
  return {
    cls: pl.cls ?? null, chosen: a.pov.classes.chosen, open: a.pov.classes.isOpen, inRoom: a.pov.classes.inRoom,
    held: a.pov.toolbelt?.selectedKey ?? null, mode: a.pov.mode, dead: pl.dead,
    perks: Object.fromEntries(pl.perks.list().map(({ perk, n }) => [perk.key, n])),
    settings: !!document.querySelector('.drawer[aria-label="Settings"].open'),
  };
});

try {
  await p.goto(`http://localhost:${port}/?size=128&preset=empty`);
  await p.waitForFunction(() => window.__app?.pov && window.__app?.perkOrbs, null, { timeout: 30000 });
  await settle(1500);

  // ---- drop in
  await p.mouse.move(W / 2, H / 2);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 15000 }).catch(() => {});
  await ev(() => { window.__app.pov.test.assumeLocked = true; });
  check('dropped in', (await state()).mode === 'on');
  check('the picker exists', await ev(() => !!window.__app.pov.classes));

  // ---- comma opens the picker (not settings) in first person
  await p.mouse.move(W - 20, H - 20);   // the cursor off the cards (it would focus one)
  await p.keyboard.press(',');
  await settle(300);
  let s = await state();
  check('comma opens the picker', s.open && await ev(() => !document.querySelector('.cp').hidden));
  check('comma does not open settings in first person', !s.settings);
  const ui = await ev(() => ({
    cards: document.querySelectorAll('.cp-card').length,
    names: [...document.querySelectorAll('.cp-name')].map((e) => e.textContent),
    soon: [...document.querySelectorAll('.cp-item.soon')].map((e) => e.title.split(':')[0]),
    bars: document.querySelectorAll('.cp-stat i').length,
    icons: document.querySelectorAll('.cp-tool img').length,
  }));
  check('seven class cards', ui.cards === 7, ui.names.join(', '));
  check('four bars a card', ui.bars === 28);
  check('tool sprites on the cards', ui.icons >= 7, `${ui.icons}`);
  check('missing tools and perks shown as coming soon', ui.soon.length > 0, ui.soon.join(', '));
  await p.waitForFunction(() => document.querySelectorAll('.cp-card.drawn').length === 7, null, { timeout: 15000 }).catch(() => {});
  check('all seven portraits drawn', (await ev(() => document.querySelectorAll('.cp-card.drawn').length)) === 7);
  // the digits are the picker's while it's open, not the hotbar's
  const heldBefore = (await state()).held;
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('ArrowRight');
  await settle(450);
  check('arrows move the focus', await ev(() => document.querySelector('.cp-card.focus')?.dataset.key === 'BULWARK'));
  await p.keyboard.press('Escape');
  await settle(200);
  s = await state();
  check('Esc closes it, nothing changes', !s.open && s.cls === null && s.chosen === null && s.held === heldBefore, JSON.stringify(s));

  // ---- out of the respawn room: a pick waits for the next spawn
  await p.waitForFunction(() => !window.__app.pov.classes.inRoom, null, { timeout: 15000 });
  await p.keyboard.press(',');
  await settle(200);
  await p.keyboard.press('7');
  await settle(200);
  s = await state();
  check('7 picks Pyro and closes', !s.open && s.chosen === 'PYRO', JSON.stringify(s));
  check('...but not yet (out of the respawn room)', s.cls === null && !s.perks.FIRE_IMMUNITY);

  // ---- die and respawn as Pyro
  await ev(() => window.__app.pov.player.hurt(10, 'Killed by the check'));
  await p.waitForFunction(() => window.__app.pov.player.dead, null, { timeout: 5000 }).catch(() => {});
  await p.waitForFunction(() => !window.__app.pov.player.dead && window.__app.pov.mode === 'on', null, { timeout: 15000 }).catch(() => {});
  s = await state();
  check('respawned as Pyro', s.cls === 'PYRO', JSON.stringify(s));
  check('Pyro has Fire Immunity', s.perks.FIRE_IMMUNITY === 1, JSON.stringify(s.perks));
  check('Pyro has the blowtorch in hand', s.held === 'BLOWTORCH', s.held);

  // ---- in the respawn room: shrine perks stay, the old class's go
  const orb = (key) => ev((key) => { const a = window.__app; a.perkOrbs.add(key, a.pov.player.pos.clone()); }, key);
  await orb('FIRE_IMMUNITY');   // a shrine stack of the class's own perk
  await settle(300);
  await orb('LUKKI');
  await settle(300);
  s = await state();
  check('shrine perks stack on the class\'s', s.perks.FIRE_IMMUNITY === 2 && s.perks.LUKKI === 1, JSON.stringify(s.perks));
  check('still in the respawn room', s.inRoom);
  await p.keyboard.press(',');
  await settle(200);
  await p.keyboard.press('1');   // Rocketeer
  await settle(300);
  s = await state();
  check('a pick in the respawn room applies at once', s.cls === 'ROCKETEER', JSON.stringify(s));
  check('the old class\'s perk is gone, the shrine\'s kept', s.perks.FIRE_IMMUNITY === 1 && s.perks.LUKKI === 1, JSON.stringify(s.perks));
  check('the new class\'s perk is on', s.perks.EXPLOSION_IMMUNITY === 1);
  check('Rocketeer holds its rocket, or its bombs until the rocket exists', s.held === 'ROCKET' || s.held === 'BOMB', s.held);

  // ---- keys this build lacks: skipped, no throw (applied straight, as a game mode or a bot would)
  const odd = await ev(async () => {
    const m = await import('/src/pov/classPicker.js');
    const a = window.__app, pl = a.pov.player, out = {};
    try {
      const r = m.applyClassTo(pl, 'RUNNER', a.pov.toolbelt);
      out.runner = { skipped: r.skipped, held: r.held, maxHealth: pl.perks.maxHealth, speed: pl.speedScale };
      const r2 = m.applyClassTo(pl, 'BULWARK', a.pov.toolbelt);
      out.bulwark = { skipped: r2.skipped, granted: r2.granted, held: r2.held, maxHealth: pl.perks.maxHealth, speed: pl.speedScale };
      const r3 = m.applyClassTo(pl, 'SPY', null);
      out.spy = { skipped: r3.skipped, granted: r3.granted };
      out.unknown = m.applyClassTo(pl, 'NOT_A_CLASS', null);
      out.after = { cls: pl.cls, perks: Object.fromEntries(pl.perks.list().map(({ perk, n }) => [perk.key, n])) };
    } catch (err) { out.threw = String(err); }
    return out;
  });
  check('unknown keys don\'t throw', !odd.threw, odd.threw ?? '');
  check('Runner: Fleet Foot skipped if missing, axe in hand, frail', !odd.threw && odd.runner.held && odd.runner.maxHealth < 1, JSON.stringify(odd.runner));
  check('Bulwark: Extra Health on, slow, sturdier', !odd.threw && odd.bulwark.granted.EXTRA_HEALTH === 1 && odd.bulwark.speed < 1 && odd.bulwark.maxHealth > 1, JSON.stringify(odd.bulwark));
  check('an unknown class changes nothing', !odd.threw && odd.unknown === null && odd.after.cls === 'SPY', JSON.stringify(odd.after));
  check('shrine perk survives every change', !odd.threw && odd.after.perks.LUKKI === 1 && odd.after.perks.FIRE_IMMUNITY === 1 && !odd.after.perks.EXTRA_HEALTH, JSON.stringify(odd.after.perks));

  // ---- a team tints it (body.team: the game modes' 'red' | 'blue' | 'infected')
  await ev(() => { window.__app.pov.player.team = 'red'; });
  await p.keyboard.press(',');
  await settle(400);
  await p.keyboard.press('ArrowLeft');   // from the chosen Rocketeer round to Pyro
  await settle(500);
  const tint = await ev(() => ({ team: document.querySelector('.cp').dataset.team, chip: document.querySelector('.cp-team').textContent, focus: document.querySelector('.cp-card.focus')?.dataset.key }));
  check('the team tints the picker', tint.team === 'red' && tint.chip === 'Red team', JSON.stringify(tint));
  if (shotPath) {
    const raw = shotPath.replace(/\.jpg$/, '.raw.png');
    await p.screenshot({ path: raw });
    execFileSync('sips', ['-Z', String(SHOT_W), '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', raw, '--out', shotPath], { stdio: 'ignore' });
    execFileSync('rm', [raw]);
    console.log(`     screenshot: ${shotPath}`);
  }
  await p.keyboard.press('Escape');
  await settle(200);

  // ---- the god view keeps comma for settings
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'off', null, { timeout: 10000 }).catch(() => {});
  await p.keyboard.press(',');
  await settle(300);
  s = await state();
  check('god view: comma opens settings, not the picker', s.settings && !s.open, JSON.stringify(s));
} catch (err) {
  fails++;
  console.log('FAIL threw', err);
} finally {
  if (errs.length) { fails++; console.log('FAIL page errors:\n  ' + errs.join('\n  ')); }
  await b.close();
}
console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);

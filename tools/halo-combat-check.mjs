// Halo combat check (docs/modes.md, "Halo combat"): a Team Slayer in the lab,
// through the real shell, keys and bodies, on the GPU:
//
//   melee         F on an enemy in front: Halo's 70 points pop its full shield (no health lost), a second
//                 blow kills it, cause 'melee'; F from behind kills another through its shield, cause
//                 'assassination'; both kills credited to the player (game:kill by 'player')
//   shield        the bot's break reaches the bus (body:shield), and a hit on the player's own shield
//                 flares the screen's edge (.pov-shieldfx)
//   reticle       red on an enemy in the gun's range, not on empty ground
//   frag          G throws (the count drops by one), it goes off after Halo's fuse (≥ 1.3 s, after a
//                 bounce), as a 'blast' with kind 'frag', near where it was thrown, and its shrapnel
//                 hurts an enemy standing there (cause 'grenade')
//   bots          (soft: logged, not failed) in a minute of play the bots throw frags and melee
//
// The bots under test are frozen (their update stubbed: they stand where they're put, facing one
// way) so each blow is deterministic. Without the arsenal's equal start merged, the check gives the
// shields (Energy Shield perk) and the grenades (body.grenades = 2) itself.
//
// usage: node tools/halo-combat-check.mjs [--url http://localhost:5423] [--shot file.jpg]
// Needs AC power (GPU) and a dev server on that port (vite --port 5423 --strictPort).
import { launchBrowser, newTestPage, ready } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const URL = opt('url', 'http://localhost:5423');
const SHOT = opt('shot', null);
const W = 960, H = 600;
const BOTS_S = 60;                 // s of free play for the soft bot check
const SPAWN_PROTECT_WAIT = 2500;   // ms: past the match's 2 s spawn protection
const MELEE_GAP = 1000;            // ms between blows: past Halo's 0.8 s melee recovery
const FUSE_WAIT = 6000;            // ms the frag gets to go off (its fuse is ≤ 4 s)
const BLAST_NEAR = 30;             // cells from the thrower its blast must be (it skids on a few metres past the first bounce)

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const soft = (name, ok, info = '') => console.log(`${ok ? 'ok  ' : 'warn'} ${name}${info ? `  ${info}` : ''}`);

const browser = await launchBrowser();
try {
  const p = await newTestPage(browser, { mode: 'preview', viewport: { width: W, height: H } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 400)));
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const wait = (ms) => p.waitForTimeout(ms);

  await p.goto(`${URL}/?preset=lab`, { timeout: 180000 });
  await ready(p);
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  await p.mouse.move(W * 0.5, H * 0.62);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });

  // the recorder, then a 2v2 Slayer on red
  await ev(async () => {
    const pov = window.__app.pov;
    pov.test.assumeLocked = true;
    const r = window.__hc = { kills: [], shield: [], frag: [], blasts: [], hits: [] };
    pov.events.on('game:kill', (e) => r.kills.push({ ...e }));
    pov.events.on('body:shield', (e) => r.shield.push({ id: e.id, state: e.state }));
    pov.events.on('frag', (e) => r.frag.push({ action: e.action, by: e.by ?? null }));
    pov.events.on('blast', (e) => r.blasts.push({ kind: e.kind ?? null, by: e.by ?? null, point: e.point.toArray() }));
    pov.events.on('body:hit', (e) => r.hits.push({ id: e.id, amount: e.amount, cause: e.cause, by: e.by ?? null }));
    await pov.game.start('slayer', { side: 'red', teamSize: 2 });
  });
  await p.waitForFunction(() => window.__app.pov.game.running && window.__app.pov.game.style === 'halo', null, { timeout: 60000 });
  await wait(SPAWN_PROTECT_WAIT);

  // freeze the enemy bots; shields and grenades if the arsenal hasn't given them
  const setup = await ev(() => {
    const pov = window.__app.pov, me = pov.player;
    const enemies = pov.game.roster.filter((e) => e.bot && e.team && e.team !== me.team).map((e) => e.bot);
    window.__hc.enemies = enemies;
    for (const b of enemies) { b.__update = b.update; b.update = () => {}; }
    const gaveShield = !(me.shieldMax > 0);
    for (const body of [me, ...enemies.map((b) => b.body)]) if (!(body.shieldMax > 0)) body.perks.add('ENERGY_SHIELD');
    const gaveNades = me.grenades == null;
    if (gaveNades) me.grenades = 2;
    return { enemies: enemies.length, team: me.team, gaveShield, gaveNades };
  });
  check('a Halo match with enemies', setup.enemies >= 2, JSON.stringify(setup));

  // the blow, from the front or the back of a frozen bot: the player placed `d` cells off it and
  // looking at its chest, then F (the real key)
  async function blow(i, { behind = false, fresh = false } = {}) {
    await ev(async ([i, behind, fresh]) => {
      const pov = window.__app.pov, me = pov.player, bot = window.__hc.enemies[i];
      const { targetById } = await import('/src/pov/targets.js');
      if (fresh) bot.placeAt(me.pos.clone().setX(me.pos.x + 12));   // a fresh body: full health and shield
      const face = me.pos.clone();
      targetById(bot.id).facing(face);
      face.y = 0; face.normalize();
      const d = 4;   // cells: inside the boot's reach, no lunge
      const at = bot.body.pos.clone().addScaledVector(face, behind ? -d : d);
      me.teleport(at);
      const dx = bot.body.pos.x - at.x, dz = bot.body.pos.z - at.z;
      const chest = bot.body.pos.y + bot.body.height * 0.6 - (at.y + me.eyeHeight);
      pov.setLook(Math.atan2(-dx, -dz), Math.atan2(chest, Math.hypot(dx, dz)));
    }, [i, behind, fresh]);
    await wait(100);   // a frame for the look and the probe
    await p.keyboard.press('f');
    await wait(200);
    return ev((i) => { const b = window.__hc.enemies[i].body; return { shield: +b.shield.toFixed(3), health: +b.health.toFixed(3), dead: b.dead, cause: b.cause }; }, i);
  }

  // ---- melee: one pops the shield, two kill; from behind, one kills
  const m1 = await blow(0, { fresh: true });
  check('melee 1 pops a full shield, health untouched', m1.shield === 0 && m1.health === 1 && !m1.dead, JSON.stringify(m1));
  await wait(MELEE_GAP);
  const m2 = await blow(0);
  check('melee 2 kills, cause melee', m2.dead && m2.cause === 'melee', JSON.stringify(m2));
  await wait(MELEE_GAP);
  const m3 = await blow(1, { behind: true, fresh: true });
  check('melee from behind kills through the shield, cause assassination', m3.dead && m3.cause === 'assassination', JSON.stringify(m3));
  await wait(300);
  const rec1 = await ev(() => ({ kills: window.__hc.kills.filter((k) => k.by === 'player').map((k) => k.cause), shield: window.__hc.shield }));
  check('both kills credited to the player', rec1.kills.includes('melee') && rec1.kills.includes('assassination'), JSON.stringify(rec1.kills));
  check('a bot\'s shield break reached the bus', rec1.shield.some((s) => s.id !== 'player' && s.state === 'break'), JSON.stringify(rec1.shield.slice(-4)));

  // ---- the player's own shield: the screen's edge flares
  await ev(() => window.__app.pov.player.hurt(0.3, 'test'));
  await wait(50);
  const edge = await ev(() => ({ op: +(getComputedStyle(document.querySelector('.pov-shieldfx')).opacity), ev: window.__hc.shield.filter((s) => s.id === 'player').map((s) => s.state) }));
  check('a hit on your shield flares the screen edge', edge.op > 0 && edge.ev.includes('hit'), JSON.stringify(edge));

  // ---- red reticle: an enemy 20 cells ahead, then empty ground
  await wait(SPAWN_PROTECT_WAIT);   // the killed bots respawn under protection: wait it out
  await ev(async () => {
    const pov = window.__app.pov, me = pov.player, bot = window.__hc.enemies[0];
    const { inventory } = await import('/src/pov/tools/inventory.js');
    inventory.give('GUN'); pov.toolbelt.select('GUN');
    bot.placeAt(me.pos.clone().setX(me.pos.x + 20));
    const dx = bot.body.pos.x - me.pos.x, dz = bot.body.pos.z - me.pos.z;
    const chest = bot.body.pos.y + bot.body.height * 0.6 - (me.pos.y + me.eyeHeight);
    pov.setLook(Math.atan2(-dx, -dz), Math.atan2(chest, Math.hypot(dx, dz)));
  });
  await wait(300);
  const redOn = await ev(() => ({ red: window.__app.pov.combat.red, css: document.querySelector('.pov-cross').classList.contains('enemy') }));
  await ev(() => window.__app.pov.setLook(window.__app.pov.camera.look.yaw + Math.PI, -0.3));
  await wait(300);
  const redOff = await ev(() => window.__app.pov.combat.red);
  check('the reticle is red on an enemy in range', redOn.red && redOn.css, JSON.stringify(redOn));
  check('...and not off it', !redOff);

  // ---- frag: G at the ground 6 cells ahead, an enemy standing just past it
  const f0 = await ev(() => {
    const pov = window.__app.pov, me = pov.player, bot = window.__hc.enemies[0];
    const yaw = pov.camera.look.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    bot.placeAt(me.pos.clone().set(me.pos.x + fx * 8, me.pos.y, me.pos.z + fz * 8));
    pov.setLook(yaw, -0.7);   // down at the ground before it
    window.__hc.blasts.length = 0;
    return { nades: me.grenades, thrown: pov.combat.frags.thrown, at: me.pos.toArray() };
  });
  await wait(SPAWN_PROTECT_WAIT);   // (the fresh placement is a respawn only if it was dead; wait anyway)
  await p.keyboard.press('g');
  await wait(300);
  const f1 = await ev(() => ({ nades: window.__app.pov.player.grenades, thrown: window.__app.pov.combat.frags.thrown, flying: window.__app.pov.combat.frags.list }));
  check('G throws a frag and spends one', f1.thrown === f0.thrown + 1 && f1.nades === f0.nades - 1, JSON.stringify({ f0, f1 }));
  await p.waitForFunction(() => window.__hc.blasts.some((b) => b.kind === 'frag'), null, { timeout: FUSE_WAIT }).catch(() => {});
  const f2 = await ev(() => ({ blasts: window.__hc.blasts, last: window.__app.pov.combat.frags.lastBlast, hits: window.__hc.hits.filter((h) => h.cause === 'grenade') }));
  const blast = f2.blasts.find((b) => b.kind === 'frag');
  const dist = blast ? Math.hypot(blast.point[0] - f0.at[0], blast.point[2] - f0.at[2]) : Infinity;
  check('it goes off after Halo\'s fuse, after a bounce', !!f2.last && f2.last.t >= 1.3 && f2.last.bounced != null, JSON.stringify(f2.last && { t: f2.last.t, bounced: f2.last.bounced }));
  check('a blast where it landed, credited to the player', !!blast && !blast.by && dist < BLAST_NEAR, JSON.stringify({ blast, dist }));
  check('its shrapnel hurt the enemy there (cause grenade)', f2.hits.length > 0, JSON.stringify(f2.hits));
  if (SHOT) await p.screenshot({ path: SHOT, type: 'jpeg', quality: 70 });

  // ---- soft: the bots, set free, throw frags and melee in a minute of play
  await ev(() => {
    for (const b of window.__hc.enemies) { b.update = b.__update; }
    window.__hc.frag.length = 0;
    window.__hc.melee = 0;
    window.__app.pov.events.on('kick', (e) => { if (e.by && e.melee) window.__hc.melee++; });
  });
  await wait(BOTS_S * 1000);
  const bots = await ev(() => ({ frags: window.__hc.frag.filter((f) => f.action === 'throw' && f.by).length, melee: window.__hc.melee }));
  soft('bots threw frags', bots.frags > 0, JSON.stringify(bots));
  soft('bots meleed', bots.melee > 0, JSON.stringify(bots));

  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);

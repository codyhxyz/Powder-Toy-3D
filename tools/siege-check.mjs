// Siege check (src/game/siege.js, docs/modes.md "Siege", docs/classes.md):
// headless on the GPU, one page, a short-fused Siege round on the lab (or
// --preset damValley), and the class picker's gating in every kind of match:
//
//   - a Siege start opens the class picker (TF2's class menu on joining a team)
//   - a pick during setup applies at once; the setup gate holds the attackers in spawn
//   - every bot has a class and fights with its class's tools
//   - the gates open (game:setup), the player takes point A alone (game:point),
//     the spawns move up and the clock gains time
//   - dead, comma picks a class for the next spawn, and the respawn has it
//   - a Halo match (Slayer): no picker, comma opens Settings, no class on the body
//   - sandbox: no picker, comma opens Settings, no class on the body (classes are Siege's only)
//   - no page errors
//
// usage: node tools/siege-check.mjs [--url http://localhost:5421] [--preset lab|damValley] [--shot file.jpg]
// Needs AC power (GPU) and a dev server (vite --port 5421 --strictPort).
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const URL = opt('url', 'http://localhost:5421');
const PRESET = opt('preset', 'lab');
const SHOT = opt('shot', null);
const W = 1280, H = 720;
// the round's rules cut down so the check fits a minute (the menu never does this: rules.js, siege.js)
const RULES = { side: 'red', setupS: 6, captureS: 4, timeLimit: 120 };
const POLL_MS = 250;
const WAIT_MS = 60000;

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const browser = await launchBrowser();
try {
  const p = await newTestPage(browser, { mode: 'preview', viewport: { width: W, height: H } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 300)); });
  await p.goto(`${URL}/?preset=${PRESET}`, { timeout: 180000 });
  await ready(p);
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  await p.mouse.move(W * 0.5, H * 0.62);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 60000 });
  await p.evaluate(() => {
    const pov = window.__app.pov;
    pov.test.assumeLocked = true;
    const r = window.__sc = { ev: [] };
    for (const n of ['game:setup', 'game:point', 'game:overtime', 'game:end', 'game:spawn', 'class:change']) {
      pov.events.on(n, (e) => r.ev.push({ n, t: pov.game.state.time, e: n === 'game:spawn' ? { id: e.id, style: e.style } : n === 'class:change' ? { key: e.key } : JSON.parse(JSON.stringify(e, (k, v) => (k === 'roster' ? undefined : v))) }));
    }
  });
  const until = (fn, arg, ms = WAIT_MS) => p.waitForFunction(fn, arg, { polling: POLL_MS, timeout: ms }).then(() => true, () => false);

  // ---- a Siege start opens the picker
  await p.evaluate((rules) => window.__app.pov.game.start('siege', rules), RULES);
  const opened = await until(() => window.__app.pov.classes?.isOpen, null, 10000);
  const st0 = await p.evaluate(() => ({ s: window.__app.pov.game.state.siege, left: window.__app.pov.game.state.timeLeft, obj: window.__app.pov.game.state.objective }));
  check('Siege start opens the class picker', opened);
  check('the round opens in setup', st0.s?.setup && st0.left <= RULES.setupS + 0.5, `${st0.obj}`);
  check('the layout has points', st0.s?.points >= 2, `${st0.s?.points} points`);

  // ---- a pick in setup applies at once
  await p.keyboard.press('3');
  const picked = await p.evaluate(() => ({ open: window.__app.pov.classes.isOpen, cls: window.__app.pov.player.cls, held: window.__app.pov.toolbelt?.selectedKey }));
  check('3 picks the Skyjack and closes the picker', !picked.open && picked.cls === 'SKYJACK', JSON.stringify(picked));

  // ---- bots have classes and class weapons
  const bots = await p.evaluate(() => window.__app.pov.game.roster.filter((e) => e.bot).map((e) => ({ team: e.team, cls: e.bot.body.cls, weapons: e.bot.agent.weapons ? [...e.bot.agent.weapons] : null })));
  check('every bot has a class', bots.length > 0 && bots.every((b) => b.cls), bots.map((b) => `${b.team}:${b.cls}`).join(' '));
  check('every bot fights with its class tools', bots.every((b) => b.weapons?.length), bots.map((b) => `${b.cls}=${b.weapons}`).join(' '));

  // ---- the setup gate: the player put far out comes back to the ring round the attackers' spawn
  if (await p.evaluate(() => window.__app.pov.game.state.siege.setup)) {
    const back = await p.evaluate(async () => {
      const pov = window.__app.pov, a = pov.game.state.siege.point;
      pov.player.teleport({ x: a.x, y: a.y + 2, z: a.z });
      await new Promise((r) => setTimeout(r, 400));
      const sp = pov.game.layout.siege.spawns?.[0]?.attack ?? pov.game.layout.spawns.red;
      const c = sp.reduce((m, q) => ({ x: m.x + q[0] / sp.length, z: m.z + q[2] / sp.length }), { x: 0, z: 0 });
      return Math.hypot(pov.player.pos.x - c.x, pov.player.pos.z - c.z);
    });
    check('the setup gate holds the attackers in spawn', back < 40, `${back.toFixed(1)} cells from the spawn's middle`);
  } else check('the setup gate holds the attackers in spawn', false, 'setup ended before the gate could be tried');

  // ---- the gates open; the player takes A alone (the defenders' bots knocked out so nothing blocks)
  check('the gates open', await until(() => window.__sc.ev.some((x) => x.n === 'game:setup'), null, (RULES.setupS + 10) * 1000));
  const before = await p.evaluate(() => ({ left: window.__app.pov.game.state.timeLeft, spawn: JSON.stringify(window.__app.pov.game.state.siege && window.__app.pov.game.layout.siege.spawns?.[1]?.attack?.[0]) }));
  await p.evaluate(() => {
    const pov = window.__app.pov, a = pov.game.state.siege.point;
    for (const e of pov.game.roster) if (e.bot && e.team === pov.game.state.siege.defenders) e.bot.body.hurt(1e6, 'check');
    pov.player.teleport({ x: a.x, y: a.y + 2, z: a.z });
  });
  const took = await until(() => window.__sc.ev.some((x) => x.n === 'game:point' && x.e.letter === 'A'), null, (RULES.captureS + 15) * 1000);
  const after = await p.evaluate(() => ({ s: window.__app.pov.game.state.siege, left: window.__app.pov.game.state.timeLeft, obj: window.__app.pov.game.state.objective, score: window.__app.pov.game.state.teamScore }));
  check('the player takes point A', took, after.obj);
  check('B is the point now, the score counts it', after.s?.stage === 1 && after.score.red === 1, JSON.stringify(after.score));
  check('a capture adds time', after.left > before.left, `${before.left.toFixed(0)} → ${after.left.toFixed(0)} s`);
  if (SHOT) { await render(p); await p.screenshot({ path: SHOT, type: 'jpeg', quality: 75 }); await p.evaluate(() => window.__app.test.resume()); }

  // ---- dead: comma picks for the next spawn
  await p.evaluate(() => window.__app.pov.player.hurt(1e6, 'check'));
  await until(() => window.__app.pov.player.dead, null, 5000);
  await p.keyboard.press(',');
  const deadOpen = await p.evaluate(() => window.__app.pov.classes.isOpen);
  await p.keyboard.press('7');
  const respawned = await until(() => !window.__app.pov.player.dead && window.__app.pov.player.cls === 'PYRO', null, 20000);
  check('dead, comma opens the picker', deadOpen);
  check('the pick applies on the respawn', respawned, await p.evaluate(() => `${window.__app.pov.player.cls}`));

  // ---- outside Siege, no classes: comma is Settings
  const noClasses = async () => {
    await p.keyboard.press(',');
    await p.waitForTimeout(300);
    const r = await p.evaluate(() => ({ open: window.__app.pov.classes.isOpen, cls: window.__app.pov.player.cls ?? null, style: window.__app.pov.game.style ?? null,
      settings: !!document.querySelector('.drawer[aria-label="Settings"].open'), tip: window.__classTips }));
    await p.keyboard.press(',');   // Settings shut again
    await p.waitForTimeout(200);
    return r;
  };
  await p.evaluate(() => {   // count the class tip's toasts from here on
    window.__classTips = 0;
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (/Press , to choose a class/.test(n.textContent ?? '')) window.__classTips++; })
      .observe(document.body, { childList: true, subtree: true });
  });
  await p.evaluate(() => window.__app.pov.game.start('slayer', { side: 'red' }));
  await p.waitForTimeout(1500);
  const halo = await noClasses();
  check('Slayer: no picker, comma opens Settings, no class on the body', halo.style === 'halo' && !halo.open && halo.settings && !halo.cls, JSON.stringify(halo));

  await p.evaluate(() => window.__app.pov.game.end());
  await p.waitForTimeout(500);
  const sandbox = await noClasses();
  check('sandbox: no picker, comma opens Settings, no class on the body', !sandbox.open && sandbox.settings && !sandbox.cls, JSON.stringify(sandbox));
  await p.evaluate(() => window.__app.pov.player.hurt(1e6, 'check'));
  const back = await until(() => !window.__app.pov.player.dead, null, 20000);
  const respawn = await noClasses();
  check('sandbox respawn: still no class, no class tip', back && !respawn.cls && !respawn.open && !respawn.tip, JSON.stringify(respawn));

  check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : 'siege check passed');
process.exit(failed ? 1 : 0);

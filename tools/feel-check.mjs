// Halo's feel in a Halo match (src/game/feel.js, docs/modes.md "Medals, tracker,
// power-ups"), headless on the GPU. On Dam Valley (4 shrines), a Team Slayer
// match on red:
//
//   power-ups  the shrines' Noita perks are put away and an Overshield floats
//              over each; walking into one charges the shield past its maximum
//              (vitals.js) and the shield bar shows the green layer; the match's
//              end puts the perks back
//   tracker    the canvas is on, drawn, and hidden again after the match
//   medals     two quick melee kills by the player (fake game:kill events) stack
//              First Strike, Beat Down and Double Kill bottom-left, put "Double
//              Kill" on the centre line, and count on the roster entry
//
// plus no page errors. --shot writes a screenshot of the HUD mid-match.
//
// usage: node tools/feel-check.mjs [--url http://localhost:5424] [--preset damValley] [--shot file.jpg]
// Needs AC power (GPU) and a dev server (npx vite --port 5424 --strictPort).
import { launchBrowser, newTestPage, ready, render } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const URL = opt('url', 'http://localhost:5424');
const PRESET = opt('preset', 'damValley');
const SHOT = opt('shot', null);
const W = 1280, H = 720;
const OVERSHIELD_WAIT_MS = 4000;   // powerups.js OVERSHIELD.chargeS (3 s) and a margin

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const browser = await launchBrowser();
try {
  const page = await newTestPage(browser, { mode: 'preview', viewport: { width: W, height: H } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 300)); });
  await page.goto(`${URL}/?preset=${PRESET}`, { timeout: 180000 });
  await ready(page);
  await page.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  await page.mouse.move(W * 0.5, H * 0.62);
  await page.keyboard.press('f');
  await page.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });
  await page.evaluate(() => { window.__app.pov.test.assumeLocked = true; });

  const shrinesBefore = await page.evaluate(() => window.__app.perkOrbs.list.filter((o) => o.shrine).length);
  await page.evaluate(() => window.__app.pov.game.start('slayer', { side: 'red' }));
  await page.waitForFunction(() => window.__app.pov.game.running, null, { timeout: 60000 });
  await page.waitForTimeout(1500);

  // ---- power-ups
  const pads = await page.evaluate(() => window.__app.pov.game.feel.powerups);
  const shrinesDuring = await page.evaluate(() => window.__app.perkOrbs.list.filter((o) => o.shrine).length);
  check('an Overshield over every shrine', pads.length > 0 && pads.every((p) => p.kind === 'overshield'), `${pads.length} pads`);
  check("the shrines' perks put away", shrinesBefore > 0 && shrinesDuring === 0, `${shrinesBefore} → ${shrinesDuring}`);
  if (pads.length) {
    await page.evaluate((f) => { const pov = window.__app.pov; pov.player.teleport({ x: f.x, y: f.y, z: f.z }); }, pads[0].feet);
    await page.waitForTimeout(OVERSHIELD_WAIT_MS);
    const s = await page.evaluate(() => {
      const p = window.__app.pov.player;
      return { shield: p.shield, max: p.shieldMax, state: p.overshielded, bar: !!document.querySelector('.pov-shield.over') };
    });
    check('walking into it charges the shield past its maximum', s.max > 0 && s.shield > s.max * 1.5, `${s.shield?.toFixed(2)} of ${s.max?.toFixed(2)}, ${s.state}`);
    check('the shield bar shows the Overshield', s.bar);
    const taken = await page.evaluate(() => window.__app.pov.game.feel.powerups.filter((p) => p.readyAt > window.__app.pov.game.state.time).length);
    check('the taken one waits to respawn', taken >= 1, `${taken} waiting`);
  }

  // ---- tracker
  const tracker = await page.evaluate(() => {
    const el = document.querySelector('.feel-tracker'), c = el?.querySelector('canvas');
    if (!el || !c) return { on: false, ink: 0 };
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
    return { on: el.classList.contains('on') && getComputedStyle(el).display !== 'none', ink };
  });
  check('the motion tracker is on and drawn', tracker.on && tracker.ink > 100, `${tracker.ink} px inked`);

  // ---- medals: two melee kills by the player within Halo 3's 4 s
  const medals = await page.evaluate(async () => {
    const pov = window.__app.pov, game = pov.game;
    const foes = game.roster.filter((e) => e.team && e.team !== game.roster.find((r) => r.id === 'player').team);
    const kill = (v) => pov.events.emit('game:kill', { killer: 'You', killerTeam: 'red', victim: v.name, victimTeam: v.team, cause: 'melee', by: 'player', id: v.id });
    kill(foes[0]);
    await new Promise((r) => setTimeout(r, 500));
    kill(foes[1]);
    await new Promise((r) => setTimeout(r, 300));
    return {
      names: [...document.querySelectorAll('.feel-medal .feel-name')].map((e) => e.textContent),
      line: document.querySelector('.feel-line.on')?.textContent ?? '',
      count: game.roster.find((r) => r.id === 'player').medals ?? 0,
    };
  });
  check('medals stack bottom-left', ['First Strike', 'Beat Down', 'Double Kill'].every((n) => medals.names.includes(n)), medals.names.join(', '));
  check('the centre line calls the multi-kill', medals.line === 'Double Kill', medals.line);
  check('the roster entry counts them', medals.count >= 4, `${medals.count}`);

  if (SHOT) {
    await render(page);
    await page.screenshot({ path: SHOT, type: 'jpeg', quality: 75 });
    await page.evaluate(() => window.__app.test.resume());
    console.log(`shot: ${SHOT}`);
  }

  // ---- the match's end puts everything back
  await page.evaluate(() => window.__app.pov.game.end());
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    shrines: window.__app.perkOrbs.list.filter((o) => o.shrine).length,
    pads: window.__app.pov.game.feel.powerups.length,
    tracker: document.querySelector('.feel-tracker')?.classList.contains('on') ?? false,
  }));
  check("the shrines' perks come back", after.shrines === shrinesBefore, `${after.shrines} of ${shrinesBefore}`);
  check('the power-ups and the tracker go', after.pads === 0 && !after.tracker);
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

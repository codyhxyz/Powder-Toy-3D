// Joining a match end to end, on the GPU (docs/modes.md "Joining", "The match
// loop"): from the bare start menu, one click on Play drops into Team Slayer on
// Dam Valley with the player on a team; the loading screen comes down on the
// match running; "Click to play" shows until the mouse is captured, then the
// controls card; the join:… timing marks are printed; M opens no match menu
// without opening the start menu; a match with its clock cut short ends in the
// carnage report, which counts down and the next match starts by itself; Leave
// ends the loop at the start menu.
// Needs AC power and a dev server: `npx vite --port 5425 --strictPort`, then
// usage: node tools/join-check.mjs [--url http://localhost:5425] [--within 90] [--shots dir]
import { mkdirSync } from 'fs';
import { join } from 'path';
import { launchBrowser, newTestPage } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const URL = opt('url', 'http://localhost:5425');
const WITHIN_S = +opt('within', '90');   // s from the Play click to a running match (a cold shader compile is most of it)
const SHOTS = opt('shots', null);        // a directory for screenshots, else none
const MENU_MS = 15000;                   // ms the bare page may take to show the menu (dev server, unbundled)
const SHORT_MATCH_S = 20;                // game s: the cut-short match's clock (rule override), so it ends on time
const END_WAIT_S = 120;                  // s (wall) for that match to end: game time runs with the frame rate
const NEXT_WAIT_S = 40;                  // s (wall) from the report to the next match running (END_SCREEN_S + a reload)
const W = 1280, H = 800;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}.png`) }); };

const browser = await launchBrowser();
try {
  const p = await newTestPage(browser, { mode: 'preview', viewport: { width: W, height: H } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 400)));
  // (a dev server without the multiplayer relay refuses its connection: not ours)
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });

  await p.goto(`${URL}/`);
  await p.waitForSelector('.mm.open .mm-play.main', { timeout: MENU_MS });
  check('the start menu shows Play and Siege', await p.$$eval('.mm-play', (els) => els.map((e) => e.dataset.play).join()) === 'slayer,siege');
  await shot(p, '1-menu');

  // one click
  const t0 = Date.now();
  await p.click('.mm-play.main');
  await p.waitForSelector('.mm.loading');
  await p.waitForFunction(() => window.__app?.pov?.game?.running && !document.querySelector('.mm.open'), null, { timeout: WITHIN_S * 1000, polling: 250 });
  const joinS = (Date.now() - t0) / 1000;
  const s1 = await p.evaluate(() => {
    const a = window.__app, g = a.pov.game, me = g.roster.find((e) => !e.bot);
    return { mode: g.mode, map: a.settings.preset, team: me?.team ?? null, bots: g.botCount, pov: a.pov.mode, play: !!document.querySelector('.game-play.on') };
  });
  check(`Play is a Slayer match on Dam Valley within ${WITHIN_S} s`, s1.mode === 'slayer' && s1.map === 'damValley' && joinS <= WITHIN_S, `${joinS.toFixed(1)} s, ${JSON.stringify(s1)}`);
  check('the player is on a team, with 7 bots', (s1.team === 'red' || s1.team === 'blue') && s1.bots === 7);
  check('"Click to play" shows while the mouse is free', s1.play);
  await shot(p, '2-click-to-play');

  // the click that would capture the mouse (headless can't lock the pointer)
  await p.evaluate(() => { window.__app.pov.test.assumeLocked = true; });
  await p.waitForFunction(() => performance.getEntriesByName('join:control').length > 0, null, { timeout: 10000 });
  const s2 = await p.evaluate(() => ({ play: !!document.querySelector('.game-play.on'), card: !!document.querySelector('.game-card.on'), hint: getComputedStyle(document.querySelector('.pov-hint')).display }));
  check('captured: the prompt goes, the controls card shows, the sandbox hint is hidden', !s2.play && s2.card && s2.hint === 'none', JSON.stringify(s2));
  await shot(p, '3-in-match');

  // the timing marks, from the click
  const marks = await p.evaluate(() => {
    const all = performance.getEntriesByType('mark').filter((m) => m.name.startsWith('join:'));
    const c = all.find((m) => m.name === 'join:click')?.startTime ?? 0;
    return all.map((m) => [m.name.slice(5), Math.round(m.startTime - c)]);
  });
  console.log(`timing (ms from the click): ${marks.map(([n, t]) => `${n} ${t}`).join(' · ')}`);
  const names = marks.map(([n]) => n);
  check('every join mark is set', ['click', 'app', 'npcs', 'first-frame', 'entered', 'bots', 'match', 'ready', 'control'].every((n) => names.includes(n)), names.join());

  // no match menu in the game (gamemodes are picked on the start menu): M opens nothing, no "M Match" chip
  await p.keyboard.press('m');
  await p.waitForTimeout(300);
  const s3 = await p.evaluate(() => ({ menu: !!document.querySelector('.game-menu, .game-chip'), start: !!document.querySelector('.mm.open'), running: window.__app.pov.game.running }));
  check('no match menu: M opens nothing and the match plays on', !s3.menu && !s3.start && s3.running, JSON.stringify(s3));

  // a match on a short clock: the carnage report, then the next match by itself
  await p.evaluate((t) => window.__app.pov.game.start('slayer', { timeLimit: t }), SHORT_MATCH_S);
  await p.waitForFunction(() => document.querySelector('.game-report.on') && window.__app.pov.game.nextIn != null, null, { timeout: END_WAIT_S * 1000, polling: 250 });
  const s4 = await p.evaluate(() => ({
    title: document.querySelector('.game-report-title').textContent,
    rows: document.querySelectorAll('.game-report .game-line:not(.head)').length,
    me: !!document.querySelector('.game-report .game-line.me'),
    nextIn: window.__app.pov.game.nextIn,
  }));
  check('the carnage report: a title, every player, you highlighted, a countdown', ['Victory', 'Defeat', 'Draw'].includes(s4.title) && s4.rows === 8 && s4.me && s4.nextIn > 0, JSON.stringify(s4));
  await shot(p, '4-report');
  await p.waitForFunction(() => window.__app.pov.game.running && !document.querySelector('.game-report.on'), null, { timeout: NEXT_WAIT_S * 1000, polling: 250 });
  const s5 = await p.evaluate(() => { const g = window.__app.pov.game; return { mode: g.mode, time: g.state.time, bots: g.botCount, team: g.roster.find((e) => !e.bot)?.team }; });
  check('the next match starts by itself, on the same rules', s5.mode === 'slayer' && s5.bots === 7 && !!s5.team, JSON.stringify(s5));

  // the way out: end it again, then Leave on the report
  await p.evaluate(() => { window.__app.pov.test.assumeLocked = false; });
  await p.waitForFunction(() => document.querySelector('.game-report.on'), null, { timeout: END_WAIT_S * 1000, polling: 250 });
  await p.click('.game-leave');
  await p.waitForTimeout(300);
  const s6 = await p.evaluate(() => ({ start: !!document.querySelector('.mm.open.in-game'), next: window.__app.pov.game.nextIn }));
  check('Leave opens the start menu and ends the loop', s6.start && s6.next == null, JSON.stringify(s6));

  check('no page errors', !errs.length, errs.join('\n'));
} finally {
  await browser.close();
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);

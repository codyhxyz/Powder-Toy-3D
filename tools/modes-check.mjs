// Team games check (src/game, docs/modes.md): bots play each mode in the lab,
// headless on the GPU, for a game-time-boxed run, and we check the mode did
// its thing:
//
//   slayer     kills are credited and score
//   ctf        a flag is taken, then captured or returned
//   koth       the hill scores
//   infection  the infection spreads
//   siege      the attackers' half ends and the sides swap
//
// plus no page errors, and the frame rate with the bot count (the player
// watches by default: all bots; --side red puts the player on red).
//
// usage: node tools/modes-check.mjs [--url http://localhost:5405] [--modes slayer,ctf] [--side spectate|red]
//        [--teamSize 4] [--shot file.jpg]
// Needs AC power (GPU) and a dev server.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const URL = opt('url', 'http://localhost:5405');
const MODES = opt('modes', 'slayer,ctf,koth,infection,siege').split(',');
const SIDE = opt('side', 'spectate');
const TEAM_SIZE = +opt('teamSize', '4');
const SHOT = opt('shot', null);
const PRESET = opt('preset', 'lab');   // lab, or an arena (damValley: its own layout)
const STRICT = args.includes('--strict');   // CTF must capture, Siege must play both halves to a result
const SWEEP = opt('sweep', null);   // e.g. 0,2,4,6,8: just the frame rate with that many bots (Slayer, watching), SWEEP_S each
const SWEEP_S = 12;
const TOUR = opt('tour', null);     // a path prefix: screenshots of a CTF match on red (HUD, Tab, M, the result), then exit
const W = 960, H = 600;
const POLL_MS = 1000;

// per mode: the rule overrides that make a check fit a few minutes, the game-time box, and what counts as working
const PLAN = {
  slayer: { opts: {}, box: 120, ok: (s) => s.kills >= 3 && s.scored },
  ctf: STRICT ? { opts: {}, box: 360, ok: (s) => s.flag.captured > 0 } : { opts: {}, box: 180, ok: (s) => s.flag.taken > 0 && (s.flag.captured > 0 || s.flag.returned > 0) },
  koth: { opts: { hillMoveS: 40 }, box: 120, ok: (s) => s.hillScore >= 5 },
  infection: { opts: { timeLimit: 150 }, box: 150, ok: (s) => s.infected >= 2 },
  siege: { opts: { holdToWin: 10, timeLimit: 50 }, box: 130, ok: (s) => (STRICT ? s.ended > 0 : s.halves >= 1) },
};

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const report = [];
let failed = false;
try {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  // (a dev server without the multiplayer relay refuses its connection: not ours)
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 300)); });
  await p.goto(`${URL}/?preset=${PRESET}`);
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  await p.waitForTimeout(2500);
  await p.mouse.move(W * 0.5, H * 0.62);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });
  await p.evaluate(() => {
    const pov = window.__app.pov;
    pov.test.assumeLocked = true;
    // the recorder: game events and frames
    const r = window.__mc = { ev: [], frames: 0, t0: performance.now() };
    for (const n of ['game:kill', 'game:flag', 'game:hill', 'game:infected', 'game:half', 'game:end', 'game:start']) {
      pov.events.on(n, (e) => r.ev.push({ n, t: pov.game.state.time, e: JSON.parse(JSON.stringify(e, (k, v) => (k === 'roster' ? undefined : v))) }));
    }
    const tick = () => { r.frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  if (TOUR) {
    await p.evaluate(() => window.__app.pov.game.start('ctf', { side: 'red', timeLimit: 30 }));
    await p.waitForTimeout(8000);
    // stand on the red base, look across at the enemy
    await p.evaluate(() => {
      const pov = window.__app.pov, q = pov.player.pos, f = pov.game.layout.flags.blue;
      pov.setLook(Math.atan2(-(f[0] - q.x), -(f[2] - q.z)), -0.08);
    });
    await p.waitForTimeout(1500);
    await p.screenshot({ path: `${TOUR}-hud.jpg`, type: 'jpeg', quality: 70 });
    await p.keyboard.down('Tab'); await p.waitForTimeout(300);
    await p.screenshot({ path: `${TOUR}-tab.jpg`, type: 'jpeg', quality: 70 });
    await p.keyboard.up('Tab');
    await p.keyboard.press('m'); await p.waitForTimeout(300);
    await p.screenshot({ path: `${TOUR}-menu.jpg`, type: 'jpeg', quality: 70 });
    await p.keyboard.press('m');
    const r = await p.evaluate(() => new Promise((res) => { const off = window.__app.pov.events.on('game:end', (e) => { off(); res({ winner: e.winner, score: e.score, why: e.why }); }); }));
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${TOUR}-end.jpg`, type: 'jpeg', quality: 70 });
    console.log('tour result', JSON.stringify(r));
    MODES.length = 0;
  }

  if (SWEEP) {
    for (const n of SWEEP.split(',').map(Number)) {
      await p.evaluate(async (n) => { const g = window.__app.pov.game; g.end(); if (n) await g.start('slayer', { side: 'spectate', teamSize: n / 2 }); }, n);
      await p.waitForTimeout(3000);   // shaders compiled, bodies landed
      const f0 = await p.evaluate(() => window.__mc.frames), t0 = Date.now();
      await p.waitForTimeout(SWEEP_S * 1000);
      const fps = (await p.evaluate(() => window.__mc.frames) - f0) / ((Date.now() - t0) / 1000);
      const botMs = await p.evaluate(() => window.__app.pov.game.state.botMs);
      console.log(JSON.stringify({ bots: n, fps: +fps.toFixed(1), botMsPerFrame: +botMs.toFixed(2) }));
    }
    await p.evaluate(() => window.__app.pov.game.end());
    MODES.length = 0;
  }

  for (const mode of MODES) {
    const plan = PLAN[mode];
    await p.evaluate(async ({ mode, opts }) => {
      window.__mc.ev.length = 0;
      await window.__app.pov.game.start(mode, opts);
    }, { mode, opts: { side: SIDE, teamSize: TEAM_SIZE, ...plan.opts } });
    const t0 = Date.now();
    let s = null, f0 = await p.evaluate(() => window.__mc.frames), w0 = Date.now(), fpsList = [];
    for (;;) {
      await p.waitForTimeout(POLL_MS);
      s = await p.evaluate(() => {
        const g = window.__app.pov.game, st = g.state, ev = window.__mc.ev;
        const count = (n, f = () => true) => ev.filter((x) => x.n === n && f(x.e)).length;
        return {
          running: st.running, time: st.time, score: st.teamScore, bots: st.bots,
          kills: count('game:kill', (e) => !!e.by), deaths: count('game:kill'),
          scored: Object.values(st.teamScore).some((v) => v > 0),
          flag: { taken: count('game:flag', (e) => e.action === 'taken'), captured: count('game:flag', (e) => e.action === 'captured'), returned: count('game:flag', (e) => e.action === 'returned'), dropped: count('game:flag', (e) => e.action === 'dropped') },
          hillScore: st.mode === 'koth' ? Math.max(...Object.values(st.teamScore)) : 0,
          infected: st.mode === 'infection' ? st.teamScore.infected : 0,
          halves: count('game:half'), ended: count('game:end'), result: ev.find((x) => x.n === 'game:end')?.e ?? null,
          frames: window.__mc.frames, botMs: st.botMs,
          goals: g.bots.map((n) => n.debug.goal).reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {}),
          ev: ev.slice(-3).map((x) => `${x.n} ${x.e.action ?? x.e.victim ?? ''}`),
        };
      });
      const now = Date.now();
      fpsList.push((s.frames - f0) / ((now - w0) / 1000));
      f0 = s.frames; w0 = now;
      if (plan.ok(s) || !s.running || s.time > plan.box || now - t0 > plan.box * 4000) break;
      if (STRICT && mode === 'ctf' && Math.round(s.time) % 30 === 0) console.log(JSON.stringify({ t: Math.round(s.time), flag: s.flag, goals: s.goals }));
    }
    const ok = plan.ok(s);
    if (!ok) failed = true;
    fpsList.sort((a, c) => a - c);
    const fps = { median: fpsList[Math.floor(fpsList.length / 2)]?.toFixed(1), low: fpsList[0]?.toFixed(1) };
    if (SHOT && mode === MODES[0]) await p.screenshot({ path: SHOT, type: 'jpeg', quality: 70 });
    await p.evaluate(() => window.__app.pov.game.end());
    const line = { mode, ok, gameS: Math.round(s.time), wallS: Math.round((Date.now() - t0) / 1000), bots: s.bots, fps, botMs: +s.botMs.toFixed(2), score: Object.fromEntries(Object.entries(s.score).map(([k, v]) => [k, Math.round(v * 10) / 10])), kills: s.kills, deaths: s.deaths, flag: mode === 'ctf' ? s.flag : undefined, infected: mode === 'infection' ? s.infected : undefined, halves: mode === 'siege' ? s.halves : undefined, result: s.result ? { winner: s.result.winner, why: s.result.why } : undefined, goals: s.goals };
    report.push(line);
    console.log(JSON.stringify(line));
  }
  if (errs.length) { failed = true; console.log('page errors:', [...new Set(errs)].slice(0, 10)); }
  else console.log('no page errors');
} finally {
  await b.close();
}
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);

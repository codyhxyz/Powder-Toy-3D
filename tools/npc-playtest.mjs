// NPC playtest: scripted players fight the lab's NPC (src/pov/npc.js) and we
// measure whether it's fair and fun, not just whether it works.
//
// Each style plays MATCHES matches from the same start (the player on the
// lab's open south floor, the NPC 27 cells off). The player is driven the way
// a person drives it: real key and mouse events, and a look direction with a
// human's aim wobble. A match ends when either dies or after MATCH_S.
//
//   afk      stands still (how long does a player who isn't fighting last?)
//   gunner   keeps it in sight and shoots, strafing side to side
//   brawler  rushes it with the axe
//   runner   sprints and jets away from it
//
// Reported per style: wins/losses/timeouts, time to kill each way, what hurt
// the player (by cause), the worst 1 s of damage, and the tools the NPC used.
// The fun targets (docs/pov.md, "NPCs"): an AFK player lasts 20–60 s; a fighting
// player wins most duels but loses some health doing it; no second takes more
// than half the player's health; a runner gets away.
//
// usage: node tools/npc-playtest.mjs [--url http://localhost:5291] [--styles gunner,brawler] [--matches 3]
// Needs AC power (GPU) and a dev server, or --url https://tpt3d.codyh.xyz.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const URL = opt('url', 'http://localhost:5291');
const STYLES = opt('styles', 'afk,gunner,brawler,runner').split(',');
const MATCHES = +opt('matches', '3');
const MATCH_S = 60;                       // s a match may last
const PLAYER_AT = [44, 3, 110];           // grid cells: open dry floor between the tower and the lava pit
const NPC_AT = [71, 3, 110];              // 27 cells east of the player
const W = 960, H = 600;

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  await p.goto(`${URL}/?preset=lab`);
  await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
  await p.waitForTimeout(2500);
  await p.mouse.move(W * 0.5, H * 0.62);
  await p.keyboard.press('f');
  await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 });
  await p.evaluate(() => { window.__app.pov.test.assumeLocked = true; });
  await p.waitForFunction(() => window.__app.pov.npc?.placeAt, null, { timeout: 30000 });

  // the in-page player bot and the match recorder
  await p.evaluate(() => {
    const app = window.__app, pov = app.pov, canvas = app.renderer.domElement;
    const HUMAN_AIM = 0.035;              // rad, a person's aim wobble (σ)
    const CLICK_S = 0.4;                  // s between a person's clicks
    const STRAFE_S = 1.1;                 // s per strafe direction
    const AXE_FROM = 12;                  // cells: the brawler swings from this close
    const RUN_JET_FROM = 18;              // cells: the runner jets when it's this close
    const key = (code, down) => dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code === 'Digit3' ? '3' : code === 'Digit4' ? '4' : code.replace('Key', '').toLowerCase(), bubbles: true }));
    const held = new Set();
    const hold = (code, on) => { if (on && !held.has(code)) { held.add(code); key(code, true); } else if (!on && held.has(code)) { held.delete(code); key(code, false); } };
    const click = () => { canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })); setTimeout(() => dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true })), 40); };
    const gauss = () => { const u = Math.random() || 1e-9; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); };
    let style = 'afk', lastClick = 0, strafeT = 0, strafe = 1, raf = 0, match = null;

    function frame(now) {
      raf = requestAnimationFrame(frame);
      const q = pov.player, n = pov.npc?.body;
      if (!match || !q || !n) return;
      const t = (now - match.t0) / 1000;
      // the match
      if (!match.done && (q.dead || n.dead || t > match.limit)) {
        match.done = true; match.t = t;
        match.result = q.dead && !n.dead ? 'loss' : n.dead && !q.dead ? 'win' : q.dead ? 'both' : 'timeout';
        for (const c of [...held]) hold(c, false);
        return;
      }
      if (match.done || q.dead) return;
      const dx = n.pos.x - q.pos.x, dz = n.pos.z - q.pos.z, hd = Math.hypot(dx, dz);
      const face = (away = false) => {
        const yaw = Math.atan2(away ? dx : -dx, away ? dz : -dz) + gauss() * HUMAN_AIM;
        const pitch = away ? 0 : Math.atan2(n.pos.y + 3 - (q.pos.y + 5), hd) + gauss() * HUMAN_AIM;
        pov.setLook(yaw, pitch);
      };
      const sees = pov.npc.agent.npc.world.sees({ x: q.pos.x, y: q.pos.y + 5, z: q.pos.z }, { x: n.pos.x, y: n.pos.y + 3, z: n.pos.z });
      if (style === 'gunner') {
        face();
        strafeT += 1 / 60; if (strafeT > STRAFE_S) { strafeT = 0; strafe = -strafe; }
        hold('KeyA', strafe < 0); hold('KeyD', strafe > 0);
        hold('KeyW', !sees);
        if (sees && now - lastClick > CLICK_S * 1000) { lastClick = now; click(); }
      } else if (style === 'brawler') {
        face();
        hold('KeyW', hd > 4); hold('ShiftLeft', hd > 8);
        if (hd < AXE_FROM && now - lastClick > CLICK_S * 1000) { lastClick = now; click(); }
      } else if (style === 'runner') {
        face(true);
        hold('KeyW', true); hold('ShiftLeft', true);
        hold('Space', hd < RUN_JET_FROM);
      }
    }
    raf = requestAnimationFrame(frame);

    window.__playtest = {
      start(s, limit, playerAt, npcAt) {
        style = s; strafeT = 0; lastClick = 0;
        for (const c of [...held]) hold(c, false);
        const V = pov.player.pos.constructor;
        pov.player.spawn(new V(...playerAt));
        pov.npc.placeAt(new V(...npcAt));
        // the player's tool for the style
        if (s === 'gunner') key('Digit4', true), key('Digit4', false);
        if (s === 'brawler') key('Digit3', true), key('Digit3', false);
        match = { t0: performance.now(), limit, done: false, hurt: [], npcHurt: [], tools: {} };
        const m = match;
        m.offs = [
          pov.player.on('hurt', (e) => m.hurt.push({ t: (performance.now() - m.t0) / 1000, amount: e.amount, cause: e.cause })),
          pov.npc.body.on('hurt', (e) => m.npcHurt.push({ t: (performance.now() - m.t0) / 1000, amount: e.amount, cause: e.cause })),
          pov.events.on('tool:action', (e) => { if (e.by) { const k = `${e.tool}:${e.action}`; m.tools[k] = (m.tools[k] ?? 0) + 1; } }),
          pov.events.on('gun:fire', (e) => { if (e.by) m.tools['gun:fire'] = (m.tools['gun:fire'] ?? 0) + 1; }),
        ];
      },
      get state() {
        if (!match) return null;
        const { done, result, t, hurt, npcHurt, tools } = match;
        return { done, result, t, hurt, npcHurt, tools, hp: pov.player.health, npcHp: pov.npc.body.health };
      },
    };
  });

  const summary = {};
  for (const style of STYLES) {
    const rows = [];
    for (let m = 0; m < MATCHES; m++) {
      // wait out a death (the shell respawns the player on its own after a few seconds)
      await p.waitForFunction(() => !window.__app.pov.player.dead && window.__app.pov.mode === 'on', null, { timeout: 20000 }).catch(() => {});
      await p.waitForTimeout(800);
      await p.evaluate(([s, lim, pa, na]) => window.__playtest.start(s, lim, pa, na), [style, MATCH_S, PLAYER_AT, NPC_AT]);
      await p.waitForFunction(() => window.__playtest.state?.done, null, { timeout: (MATCH_S + 20) * 1000, polling: 500 }).catch(() => {});
      const st = await p.evaluate(() => window.__playtest.state);
      const byCause = {};
      for (const h of st.hurt) byCause[h.cause] = +((byCause[h.cause] ?? 0) + h.amount).toFixed(2);
      let worst = 0;
      for (const h of st.hurt) worst = Math.max(worst, st.hurt.filter((x) => x.t >= h.t && x.t < h.t + 1).reduce((s2, x) => s2 + x.amount, 0));
      const row = {
        result: st.result ?? 'timeout', t: +(st.t ?? MATCH_S).toFixed(1), hp: +st.hp.toFixed(2), npcHp: +st.npcHp.toFixed(2),
        worst1s: +worst.toFixed(2), firstHitAt: st.hurt[0] ? +st.hurt[0].t.toFixed(1) : null, byCause, npcTools: st.tools,
      };
      rows.push(row);
      console.log(`${style} #${m + 1}`, JSON.stringify(row));
    }
    const n = rows.length;
    summary[style] = {
      wins: rows.filter((r) => r.result === 'win').length, losses: rows.filter((r) => r.result === 'loss' || r.result === 'both').length,
      timeouts: rows.filter((r) => r.result === 'timeout').length,
      avgT: +(rows.reduce((s2, r) => s2 + r.t, 0) / n).toFixed(1),
      avgHpLeft: +(rows.reduce((s2, r) => s2 + r.hp, 0) / n).toFixed(2),
      worst1s: Math.max(...rows.map((r) => r.worst1s)),
      avgFirstHit: +(rows.filter((r) => r.firstHitAt != null).reduce((s2, r) => s2 + r.firstHitAt, 0) / Math.max(1, rows.filter((r) => r.firstHitAt != null).length)).toFixed(1),
    };
  }
  console.log('\nSUMMARY', JSON.stringify(summary, null, 1));
  if (errs.length) console.log('page errors', errs.slice(0, 5));
} finally {
  await b.close();
}

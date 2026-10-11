import { h } from '../ui/dom.js';
import { MODES, MODE_KEYS, TEAM_NAME, TEAM_CSS, KILLFEED_S, KILLFEED_MAX, styleOf } from './rules.js';
import { deathNotice, iconFor, KF_COLOR } from '../pov/killfeed.js';
import './game.css';

// The team game's screen, Halo's layout: the score, the clock and the
// objective top-centre (your team first and filled in, the other outlined, a
// bar under each filling toward the score to win: Halo 3's score meter, which
// sits bottom-right there; docs/halo-contract.md puts ours top-centre), the
// match's news under them; kills go to the shared killfeed top-right (GMod's,
// pov/killfeed.js); Tab holds up the scoreboard (GMod's, ui/scoreboard.js:
// index.js scoreboard() is its view). (No match menu: the gamemode is picked on
// the start menu, outside the game.) At the end, Halo 3's post-game carnage
// report (every player's kills, deaths and score) under Halo Infinite's Victory /
// Defeat banner, counting down to the next match, with Leave. While you're dead,
// who killed you with what and the respawn count; while the mouse isn't
// captured, "Click to play"; on the first spawn of a session, a card of the
// match's keys. update() only writes the DOM when a shown string changes.
// docs/halo-contract.md: this file owns top-centre and top-right; bottom-left
// is the motion tracker's and medals' (feel), the centre the reticle's (combat).

const CARD_S = 9;           // s the controls card stays up (long enough to read eight keys twice)
const CARD_FADE_S = 0.6;    // s it fades out (game.css .game-card transition)
const SCORE_LABEL_W = 52;   // px a scoreboard number column takes (game.css .game-line)

const key = (k) => h('kbd', { text: k });
export const clock = (s) => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// your team first (Halo puts yours on top); watching: the mode's order
const ordered = (teams, mine) => (mine && teams.includes(mine) ? [mine, ...teams.filter((t) => t !== mine)] : teams);
const dot = () => h('span.game-dot', { text: '·' });

// The controls card, per rule style (docs/halo-contract.md "Keys in a match").
// Halo's in-game prompts name the action, then the button.
const CARDS = {
  halo: [
    [['Click'], 'Shoot'], [['Right-click'], 'Zoom'], [['G'], 'Grenade'], [['F'], 'Melee'],
    [['1', '2'], 'or wheel: swap guns'], [['E'], 'Pick up'], [['Tab'], 'Scores'],
  ],
  tf2: [
    [['Click'], 'Shoot'], [['Right-click'], 'Alt-fire'], [['F'], 'Kick'], [['1–9'], 'or wheel: weapons'],
    [['E'], 'Use'], [[','], 'Class'], [['Tab'], 'Scores'],
  ],
};

export function createGameHud({ onLeave }) {
  // ---- top centre: the mode, both scores with their bars, the clock, the objective
  const modeName = h('div.game-mode');
  const teamBox = () => {
    const num = h('b'), fill = h('i');
    return { el: h('div.game-team', {}, num, h('div.game-team-bar', {}, fill)), num, fill };
  };
  const sideA = teamBox(), sideB = teamBox();
  const timer = h('div.game-timer');
  const objective = h('div.game-obj');
  const barFill = h('i'), bar = h('div.game-bar', {}, barFill);
  const top = h('div.game-top', {}, modeName, h('div.game-row', {}, sideA.el, timer, sideB.el), objective, bar);
  const feed = h('div.game-feed');


  // a match ended by hand: a line for a moment
  const endTitle = h('div.game-end-title'), endSub = h('div.game-end-sub');
  const end = h('div.game-end', {}, endTitle, endSub);

  // the carnage report: Victory / Defeat, the teams' tables, the countdown to the next match
  const repTitle = h('div.game-report-title'), repSub = h('div.game-report-sub');
  const repBody = h('div.game-cols');
  const repNext = h('b');
  const repFoot = h('div.game-report-foot', {},
    h('span.game-report-next', {}, 'Next match in ', repNext), dot(), key('Esc'), ' menu',
    h('button.game-leave', { type: 'button', on: { click: () => onLeave?.() } }, 'Leave'));
  const report = h('div.game-report.panel', {}, repTitle, repSub, repBody, repFoot);

  // while dead: who, with what, and the respawn count (Halo 3's death screen)
  const deathWho = h('div.game-death-who'), deathCount = h('b');
  const death = h('div.game-death', {}, deathWho, h('div.game-death-count', {}, 'Respawn in ', deathCount));

  // the mouse isn't captured: one click puts you in (pointer lock needs it)
  const play = h('div.game-play', {}, h('b', { text: 'Click to play' }), h('span', {}, key('Esc'), ' menu'));

  // the first spawn's controls card
  const card = h('div.game-card.panel');

  const root = h('div.game-hud', {}, top, feed, end, report, death, play, card);
  document.body.append(root);

  const shown = {};
  const set = (el, k, v) => { if (shown[k] !== v) { shown[k] = v; el.textContent = v; } };
  const toggle = (el, cls, on) => el.classList.toggle(cls, !!on);
  // the body's classes for the first-person HUD to give way (game.css): game-live while a match runs, game-on with the report too
  const bodyClass = (cls, on) => { if (shown[cls] !== on) { shown[cls] = on; document.body.classList.toggle(cls, on); } };
  const lines = [];
  let endUntil = -Infinity;
  let reportUntil = -Infinity, reportOn = false;
  let cardUntil = -Infinity;
  const cardsShown = new Set();   // the styles whose card this session has shown (once each)

  // the teams' columns: { teams, teamScore, roster, scoreLabel, myTeam, winner }, each team's
  // players by score; a medals column when any row has medals (a count: the feel agent's
  // medals.js may set it on the roster)
  function columns(d) {
    const medals = d.roster.some((r) => r.medals != null);
    const cols = medals ? `1fr ${SCORE_LABEL_W}px 28px 28px 28px` : '';
    return ordered(d.teams, d.myTeam).map((team) => {
      const rows = d.roster.filter((r) => r.team === team).sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
      const row = (cls, cells) => h(`div.game-line${cls}`, { style: cols ? { gridTemplateColumns: cols } : null }, cells.map((c) => h('span', { text: c })));
      return h(`div.game-col.${team}${d.winner === team ? '.won' : ''}${d.myTeam === team ? '.mine' : ''}`, {},
        h('div.game-col-head', {}, h('b', { text: `${TEAM_NAME[team]}${d.winner === team ? ' · winner' : ''}` }), h('span', { text: String(Math.floor(d.teamScore[team] ?? 0)) })),
        row('.head', ['Player', d.scoreLabel, 'K', 'D', ...(medals ? ['Med'] : [])]),
        rows.map((r) => row(r.me ? '.me' : '', [r.name, String(Math.floor(r.score)), String(r.kills), String(r.deaths), ...(medals ? [String(r.medals?.length ?? r.medals ?? 0)] : [])])));
    });
  }

  function line(el, now) {
    feed.prepend(el);
    lines.unshift({ el, at: now });
    while (lines.length > KILLFEED_MAX) lines.pop().el.remove();
  }

  return {
    get reportOpen() { return reportOn; },
    show(v) {
      root.classList.toggle('on', v);
      if (!v) for (const c of ['game-live', 'game-on', 'game-halo', 'game-reporting']) bodyClass(c, false);
    },
    // a kill for the killfeed: { killer, killerTeam, victim, victimTeam, cause, held } (no killer: a suicide or the world)
    kill(e) {
      deathNotice({
        attacker: e.killer, attackerColor: TEAM_CSS[e.killerTeam] ?? KF_COLOR.player,
        icon: iconFor(e.cause, e.held), victim: e.victim, victimColor: TEAM_CSS[e.victimTeam] ?? KF_COLOR.player,
      });
    },
    // a line across the screen for a moment (flag taken, hill moved, halftime)
    announce(text, now) { line(h('div.game-kill.note', { text }), now); },
    result(title, sub, now, holdS) { endTitle.textContent = title; endSub.textContent = sub; endUntil = now + holdS; },
    // the carnage report, up for holdS: r = { title, outcome ('win' | 'loss' | 'draw' | null), sub,
    // teams, teamScore, roster, scoreLabel, myTeam, winner }
    report(r, now, holdS) {
      repTitle.textContent = r.title;
      report.dataset.outcome = r.outcome ?? '';
      repSub.textContent = r.sub;
      repBody.replaceChildren(...columns(r));
      reportUntil = now + holdS;
    },
    closeReport() { reportUntil = -Infinity; },
    // the keys' card, once a session per rule style ('halo' | 'tf2')
    card(style, now) {
      if (cardsShown.has(style) || !CARDS[style]) return;
      cardsShown.add(style);
      card.replaceChildren(...CARDS[style].map(([keys, what]) => h('span', {}, ...keys.map(key), ` ${what}`)));
      cardUntil = now + CARD_S;
    },
    // st: { running, mode, style, teamScore, teams, myTeam, scoreToWin, timeLeft, objective, progress?, progressTeam?,
    //       roster, scoreLine, scoreLabel, now, locked, dead, respawnIn, death { killer, killerTeam, weapon, cause },
    //       nextIn (s to the next match, or null), menuUp (the start menu is over the game) }
    update(st) {
      const now = st.now;
      for (let i = lines.length - 1; i >= 0; i--) if (now - lines[i].at > KILLFEED_S) { lines[i].el.remove(); lines.splice(i, 1); }
      reportOn = now < reportUntil;
      bodyClass('game-live', st.running);
      bodyClass('game-halo', st.running && styleOf(st.mode) === 'halo');
      bodyClass('game-on', st.running || reportOn);
      bodyClass('game-reporting', reportOn);
      toggle(top, 'on', st.running);
      toggle(end, 'on', now < endUntil && !reportOn);
      toggle(report, 'on', reportOn);
      toggle(report, 'free', reportOn && !st.locked);   // the mouse is free: Leave can be clicked
      if (reportOn) set(repNext, 'next', st.nextIn != null ? String(Math.max(1, Math.ceil(st.nextIn))) : '');
      toggle(repFoot, 'nonext', st.nextIn == null);
      const dead = st.running && st.dead;
      toggle(death, 'on', dead);
      toggle(play, 'on', st.running && !st.locked && !dead && !st.menuUp);
      toggle(card, 'on', st.running && now < cardUntil);
      toggle(card, 'fading', now > cardUntil - CARD_FADE_S);
      if (st.running) {
        set(modeName, 'mode', MODES[st.mode].name);
        const [a, b] = ordered(st.teams, st.myTeam);
        for (const [box, team, k] of [[sideA, a, 'a'], [sideB, b, 'b']]) {
          const cls = `game-team ${team}${team === st.myTeam ? ' mine' : ''}${st.scoreToWin ? ' barred' : ''}`;
          if (shown[`${k}c`] !== cls) { shown[`${k}c`] = cls; box.el.className = cls; }
          const score = Math.floor(st.teamScore[team] ?? 0);
          set(box.num, k, String(score));
          const w = st.scoreToWin ? `${Math.round(Math.min(1, Math.max(0, score / st.scoreToWin)) * 100)}%` : '0%';
          if (shown[`${k}w`] !== w) { shown[`${k}w`] = w; box.fill.style.width = w; }
        }
        set(timer, 'timer', clock(st.timeLeft));
        set(objective, 'obj', st.objective ?? '');
        toggle(bar, 'on', st.progress != null);
        if (st.progress != null) {
          barFill.style.width = `${Math.round(Math.min(1, st.progress) * 100)}%`;
          barFill.style.background = TEAM_CSS[st.progressTeam] ?? '#e8e2d0';
        }
      }
      if (dead) {
        const d = st.death;
        const who = d?.killer ? `Killed by ${d.killer}${d.weapon ? ` · ${d.weapon}` : ''}` : d?.cause ?? '';
        if (shown.who !== who) {
          shown.who = who;
          deathWho.replaceChildren(...(d?.killer
            ? ['Killed by ', h('b', { text: d.killer, style: { color: TEAM_CSS[d.killerTeam] ?? '' } }), ...(d.weapon ? [h('span', { text: ` · ${d.weapon}` })] : [])]
            : [who]));
        }
        set(deathCount, 'respawn', String(Math.max(1, Math.ceil(st.respawnIn))));
      }
    },
  };
}

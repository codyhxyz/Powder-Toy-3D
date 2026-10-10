import { h } from '../ui/dom.js';
import { MODES, MODE_KEYS, TEAM_NAME, TEAM_CSS, KILLFEED_S, KILLFEED_MAX } from './rules.js';
import './game.css';

// The team game's screen, Halo's layout: the score, the clock and the
// objective top-centre; the killfeed top-right; Tab holds up the scoreboard; M
// opens the match menu (mode, side, Start/End: kept out of the main drawer);
// the result at the end. update() only writes the DOM when a shown string changes.

const key = (k) => h('kbd', { text: k });
const clock = (s) => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function createGameHud({ onStart, onEnd, onSide, onClose }) {
  const modeName = h('div.game-mode');
  const scoreRed = h('div.game-score.red'), scoreBlue = h('div.game-score.blue');
  const timer = h('div.game-timer');
  const objective = h('div.game-obj');
  const barFill = h('i'), bar = h('div.game-bar', {}, barFill);
  const top = h('div.game-top', {}, modeName, h('div.game-row', {}, scoreRed, timer, scoreBlue), objective, bar);
  const feed = h('div.game-feed');
  const chip = h('div.game-chip.panel', {}, key('M'), ' Match');

  // the scoreboard (Tab; also inside the menu)
  const boardBody = h('div.game-cols');
  const boardTitle = h('div.game-board-title');
  const board = h('div.game-board.panel', {}, boardTitle, boardBody, h('div.game-keys', {}, key('Tab'), ' scores', h('span.game-dot', { text: '·' }), key('.'), ' switch team', h('span.game-dot', { text: '·' }), key('M'), ' match menu'));

  // the match menu
  let chosen = 'slayer', side = 'auto';
  const modeBtns = MODE_KEYS.map((k) => h('button.game-pick', { type: 'button', on: { click: () => { chosen = k; sync(); } } },
    h('b', { text: MODES[k].name }), h('span', { text: MODES[k].desc })));
  const sideBtns = ['auto', 'red', 'blue', 'spectate'].map((s) => h('button.game-side', { type: 'button', 'data-side': s, on: { click: () => { side = s; sync(); onSide?.(s); } } },
    s === 'auto' ? 'Auto' : s === 'spectate' ? 'Watch' : TEAM_NAME[s]));
  const startBtn = h('button.game-go', { type: 'button', on: { click: () => onStart?.(chosen, side) } }, 'Start match');
  const endBtn = h('button.game-stop', { type: 'button', on: { click: () => onEnd?.() } }, 'End match');
  const menu = h('div.game-menu.panel', {},
    h('div.game-menu-head', {}, h('b', { text: 'Match' }), h('button.game-x', { type: 'button', 'aria-label': 'Close', on: { click: () => onClose?.() } }, '×')),
    h('div.game-picks', {}, modeBtns),
    h('div.game-sides', {}, h('span', { text: 'Side' }), sideBtns),
    h('div.game-actions', {}, startBtn, endBtn));
  function sync() {
    modeBtns.forEach((b, i) => b.classList.toggle('on', MODE_KEYS[i] === chosen));
    sideBtns.forEach((b) => b.classList.toggle('on', b.dataset.side === side));
  }
  sync();

  const endTitle = h('div.game-end-title'), endSub = h('div.game-end-sub');
  const end = h('div.game-end', {}, endTitle, endSub);

  const root = h('div.game-hud', {}, top, feed, chip, board, menu, end);
  document.body.append(root);

  const shown = {};
  const set = (el, k, v) => { if (shown[k] !== v) { shown[k] = v; el.textContent = v; } };
  const toggle = (el, cls, on) => el.classList.toggle(cls, !!on);
  const lines = [];
  let boardHeld = false, menuOpen = false, endUntil = -Infinity;

  function drawBoard(st) {
    const sig = JSON.stringify(st.roster.map((r) => [r.name, r.team, r.kills, r.deaths, r.score, r.me])) + st.scoreLine;
    if (shown.board === sig) return;
    shown.board = sig;
    boardTitle.textContent = st.scoreLine;
    boardBody.replaceChildren(...st.teams.map((team) => {
      const rows = st.roster.filter((r) => r.team === team).sort((a, b) => b.score - a.score || b.kills - a.kills);
      return h(`div.game-col.${team}`, {},
        h('div.game-col-head', {}, h('b', { text: TEAM_NAME[team] }), h('span', { text: String(st.teamScore[team] ?? 0) })),
        h('div.game-line.head', {}, h('span', { text: 'Player' }), h('span', { text: st.scoreLabel }), h('span', { text: 'K' }), h('span', { text: 'D' })),
        rows.map((r) => h(`div.game-line${r.me ? '.me' : ''}`, {}, h('span', { text: r.name }), h('span', { text: String(Math.floor(r.score)) }), h('span', { text: String(r.kills) }), h('span', { text: String(r.deaths) }))));
    }));
  }

  return {
    get menuOpen() { return menuOpen; },
    show(v) { root.classList.toggle('on', v); },
    holdBoard(v) { boardHeld = v; },
    setMenu(v) { menuOpen = v; },
    choose(mode) { chosen = mode; sync(); },
    // a killfeed line: { killer, killerTeam, victim, victimTeam, cause }
    kill(e, now) {
      const el = h('div.game-kill', {},
        e.killer ? h('b', { text: e.killer, style: { color: TEAM_CSS[e.killerTeam] ?? '' } }) : null,
        h('span', { text: e.killer ? ` ${e.verb ?? 'killed'} ` : '' }),
        h('b', { text: e.victim, style: { color: TEAM_CSS[e.victimTeam] ?? '' } }),
        e.killer ? null : h('span', { text: ` ${e.cause ? e.cause.toLowerCase() : 'died'}` }));
      feed.prepend(el);
      lines.unshift({ el, at: now });
      while (lines.length > KILLFEED_MAX) lines.pop().el.remove();
    },
    // a line across the screen for a moment (flag taken, hill moved, halftime)
    announce(text, now) {
      const el = h('div.game-kill.note', { text });
      feed.prepend(el);
      lines.unshift({ el, at: now });
      while (lines.length > KILLFEED_MAX) lines.pop().el.remove();
    },
    result(title, sub, now, holdS) { endTitle.textContent = title; endSub.textContent = sub; endUntil = now + holdS; },
    // st: { running, mode, teamScore, timeLeft, objective, progress?, progressTeam?, roster, teams, scoreLine, scoreLabel, now }
    update(st) {
      const now = st.now;
      for (let i = lines.length - 1; i >= 0; i--) if (now - lines[i].at > KILLFEED_S) { lines[i].el.remove(); lines.splice(i, 1); }
      toggle(top, 'on', st.running);
      toggle(chip, 'on', !st.running && !menuOpen && now >= endUntil);
      toggle(end, 'on', now < endUntil);
      toggle(menu, 'on', menuOpen);
      toggle(board, 'on', (boardHeld || menuOpen) && (st.running || st.roster.length));
      toggle(endBtn, 'off', !st.running);
      startBtn.textContent = st.running ? 'Restart' : 'Start match';
      if (st.running) {
        set(modeName, 'mode', MODES[st.mode].name);
        const [a, b] = st.teams;
        scoreRed.className = `game-score ${a}`; scoreBlue.className = `game-score ${b}`;
        set(scoreRed, 'a', `${Math.floor(st.teamScore[a] ?? 0)}`);
        set(scoreBlue, 'b', `${Math.floor(st.teamScore[b] ?? 0)}`);
        set(timer, 'timer', clock(st.timeLeft));
        set(objective, 'obj', st.objective ?? '');
        toggle(bar, 'on', st.progress != null);
        if (st.progress != null) {
          barFill.style.width = `${Math.round(Math.min(1, st.progress) * 100)}%`;
          barFill.style.background = TEAM_CSS[st.progressTeam] ?? '#e8e2d0';
        }
      }
      if ((boardHeld || menuOpen)) drawBoard(st);
    },
  };
}

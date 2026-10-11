import { h } from '../ui/dom.js';
import { MODES, MODE_KEYS, TEAM_NAME, TEAM_CSS, KILLFEED_S, KILLFEED_MAX } from './rules.js';
import { deathNotice, iconFor, KF_COLOR } from '../pov/killfeed.js';
import './game.css';

// The team game's screen, Halo's layout: the score, the clock and the
// objective top-centre, the match's news under them; kills go to the shared
// killfeed top-right (GMod's, pov/killfeed.js); Tab holds up the scoreboard
// (GMod's, ui/scoreboard.js: index.js scoreboard() is its view); M opens the
// match menu (mode, side, Start/End: kept out of the main drawer); the result
// at the end. update() only writes the DOM when a shown string changes.

const key = (k) => h('kbd', { text: k });
export const clock = (s) => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function createGameHud({ onStart, onEnd, onSide, onClose }) {
  const modeName = h('div.game-mode');
  const scoreRed = h('div.game-score.red'), scoreBlue = h('div.game-score.blue');
  const timer = h('div.game-timer');
  const objective = h('div.game-obj');
  const barFill = h('i'), bar = h('div.game-bar', {}, barFill);
  const top = h('div.game-top', {}, modeName, h('div.game-row', {}, scoreRed, timer, scoreBlue), objective, bar);
  const feed = h('div.game-feed');
  const chip = h('div.game-chip.panel', {}, key('M'), ' Match');

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

  const root = h('div.game-hud', {}, top, feed, chip, menu, end);
  document.body.append(root);

  const shown = {};
  const set = (el, k, v) => { if (shown[k] !== v) { shown[k] = v; el.textContent = v; } };
  const toggle = (el, cls, on) => el.classList.toggle(cls, !!on);
  const lines = [];
  let menuOpen = false, endUntil = -Infinity;

  return {
    get menuOpen() { return menuOpen; },
    show(v) { root.classList.toggle('on', v); },
    setMenu(v) { menuOpen = v; },
    choose(mode) { chosen = mode; sync(); },
    // a kill for the killfeed: { killer, killerTeam, victim, victimTeam, cause, held } (no killer: a suicide or the world)
    kill(e) {
      deathNotice({
        attacker: e.killer, attackerColor: TEAM_CSS[e.killerTeam] ?? KF_COLOR.player,
        icon: iconFor(e.cause, e.held), victim: e.victim, victimColor: TEAM_CSS[e.victimTeam] ?? KF_COLOR.player,
      });
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
    },
  };
}

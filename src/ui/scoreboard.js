import { h } from './dom.js';
import { povEvents } from '../pov/events.js';
import { PLAYER } from '../pov/targets.js';
import './scoreboard.css';

// The scoreboard, held up while Tab is down: Garry's Mod's base gamemode's
// (gamemodes/base/gamemode/cl_scoreboard.lua, shown on +showscores and hidden
// on its release). The server's name big at the top (here the map's), then a
// light row per player: avatar, name, kills, deaths and ping, a bot's ping
// reading BOT, a dead player's row pink, the host's (GMod's admin) green. The
// layout, sizes and colours are GMod's (scoreboard.css); the code is a rewrite
// (Facepunch's Lua carries no licence).
//
// What it lists:
//   a team game (src/game, while a match runs): its roster, bots and all, each
//     row edged in its team's colour, and under the map's name the mode's score
//     line (game.scoreboard())
//   the sandbox: you and the people playing with you (src/net/multiplayer.js
//     players), your kills and deaths counted from the killfeed's povEvents 'kill'
//
// opts: wantsTab(e) whether Tab is the scoreboard's now (not typing, not moving
// through a dialog); map() the map's name; match() the team game's scoreboard
// view while one runs, else null; session() the multiplayer players ([] solo);
// dead() whether your body is dead now.

// ---- GMod's numbers: the order (PLAYER_LINE Think)
// Rows are docked in z order, z = kills × −50 + deaths + the player's index: the
// most kills first, then the fewest deaths, then who joined first.
const Z_PER_KILL = -50;

// ---- ours
const HOST_NAME = 'Powder Toy 3D';   // the title when the grid is no map's (an old save, a link's ?size=)
const SANDBOX = 'Sandbox';           // the gamemode's name, under the title (maps.js GAMEMODES)
const YOU = 'You';                   // the killfeed's and the team games' name for the player
const YOU_COLOR = 'rgb(255, 255, 100)';   // your avatar outside a team: GMod's colour for a player in no team (team.lua)
const DOT = ' · ';

export function createScoreboard({ wantsTab, map, match, session, dead }) {
  // ---- the sandbox's books: GMod's DoPlayerDeath (base/gamemode/init.lua) adds a
  // death, and a frag to the killer, or takes one back from a suicide. GMod's base
  // counts only kills of other players; the sandbox has no other players to kill
  // (guests can't drop in yet), so its creatures count.
  const mine = { kills: 0, deaths: 0 };
  povEvents.on('kill', (e) => {
    if (e.team) return;   // a team game keeps its own roster (src/game)
    if (e.id === PLAYER) { mine.deaths++; if (e.self) mine.kills--; }
    else if (e.by === PLAYER) mine.kills++;
  });

  const title = h('div.sb-host');
  const sub = h('div.sb-sub');
  const head = h('div.sb-row.sb-head');
  const list = h('div.sb-list');
  const foot = h('div.sb-foot');
  const root = h('div.sb', { 'aria-hidden': 'true' }, h('div.sb-header', {}, title, sub), head, list, foot);
  document.body.append(root);

  let shown = false, raf = 0, drawn = '';

  function sandbox() {
    const players = session();
    const meP = players.find((p) => p.you);
    const rows = [{
      key: 'me', name: YOU, avatar: meP?.color ?? YOU_COLOR, kills: mine.kills, deaths: mine.deaths,
      ping: meP ? meP.ping : 0, dead: dead(), me: true, admin: meP?.role === 'host' && players.length > 1,
    }];
    players.filter((p) => !p.you).forEach((p) => rows.push({
      key: p.id, name: p.name, avatar: p.color, kills: p.kd?.[0] ?? 0, deaths: p.kd?.[1] ?? 0,
      ping: p.ping, dead: false, me: false, admin: p.role === 'host',
    }));
    const n = rows.length;
    return { host: map() ?? HOST_NAME, sub: [SANDBOX, `${n} ${n === 1 ? 'player' : 'players'}`], rows, scoreLabel: null, foot: '' };
  }

  function view() {
    const m = match();
    const v = m ? { host: map() ?? m.map ?? HOST_NAME, ...m } : sandbox();
    v.rows = v.rows.map((r, i) => ({ ...r, z: r.kills * Z_PER_KILL + r.deaths + i }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.z - b.z);   // a mode's score first (TF2's board), then GMod's order
    return v;
  }

  const cell = (v) => h('span.sb-n', { text: v == null ? '' : String(v) });
  function draw() {
    const v = view();
    const sig = JSON.stringify(v);
    if (sig === drawn) return;
    drawn = sig;
    title.textContent = v.host;
    sub.textContent = v.sub.filter(Boolean).join(DOT);
    foot.textContent = v.foot ?? '';
    const cols = v.scoreLabel ? ['Kills', 'Deaths', v.scoreLabel, 'Ping'] : ['Kills', 'Deaths', 'Ping'];
    root.style.setProperty('--sb-cols', String(cols.length));
    head.replaceChildren(h('span'), h('span.sb-name', { text: 'Name' }), ...cols.map((c) => h('span.sb-n', { text: c })));
    list.replaceChildren(...v.rows.map((r) => h(`div.sb-row${r.dead ? '.dead' : ''}${r.admin ? '.admin' : ''}${r.me ? '.me' : ''}${r.team ? '.team' : ''}`,
      { style: { '--sb-avatar': r.avatar ?? YOU_COLOR, '--sb-team': r.team ?? 'transparent' } },
      h('i.sb-avatar'), h('span.sb-name', { text: r.name }),
      cell(r.kills), cell(r.deaths), v.scoreLabel ? cell(r.score) : null, cell(r.ping))));
  }

  function frame() {
    raf = 0;
    if (!shown) return;
    draw();
    raf = requestAnimationFrame(frame);   // GMod's Think: every frame while it shows
  }
  function show(v) {
    if (shown === v) return;
    shown = v;
    root.classList.toggle('on', v);
    document.body.classList.toggle('sb-on', v);   // (what it covers can step aside: game.css)
    if (v) { drawn = ''; frame(); } else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  // +showscores / -showscores
  addEventListener('keydown', (e) => {
    if (e.code !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey || !wantsTab(e)) return;
    e.preventDefault();
    show(true);
  });
  addEventListener('keyup', (e) => { if (e.code === 'Tab') show(false); });
  addEventListener('blur', () => show(false));

  return {
    get shown() { return shown; },
    show,
    // your sandbox kills and deaths ([kills, deaths]: multiplayer sends the host's to its guests)
    get mine() { return [mine.kills, mine.deaths]; },
    // a new map: GMod's frags start over with the server
    reset() { mine.kills = 0; mine.deaths = 0; },
  };
}

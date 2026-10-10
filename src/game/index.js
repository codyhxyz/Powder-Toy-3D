import * as THREE from 'three';
import { povEvents } from '../pov/events.js';
import { setHitRules, targetById, PLAYER } from '../pov/targets.js';
import { CLASS } from '../pov/classes.js';
import { BODY_HEIGHT } from '../pov/constants.js';
import { ELEMENTS, E, K } from '../elements.js';
import * as R from './rules.js';
import { labLayout, fitLayout } from './layout.js';
import { ObjectiveEvaluator, WANT, NEAR } from './bots.js';
import { createMarkers } from './markers.js';
import { createGameHud } from './hud.js';

// Team games in first person: Halo's Team Slayer, Capture the Flag, King of
// the Hill and Infection, and a Siege (TF2's attack/defend with a halftime
// swap). Teams of bots (npc.js: the player's body, tools and a Yuka brain) on
// both sides, the player on one of them. docs/modes.md has the rules.
//
//   game.start(mode, opts)   'slayer' | 'ctf' | 'koth' | 'infection' | 'siege';
//                            opts: { side: 'auto' | 'red' | 'blue' | 'spectate', teamSize, ...rule overrides }
//   game.end()               stop now (no winner)
//   game.useLayout(layout)   a map's spawns, flags, hills and core (layout.js); none: the lab's
//   game.state               what the HUD shows (checks read it)
//
// Every body carries body.team ('red' | 'blue' | 'infected' | null); other
// modules (vehicles, classes) read it. Blows through targets.js don't hurt
// teammates (setHitRules); the sim's damage (fire, blasts, lava) can't tell
// teams apart and hurts everyone. Events on povEvents: game:start, game:end,
// game:kill, game:flag, game:hill, game:infected, game:half, game:team.
//
// shell (pov/index.js): { app, scene, renderer, camera, player, toolbelt,
//   loadNpcs() → Promise<{ mod, ai }>, env(), loadPreset(), respawnPlayer(at), freeMouse() }

const CARRIER_PRIORITY = 30;         // cells: a bot goes after the enemy carrying its flag as if they were this much nearer
const ESCORT_R = 6;                  // cells: escorts keep this near the carrier
const DEFEND_R = 8;                  // cells: defenders keep this near their stand
const ROLES = ['attack', 'defend'];  // CTF roles, dealt in turn (Raven's / Quake III's team orders)
const FLAG_LIFT = 2;                 // cells above a carrier's feet the flag rides
const SPAWN_LIFT_MAX = 40;           // cells a spawn rises at most to clear what has fallen on its point (a heap of sand)
const BOT_MS_EASE = 0.05;            // the bots' CPU time per frame is shown as this running average (checks)
const ROAM_S = 30;                   // s a Slayer bot heads for one stretch of open ground before the next
const other = (t) => (t === 'red' ? 'blue' : 'red');
const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const v3 = ([x, y, z]) => new THREE.Vector3(x, y, z);
const label = (k) => R.TEAM_NAME[k] ?? k;

export function createGame(shell) {
  const { app } = shell;
  let userLayout = null, layout = null;
  let running = false, mode = null, rules = null;
  let time = 0, ends = 0;           // the game clock (s, runs while in first person) and when this (half) ends
  let side = 'auto';
  const roster = new Map();          // id → { id, name, team, bot, body, kills, deaths, score, role, wasDead, protect, lastHit }
  const teamScore = {};
  let teams = R.TEAMS;
  let flags = null, hill = null, siege = null;
  let npc = null;
  let starting = null;
  let visible = true;
  let botMs = 0;
  const markers = createMarkers({ scene: shell.scene, getVolume: app.getVolume, getScale: app.getScale });
  const hud = createGameHud({
    onStart: (m, s) => { side = s; menu(false); start(m, { side: s }); },
    onEnd: () => { menu(false); end(); },
    onSide: (s) => { side = s; if (running && (s === 'red' || s === 'blue')) switchTeam(s); },
    onClose: () => menu(false),
  });
  const now = () => performance.now() / 1000;
  const sim = () => app.getSim();

  // ---------------------------------------------------------------- roster
  const me = () => roster.get(PLAYER) ?? null;
  const bodyOf = (e) => (e.bot ? e.bot.body : shell.player);
  const alive = (e) => !!targetById(e.id)?.alive;
  const bots = () => [...roster.values()].filter((e) => e.bot);
  const members = (team) => [...roster.values()].filter((e) => e.team === team);
  const carrying = (e) => !!flags && Object.values(flags).some((f) => f.carrier === e.id);

  function entry(id, name, team, bot = null) {
    const e = { id, name, team, bot, kills: 0, deaths: 0, score: 0, role: null, wasDead: false, protect: 0, lastHit: null };
    roster.set(id, e);
    return e;
  }

  // a body's side: its colour, and what it may do on it
  const WEAPONS = { infected: new Set(R.INFECTED_WEAPONS), carrier: new Set(R.CARRIER_WEAPONS) };
  function setTeam(e, team) {
    e.team = team;
    const b = bodyOf(e);
    if (b) { b.team = team; pace(e, b); }
    if (e.bot && team) e.bot.tint(R.TEAM_LOOK[team]);
    povEvents.emit('game:team', { id: e.id, team });
  }
  // an infected runs faster than its class (classes.js sets body.speedScale on every spawn)
  const classSpeed = (b) => CLASS[b.cls]?.body?.speed ?? 1;
  function pace(e, b) {
    const want = classSpeed(b) * (e.team === R.INFECTED ? R.INFECTED_SPEED : 1);
    if (b.speedScale !== want) b.speedScale = want;
  }
  function loadout(e) {
    if (!e.bot) return;
    const want = e.team === R.INFECTED ? WEAPONS.infected : carrying(e) ? WEAPONS.carrier : null;
    if (e.bot.agent.weapons !== want) e.bot.agent.weapons = want;
  }

  // who a bot fights: everyone alive on another side; a flag carrier, and
  // Infection's last survivor, show up wherever they are (Halo's waypoints)
  function opponentsOf(e) {
    const out = [];
    const humansLeft = mode === 'infection' ? members(R.HUMANS).length : 0;
    for (const o of roster.values()) {
      if (o === e || !o.team || o.team === e.team) continue;
      const b = bodyOf(o);
      if (!b) continue;
      const carrier = carrying(o);
      out.push({
        id: o.id, pos: b.pos, vel: b.vel, alive: alive(o),
        holding: o.bot ? o.bot.agent.intent.tool : shell.toolbelt?.selectedKey ?? null,
        reveal: carrier || (R.LAST_HUMAN_REVEAL && humansLeft === 1 && o.team === R.HUMANS),
        priority: carrier ? CARRIER_PRIORITY : 0,
      });
    }
    return out;
  }

  // Halo's spawn choice: of the side's points, the one farthest from the
  // nearest living enemy, a little jittered so bodies don't land on each other
  function spawnFor(e) {
    let pts = layout.spawns[e.team] ?? [...layout.spawns.red, ...layout.spawns.blue];
    if (mode === 'siege') pts = layout.spawns[e.team === siege.attackers ? layout.siege.attackers : other(layout.siege.attackers)];
    if (mode === 'infection') pts = [...layout.spawns.red, ...layout.spawns.blue];
    const foes = [...roster.values()].filter((o) => o.team && o.team !== e.team && alive(o)).map((o) => bodyOf(o).pos);
    let best = pts[0], bd = -Infinity;
    for (const p of pts) {
      const d = foes.length ? Math.min(...foes.map((f) => Math.hypot(f.x - p[0], f.z - p[2]))) : Math.random();
      if (d > bd) { bd = d; best = p; }
    }
    const g = sim().g, a = Math.random() * Math.PI * 2, r = Math.random() * R.SPAWN_JITTER;
    const x = THREE.MathUtils.clamp(best[0] + Math.cos(a) * r, 2, g.nx - 2), z = THREE.MathUtils.clamp(best[2] + Math.sin(a) * r, 2, g.nz - 2);
    return new THREE.Vector3(x, clearAt(x, best[1], z), z);
  }
  // the lowest height from y up where a body fits (the world model's copy of the cells), so
  // nobody spawns inside a heap; a roof over the point stays a roof
  const open = (i) => i === E.EMPTY || ELEMENTS[i]?.kind === K.GAS || ELEMENTS[i]?.kind === K.LIQUID;
  function clearAt(x, y, z) {
    const w = npc?.ai?.world;
    if (!w?.ready) return y;
    const fx = Math.floor(x), fz = Math.floor(z), top = sim().g.ny - BODY_HEIGHT - 1;
    for (let yy = Math.floor(y); yy <= Math.min(y + SPAWN_LIFT_MAX, top); yy++) {
      let free = true;
      for (let k = 0; k < Math.ceil(BODY_HEIGHT) && free; k++) free = open(w.id(fx, yy + k, fz));
      if (free) return yy;
    }
    return y;
  }

  function addBot(team, name) {
    let e = null;
    const n = npc.mod.createNpc({
      env: shell.env(), ai: npc.ai, team, name, respawnS: R.RESPAWN_S,
      opponents: () => opponentsOf(e),
      home: () => spawnFor(e),
    });
    e = entry(n.id, name, team, n);
    n.agent.radar = R.RADAR;
    n.agent.brain.addEvaluator(new ObjectiveEvaluator(() => objectiveFor(e)));
    shell.scene.add(n.root);
    n.bind(app.getVolume(), sim().g);
    n.compile(shell.renderer, shell.camera, shell.scene);
    setTeam(e, team);
    return e;
  }
  function removeBots() {
    for (const e of bots()) { shell.scene.remove(e.bot.root); e.bot.dispose(); roster.delete(e.id); }
  }

  function spawnAll() {
    for (const e of roster.values()) {
      e.protect = R.SPAWN_PROTECT_S; e.lastHit = null; e.wasDead = false;
      if (e.bot) e.bot.placeAt(spawnFor(e));
      else if (e.team) shell.respawnPlayer(spawnFor(e));
    }
  }

  // ---------------------------------------------------------------- the match
  const hitRules = {
    // a teammate (or someone watching) lets the blow through
    passes(by, t) {
      const a = roster.get(by), b = roster.get(t.id);
      return !!b && (!b.team || (!!a?.team && a.team === b.team));
    },
    share(by, t) {
      const v = roster.get(t.id);
      if (!v) return 1;
      if (!v.team || v.protect > 0) return 0;
      const a = roster.get(by);
      if (a?.team === v.team) return 0;
      return a?.team === R.INFECTED ? R.INFECTED_MELEE : 1;
    },
  };

  async function start(m, opts = {}) {
    if (!R.MODES[m]) throw new Error(`game: no mode '${m}'`);
    if (!shell.player || !sim()) { app.hud?.toast?.('Drop in first (F), then start a match'); return false; }
    if (starting) return starting;
    starting = (async () => {
      if (running) stop();
      npc ??= await shell.loadNpcs();
      const g = sim().g;
      layout = fitLayout(userLayout ?? app.getArena?.(), g) ?? labLayout(g);   // useLayout's, the loaded arena's (Dam Valley), else the lab's
      mode = m;
      rules = { ...R.MODES[m], ...opts };
      side = opts.side ?? side;
      time = 0; ends = rules.timeLimit;
      for (const k of Object.keys(teamScore)) delete teamScore[k];
      roster.clear();
      teams = m === 'infection' ? [R.HUMANS, R.INFECTED] : R.TEAMS;
      const size = rules.teamSize ?? R.TEAM_SIZE;

      // the player: on the side asked for, else the one with fewer people (auto-balance; a coin toss when even)
      const watching = side === 'spectate';
      const mine = m === 'infection' ? R.HUMANS : side === 'red' || side === 'blue' ? side : Math.random() < 0.5 ? 'red' : 'blue';
      const pe = entry(PLAYER, 'You', watching ? null : mine);
      setTeam(pe, pe.team);
      // bots fill both sides to the team size
      let n = 0;
      const name = () => R.BOT_NAMES[n++ % R.BOT_NAMES.length];
      if (m === 'infection') {
        for (let i = watching ? 0 : 1; i < 2 * size; i++) addBot(R.HUMANS, name());
      } else {
        for (const t of R.TEAMS) for (let i = pe.team === t ? 1 : 0; i < size; i++) addBot(t, name());
      }
      for (const t of teams) teamScore[t] = 0;
      // CTF roles: half of each side goes for the flag, half guards theirs
      for (const t of R.TEAMS) members(t).filter((e) => e.bot).forEach((e, i) => { e.role = ROLES[i % ROLES.length]; });

      // the round: a fresh scene, the objectives, everyone at their spawns
      shell.loadPreset();
      flags = null; hill = null; siege = null;
      markers.clear();
      if (m === 'ctf') {
        flags = {};
        for (const t of R.TEAMS) flags[t] = { team: t, home: v3(layout.flags[t]), pos: v3(layout.flags[t]), state: 'home', carrier: null, droppedAt: 0 };
        markers.flags(layout);
      }
      if (m === 'koth') { hill = { i: -1, owner: null, contested: false }; moveHill(); }
      if (m === 'siege') {
        siege = { half: 1, attackers: layout.siege.attackers, held: 0, halfStart: 0, results: [] };
        const [x, y, z, r] = layout.siege.core;
        markers.zone({ x, y, z, r });
      }
      if (m === 'infection') for (const e of pick([...roster.values()].filter((o) => o.team), rules.alphas)) setTeam(e, R.INFECTED);
      setHitRules(hitRules);
      running = true;
      spawnAll();
      count();
      povEvents.emit('game:start', { mode: m, layout: layout.name, teams: Object.fromEntries(teams.map((t) => [t, members(t).map((e) => e.id)])) });
      hud.announce(`${rules.name}${pe.team ? `: you're on ${label(pe.team)}` : ''}`, now());
      hud.choose(m);
      return true;
    })();
    try { return await starting; } finally { starting = null; }
  }

  function pick(list, k) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, k);
  }

  // stop without a result
  function stop() {
    running = false;
    removeBots();
    const p = me();
    roster.clear();
    if (shell.player) { shell.player.team = null; shell.player.speedScale = classSpeed(shell.player); }
    setHitRules(null);
    markers.clear();
    flags = hill = siege = null;
    return p;
  }

  function end(winner = undefined, why = '') {
    if (!running) return;
    const p = me();
    const result = { mode, winner: winner ?? null, score: { ...teamScore }, why, roster: board() };
    if (winner !== undefined) {
      const title = winner ? `${label(winner)} ${winner === R.INFECTED ? 'win' : 'wins'}` : 'Draw';   // (the Infected win)
      const you = p?.team ? (winner === p.team ? 'You win. ' : winner ? 'You lose. ' : '') : '';
      hud.result(title, `${you}${why}`, now(), R.END_SCREEN_S);
    } else hud.result('Match ended', '', now(), R.END_SCREEN_S / 2);
    povEvents.emit('game:end', result);
    stop();
    lastResult = result;
    return result;
  }
  let lastResult = null;

  // ---------------------------------------------------------------- deaths and kills
  povEvents.on('body:hit', (e) => {
    if (!running) return;
    const v = roster.get(e.id), by = e.by ?? PLAYER;
    if (v && by !== v.id) v.lastHit = { by, at: time };
  });
  const near = (by, point, r) => {
    for (const v of roster.values()) {
      const b = bodyOf(v);
      if (b && v.id !== by && b.pos.distanceTo(point) < r) v.lastHit = { by, at: time };
    }
  };
  povEvents.on('blast', (e) => { if (running && e.point) near(e.by ?? PLAYER, e.point, R.BLAST_CREDIT_R); });
  povEvents.on('tool:action', (e) => {
    if (!running || e.tool !== 'blowtorch' || e.action !== 'on') return;
    const from = e.from ?? shell.player?.pos;
    if (from) near(e.by ?? PLAYER, from, R.TORCH_CREDIT_R);
  });

  function died(v) {
    v.deaths++;
    const h = v.lastHit;
    let k = h && time - h.at <= R.KILL_CREDIT_S ? roster.get(h.by) : null;
    if (k && (!k.team || k.team === v.team)) k = null;   // a teammate's bomb, say: a betrayal counts as a suicide
    if (k) k.kills++;
    v.lastHit = null;
    const cause = bodyOf(v)?.cause ?? '';
    const e = { killer: k?.name ?? null, killerTeam: k?.team ?? null, victim: v.name, victimTeam: v.team, cause, by: k?.id ?? null, id: v.id };
    hud.kill(e, now());
    povEvents.emit('game:kill', e);
    // the mode's part
    if (mode === 'slayer') {
      if (k) { teamScore[k.team]++; k.score++; }
      else if (v.team) teamScore[v.team] -= R.SUICIDE_PENALTY;
    }
    if (mode === 'infection') {
      if (k) k.score++;
      if (v.team === R.HUMANS) {
        setTeam(v, R.INFECTED);
        povEvents.emit('game:infected', { id: v.id, by: k?.id ?? null });
        hud.announce(`${v.name} ${v.id === PLAYER ? 'are' : 'is'} infected`, now());
      }
    }
    if (mode === 'ctf') {
      for (const f of Object.values(flags)) if (f.carrier === v.id) dropFlag(f, bodyOf(v).pos);
    }
  }

  // ---------------------------------------------------------------- CTF
  const touching = (b, p) => hdist(b.pos, p) < R.TOUCH_R && Math.abs(b.pos.y - p.y) < R.TOUCH_UP;
  function flagEvent(f, action, e) {
    povEvents.emit('game:flag', { team: f.team, action, by: e?.id ?? null });
    const who = e ? `${e.name} ` : '';
    const text = { taken: `${who}took the ${label(f.team)} flag`, dropped: `${label(f.team)} flag dropped`,
      returned: `${who}${e ? 'returned' : ''}${e ? ' the ' : ''}${label(f.team)} flag${e ? '' : ' returned'}`, captured: `${who}captured the ${label(f.team)} flag` }[action];
    hud.announce(text, now());
  }
  function dropFlag(f, at) {
    f.state = 'dropped'; f.carrier = null; f.droppedAt = time;
    f.pos.set(at.x, at.y, at.z);
    flagEvent(f, 'dropped');
  }
  function homeFlag(f) { f.state = 'home'; f.carrier = null; f.pos.copy(f.home); }
  function tickCtf() {
    for (const f of Object.values(flags)) {
      if (f.state === 'carried') {
        const c = roster.get(f.carrier);
        if (!c) { homeFlag(f); continue; }
        const b = bodyOf(c);
        f.pos.set(b.pos.x, b.pos.y + FLAG_LIFT, b.pos.z);
        const mine = flags[c.team];
        if (mine.state === 'home' && touching(b, mine.home)) {
          teamScore[c.team]++; c.score++;
          flagEvent(f, 'captured', c);
          homeFlag(f);
        }
        continue;
      }
      if (f.state === 'dropped' && time - f.droppedAt > R.FLAG_RESET_S) { homeFlag(f); flagEvent(f, 'returned'); continue; }
      for (const e of roster.values()) {
        if (!e.team || !alive(e)) continue;
        const b = bodyOf(e);
        if (!touching(b, f.pos)) continue;
        if (e.team !== f.team && !carrying(e)) { f.state = 'carried'; f.carrier = e.id; flagEvent(f, 'taken', e); break; }
        if (e.team === f.team && f.state === 'dropped') { homeFlag(f); flagEvent(f, 'returned', e); break; }
      }
    }
  }

  // ---------------------------------------------------------------- zones (KOTH's hill, Siege's core)
  const zoneOf = ([x, y, z, r]) => ({ x, y, z, r });
  function inZone(b, z) { return hdist(b.pos, z) < z.r && b.pos.y - z.y > -1 && b.pos.y - z.y < R.ZONE_UP; }
  function teamsIn(z) {
    const s = new Set();
    for (const e of roster.values()) if (e.team && alive(e) && inZone(bodyOf(e), z)) s.add(e.team);
    return s;
  }
  function moveHill() {
    const i = Math.floor(time / rules.hillMoveS) % layout.hills.length;
    if (i === hill.i) return;
    const first = hill.i < 0;
    hill.i = i;
    hill.zone = zoneOf(layout.hills[i]);
    markers.zone(hill.zone);
    povEvents.emit('game:hill', { index: i, at: hill.zone });
    if (!first) hud.announce('The hill moved', now());
  }
  function tickKoth(dt) {
    moveHill();
    const s = teamsIn(hill.zone);
    hill.contested = s.size > 1;
    hill.owner = s.size === 1 ? [...s][0] : null;
    if (hill.owner) {
      teamScore[hill.owner] += dt;
      for (const e of members(hill.owner)) if (alive(e) && inZone(bodyOf(e), hill.zone)) e.score += dt;
    }
  }

  function tickSiege(dt) {
    const core = zoneOf(layout.siege.core);
    const s = teamsIn(core);
    siege.contested = s.has(siege.attackers) && s.size > 1;
    siege.owner = s.size === 1 ? [...s][0] : null;
    if (siege.owner === siege.attackers) {
      siege.held += dt;
      teamScore[siege.attackers] += dt;
      for (const e of members(siege.attackers)) if (alive(e) && inZone(bodyOf(e), core)) e.score += dt;
    }
    if (siege.held >= rules.holdToWin) halfOver(true);
    else if (time >= ends) halfOver(false);
  }
  function halfOver(captured) {
    siege.results.push({ attackers: siege.attackers, captured, time: time - siege.halfStart, held: siege.held });
    const r = siege.results.at(-1);
    povEvents.emit('game:half', { half: siege.half, ...r });
    if (siege.half === 1) {
      hud.announce(`${label(r.attackers)} ${captured ? `took the core in ${Math.round(r.time)} s` : `held it ${Math.round(r.held)} s`}. Halftime: sides swap`, now());
      siege.half = 2; siege.attackers = other(siege.attackers); siege.held = 0; siege.halfStart = time;
      ends = time + rules.timeLimit;
      shell.loadPreset();
      spawnAll();
      return;
    }
    // TF2's stopwatch: a capture beats none; two captures, the faster; none, the longer hold
    const [a, b] = siege.results;
    let w = null;
    if (a.captured !== b.captured) w = a.captured ? a.attackers : b.attackers;
    else if (a.captured) w = a.time < b.time ? a.attackers : b.time < a.time ? b.attackers : null;
    else w = a.held > b.held ? a.attackers : b.held > a.held ? b.attackers : null;
    const say = (x) => `${label(x.attackers)} ${x.captured ? `capped in ${Math.round(x.time)} s` : `held ${Math.round(x.held)} s`}`;
    end(w, `${say(a)}, ${say(b)}`);
  }

  // ---------------------------------------------------------------- what bots go for
  function objectiveFor(e) {
    if (!running || !e.team) return null;
    const b = bodyOf(e);
    if (mode === 'slayer' || (mode === 'infection' && e.team === R.HUMANS)) {
      // go looking: the hills in turn (the map's open ground), a new one every so often
      const h = layout.hills[(Math.floor(time / ROAM_S) + e.kills) % layout.hills.length];
      return { kind: 'roam', at: { x: h[0], y: h[1], z: h[2] }, r: h[3], want: WANT.roam };
    }
    if (mode === 'koth') {
      const z = hill.zone;
      return { kind: 'hill', at: z, r: z.r, want: inZone(b, z) ? WANT.inZone : WANT.zone };
    }
    if (mode === 'siege') {
      const z = zoneOf(layout.siege.core);
      if (e.team === siege.attackers) return { kind: 'attackCore', at: z, r: z.r, want: inZone(b, z) ? WANT.inZone : WANT.zone };
      return { kind: 'defendCore', at: z, r: z.r, want: WANT.defend };
    }
    if (mode === 'ctf') {
      const mine = flags[e.team], theirs = flags[other(e.team)];
      if (theirs.carrier === e.id) return { kind: 'carry', at: mine.home, r: 0, want: WANT.carry };
      if (mine.state === 'dropped') return { kind: 'return', at: mine.pos.clone(), r: 0, want: WANT.return };
      if (theirs.state === 'carried') {
        const c = roster.get(theirs.carrier);
        if (e.role === 'attack' && c) { const p = bodyOf(c).pos; return { kind: 'escort', at: { x: p.x, y: p.y, z: p.z }, r: ESCORT_R, want: WANT.escort }; }
      } else if (e.role === 'attack') {
        return { kind: 'getFlag', at: theirs.pos.clone(), r: 0, want: hdist(b.pos, theirs.pos) < NEAR ? WANT.getFlagNear : WANT.getFlag };
      }
      if (e.role === 'defend' && mine.state === 'home') return { kind: 'defend', at: mine.home, r: DEFEND_R, want: WANT.defend };
      if (theirs.state !== 'carried') return { kind: 'getFlag', at: theirs.pos.clone(), r: 0, want: WANT.getFlagIdle };
    }
    return null;   // the infected: hunt (they see every survivor nearby on the tracker)
  }

  // ---------------------------------------------------------------- per frame
  function count() {
    if (mode !== 'infection') return;
    teamScore[R.HUMANS] = members(R.HUMANS).length;
    teamScore[R.INFECTED] = members(R.INFECTED).length;
  }

  function leader() {
    const [a, b] = teams;
    return teamScore[a] > teamScore[b] ? a : teamScore[b] > teamScore[a] ? b : null;
  }

  // frame: npc.js's per-frame world ({ player, holding, toWorld, worldToGrid, scale, stepsPerFrame })
  function update(dt, frame) {
    if (!visible) setVisible(true);
    if (running) {
      time += dt;
      const t0 = performance.now();
      if (frame) for (const e of bots()) { loadout(e); e.bot.bind(app.getVolume(), sim().g); e.bot.update(dt, frame); }
      botMs += (performance.now() - t0 - botMs) * BOT_MS_EASE;
      for (const e of roster.values()) {
        const b = bodyOf(e);
        if (!b || !e.team) continue;
        e.protect = Math.max(0, e.protect - dt);
        pace(e, b);
        if (b.dead && !e.wasDead) died(e);
        else if (!b.dead && e.wasDead) e.protect = R.SPAWN_PROTECT_S;   // back: a moment's protection
        e.wasDead = b.dead;
      }
      count();
      if (mode === 'ctf') tickCtf();
      if (mode === 'koth') tickKoth(dt);
      if (mode === 'siege') tickSiege(dt);
      // the end: the score, the last survivor, the clock
      if (running && mode !== 'siege') {
        const won = mode !== 'infection' && teams.find((t) => teamScore[t] >= rules.scoreToWin);
        if (won) end(won, `${Math.floor(teamScore[won])} to ${Math.floor(teamScore[other(won)])}`);
        else if (mode === 'infection' && teamScore[R.HUMANS] === 0) end(R.INFECTED, 'No one survived');
        else if (time >= ends) {
          if (mode === 'infection') end(R.HUMANS, `${teamScore[R.HUMANS]} survived the clock`);
          else { const w = leader(); end(w, `Time's up: ${Math.floor(teamScore[R.TEAMS[0]])} to ${Math.floor(teamScore[R.TEAMS[1]])}`); }
        }
      }
      markers.update({
        time,
        flagAt: (t) => (flags?.[t] && flags[t].carrier !== PLAYER ? flags[t].pos : null),   // the player's own carry would be in their eye
        zoneOwner: hill?.owner ?? siege?.owner ?? (siege ? other(siege.attackers) : null),
        zoneContested: hill?.contested ?? siege?.contested ?? false,
        bots: bots().map((e) => ({ id: e.id, team: e.team, alive: alive(e), pos: e.bot.body.pos })),
        myTeam: me()?.team ?? null,
      });
    }
    hud.update(state());
  }

  function board() {
    return [...roster.values()].filter((e) => e.team).map((e) => ({ id: e.id, name: e.name, team: e.team, kills: e.kills, deaths: e.deaths, score: e.score, me: e.id === PLAYER }));
  }

  function objectiveText() {
    if (mode === 'slayer') return { text: `First to ${rules.scoreToWin}` };
    if (mode === 'ctf') {
      const say = (f) => `${label(f.team)} flag ${f.state === 'carried' ? 'taken' : f.state}`;
      return { text: `${say(flags.red)} · ${say(flags.blue)}` };
    }
    if (mode === 'koth') {
      const left = rules.hillMoveS - (time % rules.hillMoveS);
      const who = hill.contested ? 'contested' : hill.owner ? `${label(hill.owner)}'s` : 'empty';
      const lead = leader();
      return { text: `Hill ${who} · moves in ${Math.ceil(left)} s`, progress: lead ? teamScore[lead] / rules.scoreToWin : 0, progressTeam: lead };
    }
    if (mode === 'infection') {
      const n = teamScore[R.HUMANS];
      return { text: `${n} survivor${n === 1 ? '' : 's'} · ${teamScore[R.INFECTED]} infected` };
    }
    if (mode === 'siege') {
      return {
        text: `Half ${siege.half} · ${label(siege.attackers)} attack the core · ${Math.floor(siege.held)}/${rules.holdToWin} s${siege.contested ? ' · contested' : ''}`,
        progress: siege.held / rules.holdToWin, progressTeam: siege.attackers,
      };
    }
    return { text: '' };
  }

  function state() {
    const o = running ? objectiveText() : {};
    return {
      running, mode, now: now(), time,
      teamScore: { ...teamScore }, teams,
      timeLeft: running ? ends - time : 0,
      objective: o.text, progress: o.progress, progressTeam: o.progressTeam,
      roster: board(),
      scoreLine: running ? `${rules.name} on ${layout.name}` : lastResult ? `Last match: ${R.MODES[lastResult.mode].name}` : '',
      scoreLabel: { slayer: 'Kills', ctf: 'Caps', koth: 'Hill s', infection: 'Kills', siege: 'Core s' }[mode] ?? 'Score',
      flags: flags ? Object.fromEntries(Object.values(flags).map((f) => [f.team, { state: f.state, carrier: f.carrier }])) : null,
      hill: hill ? { index: hill.i, owner: hill.owner, contested: hill.contested } : null,
      siege: siege ? { half: siege.half, attackers: siege.attackers, held: siege.held, results: siege.results } : null,
      bots: bots().length,
      botMs,
    };
  }

  // ---------------------------------------------------------------- the player's side
  // '.' (TF2's team switch): to the other side; a bot there takes your place
  function switchTeam(to = null) {
    const p = me();
    if (!running || !p?.team || mode === 'infection') return false;
    const dest = to ?? other(p.team);
    if (dest === p.team) return false;
    const swap = members(dest).find((e) => e.bot);
    if (swap) { setTeam(swap, p.team); swap.role = p.role ?? 'attack'; }
    setTeam(p, dest);
    for (const f of Object.values(flags ?? {})) if (f.carrier === p.id) dropFlag(f, shell.player.pos);
    shell.respawnPlayer(spawnFor(p));
    p.protect = R.SPAWN_PROTECT_S;
    hud.announce(`You joined ${label(dest)}`, now());
    return true;
  }

  function menu(open) {
    hud.setMenu(open);
    if (open) shell.freeMouse();
  }

  function setVisible(v) {
    visible = v;
    markers.setVisible(v);
    hud.show(v);
    for (const e of bots()) e.bot.setVisible(v);
  }
  setVisible(false);

  // keys, in first person: Tab holds the scoreboard, M opens the match menu, '.' switches team
  addEventListener('keydown', (e) => {
    if (!shell.active() || app.isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Tab') { e.preventDefault(); hud.holdBoard(true); return; }
    if (e.repeat) return;
    if (e.code === 'KeyM') menu(!hud.menuOpen);
    else if (e.key === '.') switchTeam();
  });
  addEventListener('keyup', (e) => { if (e.code === 'Tab') hud.holdBoard(false); });
  addEventListener('blur', () => hud.holdBoard(false));

  return {
    start, end: () => end(), useLayout(l) { userLayout = l ?? null; },
    get running() { return running; },
    get mode() { return mode; },
    get layout() { return layout ?? (sim() ? fitLayout(userLayout ?? app.getArena?.(), sim().g) ?? labLayout(sim().g) : null); },
    get state() { return state(); },
    get lastResult() { return lastResult; },
    get roster() { return [...roster.values()]; },
    get bots() { return bots().map((e) => e.bot); },
    get botCount() { return running ? bots().length : 0; },
    // the player's respawn while a match runs: Halo's delay, at a spawn of their side (null: the shell's own)
    get playerRespawn() {
      const p = me();
      return running && p?.team ? { delay: R.RESPAWN_S, at: () => spawnFor(p) } : null;
    },
    switchTeam,
    menu,
    setVisible,
    update,
  };
}

import * as R from './rules.js';
import { CLASS, applyClass } from '../pov/classes.js';
import { WANT } from './bots.js';

// Siege: Team Fortress 2's attack/defend, Dustbowl's and Gravel Pit's rules on
// our maps. One team attacks a row of control points (A, then B, then C) and
// the other defends them; the defenders win when the clock runs out.
//
// - Setup: the round opens with the attackers held in their spawn while the
//   defenders take up their posts and everyone picks a class (TF2's setup
//   gates). Here the gate is an invisible ring round the attackers' spawn.
// - Capturing: attackers alone on the point fill its bar, faster the more of
//   them stand on it (TF2's harmonic rate: 2 cappers 1.5×, 3 1.83×, 4 2.08×; a
//   Runner counts twice, as TF2's Scout). Any defender on the point blocks it
//   (the bar holds). Nobody of the attackers on it: the bar drains.
// - A point taken unlocks the next, adds time to the clock and moves both
//   teams' spawns forward (TF2's forward spawns): attackers come back nearer
//   the front, defenders fall back toward the last point.
// - Overtime: at time-out with capture progress on the point (or an attacker
//   on it), the round goes on until the bar drains, six times as fast (TF2).
// - Respawns: attackers come back faster than defenders (Dustbowl's waves).
//
// The layout's `siege` field (layout.js, arenas/damValley.js):
//
//   siege: { attackers: 'red',
//            points: [[x, y, z, r], ...],                  taken in this order
//            spawns: [{ attack: [[x, y, z], ...], defend: [...] }, ...],   per stage: before A falls, after A, ...
//            core: [x, y, z, r] }                          the last point (older readers)
//
// A stage without spawns of its own keeps the stage before's; without any, a
// side spawns at its team's spawns (layout.spawns). A layout with only `core`
// (the first Siege's) is one point.

// ---- the clock
// TF2's setup is 60 s on Dustbowl (wiki.teamfortress.com/wiki/Dustbowl), time to
// pick a class and walk to the front. Ours is a third: our points are a short
// run from the spawns and the class pick is one key.
export const SETUP_S = 20;
// The round clock after setup is the mode's timeLimit (rules.js MODES.siege).
// Dustbowl adds 4:30 to the clock for every point taken; our points are a
// third of its walk apart, so a third of that.
export const CAPTURE_BONUS_S = 90;

// ---- the points (wiki.teamfortress.com/wiki/Control_point_timing)
// s one attacker takes to capture a point: Gravel Pit's C (12 s alone; Dustbowl's
// points are 6 s, Gravel Pit's A and B 60 s). Four take 12 / 2.08 = 5.8 s.
export const CAPTURE_S = 12;
// s an untouched bar takes to drain from full: TF2's default is 90 s for points
// that take 6 to 60 s; a third of it for our 12 s points, so a half-taken point
// stays worth coming back to for a quarter of a minute.
export const DECAY_S = 30;
export const OVERTIME_DECAY = 6;     // × the drain in overtime (TF2: 90 s becomes 15 s)
// How many cappers a class counts as (TF2: the Scout counts as two). Others: one.
export const CAP_WEIGHT = { RUNNER: 2 };
export const LETTERS = 'ABCDEFGH';

// ---- respawns (wiki.teamfortress.com/wiki/Respawn_time)
// Dustbowl's waves: attackers 2 s, defenders 10 s, each plus ~5 s of death cam
// (7 s and 15 s in all). About half of each: our walk back to the front is short.
export const ATTACK_RESPAWN_S = 4;
export const DEFEND_RESPAWN_S = 8;

// ---- the spawn room and the setup gate
// cells from a side's spawn point that count as its respawn room: a class
// change there applies at once (TF2: change class in the respawn room and you
// come out as the new class)
export const ROOM_R = 8;
export const GATE_PAD = 8;           // cells past the attackers' farthest spawn point the setup gate stands

// ---- the scoreboard (TF2's: a capture is 2 points to each capper, a defense 1)
export const CAPTURE_SCORE = 2;
export const DEFENSE_SCORE = 1;      // killing an attacker on, or near, your point
export const DEFENSE_R = 6;          // cells past the point's ring a kill still counts as a defense

// ---- bots
// Classes dealt to each side's bots in turn (classes.js; the first ones when the
// player takes a place): attackers as TF2's Soldier, Scout, Pyro and a flier;
// defenders as TF2's Heavy on the point, then Pyro, a flier and a Soldier.
export const ATTACK_CLASSES = ['ROCKETEER', 'RUNNER', 'PYRO', 'SKYJACK'];
export const DEFEND_CLASSES = ['BULWARK', 'PYRO', 'SKYJACK', 'ROCKETEER'];
export const FALLBACK_WEAPON = 'GUN';   // a class none of whose tools a bot can fight with fights with this
// One defender (the first: the Bulwark) holds the point itself, TF2's Heavy or
// Engineer nest; the others stand guard out in front of it, toward where the
// attackers come from, a few posts apart, and move to another post now and then
// (a fixed post is found and flanked). When the attackers step on the point,
// every defender goes to retake it.
const GUARD_OUT = 10;                // cells past the point's ring a guard post stands
const GUARD_R = 6;                   // cells: a guard post's zone
const GUARD_POSTS = 3;               // posts round the point's front...
const GUARD_SPREAD = 0.6;            // ...this far apart (rad)
const GUARD_SHIFT_S = 25;            // s at a post before moving to the next
const WAIT_SHARE = 0.5;              // share of the gate's radius attackers wander in during setup
// A bot whose class can't shoot from the point (no gun: a Pyro, a Runner)
// fights an enemy it sees this near instead of standing on the point.
const MELEE_FIGHT_R = 40;            // cells
const EDGE = 3;                      // cells: posts stay this far inside the box

const other = (t) => (t === 'red' ? 'blue' : 'red');
const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const label = (k) => R.TEAM_NAME[k] ?? k;
const zoneOf = ([x, y, z, r]) => ({ x, y, z, r });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// TF2's capture rate for n cappers: the harmonic number 1 + 1/2 + ... + 1/n
export function capRate(n) {
  let r = 0;
  for (let i = 1; i <= n; i++) r += 1 / i;
  return r;
}

// One frame of a point's bar (0..1). att: cappers on it (weighted), def:
// defenders on it. Both: blocked, the bar holds. Attackers alone: it fills.
// Neither, or defenders alone: it drains (OVERTIME_DECAY× in overtime).
export function stepPoint(progress, { att, def, dt, captureS = CAPTURE_S, decayS = DECAY_S, overtime = false }) {
  if (att > 0 && def > 0) return progress;
  if (att > 0) return Math.min(1, progress + (dt * capRate(att)) / captureS);
  return Math.max(0, progress - (dt * (overtime ? OVERTIME_DECAY : 1)) / decayS);
}

// The layout's siege field, read the new way or the old: { attackers, points: [{ x, y, z, r }],
// stages: [{ attack: [[x, y, z]], defend: [...] }] (one per point) }
export function siegePlan(layout) {
  const s = layout.siege ?? {};
  const attackers = s.attackers ?? R.TEAMS[0], defenders = other(attackers);
  const points = (s.points?.length ? s.points : s.core ? [s.core] : []).map(zoneOf);
  const team = { attack: layout.spawns?.[attackers] ?? [], defend: layout.spawns?.[defenders] ?? [] };
  const last = { ...team };
  const stages = points.map((_, i) => {
    const st = s.spawns?.[i] ?? {};
    for (const role of ['attack', 'defend']) if (st[role]?.length) last[role] = st[role];
    return { attack: last.attack, defend: last.defend };
  });
  return { attackers, defenders, points, stages };
}

// the middle of some spawn points (cells, feet)
function centre(pts) {
  const c = { x: 0, y: 0, z: 0 };
  for (const p of pts) { c.x += p[0]; c.y += p[1]; c.z += p[2]; }
  const n = pts.length || 1;
  c.x /= n; c.y /= n; c.z /= n;
  return c;
}

// One Siege round. g: what the game (index.js) lends it:
//   { layout, rules, size: [nx, ny, nz], time(), entries(), bodyOf(e), alive(e), inZone(body, zone),
//     teamScore, announce(text), end(winner, why), emit(name, payload), markZone(zone), canFight(key) }
export function createSiege(g) {
  const plan = siegePlan(g.layout);
  const att = plan.attackers, def = plan.defenders, n = plan.points.length;
  const setupS = g.rules.setupS ?? SETUP_S;
  const captureS = g.rules.captureS ?? CAPTURE_S;
  const bonusS = g.rules.timeBonus ?? CAPTURE_BONUS_S;
  const t0 = g.time();
  const s = {
    stage: 0, progress: 0, cappers: 0, contested: false, overtime: false, open: false, over: false,
    setupEnds: t0 + setupS, ends: t0 + setupS + g.rules.timeLimit, taken: [],
  };
  const point = () => plan.points[s.stage] ?? null;
  const stage = () => plan.stages[Math.min(s.stage, n - 1)];
  const spawnsOf = (team) => (team === att ? stage().attack : stage().defend);
  const inSetup = () => g.time() < s.setupEnds;
  // the gate: a ring round the attackers' spawn, just past its farthest point
  function gate() {
    const pts = stage().attack, c = centre(pts);
    let r = 0;
    for (const p of pts) r = Math.max(r, Math.hypot(p[0] - c.x, p[2] - c.z));
    return { c, r: r + GATE_PAD };
  }

  function begin() {
    if (!n) { g.end(null, 'This map has no siege points'); return; }
    g.markZone(point());
    score();
    g.announce(`Setup: ${label(att)} attack point ${LETTERS[0]} in ${Math.round(setupS)} s`);
  }

  // ---- per frame
  function tick(dt) {
    if (s.over || !n) return;
    if (inSetup()) { holdGate(); score(); return; }
    if (!s.open) {
      s.open = true;
      g.emit('game:setup', { open: true });
      g.announce(`The gates are open: ${label(att)} attack!`);
    }
    const pt = point();
    let cap = 0, defOn = 0;
    const on = [];
    for (const e of g.entries()) {
      if (!e.team || !g.alive(e)) continue;
      const b = g.bodyOf(e);
      if (!b || !g.inZone(b, pt)) continue;
      if (e.team === att) { cap += CAP_WEIGHT[b.cls] ?? 1; on.push(e); }
      else if (e.team === def) defOn++;
    }
    s.cappers = cap;
    s.contested = cap > 0 && defOn > 0;
    s.progress = stepPoint(s.progress, { att: cap, def: defOn, dt, captureS, decayS: DECAY_S, overtime: s.overtime });
    if (s.progress >= 1) { capture(on); return; }
    // the clock: overtime while the point has progress or an attacker on it; else the defenders hold
    if (g.time() >= s.ends) {
      const live = s.progress > 0 || cap > 0;
      if (live && !s.overtime) { s.overtime = true; g.emit('game:overtime', { index: s.stage }); g.announce('Overtime!'); }
      if (!live) { finish(def); return; }
    }
    score();
  }

  // during setup the attackers can't leave their spawn: pushed back to the gate's ring
  function holdGate() {
    const { c, r } = gate();
    for (const e of g.entries()) {
      if (e.team !== att || !g.alive(e)) continue;
      const b = g.bodyOf(e);
      const dx = b.pos.x - c.x, dz = b.pos.z - c.z, d = Math.hypot(dx, dz);
      if (d <= r) continue;
      b.pos.x = c.x + (dx * r) / d;
      b.pos.z = c.z + (dz * r) / d;
      const out = (b.vel.x * dx + b.vel.z * dz) / d;
      if (out > 0) { b.vel.x -= (out * dx) / d; b.vel.z -= (out * dz) / d; }
    }
  }

  function capture(on) {
    const L = LETTERS[s.stage];
    for (const e of on) e.score += CAPTURE_SCORE;
    s.taken.push(L);
    g.emit('game:point', { index: s.stage, letter: L, team: att, by: on.map((e) => e.id) });
    s.stage++;
    s.progress = 0; s.cappers = 0; s.contested = false; s.overtime = false;
    if (s.stage >= n) { finish(att); return; }
    s.ends = Math.max(s.ends, g.time()) + bonusS;   // (in overtime the clock had run out: the bonus from now)
    g.markZone(point());
    score();
    g.announce(`${label(att)} took point ${L}: +${bonusS} s. On to ${LETTERS[s.stage]}`);
  }

  function finish(winner) {
    s.over = true;
    const took = g.time() - s.setupEnds;
    const why = winner === att
      ? `${label(att)} took all ${n} point${n === 1 ? '' : 's'} in ${mmss(took)}`
      : `${label(def)} held point ${LETTERS[s.stage]}${s.taken.length ? ` (${s.taken.join(', ')} fell)` : ''}`;
    g.end(winner, why);
  }

  // the scores: points taken, points still held
  function score() {
    g.teamScore[att] = s.stage;
    g.teamScore[def] = n - s.stage;
  }

  // ---- bodies
  // a bot's class: dealt from its side's list, the first one no teammate bot has
  function classFor(e) {
    if (e.cls && e.clsTeam === e.team) return e.cls;
    const list = e.team === att ? ATTACK_CLASSES : DEFEND_CLASSES;
    const held = new Set(g.entries().filter((o) => o !== e && o.bot && o.team === e.team && o.clsTeam === o.team).map((o) => o.cls));
    e.cls = list.find((k) => CLASS[k] && !held.has(k)) ?? list[held.size % list.length];
    e.clsTeam = e.team;
    return e.cls;
  }
  // a body entered play: a bot puts its class on (the player's is the class picker's) and
  // fights with the class's tools its brain knows how to use
  function spawned(e, body) {
    if (!e.bot) return;
    const key = classFor(e);
    applyClass(body, key);
    const usable = (CLASS[key]?.tools ?? []).filter((k) => g.canFight(k));
    e.classWeapons = new Set(usable.length ? usable : [FALLBACK_WEAPON]);
  }
  // TF2's defense: a defender who kills an attacker on (or at) the point
  function died(v, k) {
    if (!k || k.team !== def || v.team !== att) return;
    const b = g.bodyOf(v), pt = point();
    if (b && pt && hdist(b.pos, pt) < pt.r + DEFENSE_R) k.score += DEFENSE_SCORE;
  }
  const respawnS = (team) => (team === att ? ATTACK_RESPAWN_S : DEFEND_RESPAWN_S);
  // the respawn room: all of setup, else near one of the side's spawn points
  function inSpawnRoom(e) {
    if (!e?.team || s.over) return false;
    if (inSetup()) return true;
    const b = g.bodyOf(e);
    return !!b && spawnsOf(e.team).some((p) => Math.hypot(b.pos.x - p[0], b.pos.z - p[2]) < ROOM_R && Math.abs(b.pos.y - p[1]) < R.ZONE_UP);
  }

  // ---- what bots go for (bots.js ObjectiveEvaluator)
  const defenderBots = () => g.entries().filter((e) => e.bot && e.team === def);
  function guardPost(k) {
    const pt = point(), c = centre(stage().attack);
    const toward = Math.atan2(c.z - pt.z, c.x - pt.x);
    const slot = (((k % GUARD_POSTS) + GUARD_POSTS) % GUARD_POSTS) - (GUARD_POSTS - 1) / 2;
    const a = toward + slot * GUARD_SPREAD, d = pt.r + GUARD_OUT;
    const [nx, , nz] = g.size;
    return { x: clamp(pt.x + Math.cos(a) * d, EDGE, nx - EDGE), y: pt.y, z: clamp(pt.z + Math.sin(a) * d, EDGE, nz - EDGE) };
  }
  function objective(e) {
    const a = e.bot?.agent, pt = point();
    if (!a || !pt || s.over) return null;
    const b = g.bodyOf(e);
    if (e.team === att) {
      if (inSetup()) {
        const { c, r } = gate();
        return { kind: 'setup', at: c, r: Math.max(GUARD_R, r * WAIT_SHARE), want: WANT.inZone };
      }
      // no gun to shoot from the point with: fight what it sees near, then come back to it
      const melee = !!a.weapons && !a.weapons.has('GUN') && a.sees && a.dist3 < MELEE_FIGHT_R;
      return { kind: 'attackPoint', at: pt, r: pt.r, want: melee ? WANT.defend : g.inZone(b, pt) ? WANT.inZone : WANT.zone };
    }
    if (e.team !== def) return null;
    if (!inSetup() && s.cappers > 0) return { kind: 'retake', at: pt, r: pt.r, want: WANT.zone };
    const mine = defenderBots();
    if (mine[0] === e) return { kind: 'anchor', at: pt, r: pt.r, want: WANT.defend };
    const k = mine.indexOf(e) - 1 + Math.floor(g.time() / GUARD_SHIFT_S) + (e.roam ?? 0);
    return { kind: 'guard', at: guardPost(k), r: GUARD_R, want: WANT.defend };
  }

  // ---- what the HUD shows (game/hud.js reads state(): objective, progress, the clock)
  function hud() {
    const t = g.time(), L = LETTERS[s.stage] ?? LETTERS[n - 1];
    const of = n > 1 ? ` of ${n}` : '';
    if (t < s.setupEnds) return { text: `Setup · ${label(att)} attack point ${L}${of} when the gates open` };
    const who = s.contested ? 'contested' : s.cappers ? `${label(att)} capturing${s.cappers > 1 ? ` ×${s.cappers}` : ''}` : `${label(def)} holds it`;
    const done = s.taken.length ? ` · ${s.taken.join(', ')} taken` : '';
    return { text: `${s.overtime ? 'Overtime! ' : ''}Point ${L}${of} · ${who}${done}`, progress: s.progress, progressTeam: att };
  }

  return {
    attackers: att, defenders: def,
    begin, tick, spawned, died, objective, hud, respawnS, inSpawnRoom,
    spawnPoints: spawnsOf,
    get timeLeft() { return inSetup() ? s.setupEnds - g.time() : Math.max(0, s.ends - g.time()); },
    // the point's ring: the defenders' colour, the attackers' while they take it alone
    get zoneOwner() { return s.cappers > 0 && !s.contested ? att : def; },
    get contested() { return s.contested; },
    get state() {
      return {
        attackers: att, defenders: def, points: n, stage: s.stage, letter: LETTERS[s.stage] ?? null, taken: [...s.taken],
        progress: s.progress, cappers: s.cappers, contested: s.contested, overtime: s.overtime,
        setup: inSetup(), setupLeft: Math.max(0, s.setupEnds - g.time()), point: point(),
      };
    },
  };
}

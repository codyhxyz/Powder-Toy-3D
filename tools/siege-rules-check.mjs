// Siege's rules on the CPU (src/game/siege.js, docs/modes.md "Siege"): no
// browser, no GPU. A fake game drives one round at a time: the capture rate,
// blocking, the drain, setup's gate, a capture's time and forward spawns,
// overtime, the bots' classes and objectives, both maps' layouts.
//
// usage: node tools/siege-rules-check.mjs
import * as S from '../src/game/siege.js';
import { labLayout } from '../src/game/layout.js';
import { DAM_VALLEY_LAYOUT } from '../src/arenas/damValley.js';
import { canFight } from '../src/pov/ai/brain.js';
import { WANT } from '../src/game/bots.js';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// pure parts
ok(near(S.capRate(1), 1) && near(S.capRate(2), 1.5) && near(S.capRate(4), 25 / 12), 'harmonic capture rate');
ok(S.stepPoint(0.5, { att: 1, def: 1, dt: 1 }) === 0.5, 'contested holds');
ok(near(S.stepPoint(0, { att: 1, def: 0, dt: 1 }), 1 / S.CAPTURE_S), 'one capper fills 1/CAPTURE_S a second');
ok(near(S.stepPoint(1, { att: 0, def: 0, dt: 1 }), 1 - 1 / S.DECAY_S), 'drains when empty');
ok(near(S.stepPoint(1, { att: 0, def: 0, dt: 1, overtime: true }), 1 - S.OVERTIME_DECAY / S.DECAY_S), 'drains 6x in overtime');
const old = S.siegePlan({ spawns: { red: [[1, 0, 1]], blue: [[9, 0, 9]] }, siege: { attackers: 'blue', core: [5, 0, 5, 3] } });
ok(old.points.length === 1 && old.attackers === 'blue' && old.stages[0].attack[0][0] === 9, 'old core-only layout reads as one point');
const dv = S.siegePlan(DAM_VALLEY_LAYOUT);
ok(dv.points.length === 3 && dv.stages[1].attack[0][0] === 84 && dv.stages[2].defend[0][0] === 247 && dv.stages[0].attack[0][0] === 8, 'Dam Valley stages: spawns move up');

// a fake match
function match(layout, opts = {}) {
  const ents = [];
  const mk = (id, team, bot, x, z) => {
    const body = { pos: { x, y: 0, z }, vel: { x: 0, y: 0, z: 0 }, cls: null, perks: { add() {}, take() { return true; } }, dead: false };
    const e = { id, team, bot: bot ? { agent: { weapons: null, sees: false, dist3: 99 } } : null, body, score: 0, roam: 0 };
    ents.push(e); return e;
  };
  let time = 0, ended = null; const events = [], notes = []; const teamScore = {};
  const g = {
    layout, rules: { timeLimit: 180, ...opts }, size: layout.size, teamScore, canFight,
    time: () => time, entries: () => ents, bodyOf: (e) => e.body, alive: (e) => !e.body.dead,
    inZone: (b, z) => Math.hypot(b.pos.x - z.x, b.pos.z - z.z) < z.r && b.pos.y - z.y > -1 && b.pos.y - z.y < 8,
    announce: (t) => notes.push(t), end: (w, why) => { ended = { w, why }; }, emit: (n, e) => events.push([n, e]), markZone: () => {},
  };
  const s = S.createSiege(g);
  return { s, mk, ents, step: (dt) => { time += dt; s.tick(dt); }, get time() { return time; }, set time(v) { time = v; }, get ended() { return ended; }, events, notes, teamScore };
}

{ // the lab: setup gate, a capture, the bonus, spawns moving, the final capture
  const L = labLayout({ nx: 128, ny: 128, nz: 128 });
  const m = match(L);
  const p = S.siegePlan(L).points;
  const a1 = m.mk('p', 'red', false, 115, 15), a2 = m.mk('b1', 'red', true, 115, 15), d1 = m.mk('b2', 'blue', true, 16, 112), d2 = m.mk('b3', 'blue', true, 16, 112);
  for (const e of m.ents) m.s.spawned(e, e.body);
  ok(a2.body.cls === 'ROCKETEER' && d1.body.cls === 'BULWARK' && d2.body.cls === 'PYRO', `bots dealt classes: ${a2.body.cls}, ${d1.body.cls}, ${d2.body.cls}`);
  ok([...a2.classWeapons].join() === 'BOMB' || a2.classWeapons.has('ROCKET'), `Rocketeer bot fights with ${[...a2.classWeapons]}`);
  ok([...d2.classWeapons].join() === 'BLOWTORCH', `Pyro bot fights with ${[...d2.classWeapons]}`);
  ok(m.s.state.setup && m.s.timeLeft === S.SETUP_S, 'setup first');
  ok(m.s.objective(a2).kind === 'setup' && m.s.objective(d1).kind === 'anchor' && m.s.objective(d2).kind === 'guard', 'setup plans: wait, anchor, guard');
  ok(m.s.inSpawnRoom(a1), 'all of setup is the respawn room');
  a1.body.pos.x = 60; a1.body.pos.z = 60; a1.body.vel.x = -10;
  m.step(0.1);
  ok(Math.hypot(a1.body.pos.x - 115.6, a1.body.pos.z - 16) < 30 && a1.body.vel.x > -10, 'the gate holds an attacker in spawn during setup');
  // gates open; attackers on A
  m.time = S.SETUP_S;
  a1.body.pos.x = p[0].x; a1.body.pos.z = p[0].z; a2.body.pos.x = p[0].x + 1; a2.body.pos.z = p[0].z;
  m.step(0.05);
  ok(m.events.some(([n]) => n === 'game:setup'), 'gates open event');
  ok(m.s.state.cappers === 2 && m.s.zoneOwner === 'red', 'two cappers, red ring');
  ok(m.s.objective(d1).kind === 'retake' && m.s.objective(d1).want === WANT.zone, 'defenders go to retake');
  ok(!m.s.inSpawnRoom(a1), 'out of setup the point is not a respawn room');
  d1.body.pos.x = p[0].x; d1.body.pos.z = p[0].z + 2; m.step(1);
  const held = m.s.state.progress; m.step(1);
  ok(m.s.state.contested && m.s.state.progress === held, 'a defender blocks: bar holds');
  d1.body.dead = true;
  let t = 0; while (m.s.state.stage === 0 && t < 30) { m.step(0.05); t += 0.05; }
  ok(near(t + 0.05, S.CAPTURE_S / 1.5, 0.15), `two cappers take A in ~${(t + 0.05).toFixed(2)} s (expect ${(S.CAPTURE_S / 1.5).toFixed(2)})`);
  ok(m.events.some(([n, e]) => n === 'game:point' && e.letter === 'A') && a1.score === S.CAPTURE_SCORE, 'A captured, cappers scored');
  ok(m.teamScore.red === 1 && m.teamScore.blue === 1, 'scores: 1 taken, 1 left');
  ok(m.s.spawnPoints('red')[0][0] === 100, 'red spawns moved up after A');
  ok(near(m.s.timeLeft, 180 - (m.time - S.SETUP_S) + S.CAPTURE_BONUS_S, 0.01), 'time bonus added');
  // B: 4 weighted cappers? a Runner counts 2
  a2.body.cls = 'RUNNER';
  a1.body.pos.x = p[1].x; a1.body.pos.z = p[1].z; a2.body.pos.x = p[1].x; a2.body.pos.z = p[1].z;
  m.step(0.05);
  ok(m.s.state.cappers === 3, 'a Runner counts as two cappers');
  t = 0; while (!m.ended && t < 30) { m.step(0.05); t += 0.05; }
  ok(m.ended?.w === 'red', `red wins on taking B: ${m.ended?.why}`);
}

{ // overtime, then the defenders win when the bar drains
  const L = labLayout({ nx: 128, ny: 128, nz: 128 });
  const m = match(L, { timeLimit: 10 });
  const p = S.siegePlan(L).points;
  const a1 = m.mk('p', 'red', false, p[0].x, p[0].z);
  m.time = S.SETUP_S; m.step(0.05);
  while (m.time < S.SETUP_S + 10) m.step(0.05);
  ok(m.s.state.overtime && !m.ended, 'on the point at time-out: overtime');
  a1.body.pos.x = 0; a1.body.pos.z = 0;
  const pr = m.s.state.progress; let t = 0;
  while (!m.ended && t < 60) { m.step(0.05); t += 0.05; }
  ok(m.ended?.w === 'blue' && near(t, pr * S.DECAY_S / S.OVERTIME_DECAY, 0.2), `bar drained in ${t.toFixed(2)} s, blue wins: ${m.ended?.why}`);
}

{ // time-out with nothing on the point: defenders win at once; a melee bot fights instead of standing
  const L = labLayout({ nx: 128, ny: 128, nz: 128 });
  const m = match(L, { timeLimit: 5 });
  const b = m.mk('b1', 'red', true, 115, 15); m.s.spawned(b, b.body);
  b.bot.agent.weapons = b.classWeapons;
  m.time = S.SETUP_S + 0.01; m.step(0.01);
  b.bot.agent.sees = true; b.bot.agent.dist3 = 20;
  ok(m.s.objective(b).want < 0.6, 'a gunless attacker that sees an enemy near fights (want under Attack)');
  while (!m.ended && m.time < 40) m.step(0.1);
  ok(m.ended?.w === 'blue', 'time-out: blue holds');
}

{ // Dam Valley guard posts stay inside the box and differ
  const m = match(DAM_VALLEY_LAYOUT);
  const ds = [0, 1, 2, 3].map((i) => m.mk(`d${i}`, 'blue', true, 247, 64));
  const posts = ds.slice(1).map((e) => m.s.objective(e).at);
  ok(posts.every((q) => q.x > 0 && q.x < 256 && q.z > 0 && q.z < 128), 'guard posts inside the box');
  ok(new Set(posts.map((q) => `${Math.round(q.x)},${Math.round(q.z)}`)).size === 3, `three different guard posts: ${posts.map((q) => `${q.x.toFixed(0)},${q.z.toFixed(0)}`).join(' ')}`);
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);

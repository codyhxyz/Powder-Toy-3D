// Halo medal rules (src/game/medals.js), checked in node: no browser, no GPU.
// Feeds the medal book fake game:kill / game:flag / game:end events and checks
// who earns what.  node tools/medals-check.mjs
import assert from 'node:assert/strict';
import { createMedalBook, MULTI_KILL_S, SPREE_STEP, MEDALS, causeMedal, rankOf } from '../src/game/medals.js';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok    ${name}`); } catch (err) { failures++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}
const keys = (list, id) => list.filter((m) => id == null || m.id === id).map((m) => m.key);
const kill = (by, id, cause = 'Shot', extra = {}) => ({ by, id, cause, killerTeam: 'red', victimTeam: 'blue', ...extra });

check('every medal has a name, kind and glyph', () => {
  for (const [k, m] of Object.entries(MEDALS)) assert.ok(m.name && m.kind && m.glyph, k);
});

check('first kill of the match: First Strike, once', () => {
  const b = createMedalBook(); b.start('slayer');
  assert.deepEqual(keys(b.kill(kill('p', 'a'), 0)), ['FIRST_STRIKE']);
  assert.deepEqual(keys(b.kill(kill('q', 'b'), 10)), []);
});

check('multi-kills chain within 4 s, Double to Killionaire and past it', () => {
  const b = createMedalBook(); b.start('slayer');
  b.kill(kill('x', 'z'), -100);   // someone else's First Strike
  const got = [];
  for (let i = 0; i < 11; i++) got.push(...keys(b.kill(kill('p', `v${i}`), i * (MULTI_KILL_S - 0.5)), 'p'));
  const multis = got.filter((k) => MEDALS[k].kind === 'multi');
  assert.deepEqual(multis, ['DOUBLE_KILL', 'TRIPLE_KILL', 'OVERKILL', 'KILLTACULAR', 'KILLTROCITY', 'KILLIMANJARO', 'KILLTASTROPHE', 'KILLPOCALYPSE', 'KILLIONAIRE', 'KILLIONAIRE']);
});

check('a gap over 4 s breaks the chain', () => {
  const b = createMedalBook(); b.start('slayer');
  b.kill(kill('p', 'a'), 0);
  assert.deepEqual(keys(b.kill(kill('p', 'b'), MULTI_KILL_S + 0.01)), []);
  assert.deepEqual(keys(b.kill(kill('p', 'c'), MULTI_KILL_S + 1)), ['DOUBLE_KILL']);
});

check('sprees every 5 without dying; death resets; past 30 repeats Invincible', () => {
  const b = createMedalBook(); b.start('slayer');
  const sprees = [];
  for (let i = 0; i < 35; i++) sprees.push(...keys(b.kill(kill('p', `v${i}`), i * 10), 'p').filter((k) => MEDALS[k].kind === 'spree'));
  assert.deepEqual(sprees, ['KILLING_SPREE', 'KILLING_FRENZY', 'RUNNING_RIOT', 'RAMPAGE', 'UNTOUCHABLE', 'INVINCIBLE', 'INVINCIBLE']);
  b.kill(kill('q', 'p'), 1000);
  assert.equal(b.streak('p'), 0);
});

check('ending a spree of 5+ is a Killjoy; ending 4 is not', () => {
  const b = createMedalBook(); b.start('slayer');
  for (let i = 0; i < SPREE_STEP; i++) b.kill(kill('p', `v${i}`), i * 10);
  assert.ok(keys(b.kill(kill('q', 'p'), 100), 'q').includes('KILLJOY'));
  for (let i = 0; i < SPREE_STEP - 1; i++) b.kill(kill('r', `w${i}`), 200 + i * 10);
  assert.ok(!keys(b.kill(kill('q', 'r'), 300), 'q').includes('KILLJOY'));
});

check('causes: Beat Down, Assassin, Grenade Stick, Grenade Kill, Splatter, Incineration', () => {
  assert.equal(causeMedal('melee'), 'BEAT_DOWN');
  assert.equal(causeMedal('assassination'), 'ASSASSIN');
  assert.equal(causeMedal('grenade'), 'GRENADE_KILL');
  assert.equal(causeMedal('grenade stick'), 'GRENADE_STICK');
  assert.equal(causeMedal('Run over by a jeep'), 'SPLATTER');
  assert.equal(causeMedal('Burned'), 'INCINERATION');
  assert.equal(causeMedal('Shot'), null);
});

check('splatter spree at 5 splatters', () => {
  const b = createMedalBook(); b.start('slayer');
  let got = [];
  for (let i = 0; i < 5; i++) got = keys(b.kill(kill('p', `v${i}`, 'Run over by a jeep'), i * 10), 'p');
  assert.ok(got.includes('SPLATTER_SPREE'), got.join());
});

check('suicides and betrayals give nothing, and still end the spree', () => {
  const b = createMedalBook(); b.start('slayer');
  for (let i = 0; i < 3; i++) b.kill(kill('p', `v${i}`), i * 10);
  assert.deepEqual(b.kill({ by: null, id: 'p', cause: 'Fell 20 m' }, 50), []);
  assert.equal(b.streak('p'), 0);
});

check('a kill after its killer died: Death from the Grave', () => {
  const b = createMedalBook({ alive: (id) => id !== 'p' }); b.start('slayer');
  b.kill(kill('x', 'y'), 0);
  assert.ok(keys(b.kill(kill('p', 'a', 'grenade'), 5), 'p').includes('DEATH_FROM_THE_GRAVE'));
});

check('CTF: Killed Flag Carrier, Flag Kill (melee with the flag), Flag Score, Flag Returned', () => {
  const b = createMedalBook(); b.start('ctf');
  b.kill(kill('x', 'y'), 0);
  b.flag({ team: 'red', action: 'taken', by: 'c' });
  assert.ok(keys(b.kill(kill('p', 'c', 'Shot', { killerTeam: 'red' }), 5), 'p').includes('KILLED_FLAG_CARRIER'));
  b.flag({ team: 'red', action: 'dropped', by: null });
  b.flag({ team: 'blue', action: 'taken', by: 'p' });
  assert.ok(keys(b.kill(kill('p', 'd', 'melee'), 20), 'p').includes('FLAG_KILL'));
  assert.deepEqual(keys(b.flag({ team: 'blue', action: 'captured', by: 'p' })), ['FLAG_SCORE']);
  assert.deepEqual(keys(b.flag({ team: 'red', action: 'returned', by: 'q' })), ['FLAG_RETURNED']);
  assert.deepEqual(keys(b.flag({ team: 'red', action: 'returned', by: null })), []);
});

check('KOTH: Hail to the King on the 5th kill in the hill; the hill moving starts it over', () => {
  const b = createMedalBook({ inHill: () => true }); b.start('koth');
  let got = [];
  for (let i = 0; i < 4; i++) b.kill(kill('p', `v${i}`), i * 10);
  b.hillMoved();
  for (let i = 0; i < 5; i++) got = keys(b.kill(kill('p', `w${i}`), 100 + i * 10), 'p');
  assert.ok(got.includes('HAIL_TO_THE_KING'), got.join());
});

check('Infection: Infection Spree, Zombie Killing Spree, Last Man Standing', () => {
  const b = createMedalBook(); b.start('infection');
  let got = [];
  for (let i = 0; i < 5; i++) got = keys(b.kill({ by: 'z', id: `h${i}`, cause: 'Axe', killerTeam: 'infected', victimTeam: 'blue' }, i * 10), 'z');
  assert.ok(got.includes('INFECTION_SPREE'), got.join());
  for (let i = 0; i < 5; i++) got = keys(b.kill({ by: 'h', id: `z${i}`, cause: 'Shot', killerTeam: 'blue', victimTeam: 'infected' }, 100 + i * 10), 'h');
  assert.ok(got.includes('ZOMBIE_KILLING_SPREE'), got.join());
  assert.deepEqual(keys(b.end({ mode: 'infection', winner: 'blue', roster: [{ id: 'h', team: 'blue' }, { id: 'z', team: 'infected' }] })), ['LAST_MAN_STANDING']);
});

check('Extermination: the whole enemy side (4+) down at once', () => {
  const dead = new Set();
  const b = createMedalBook({ alive: (id) => !dead.has(id), members: (t) => (t === 'blue' ? ['a', 'b', 'c', 'd'] : ['p']) });
  b.start('slayer');
  let got = [];
  for (const v of ['a', 'b', 'c', 'd']) { got = keys(b.kill(kill('p', v), 0), 'p'); dead.add(v); }
  assert.ok(got.includes('EXTERMINATION'), got.join());
});

check('Perfection: a Slayer win with 15+ kills and no deaths', () => {
  const b = createMedalBook(); b.start('slayer');
  for (let i = 0; i < 15; i++) b.kill(kill('p', `v${i}`), i * 10);
  assert.deepEqual(keys(b.end({ mode: 'slayer', winner: 'red', roster: [{ id: 'p', team: 'red' }] })), ['PERFECTION']);
});

check('counts per body for the scoreboard', () => {
  const b = createMedalBook(); b.start('slayer');
  b.kill(kill('p', 'a'), 0); b.kill(kill('p', 'b'), 1);
  assert.equal(b.count('p'), 2);   // First Strike + Double Kill
  assert.deepEqual(b.counts('p'), { FIRST_STRIKE: 1, DOUBLE_KILL: 1 });
});

check('headline: a multi-kill outranks a spree outranks a style medal', () => {
  assert.ok(rankOf('DOUBLE_KILL') > rankOf('KILLING_SPREE'));
  assert.ok(rankOf('KILLING_SPREE') > rankOf('BEAT_DOWN'));
  assert.ok(rankOf('KILLIONAIRE') > rankOf('DOUBLE_KILL'));
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

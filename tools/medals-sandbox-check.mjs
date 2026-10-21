// Node check of what sits around the medal book (src/game/medals.js; its Halo rules are
// tools/medals-check.mjs's): the sim's chaos medals, the sandbox's medals fed by the
// killfeed (src/pov/sandboxMedals.js, src/pov/killfeed.js), the drawn badges
// (src/game/medalBadge.js) and the announcer (src/pov/announcer.js: clips, its queue,
// the speech fallback, the match's lines). No browser: a stub DOM, stubbed CSS, a
// shiftable clock, a fake audio context and a fake speechSynthesis.
// usage: node tools/medals-sandbox-check.mjs
import { register } from 'node:module';

// .css imports are Vite's: here they're empty modules
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, ctx, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return next(url, ctx);
}`)}`);

// ---- a stub DOM: enough for ui/dom.js h(), the killfeed and the medal stack
class El {
  constructor(tag) { this.tag = tag; this.nodeType = 1; this.children = []; this.parent = null; this.attrs = {}; this.cls = new Set(); this.textContent = ''; this.innerHTML = ''; this.style = { setProperty() {} }; this.offsetWidth = 0; }
  get className() { return [...this.cls].join(' '); }
  set className(v) { this.cls = new Set(String(v).split(' ').filter(Boolean)); }
  get classList() { const c = this.cls; return { add: (k) => c.add(k), remove: (k) => c.delete(k), contains: (k) => c.has(k), toggle: (k, on = !c.has(k)) => (on ? c.add(k) : c.delete(k)) }; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  get firstElementChild() { return this.children[0] ?? null; }
  find(cls) { const out = []; const walk = (e) => { for (const c of e.children) { if (c.cls?.has(cls)) out.push(c); if (c.children) walk(c); } }; walk(this); return out; }
}
globalThis.document = { body: new El('body'), hidden: false, createElement: (t) => new El(t), createElementNS: (_, t) => new El(t), createTextNode: (t) => ({ nodeType: 3, textContent: t }) };
globalThis.requestAnimationFrame = () => 0;   // the killfeed's slide-up never runs: only its notices are checked
const spoken = [];
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
globalThis.speechSynthesis = { speaking: false, pending: false, getVoices: () => [], addEventListener() {}, speak: (u) => spoken.push(u.text), cancel() {} };
// a clock the check can move on (the sandbox's book runs on the wall clock)
const realNow = performance.now.bind(performance);
let skip = 0;
performance.now = () => realNow() + skip * 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { povEvents } = await import('../src/pov/events.js');
const { PLAYER } = await import('../src/pov/targets.js');
const { createMedalBook, MEDALS, CHAIN_GAP_S } = await import('../src/game/medals.js');
const { createDeathWatch } = await import('../src/pov/killfeed.js');
const { createSandboxMedals } = await import('../src/pov/sandboxMedals.js');
const { badgeSvg } = await import('../src/game/medalBadge.js');
const { connectAnnouncer, announceMatches, play, LINES, announcerStats } = await import('../src/pov/announcer.js');

let fails = 0;
const check = (ok, what, got) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: got ${JSON.stringify(got)}`}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (list) => list.map((m) => m.key);

// ---- the book's chaos medals
{
  const book = createMedalBook();
  check(same(keys(book.kill({ id: PLAYER, by: null, cause: 'Blown up', self: true }, 0)), ['OWN_GOAL']), 'your own blast killed you: Own Goal');
  check(same(keys(book.kill({ id: PLAYER, by: null, cause: 'Fell' }, 1)), []), 'a fall: nothing');
  check(keys(book.kill({ id: 'a', by: PLAYER, cause: 'Bored' }, 10)).includes('BORED'), 'a burrower kill: Bored');
  check(keys(book.kill({ id: 'b', by: PLAYER, cause: 'Buried in sand' }, 20)).includes('HEAVY_PARTICLES'), 'buried with your credit: Heavy Particles');
  check(keys(book.kill({ id: 'c', by: PLAYER, cause: 'Drowned in water' }, 30)).includes('FLOODED'), 'drowned with your credit: Flooded');
  check(same(keys(book.kill({ id: 'd', by: null, cause: 'Drowned in water' }, 40)), []), "drowned with nobody's credit: nothing");
  let t = 100;
  const blasts = (...bys) => bys.flatMap(([by, dt]) => { t += dt; return keys(book.blast(by, t)); });
  check(same(blasts([PLAYER, 0], ['vehicle:1', 0.1], ['vehicle:2', 0.2]), ['CHAIN_REACTION']), 'your blast, then two vehicles: Chain Reaction');
  check(same(blasts(['vehicle:3', 0.2]), []), '...once per chain');
  check(same(blasts([PLAYER, 10], [PLAYER, 0.3], [PLAYER, 0.3]), []), 'your own blasts alone: no chain');
  check(same(blasts([PLAYER, 10], ['vehicle:4', 0.5], ['vehicle:5', CHAIN_GAP_S + 0.5]), []), 'a link too late breaks it');
  check(Object.keys(MEDALS).every((k) => badgeSvg(k).startsWith('<svg')), `every medal (${Object.keys(MEDALS).length}) has a drawn badge`);
  check(new Set(Object.keys(MEDALS).map((k) => badgeSvg(k).match(/id="([^"]+)rim"/)[1])).size === Object.keys(MEDALS).length, '...each with its own gradient ids');
  check((badgeSvg('KILLTACULAR').match(/<polygon/g) ?? []).length === 5, 'a Killtacular wears five stars');
}

// ---- the sandbox: the killfeed's 'kill' feeds the book; only the player's show
let matchOn = false, dead = false;
const sandbox = createSandboxMedals({ quiet: () => matchOn, isPlayerDead: () => dead });
const medalEvents = [];
povEvents.on('game:medal', (e) => medalEvents.push(e));
const takeMedals = () => medalEvents.splice(0).map((e) => e.key);
const stack = () => document.body.find('feel-medal-hud').find((r) => r.cls.has('solo'));
check(!!stack() && stack().cls.has('on'), 'the sandbox stack is on the page, placed with no tracker under it (solo)');

const bodies = [[PLAYER, { dead: false, cause: '' }]];
const watch = createDeathWatch({ heldBy: (id) => (id === PLAYER ? held : 'AXE'), bodies: () => bodies, quiet: () => matchOn });
let held = 'GUN', n = 0;
function npcDies(cause, { by = PLAYER, kind = 'axeman' } = {}) {
  const id = `${kind}${n++}`, body = { dead: false, cause: '' };
  bodies.push([id, body, kind]);
  watch.update();
  povEvents.as(by === PLAYER ? null : { id: by, at: null }, () => povEvents.emit('body:hit', { id, amount: 1, cause }));
  body.dead = true; body.cause = cause;
  watch.update();
  return id;
}
npcDies('Shot');
check(same(takeMedals(), []), "one kill: nothing (no First Strike: that's a match's)");
npcDies('Shot');
check(same(takeMedals(), ['DOUBLE_KILL']), 'a second within 4 s: Double Kill, as game:medal mine', medalEvents);
skip += 10;
for (const [cause, h, want] of [
  ['Axed', 'AXE', 'BEAT_DOWN'], ['Kicked', 'GUN', 'BEAT_DOWN'], ['Backstabbed', 'KNIFE', 'ASSASSIN'],
  ['Shot', 'SNIPER', 'SNIPER_KILL'], ['Run over by a jeep', 'GUN', 'SPLATTER'], ['Lasered', 'LASER', 'LASER_KILL'],
  ['Burned', 'BLOWTORCH', 'INCINERATION'], ['Burned', 'GUN', null], ['Bored', 'BURROWER', 'BORED'],
]) {
  skip += 10; held = h;
  const got = takeMedals(npcDies(cause)).filter((k) => !/SPREE|FRENZY/.test(k));
  check(same(got, want ? [want] : []), `sandbox: ${cause} with the ${h} → ${want ?? 'nothing'}`, got);
}
held = 'GUN';
skip += 10; takeMedals();
// an axeman's spree, ended by you
skip += 10;
const ax = 'axeman-killer';
for (let i = 0; i < 5; i++) npcDies('Axed', { by: ax, kind: 'worm' });
check(same(takeMedals(), []), "an axeman's kills: none of yours");
skip += 10;
bodies.push([ax, { dead: false, cause: '' }, 'axeman']); watch.update();
povEvents.emit('body:hit', { id: ax, amount: 1, cause: 'Shot' }); bodies.at(-1)[1].dead = true; bodies.at(-1)[1].cause = 'Shot'; watch.update();
check(takeMedals().includes('KILLJOY'), "ending the axeman's 5-kill spree: Killjoy");
skip += 10; dead = true; npcDies('Blown up'); dead = false;
check(takeMedals().includes('DEATH_FROM_THE_GRAVE'), 'a kill while you lie dead: Death from the Grave');
// Chain Reaction through 'blast'
skip += 10;
povEvents.emit('blast', { point: {} });
povEvents.as({ id: 'vehicle:9', at: null }, () => povEvents.emit('blast', { point: {} }));
povEvents.as({ id: 'vehicle:10', at: null }, () => povEvents.emit('blast', { point: {} }));
const chain = medalEvents.slice(-1)[0];
check(same(takeMedals(), ['CHAIN_REACTION']) && chain.mine && chain.by === undefined, "your blast sets off two vehicles: Chain Reaction (the player's, not the vehicle's)", chain);
// the player's own death
skip += 10;
bodies[0][1].pos = { distanceTo: () => 0 };   // (a blast marks the bodies near it: this one is near everything)
povEvents.emit('blast', { point: {} });
bodies[0][1].dead = true; bodies[0][1].cause = 'Blown up';
watch.update();
bodies[0][1].dead = false; watch.update();
check(takeMedals().includes('OWN_GOAL'), 'your blast, your death: Own Goal');
// stands down in a match
matchOn = true; skip += 10;
povEvents.emit('kill', { id: 'x', victim: 'Ash', by: PLAYER, killer: 'You', cause: 'Shot', icon: 'GUN', held: 'GUN', self: false, team: true });
povEvents.emit('kill', { id: 'y', victim: 'Ash', by: PLAYER, killer: 'You', cause: 'Shot', icon: 'GUN', held: 'GUN', self: false, team: false });
check(same(takeMedals(), []), "a match's kills are game/feel.js's: the sandbox stands down");
matchOn = false;
const shown = stack().find('feel-medal');
check(shown.length > 0 && shown.length <= 6 && shown.every((m) => m.find('feel-badge')[0]?.innerHTML.startsWith('<svg')), 'the stack shows at most 6, each with its drawn badge', shown.length);

// ---- the announcer: clips first, the synthesized voice for a missing one, match lines
const started = [];
const fakeCtx = {
  decodeAudioData: async (data) => ({ duration: 0.05, key: data.key }),   // the clip remembers its key, to read the order back
  createGain: () => ({ gain: { value: 1 }, connect: (x) => x, disconnect() {} }),
  createBufferSource() {
    const s = { buffer: null, onended: null, connect: (x) => x, disconnect() {}, start() { started.push({ at: realNow(), key: s.buffer.key }); setTimeout(() => s.onended?.(), s.buffer.duration * 1000); } };
    return s;
  },
};
const fetched = [];
const HAVE = ['DOUBLE_KILL', 'KILLING_SPREE', 'FLAG_TAKEN', 'MODE_CTF', 'GAME_OVER', 'RED_WINS'];   // on the "server"; the rest answer with the page (an SPA fallback)
globalThis.fetch = async (url) => {
  fetched.push(url);
  const key = url.split('/').pop().replace('.mp3', ''), have = HAVE.includes(key);
  return { ok: true, headers: { get: () => (have ? 'audio/mpeg' : 'text/html') }, arrayBuffer: async () => Object.assign(new ArrayBuffer(8), { key }) };
};
spoken.length = 0;
let fell = 0;
check(play('DOUBLE_KILL', () => fell++) === false && fell === 1, 'no audio yet (no first person, no gesture): the fallback speaks');
connectAnnouncer(() => ({ ctx: fakeCtx, input: {} }));
check(play('NOPE', () => fell++) === false && fell === 2, 'an unknown line: the fallback');
play('DOUBLE_KILL'); play('KILLING_SPREE'); play('TRIPLE_KILL', () => fell++); play('FLAG_TAKEN'); play('DOUBLE_KILL');
await wait(1500);
const order = started.map((s) => s.key);
check(same(order, ['DOUBLE_KILL', 'KILLING_SPREE', 'FLAG_TAKEN', 'DOUBLE_KILL']), 'lines play in order; a missing clip is skipped', order);
check(fell === 3, "...and the missing one's fallback ran instead", fell);
const gaps = started.slice(1).map((s, i) => s.at - started[i].at);
check(gaps.every((g) => g >= 50), 'no two lines overlap', gaps);
check(fetched.filter((u) => u.endsWith('/DOUBLE_KILL.mp3')).length === 1 && announcerStats().missing.includes('TRIPLE_KILL'), 'a clip is asked for once a session; a missing one is remembered');
// the medal stack: the clip when there is one, else the speech
started.length = 0; spoken.length = 0;
skip += 10; npcDies('Shot'); skip += 1; npcDies('Shot');
await wait(300);   // (said before the clock jumps on: a line left waiting 5 s is dropped)
skip += 10; npcDies('Bored');
await wait(600);
check(same(started.map((s) => s.key), ['DOUBLE_KILL']) && same(spoken, ['Bored']), 'the stack says Double Kill from its clip, and Bored (no clip) with the browser voice', { clips: started.map((s) => s.key), spoken });
// the match's lines, from its events
started.length = 0; skip += 10;
announceMatches();
povEvents.emit('game:start', { mode: 'ctf', teams: { red: [PLAYER], blue: ['b1'] } });
povEvents.emit('game:flag', { team: 'red', action: 'taken', by: 'b1' });
povEvents.emit('game:flag', { team: 'blue', action: 'captured', by: PLAYER });   // yours: the medal's line, not this
povEvents.emit('game:end', { mode: 'ctf', winner: 'red', why: '3 to 1' });
await wait(800);
check(same(started.map((s) => s.key), ['MODE_CTF', 'FLAG_TAKEN', 'GAME_OVER', 'RED_WINS']), 'a match: its mode, Flag taken, Game over, Red team wins (your capture left to your medal)', started.map((s) => s.key));
started.length = 0; skip += 10;
povEvents.emit('game:end', { mode: 'ctf', winner: null, why: '' });
await wait(200);
check(started.length === 0, 'a match stopped by hand: nothing to call');
check(Object.keys(MEDALS).every((k) => LINES[k] === `${MEDALS[k].name}!`) && Object.keys(LINES).length > Object.keys(MEDALS).length, `the manifest: every medal's name and the match's lines (${Object.keys(LINES).length})`);

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);

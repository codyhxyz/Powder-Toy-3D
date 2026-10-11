// Node check of the medals (src/pov/medals.js), the killfeed's 'kill' that drives
// them (src/pov/killfeed.js) and the announcer's queue (src/pov/announcer.js).
// No browser: a stub DOM, a stubbed CSS import, a fake clock for the rules and a
// fake audio context. usage: node tools/medals-check.mjs
import { register } from 'node:module';

// .css imports are Vite's: here they're empty modules
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, ctx, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return next(url, ctx);
}`)}`);

// ---- a stub DOM: enough for the killfeed's notices and the medal row
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.parent = null; this.attrs = {}; this.className = ''; this.textContent = ''; this.innerHTML = ''; this.style = { setProperty() {} }; }
  get classList() { const el = this; return { add: (c) => { el.className += ` ${c}`; }, contains: (c) => el.className.split(' ').includes(c), toggle() {} }; }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  get firstElementChild() { return this.children[0] ?? null; }
  querySelectorAll(cls) { const out = []; const walk = (e) => { for (const c of e.children) { if (c.className.split(' ').includes(cls.slice(1))) out.push(c); walk(c); } }; walk(this); return out; }
}
globalThis.document = { body: new El('body'), createElement: (t) => new El(t), createElementNS: (_, t) => new El(t) };
globalThis.requestAnimationFrame = () => 0;   // the killfeed's slide-up never runs: only its notices are checked

const { povEvents } = await import('../src/pov/events.js');
const { PLAYER } = await import('../src/pov/targets.js');
const { createMedals } = await import('../src/pov/medals.js');
const { createDeathWatch } = await import('../src/pov/killfeed.js');
const { connectAnnouncer, play, LINES, announcerStats } = await import('../src/pov/announcer.js');
const { MEDALS, MULTIKILL_S } = await import('../src/pov/medaldefs.js');
const { badgeSvg } = await import('../src/pov/medalbadge.js');

let fails = 0;
const check = (ok, what, got) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: got ${JSON.stringify(got)}`}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- the rules, on a fake clock
let t = 100, dead = false;
const medals = createMedals({ now: () => t, isPlayerDead: () => dead });
const got = [];
povEvents.on('medal', ({ key }) => got.push(key));
const kill = (o) => povEvents.emit('kill', { id: 'npc', victim: 'Axeman', by: PLAYER, killer: 'You', cause: 'Shot', icon: 'GUN', held: 'GUN', self: false, team: false, ...o });
const take = () => got.splice(0);
const die = () => kill({ id: PLAYER, by: 'npc', cause: 'Axed' });

kill({}); check(same(take(), []), 'one kill: nothing');
t += MULTIKILL_S - 0.5; kill({}); check(same(take(), ['doubleKill']), 'second kill inside 4 s: Double Kill', got);
t += MULTIKILL_S - 0.5; kill({}); check(same(take(), ['tripleKill']), 'third inside 4 s of the second: Triple Kill');
t += MULTIKILL_S + 0.5; kill({}); check(same(take(), []), 'a kill 4.5 s later starts over');
t += 1; kill({}); check(same(take(), ['doubleKill', 'killingSpree']), '5th kill without dying: Double Kill and Killing Spree, in that order');
die(); take();
for (let i = 0; i < 12; i++) { t += 1; kill({}); }
const run = take();
check(same(run.filter((k) => MEDALS[k].family === 'multikill'), ['doubleKill', 'tripleKill', 'overkill', 'killtacular', 'killtrocity', 'killimanjaro', 'killtastrophe', 'killpocalypse', 'killionaire']), 'twelve quick kills: the whole ladder to Killionaire, no repeat', run);
check(same(run.filter((k) => MEDALS[k].family === 'spree'), ['killingSpree', 'killingFrenzy']), '...and Killing Spree at 5, Killing Frenzy at 10', run);
die(); take(); t += 10;
for (let i = 0; i < 4; i++) { t += 10; kill({}); }
check(same(take(), []), 'death resets the spree: 4 slow kills after it earn nothing');

const kinds = [
  [{ cause: 'Backstabbed', icon: 'backstab', held: 'KNIFE' }, 'assassin'],
  [{ cause: 'Stabbed', icon: 'KNIFE', held: 'KNIFE' }, 'beatDown'],
  [{ cause: 'Axed', icon: 'AXE' }, 'beatDown'],
  [{ cause: 'Kicked', icon: 'kick' }, 'beatDown'],
  [{ cause: 'Run over by a jeep', icon: 'jeep' }, 'splatter'],
  [{ cause: 'Burned', icon: 'BLOWTORCH', held: 'BLOWTORCH' }, 'incineration'],
  [{ cause: 'Burned', icon: 'fire', held: 'GUN' }, null],
  [{ cause: 'Shot', icon: 'SNIPER', held: 'SNIPER' }, 'sniperKill'],
  [{ cause: 'Lasered', icon: 'LASER' }, 'laserKill'],
  [{ cause: 'Bored', icon: 'BURROWER' }, 'bored'],
  [{ cause: 'Buried in sand', icon: 'buried' }, 'heavyParticles'],
  [{ cause: 'Drowned in water', icon: 'drowned' }, 'flooded'],
];
for (const [k, want] of kinds) { die(); take(); t += 10; kill(k); const g = take(); check(same(g, want ? [want] : []), `${k.cause} (${k.icon}) → ${want ?? 'nothing'}`, g); }
die(); take(); t += 10; kill({ by: 'npc2', killer: 'Axeman' }); check(same(take(), []), "someone else's kill: nothing");
kill({ id: 'bird:3', victim: 'Bird' }); check(same(take(), []), 'a bird: nothing');
povEvents.emit('kill', { id: PLAYER, victim: 'You', by: null, killer: null, cause: 'Blown up', icon: 'default', held: null, self: true, team: false });
check(same(take(), ['ownGoal']), 'killed by your own blast: Own Goal');
t += 10; kill({ id: PLAYER, by: null, cause: 'Fell' }); check(same(take(), []), 'a plain fall: nothing');
// weapon sprees
for (let i = 0; i < 10; i++) { t += 10; kill({ cause: 'Shot', icon: 'SNIPER', held: 'SNIPER' }); }
check(same(take().filter((k) => k !== 'sniperKill'), ['sniperSpree', 'killingSpree', 'sharpshooter', 'killingFrenzy']), '10 sniper kills: Sniper Spree, Sharpshooter (with the sprees)');
die(); take();
for (let i = 0; i < 5; i++) { t += 10; kill({ cause: 'Run over by a hoverbike', icon: 'hoverbike' }); }
check(take().includes('splatterSpree'), '5 run-overs: Splatter Spree');
// Killjoy and Death from the Grave
die(); take();
for (let i = 0; i < 5; i++) povEvents.emit('kill', { id: `v${i}`, victim: 'Gunner', by: 'gunner1', killer: 'Gunner', cause: 'Shot', icon: 'GUN', held: 'GUN', self: false, team: false });
t += 10; kill({ id: 'gunner1' }); check(same(take(), ['killjoy']), "ending a gunner's 5-kill spree: Killjoy");
t += 10; dead = true; kill({ cause: 'Blown up', icon: 'ROCKET' }); dead = false; check(same(take(), ['deathFromTheGrave']), 'a kill while dead: Death from the Grave');
// Chain Reaction
const blast = (by) => povEvents.emit('blast', by ? { point: {}, by } : { point: {} });
t += 10; blast(); t += 0.1; blast('vehicle:1'); t += 0.2; blast('vehicle:2'); check(same(take(), ['chainReaction']), 'your blast, then two vehicles: Chain Reaction');
t += 0.2; blast('vehicle:3'); check(same(take(), []), '...once per chain');
t += 10; blast(); t += 0.3; blast(); t += 0.3; blast(); check(same(take(), []), 'your own blasts alone: no chain');
t += 10; blast(); t += 0.5; blast('vehicle:4'); t += 2; blast('vehicle:5'); check(same(take(), []), 'a link 2 s late breaks it');
t += 10; blast('vehicle:6'); t += 0.1; blast('vehicle:7'); t += 0.1; blast('vehicle:8'); check(same(take(), []), "a chain you didn't start: nothing");

// ---- team games
povEvents.emit('game:start', { mode: 'ctf', teams: { red: [PLAYER, 'r1'], blue: ['b1', 'b2'] } });
povEvents.emit('game:flag', { team: 'red', action: 'taken', by: 'b1' });
t += 10; kill({ id: 'b1', team: true }); check(same(take(), ['killedFlagCarrier']), 'CTF: killing who carries your flag: Killed Flag Carrier');
povEvents.emit('game:flag', { team: 'red', action: 'dropped', by: null });
t += 10; kill({ id: 'b2', team: true }); check(same(take(), []), '...and nobody else');
povEvents.emit('game:flag', { team: 'blue', action: 'captured', by: PLAYER }); check(same(take(), ['flagScore']), 'CTF: your capture: Flag Score');
povEvents.emit('game:flag', { team: 'red', action: 'captured', by: 'b1' }); check(same(take(), []), "CTF: theirs: nothing");
povEvents.emit('game:end', { mode: 'ctf', winner: 'red', roster: [{ id: PLAYER, team: 'red', kills: 20, deaths: 0, me: true }] });
check(same(take(), []), 'CTF won: no Perfection (Slayer only)');
povEvents.emit('game:start', { mode: 'slayer', teams: { red: [PLAYER], blue: ['b1'] } });
povEvents.emit('game:end', { mode: 'slayer', winner: 'red', roster: [{ id: PLAYER, team: 'red', kills: 15, deaths: 0, me: true }] });
check(same(take(), ['perfection']), 'Slayer won with 15 kills, no deaths: Perfection');
povEvents.emit('game:start', { mode: 'slayer', teams: { red: [PLAYER], blue: ['b1'] } });
povEvents.emit('game:end', { mode: 'slayer', winner: 'red', roster: [{ id: PLAYER, team: 'red', kills: 15, deaths: 1, me: true }] });
check(same(take(), []), '...one death: none');
povEvents.emit('game:start', { mode: 'infection', teams: { blue: [PLAYER, 'h1', 'h2'], infected: ['z1'] } });
for (let i = 0; i < 5; i++) { t += 10; kill({ id: 'z1', team: true }); }
check(take().includes('zombieKillingSpree'), 'Infection: 5 zombie kills: Zombie Killing Spree');
povEvents.emit('game:team', { id: 'h1', team: 'infected' }); check(same(take(), []), 'Infection: one survivor turns: nothing yet');
povEvents.emit('game:team', { id: 'h2', team: 'infected' }); check(same(take(), ['lastManStanding']), "Infection: you're the last: Last Man Standing");
die(); take();
povEvents.emit('game:team', { id: PLAYER, team: 'infected' });
for (let i = 0; i < 5; i++) povEvents.emit('game:infected', { id: `h${i}`, by: PLAYER });
check(same(take(), ['infectionSpree']), 'Infection: 5 infections in one life: Infection Spree');
povEvents.emit('game:end', { mode: 'infection', winner: 'infected', roster: [] });
check(same(medals.awarded.slice(-1), ['infectionSpree']), 'medals.awarded keeps the log');

// ---- the killfeed drives it: body:hit marks the player as the killer, update() sees the death
const bodies = [[PLAYER, { dead: false, cause: '' }], ['axe1', { dead: false, cause: '' }, 'axeman'], ['axe2', { dead: false, cause: '' }, 'axeman']];
const watch = createDeathWatch({ heldBy: (id) => (id === PLAYER ? 'GUN' : 'AXE'), bodies: () => bodies, quiet: () => false });
const kills = [];
povEvents.on('kill', (e) => kills.push(e));
watch.update();
for (const id of ['axe1', 'axe2']) povEvents.emit('body:hit', { id, amount: 1, cause: 'Shot' });
bodies[1][1].dead = true; bodies[1][1].cause = 'Shot'; t += 1; watch.update();
bodies[2][1].dead = true; bodies[2][1].cause = 'Shot'; t += 1; watch.update();
check(kills.length === 2 && kills.every((k) => k.by === PLAYER && k.icon === 'GUN'), "killfeed: two 'kill's credited to the player", kills);
check(same(take(), ['doubleKill']), 'killfeed → medals: Double Kill', got);

// ---- the row and the badges (the stub DOM)
await new Promise((r) => setTimeout(r, 200));
const row = document.body.children.find((c) => c.className === 'medal-row');
const shown = row?.children ?? [];
check(!!row && shown.length >= 1 && shown.length <= 6, 'the medal row is on the page, at most 6 medals in it', shown.length);
check(shown.at(-1)?.innerHTML.startsWith('<svg') && shown.at(-1).children[0]?.textContent === MEDALS[medals.awarded.at(-1)]?.name, 'the newest medal: its badge and its name under it');
check(document.body.children.some((c) => c.className === 'killfeed'), 'the killfeed posted its notices too');
const svgs = Object.keys(MEDALS).map((k) => badgeSvg(k));
check(svgs.every((s) => s.startsWith('<svg') && s.includes('<path')) && new Set(svgs.map((s) => s.match(/id="([^"]+)rim"/)[1])).size === svgs.length, 'every medal has a badge, each with its own gradient ids');

// ---- the announcer: one line at a time, missing clips silent, late lines dropped
const started = [];
const fakeCtx = {
  decodeAudioData: async (data) => ({ duration: 0.05, key: data.key }),   // the clip remembers its key, to read the order back
  createGain: () => ({ gain: { value: 1 }, connect: (n) => n, disconnect() {} }),
  createBufferSource() {
    const s = { buffer: null, onended: null, connect: (n) => n, disconnect() {}, start() { started.push({ at: performance.now(), key: s.buffer.key }); setTimeout(() => s.onended?.(), s.buffer.duration * 1000); } };
    return s;
  },
};
const fetched = [];
const HAVE = ['doubleKill', 'killingSpree', 'flagTaken'];   // the clips on the "server"; the rest answer with the page (an SPA fallback)
globalThis.fetch = async (url) => {
  fetched.push(url);
  const key = url.split('/').pop().replace('.mp3', ''), have = HAVE.includes(key);
  return { ok: true, headers: { get: () => (have ? 'audio/mpeg' : 'text/html') }, arrayBuffer: async () => Object.assign(new ArrayBuffer(8), { key }) };
};
check(play('doubleKill') === false, 'no audio yet (no first person, no gesture): play() is a no-op');
connectAnnouncer(() => ({ ctx: fakeCtx, input: {} }));
check(play('nope') === false, 'an unknown key: refused');
play('doubleKill'); play('killingSpree'); play('tripleKill'); play('flagTaken'); play('doubleKill');
await new Promise((r) => setTimeout(r, 1500));
const order = started.map((s) => s.key);
check(same(order, ['doubleKill', 'killingSpree', 'flagTaken', 'doubleKill']), 'lines play in order; a missing clip (tripleKill) is skipped', order);
const gaps = started.slice(1).map((s, i) => s.at - started[i].at);
check(gaps.every((g) => g >= 50), 'no two lines overlap (each starts after the last ended)', gaps);
check(fetched.filter((u) => u.endsWith('/doubleKill.mp3')).length === 1, 'a clip is fetched once a session');
check(announcerStats().missing.includes('tripleKill'), 'the missing clip is remembered as missing');
check(Object.keys(LINES).length > 50 && Object.values(LINES).every((s) => typeof s === 'string' && s.length), `the manifest: ${Object.keys(LINES).length} lines`);

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);

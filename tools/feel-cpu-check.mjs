// CPU check of Halo's feel layer (src/game/feel.js: medals on screen, the motion tracker, the
// shrines' power-ups) in node: no browser, no GPU, no server. A tiny stand-in DOM records the
// medal HUD's elements and the tracker's canvas calls; CSS imports load as nothing. A fake
// Slayer match on red: the tracker's dots (a teammate, a moving enemy, a standing one that
// fires), two kills' medals and the voice, an Overshield pickup, and the match's end.
// usage: node tools/feel-cpu-check.mjs   (the browser check is tools/feel-check.mjs)
import { register } from 'node:module';

register(`data:text/javascript,${encodeURIComponent(
  "export async function load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); }",
)}`);

// ---- a tiny DOM: enough for ui/dom.js h(), the medal HUD and the tracker's canvas
const ops = [];
class ClassList { constructor() { this.s = new Set(); } add(...c) { c.forEach((x) => this.s.add(x)); } remove(...c) { c.forEach((x) => this.s.delete(x)); } contains(c) { return this.s.has(c); } toggle(c, v) { if (v === undefined) v = !this.s.has(c); v ? this.s.add(c) : this.s.delete(c); return v; } }
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.children = []; this.classList = new ClassList(); this.style = { setProperty() {} }; this.attrs = {}; this.textContent = ''; this.parent = null; this.id = ''; }
  append(...c) { for (const x of c) { x.parent?.children.splice(x.parent.children.indexOf(x), 1); x.parent = this; this.children.push(x); } }
  prepend(...c) { this.append(...c); }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  replaceChildren(...c) { this.children = []; this.append(...c); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  get offsetWidth() { return 10; }
  getContext() { const rec = { ops }; return new Proxy(rec, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[a-z]/.test(k) ? (...a) => ops.push([k, ...a]) : undefined), set: (t, k, v) => { t[k] = v; ops.push(['set', k, v]); return true; } }); }
  all(cls, out = []) { for (const c of this.children) { if (c.classList.contains(cls)) out.push(c); c.all(cls, out); } return out; }
}
globalThis.document = { createElement: (t) => new El(t), body: new El('body'), hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.devicePixelRatio = 1;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.getComputedStyle = () => ({ display: 'block' });
globalThis.requestAnimationFrame = () => 0;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
// speech: record what's said
globalThis.__said = [];
globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
globalThis.speechSynthesis = { speaking: false, pending: false, getVoices: () => [{ name: 'Daniel', lang: 'en-GB' }], addEventListener() {}, cancel() {}, speak(u) { globalThis.__said.push([u.text, u.pitch, u.rate, u.voice?.name]); } };

// ---- the match
const THREE = await import('three');
const { povEvents } = await import('../src/pov/events.js');
const { createFeel } = await import('../src/game/feel.js');
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };

// a fake match: the player on red at (100, 10, 100) looking north (-z); a red bot east, a blue bot north moving, a blue bot standing
const body = (x, y, z, vx = 0) => ({ pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(vx, 0, 0), dead: false, overshield(o) { this.os = o; return true; } });
const player = body(100, 10, 100);
const roster = new Map([
  ['player', { id: 'player', team: 'red', bot: null }],
  ['r1', { id: 'r1', team: 'red', bot: { body: body(120, 10, 100), agent: { intent: { tool: 'SMG' } } } }],
  ['b1', { id: 'b1', team: 'blue', bot: { body: body(100, 10, 80, 10), agent: { intent: { tool: 'SNIPER' } } } }],
  ['b2', { id: 'b2', team: 'blue', bot: { body: body(90, 30, 100), agent: { intent: { tool: 'SMG' } } } }],
]);
const camera = new THREE.PerspectiveCamera();   // looks down -z
let t = 0;
const orbs = { list: [], removed: [], added: [], feet: (o, v) => v.copy(o.feetV), remove(o) { this.removed.push(o); this.list.splice(this.list.indexOf(o), 1); }, add(k, f, s) { this.added.push(k); this.list.push({ key: k, feetV: f.clone(), shrine: s }); } };
for (let s = 1; s <= 2; s++) for (let i = 0; i < 3; i++) orbs.list.push({ key: `P${s}${i}`, shrine: s, feetV: new THREE.Vector3(50 * s + i * 3, 10, 50) });
const shell = {
  app: { getPerkOrbs: () => orbs, getVolume: () => ({ position: new THREE.Vector3() }), getScale: () => 1 },
  scene: new THREE.Scene(), camera, player, active: () => true, toolbelt: { selectedKey: 'SNIPER' },
};
const bodyOf = (e) => (e.bot ? e.bot.body : player);
const feel = createFeel({ shell, roster: () => roster, bodyOf, alive: (e) => !bodyOf(e).dead, clock: () => t });
feel.show(true);
povEvents.emit('game:start', { mode: 'slayer' });
assert(feel.powerups.length === 2 && orbs.list.length === 0, `power-ups replace the shrines' perks (${feel.powerups.length} pads, ${orbs.list.length} orbs left)`);

// tracker: draw a frame
ops.length = 0;
feel.update();
const arcs = ops.filter((o) => o[0] === 'arc' && o[3] === 3.6);   // dots (tracker.js DOT_PX at a pixel ratio of 1)
const tris = ops.filter((o) => o[0] === 'moveTo');
console.log('     dots', arcs.map((a) => a.slice(1, 3).map((x) => x.toFixed(1)).join(',')).join(' | '));
// tracker.js: TRACKER_PX 132 across, RIM_PX 2: c = 66, R = 64, k = R / RADAR (83.3 cells): b1 20 cells ahead → (66, 66 - 20k); r1 20 cells right → (66 + 20k, 66)
const k = 64 / (25 / 0.3);
assert(arcs.some((a) => Math.abs(a[1] - (66 + 20 * k)) < 0.01 && Math.abs(a[2] - 66) < 0.01), 'the teammate 20 cells east shows to the right (looking north)');
assert(arcs.some((a) => Math.abs(a[1] - 66) < 0.01 && Math.abs(a[2] - (66 - 20 * k)) < 0.01), 'the moving enemy 20 cells north shows ahead');
assert(arcs.length === 2, 'the standing enemy (b2) does not show');
// b2 fires: shows, as a triangle (20 cells = 6 m above)
povEvents.as({ id: 'b2', at: null }, () => povEvents.emit('gun:fire', {}));
ops.length = 0;
await new Promise((r) => setTimeout(r, 40));
feel.update();
const fills = ops.filter((o) => o[0] === 'moveTo').length;
assert(fills >= 2, `a shot shows the standing enemy, above: a triangle (${fills} paths with moveTo, the player's arrow is one)`);

// medals: two kills by the player with the sniper in hand within 4 s
const said0 = __said.length;
povEvents.emit('game:kill', { killer: 'You', killerTeam: 'red', victim: 'b1', victimTeam: 'blue', cause: 'Shot', by: 'player', id: 'b1' });
t = 2;
povEvents.emit('game:kill', { killer: 'You', killerTeam: 'red', victim: 'b2', victimTeam: 'blue', cause: 'melee', by: 'player', id: 'b2' });
const names = document.body.all('feel-name').map((e) => e.textContent);
console.log('     medals', names.join(', '));
assert(['First Strike', 'Sniper Kill', 'Double Kill', 'Beat Down'].every((n) => names.includes(n)), 'First Strike, Sniper Kill (the gun in hand), Double Kill, Beat Down');
const line = document.body.all('feel-line')[0];
assert(line.textContent === 'Double Kill' && line.classList.contains('on'), `the centre line: ${line.textContent}`);
assert(roster.get('player').medals === 4, `the roster entry counts ${roster.get('player').medals}`);
await new Promise((r) => setTimeout(r, 100));
console.log('     said', JSON.stringify(__said.slice(said0)));
assert(__said.length > said0 && __said.at(-1)[0] === 'Double Kill', 'the voice calls the headline');

// power-up pickup: walk the player into the first pad
const pad = feel.powerups[0];
player.pos.set(pad.feet.x, pad.feet.y, pad.feet.z);
let got = null;
povEvents.on('game:powerup', (e) => { got = e; });
feel.update();
assert(got?.mine && player.os?.layers === 2, `walking into it gives the Overshield (${JSON.stringify(player.os)})`);
assert(feel.powerups[0].readyAt === t + 120, 'and it waits 120 s');
// an overshielded bot glows; the player's own body (the camera's) doesn't
roster.get('r1').bot.body.overshielded = 'charging';
player.overshielded = 'on';
feel.update();
const root3d = shell.scene.getObjectByName('halo-powerups');
const glows = root3d.children.filter((o) => o.isMesh && o.visible);
assert(glows.length === 1 && Math.abs(glows[0].position.x - 120) < 1e-6, `one glow, round the overshielded bot (${glows.length})`);

// the end: perks back, pads gone, tracker off
povEvents.emit('game:stop', { mode: 'slayer', style: 'halo' });
assert(orbs.list.length === 6 && feel.powerups.length === 0, `the perks come back (${orbs.list.length})`);
const tr = document.body.all('feel-tracker')[0];
assert(!tr.classList.contains('on'), 'the tracker hides');
process.exit();

// Descent's level switch, the pure parts (src/pov/descent/switch.js): the body
// against the temple's box and exit, the event order of a level change and of
// the run's end, and that a switch hands over the run it started with.
// Runs against A's real levels.js. No browser.
//   node scripts/check-descent-switch.mjs

import { DESCENT_LEVELS } from '../src/world/scenes/descent/levels.js';
import { bodyInBox, createDescentSwitch, createDescentRunner, runSnapshot, runLost, spawnColumn } from '../src/pov/descent/switch.js';

let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.error('FAIL', msg); } else console.log('ok  ', msg); };
const v = (x, y, z) => ({ x, y, z });
const L = DESCENT_LEVELS;
ok(L.length === 3 && L.every((l) => l.spawn && l.temple?.box && l.temple?.exit), 'levels.js: three levels with spawn, temple box and exit');

// ---- the box test (feet; the body is BODY_WIDTH square, BODY_HEIGHT tall)
const [bx0, by0, bz0, bx1, by1, bz1] = L[0].temple.box;
const mid = v((bx0 + bx1) / 2, by0, (bz0 + bz1) / 2);
ok(bodyInBox(mid, L[0].temple.box), 'feet on the temple floor are in the temple');
ok(!bodyInBox(v(bx0 - 5, by0, mid.z), L[0].temple.box), 'five cells west of it is outside');
ok(bodyInBox(v(bx0 - 0.5, by0, mid.z), L[0].temple.box), 'a body half over its edge is in (it overlaps)');
ok(!bodyInBox(v(mid.x, by1 + 1, mid.z), L[0].temple.box), 'above its ceiling is outside');
ok(!bodyInBox(v(mid.x, by0 - 6, mid.z), L[0].temple.box), 'a body wholly below its floor is outside');
const [ex0, ey0, ez0, ex1, ey1, ez1] = L[0].temple.exit;
const pit = v((ex0 + ex1) / 2, ey0 + 1, (ez0 + ez1) / 2);
ok(bodyInBox(pit, L[0].temple.exit), 'feet down the exit pit are in the exit');
ok(!bodyInBox(v(pit.x, by0, pit.z), L[0].temple.exit), 'standing on the temple floor over it is not');
ok(!bodyInBox(L[0].spawn && v(...L[0].spawn), L[0].temple.exit), 'the spawn is not in the exit');
ok(L.every((l) => !bodyInBox(v(l.spawn[0] + 0.5, l.spawn[1], l.spawn[2] + 0.5), l.temple.exit)), 'no level spawns in its own exit (no switch loop)');
ok(JSON.stringify(spawnColumn(L[1])) === JSON.stringify([L[1].spawn[0], L[1].spawn[2]]), 'spawnColumn is the spawn\'s (x, z)');

// ---- the per-frame switch: events
const log = [];
const emit = (name, p) => log.push([name, p]);
const sw = createDescentSwitch({ levels: L, emit });
ok(sw.update({ key: 'island', feet: mid, live: true }) === null && log.length === 0, 'off Descent: nothing');
sw.update({ key: 'descentMines', feet: v(...L[0].spawn), live: true });
ok(log.length === 0, 'at the spawn: no temple event');
sw.update({ key: 'descentMines', feet: mid, live: true });
ok(log.at(-1)?.[0] === 'descent:temple' && log.at(-1)[1].inside === true && log.at(-1)[1].level === 0, 'walking in: descent:temple { level 0, inside }');
sw.update({ key: 'descentMines', feet: mid, live: true });
ok(log.length === 1, 'staying in: no repeat');
const go = sw.update({ key: 'descentMines', feet: pit, live: true });
ok(log.at(-2)?.[0] === 'descent:temple' && log.at(-2)[1].inside === false, 'down the pit the body has left the temple (its floor is above)...');
ok(log.at(-1)?.[0] === 'descent:exit' && log.at(-1)[1].level === 0, '...and then descent:exit { level 0 }');
ok(go?.from === 0 && go.next === L[1], 'and the switch to level 2');
ok(sw.update({ key: 'descentMines', feet: pit, live: true }) === null && log.filter(([n]) => n === 'descent:exit').length === 1, 'the exit fires once');
sw.update({ key: 'descentMines', feet: mid, live: true });   // (a level that loaded with the body still in its temple)
sw.arrive('descentCoal');
ok(log.at(-2)?.[0] === 'descent:temple' && log.at(-2)[1].inside === false, 'arriving from inside a temple leaves it first');
ok(log.at(-1)?.[0] === 'descent:level' && log.at(-1)[1].level === 1 && log.at(-1)[1].key === 'descentCoal', 'then descent:level { level 1, key }');
ok(sw.index === 1 && !sw.inside, 'the switch is on level 2, outside its temple');
log.length = 0;
sw.update({ key: 'descentCoal', feet: mid, live: false });
ok(log.length === 0, 'a dead body is in no temple');

// ---- the runner: a whole level change, then the run's end
const fake = { key: 'descentMines', load: 1, health: 0.4, gold: 230, wands: ['bolt', 'bomb', 'w3'], perks: [['EXTRA_HEALTH', 2]], status: ['WET'] };
const player = {
  get health() { return fake.health; }, shield: 0,
  perks: { list: () => fake.perks.map(([key, n]) => ({ perk: { key }, n })) },
  status: { list: () => fake.status.map((key) => ({ key })) },
};
const wands = { get wands() { return fake.wands.map((id) => ({ id })); }, bag: ['SPARK'] };
const seq = [];
const overlay = { show: (t) => seq.push(`overlay:${t}`), hide: () => seq.push('overlay:hide') };
const runner = createDescentRunner({
  levels: L,
  emit: (name, p) => seq.push(`${name}${p.inside !== undefined ? `:${p.inside}` : ''}${p.key ? `:${p.key}` : ''}`),
  loadScene: async (key) => { seq.push(`load:${key}`); fake.key = key; fake.load++; },
  enterAt: async (spawn) => { seq.push(`enter:${spawn.join(',')}`); },
  snapshot: () => runSnapshot({ player, gold: fake.gold, wands }),
  overlay, toast: (t) => seq.push(`toast:${t}`),
  finish: () => seq.push('menu'),
  wait: async () => {},
  loadId: () => fake.load,
});
const frame = (feet) => runner.frame({ key: fake.key, feet, live: true, load: fake.load });
frame(v(...L[0].spawn));
ok(seq[0] === 'descent:level:descentMines' && seq[1] === 'overlay:Mines', 'the map menu\'s Descent, entered by hand: descent:level and the name card');
frame(mid);
const p1 = frame(pit);
ok(p1 instanceof Promise && runner.busy, 'the pit starts a switch');
ok(frame(pit) === null, 'frames during it do nothing');
const before = runSnapshot({ player, gold: fake.gold, wands });
await p1;
const want = ['descent:temple:true', 'descent:temple:false', 'descent:exit', 'overlay:Descending…', 'load:descentCoal', `enter:${L[1].spawn.join(',')}`, 'descent:level:descentCoal', 'overlay:Coal Pits'];
ok(JSON.stringify(seq.slice(2)) === JSON.stringify(want), `a level change's order: ${seq.slice(2).join(' → ')}`);
ok(runLost(before, runSnapshot({ player, gold: fake.gold, wands })).length === 0, 'the run came through: health, perks, statuses, gold, wands, bag');
fake.health = 1;
ok(JSON.stringify(runLost(before, runSnapshot({ player, gold: fake.gold, wands }))) === '["health"]', 'and a lost field would show');
seq.length = 0;
frame(v(...L[1].spawn));
ok(seq.length === 0, 'no second descent:level on the new level\'s first frame');
// down the second, then the last
await frame(pit);
ok(fake.key === 'descentSnow' && seq.includes('descent:level:descentSnow'), 'level 2\'s exit loads level 3');
seq.length = 0;
await frame(pit);
ok(seq.includes('descent:exit') && seq.includes('overlay:You reached the bottom') && seq.at(-1) === 'menu' && !seq.some((s) => s.startsWith('load:')), 'level 3\'s exit: "You reached the bottom", then the map menu, no load');

// a load that fails: no lockup, a toast
const bad = createDescentRunner({
  levels: L, emit: () => {}, overlay, toast: (t) => seq.push(`toast:${t}`), wait: async () => {}, finish: () => {},
  loadScene: async () => { throw new Error('test: no GPU'); }, enterAt: async () => {},
});
const err = console.error; console.error = () => {};
bad.frame({ key: 'descentMines', feet: mid, live: true, load: 1 });
const r = await bad.frame({ key: 'descentMines', feet: pit, live: true, load: 1 });
console.error = err;
ok(r === false && !bad.busy && seq.at(-1)?.startsWith('toast:'), 'a failed load: toast, not stuck');

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('all passed');

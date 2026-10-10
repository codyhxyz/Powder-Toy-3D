// CPU check of the shared element mechanisms (elements.js cold/hot/crush,
// REACTIONS, blast; docs/elements.md): adds test rows to the element table at
// runtime (nothing real is added), runs them through the dock tiles' CPU twin
// of the engine (src/ui/tiles/engine.js), and compiles the GPU passes with the
// same rows through glslangValidator.
//   node tools/elements-core-check.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ELEMENTS, E, K, R, REACTIONS, elementRow, mechanisms } from '../src/elements.js';
// The GPU passes' modules load before the test rows exist (shaders/far.js
// checks the element count as it loads); their GLSL reads the table when built.
import { gridLayout } from '../src/sim.js';
import { reactFrag } from '../src/shaders/react.js';
import * as activity from '../src/shaders/activity.js';
import * as move from '../src/shaders/move.js';

// ---- test rows ----
const add = (d) => {
  const id = ELEMENTS.length;
  ELEMENTS.push(elementRow({ render: R.OPAQUE, color: '#808080', cond: 0.01, cap: 0.5, ...d }, id));
  E[d.key] = id;
  return id;
};
// a liquid-nitrogen-like boil: latent heat, and a puff of gas
const BOIL_T = -196, BOIL_L = 38, BOIL_PUFF = 690;
add({ key: 'T_CRYO', kind: K.LIQUID, dens: 8, temp: BOIL_T, hot: { T: BOIL_T, into: 'EMPTY', latent: BOIL_L, puff: BOIL_PUFF } });
// instant phase changes, a weighted product list, and a cold one
const BRINE_BOIL = 100, BRINE_FREEZE = -21, BRINE_SALT = 0.1;
add({ key: 'T_BRINE', kind: K.LIQUID, dens: 11, flow: 0.8,
  hot: { T: BRINE_BOIL, into: [['STEAM', 1 - BRINE_SALT], ['SAND', BRINE_SALT]] }, cold: { T: BRINE_FREEZE, into: 'ICE' } });
// a melt that remembers something else (of), and a crush
const ORE_MELT = 900, FOAM_CRUSH = 5;
add({ key: 'T_ORE', kind: K.SOLID, hot: { T: ORE_MELT, into: 'LAVA', of: 'METAL' } });
add({ key: 'T_FOAM', kind: K.SOLID, crush: { P: FOAM_CRUSH, into: 'SAND' } });
// reactions: a pair, a gated pair, a wildcard
add({ key: 'T_SALT', kind: K.POWDER, dens: 20, slide: 0.5 });
add({ key: 'T_FUEL', kind: K.SOLID });
add({ key: 'T_OX', kind: K.SOLID });
add({ key: 'T_ANTI', kind: K.SOLID });
const DISSOLVE_HEAT = -0.5, GATE_T = 500;
REACTIONS.push(
  { a: 'T_SALT', b: 'WATER', into: ['EMPTY', 'T_BRINE'], chance: 0.02, heat: DISSOLVE_HEAT },
  { a: 'T_FUEL', b: 'T_OX', into: ['FIRE', 'SAME'], chance: 0.1, minT: GATE_T, heat: 50 },
  { a: 'T_ANTI', b: '*', except: ['WALL'], into: ['EMPTY', 'EMPTY'], chance: 0.05, heat: 10 },
);
// explosives: a shock-sensitive liquid that also goes off under pressure, and a solid charge
const NITRO_SHOCK = 4, NITRO_CRUSH_P = 30, C4_SHOCK = 20;
add({ key: 'T_NITRO', kind: K.LIQUID, dens: 16, blast: { P: 80, T: 3000, shock: NITRO_SHOCK, crushP: NITRO_CRUSH_P } });
add({ key: 'T_C4', kind: K.SOLID, blast: { P: 100, T: 3000, shock: C4_SHOCK } });

// ---- the CPU twin (imported after the rows exist: it bakes its tables on load) ----
const { World } = await import('../src/ui/tiles/engine.js');
const { PHYS } = await import('../src/physics.js');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const world = (nx = 24, ny = 24) => { const w = new World(nx, ny); w.gravity = 0.025; return w; };
const fill = (w, x0, y0, x1, y1, id, extra) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) w.put(x, y, id, extra); };
const count = (w, id) => w.id.reduce((n, v) => n + (v === id), 0);
const where = (w, id) => w.id.findIndex((v) => v === id);
const puffP = (v) => PHYS.STEAM_BOIL_PUFF * v / PHYS.STEAM_EXPANSION;

// 1. latent heat: the cryogen holds at its boiling point, banking heat, then boils with a puff
{
  const w = world();
  fill(w, 0, 0, 24, 1, E.WALL);
  w.put(12, 1, E.T_CRYO);
  const i = w.idx(12, 1);
  let steps = 0, maxT = -Infinity, banked = 0;
  while (w.id[i] === E.T_CRYO && steps < 20000) {
    maxT = Math.max(maxT, w.T[i]); banked = w.life[i];
    const P0 = w.P[i];
    w.step(); steps++;
    if (w.id[i] !== E.T_CRYO) check('cryogen boils with a pressure puff', w.P[i] > P0 + 0.5 * puffP(BOIL_PUFF), `P ${w.P[i].toFixed(3)}, puff ${puffP(BOIL_PUFF).toFixed(3)}`);
  }
  check('cryogen pinned at its boiling point while it banks latent heat', maxT === BOIL_T, `max T ${maxT}`);
  check('cryogen boils once a full latent heat is banked', w.id[i] === E.EMPTY && banked > 0.9 * BOIL_L && steps > 10, `${steps} steps, banked ${banked.toFixed(1)} of ${BOIL_L}`);
}
// 2. instant phase changes, a weighted product list, cold
{
  const w = world(40, 40);
  fill(w, 0, 0, 40, 40, E.T_BRINE, { T: BRINE_BOIL + 50 });
  w.step();
  const n = 40 * 40, sand = count(w, E.SAND), steam = count(w, E.STEAM);
  check('brine boils instantly into a weighted list', sand + steam === n && Math.abs(sand / n - BRINE_SALT) < 0.03, `${steam} steam, ${sand} sand (${(sand / n).toFixed(3)}, want ${BRINE_SALT})`);
  const c = world();
  c.put(5, 5, E.T_BRINE, { T: BRINE_FREEZE - 5 });
  c.put(15, 5, E.T_BRINE, { T: BRINE_FREEZE + 5 });
  c.step();
  check('brine freezes at its cold point, not above it', count(c, E.ICE) === 1 && count(c, E.T_BRINE) === 1);
}
// 3. a melt into LAVA remembers `of`; crush by air pressure
{
  const w = world();
  w.put(5, 5, E.T_ORE, { T: ORE_MELT + 10 });
  w.put(15, 5, E.T_ORE, { T: ORE_MELT - 10 });
  w.step();
  const lava = where(w, E.LAVA);
  check('ore melts into lava that sets into metal (of)', lava >= 0 && w.ctype[lava] === E.METAL && count(w, E.T_ORE) === 1);
  const c = world();
  c.put(5, 5, E.T_FOAM); c.put(15, 5, E.T_FOAM);
  c.P[c.idx(6, 5)] = FOAM_CRUSH * 3;   // air beside the first
  c.step();
  check('foam crushes into sand beside high pressure, not elsewhere', count(c, E.SAND) === 1 && count(c, E.T_FOAM) === 1);
}
// 4. a reaction: both sides change in the same step, one partner each (matter is conserved)
{
  const w = world();
  fill(w, 0, 0, 24, 4, E.T_SALT);
  fill(w, 0, 4, 24, 12, E.WATER);
  const salt0 = count(w, E.T_SALT), water0 = count(w, E.WATER);
  let ok = true, steps = 0, T0 = w.T.reduce((s, v) => s + v, 0);
  for (; steps < 1500; steps++) {
    w.step();
    const ds = salt0 - count(w, E.T_SALT), dw = water0 - count(w, E.WATER), b = count(w, E.T_BRINE);
    if (ds !== b || dw !== b) { ok = false; break; }
  }
  const brine = count(w, E.T_BRINE);
  check('salt + water → air + brine, pair by pair', ok && brine > 20, `${brine} brine after ${steps} steps`);
  check('dissolving absorbs heat (heat < 0)', w.T.reduce((s, v) => s + v, 0) < T0);
}
// 5. a temperature gate: nothing below it; a hot spot past it starts the reaction
{
  const w = world();
  fill(w, 4, 4, 12, 5, E.T_FUEL);
  fill(w, 4, 5, 12, 6, E.T_OX);
  for (let t = 0; t < 600; t++) w.step();
  check('gated pair rests below its gate', count(w, E.T_FUEL) === 8 && count(w, E.T_OX) === 8);
  for (let x = 4; x < 12; x++) w.T[w.idx(x, 4)] = GATE_T + 300;   // a hot spot: the fuel's row
  for (let t = 0; t < 200; t++) w.step();
  check('a hot spot past the gate sets it off (SAME keeps the partner)', count(w, E.T_FUEL) < 8 && count(w, E.T_OX) === 8, `${count(w, E.T_FUEL)} fuel left`);
}
// 6. a wildcard: any matter but the exceptions, never itself or air
{
  const w = world();
  fill(w, 0, 0, 24, 1, E.WALL);
  fill(w, 4, 1, 6, 6, E.T_ANTI);   // two columns touching each other, the wall below
  fill(w, 6, 1, 7, 6, E.ROCK);     // and rock beside
  const anti0 = count(w, E.T_ANTI), rock0 = count(w, E.ROCK);
  for (let t = 0; t < 400; t++) w.step();
  const da = anti0 - count(w, E.T_ANTI), dr = rock0 - count(w, E.ROCK);
  check('wildcard annihilates rock pair by pair, spares wall and itself', da === dr && dr > 0 && count(w, E.WALL) === 24, `${dr} rock, ${da} anti gone`);
}
// 7. explosives: a shock-sensitive liquid, pressure, a solid charge
{
  const rest = world();
  fill(rest, 0, 0, 24, 1, E.ROCK);
  rest.put(12, 1, E.T_NITRO);
  for (let t = 0; t < 300; t++) rest.step();
  check('nitro at rest stays', count(rest, E.T_NITRO) === 1);
  const drop = world(8, 60);
  fill(drop, 0, 0, 8, 1, E.ROCK);
  drop.put(4, 58, E.T_NITRO);
  let boom = false;
  for (let t = 0; t < 400 && !boom; t++) { drop.step(); boom = count(drop, E.T_NITRO) === 0; }
  check('nitro dropped from 57 cells goes off when it lands', boom && count(drop, E.FIRE) > 0);
  const press = world();
  press.put(12, 12, E.T_NITRO, { T: 20 });
  press.P[press.idx(13, 12)] = NITRO_CRUSH_P * 2;
  press.step();
  check('nitro goes off under a blast\'s pressure (crushP)', count(press, E.T_NITRO) === 0);
  const shot = world();
  shot.put(12, 5, E.T_C4);
  shot.put(12, 9, E.SCRAP); shot.vy[shot.idx(12, 9)] = -PHYS.V_MAX;   // a slug: ½·78·1² = 39 > 20
  const soft = world();
  soft.put(12, 5, E.T_C4);
  soft.put(12, 9, E.SAND); soft.vy[soft.idx(12, 9)] = -0.5;           // sand: ½·16·0.5² = 2 < 20
  for (let t = 0; t < 30; t++) { shot.step(); soft.step(); }
  check('C-4 goes off when a slug hits it', count(shot, E.T_C4) === 0);
  check('C-4 shrugs off falling sand', count(soft, E.T_C4) === 1);
}
// 8. gunpowder runs on blast: fire sets it off, and it leaves its blast's heat and pressure
{
  const w = world();
  fill(w, 0, 0, 24, 1, E.ROCK);
  fill(w, 10, 1, 14, 3, E.GUNPOWDER);
  w.put(12, 3, E.FIRE);
  let seen = false;
  for (let t = 0; t < 40 && !seen; t++) {
    w.step();
    for (let i = 0; i < w.id.length; i++) if (w.id[i] === E.FIRE && w.T[i] > 2000) seen = true;
  }
  check('gunpowder still goes off from a flame, at its blast T', seen && count(w, E.GUNPOWDER) < 8);
}
// 9. the table's checks catch mistakes
{
  const bad = (name, fn) => {
    let threw = false;
    try { fn(); mechanisms(); } catch { threw = true; }
    check(`rejects ${name}`, threw);
  };
  const tryRow = (d) => () => { add(d); };
  const undo = () => { const e = ELEMENTS.pop(); delete E[e.key]; };
  bad('melt with hot', tryRow({ key: 'T_BAD', kind: K.SOLID, melt: 900, hot: { T: 900, into: 'LAVA' } })); undo();
  bad('latent heat on a fuel', tryRow({ key: 'T_BAD', kind: K.SOLID, life: 1, burnRate: 0.01, ignite: 300, hot: { T: 60, into: 'WATER', latent: 10 } })); undo();
  bad('an unknown product', tryRow({ key: 'T_BAD', kind: K.SOLID, cold: { T: 0, into: 'NOPE' } })); undo();
  bad('a blast without T', tryRow({ key: 'T_BAD', kind: K.SOLID, blast: { P: 10 } })); undo();
  bad('a second reaction for a pair', () => REACTIONS.push({ a: 'WATER', b: 'T_SALT', into: ['SAME', 'SAME'] })); REACTIONS.pop();
  mechanisms();
}

// ---- the GPU passes compile with the same rows ----
{
  const g = gridLayout(64, 64, 64);
  const dir = mkdtempSync(join(tmpdir(), 'elcore-'));
  const raw = '#version 300 es\n';
  const progs = {
    react: reactFrag(g), inertRows: activity.inertRowsFrag(g), inertRef: activity.inertRefFrag(g),
    moveBlock: move.moveBlockFrag(g), moveGather: move.moveGatherFrag(g),
  };
  for (const [name, src] of Object.entries(progs)) {
    const f = join(dir, `${name}.frag`);
    writeFileSync(f, raw + src);
    let ok = true, msg = '';
    try { execFileSync('glslangValidator', [f], { stdio: 'pipe' }); } catch (e) {
      ok = false; msg = String(e.stdout).split('\n').filter((l) => /ERROR/.test(l)).slice(0, 4).join(' | ');
    }
    check(`${name} compiles with the test rows`, ok, msg);
  }
}

console.log(failures ? `${failures} FAILED` : 'elements core: all checks pass');
process.exit(failures ? 1 : 0);

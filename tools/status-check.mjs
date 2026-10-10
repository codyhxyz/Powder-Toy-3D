// Check of the status effects (src/pov/status.js, src/pov/stains.js): stains from contact
// cells, Burning, Frozen, their cancelling, Toxic, Bleeding and an NPC's body.
// CPU only (node): real vitals.js and status sets fed made-up contact cells, the way
// player.js feeds them.
// usage: node tools/status-check.mjs
import { E } from '../src/elements.js';
import { createVitals } from '../src/pov/vitals.js';
import { createPerkSet } from '../src/pov/perks.js';
import { createStatusSet, registerStain, statusDef, shock, WET_SHOCK } from '../src/pov/status.js';
import { wound, BLEED_ELEMENT } from '../src/pov/stains.js';
import { povEvents } from '../src/pov/events.js';

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- CPU
const N = 200;   // contact cells around a body (player.js: ~3 × 7 × 3 cells with the reach)
const DT = 1 / 60;
const AIR_T = 22;

// A body as player.js builds it: vitals, perks, a status set, and its contact cells.
function makeBody() {
  const perks = createPerkSet();
  const spilled = [];
  let burns = 0;
  const ctx = {
    world: { burn() { burns++; }, spill(b, id, n) { spilled.push({ id, n }); } },
    hurt: (amount, cause, opts) => vitals.hurt(amount, cause, false, opts),
  };
  const body = { pos: { x: 0, y: 0, z: 0 }, perks };
  const vitals = createVitals((name, data) => { if (name === 'wound') wound(body, data.amount, ctx); }, perks);
  Object.defineProperties(body, {
    skinT: { get: () => vitals.skinT }, dead: { get: () => vitals.dead }, health: { get: () => vitals.health },
  });
  body.status = createStatusSet(body, ctx);
  const env = {
    contactId: new Int32Array(N), contactT: new Float32Array(N), contactLife: new Float32Array(N), contactN: N,
    headInLiquid: false, liquidId: -1, buriedId: -1, pressure: 0,
  };
  // touch: { elementKeyOrId: [share, T] }, the rest air at AIR_T
  body.touch = (touch = {}) => {
    let i = 0;
    for (const [k, [share, t]] of Object.entries(touch)) {
      const id = typeof k === 'string' && k in E ? E[k] : +k;
      for (let n = Math.round(share * N); n > 0 && i < N; n--, i++) { env.contactId[i] = id; env.contactT[i] = t; }
    }
    for (; i < N; i++) { env.contactId[i] = E.EMPTY; env.contactT[i] = AIR_T; }
  };
  // run for s seconds; until(body) stops early; returns the time it took (Infinity: never)
  body.run = (s, until = null) => {
    for (let t = 0; t < s; t += DT) {
      vitals.update(DT, env);
      body.status.update(DT, env);
      if (until?.(body)) return t + DT;
    }
    return Infinity;
  };
  body.vitals = vitals; body.env = env; body.spilled = spilled;
  Object.defineProperty(body, 'burns', { get: () => burns });
  body.touch();
  return body;
}

const events = [];
povEvents.on('status:on', (e) => events.push(['on', e.key, e.cause, e.by]));
povEvents.on('status:off', (e) => events.push(['off', e.key, e.cause, e.by]));

// ---- standing in water gives Wet
{
  const b = makeBody();
  b.touch({ WATER: [0.3, AIR_T] });   // waist deep
  const t = b.run(2, (x) => x.status.has('WET'));
  check('standing in water gives Wet', b.status.has('WET'), `shows in ${r2(t)} s`);
  b.run(3);
  check('a soak lasts', b.status.time('WET') > 9, `${r2(b.status.time('WET'))} s left after 3 s in it`);
  b.touch();
  b.status.add('WET', 10);
  const dry = b.run(30, (x) => !x.status.has('WET'));
  check('Wet dries off by itself', !b.status.has('WET'), `after ${r2(dry)} s out of the water`);
  const hot = makeBody();
  hot.status.add('WET', 10);
  hot.touch({ STEAM: [0.5, 100] });   // hot skin dries it faster
  const dryHot = hot.run(30, (x) => !x.status.has('WET'));
  check('Wet dries faster when hot', dryHot < dry, `${r2(dryHot)} s in steam vs ${r2(dry)} s in air (skin ${r2(hot.skinT)} °C)`);
  const toe = makeBody();
  toe.touch({ WATER: [0.02, AIR_T] });   // a puddle under one boot
  toe.run(3);
  check('a splash on a boot is not Wet', !toe.status.has('WET'));
}

// ---- oil plus fire gives Burning (and oil lets it catch faster, burn longer)
{
  const plain = makeBody();
  plain.touch({ FIRE: [0.02, 900] });   // a brush of flame (4 cells)
  const tPlain = plain.run(3, (x) => x.status.has('BURNING'));
  const faint = makeBody();
  faint.touch({ FIRE: [0.005, 900] });   // one stray fire cell
  faint.run(3);
  check('one stray fire cell does not light it', !faint.status.has('BURNING'));
  const oily = makeBody();
  oily.touch({ OIL: [0.3, AIR_T] });
  oily.run(1);
  check('oil gives Oily', oily.status.has('OILY'));
  oily.touch({ FIRE: [0.02, 900] });
  const tOily = oily.run(3, (x) => x.status.has('BURNING'));
  check('oil plus fire gives Burning', oily.status.has('BURNING'), `caught in ${r2(tOily)} s (dry: ${r2(tPlain)} s)`);
  check('oily catches faster', tOily < tPlain);
  const burnOily = oily.status.time('BURNING'), burnPlain = plain.status.time('BURNING');
  check('oily burns longer', burnOily > burnPlain, `${r2(burnOily)} s vs ${r2(burnPlain)} s`);
  oily.touch();
  const h0 = oily.health;
  const out = oily.run(20, (x) => !x.status.has('BURNING'));
  check('Burning burns out and hurts', Number.isFinite(out) && oily.health < h0, `out after ${r2(out)} s more, took ${r2(h0 - oily.health)} health`);
  check('a burning body lights the world (fire passes)', oily.burns > 0, `${oily.burns} passes`);
  const immune = makeBody();
  immune.perks.add('FIRE_IMMUNITY');
  immune.status.add('BURNING', 3);
  const hi = immune.health;
  immune.run(2);
  check('Fire Immunity blocks the burn damage', immune.health === hi && immune.burns > 0);
  const hot = makeBody();
  hot.touch({ METAL: [0.6, 600] });   // skin past ignition, no flame touching
  const tHot = hot.run(10, (x) => x.status.has('BURNING'));
  check('heat past ignition sets it alight', hot.status.has('BURNING'), `in ${r2(tHot)} s, skin ${r2(hot.skinT)} °C`);
}

// ---- jumping in water puts Burning out; a wet body can't catch fire
{
  const b = makeBody();
  b.status.add('BURNING', 4);
  b.touch({ WATER: [0.7, AIR_T] });
  const t = b.run(1, (x) => !x.status.has('BURNING'));
  check('jumping in water puts Burning out', !b.status.has('BURNING') && b.status.has('WET'), `in ${r2(t)} s`);
  b.run(1);
  b.touch({ FIRE: [0.1, 900] });
  b.run(1);
  check('a wet body does not catch fire', !b.status.has('BURNING'));
  check('add() is refused while blocked', b.status.add('BURNING', 3) === false);
  const s = makeBody();
  s.status.add('BURNING', 4);
  s.touch({ SNOW: [0.5, -5] });
  const ts = s.run(2, (x) => !x.status.has('BURNING'));
  check('rolling in snow puts Burning out', !s.status.has('BURNING'), `in ${r2(ts)} s`);
}

// ---- cold gives Frozen, and Frozen slows the body
{
  const b = makeBody();
  b.touch({ METAL: [0.6, -40] });   // cold, no ice: the skin itself
  const t = b.run(20, (x) => x.status.has('FROZEN'));
  check('cold skin gives Frozen', b.status.has('FROZEN'), `in ${r2(t)} s, skin ${r2(b.skinT)} °C`);
  check('Frozen slows movement', b.status.moveScale < 0.5, `× ${r2(b.status.moveScale)}`);
  const s = makeBody();
  s.touch({ SNOW: [0.6, -5] });
  const ts = s.run(5, (x) => x.status.has('FROZEN'));
  check('buried in snow gives Frozen', s.status.has('FROZEN'), `in ${r2(ts)} s`);
  const ice = makeBody();
  ice.touch({ ICE: [0.15, -5] });   // standing on ice
  ice.run(5);
  check('standing on ice does not freeze', !ice.status.has('FROZEN'));
  b.touch({ WATER: [0.5, 60] });   // warmed back up
  const thaw = b.run(10, (x) => !x.status.has('FROZEN'));
  check('heat thaws Frozen', !b.status.has('FROZEN'), `in ${r2(thaw)} s, skin ${r2(b.skinT)} °C`);
}

// ---- Frozen and Burning cancel each other, both ways
{
  const def = (k) => statusDef(k);
  check('the rule is data (cancels)', def('FROZEN').cancels.includes('BURNING') || def('BURNING').cancels.includes('FROZEN'));
  const a = makeBody();
  a.status.add('FROZEN', 4);
  a.touch({ FIRE: [0.05, 900] });   // fire touches a frozen body
  a.run(1, (x) => x.status.has('BURNING'));
  check('fire on a Frozen body: Burning on, Frozen off', a.status.has('BURNING') && !a.status.has('FROZEN'));
  const b = makeBody();
  b.status.add('BURNING', 4);
  b.status.add('FROZEN', 4);
  check('Frozen on a Burning body: Frozen on, Burning off', b.status.has('FROZEN') && !b.status.has('BURNING'));
  const c = makeBody();
  c.status.add('FROZEN', 4);
  c.status.add('BURNING', 4);
  check('Burning on a Frozen body: Burning on, Frozen off', c.status.has('BURNING') && !c.status.has('FROZEN'));
  const off = events.findLast((e) => e[0] === 'off' && e[1] === 'FROZEN');
  check('status:off names what cancelled it', off?.[2] === 'BURNING', JSON.stringify(off));
}

// ---- Toxic does damage over time (TOXIC is branch nt-mat's: a stand-in element if it's absent)
{
  let key = 'TOXIC';
  if (E.TOXIC === undefined) { key = 'SAWDUST'; registerStain(key, 'TOXIC', { rate: 20, seconds: 6 }); }
  const b = makeBody();
  b.touch({ [key]: [0.3, AIR_T] });
  b.run(0.5);
  const on = b.status.has('TOXIC');
  b.touch();
  const h0 = b.health;
  b.run(3);
  check(`Toxic does damage over time (source ${key})`, on && b.health < h0, `${r2((h0 - b.health) / 3)} health/s, ${r2(b.status.time('TOXIC'))} s left`);
  b.touch({ WATER: [0.5, AIR_T] });
  const t = b.run(5, (x) => !x.status.has('TOXIC'));
  check('water washes Toxic off', !b.status.has('TOXIC'), `in ${r2(t)} s`);
}

// ---- Slimy slows; statuses' move multipliers multiply
{
  if (E.SLIME === undefined) registerStain('ASH', 'SLIMY', { rate: 20, seconds: 8 });
  const b = makeBody();
  b.touch({ [E.SLIME === undefined ? 'ASH' : 'SLIME']: [0.3, AIR_T] });
  b.run(0.5);
  check('Slimy slows movement', b.status.has('SLIMY') && b.status.moveScale < 1, `× ${r2(b.status.moveScale)}`);
}

// ---- Bleeding: a blow spills blood in proportion and stains Bloody; heat doesn't
{
  const b = makeBody();
  b.vitals.hurt(0.5, 'Shot', true, { shielded: true });
  const cells = b.spilled.reduce((s, x) => s + x.n, 0);
  const bloodId = E[BLEED_ELEMENT] ?? -1;
  check('a wound stains Bloody', b.status.has('BLOODY'));
  if (bloodId >= 0) check('a wound spills blood cells', cells > 0 && b.spilled.every((x) => x.id === bloodId), `${cells} cells of ${BLEED_ELEMENT} for 0.5 health`);
  else check(`a wound spills nothing while ${BLEED_ELEMENT} doesn't exist`, cells === 0, `(${BLEED_ELEMENT} is branch nt-mat's)`);
  const c = makeBody();
  c.vitals.hurt(0.5, 'Burned', false);
  check('heat damage does not bleed', !c.status.has('BLOODY') && c.spilled.length === 0);
  const s = makeBody();
  s.perks.add('ENERGY_SHIELD');
  s.vitals.reset();
  s.vitals.hurt(0.3, 'Shot', true, { shielded: true });
  check('a blow the shield takes does not bleed', !s.status.has('BLOODY'));
  b.touch({ WATER: [0.5, AIR_T] });
  const t = b.run(3, (x) => !x.status.has('BLOODY'));
  check('water washes Bloody off', !b.status.has('BLOODY'), `in ${r2(t)} s`);
}

// ---- electricity hook: no live cells until el-elec wires them; wet multiplies
{
  const b = makeBody();
  b.touch({ METAL: [0.1, AIR_T] });
  const live = (c) => c.id === E.METAL;
  const dry = shock(b.env, false, live), wet = shock(b.env, true, live);
  check('shock: nothing is live by default', shock(b.env, true) === 0);
  check('shock: wet skin takes WET_SHOCK ×', dry > 0 && Math.abs(wet / dry - WET_SHOCK) < 1e-9, `${r2(dry)} → ${r2(wet)} health/s`);
}

// ---- an NPC body: the same status set, its events carry who it is
{
  const b = makeBody();
  b.status.actor = { id: 'npc7', at: null };
  b.touch({ WATER: [0.3, AIR_T] });
  b.run(1);
  const e = events.findLast((x) => x[0] === 'on' && x[1] === 'WET');
  check('an NPC body gets stains, its events say whose', b.status.has('WET') && e?.[3] === 'npc7', JSON.stringify(e));
}

// ---- death clears them
{
  const b = makeBody();
  b.status.add('WET', 5); b.status.add('OILY', 5);
  b.vitals.hurt(5, 'Shot', true, { shielded: true });
  b.run(0.1);
  check('death clears every status', b.status.list().length === 0);
}

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);


// Check of the status effects (src/pov/status.js, src/pov/stains.js): stains from contact
// cells, Burning, Frozen, their cancelling, Toxic, Bleeding and an NPC's body.
// The default run is CPU only (node): real vitals.js and status sets fed made-up contact
// cells, the way player.js feeds them. --gpu then runs the real body in a browser (needs
// a dev server; AC power): a pool, fire on and off the body, snow, a wound's spill, the HUD
// row and the lab's NPC.
// usage: node tools/status-check.mjs [--gpu] [--port 5431] [--shot file.jpg]
import { E } from '../src/elements.js';
import { createVitals } from '../src/pov/vitals.js';
import { createPerkSet } from '../src/pov/perks.js';
import { createStatusSet, registerStain, statusDef, shock, WET_SHOCK } from '../src/pov/status.js';
import { wound, BLEED_ELEMENT } from '../src/pov/stains.js';
import { povEvents } from '../src/pov/events.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
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
    contactId: new Int32Array(N), contactT: new Float32Array(N), contactSpark: new Float32Array(N), contactN: N,
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
  check('shock: nothing is live by default', shock(b.env, true) === 0);
  b.env.contactSpark[0] = 0.5;   // el-elec's probe: a spark of strength 0.5 on one contact cell
  const dry = shock(b.env, false), wet = shock(b.env, true);
  check('shock: wet skin takes WET_SHOCK ×', dry > 0 && Math.abs(wet / dry - WET_SHOCK) < 1e-9, `${r2(dry)} → ${r2(wet)} health/s at strength 0.5`);
  const h0 = b.health;
  b.status.add('WET', 5);
  b.run(0.2);
  check('shock: a live cell hurts the body', b.health < h0, `${r2((h0 - b.health) / 0.2)} health/s wet`);
  b.env.contactSpark[0] = 0;
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

// ---------------------------------------------------------------- GPU (the real body)
if (args.includes('--gpu')) await gpu(opt('port', '5431'), opt('shot', null));

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);


async function gpu(port, shotPath) {
  const { chromium } = await import('playwright');
  const W = 960, H = 600;
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const p = await browser.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  // (the multiplayer relay isn't running locally: its refused connection isn't ours)
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push(m.text().slice(0, 400)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 600)));
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const settle = (ms) => p.waitForTimeout(ms);
  const dropIn = async (url) => {
    await p.goto(url);
    await p.waitForFunction(() => window.__app?.pov, null, { timeout: 60000 });
    await settle(1500);
    await p.mouse.move(W / 2, H / 2);
    await p.keyboard.press('f');
    await p.waitForFunction(() => window.__app.pov.mode === 'on', null, { timeout: 30000 }).catch(() => {});
    await ev(() => { window.__app.pov.test.assumeLocked = true; });
  };
  // paint a ball of element `key` (grid cells), the brush's way
  const paint = (key, [x, y, z], radius, replace = false) => ev(async ([key, x, y, z, radius, replace]) => {
    const { E } = await import('/src/elements.js');
    const a = window.__app, C = a.camera.position.constructor;
    a.sim.paint({ center: new C(x, y, z), radius, shape: 1, tool: E[key], rate: 1, replace });
  }, [key, x, y, z, radius, replace]);
  const stand = (x, z, y = 0) => ev(([x, y, z]) => { const a = window.__app; a.pov.player.spawn(a.pov.player.pos.clone().set(x, y, z)); }, [x, y, z]);
  const st = () => ev(() => window.__app.pov.player.status.list().map((s) => s.key));
  const count = (key) => ev(async (key) => { const { E } = await import('/src/elements.js'); const c = window.__app.sim.census()[E[key]]; return c ? { n: c.n, Tmax: Math.round(c.Tmax) } : { n: 0, Tmax: 0 }; }, key);
  const until = (fn, arg, ms) => p.waitForFunction(fn, arg, { timeout: ms, polling: 50 }).then(() => true, () => false);
  try {
    await dropIn(`http://localhost:${port}/?size=128&preset=empty`);
    check('gpu: dropped in', (await ev(() => window.__app.pov.mode)) === 'on');

    // ---- a wound spills cells in proportion (BLOOD is branch nt-mat's: none while it's absent)
    await stand(30, 30);
    await settle(800);
    const bleedKey = await ev(async () => (await import('/src/pov/stains.js')).BLEED_ELEMENT);
    const hasBlood = await ev(async (k) => (await import('/src/elements.js')).E[k] !== undefined, bleedKey);
    const b0 = await count(bleedKey);
    await ev(() => window.__app.pov.player.hurt(0.5, 'test'));
    await settle(600);
    const b1 = await count(bleedKey);
    if (hasBlood) check('gpu: a wound spills cells', b1.n > b0.n, `${bleedKey} ${b0.n} → ${b1.n} for 0.5 health`);
    else check(`gpu: no spill while ${bleedKey} doesn't exist`, b1.n === b0.n);
    check('gpu: a wound stains Bloody', (await st()).includes('BLOODY'), JSON.stringify(await st()));
    await ev(() => { const q = window.__app.pov.player; q.status.clearAll(); q.spawn(q.pos.clone()); });

    // ---- a burning body lights the world: FIRE cells around it, the wood beside it heats
    await stand(64, 64);
    await paint('WOOD', [66.8, 1.5, 64.5], 1.5, true);   // touching the body's side
    await settle(600);
    const w0 = await count('WOOD');
    await ev(() => window.__app.pov.player.status.add('BURNING', 4));
    let fireSeen = 0;
    for (let i = 0; i < 6; i++) { await settle(400); fireSeen = Math.max(fireSeen, (await count('FIRE')).n); }
    const w1 = await count('WOOD');
    check('gpu: a burning body puts FIRE in the air', fireSeen > 0, `${fireSeen} fire cells at most`);
    check('gpu: the wood beside it heats', w1.Tmax > w0.Tmax + 50, `wood Tmax ${w0.Tmax} → ${w1.Tmax} °C, ${w0.n} → ${w1.n} cells`);
    const hud = await ev(() => [...document.querySelectorAll('.pov-st')].map((e) => e.title + ' ' + e.querySelector('b')?.textContent));
    check('gpu: the HUD row shows it', hud.some((x) => x.startsWith('Burning')), JSON.stringify(hud));
    const tint = await ev(() => window.__app.pov.player.status.tint());
    check('gpu: the body is tinted', tint[3] > 0, JSON.stringify(tint.map((x) => +x.toFixed(2))));
    const burnOut = await until(() => !window.__app.pov.player.status.has('BURNING'), null, 6000);
    check('gpu: it burns out', burnOut);
    // oily, it burns long enough to set the wood alight (wood ignites at 300 °C)
    await ev(() => { const q = window.__app.pov.player; q.status.add('OILY', 15); q.status.add('BURNING', 10); });
    const caught = await until(async () => {
      const { E } = await import('/src/elements.js');
      return (window.__app.sim.census()[E.WOOD]?.Tmax ?? 0) > 300;
    }, null, 10000);
    const w2 = await count('WOOD');
    check('gpu: a burning oily body sets the wood beside it alight', caught, `wood Tmax ${w2.Tmax} °C, ${w2.n} cells left`);
    await ev(() => window.__app.pov.player.status.clearAll());

    // ---- touching fire sets it alight; jumping in water puts it out
    await stand(30, 90);
    await settle(500);
    for (let i = 0; i < 3; i++) { await paint('FIRE', [30, 3, 90], 2.5); await settle(100); }   // a gout of flame over the body
    const lit = await until(() => window.__app.pov.player.status.has('BURNING'), null, 3000);
    check('gpu: touching fire sets the body alight', lit, JSON.stringify(await st()));
    await paint('WATER', [90, 1.5, 90], 6); await paint('WATER', [90, 1.5, 90], 6); await paint('WATER', [90, 1.5, 90], 6);
    await settle(1200);
    await ev(() => window.__app.pov.player.status.add('BURNING', 4));
    await stand(90, 90, 4);
    const out = await until(() => { const s = window.__app.pov.player.status; return s.has('WET') && !s.has('BURNING'); }, null, 4000);
    check('gpu: jumping in water gives Wet and puts Burning out', out, JSON.stringify(await st()));

    // ---- buried in snow: Frozen, and it slows the body
    await ev(() => window.__app.pov.player.status.clearAll());
    await stand(30, 60);
    await settle(400);
    for (let i = 0; i < 4; i++) await paint('SNOW', [30.5, 2.5, 60.5], 3.5);
    const froze = await until(() => window.__app.pov.player.status.has('FROZEN'), null, 6000);
    check('gpu: buried in snow, Frozen', froze, `${JSON.stringify(await st())} moveScale ${await ev(() => window.__app.pov.player.status.moveScale)}`);

    if (shotPath) {
      await ev(() => { const q = window.__app.pov.player; q.status.clearAll(); q.spawn(q.pos.clone().set(64, 0, 40)); });
      await settle(600);
      await ev(() => { const q = window.__app.pov.player; q.status.add('OILY', 30); q.status.add('BURNING', 30); });
      await p.keyboard.press('v');
      await settle(1200);
      await p.screenshot({ path: shotPath, type: 'jpeg', quality: 60, scale: 'css' });
      await p.keyboard.press('v');
    }

    // ---- the lab's NPC: the same body, so the same stains
    await dropIn(`http://localhost:${port}/?preset=lab`);
    const npcUp = await until(() => window.__app.pov.npc?.body?.status && window.__app.pov.npc.body.pos.y >= 0, null, 30000);
    check('gpu: the lab NPC has a status set', npcUp);
    if (npcUp) {
      await settle(1500);
      const at = await ev(() => { const q = window.__app.pov.npc.body.pos; return [q.x, q.y, q.z]; });
      for (let i = 0; i < 3; i++) await paint('WATER', [at[0], at[1] + 2, at[2]], 3);
      const wet = await until(() => window.__app.pov.npc.body.status.has('WET'), null, 4000);
      check('gpu: an NPC body gets Wet from water', wet, JSON.stringify(await ev(() => window.__app.pov.npc.body.status.list().map((s) => s.key))));
    }
  } finally {
    if (errs.length) { console.log('page errors:'); errs.slice(0, 8).forEach((e) => console.log('  ' + e)); }
    check('gpu: no page errors', !errs.length);
    await browser.close();
  }
}

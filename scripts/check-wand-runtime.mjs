import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import * as THREE from 'three';
import { E, K } from '../src/elements.js';
import { addTarget } from '../src/pov/targets.js';

// Inject factory dependencies even when the GPU/compiler lanes have not landed.
// Production imports remain unchanged; real compiler recipes run below if present.
const runtimeURL = new URL('../src/pov/wands/runtime.js', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === runtimeURL && ['./compiler.js', './world.js'].includes(specifier)) {
      const name = specifier === './compiler.js' ? 'compileWand' : 'createWandWorld';
      return { url: `data:text/javascript,export function ${name}(){throw Error('Test dependency not injected')}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { createWandRuntime, WAND_LIMITS } = await import(runtimeURL);
hooks.deregister();
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const leaf = (effect, params = {}, op = 'self') => ({ op, id: effect, effect,
  params: { mana: 1, radius: 1, power: 10, lifetime: 0.3, speed: 30, ...params } });
const cfg = { manaMax: 100, manaRegen: 0, castDelay: 0.02, recharge: 0.1 };
function fakeCompile(cards, config) {
  return { casts: cards, errors: [], config: { ...cfg, ...config },
    stats: { castDelays: cards.map(() => config.castDelay ?? cfg.castDelay), recharge: config.recharge ?? cfg.recharge } };
}
function harness(options = {}) {
  let sim = { g: { nx: 128, ny: 128, nz: 128 }, origin: v() };
  const calls = [], batches = [], rays = [], transferCalls = [], lights = [];
  const visual = { items: [], active: false, stats: {}, pulse() {}, clear() {}, dispose() {}, windowShifted() {},
    update(items) { this.items = items; } };
  let queued = [], traceFn = options.trace ?? ((segments) => Promise.resolve(segments.map(() => null)));
  const world = { stats: {}, begin() {}, queue(c) { queued.push(c); return true; },
    flush() { batches.push(queued); calls.push(...queued); queued = []; },
    trace(segments) { rays.push(segments); return traceFn(segments); },
    clearance: options.clearance ?? (() => Promise.resolve(true)),
    setLights(value) { lights.push(value); }, windowShifted() {}, dispose() {} };
  let pool = options.pool ?? [];
  const transfer = options.transfer ?? {
    busy: false,
    take(load, spec) {
      transferCalls.push({ take: true, spec });
      const got = pool.splice(0, Math.min(pool.length, spec.limit, load.free));
      load.cells.push(...got); return Promise.resolve(got);
    },
    put(load, spec) {
      transferCalls.push({ take: false, spec });
      const picked = load.cells.filter((cell) => spec.id === -1 || cell[0] === spec.id).slice(0, spec.max);
      for (const cell of picked) load.cells.splice(load.cells.indexOf(cell), 1);
      pool.push(...picked); return Promise.resolve(picked.length);
    },
  };
  const renderer = options.renderer ?? {};
  const env = { renderer, world, visuals: visual, transfer, compileWand: options.compile ?? fakeCompile,
    getSim: () => sim, getScale: () => 1 };
  const runtime = createWandRuntime(env);
  const impulses = [], teleports = [];
  const ctx = { sim, dt: 0.05, stepsPerFrame: 1, primary: false, eye: v(20, 20, 20), dir: v(1),
    player: { pos: v(20, 16, 20), applyImpulse: (dv) => impulses.push(dv), teleport: (feet) => teleports.push(feet) } };
  const equip = (nodes, config = {}, more = {}) => runtime.equip({ id: 'test', cards: nodes, config, ...more });
  async function step({ fire = false, paused = false, dt = 0.05, tick = false } = {}) {
    ctx.primary = fire; ctx.dt = dt; ctx.stepsPerFrame = paused ? 0 : 1;
    if (tick) runtime.tick(ctx); else runtime.update(ctx);
    const s = runtime.stats;
    assert(s.frameCommands <= WAND_LIMITS.commands);
    assert(s.frameTransfers <= WAND_LIMITS.transfers);
    assert(s.frameNodes <= WAND_LIMITS.nodes);
    assert(s.frameCasts <= WAND_LIMITS.casts);
    assert(s.frameRays <= WAND_LIMITS.rays);
    assert(s.projectiles <= WAND_LIMITS.projectiles);
    assert(s.events <= WAND_LIMITS.events);
    assert(s.fields <= WAND_LIMITS.fields);
    assert(rays.every((batch) => batch.length <= 128));
    assert(lights.every((batch) => batch.length <= 8));
    await turn();
  }
  return { runtime, ctx, equip, step, calls, batches, rays, transferCalls, lights, impulses, teleports, visual, pool,
    setTrace(fn) { traceFn = fn; }, replace() { sim = { ...sim, origin: v() }; ctx.sim = sim; } };
}

// Root mana is prepaid once, deck delays/recharge are respected, and pause is inert.
{
  const h = harness();
  h.equip([{ op: 'multi', params: { mana: 25 }, children: [leaf('heat', { mana: 10 }), leaf('cool', { mana: 15 })] },
    leaf('pressure', { mana: 20 })], { manaMax: 30 });
  await h.step({ fire: true, dt: 0.01 });
  assert.equal(h.runtime.stats.mana, 5);
  assert.equal(h.runtime.stats.castIndex, 1);
  assert.equal(h.calls.length, 2);
  const before = h.runtime.stats.time;
  await h.step({ fire: true, paused: true });
  assert.equal(h.runtime.stats.time, before);
  await h.step({ fire: true });
  assert.equal(h.runtime.stats.casts, 1);
  assert(h.runtime.stats.mana >= 0);
  h.runtime.dispose();
}
{
  const h = harness();
  h.equip([leaf('heat'), leaf('cool')], { recharge: 0.5 });
  await h.step({ fire: true, dt: 0.01 });
  h.runtime.deselect();
  h.equip([leaf('heat'), leaf('cool')], { recharge: 0.5 });
  assert.equal(h.runtime.stats.castIndex, 1, 're-equip preserves deck position');
  await h.step({ fire: true, dt: 0.02 });
  assert.equal(h.runtime.stats.castIndex, 0);
  assert(h.runtime.stats.cooldown > 0.4);
  h.runtime.dispose();
}

// Async timer payload survives edits/deselect, freezes while paused, and fires once.
{
  const h = harness();
  const carrier = leaf('spark', { lifetime: 0.3, delay: 0.1, mana: 21 }, 'projectile');
  carrier.payload = leaf('pressure', { mana: 20 }); carrier.trigger = 'timer';
  h.equip([carrier]);
  await h.step({ fire: true });
  h.runtime.setDefinition({ id: 'other', cards: [leaf('erase')], config: {} });
  h.runtime.deselect();
  await h.step({ paused: true, tick: true });
  assert.equal(h.calls.length, 0);
  for (let i = 0; i < 9; i++) await h.step({ tick: true });
  assert.equal(h.calls.filter((c) => c.effect === 'pressure').length, 1);
  assert.equal(h.calls.filter((c) => c.effect === 'erase').length, 0);
  h.runtime.dispose();
}

// Errors are not clear space: no advance, damage or payload on a rejected trace.
{
  const h = harness({ trace: () => Promise.reject(new Error('busy')) });
  const carrier = leaf('spark', { lifetime: 0.1, delay: 0.02 }, 'projectile');
  carrier.payload = leaf('pressure'); carrier.trigger = 'timer';
  h.equip([carrier]); await h.step({ fire: true });
  for (let i = 0; i < 8; i++) await h.step();
  assert.equal(h.calls.length, 0); assert.equal(h.runtime.stats.projectiles, 1);
  assert(h.runtime.stats.traceErrors > 0);
  assert.equal(h.visual.items[0].position.x, 20);
  h.runtime.dispose();
}

// Window shifts remap delayed hit positions exactly once; stale generations vanish.
{
  let resolve;
  const h = harness({ trace: () => new Promise((r) => { resolve = r; }) });
  h.equip([leaf('heat', {}, 'projectile')]); await h.step({ fire: true });
  h.runtime.windowShifted(10, 0);
  resolve([{ point: v(12, 20, 20), normal: v(-1), id: E.ROCK, fraction: 0.5 }]); await turn();
  await h.step();
  assert.equal(h.calls.at(-1).center.x, 12);
  h.equip([leaf('heat', {}, 'projectile')]); await h.step({ fire: true });
  h.runtime.resetWorld();
  resolve([{ point: v(1), normal: v(-1), id: E.ROCK, fraction: 0.5 }]); await turn();
  const count = h.calls.length; await h.step(); assert.equal(h.calls.length, count);
  h.runtime.dispose();
}

// Actor hits are clipped by terrain, exclude captured owner, and area blasts hit boxes.
{
  let damage = 0;
  const remove = addTarget({ id: 'victim', alive: true,
    box(lo, hi) { lo.set(21, 19, 19); hi.set(22, 22, 21); }, hurt(n) { damage += n; } });
  const h = harness({ trace: () => Promise.resolve([{ point: v(24, 20, 20), normal: v(-1), id: E.ROCK }]) });
  h.equip([leaf('spark', { damage: 50, speed: 100 }, 'projectile')]);
  await h.step({ fire: true }); await h.step();
  assert.equal(damage, 0.5);
  assert.equal(h.calls.at(-1).center.x, 21);
  h.runtime.dispose(); remove();
}

// Bounce, pierce, trail and expiry branches stay on the shared collision scheduler.
{
  let n = 0;
  const h = harness({ trace: (segments) => Promise.resolve(segments.map((s) => n++ === 0
    ? { point: s.to.clone(), normal: v(-1), id: E.ROCK } : null)) });
  const shot = leaf('heat', { bounces: 1, lifetime: 0.15, trail: 'FIRE' }, 'projectile');
  shot.trigger = 'expiry'; shot.payload = leaf('pressure');
  h.equip([shot]); await h.step({ fire: true });
  for (let i = 0; i < 6; i++) await h.step();
  assert(h.rays[1][0].to.x < h.rays[0][0].to.x, 'bounce reflects velocity');
  assert(h.calls.some((c) => c.material === 'FIRE'));
  assert.equal(h.calls.filter((c) => c.effect === 'pressure').length, 1);
  h.runtime.dispose();
}
{
  const h = harness({ trace: (segments) => Promise.resolve(segments.map((s) => ({ point: s.to.clone(), normal: v(-1), id: E.ROCK }))) });
  const shot = leaf('heat', { pierce: 1 }, 'projectile');
  shot.trigger = 'impact'; shot.payload = leaf('pressure', {}, 'touch');
  h.equip([shot]); await h.step({ fire: true });
  for (let i = 0; i < 5; i++) await h.step();
  assert.equal(h.calls.filter((c) => c.effect === 'heat').length, 2);
  const blast = h.calls.find((c) => c.effect === 'pressure');
  assert(blast.center.distanceTo(h.calls[0].center) < 0.001, 'payload touch uses impact origin');
  assert.equal(h.calls.filter((c) => c.effect === 'pressure').length, 1);
  h.runtime.dispose();
}

// Exact stored cargo is finite, is returned on cancel, and does not reseed on equip.
{
  const renderer = {};
  const h = harness({ renderer });
  const def = { sandboxReservoir: { material: 'SCRAP', count: 4, label: '4 scrap cells' } };
  const round = leaf('emit', { stored: true, material: 'SCRAP', radius: 0.3 }, 'projectile');
  h.equip([round], {}, def); await h.step({ fire: true });
  assert.equal(h.runtime.stats.inventory, 4, 'flight cargo counted in inventory');
  h.equip([round], {}, def); assert.equal(h.runtime.stats.inventory, 4);
  h.runtime.dispose();
  const h2 = harness({ renderer }); h2.equip([round], {}, def);
  assert.equal(h2.runtime.stats.inventory, 4, 'cancel refunds cargo');
  await h2.step({ dt: 0.1 }); await h2.step({ fire: true });
  for (let i = 0; i < 9; i++) await h2.step();
  assert.equal(h2.pool.length, 1); assert.equal(h2.runtime.stats.inventory, 3);
  assert.equal(h2.calls.filter((c) => c.material === 'SCRAP').length, 0, 'stored matter never synthesized');
  h2.equip([round], {}, def); assert.equal(h2.runtime.stats.inventory, 3);
  h2.runtime.resetWorld(); assert.equal(h2.runtime.stats.inventory, 4, 'explicit reset starts a new sandbox generation');
  h2.runtime.dispose();
}

// Late absorb results target their original load, never an edited or reset load.
{
  let finish;
  const transfer = { busy: false, take(load) {
    load.reserved++;
    return new Promise((resolve) => { finish = () => {
      load.reserved--; load.cells.push([E.WATER, 20, 0, 0]); resolve(load.cells);
    }; });
  }, put() { return null; } };
  const h = harness({ transfer }); h.equip([leaf('absorb')]); await h.step({ fire: true });
  h.runtime.resetWorld(); finish(); await turn();
  assert.equal(h.runtime.stats.inventory, 0); h.runtime.dispose();
}

// Stored water spray uses exact transfer too, never the creation shader.
{
  const h = harness();
  h.equip([leaf('emit', { stored: true, material: 'WATER' }, 'touch')], {},
    { sandboxReservoir: { material: 'WATER', count: 12, label: '12 water cells' } });
  await h.step({ fire: true }); await h.step();
  assert.equal(h.runtime.stats.inventory, 0); assert.equal(h.pool.length, 12);
  assert.deepEqual(h.pool[0], [E.WATER, 20, 0, 0]);
  assert.equal(h.calls.length, 0); h.runtime.dispose();
}

// Bounded overload, burst timing, field lights and transfer budget.
{
  const h = harness();
  const children = Array.from({ length: 800 }, () => leaf('emit', { stored: true, material: 'WATER' }));
  h.equip([{ op: 'multi', params: { mana: 1 }, children }], {},
    { sandboxReservoir: { material: 'WATER', count: 500, label: 'water' } });
  await h.step({ fire: true }); assert(h.runtime.stats.dropped > 0);
  assert(h.runtime.stats.queuedTransfers <= WAND_LIMITS.transferQueue);
  for (let i = 0; i < 12; i++) await h.step();
  assert(h.transferCalls.length <= 26); h.runtime.dispose();
}
{
  const h = harness();
  h.equip([{ op: 'burst', params: { mana: 2, interval: 0.2 }, children: [leaf('pressure'), leaf('pressure')] }]);
  await h.step({ fire: true }); assert.equal(h.calls.length, 1);
  await h.step({ paused: true }); assert.equal(h.calls.length, 1);
  for (let i = 0; i < 5; i++) await h.step();
  assert.equal(h.calls.length, 2); h.runtime.dispose();
}
{
  const h = harness();
  h.equip([{ op: 'multi', params: { mana: 1 }, children: Array.from({ length: 100 }, () => leaf('light', { lifetime: 2 }, 'field')) }]);
  await h.step({ fire: true }); assert.equal(h.runtime.stats.fields, WAND_LIMITS.fields);
  assert.equal(h.lights.at(-1).length, 8); h.runtime.dispose();
}

// Every leaf op/effect executes: mining collection, beam samples, recoil and teleport.
{
  const h = harness({ pool: [[E.STONE, 20, 0, 0]] });
  h.equip([leaf('dig', { collect: true, recoil: 10 })]); await h.step({ fire: true });
  assert.equal(h.runtime.stats.inventory, 1);
  assert.deepEqual(h.transferCalls[0].spec.kinds, [K.POWDER]);
  assert.equal(h.impulses[0].x, -10);
  for (const effect of ['heat', 'cool', 'pressure', 'erase', 'ignite', 'place', 'attract', 'repel', 'emit']) {
    h.equip([leaf(effect)], {}, { id: effect }); await h.step({ fire: true });
    assert(h.calls.some((c) => c.effect === effect));
  }
  h.equip([leaf('dig', { lifetime: 1, speed: 80 }, 'beam')], {}, { id: 'beam' });
  await h.step({ fire: true }); await h.step();
  assert(h.calls.filter((c) => c.effect === 'dig').length > 2);
  h.equip([leaf('teleport', {}, 'touch')], {}, { id: 'teleport' });
  await h.step({ fire: true }); await h.step(); await h.step({ paused: true });
  assert.equal(h.teleports.length, 0);
  await h.step(); assert.equal(h.teleports.length, 1);
  h.runtime.dispose();
}
{
  const h = harness({ clearance: () => Promise.resolve(false) });
  h.equip([leaf('teleport', {}, 'touch')]);
  await h.step({ fire: true }); for (let i = 0; i < 3; i++) await h.step();
  assert.equal(h.teleports.length, 0); h.runtime.dispose();
}

let recipes = 0;
if (existsSync(new URL('../src/pov/wands/compiler.js', import.meta.url))) {
  const { compileWand } = await import('../src/pov/wands/compiler.js');
  const { PRESETS } = await import('../src/pov/wands/catalog.js');
  const evidence = new Map();
  for (const preset of PRESETS) {
    const observed = { calls: [], puts: [], takes: [], impulses: [], lights: [], teleports: [] };
    for (const impact of [false, true]) {
      let batch = 0;
      const h = harness({ compile: compileWand, pool: [[E.WATER, 20, 0, 0]], trace: (segments) => {
        const hit = impact && batch++ === 0;
        return Promise.resolve(segments.map((segment) => hit ? {
          point: segment.from.clone().lerp(segment.to, 0.8), normal: v(-1), id: E.ROCK, fraction: 0.8,
        } : null));
      } });
      const result = h.runtime.equip(preset);
      assert.deepEqual(result.errors, [], preset.id);
      for (let i = 0; i < 140; i++) await h.step({ fire: i < 20 });
      assert(h.runtime.stats.casts > 0, `${preset.id} never cast`);
      assert.equal(h.runtime.stats.transferErrors, 0, preset.id);
      observed.calls.push(...h.calls); observed.puts.push(...h.transferCalls.filter((c) => !c.take));
      observed.takes.push(...h.transferCalls.filter((c) => c.take));
      observed.impulses.push(...h.impulses); observed.lights.push(...h.lights.flat()); observed.teleports.push(...h.teleports);
      h.runtime.dispose();
    }
    evidence.set(preset.id, observed); recipes++;
  }
  const effects = (id, effect) => evidence.get(id).calls.filter((c) => c.effect === effect);
  assert(effects('mining-vacuum', 'dig').length && evidence.get('mining-vacuum').takes.some((c) => c.spec.kinds.includes(K.POWDER)));
  assert(effects('tunnel-cutter', 'dig').length);
  assert(effects('acid-shotgun', 'emit').some((c) => c.material === 'ACID'));
  assert(effects('spark-machinegun', 'heat').length);
  assert(evidence.get('stored-scrap-machinegun').puts.length);
  assert(evidence.get('recoil-flying').impulses.length);
  assert(effects('water-extinguisher', 'emit').some((c) => c.material === 'WATER') && effects('water-extinguisher', 'cool').length);
  assert(evidence.get('liquid-sponge').takes.some((c) => c.spec.kinds.includes(K.LIQUID)));
  assert(evidence.get('stored-lava-mortar').puts.length);
  assert(effects('remote-black-hole', 'erase').length || effects('remote-black-hole', 'attract').length);
  assert(effects('double-explosion', 'pressure').length >= 2);
  assert(effects('delayed-second-explosion', 'pressure').length >= 2);
  assert(effects('ice-bridge', 'cool').length && effects('ice-bridge', 'place').length);
  assert(evidence.get('cave-lantern').lights.length);
  assert(effects('powder-and-ignition', 'place').some((c) => c.material === 'GUNPOWDER') && effects('powder-and-ignition', 'ignite').length);
  assert(evidence.get('teleport').teleports.length);

}
console.log(`wand runtime checks passed: scheduling, prepaid mana, pause, async triggers, collision, shifts, inventory, effects; ${recipes} catalog recipes`);

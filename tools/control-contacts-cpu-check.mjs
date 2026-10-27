// Run with --experimental-vm-modules. Real integration modules and unchanged
// flask/frag/dig consumers; doubles replace only GPU, renderer and host clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SourceTextModule, SyntheticModule } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const actual = p => import(pathToFileURL(path.join(root, p)).href);
const THREE = await actual('node_modules/three/build/three.module.js');
const elements = await actual('src/elements.js');
const transferHelpers = await actual('src/pov/tools/transfer.js');
const { E } = elements;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
let owner = 0;

async function fixture({ foreign = true, activationWait = null } = {}) {
  const edits = [], takes = [], puts = [], activations = [], rejections = [];
  const transfer = {
    take(load, spec) { takes.push(spec); const got = [[E.SAND, 295, 0, 0]]; load.cells.push(...got); return Promise.resolve(got); },
    put(load, spec) { puts.push({ ...spec, matter: load.cells.map(c => [...c]) }); const n = load.cells.length; load.cells.length = 0; return Promise.resolve(n); },
  };
  const sim = { id: ++owner, g: { nx: 64, ny: 64, nz: 64 }, origin: V(), gravity: .025,
    touch: (lo, hi) => ({ lo, hi }), touchCentres: (lo, hi) => ({ lo, hi }) };
  const pending = defer(), world = { scene: {}, historyIdentity: {}, epoch: 0, pending: foreign ? pending.promise : null };
  const body = { pos: V(5, 5, 5), vel: V(), stepRate: 240, eyeHeight: 5, onGround: false, applyImpulse() {} };
  const gpu = { ready: true, probeReady: () => false, edit: (name, region, params) => edits.push({ name, region, params }) };
  const toolPass = () => Object.assign(() => true, { dispose() {} });
  const rig = () => ({ hand() { const g = new THREE.Group(); g.userData = {}; return g; }, releaseHand() {}, hit() {}, update() {} });
  const attachModel = (parent, name, ready) => { const obj = new THREE.Group(); parent.add(obj); ready?.(obj); return { obj, dispose() { obj.removeFromParent(); } }; };
  const namespaces = new Map([
    ['three', THREE], ['src/elements.js', elements],
    ['src/pov/tools/transfer.js', { ...transferHelpers, sharedTransfer: () => transfer }],
    ['src/pov/gpu.js', { povGpu: () => gpu, toolPass }],
    ['src/v2/host.js', { HOST_HZ: 60, projectileSeconds: (_sim, dt) => dt }],
    ['src/pov/vitals.js', { CELL_METERS: .3 }],
    ['src/pov/targets.js', { segmentTarget: () => null, rayTarget: () => null, areaTargets: () => [], dealtScale: () => 1, PLAYER: 'player' }],
    ['src/pov/gravityField.js', { radialGravity: () => false, pullAt: () => [0, 0, 0], upAt: () => null }],
    ['src/pov/viewmodel.js', { viewmodelRig: rig, heldMaterial: color => new THREE.MeshBasicMaterial({ color }), HIT: { THROW: {}, DRINK: {} } }],
    ['src/pov/models.js', { attachModel, FLASK_BULB: { r: 1, sides: 4, rings: 4 } }],
    ['src/pov/strikePose.js', { strikePose() {}, sampleKickPose() {} }],
    ['src/pov/tools/knife.tool.js', { behind: () => false }],
    ['src/pov/halo.js', { haloMatch: () => false, points: n => n, wu: n => n, CAUSE: {} }],
    ['src/v2/interactions.js', { flushNativeLaunch() {} }],
    ['src/gfx/uniforms.js', { gfxUniforms: { uDigMin: { value: [] }, uDigMax: { value: [] } } }],
    ['src/pov/player.js', { PX: .5 }], ['src/pov/ingest.js', { ingest() {} }],
    ['src/pov/tools/bomb.tool.js', { THROW_SPEED: 20 }],
    ['src/pov/tools/inventory.js', { inventory: { on: () => () => {} } }],
    ['src/pov/tools/catalog.js', { gear: key => ({ key }) }],
  ]);
  for (const p of ['src/shaders/povTrace.js', 'src/shaders/povKick.js', 'src/shaders/povBody.js',
    'src/shaders/povTools.js', 'src/shaders/common.js', 'src/physics.js', 'src/scale.js',
    'src/pov/constants.js', 'src/pov/tug.js']) namespaces.set(p, await actual(p));
  const sourcePaths = ['src/pov/ballistics.js', 'src/pov/kick.js', 'src/pov/tools/melee.js', 'src/pov/electronicsInteractions.js',
    'src/pov/tools/action.js', 'src/pov/tools/dig.js', 'src/pov/tools/held.js', 'src/pov/tools/flask.tool.js',
    'src/pov/frag.js', 'src/pov/grid.js', 'src/pov/space.js', 'src/pov/events.js'];
  const modules = new Map();
  for (const [p, ns] of namespaces) modules.set(p, new SyntheticModule(Object.keys(ns), function () {
    for (const [k, v] of Object.entries(ns)) this.setExport(k, v);
  }, { identifier: p }));
  for (const p of sourcePaths) modules.set(p, new SourceTextModule(readFileSync(path.join(root, p), 'utf8'), { identifier: p }));
  const entry = new SourceTextModule(sourcePaths.map((p, i) => `import * as m${i} from '${p}'; export {m${i}};`).join('\n'), { identifier: 'entry' });
  await entry.link((specifier, from) => {
    const id = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(from.identifier), specifier)) : specifier;
    if (!modules.has(id)) throw new Error(`Unexpected dependency ${id} from ${from.identifier}`);
    return modules.get(id);
  });
  await entry.evaluate();
  const get = p => modules.get(p).namespace;
  const service = get('src/pov/electronicsInteractions.js').createElectronicsInteractions({
    getSim: () => sim, getWorld: () => world, getSceneKey: () => 'scene', canMutate: () => true,
    pickRay: () => null, rejectContact: r => rejections.push(r),
    parts: {
      async activate(spec) { activations.push(spec); if (activationWait) await activationWait.promise; return { ok: true }; },
      reset() {}, dispose() {},
    },
  });
  const flight = get('src/pov/ballistics.js').createBallistics(); flight.prepare(sim);
  const env = { owner: `cpu-${owner}`, scene: new THREE.Scene(), getSim: () => sim, getScale: () => 1,
    getVolume: () => ({ position: V() }), transfer, ballistics: flight };
  const ctx = { sim, eye: V(8, 10, 8), dir: V(1, 0, 0), player: body, dt: .02, primary: false };
  function hit(r, id = E.SAND) {
    r.hit = { t: .01, id, cell: V(9, 10, 8), prev: V(8, 10, 8), point: V(9, 10.5, 8.5), face: 1 }; r.tClear = 1;
  }
  const step = () => flight.update({ sim, dt: .02, stepsPerFrame: 1 });
  const release = async () => {
    if (world.pending === pending.promise) world.pending = null;
    pending.resolve(); await service.settle(); await tick();
  };
  return { get, sim, body, env, ctx, service, flight, world, edits, takes, puts, activations, hit, step, release,
    events: get('src/pov/events.js').povEvents };
}

test('queued dig rebases the actual extraction minimum as well as its aim', async () => {
  const f = await fixture();
  const spec = { key: 'PICKAXE', name: 'Pickaxe', model: 'pickaxe', desc: '',
    blow: { ENERGY: 100, RADIUS: 1, DEPTH: 1 }, frag: '', hit: {}, refire: .1, body: {},
    pose: { pos: [0, 0, 0], rest: 0, hit: 1, miss: 1, roll: 0, strike: .05 },
    dig: { power: 100, limit: 100, tools: ['shovel', 'pickaxe'] } };
  const tool = f.get('src/pov/tools/melee.js').meleeTool(spec).create(f.env);
  const ctx = { ...f.ctx, aim: { valid: true, cell: V(8, 8, 8), id: E.SAND, dist: 1, face: 1 }, primary: true, primaryPressed: true };
  tool.update(ctx); assert.equal(f.takes.length, 0);
  ctx.aim.cell.x = 40; ctx.eye.x = 40;
  f.sim.origin.x = 4; tool.windowShifted(4, 0); await f.release();
  assert.equal(f.takes.length, 1);
  assert.equal(Math.min(...f.takes[0].cells.map(c => c[0])), 4); assert.equal(tool.lastHit.cell.x, 4);
  tool.dispose(); f.flight.dispose(); f.service.dispose();
});

test('queued carry freezes hip/heading across another kick and a window shift', async () => {
  const f = await fixture();
  const kick = f.get('src/pov/kick.js').createKick({ body: f.body, owner: f.env.owner, getSim: () => f.sim,
    cellAt: (x, y, z) => (x === 6 && z === 5) || (x === 5 && z === 6) ? E.SAND : E.AIR, unknown: -999 });
  const launches = [];
  kick.ballistics = { fire: (origin, dir) => { launches.push({ origin: origin.clone(), dir: dir.clone() }); return 12; } };
  kick.kick(V(1, 0, 0)); kick.update(.6); kick.kick(V(0, 0, 1));
  f.sim.origin.x = 4; await f.release(); kick.update(.01);
  assert.equal(f.takes.length, 1); assert.equal(launches.length, 1);
  assert(Math.abs(launches[0].origin.x - 1.95) < 1e-9);
  assert.equal(launches[0].origin.z, 5); assert(launches[0].dir.x > 0); assert.equal(launches[0].dir.z, 0);
  kick.dispose(); f.flight.dispose(); f.service.dispose();
});

test('queued bullet stays alive, then records its rebased destructive pass once', async () => {
  const f = await fixture(), order = [];
  f.events.on('round:end', () => order.push('end')); f.events.on('impact', () => order.push('impact'));
  f.flight.fire(V(8, 10, 8), V(1, 0, 0), 0); const r = f.flight.rounds[0]; f.hit(r);
  f.step(); f.step(); assert.equal(f.flight.count, 1); assert.equal(r.t, .02); assert.deepEqual(order, []);
  f.sim.origin.x = 4; f.flight.windowShifted(4, 0); await f.release();
  assert.deepEqual(order, ['impact', 'end']); assert.equal(f.flight.count, 0);
  assert.equal(f.edits.length, 1); assert.equal(f.edits[0].name, 'povStrike');
  assert.equal(f.edits[0].params.entry.x, 5); assert.equal(r.p0.x, 4);
  f.flight.dispose(); f.service.dispose();
});

test('contact activates before onStrike and preserves actor plus all rebased hit coordinates', async () => {
  const f = await fixture(); let seen;
  const actor = { id: 'cpu-shooter' };
  f.events.as(actor, () => f.flight.fire(V(8, 10, 8), V(1, 0, 0), 0, {
    onStrike: s => { seen = s; assert.equal(f.events.actor, actor); assert.equal(f.activations.length, 1); },
  }));
  f.hit(f.flight.rounds[0], E.BUTTON); f.step();
  f.sim.origin.x = 4; f.flight.windowShifted(4, 0); await f.release();
  assert.deepEqual([seen.hit.cell.x, seen.hit.prev.x, seen.hit.point.x], [5, 4, 5]);
  assert.equal(f.activations[0].x, 5); assert.equal(f.activations[0].material, E.BUTTON);
  assert.equal(f.flight.count, 0); f.flight.dispose(); f.service.dispose();
});

test('actual flask and launcher spill before round:end instead of losing contents', async () => {
  const f = await fixture(), flask = f.get('src/pov/tools/flask.tool.js').default.create(f.env);
  flask.holdCells([[E.WATER, 295, 0, 0], [E.SAND, 295, 0, 0]]);
  flask.update({ ...f.ctx, secondary: true, secondaryPressed: true }); assert.equal(flask.flying, 1);
  f.hit(f.flight.rounds[0], E.BUTTON); f.step();
  assert.equal(flask.flying, 1); assert.equal(flask.lost, 0); assert.equal(flask.lastShatter, null);
  f.sim.origin.x = 4; f.flight.windowShifted(4, 0); await f.release();
  assert.equal(flask.flying, 0); assert.equal(flask.lost, 0);
  assert.equal(flask.lastShatter.held, 2); assert.equal(flask.lastShatter.point.x, 5);
  assert(f.puts[0].matter.some(c => c[0] === E.WATER)); assert(f.puts[0].matter.some(c => c[0] === E.SAND));
  assert.equal(f.puts[0].matter.filter(c => c[0] === E.SHARDS).length, flask.lastShatter.glass);
  flask.dispose(); f.flight.dispose(); f.service.dispose();
});

test('actual frag bounces and relaunches before its old round ends', async () => {
  const f = await fixture(), frags = f.get('src/pov/frag.js').createFrags({ ...f.env, ballistics: () => f.flight });
  assert.equal(frags.throw(f.body, f.ctx.eye, f.ctx.dir), true);
  const first = f.flight.rounds[0].id, order = [];
  f.events.on('frag', e => { if (e.action === 'bounce') order.push('bounce'); });
  f.events.on('round:end', e => { if (e.id === first) order.push('end'); });
  f.hit(f.flight.rounds[0], E.BUTTON); f.step(); f.step();
  assert.equal(frags.list.length, 1); assert.equal(frags.list[0].bounces, 0);
  await f.release(); assert.deepEqual(order, ['bounce', 'end']);
  assert.equal(frags.list.length, 1); assert.equal(frags.list[0].bounces, 1); assert.equal(f.flight.count, 1);
  assert.notEqual(f.flight.rounds[0].id, first);
  frags.dispose(); f.flight.dispose(); f.service.dispose();
});

for (const terminal of ['dispose', 'clear', 'cancel', 'reset', 'service-dispose', 'nonresident']) {
  test(`parked projectile ${terminal}: exactly one end and no stale work`, async () => {
    const f = await fixture(); let strikes = 0, ends = 0;
    f.events.on('round:end', () => ends++);
    const id = f.flight.fire(V(8, 10, 8), V(1, 0, 0), 0, { onStrike: () => strikes++ });
    f.hit(f.flight.rounds[0], E.BUTTON); f.step();
    if (terminal === 'reset') f.service.reset();
    else if (terminal === 'service-dispose') f.service.dispose();
    else if (terminal === 'nonresident') { f.sim.origin.x = 32; f.flight.windowShifted(32, 0); }
    else if (terminal === 'cancel') f.flight.cancel(id);
    else f.flight[terminal]();
    if (terminal !== 'nonresident') assert.equal(ends, 1);
    await f.release();
    assert.equal(strikes, 0); assert.equal(f.activations.length, 0); assert.equal(ends, 1); assert.equal(f.flight.count, 0);
    f.flight.dispose(); f.service.dispose();
  });
}

test('disposed kick cannot extract queued grains or break a patch', async () => {
  const f = await fixture();
  const kick = f.get('src/pov/kick.js').createKick({ body: f.body, owner: f.env.owner, getSim: () => f.sim,
    cellAt: x => x === 6 ? E.SAND : E.AIR, unknown: -999 });
  kick.kick(V(1, 0, 0)); kick.dispose(); await f.release(); kick.update(1);
  assert.equal(f.takes.length, 0); assert.equal(f.edits.length, 0); assert.equal(kick.kick(V(1, 0, 0)), null);
  f.flight.dispose(); f.service.dispose();
});

test('disposed melee cancels activation and destructive digging', async () => {
  const f = await fixture();
  const tool = f.get('src/pov/tools/melee.js').meleeTool({ key: 'AXE', name: 'Axe', model: 'axe',
    blow: { ENERGY: 100, RADIUS: 1, DEPTH: 1 }, frag: '', hit: {}, refire: .1, body: {},
    pose: { pos: [0, 0, 0], rest: 0, hit: 1, miss: 1, roll: 0, strike: .05 } }).create(f.env);
  tool.update({ ...f.ctx, aim: { valid: true, cell: V(8, 8, 8), id: E.BUTTON, dist: 1, face: 1 }, primary: true, primaryPressed: true });
  tool.dispose(); await f.release(); assert.equal(f.activations.length, 0); assert.equal(f.takes.length, 0);
  f.flight.dispose(); f.service.dispose();
});

test('instance disposal invalidates the commit guard across activation awaits', async () => {
  const wait = defer(), f = await fixture({ foreign: false, activationWait: wait }); let strikes = 0;
  f.flight.fire(V(8, 10, 8), V(1, 0, 0), 0, { onStrike: () => strikes++ }); f.hit(f.flight.rounds[0], E.BUTTON); f.step();
  await tick(); assert.equal(f.activations.length, 1); assert.equal(f.service.canCommit, true);
  f.flight.dispose(); assert.equal(f.service.canCommit, false);
  wait.resolve(); await f.service.settle(); assert.equal(strikes, 0); f.service.dispose();
});

test('ordinary contacts remain immediate without a transaction', async () => {
  const f = await fixture({ foreign: false });
  f.flight.fire(V(8, 10, 8), V(1, 0, 0), 0); f.hit(f.flight.rounds[0]); f.step();
  assert.equal(f.edits.length, 1); assert.equal(f.flight.count, 0); assert.equal(f.service.pending, 0);
  f.flight.dispose(); f.service.dispose();
});

test('a button hit retains both activation and its destructive bullet strike', async () => {
  const f = await fixture();
  f.flight.fire(V(8, 10, 8), V(1, 0, 0), 0); f.hit(f.flight.rounds[0], E.BUTTON); f.step(); await f.release();
  assert.equal(f.activations.length, 1); assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].name, 'povStrike'); assert.equal(f.flight.count, 0);
  f.flight.dispose(); f.service.dispose();
});

for (const disposed of [false, true]) test(`queued kick patch: ${disposed ? 'disposed' : 'rebased'}`, async () => {
  const f = await fixture();
  const kick = f.get('src/pov/kick.js').createKick({ body: f.body, owner: f.env.owner, getSim: () => f.sim,
    cellAt: x => x === 6 ? E.GLASS : E.AIR, unknown: -999 });
  kick.kick(V(1, 0, 0)); f.sim.origin.x = 4; if (disposed) kick.dispose(); await f.release();
  assert.equal(f.edits.length, disposed ? 0 : 1);
  if (!disposed) { assert.equal(f.edits[0].name, 'povKick'); assert.equal(f.edits[0].params.center.x, 2.5); assert(f.edits[0].params.shove.x > 0); }
  kick.dispose(); f.flight.dispose(); f.service.dispose();
});

test('disposed kick cannot activate its queued button', async () => {
  const f = await fixture();
  const kick = f.get('src/pov/kick.js').createKick({ body: f.body, owner: f.env.owner, getSim: () => f.sim,
    cellAt: x => x === 6 ? E.BUTTON : E.AIR, unknown: -999 });
  kick.kick(V(1, 0, 0)); kick.dispose(); await f.release();
  assert.equal(f.activations.length, 0); assert.equal(f.edits.length, 0);
  f.flight.dispose(); f.service.dispose();
});

test('explicit flask cancellation accounts for loss once without a later spill', async () => {
  const f = await fixture(), flask = f.get('src/pov/tools/flask.tool.js').default.create(f.env);
  flask.holdCells([[E.WATER, 295, 0, 0]]); flask.update({ ...f.ctx, secondary: true, secondaryPressed: true });
  f.hit(f.flight.rounds[0], E.BUTTON); f.step(); f.flight.cancel(f.flight.rounds[0].id);
  assert.equal(flask.flying, 0); assert.equal(flask.lost, 1);
  await f.release(); assert.equal(flask.lastShatter, null); assert.equal(f.puts.length, 0); assert.equal(flask.lost, 1);
  flask.dispose(); f.flight.dispose(); f.service.dispose();
});

test('explicit frag cancellation cannot later bounce or activate', async () => {
  const f = await fixture(), frags = f.get('src/pov/frag.js').createFrags({ ...f.env, ballistics: () => f.flight });
  frags.throw(f.body, f.ctx.eye, f.ctx.dir); f.hit(f.flight.rounds[0], E.BUTTON); f.step();
  f.flight.clear(); assert.equal(frags.list.length, 0);
  await f.release(); assert.equal(frags.list.length, 0); assert.equal(f.activations.length, 0); assert.equal(f.flight.count, 0);
  frags.dispose(); f.flight.dispose(); f.service.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { E } from '../../src/elements.js';
import { state, install, tick, loadControlWires } from '../helpers/controlNetwork.js';

const { electronics, mp: mpWire } = await loadControlWires();
function firstHit(eye, dir, cells) {
  let best = Infinity, cell = null, id = -1;
  for (const block of cells) {
    let lo = 0, hi = Infinity;
    for (let i = 0; i < 3; i++) {
      const o = eye.getComponent(i), d = dir.getComponent(i), a = block.cell[i];
      if (Math.abs(d) < 1e-9) { if (o < a || o > a + 1) { hi = -1; break; } continue; }
      const t1 = (a - o) / d, t2 = (a + 1 - o) / d;
      lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
    }
    if (lo <= hi && lo < best) { best = lo; cell = new Vector3(...block.cell); id = block.id; }
  }
  return { valid: !!cell, cell, id };
}
function app(streamed = false) {
  const sim = { id: 1, g: { nx: 32, ny: 32, nz: 32 }, origin: new Vector3(64, 0, 96),
    bytes: new Uint8Array(8), cellTexel: () => 0 };
  const a = { sim, settings: { preset: 'box', scene: 'test' }, worldSeed: 1,
    mapKind: { streamed, guestPlaysOn: true },
    camera: { position: new Vector3(999, 100, 999), getWorldDirection: v => v.set(0, 0, -1) },
    pov: { active: false, exit() {}, worldReplaced() {}, windowShifted() {} },
    scoreboard: { mine: null }, mp: null, scale: 2, anchor: { x: 64, y: 96 },
    hover: { valid: true, id: E.BUTTON, cell: new Vector3(5, 5, 6) }, pointerInside: true, uiHover: false,
    isTyping: () => false, requestRender() {}, placeVolume() {}, homeOver() {}, rig: { reset() {} },
    post: { reset() {} }, hud: { toast() {} }, boxSeaFrom() {}, setGrid: () => true,
    actionRay: () => ({ origin: new Vector3(2, 5.5, 10), direction: new Vector3(1, 0, -1).normalize() }), picks: [] };
  a.cells = [{ id: E.BUTTON, cell: [5, 5, 6] }, { id: E.METAL, cell: [2, 5, 6] }];
  a.pickRay = async (...args) => { a.picks.push(args); return firstHit(args[0], args[1], a.cells); };
  if (streamed) a.win = { loaded: true, epoch: 1, historyIdentity: {}, size: [256, 32, 256],
    scene: { key: 'test', ground: () => 5 }, P: { seed: 1 }, whenReady: async () => {} };
  electronics.boot(a); a.key = state.keys.at(-1); return a;
}
const cursor = { visible: false }, update = a => a.mp.update(.05, cursor);
const intent = { cell: [69, 5, 102], material: E.BUTTON, source: 'god',
  actionRay: { eye: [66, 5.5, 106], dir: [Math.SQRT1_2, 0, -Math.SQRT1_2] } };
async function pair(streamed = false) {
  install(); state.now = 100; state.frames = 0; state.writes.length = 0; state.sockets.length = 0;
  state.keys.length = 0; state.buttons.length = 0; state.autoCommit = true; state.unpackJobs.length = 0;
  const host = app(streamed); mpWire.boot(host);
  await state.buttons[0].listeners.click(); const hs = state.sockets.at(-1); hs.id = 'h';
  hs.receive({ t: 'welcome', id: 'h', n: 0, role: 'host', peers: [{ id: 'g', n: 1, role: 'guest' }] });
  location.search = '?join=cpu';
  const guest = app(streamed); mpWire.boot(guest); const gs = state.sockets.at(-1); gs.id = 'g';
  gs.peer = hs; hs.peer = gs;
  gs.receive({ t: 'welcome', id: 'g', n: 1, role: 'guest', peers: [{ id: 'h', n: 0, role: 'host' }] });
  update(host); await tick(); update(guest); await tick(); state.now = 160; update(host); await tick();
  return { host, guest, hs, gs };
}
const latestContext = hs => JSON.parse(hs.messages.filter(x => typeof x === 'string' && JSON.parse(x).t === 'control-context').at(-1));

test('actual local and guest E retain the off-centre pointer ray; host rechecks occlusion', async () => {
  const { host, guest } = await pair();
  const local = app(); local.mp = { replica: false };
  local.key({ code: 'KeyE', preventDefault() {} }); await local.electronics.settle();
  assert.deepEqual(state.writes, [{ x: 5, y: 5, z: 6, material: E.BUTTON }]);
  let release;
  guest.pickRay = (...args) => new Promise(resolve => { release = () => resolve(firstHit(args[0], args[1], guest.cells)); });
  guest.key({ code: 'KeyE', preventDefault() {} }); await tick();
  guest.actionRay = () => ({ origin: new Vector3(25, 25, 25), direction: new Vector3(0, 0, -1) });
  guest.camera.position.set(-999, -999, -999); release();
  await guest.electronics.settle(); await tick(); await host.electronics.settle();
  assert.equal(state.writes.length, 2);
  assert.deepEqual(host.picks.at(-1).slice(2), [false, false]);
  assert.deepEqual(host.picks.at(-1)[0].toArray(), [2, 5.5, 10]);
  assert(host.picks.at(-1)[1].distanceTo(new Vector3(1, 0, -1).normalize()) < 1e-12);
  host.cells.push({ id: E.METAL, cell: [3, 5, 8] }); state.now += 200;
  assert.equal(guest.mp.requestControlUse(intent), true); await tick(); await host.electronics.settle();
  assert.equal(state.writes.length, 2, 'a new host-side blocker defeats the old guest pick');
});

test('suppressed legacy frames stay live only with a confirmed matching baseline', async () => {
  const { host, guest, hs, gs } = await pair(), initialFrames = state.frames;
  for (state.now = 300; state.now <= 3300; state.now += 100) { update(host); await tick(); update(guest); await tick(); }
  assert.equal(state.frames, initialFrames);
  assert.equal(guest.mp.requestControlUse(intent), true, 'quiet sessions remain usable beyond 2.5 seconds');
  await tick(); await host.electronics.settle(); assert.equal(state.writes.length, 1);
  const context = latestContext(hs), before = gs.messages.length;
  state.now += 2600; gs.receive({ ...context, from: 'h' });
  assert.equal(guest.mp.requestControlUse(intent), false);
  assert.equal(gs.messages.length, before, 'replayed heartbeat cannot renew freshness');
  update(host); await tick(); state.now += 60; update(host); await tick();
  assert.equal(guest.mp.requestControlUse(intent), true, 'a real unchanged capture renews confirmation');
});

test('unknown, unapplied and wrong-window baselines cannot borrow a heartbeat', async () => {
  const { host, guest, hs, gs } = await pair(), base = latestContext(hs);
  let seq = base.seq;
  for (const change of [
    b => ({ ...b, seq: b.seq + 10 }), b => ({ ...b, generation: 'old' }),
    b => ({ ...b, size: [64, 32, 32] }), b => ({ ...b, origin: [0, 0, 0] }),
  ]) {
    gs.receive({ ...base, seq: ++seq, baseline: change(base.baseline), from: 'h' });
    assert.equal(guest.mp.requestControlUse(intent), false);
  }
  gs.receive({ ...base, seq: ++seq, from: 'h' }); assert.equal(guest.mp.requestControlUse(intent), true); await tick();
  state.autoCommit = false; host.sim.bytes[0] = 1; state.now += 200;
  update(host); await tick(); update(guest); await tick();
  const frame = hs.messages.filter(x => typeof x !== 'string').at(-1);
  gs.receive({ ...base, seq: ++seq, baseline: { ...base.baseline, seq: frame.seq }, from: 'h' });
  assert.equal(guest.mp.requestControlUse(intent), false, 'receipt is not an applied GPU frame');
  state.unpackJobs.shift()(); await tick(); assert.equal(guest.mp.requestControlUse(intent), true);
  gs.onmessage({ data: hs.messages.filter(x => typeof x !== 'string')[0] });
  await tick(); update(guest); await tick();
  assert.equal(state.unpackJobs.length, 0); assert.equal(guest.sim.appliedBytes[0], 1);
  gs.receive({ ...base, seq: ++seq, from: 'h' }); assert.equal(guest.mp.requestControlUse(intent), false);
  state.now += 60; host.electronics.reset(); update(host); await tick();
  assert.equal(latestContext(hs).baseline, null);
});

test('capture stalls, replayed poses, window changes and host departure fail closed', async () => {
  const { host, guest, hs, gs } = await pair();
  host.sim.delayCapture = true; state.now += 200; update(host); await tick();
  state.now += 2600; update(host); await tick(); assert.equal(latestContext(hs).baseline, null);
  host.sim.releaseCapture(); await tick();
  assert.equal(guest.mp.requestControlUse(intent), false, 'late readback cannot renew dispatch time');
  host.sim.delayCapture = false; state.now += 200; update(host); await tick(); state.now += 60; update(host); await tick();
  assert.equal(guest.mp.requestControlUse(intent), true); await tick(); await host.electronics.settle();
  const sent = gs.messages.filter(x => typeof x === 'string').map(x => JSON.parse(x));
  const pose = sent.filter(x => x.t === 'control-pose').at(-1), use = sent.filter(x => x.t === 'control-use').at(-1);
  const count = state.writes.length;
  hs.receive({ ...pose, from: 'g' }); hs.receive({ ...use, seq: use.seq + 1, from: 'g' }); await tick();
  assert.equal(state.writes.length, count);
  state.now += 501; hs.receive({ ...use, seq: use.seq + 2, from: 'g' }); await tick(); assert.equal(state.writes.length, count);
  hs.receive({ ...pose, seq: pose.seq + 1, from: 'g' }); host.sim.origin.x += 32;
  hs.receive({ ...use, seq: use.seq + 3, poseSeq: pose.seq + 1, from: 'g' }); await tick();
  assert.equal(state.writes.length, count);
  gs.receive({ t: 'leave', id: 'h' }); assert.equal(guest.mp.requestControlUse(intent), false);
});

test('same-Sim reset requires a new sequenced key and its actual application', async () => {
  const { host, guest, hs } = await pair(), before = latestContext(hs);
  host.electronics.reset(); state.now += 60; update(host); await tick();
  const reset = latestContext(hs);
  assert.notEqual(reset.context.id, before.context.id); assert.equal(reset.baseline, null);
  assert.equal(guest.mp.requestControlUse(intent), false);
  state.now += 100; update(host); await tick();
  const frame = hs.messages.filter(x => typeof x !== 'string').at(-1);
  assert.equal(frame.kind, 0); assert(frame.seq > before.baseline.seq);
  state.now += 60; update(host); await tick();
  assert.equal(guest.mp.requestControlUse(intent), false);
  update(guest); await tick(); assert.equal(guest.mp.requestControlUse(intent), true);
  const current = latestContext(hs);
  assert.equal(current.baseline.generation, current.context.id); assert.equal(current.baseline.seq, frame.seq);
});

test('expired captures, false senders and identical replacement Sims are not freshness', async () => {
  const { guest, hs, gs } = await pair(), context = latestContext(hs);
  gs.receive({ ...context, seq: context.seq + 1, age: 2501, from: 'h' }); assert.equal(guest.mp.requestControlUse(intent), false);
  gs.receive({ ...context, seq: context.seq + 2, age: -1, from: 'h' }); assert.equal(guest.mp.requestControlUse(intent), false);
  gs.receive({ ...context, seq: context.seq + 3, age: 0, from: 'not-the-host' }); assert.equal(guest.mp.requestControlUse(intent), false);
  guest.sim = { ...guest.sim, origin: guest.sim.origin.clone() };
  gs.receive({ ...context, seq: context.seq + 4, age: 0, from: 'h' }); assert.equal(guest.mp.requestControlUse(intent), false);
});

test('streamed window moves require the matching frame committed at its new origin', async () => {
  const { host, guest, hs } = await pair(true), before = latestContext(hs);
  assert.equal(guest.mp.requestControlUse(intent), true); await tick();
  host.sim.origin.x += 32; state.now += 60; update(host); await tick();
  assert.notEqual(latestContext(hs).context.id, before.context.id); assert.equal(guest.mp.requestControlUse(intent), false);
  state.now += 100; update(host); await tick(); state.now += 60; update(host); await tick();
  assert.equal(guest.mp.requestControlUse(intent), false);
  update(guest); await tick(); assert.equal(guest.sim.origin.x, 96);
  const moved = { ...intent, cell: [101, 5, 102], actionRay: { ...intent.actionRay, eye: [98, 5.5, 106] } };
  assert.equal(guest.mp.requestControlUse(moved), true);
  const context = latestContext(hs);
  assert.deepEqual(context.baseline.origin, [96, 0, 96]);
  assert.equal(context.baseline.stamp, hs.messages.filter(x => typeof x !== 'string').at(-1).meta.id + ':96,0,96');
  await tick(); await host.electronics.settle();
});

for (const reset of [false, true]) test(`nonresident god admission ${reset ? 'cancels after same-scene reset' : 'recasts at the admitted world cell'}`, async () => {
  install(); state.now = 100; state.writes.length = 0;
  const a = app(true); a.mp = { replica: false };
  a.hover.cell.set(40, 5, 6);
  a.actionRay = () => ({
    origin: new Vector3(2, 5.5, 10), direction: new Vector3(38.5, 0, -3.5).normalize(),
  });
  const admitted = [];
  a.workAt = (x, z) => { admitted.push([x, z]); return true; };
  a.key({ code: 'KeyE', preventDefault() {} });
  assert.deepEqual(admitted, [[104, 102]]); assert.equal(state.writes.length, 0);
  if (reset) a.electronics.reset();
  a.sim.origin.x += 32; a.cells = [{ id: E.BUTTON, cell: [8, 5, 6] }];
  electronics.afterStep(a); await a.electronics.settle();
  assert.equal(state.writes.length, reset ? 0 : 1);
  if (!reset) assert.deepEqual(state.writes[0], { x: 8, y: 5, z: 6, material: E.BUTTON });
  a.electronics.dispose();
});

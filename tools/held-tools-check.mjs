// CPU-only lifecycle, timing and authoring regression. No renderer/browser.
// node tools/held-tools-check.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
// Firearm's stylesheet has no behavior in this DOM-free/NPC fixture.
registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { heldModel } = await import('../src/pov/tools/held.js');
const { default: jackhammer, REFIRE } = await import('../src/pov/tools/jackhammer.tool.js');
const { default: axe } = await import('../src/pov/tools/axe.tool.js');
const { default: sniper } = await import('../src/pov/tools/sniper.tool.js');
const { default: pistol } = await import('../src/pov/tools/gun.tool.js');
const { default: smg } = await import('../src/pov/tools/smg.tool.js');
const { povEvents } = await import('../src/pov/events.js');
const { muzzleCell } = await import('../src/pov/tools/transfer.js');
const { default: flamer } = await import('../src/pov/tools/blowtorch.tool.js');
const { GEAR, gearByKey } = await import('../src/pov/tools/catalog.js');
const { GEAR_ITEMS } = await import('../src/elements.js');
const { gesturePose } = await import('../src/pov/holds.js');
const { trigger } = await import('../src/pov/tools/action.js');
const { E } = await import('../src/elements.js');
const { EYE_HEIGHT, HAND_REACH } = await import('../src/pov/constants.js');
const env = () => ({ viewmodel: new THREE.Group(), getScale: () => 1, owner: 'held-tools-cpu',
  getVolume: () => new THREE.Object3D(), ballistics: { windowShifted() {} } });
const ctx = (extra = {}) => ({ dt: 1 / 60, eye: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1),
  player: { onGround: true }, aim: { valid: false }, primary: false, primaryPressed: false, ...extra });

const e = env(), held = heldModel(e, { model: 'jackhammer', pos: [0, 0, -1], pivot: true });
const bit = held.mesh.obj.getObjectByName('bit'), motor = held.mesh.obj.getObjectByName('motor');
assert.ok(bit.position.y < motor.position.y, 'bit points down below the motor');
assert.equal(bit.position.z, motor.position.z, 'bit is not a forward barrel');
let freed = 0, geometries = 0;
held.mesh.obj.traverse((o) => { if (o.geometry) { geometries++; o.geometry.addEventListener('dispose', () => freed++); } });
assert.equal(held.hand.visible, false);
held.update(ctx()); assert.equal(held.hand.visible, true);
held.update(ctx(), false); assert.equal(held.hand.visible, false, 'scoped visibility override');
held.deselect(); held.update(ctx()); assert.equal(held.hand.visible, true, 're-equip');
held.dispose(); held.dispose();
assert.equal(freed, geometries, 'each geometry disposed once');
assert.equal(held.hand.parent, null); assert.equal(held.rig.root.children.length, 0);
const rest = held.hand.position.clone(); held.rig.update(ctx({ dt: 0.3 }));
assert.deepEqual(held.hand.position.toArray(), rest.toArray(), 'disposed hand removed from rig update registry');
held.update(ctx()); assert.equal(held.hand.visible, false, 'disposed model cannot re-equip');
const a = heldModel(e, { model: 'axe', pos: [0, 0, -1] });
const b = heldModel(e, { model: 'pistol', pos: [0, 0, -1] });
assert.equal(a.rig, b.rig, 'tools share the environment rig');
a.dispose(); b.update(ctx());
assert.equal(b.hand.visible, true); assert.equal(b.rig.root.parent, e.viewmodel, 'disposing one tool does not own the rig');
b.dispose();

const ve = env(), vertical = jackhammer.create(ve);
try {
  vertical.update(ctx({ dt: 0, primary: true, primaryPressed: true }));
  vertical.update(ctx({ dt: 0.025 }));
  const pivot = ve.viewmodel.userData.rig.root.children[0].children[0];
  assert.deepEqual(pivot.position.toArray(), [0, -0.04, 0], 'peak piston stroke is down, not forward');
} finally { vertical.dispose(); }

for (const def of [axe, jackhammer, sniper, pistol, flamer]) {
  const e = env(), tool = def.create(e), rig = e.viewmodel.userData.rig;
  const hand = rig.root.children[0];
  assert.equal(hand.visible, false, `${def.key}: initially hidden`);
  tool.update(ctx()); assert.equal(hand.visible, true);
  tool.deselect(); assert.equal(hand.visible, false);
  tool.update(ctx()); assert.equal(hand.visible, true);
  if (def === sniper) {
    tool.update(ctx({ secondaryPressed: true }));
    assert.equal(tool.scoped, true); assert.equal(hand.visible, false);
    assert.ok(tool.zoom() > 1); assert.ok(tool.muzzle.isObject3D);
    assert.ok(tool.muzzleWorld().isVector3);
    tool.windowShifted(1, 2);
    tool.deselect(); assert.equal(tool.scoped, false); assert.equal(tool.zoom(), 1);
    tool.update(ctx()); assert.equal(hand.visible, true, 'unscoped on re-equip');
  }
  const body = { onGround: true };
  if (def === pistol) { tool.update(ctx({ dt: 0.2, secondary: true, player: body })); assert.ok(body.aimScale < 1); }
  tool.dispose(); tool.dispose();
  assert.equal(rig.root.children.length, 0, `${def.key}: cleanup removed hand`);
  if (def === pistol) assert.equal(body.aimScale, 1, 'teardown restores ADS movement');
}

// The real melee update, missing the world: cadence at different frame rates,
// release, rapid tap during cooldown, deselect and the tool-speed perk.
for (const fps of [30, 60, 144]) {
  const e = env(); let strokes = 0;
  e.feedback = { act: () => strokes++ };
  const tool = jackhammer.create(e);
  try {
    tool.update(ctx({ dt: 0, primary: true, primaryPressed: true }));
    for (let i = 1; i < fps; i++) tool.update(ctx({ dt: 1 / fps, primary: true }));
    assert.equal(strokes, 10, `${fps} fps: ten strokes/s`);
    for (let i = 0; i < fps; i++) tool.update(ctx({ dt: 1 / fps }));
    assert.equal(strokes, 10, 'release stops');
    tool.deselect(); strokes = 0;
    tool.update(ctx({ dt: 0, primary: true, primaryPressed: true }));
    tool.update(ctx({ dt: 0.01, primary: true, primaryPressed: true }));
    tool.update(ctx({ dt: 0.1 }));
    assert.equal(strokes, 1, 'released cooldown tap is not buffered');
    tool.deselect(); strokes = 0;
    tool.update(ctx({ dt: 0, primary: true }));
    for (let i = 1; i < fps; i++) tool.update(ctx({ dt: 1 / fps, toolRate: 2, primary: true }));
    assert.equal(strokes, 20, 'tool-rate perk doubles cadence');
    const pivot = e.viewmodel.userData.rig.root.children[0].children[0];
    assert.equal(pivot.rotation.x, 0, 'no broad swing');
    assert.equal(pivot.position.z, 0, 'no forward hammering');
    assert.ok(pivot.position.y <= 0 && pivot.position.y >= -0.07, 'vertical piston stroke');
    assert.deepEqual(pivot.parent.userData.gesture.axis, [0, -1, 0], 'third-person stroke drives down too');
  } finally { tool.dispose(); }
}
// Standing mining: the old five-cell reach could not reach even slightly
// forward of the feet, or keep drilling as the face receded.
{
  const e = env(); let bites = 0;
  e.transfer = { take: () => { bites++; return Promise.resolve([]); } };
  const tool = jackhammer.create(e);
  try {
    const eye = new THREE.Vector3(20.5, 20 + EYE_HEIGHT, 20.5);
    const dir = new THREE.Vector3(0, -1, 0.2).normalize();
    for (let i = 0; i < 3; i++) {
      const dist = (EYE_HEIGHT + i * 3) / -dir.y;
      const cell = eye.clone().addScaledVector(dir, dist).floor();
      tool.update(ctx({ dt: REFIRE, eye, dir, sim: { g: { nx: 64, ny: 64, nz: 64 } }, primary: true,
        aim: { valid: true, cell, face: 2, id: E.ROCK, dist } }));
    }
    assert.equal(bites, 3, 'standing drill follows three receding ground bites without a pause');
    tool.update(ctx({ dt: REFIRE, eye, dir, primary: true,
      aim: { valid: true, cell: new THREE.Vector3(20, 0, 20), face: 2, id: E.ROCK, dist: HAND_REACH + 1 } }));
    assert.equal(bites, 3, 'out-of-reach ground stays untouched');
  } finally { tool.dispose(); }
}

// All firearms fire at point-blank range and grid edges, scoped/NPC included.
for (const def of [pistol, smg, sniper]) {
  for (const mode of ['hip', 'ads', 'hidden', ...(def === sniper ? ['scope'] : [])]) {
    for (const near of ['open', 'path', 'barrel', 'edge']) {
      const e = env(), events = [], notices = [], shots = [];
      const off = ['gun:fire', 'gun:dry'].map((name) => povEvents.on(name, () => events.push(name)));
      e.feedback = { notice: (text) => notices.push(text) };
      e.ballistics = { count: 0, fire: (origin, dir) => {
        shots.push({ origin: origin.clone(), dir: dir.clone() }); return shots.length;
      } };
      if (mode === 'hidden') e.viewmodel.visible = false;
      const tool = def.create(e);
      try {
        const eye = new THREE.Vector3(20.5, 6.5, near === 'edge' ? 0.1 : 20.5);
        const dir = new THREE.Vector3(0, 0, -1);
        const player = { pos: new THREE.Vector3(eye.x, 1, eye.z), onGround: true, applyImpulse() {} };
        const sim = { g: { nx: 64, ny: 64, nz: 64 }, gravity: 0.025 };
        // Align the real viewmodel with the eye; gridSpace is identity in this fixture.
        e.viewmodel.position.copy(eye);
        const c = ctx({ dt: 0.3, eye, dir, player, sim, secondary: mode === 'ads' });
        tool.update({ ...c, secondaryPressed: mode === 'scope' });
        const m = muzzleCell(eye, dir, player.pos, sim.g);
        const aim = near === 'path'
          ? { valid: true, cell: m.path[0].clone(), dist: 0.1 }
          : near === 'barrel'
            ? { valid: true, cell: new THREE.Vector3(0, 0, 0), dist: 0.01 }
            : { valid: false };
        tool.update({ ...c, aim, primary: true, primaryPressed: true });
        const label = `${def.key}/${mode}/${near}`;
        assert.equal(shots.length, 1, `${label}: fires`);
        assert.deepEqual(events, ['gun:fire'], `${label}: no dry click`);
        assert.deepEqual(notices, [], `${label}: no blocked notice`);
        assert.ok(shots[0].dir.dot(dir) > 0, `${label}: shoots forward`);
        assert.deepEqual(shots[0].origin.toArray(), eye.toArray(), `${label}: eye origin never skips nearby cover`);
        e.ballistics.count = Infinity;
        tool.update({ ...c, dt: 10, primary: true, primaryPressed: true });
        assert.equal(shots.length, 1, `${label}: capacity limit preserved`);
      } finally { tool.dispose(); off.forEach((unsubscribe) => unsubscribe()); }
    }
  }
}

// Existing buffered triggers retain their behavior.
const t = trigger(REFIRE); t.ready(ctx({ primaryPressed: true })); t.fire();
t.ready(ctx({ dt: 0.01, primaryPressed: true }));
assert.equal(t.ready(ctx({ dt: 0.09 })), true, 'existing melee/gun input buffering preserved');
const gesture = gesturePose('drill', 0.025, REFIRE, [0, 0, 0]);
assert.deepEqual(gesture, [0, 0, 0.07], 'third-person stroke is axial too');
assert.equal(GEAR.at(-1).key, 'JACKHAMMER');
assert.equal(GEAR_ITEMS.at(-1).id, -322, 'appended palette ID');
assert.equal(GEAR_ITEMS.find((g) => g.gear === 'TOOLGUN').id, -321, 'previous palette IDs preserved');
assert.equal(gearByKey('JACKHAMMER').slot, 0); assert.deepEqual(gearByKey('JACKHAMMER').touch, ['Drill']);
console.log('PASS: lifecycle/visibility/cleanup, NPC/no-HUD scope + ADS, getters, cadence/release/perk, axial motion, catalog IDs, point-blank/grid-edge firearms');

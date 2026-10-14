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
const { default: flamer } = await import('../src/pov/tools/blowtorch.tool.js');
const { GEAR, gearByKey } = await import('../src/pov/tools/catalog.js');
const { GEAR_ITEMS } = await import('../src/elements.js');
const { gesturePose } = await import('../src/pov/holds.js');
const { trigger } = await import('../src/pov/tools/action.js');
const env = () => ({ viewmodel: new THREE.Group(), getScale: () => 1, owner: 'held-tools-cpu',
  getVolume: () => new THREE.Object3D(), ballistics: { windowShifted() {} } });
const ctx = (extra = {}) => ({ dt: 1 / 60, eye: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1),
  player: { onGround: true }, aim: { valid: false }, primary: false, primaryPressed: false, ...extra });

const e = env(), held = heldModel(e, { model: 'jackhammer', pos: [0, 0, -1], pivot: true });
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
    assert.equal(pivot.rotation.x, 0, 'no broad swing'); assert.ok(Math.abs(pivot.position.z) <= 0.07);
  } finally { tool.dispose(); }
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
console.log('PASS: lifecycle/visibility/cleanup, NPC/no-HUD scope + ADS, getters, cadence/release/perk, axial motion, catalog IDs');

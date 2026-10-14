// CPU-only: real controller, state, collision and Three models; UI/audio adapters.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { ITEMS, HOMES, FLOOR, HOME_Z, DRESSER, initialState, validState, change,
  restPose, cardinal, drawerFrame, moveProgress, gripMove, gripPosition, standPosition } from '../src/pov/village/state.js';
import { character, dispose } from '../src/pov/village/models.js';
import { povEvents } from '../src/pov/events.js';
import { BODY_WIDTH, BODY_HEIGHT } from '../src/pov/constants.js';
import { residentFurniture } from '../src/pov/village/residents.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  const modules = {
    './ui.js': `export function createVillageUi(opts) {
      globalThis.uiOptions = opts; let opened = false, talking = false;
      return {
        get opened() { return opened; }, get talking() { return talking; },
        open(which = 'pockets') {
          if (which === 'storage' && !opts.context().storageReady) return opts.act({ type: 'openStorage' });
          if (opts.onOpen() !== false) opened = true;
        },
        close() { if (opened) { opened = talking = false; opts.onClose(); } },
        talk(resident, text, choices) { opened = talking = true; globalThis.lastTalk = { resident, text, choices }; opts.onOpen(); },
        update() {}, handleKey() { return false; }
      };
    }`,
    './speech.js': `export function createSpeech() { return { stats: {}, speak() {}, bonk() {}, stop() {} }; }`,
  };
  if (context.parentURL?.endsWith('/village/index.js') && modules[specifier])
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(modules[specifier])}` };
  return next(specifier, context);
} });
globalThis.addEventListener = () => {};
const listeners = {};
globalThis.document = { hidden: false, body: { classList: { toggle() {} } }, querySelector: () => null,
  addEventListener(k, fn) { listeners[k] = fn; },
  createElement: () => ({ getContext: () => ({ beginPath() {}, roundRect() {}, moveTo() {}, lineTo() {}, fill() {}, fillText() {} }) }) };
const saves = new Map();
globalThis.localStorage = { getItem: k => saves.get(k) ?? null, setItem: (k, v) => saves.set(k, v) };
const { createVillage } = await import('../src/pov/village/index.js');
const size = [512, 128, 512], sim = { origin: new THREE.Vector3() };
const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), size: 1, width: BODY_WIDTH, height: BODY_HEIGHT,
  onGround: true, dead: false, jumpCharge: null, leaping: false, sprintRush: 0,
  cancelJump() { this.jumpCharge = null; this.leaping = false; } };
const camera = { look: { yaw: 0, pitch: 0 }, third: true,
  forwardH(out) { return out.set(-Math.sin(this.look.yaw), 0, -Math.cos(this.look.yaw)); } };
let live = true, mode = 'animalCrossing', used = 0;
const app = { scene: new THREE.Scene(), getSim: () => sim, getScale: () => 1,
  getVolume: () => ({ position: new THREE.Vector3() }), getMode: () => mode,
  getWorld: () => ({ scene: { key: 'willowCove' }, P: { size, seed: 'cpu' } }),
  requestRender() {}, isTyping: () => false };
const village = createVillage({ app, getPlayer: () => player, live: () => live, camera,
  freeMouse() {}, releaseInput() {}, releaseActions() {}, onEnabled() {}, onTool() {}, useTool() { used++; } });
function position(x, z, home = 0, y = 0) {
  player.pos.set(size[0] / 2 + HOMES[home] + x - sim.origin.x, FLOOR + y - sim.origin.y,
    size[2] / 2 + HOME_Z + z - sim.origin.z); player.vel.set(0, 0, 0);
}
function tick(n = 1, move = { x: 0, z: 0 }) {
  let input;
  for (let i = 0; i < n; i++) {
    input = { move: { ...move }, jump: true, sprint: true, chargeJump: true };
    village.beforeBody(input, 0.05); village.afterBody(); village.update(0.05, true, camera.look.yaw);
  }
  return input;
}
function reset(state = initialState(), memory) {
  village.setEnabled(false); saves.clear(); sim.origin.set(0, 0, 0); live = true; mode = 'animalCrossing'; player.dead = false;
  saves.set('willow-cove:furniture:v1:cpu', JSON.stringify(state));
  if (memory !== undefined) saves.set('willow-cove:neighbors:v1:cpu', memory);
  position(0, -4); village.setEnabled(true, { size, seed: 'cpu' });
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
let blockedSounds = 0;
povEvents.on('village:blocked', () => blockedSounds++);
reset();
position(-2.5, 5);
assert.ok(!village.act({ type: 'rest', id: 'bed' }).error);
assert.equal(village.interaction.kind, 'sleep');
player.jumpCharge = 1; player.leaping = true;
const frozen = tick();
assert.equal(frozen.jump, false); assert.equal(frozen.cancelJump, true);
assert.equal(player.jumpCharge, null); assert.equal(player.leaping, false);
near(village.avatar.getObjectByName('village-body').rotation.x, Math.PI / 2);
assert.equal(village.avatar.getObjectByName('sleep-eye-left').visible, true);
assert.equal(village.canAct, false);
const restYaw = village.avatar.rotation.y; camera.look.yaw = 2; tick(); near(village.avatar.rotation.y, restYaw);
await village.punch(); await village.kick();
village.act({ type: 'tool', key: 'SHOVEL' }); village.act({ type: 'tool-primary' });
assert.equal(village.tool, null); assert.equal(used, 0);
assert.ok(!village.act({ type: 'cancel' }).error);
near(village.context.player.x, -2.5); near(village.context.player.z, 5);
tick(); assert.equal(village.avatar.getObjectByName('sleep-eye-left').visible, false);

position(-2.5, 5);
assert.ok(!village.act({ type: 'grab', id: 'bed' }).error);
assert.equal(village.carrying, null, 'placed furniture stays on the floor');
assert.equal(village.interaction.kind, 'grip');
const before = village.state.placed.find(i => i.id === 'bed');
const beforePlayer = village.context.player;
const input = tick(1, { x: 1, z: 1 });
assert.deepEqual(input.move, { x: 0, z: 0 }, 'ordinary movement is consumed');
assert.deepEqual(village.context.player, beforePlayer, 'anticipation beat plants feet');
tick(6, { x: 1, z: 1 });
assert.equal(village.state.placed.find(i => i.id === 'bed').x, before.x + 1);
assert.equal(village.state.placed.find(i => i.id === 'bed').z, before.z, 'diagonal input snaps to one cardinal axis');
near(village.context.player.x, beforePlayer.x + 1);
assert.ok(validState(village.state));
tick(70, { x: 1, z: 0 }); // cross the room center; stop only when the player reaches the dresser
assert.ok(blockedSounds > 0); assert.equal(village.state.placed.find(i => i.id === 'bed').x, 0);
village.act({ type: 'cancel' });
assert.equal(village.interaction, null);
assert.equal(JSON.parse(saves.get('willow-cove:furniture:v1:cpu')).placed.find(i => i.id === 'bed').x, 0);

// Every public storage entry path waits for reaching/pulling, then executes.
for (const entry of ['open', 'openStorage', 'store', 'withdraw']) {
  reset(); position(3, 3);
  const beforeStorage = village.state.storage.length;
  const result = entry === 'open' ? village.open('storage')
    : village.act({ type: entry, id: entry === 'store' ? 'plant' : 'chair2' });
  assert.ok(!result?.error, entry);
  assert.equal(village.interaction.phase, 'opening', entry);
  assert.equal(village.blocked, true);
  tick(4);
  assert.equal(village.context.storageReady, false);
  assert.equal(village.state.storage.length, beforeStorage);
  tick(10);
  assert.equal(village.context.storageReady, true);
  const dresser = village.root.getObjectByName('village-dresser');
  assert.ok(dresser.userData.drawer.position.z < -0.6, 'real drawer mesh moves');
  assert.equal(village.state.storage.length, beforeStorage + (entry === 'store' ? 1 : entry === 'withdraw' ? -1 : 0));
  village.close(); tick(6);
  assert.equal(village.interaction, null); near(dresser.userData.drawer.position.z, 0);
}
reset(); position(3, 3); village.open('storage'); tick(2); village.act({ type: 'cancel' }); tick(6);
assert.equal(village.interaction, null, 'cancel opening safely closes drawer');
assert.deepEqual(village.state, initialState());

// Pocket previews still permit free movement, unlike grounded grips.
reset(); assert.ok(!village.act({ type: 'grab', id: 'plant' }).error);
assert.ok(village.carrying); assert.equal(village.interaction, null);
const walking = tick(1, { x: 1, z: 0 }); assert.equal(walking.move.x, 1);
village.act({ type: 'cancel' });
// Guests may rest, but ownership never transfers to them.
for (const home of [1, 2, 3]) for (const family of ['chair', 'bed']) {
  reset();
  const item = residentFurniture(home).find(i => ITEMS[i.kind].family === family);
  const halfWidth = (item.rotation % 2 ? ITEMS[item.kind].d : ITEMS[item.kind].w) / 2;
  const x = item.x + (item.x < 0 ? 1 : -1) * (halfWidth + 1.2);
  position(x, item.z, home); camera.look.yaw = Math.atan2(x - item.x, 0);
  const action = uiOptions.primary();
  assert.match(action?.title, /Sit on|Sleep in/);
  assert.equal(action.secondary, null, 'neighbor furniture has no grab action');
  village.act({ type: 'interact' }); tick();
  assert.equal(village.interaction.kind, family === 'bed' ? 'sleep' : 'sit');
  assert.ok(village.act({ type: 'grab', id: item.id }).error);
  assert.ok(!village.act({ type: 'cancel' }).error);
  near(player.pos.x + sim.origin.x, size[0] / 2 + HOMES[home] + x);
  assert.deepEqual(village.state, initialState(), 'resting does not change either home');
}
const effortModel = character();
const animateGrip = pose => effortModel.animate(1, 0, false, false, 0, 0, false, false, null, 0, { kind: 'grip', ...pose });
animateGrip({ reach: 0, effort: 0 });
near(effortModel.root.getObjectByName('arm-left').rotation.x, 0);
animateGrip({ reach: 1, effort: 1, pulling: true });
assert.ok(effortModel.root.getObjectByName('village-body').rotation.x > 0, 'yank leans backward');
animateGrip({ reach: 1, effort: 1, pulling: false });
assert.ok(effortModel.root.getObjectByName('village-body').rotation.x < 0, 'push leans forward');
dispose(effortModel.root);
for (const cleanup of ['teleport', 'hidden', 'inactive', 'death', 'mode']) {
  reset(); position(-2.5, 5); village.act({ type: 'rest', id: 'bed' });
  if (cleanup === 'teleport') position(0, -5);
  if (cleanup === 'hidden') { document.hidden = true; listeners.visibilitychange(); document.hidden = false; }
  if (cleanup === 'inactive') live = false;
  if (cleanup === 'death') player.dead = true;
  if (cleanup === 'mode') mode = 'sandbox';
  tick(); assert.equal(village.interaction, null, cleanup);
  if (cleanup === 'teleport') near(village.context.player.z, -5);
}

// Fast sweeps and NPC walking use real controller coordinates, including origin offsets.
reset(); sim.origin.set(50, 7, -30);
const resident = village.residents[0];
position(-100, resident.z, 1); village.beforeBody({}, 0);
player.pos.x += 200; village.afterBody();
const residentWorldX = size[0] / 2 + HOMES[1] + resident.x - sim.origin.x;
assert.ok(player.pos.x <= residentWorldX - 2.8 + 1e-6, 'large motions cannot tunnel through characters');
position(-100, resident.z, 1, 9); village.beforeBody({}, 0); player.pos.x += 200; village.afterBody();
near(player.pos.x, size[0] / 2 + HOMES[1] + 100 - sim.origin.x);
position(resident.x, resident.z, 1, 9); village.beforeBody({}, 0);
player.pos.y = FLOOR - sim.origin.y; player.vel.y = -20; village.afterBody();
assert.ok(player.pos.y > FLOOR - sim.origin.y + 5, 'landing cannot enter a resident from above');
assert.equal(player.vel.y, 0);
position(resident.x, resident.z + 2.81, 1);
for (let n = 0; n < 200; n++) {
  village.update(0.05);
  const r = village.residents[0], world = player.pos.clone().add(sim.origin);
  assert.ok(Math.hypot(world.x - size[0] / 2 - HOMES[1] - r.x, world.z - size[2] / 2 - HOME_Z - r.z) >= 2.8 - 1e-6);
}

// Real chat wiring remembers choices and never overwrites unreadable saves.
reset(); position(0, 3, 1); village.act({ type: 'interact' });
assert.equal(lastTalk.choices.length, 3);
uiOptions.speakNext(lastTalk.choices[0].id); const choice = lastTalk.choices[0].id;
uiOptions.speakNext(choice); village.close();
village.act({ type: 'interact' });
const memoryKey = 'willow-cove:neighbors:v1:cpu';
assert.equal(JSON.parse(saves.get(memoryKey)).residents.Maple.lastChoice, choice);
assert.match(lastTalk.text, /knot/);
const visits = JSON.parse(saves.get(memoryKey)).residents.Maple.visits;
uiOptions.speakNext(); assert.equal(JSON.parse(saves.get(memoryKey)).residents.Maple.visits, visits);
for (const raw of ['bad JSON', '{"version":2}', '{"version":1,"residents":{"Maple":{"version":99}}}']) {
  reset(initialState(), raw); position(0, 3, 1); village.act({ type: 'interact' });
  assert.equal(saves.get(memoryKey), raw);
}

// Metadata, not literal item names, selects every supported resting family.
for (const [kind, spec] of Object.entries(ITEMS)) for (let rotation = 0; rotation < 4; rotation++) {
  const item = { id: 'order-1', kind, x: -6, z: 5, rotation }, pose = restPose(item);
  if (!spec.seatHeight && !spec.lyingHeight) { assert.equal(pose, null); continue; }
  assert.equal(pose.kind, spec.lyingHeight ? 'sleep' : 'sit');
  near(pose.yaw, rotation * Math.PI / 2);
  const model = character();
  model.animate(1, 0, false, false, 0, 0, false, false, null, 0, pose);
  near(model.root.getObjectByName('knee-left').rotation.x, spec.seatHeight ? -Math.PI / 2 : 0);
  dispose(model.root);
}
assert.equal(cardinal({ x: 0.1, z: 0.1 }), null);
assert.equal(cardinal({ x: NaN, z: 1 }), null);
assert.equal(moveProgress(0.07), 0); near(moveProgress(0.35), 1);
assert.equal(drawerFrame(0.2).extension, 0); assert.equal(drawerFrame(0.65).ready, true);
const starter = initialState(), bed = starter.placed[0], grip = gripPosition(starter, bed, { x: -2.5, z: 5 });
assert.ok(gripMove(starter, bed, grip, { x: 1, z: 1 }).error);
assert.ok(standPosition(starter, bed, restPose(bed), { x: -2.5, z: 5 }));
assert.equal(standPosition({ placed: [...starter.placed, { id: 'obstruction', kind: 'sofa', x: -2.5, z: 5, rotation: 0 }] },
  bed, restPose(bed), { x: -2.5, z: 5 }), null, 'never stand in an obstructed exit');
village.setEnabled(false); hooks.deregister();
console.log('PASS real-controller grip/rest/drawer/lifecycle, input/tool/kick/leap gates, memory, swept characters and all themed poses (CPU only)');

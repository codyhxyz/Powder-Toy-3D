// CPU-only: real controller, state, collision and Three models; UI/audio adapters.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { ITEMS, HOMES, FLOOR, HOME_Z, DRESSER, initialState, validState, change,
  bounds, restPose, cardinal, drawerFrame, moveProgress, gripMove, gripPosition, standPosition } from '../src/pov/village/state.js';
import { character, dispose } from '../src/pov/village/models.js';
import { povEvents } from '../src/pov/events.js';
import { BODY_WIDTH, BODY_HEIGHT } from '../src/pov/constants.js';
import { residentFurniture } from '../src/pov/village/residents.js';
import { willowCove, willowCoveTwin } from '../src/world/scenes/willowCove.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  const modules = {
    './debtBadge.js': `export function createDebtBadge(){return {update(){},dispose(){}}}`,
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
    './speech.js': `export function createSpeech() { return { stats: {}, speak() {}, swing() {}, bonk() {}, stop() {} }; }`,
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
const { villageBuildings, buildingDoors, buildingPoint, buildingAt } = await import('../src/pov/village/buildings.js');
const { createDoorController, resolveBoxMotion, inReach, DOOR_SECONDS } = await import('../src/pov/village/doors.js');
const { createBuildingRuntime } = await import('../src/pov/village/buildingRuntime.js');
const buildings = villageBuildings(true), specs = buildingDoors(buildings);
assert.equal(villageBuildings(false).length, 4);
assert.equal(buildings.length, 16); assert.equal(specs.length, 17);
assert.equal(new Set(specs.map(d => d.id)).size, 17);
assert.ok(buildings.slice(4).every(b => b.occupant && b.items.length >= 4));
assert.equal(buildings[0].occupant, undefined, 'no stranger in the player home');
assert.equal(new Set(buildings.slice(4).map(b => b.items.map(i => `${i.kind}:${i.x}:${i.z}`).join('|'))).size, 12, 'distinct interior layouts');
for (const b of buildings) {
  assert.equal(buildingAt([b], { x: b.at[0], y: b.floor, z: b.at[1] }), b);
  assert.equal(buildingAt([b], { x: b.at[0], y: b.floor - 3, z: b.at[1] }), null);
  for (const i of b.items ?? []) {
    const a = bounds(i);
    assert.ok(Math.abs(i.x) < b.half[0] - 1 && Math.abs(i.z) < b.half[1] - 1);
    assert.ok(!overlap(a, { x: -4, z: 0, w: 8, d: b.half[1] }), `${b.id} leaves the center door approach clear`);
  }
}
function overlap(a,b) { return a.x < b.x+b.w && a.x+a.w > b.x && a.z < b.z+b.d && a.z+a.d > b.z; }
for (const spec of specs) {
  const c = createDoorController([spec]), d = c.doors[0], nx = Math.sin(d.yaw), nz = Math.cos(d.yaw);
  const outside = { x: d.x + nx * 8, y: d.floor, z: d.z + nz * 8, height: 6 };
  const inside = { x: d.x - nx * 10, y: d.floor, z: d.z - nz * 10 };
  const closed = resolveBoxMotion(outside, inside, 0.8, c.colliders()); assert.ok(closed.blocked, `${d.id}: closed passage solid`);
  c.toggle(d, outside, 0.8); c.tick(DOOR_SECONDS / 2, outside, 0.8);
  assert.equal(d.progress, 0.5); assert.ok(resolveBoxMotion(outside, inside, 0.8, c.colliders()).blocked, `${d.id}: partial passage solid`);
  c.tick(DOOR_SECONDS / 2, outside, 0.8); assert.equal(d.progress, 1);
  assert.equal(resolveBoxMotion(outside, inside, 0.8, c.colliders()).blocked, false, `${d.id}: fully open passage accessible`);
  assert.ok(c.toggle(d, { x: d.x, y: d.floor, z: d.z, height: 6 }, 0.8).error, 'cannot close through player');
  assert.ok(!c.toggle(d, outside, 0.8).error); c.tick(DOOR_SECONDS / 3, outside, 0.8);
  c.tick(DOOR_SECONDS, { x: d.x, y: d.floor, z: d.z, height: 6 }, 0.8);
  assert.equal(d.target, 1, 'entering closing sweep reverses door safely');
  c.dispose(); assert.equal(c.doors.length, 0);
}
assert.ok(inReach({ x: 0, y: 24, z: 5 }, { x: 0, y: 24, z: 0 }, { x: 0, z: -1 }));
assert.ok(!inReach({ x: 0, y: 24, z: 5 }, { x: 0, y: 24, z: 0 }, { x: 0, z: 1 }));
assert.ok(!inReach({ x: 0, y: 28, z: 5 }, { x: 0, y: 24, z: 0 }, { x: 0, z: -1 }));
assert.ok(!inReach({ x: 0, y: 24, z: 8 }, { x: 0, y: 24, z: 0 }, { x: 0, z: -1 }));
const huge = resolveBoxMotion({ x: -100000, z: 0 }, { x: 100000, z: 0 }, 0.8, [{ x: -0.2, z: -4, w: 0.4, d: 8 }]);
assert.ok(huge.blocked && huge.x < -1, 'fast motion cannot tunnel');
const sweep = createDoorController([{ x: 0, z: 0, floor: 24, yaw: 0, width: 8, height: 11 }]);
sweep.doors[0].target = 1;
const visitor = { x: 2.7549981495, y: 24, z: -3.9, height: 6 };
sweep.tick(0.1, visitor, 0.8);
const safeAngle = sweep.doors[0].progress;
sweep.tick(0.1, visitor, 0.8);
assert.equal(sweep.doors[0].progress, safeAngle, 'opening checks the entire angular sweep');

const size = [3072, 128, 1024], sim = { origin: new THREE.Vector3() };
const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), size: 1, width: BODY_WIDTH, height: BODY_HEIGHT,
  onGround: true, dead: false, cancelJump() {} };
const camera = { look: { yaw: 0, pitch: 0 }, third: true, forwardH: out => out.set(0, 0, -1) };
let seed = 'buildings', mode = 'animalCrossing';
const app = { scene: new THREE.Scene(), settings: { villageCharacter: 'boy' }, getSim: () => sim, getScale: () => 1,
  getVolume: () => ({ position: new THREE.Vector3() }), getMode: () => mode,
  getWorld: () => ({ scene: { key: 'willowCove' }, P: { size, seed } }), requestRender() {}, isTyping: () => false, save() {} };
const village = createVillage({ app, getPlayer: () => player, live: () => true, camera, freeMouse() {}, releaseInput() {}, releaseActions() {}, onEnabled() {}, onTool() {} });
function position(x, y, z) { player.pos.set(size[0]/2+x-sim.origin.x,y-sim.origin.y,size[2]/2+z-sim.origin.z); player.vel.set(0,0,0); }
position(-380,24,28); village.setEnabled(true, { size, seed });
assert.equal(village.buildings.length, 16); assert.equal(village.doors.length, 17);
assert.equal(globalThis.uiOptions.primary().title, 'Open Creek Supply door');
village.act({ type:'interact' }); village.update(0.6);
assert.equal(village.doors.find(d=>d.id==='nookShop').progress,1);
position(-380,24,7.5); village.act({ type:'interact' });
assert.equal(globalThis.lastTalk.resident.name,'Nutmeg');
globalThis.uiOptions.speakNext('catalogue'); assert.ok(!globalThis.uiOptions.context().home && globalThis.uiOptions.context().catalogue);
const old = village.state; assert.ok(!village.act({ type:'order',kind:'botanicalShelf' }).error);
assert.deepEqual(village.state.placed,old.placed); assert.deepEqual(village.state.storage,old.storage);
assert.equal(village.state.pockets.at(-1).kind,'botanicalShelf'); village.close();
// A streaming-origin shift between before/after physics must not alter the
// absolute sweep through the still-closed original-home doorway.
position(HOMES[0],FLOOR,HOME_Z-20); village.beforeBody({move:{x:0,z:0}},0);
sim.origin.set(100,0,32); position(HOMES[0],FLOOR,HOME_Z+2); village.afterBody();
assert.ok(player.pos.z+sim.origin.z-size[2]/2 < HOME_Z-11, 'streaming and fast crossing stay blocked');
// Original neighbor talk wins over a nearby chair, independent of furniture order.
position(HOMES[1],FLOOR,HOME_Z+5); assert.equal(globalThis.uiOptions.primary().title,'Talk to Maple');
// New furniture rest uses the same avatar pose and restores a clear standing spot.
position(264+7,36,-80-6); // west-facing café chair at local (6,7)
const chairWorld = buildingPoint(buildings.find(b=>b.id==='cafe'),6,7);
position(chairWorld.x,36,chairWorld.z+3); camera.forwardH=out=>out.set(0,0,-1);
const runtime = createBuildingRuntime(new THREE.Group(),size);
assert.equal(runtime.actors.length,12);
for (const form of runtime.furnishings.filter(i => i.id.endsWith('-form'))) {
  assert.equal(runtime.rest(form, { x: form.x, y: form.y, z: form.z + 3 }, 0.8, 1), null, 'dress forms are not chairs');
}
assert.ok(runtime.collide({ x: 77.5, y: 48.8, z: -406 }, { x: 77.5, y: 48.8, z: -404 }, 0.8, 1.4, 6).blocked, 'raised curtain posts are solid');
const cafeChair = runtime.furnishings.find(i=>i.building.id==='cafe' && i.kind==='chair');
const entry = {x:cafeChair.x-3,y:36,z:cafeChair.z};
const pose = runtime.rest(cafeChair,entry,player.width/2,1); assert.ok(pose);
assert.ok(runtime.stand(cafeChair,pose,entry,player.width/2,1));
assert.equal(runtime.rest(cafeChair, { x: 240, y: 36, z: -74 }, player.width / 2, 1), null, 'rest cannot cross an exterior wall or closed door');
position(entry.x, 36, entry.z); camera.forwardH = out => out.set(1, 0, 0);
assert.match(globalThis.uiOptions.primary().title, /^Sit on/);
player.cellAt = () => -1;
assert.ok(village.act({ type: 'interact' }).error, 'unloaded or obstructed voxel paths cannot teleport into a seat');
delete player.cellAt;
assert.ok(!village.act({ type: 'interact' }).error);
assert.equal(village.interaction.kind, 'sit', 'new seats use the actual village controller');
village.act({ type: 'cancel' });
assert.equal(village.interaction, null);
assert.equal(player.pos.x + sim.origin.x - size[0] / 2, entry.x, 'standing restores building coordinates, not home coordinates');
assert.equal(player.pos.y + sim.origin.y, 36);
const twin = willowCoveTwin(willowCove.params({ size, seed: 20261008 }));
player.cellAt = (x, y, z) => twin.wcCell(x + sim.origin.x, y + sim.origin.y, z + sim.origin.z);
position(-268, 24, 12); village.beforeBody();
position(-272, 24, 8); village.afterBody();
assert.equal(player.pos.x + sim.origin.x - size[0] / 2, -268, 'an NPC slide cannot redirect terrain-safe motion into voxel furniture');
assert.equal(player.pos.z + sim.origin.z - size[2] / 2, 12);
delete player.cellAt;
let disposed = 0; const runtimeRoot = runtime.actors[0].model.root.parent;
runtimeRoot.traverse(o=>{if(o.geometry)o.geometry.addEventListener('dispose',()=>disposed++);});
runtime.dispose(); assert.ok(disposed>0); assert.equal(runtimeRoot.parent,null); assert.equal(runtime.actors.length,0);
const previousRoot = village.root.getObjectByName('village-buildings'); seed='new-buildings'; village.update(0);
assert.equal(previousRoot.parent,null); assert.equal(village.doors.every(d=>d.progress===0),true);
mode='sandbox'; village.update(0); assert.equal(village.enabled,false); assert.equal(village.root.children.length,0);
size[0]=512; mode='animalCrossing'; village.update(0); assert.equal(village.buildings.length,4); assert.equal(village.doors.length,4);
village.setEnabled(false); hooks.deregister();
console.log('PASS 16-building interiors/occupants, 17 animated doors, continuous collision, facing/floor/reach, shop saves, original talk, rest and lifecycle (CPU only)');

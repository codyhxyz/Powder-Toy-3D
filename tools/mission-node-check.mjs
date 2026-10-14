import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createMissionAttempt, validMission } from '../src/game/missionRules.js';
import { createMission } from '../src/game/mission.js';
import { GunnerAgent } from '../src/pov/ai/gunner.js';
import { createMarkers } from '../src/game/markers.js';
import { MAPS, mapsFor, resolveMode } from '../src/maps.js';

const manifest = () => ({ id: 'fixture', name: 'CPU fixture (not a playable map)', spawn: [12, 4, 20],
  targets: [{ id: 'a', name: 'Target A', at: [20, 4, 20] }, { id: 'b', name: 'Target B', at: [30, 4, 20] }],
  guards: [{ id: 'guard', name: 'Guard', at: [40, 4, 20] }], extraction: { at: [50, 4, 20], radius: 3, height: 4 } });
const exit = { x: 50, y: 4, z: 20 };
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
check('unsupported maps remain ineligible; all registered missions validate', () => {
  for (const map of MAPS) if (!map.mission) assert.equal(resolveMode(map, 'crueltySquad').key, 'sandbox');
  for (const map of mapsFor('crueltySquad')) assert.ok(validMission(map.mission));
  const map = { modes: ['crueltySquad'], mission: manifest() };
  assert.equal(resolveMode(map, 'crueltySquad').key, 'crueltySquad');
  map.mission.targets = [];
  assert.equal(resolveMode(map, 'crueltySquad').key, 'sandbox');
});
check('reject invalid/duplicate metadata rather than invent objectives', () => {
  for (const alter of [m => m.targets[0].at[0] = NaN, m => m.guards[0].id = 'a', m => m.extraction.radius = 0,
    m => m.spawn = null, m => m.targets[0].style = 'imaginary', m => m.targets[0].weapons = ['PHYSGUN'],
    m => m.spawnYaw = NaN,
    m => m.extraction.bounds = { min: [0, 0, 0], max: [1, NaN, 1] },
    m => m.extraction.bounds = { min: [0, 0, 0], max: [1, 0, 1] }]) {
    const m = manifest(); alter(m); assert.equal(validMission(m), false); assert.throws(() => createMissionAttempt(m));
  }
});
check('early extraction, guard death and duplicate death cannot complete mission', () => {
  const run = createMissionAttempt(manifest());
  assert.equal(run.update({ at: exit, dead: false }), 'active');
  assert.equal(run.eliminate('guard'), false);
  assert.equal(run.eliminate('unknown'), false);
  assert.equal(run.eliminate('a'), true);
  assert.equal(run.eliminate('a'), false);
  assert.equal(run.state.eliminated, 1);
  assert.equal(run.update({ at: exit, dead: false }), 'active');
});
check('all targets unlock EXIT, horizontal/vertical proximity both required', () => {
  const run = createMissionAttempt(manifest()); run.eliminate('b'); run.eliminate('a');
  assert.equal(run.state.ready, true);
  assert.equal(run.update({ at: { ...exit, y: 9 }, dead: false }), 'active');
  assert.equal(run.update({ at: { ...exit, x: 54 }, dead: false }), 'active');
  assert.equal(run.update({ at: exit, dead: false }), 'complete');
  assert.equal(run.update({ dead: true }), 'complete');
});
check('death fails even on extraction frame; fresh retry clears all objective progress', () => {
  const m = manifest(), run = createMissionAttempt(m); run.eliminate('a'); run.eliminate('b');
  assert.equal(run.update({ at: exit, dead: true }), 'failed');
  assert.equal(run.eliminate('a'), false);
  assert.equal(run.update({ at: exit, dead: false }), 'failed');
  assert.equal(createMissionAttempt(m).state.eliminated, 0);
});
check('authored rectangular extraction uses full width and body overlap, not an inscribed cylinder', () => {
  const m = manifest();
  m.extraction.bounds = { min: [20, 4, 19], max: [80, 40, 21] };
  const run = createMissionAttempt(m); run.eliminate('a'); run.eliminate('b');
  assert.equal(run.update({ dead: false, at: { x: 79, y: 3, z: 18.1 }, width: 1, height: 5 }), 'active');
  assert.equal(run.update({ dead: false, at: { x: 79, y: 3, z: 18.7 }, width: 1, height: 5 }), 'complete');
});
check('either authored exit completes; malformed additional exits invalidate the manifest', () => {
  const m = manifest(), second = { at: [100, 4, 20], radius: 2, height: 4 };
  m.extractions = [m.extraction, second];
  const run = createMissionAttempt(m); run.eliminate('a'); run.eliminate('b');
  assert.equal(run.update({ dead: false, at: { x: 100, y: 4, z: 20 } }), 'complete');
  m.extractions = []; assert.equal(validMission(m), false);
  m.extractions = [second, { ...second, height: 0 }]; assert.equal(validMission(m), false);
});
check('multiple exit markers retain full authored box bounds and dispose replaced geometry', () => {
  const scene = new THREE.Scene(), volume = new THREE.Group();
  volume.position.set(7, 8, 9);
  const markers = createMarkers({ scene, getVolume: () => volume, getScale: () => 0.3 });
  const a = { x: 20, y: 4, z: 20, bounds: { min: [10, 4, 19], max: [30, 40, 21] } };
  const b = { x: 100, y: 4, z: 20, r: 2 };
  markers.zones([a, b]);
  markers.update({ time: 0, bots: [], myTeam: 'red' });
  const root = scene.children[0], first = root.children[0];
  assert.equal(root.children.length, 2);
  assert.deepEqual(first.position.toArray(), [13, 9.2, 15]);
  assert.equal(first.children[0].geometry.parameters.width, 20);
  assert.equal(first.children[0].geometry.parameters.depth, 2);
  let disposed = false;
  first.children[0].geometry.addEventListener('dispose', () => disposed = true);
  markers.zone(b);
  assert.equal(root.children.length, 1); assert.equal(disposed, true);
  markers.clear(); assert.equal(root.children.length, 0);
});
check('no time limit or individual respawn in lifecycle; stopped attempts remain stopped', () => {
  const run = createMissionAttempt(manifest());
  assert.equal(run.update({ at: exit, dead: false, time: 1e9 }), 'active');
  run.stop(); assert.equal(run.eliminate('a'), false); assert.equal(run.update({ at: exit }), 'stopped');
});

function fixture({ defer = false } = {}) {
  let resolve;
  const loaded = [], opened = [], hud = [], player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), dead: false };
  const scene = new THREE.Scene(), sim = { origin: new THREE.Vector3(10, 0, 10) };
  const mod = { createNpc(options) {
    const listeners = new Map();
    const n = { id: `npc${loaded.length}`, root: new THREE.Group(), agent: { weapons: null, prey: {}, foes: new Map(),
      brain: { clearSubgoals() {} }, memory: { getRecord: () => null } }, kit: { keys: [] }, disposed: false, updates: 0,
      body: { pos: options.home(), dead: false, on: (name, fn) => listeners.set(name, fn),
        windowShifted(dx, dz) { this.pos.x -= dx; this.pos.z -= dz; } },
      update(dt) { this.updates++; if (dt > 1 && !options.oneShot) this.body.dead = false; },
      kill() { this.body.dead = true; listeners.get('death')?.(); },
      dispose() { this.disposed = true; }, setVisible() {}, options,
    };
    loaded.push(n); return n;
  } };
  const ready = { mod, ai: {} };
  const toolbelt = { selectedKey: 'SHOVEL', restricted: null,
    restrict(keys, selected) { this.restricted = keys; if (selected) this.selectedKey = selected; },
    select(key) { this.selectedKey = key; } };
  const shell = { scene, player, app: { getSim: () => sim, openMap: (...args) => opened.push(args) },
    toolbelt,
    env: () => ({}), loadNpcs: () => defer ? new Promise(r => resolve = r) : Promise.resolve(ready),
    respawnPlayer: (at) => { player.pos.copy(at); player.dead = false; }, hud: { update: (state) => hud.push(state) } };
  return { shell, loaded, opened, hud, player, scene, sim, release: () => resolve(ready) };
}
const f = fixture(), mission = createMission(f.shell), map = { key: 'fixture', mission: manifest() };
assert.equal(await mission.start(map), true);
check('adapter creates exactly authored actors and spawn in origin-relative cells', () => {
  assert.equal(f.loaded.length, 3); assert.deepEqual(f.player.pos.toArray(), [2, 4, 10]);
  assert.ok(f.loaded.every(n => n.options.oneShot));
  assert.deepEqual([...f.loaded[0].agent.weapons], []);
  assert.equal(f.loaded[0].options.opponents().length, 0);
  assert.deepEqual([...f.loaded[2].agent.weapons], ['GUN']);
  assert.equal(f.loaded[2].options.opponents()[0].id, 'player');
  assert.deepEqual(f.shell.toolbelt.restricted, ['GUN', 'SMG']);
  assert.equal(f.shell.toolbelt.selectedKey, 'GUN', 'mission starts armed, not holding a shovel');
});
check('adapter guards do not count and targets never respawn after death', () => {
  f.loaded[2].kill(); f.loaded[0].kill(); mission.update(100, {});
  assert.equal(mission.state.eliminated, 1); assert.equal(f.loaded[0].body.dead, true);
  assert.equal(f.hud.at(-1).targets[0].eliminated, true);
});
check('adapter uses authoritative body deaths and WORLD extraction coordinates', () => {
  f.loaded[1].body.dead = true; // environmental death without credited kill event
  mission.update(0, {}); assert.equal(mission.state.ready, true); assert.equal(mission.state.phase, 'active');
  f.player.pos.set(40, 4, 10); mission.update(0, {}); assert.equal(mission.state.phase, 'complete');
  mission.retry(); assert.deepEqual(f.opened.at(-1), ['fixture', 'crueltySquad']);
});
await mission.start(map);
check('retry rebuilds actors and objectives, cleanup removes all scene/target owners', () => {
  assert.equal(mission.state.eliminated, 0); assert.ok(f.loaded.slice(0, 3).every(n => n.disposed));
  f.player.dead = true; mission.update(0, {}); assert.equal(mission.state.phase, 'failed');
  mission.end(); assert.equal(mission.state, null); assert.equal(mission.engaged, false);
  assert.equal(f.shell.toolbelt.selectedKey, 'SHOVEL'); assert.equal(f.shell.toolbelt.restricted, null);
  assert.equal(f.scene.children.length, 0); assert.ok(f.loaded.every(n => n.disposed));
});
const pending = fixture({ defer: true }), cancelled = createMission(pending.shell);
const starting = cancelled.start(map); cancelled.end(); pending.release();
assert.equal(await starting, false);
check('cancelled async map/mode entry cannot spawn into replacement world', () => { assert.equal(pending.loaded.length, 0); assert.equal(cancelled.engaged, false); });
check('existing gunner respects authored weapons, including empty loadouts', () => {
  const agent = new GunnerAgent({ body: { pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: true, jetFuel: 1 },
    target: () => ({ pos: new THREE.Vector3(20, 0, 0), vel: new THREE.Vector3(), alive: true }) });
  agent.record.timeLastSensed = 0; agent.record.visible = true;
  agent.steerTo = () => {}; agent.ready = () => false; agent.lookAt = () => {};
  agent.clearIntent();
  agent.weapons = new Set(['GUN']);
  agent.brain.evaluators[0].setGoal(agent); agent.brain.currentSubgoal().execute();
  assert.equal(agent.intent.tool, 'GUN');
  agent.clearIntent(); agent.weapons = new Set();
  agent.brain.currentSubgoal().execute();
  assert.equal(agent.intent.tool, null);
});
const streamed = fixture(), streamedMission = createMission(streamed.shell), distant = manifest();
streamed.sim.g = { windowed: true, nx: 64, nz: 64 };
distant.targets[0].at = [100, 4, 20];
await streamedMission.start({ key: 'streamed-fixture', mission: distant });
check('streamed distant targets retain authored positions and sleep outside resident cells', () => {
  streamedMission.update(10, {});
  assert.equal(streamed.loaded[0].updates, 0);
  assert.equal(streamed.loaded[1].updates, 1);
  assert.deepEqual(streamed.loaded[0].body.pos.toArray(), [90, 4, 10]);
  streamed.sim.origin.x += 80;
  streamedMission.windowShifted(80, 0);
  assert.deepEqual(streamed.loaded[0].body.pos.toArray(), [10, 4, 10]);
  streamedMission.update(10, {});
  assert.equal(streamed.loaded[0].updates, 1);
  assert.equal(streamed.loaded[1].updates, 1); // now outside the window, not randomly relocated
});
streamedMission.end();
console.log(`${checks} mission CPU checks passed (no browser/GPU).`);

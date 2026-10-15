// Real mission -> createNpc -> CrueltyAgent/figure path; CPU only, no renderer.
// Only the GPU/tool kit is replaced: bodies, hit targets, minds, geometry and
// mission selection are production code. Existing enemy-aim check tests real guns.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import fs from 'node:fs';
import * as THREE from 'three';
registerHooks({ load(url, context, next) {
  if (url.endsWith('/pov/tools/index.js')) return { format: 'module', shortCircuit: true,
    source: 'export const createKit = () => ({ keys: [], tool: () => null, putAway() {}, dispose() {} });' };
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return next(url, context);
} });
const { createMission } = await import('../src/game/mission.js');
const { createNpc } = await import('../src/pov/npc.js');
const { CrueltyAgent } = await import('../src/pov/ai/cruelty.js');
const { Agent, REACTION_S } = await import('../src/pov/ai/brain.js');
const { GunnerAgent } = await import('../src/pov/ai/gunner.js');
const { crueltyProfile } = await import('../src/game/crueltyProfiles.js');
const { buildCruelty } = await import('../src/pov/figureCruelty.js');
const { bodyTarget } = await import('../src/pov/targets.js');
const { BODY_WIDTH, BODY_HEIGHT } = await import('../src/pov/constants.js');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
const world = { visible: true, sees() { return this.visible; }, nearest: () => null, raycast: () => ({ valid: false }) };
const ai = { world, nav: { path: (from, to) => [to] } };
const player = { pos: new THREE.Vector3(0, 0, -20), vel: new THREE.Vector3(), dead: false };
const sim = { origin: new THREE.Vector3() }, scene = new THREE.Scene();
const mission = createMission({ player, scene, env: () => ({ getSim: () => null }),
  app: { getSim: () => sim }, respawnPlayer: () => {}, loadNpcs: async () => ({ mod: { createNpc }, ai }) });
const actor = (name, props = {}) => ({ id: name, name, at: [0, 0, 0], style: 'gunner',
  sourceResource: `res://Entities/Enemies/${name}.tscn`, sourceProperties: props });
const manifest = { id: 'cpu-enemies', name: 'CPU enemies', spawn: [0, 0, -20],
  targets: [actor('Obj_Nerd_1', { health: 15, civilian: true, stupid: true }),
    actor('Obj_Executive1', { civilian: true }), actor('Chief', { civilian: false, health: 120 })],
  guards: ['E_Grunt', 'E_Elite', 'E_Security', 'E_Cop_Revolver', 'E_Cop_Shotgun', 'E_Assassin', 'E_Knifelord', 'E_Mutant'].map(n => actor(n)),
  extraction: { at: [50, 0, 0], radius: 2, height: 4 } };
await mission.start({ key: 'cpu-enemies', cellMeters: 0.3, mission: manifest });
  const actors = mission.actors;
  for (const actor of actors) assert.doesNotThrow(() => actor.debug, 'dormant actors have no frame world yet');
const step = (a, dt = 1 / 60) => { a.regulator.ready = () => true; a.think(dt); return a.intent; };
const fire = a => a.intent.primary || a.intent.primaryPressed;
try {
  check('actual mission spawns choose isolated mind, role appearance and loadouts', () => {
    assert.equal(actors.length, 11);
    for (const n of actors) { assert.ok(n.agent instanceof CrueltyAgent); assert.ok(n.root.getObjectByName('angular-skull')); }
    assert.deepEqual(actors.slice(3).map(n => [...n.agent.weapons][0]), ['GUN', 'SMG', 'SMG', 'GUN', 'SMG', 'SNIPER', 'AXE', 'AXE']);
    assert.deepEqual([...actors[0].agent.weapons], []);
    assert.equal(actors[2].agent.profile.civilian, false, 'hostile objective is not made passive');
    assert.equal(actors[2].agent.profile.health, 120);
    assert.equal(actors[0].agent.profile.damageScale, 40 / 15);
    assert.equal(actors[3].agent.profile.damageScale, 1);
    assert.ok(actors[4].root.getObjectByName('ballistic-vest'));
    assert.ok(actors[8].root.getObjectByName('respirator'));
  });
  check('actual goal selection respects reaction, salvos and cadence', () => {
    for (const n of actors.slice(3, 9)) {
      const a = n.agent;
      while (a.now < a.profile.reaction - 0.03) { step(a); assert.ok(!fire(a), `${a.profile.role} waits`); }
      while (!a.intent.primaryPressed) step(a);
      const start = a.now;
      assert.equal(a.lastGoal, 'Attack'); assert.equal(a.intent.tool, [...a.weapons][0]);
      assert.ok(Math.abs(a.intent.look.x) <= 20 * Math.tan(a.profile.spread) + 1e-6, 'role spread bounds');
      step(a);
      assert.equal(!!a.intent.primary, a.profile.burst > 0);
      while (a.now < start + a.profile.interval - 0.02) { step(a); assert.equal(a.intent.primaryPressed, false); }
      while (!a.intent.primaryPressed) step(a);
      assert.ok(Math.abs(a.now - start - a.profile.interval) < 0.025);
      assert.equal(a.intent.jet, undefined, 'no Noita gunner flight');
    }
  });
  check('LOS gates damage; last-known hunt never updates to unseen live position; memory expires', () => {
    const a = actors[3].agent;
    world.visible = false; const known = { ...a.lastSeen };
    player.pos.set(6, 0, -30); step(a);
    assert.equal(a.lastGoal, 'Hunt'); assert.ok(!fire(a)); assert.deepEqual(a.lastSeen, known);
    assert.equal(a.aimState, null);
    step(a, a.profile.memory + 0.1); assert.equal(a.knows, false); assert.equal(a.lastGoal, 'Wander');
    world.visible = true; player.pos.set(0, 0, -20); step(a);
    assert.equal(a.sees, true); assert.ok(!fire(a), 'reacquisition resets windup');
  });
  check('new guards cannot see behind, beyond source sight, or through nearby walls; damage alerts', () => {
    const a = actors[10].agent;
    player.pos.set(0, 0, 20); step(a); assert.equal(a.knows, false);
    a.alert('player'); step(a); assert.equal(a.sees, true, 'alert permits turning to threat');
    player.pos.set(0, 0, -a.profile.sight - 1); step(a); assert.equal(a.sees, false);
    player.pos.set(0, 0, -1); world.visible = false; step(a);
    assert.equal(a.sees, false); assert.ok(!fire(a));
    world.visible = true; player.pos.set(0, 0, -20);
  });
  check('civilian objectives stay unarmed; stupid Nerd waits, ordinary civilian flees when hurt', () => {
    const nerd = actors[0].agent, civilian = actors[1].agent;
    step(nerd); nerd.alert('player'); step(nerd);
    assert.equal(nerd.lastGoal, 'Wait'); assert.equal(nerd.intent.share, 0);
    step(civilian); assert.equal(civilian.lastGoal, 'Wait');
    civilian.alert('player'); step(civilian);
    assert.equal(civilian.lastGoal, 'Flee'); assert.ok(civilian.intent.share > 0);
    assert.ok(civilian.seek.target.z > civilian.feet.z, 'away from the player');
    assert.equal(civilian.intent.tool, null); assert.ok(!fire(civilian));
  });
  check('effective source HP scales actual NPC body hits: Nerd one pistol hit, Grunt two, Elite five', () => {
    for (const [index, hits] of [[0, 1], [3, 2], [4, 5]]) {
      const n = actors[index];
      const t = bodyTarget(n.id, n.body, { alive: () => true, damageScale: n.agent.profile.damageScale, knockback: 0, knockUp: 0 });
      for (let shot = 0; shot < hits; shot++) {
        if (shot) assert.ok(n.body.health > 0);
        t.hurt(0.5, 'gun', null);
      }
      assert.ok(n.body.health < 1e-8);
    }
  });
  check('authored scalar overrides and exact resource precedence; no mutation of manifest', () => {
    const spec = actor('E_Elite', { health: 70, reaction_time: 3, ai_distance: 25, move_speed: 0, no_patrol: true, burst: false });
    spec.name = 'E_Grunt'; spec.weapons = ['GUN']; spec.sourceYaw = Math.PI;
    const before = JSON.stringify(spec), p = crueltyProfile(spec, { cellMeters: 0.5 });
    assert.equal(p.role, 'elite'); assert.deepEqual(p.weapons, ['SMG']);
    assert.equal(p.health, 70); assert.equal(p.reaction, 0.7); assert.equal(p.sight, 50);
    assert.equal(p.speed, 0); assert.equal(p.burst, 0); assert.equal(p.patrol, false);
    assert.equal(p.yaw, Math.PI); assert.equal(JSON.stringify(spec), before);
  });
  check('all appearance variants fit the real neutral body bounds and retain articulated joints', () => {
    const signatures = new Set();
    for (const n of actors) {
      const rig = buildCruelty({ outfit: n.agent.profile.outfit });
      rig.body.position.y = rig.hipY; rig.body.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(rig.body);
      assert.ok(b.min.y >= -1e-6); assert.ok(b.max.y <= BODY_HEIGHT + 1e-6);
      assert.ok(b.min.x >= -BODY_WIDTH / 2 && b.max.x <= BODY_WIDTH / 2);
      assert.ok(b.min.z >= -BODY_WIDTH / 2 && b.max.z <= BODY_WIDTH / 2);
      assert.equal(rig.elR.parent, rig.shR); assert.equal(rig.handY, -0.9);
      const colors = []; rig.body.traverse(o => { if (o.isMesh) colors.push(o.userData.albedo.join()); });
      signatures.add(colors.join('|'));
      rig.body.traverse(o => o.geometry?.dispose());
    }
    assert.ok(signatures.size >= 7, 'not a uniform army of recolored generic bots');
  });
  check('actual sandbox gunner/axeman retain their old minds, wizard figures, default reaction/memory/touch', () => {
    for (const style of ['axeman', 'gunner']) {
      const n = createNpc({ env: { getSim: () => null }, ai, style });
      assert.ok(n.agent instanceof (style === 'gunner' ? GunnerAgent : Agent));
      assert.ok(!(n.agent instanceof CrueltyAgent)); assert.equal(n.agent.reactionTime, REACTION_S);
      assert.equal(n.agent.memorySpan, 12); assert.equal(n.agent.touchRange, 4);
      assert.equal(n.agent.npc.combatProfile, null); assert.equal(n.root.getObjectByName('angular-skull'), undefined);
      n.dispose();
    }
  });
  check('checked-in imported missions use real source resources rather than misleading legacy names', () => {
    const roles = new Set();
    for (const file of ['paradise', 'androgenAssault', 'apartmentAtrocity', 'pharmakokinetiks']) {
      const map = JSON.parse(fs.readFileSync(new URL(`../public/local-maps/${file}.json`, import.meta.url)));
      for (const s of map.mission.guards) roles.add(crueltyProfile(s).role);
    }
    for (const role of ['grunt', 'elite', 'security', 'copRevolver', 'copShotgun', 'assassin', 'knifelord']) assert.ok(roles.has(role), role);
    const paradise = JSON.parse(fs.readFileSync(new URL('../public/local-maps/paradise.json', import.meta.url)));
    for (const s of paradise.mission.targets) {
      const p = crueltyProfile(s, { target: true });
      assert.ok(p.civilian && p.stupid && p.weapons.length === 0, 'authored Nerd defaults survive PackedScene references');
      assert.equal(p.health, 15);
    }
    const androgen = JSON.parse(fs.readFileSync(new URL('../public/local-maps/androgenAssault.json', import.meta.url)));
    const chief = crueltyProfile(androgen.mission.targets.find(s => /Chief/.test(s.sourceResource)), { target: true });
    const narc = crueltyProfile(androgen.mission.targets.find(s => /Cop_Narc/.test(s.sourceResource)), { target: true });
    assert.ok(!chief.civilian && !narc.civilian, 'armed source objectives are not silently made passive');
    assert.equal(chief.health, 300);
    assert.equal(narc.health, 50);
    const apartment = JSON.parse(fs.readFileSync(new URL('../public/local-maps/apartmentAtrocity.json', import.meta.url)));
    const cult = crueltyProfile(apartment.mission.targets[0], { target: true });
    assert.ok(cult.civilian && cult.stupid && cult.weapons.length === 0);
    const pharma = JSON.parse(fs.readFileSync(new URL('../public/local-maps/pharmakokinetiks.json', import.meta.url)));
    const pinky = crueltyProfile(pharma.mission.targets.find(s => /Obj_Pinky/.test(s.sourceResource)), { target: true });
    assert.ok(pinky.civilian && pinky.stupid && pinky.weapons.length === 0);
    assert.equal(pinky.health, 15);
  });
} finally { mission.end(); }
assert.equal(scene.children.length, 0);
console.log(`${checks} Cruelty enemy CPU checks passed (no browser/GPU).`);

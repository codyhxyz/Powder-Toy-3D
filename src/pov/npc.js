import * as THREE from 'three';
import { createPlayer, PX } from './player.js';
import { createFigure } from './figure.js';
import { buildCrasher, CRASHER_COLORS } from './figureCrasher.js';
import { attachModel } from './models.js';
import { addTarget, bodyTarget, spotAround, PLAYER } from './targets.js';
import { povEvents } from './events.js';
import { createKit } from './tools/index.js';
import { gearByKey } from './tools/catalog.js';
import { pack, persistentLoad, ownedKey } from './tools/transfer.js';
import { Agent, wantsMelee } from './ai/brain.js';
import { throwFrag } from './frag.js';
import { GunnerAgent } from './ai/gunner.js';
import { CrueltyAgent } from './ai/cruelty.js';
import { buildCruelty } from './figureCruelty.js';
import { createWorldModel } from './ai/world.js';
import { createNav } from './ai/nav.js';
import { BODY_HEIGHT, RESPAWN_S } from './constants.js';
import { nativeSeconds } from '../v2/host.js';

export { createWorm } from './worm.js';

// An NPC that hunts the player with every tool the player has (the lab world,
// in POV). Three parts, each a solved problem done by the book:
//
// - Body: the player's own (player.js, a second, quiet instance with its own
//   probe), so it runs, jumps, swims, burns, drowns and is blown up by the same
//   rules.
// - Hands: the player's own tools (tools/index.js createKit), run headless with
//   its own pack and bucket, inside povEvents.as(), so what they emit is its own.
// - Mind: ai/brain.js, Buckland's goal-driven agent and fuzzy weapon choice
//   on Yuka, over a CPU copy of the cells (ai/world.js) and an A* height map
//   (ai/nav.js). Each frame the brain fills an intent (move, jump, where to
//   look, which tool and its buttons); this turns it into the body's input and
//   the tool's ctx. Reflexes stay here: jump when blocked, swim up to breathe,
//   dive after a player below, jet out of water at a wall.
//
// It looks like the Castle Crashers wizard in red, the tool in use in its right
// mitten; the player's axe and gun hit it through targets.js.
//
// style 'gunner' is Noita's jetpack Hiisi on the same body: its mind is
// ai/gunner.js (guns only, keeps its range, flies to a vantage on the body's
// jetpack and lands to refuel), and it wears olive. A worm is another creature
// altogether (worm.js, re-exported here so one lazy import brings them all).

// reflexes
const STUCK_SPEED = 0.25;         // share of the wished speed below which it counts as blocked...
const STUCK_S = 0.2;              // ...for this long, then it jumps
const JUMP_COOLDOWN_S = 0.5;
const DIVE_FROM = 3;              // cells: a player this much lower makes it dive in liquid
const SURFACE_BREATH = 0.35;      // breath left (0..1) at which it gives up diving and swims up

// being hit
const HIT_KNOCKBACK = 14;         // cells/s a blow throws it
const DAMAGE_TAKEN = 0.6;         // share of a weapon's damage it takes: four gunshots or five axe blows (two shots felt flimsy)
const KNOCK_UP = 0.4;             // upward share of a knockback

// life
const SPAWN_DIST = 30;            // cells from the player it appears (dropped from above)
const SPAWN_DROP = 18;            // cells above the player's feet
const EDGE = 4;                   // cells: spawns stay this far inside the box walls

// look
const PALETTE = {
  ...CRASHER_COLORS,
  robe: [0.32, 0.02, 0.02], hood: [0.22, 0.015, 0.015], trim: [0.25, 0.25, 0.27], belt: [0.06, 0.05, 0.05],
};
const EYE_GLOW = [4, 0.35, 0.15]; // HDR: red eyes
// the jetpack gunner: olive drab and gunmetal, amber eyes
const GUNNER_PALETTE = {
  ...CRASHER_COLORS,
  robe: [0.09, 0.1, 0.035], hood: [0.06, 0.07, 0.025], trim: [0.12, 0.12, 0.13], belt: [0.05, 0.035, 0.02], brass: [0.3, 0.3, 0.32],
};
const GUNNER_EYE_GLOW = [4, 2.2, 0.2];
const LOOK = { axeman: { palette: PALETTE, eyeGlow: EYE_GLOW }, gunner: { palette: GUNNER_PALETTE, eyeGlow: GUNNER_EYE_GLOW } };
const HELD_SCALE = 1.8;           // the viewmodels (cells, sized for the camera) grown to read in its big mitten
const AIMED_TOOLS = new Set(['GUN', 'SMG', 'SNIPER', 'ROCKET', 'LASER', 'BLOWTORCH', 'PHYSGUN']);
const CHOP_S = 0.25;              // s the chop's follow-through shows after a blow
// the tool's model for each tool the brain uses (models.js, by the catalog)
const MODEL_OF = Object.fromEntries(['SHOVEL', 'BUCKET', 'AXE', 'GUN', 'SMG', 'SNIPER', 'PHYSGUN', 'TROWEL', 'BLOWTORCH', 'BOMB', 'PICKAXE',
  'ROCKET', 'LASER'].map((k) => [k, gearByKey(k).model]));   // (the rocket launcher and laser: a Halo match's power weapons, game/arsenal.js)

const AIM_REACH = 256;            // cells the tools' pick looks along
let nextId = 1;

// The figure, with every tool's model in its right mitten (hidden but the held
// one). The models' meshes take the figure's lighting: each gets its colour as
// an albedo, and createFigure lights it like the body. palette and eyeGlow are
// this NPC's own arrays (copied from its style's LOOK): the meshes hold them, so
// a team's colours (tint) are written into them in place.
function buildWizard(held, hand, palette, eyeGlow, combatProfile = null, variant = 0) {
  return () => {
    const rig = combatProfile ? buildCruelty({ outfit: combatProfile.outfit, variant }) : buildCrasher({ palette, eyeGlow });
    const grip = new THREE.Group();
    grip.position.y = rig.handY;
    grip.scale.setScalar(HELD_SCALE);
    rig.elR.add(grip);
    Object.assign(hand, { grip, shoulder: rig.shR, elbow: rig.elR });
    for (const [key, model] of Object.entries(MODEL_OF)) {
      const m = attachModel(grip, model, null, { arm: false });
      m.obj.position.copy(m.info.grip).negate(); // the handle, not the model's bounding-box centre, sits in the mitten
      m.obj.traverse((o) => {
        if (!o.isMesh || !o.material?.color) return;
        const c = o.material.color;
        o.userData.albedo = [c.r, c.g, c.b];
      });
      m.obj.visible = false;
      held[key] = m.obj;
    }
    return rig;
  };
}

// What every NPC shares: the world model and the walkable map. Call world.update(dt) once a frame.
export function createAi({ renderer, getSim }) {
  const world = createWorldModel({ renderer, getSim });
  return { world, nav: createNav(world) };
}

// One NPC. ai: { world, nav } shared by all of them. env: the toolbelt's env
// (renderer, scene, getSim, getVolume, getScale) plus ballistics (the player's).
// home(): where it appears and comes back (grid cells, feet: its spawner), or
// null for a random spot near the player.
// style: its LOOK and mind ('axeman' | 'gunner'). A team game (src/game) also
// passes: team ('red' | 'blue' | 'infected', on body.team), opponents() (who it
// fights: [{ id, pos, vel, alive, holding }]; without it, the player), respawnS
// (s dead before it comes back, or a function giving it: Siege's differ by side) and name.
export function createNpc({ env, ai, home = () => null, style = 'axeman', team = null, opponents = null, respawnS = RESPAWN_S, oneShot = false, name = null, combatProfile = null, threat = null }) {
  const id = `npc${nextId++}`;
  const body = createPlayer({ renderer: env.renderer, getSim: env.getSim, quiet: true, id });
  body.team = team;
  const held = {}, hand = {};
  const styleLook = LOOK[style] ?? LOOK.axeman;
  const palette = Object.fromEntries(Object.entries(styleLook.palette).map(([k, v]) => [k, [...v]]));
  const eyeGlow = [...styleLook.eyeGlow];
  const variant = [...(name ?? id)].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  const figure = createFigure(buildWizard(held, hand, palette, eyeGlow, combatProfile, variant));
  const viewmodel = new THREE.Group();   // its tools' hands hang here; never drawn (the figure holds the models)
  const kit = createKit({ ...env, viewmodel, owner: id, getMuzzleWorld(key) {
    const model = held[key];
    if (!model?.visible || body.dead || body.gibbed) return null;
    return model.getObjectByName('muzzle')?.getWorldPosition(new THREE.Vector3()) ?? null;
  } });
  let world = null;   // the frame's: { player, holding, toWorld, worldToGrid, scale, stepsPerFrame }
  const charmed = () => !!(body.status?.has('CHARMED') || world?.player?.status?.has('CHARMED'));
  const agent = new (combatProfile ? CrueltyAgent : style === 'gunner' ? GunnerAgent : Agent)({
    body, world: ai.world, nav: ai.nav, kit, getSim: env.getSim, combatProfile, threat,
    packCells: () => pack(id).cells.length,
    bucket: () => { const l = persistentLoad(ownedKey('BUCKET', id), Infinity); return { id: l.cells[0]?.[0] ?? -1, n: l.cells.length }; },
    // Charmed (pheromone, potions.js): a charmed NPC, or a charmed player, isn't hunted: it reads as gone
    target: () => ({ pos: world?.player?.pos ?? body.pos, vel: world?.player?.vel ?? body.vel, alive: !!world?.player && !world.player.dead && !charmed(), holding: world?.holding }),
    opponents,
  });
  if (combatProfile) agent.weapons = new Set(combatProfile.weapons);

  let deadTime = 0, stuckT = 0, jumpWait = 0, spawned = false, yaw = combatProfile?.yaw ?? 0, chopT = 0;
  let carried = style === 'gunner' ? 'SMG' : 'AXE';
  const input = { move: { x: 0, z: 0 }, jump: false, sprint: false, down: false };
  const eye = new THREE.Vector3(), dir = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), look = new THREE.Vector3();
  const vFeet = new THREE.Vector3(), tmp = new THREE.Vector3(), worldEye = new THREE.Vector3();
  const aim = { valid: false, cell: new THREE.Vector3(), face: 0, id: -1, T: 20, P: 0, dist: Infinity };
  const ctx = {
    sim: null, dt: 0, stepsPerFrame: 0, eye, dir, aim, wheel: 0,
    primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, player: body, viewBobbing: false,
  };
  const actor = { id, at: eye };
  const down = new THREE.Vector3(0, -1, 0), localAim = new THREE.Vector3();
  const parentQ = new THREE.Quaternion(), aimQ = new THREE.Quaternion(), aimEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  body.status.actor = actor;   // its statuses' events say whose (status.js)
  // it hurt the player: a breather before its next attack
  const offLanded = povEvents.on('player:hit', (e) => { if (e.by === id) agent.landed(); });
  const hit = {};

  const removeTarget = addTarget(bodyTarget(id, body, {
    alive: () => spawned && !body.dead,
    facing: (out) => out.copy(dir),   // where it looks
    damageScale: combatProfile?.damageScale ?? DAMAGE_TAKEN, knockback: HIT_KNOCKBACK, knockUp: KNOCK_UP,
    onHurt() {
      agent.stagger();   // a hit stops its wind-up
      agent.alert(povEvents.actor?.id ?? PLAYER);   // it knows where its attacker is now
    },
  }));

  // drop in at SPAWN_DIST from the player, on a random bearing, inside the box (or at `at`)
  function spawn(sim, at = home()) {
    const g = sim.g, p = world.player?.pos ?? at ?? body.pos;
    const { x, z } = spotAround(p, SPAWN_DIST, EDGE, g);
    const y = Math.min(p.y + SPAWN_DROP, g.ny - BODY_HEIGHT - 1);
    body.spawn(at ? new THREE.Vector3(at.x, at.y, at.z) : new THREE.Vector3(x, y, z));
    agent.record.timeLastSensed = -Infinity;
    agent.record.visible = false;
    agent.cool = {};
    agent.useState = null;
    agent.velocity.set(0, 0, 0);
    agent.brain.clearSubgoals();
    agent.brain.status = 'inactive';
    deadTime = 0; stuckT = 0;
    spawned = true;
  }

  // the tools' aim: the cell its look ray strikes (the world model's pick)
  function pick() {
    const r = ai.world.raycast(eye, dir, AIM_REACH, undefined, hit);
    aim.valid = r.valid;
    if (r.valid) {
      aim.cell.set(r.cell.x, r.cell.y, r.cell.z);
      aim.face = r.face; aim.id = r.id; aim.dist = r.dist;
      aim.T = ai.world.T(r.cell.x, r.cell.y, r.cell.z);
    } else aim.dist = Infinity;
  }

  // a team's look: { colors: { robe, hood, ... } (linear albedo), eyes (HDR) }
  function tint(look) {
    for (const [k, c] of Object.entries(look.colors ?? {})) palette[k]?.splice(0, 3, ...c);
    if (look.eyes) eyeGlow.splice(0, 3, ...look.eyes);
    figure.root.traverse((o) => {
      if (!o.isMesh) return;
      const u = o.material?.uniforms?.uAlbedo;
      if (u && o.userData.albedo) u.value.set(...o.userData.albedo);
      else if (o.userData.glow && o.material?.color) o.material.color.setRGB(...o.userData.glow);
    });
  }

  return {
    id, kind: style,
    name: name ?? id,
    root: figure.root,
    tint,
    get team() { return body.team; },
    set team(t) { body.team = t; },
    bind(volume, g) { figure.bind(volume, g); },
    compile(r, camera, scene) { return figure.compile(r, camera, scene); },
    get body() { return body; },
    get finished() { return oneShot && body.dead && deadTime >= RESPAWN_S; },
    get agent() { return agent; },
    get kit() { return kit; },
    // The window moved over the world by (dx, 0, dz) cells (docs/scaling.md D11): the body and its
    // tools stay put in the world; its plans and sightings were in the old window's cells.
    windowShifted(dx, dz) {
      body.windowShifted(dx, dz);
      for (const key of kit.keys) kit.tool(key)?.windowShifted?.(dx, dz);
      agent.brain.clearSubgoals();
      for (const entity of [agent.prey, ...agent.foes.values()]) {
        const record = agent.memory.getRecord(entity);
        if (record) { record.timeLastSensed = -Infinity; record.visible = false; }
      }
    },
    // what it's doing (checks): its goal, weapon, tool, pack
    get debug() {
      return {
        style, profile: combatProfile?.role ?? null, sourceHealth: combatProfile?.health ?? null, goal: agent.lastGoal, weapon: agent.weapon, tool: agent.intent.tool, sees: agent.sees, knows: agent.knows, pack: pack(id).cells.length, refusal: kit.lastRefusal?.text ?? null,
        range: agent.mode ?? null, flight: agent.flight ?? null, fuel: body.jetFuel, jetting: body.jetting,
      };
    },
    update(dt, w) {
      world = w;
      const sim = env.getSim();
      if (!sim) return;
      if (!spawned) spawn(sim);
      if (body.dead) {
        deadTime += dt;
        kit.putAway();
        if (!oneShot && deadTime >= (typeof respawnS === 'function' ? respawnS() : respawnS)) spawn(sim);
      }
      const alive = !body.dead;

      // think: the brain on the ground plane (Yuka keeps its own velocity; only the position follows the body)
      agent.position.set(body.pos.x, 0, body.pos.z);
      if (dt > 0 && alive && ai.world.ready) { agent.think(dt); agent.update(dt); } else agent.clearIntent();
      const it = agent.intent;

      // the body: the steered velocity is the wished move
      const sp = Math.hypot(agent.velocity.x, agent.velocity.z);
      const share = alive && sp > 1e-3 ? Math.min(1, it.share) : 0;
      input.move.x = share ? (agent.velocity.x / sp) * share : 0;
      input.move.z = share ? (agent.velocity.z / sp) * share : 0;
      // Source Grunt movement is 4.5m/s, not the sandbox's full sprint.
      if (combatProfile) {
        const speedShare = Math.min(1, combatProfile.speed / (57 * PX));
        input.move.x *= speedShare; input.move.z *= speedShare;
      }
      input.sprint = combatProfile ? true : it.sprint;
      jumpWait = Math.max(0, jumpWait - dt);
      const want = share * agent.maxSpeed, got = Math.hypot(body.vel.x, body.vel.z);
      stuckT = want > 0 && got < want * STUCK_SPEED ? stuckT + dt : 0;
      input.down = false;
      if (body.inLiquid) {
        // reflexes in liquid: dive after its target below while breath lasts; else swim up
        // to breathe, and stopped by a wall (a tank's side) hold jump: the jet lifts it out
        const dive = alive && agent.knows && agent.target.pos.y - body.pos.y < -DIVE_FROM && body.breath > SURFACE_BREATH;
        input.down = dive;
        input.jump = alive && !dive && (body.headInLiquid || stuckT > STUCK_S || it.jump);
      } else {
        input.jump = alive && body.onGround && jumpWait === 0 && (stuckT > STUCK_S || it.jump);
        if (input.jump) { jumpWait = JUMP_COOLDOWN_S; stuckT = 0; }
        if (alive && it.jet && !body.onGround) input.jump = true;   // held in the air: the jetpack (the gunner flies)
      }
      body.update(dt, input);

      // its eye and aim: toward what the brain looks at, else where it's going
      eye.copy(body.pos).setY(body.pos.y + body.eyeHeight);
      if (it.look) dir.set(it.look.x - eye.x, it.look.y - eye.y, it.look.z - eye.z);
      else if (got > 1) dir.set(body.vel.x, 0, body.vel.z);
      if (dir.lengthSq() < 1e-9) dir.set(0, 0, -1);
      dir.normalize();
      yaw = Math.atan2(-dir.x, -dir.z);
      if (combatProfile) { agent.facing.x = dir.x; agent.facing.z = dir.z; }

      // Halo's in a Halo match: a frag from the eye, whatever is in hand (frag.js), and the melee: the
      // body's kick (kick.js), turned to the enemy first (Halo's melee magnetism)
      if (alive && it.frag && body.grenades > 0 && povEvents.as(actor, () => throwFrag(body, eye, dir))) body.grenades--;
      if (alive && wantsMelee(agent)) {
        const c = agent.chest();
        tmp.set(c.x - eye.x, c.y - eye.y, c.z - eye.z).normalize();
        povEvents.as(actor, () => body.kick(tmp));
      }

      // Equipped is persistent; a frame with no attack intent does not holster the weapon (HL2 NPCs).
      carried = it.tool ?? agent.weapon ?? carried;
      if (agent.weapons && !agent.weapons.has(carried)) carried = [...agent.weapons].find((key) => held[key]) ?? null;
      for (const [k, obj] of Object.entries(held)) obj.visible = alive && k === carried;
      if ((it.tool === 'AXE' || it.tool === 'PICKAXE') && it.primaryPressed) chopT = CHOP_S;
      chopT = Math.max(0, chopT - dt);
      w.toWorld(body.pos, vFeet);
      figure.setVisible(spawned && !body.gibbed);
      figure.update(dt, {
        feet: vFeet, scale: w.scale * body.size, yaw, worldToGrid: w.worldToGrid,
        speedH: got / body.size, velY: body.vel.y, onGround: body.onGround, inLiquid: body.inLiquid, headInLiquid: body.headInLiquid,
        dead: body.dead, deadTime, heat: body.feel?.heat ?? 0, jetting: body.jetting, status: body.status,
        chop: chopT > 0 ? 1 : it.chop, kick: body.kickPose,
      });
      if (hand.grip) {
        hand.grip.quaternion.identity();
        if (alive && AIMED_TOOLS.has(carried)) {
          // Source's aim layer overrides the walking arm; the wizard keeps its one-mitten grip.
          hand.shoulder.parent.getWorldQuaternion(parentQ).invert();
          localAim.copy(dir).applyQuaternion(parentQ);
          hand.shoulder.quaternion.setFromUnitVectors(down, localAim);
          hand.elbow.quaternion.identity();
          aimQ.setFromEuler(aimEuler.set(Math.atan2(dir.y, Math.hypot(dir.x, dir.z)), yaw, 0));
          hand.elbow.getWorldQuaternion(parentQ);
          hand.grip.quaternion.copy(parentQ).invert().multiply(aimQ);
        }
      }

      // the hands: the tool the brain wants, with its buttons, as this NPC
      if (alive && it.tool) {
        pick();
        ctx.sim = sim; ctx.dt = dt; ctx.stepsPerFrame = w.stepsPerFrame; ctx.toolRate = body.perks.toolRate;
        // (its tools' clock is the frame's time, as the player's and V1's: tools/action.js toolDt; nativeDt is
        // the game time the frame ran, for what moves with the world: the physgun's hold)
        ctx.nativeDt = sim?.compact ? nativeSeconds(w.stepsPerFrame) : undefined;
        ctx.primary = it.primary; ctx.secondary = it.secondary;
        ctx.primaryPressed = it.primaryPressed; ctx.secondaryPressed = it.secondaryPressed;
        // its tools' hands at its eye, turned along its aim (the physgun's beam leaves from there)
        w.toWorld(eye, worldEye);
        viewmodel.position.copy(worldEye);
        viewmodel.quaternion.setFromUnitVectors(look.set(0, 0, -1), dir);
        viewmodel.updateMatrixWorld(true);
        povEvents.as(actor, () => kit.use(it.tool, ctx));
      } else if (kit.held) kit.putAway();
    },
    setVisible(v) { figure.setVisible(v && spawned && !body.gibbed); },
    reset() { if (oneShot) return; spawned = false; kit.putAway(); figure.setVisible(false); },
    // a fresh NPC at `at` (grid cells): health, memory and cooldowns reset (playtests)
    placeAt(at) { const sim = env.getSim(); if (sim && world) spawn(sim, at); },
    dispose() { offLanded(); removeTarget(); kit.dispose(); figure.dispose(); body.dispose(); },
  };
}

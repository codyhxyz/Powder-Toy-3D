import * as THREE from 'three';
import { createPlayer } from './player.js';
import { createFigure } from './figure.js';
import { buildCrasher, CRASHER_COLORS } from './figureCrasher.js';
import { attachModel } from './models.js';
import { addTarget, PLAYER } from './targets.js';
import { povEvents } from './events.js';
import { createKit } from './tools/index.js';
import { gearByKey } from './tools/catalog.js';
import { pack, persistentLoad, ownedKey } from './tools/transfer.js';
import { Agent } from './ai/brain.js';
import { GunnerAgent } from './ai/gunner.js';
import { createWorldModel } from './ai/world.js';
import { createNav } from './ai/nav.js';
import { BODY_HEIGHT, BODY_WIDTH, EYE_HEIGHT } from './constants.js';

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
const RESPAWN_S = 8;              // s dead before another comes
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
const CHOP_S = 0.25;              // s the chop's follow-through shows after a blow
// the tool's model for each tool the brain uses (models.js, by the catalog)
const MODEL_OF = Object.fromEntries(['SHOVEL', 'BUCKET', 'AXE', 'GUN', 'SMG', 'SNIPER', 'PHYSGUN', 'TROWEL', 'SCANNER', 'BLOWTORCH', 'BOMB', 'PICKAXE'].map((k) => [k, gearByKey(k).model]));

const HW = BODY_WIDTH / 2;
const AIM_REACH = 256;            // cells the tools' pick looks along
let nextId = 1;

// The figure, with every tool's model in its right mitten (hidden but the held
// one). The models' meshes take the figure's lighting: each gets its colour as
// an albedo, and createFigure lights it like the body. palette and eyeGlow are
// this NPC's own arrays (copied from its style's LOOK): the meshes hold them, so
// a team's colours (tint) are written into them in place.
function buildWizard(held, palette, eyeGlow) {
  return () => {
    const rig = buildCrasher({ palette, eyeGlow });
    const grip = new THREE.Group();
    grip.position.y = rig.handY;
    grip.scale.setScalar(HELD_SCALE);
    rig.elR.add(grip);
    for (const [key, model] of Object.entries(MODEL_OF)) {
      const m = attachModel(grip, model, null, { arm: false });
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
// (s dead before it comes back) and name.
export function createNpc({ env, ai, home = () => null, style = 'axeman', team = null, opponents = null, respawnS = RESPAWN_S, name = null }) {
  const id = `npc${nextId++}`;
  const body = createPlayer({ renderer: env.renderer, getSim: env.getSim, quiet: true });
  body.team = team;
  const held = {};
  const styleLook = LOOK[style] ?? LOOK.axeman;
  const palette = Object.fromEntries(Object.entries(styleLook.palette).map(([k, v]) => [k, [...v]]));
  const eyeGlow = [...styleLook.eyeGlow];
  const figure = createFigure(buildWizard(held, palette, eyeGlow));
  const viewmodel = new THREE.Group();   // its tools' hands hang here; never drawn (the figure holds the models)
  const kit = createKit({ ...env, viewmodel, owner: id });
  let world = null;   // the frame's: { player, holding, toWorld, worldToGrid, scale, stepsPerFrame }
  const charmed = () => !!(body.status?.has('CHARMED') || world.player.status?.has('CHARMED'));
  const agent = new (style === 'gunner' ? GunnerAgent : Agent)({
    body, world: ai.world, nav: ai.nav, kit, getSim: env.getSim,
    packCells: () => pack(id).cells.length,
    bucket: () => { const l = persistentLoad(ownedKey('BUCKET', id), Infinity); return { id: l.cells[0]?.[0] ?? -1, n: l.cells.length }; },
    // Charmed (pheromone, potions.js): a charmed NPC, or a charmed player, isn't hunted: it reads as gone
    target: () => ({ pos: world.player.pos, vel: world.player.vel, alive: !world.player.dead && !charmed(), holding: world.holding }),
    opponents,
  });

  let deadTime = 0, stuckT = 0, jumpWait = 0, spawned = false, yaw = 0, chopT = 0;
  const input = { move: { x: 0, z: 0 }, jump: false, sprint: false, down: false };
  const eye = new THREE.Vector3(), dir = new THREE.Vector3(0, 0, -1), look = new THREE.Vector3();
  const vFeet = new THREE.Vector3(), tmp = new THREE.Vector3(), worldEye = new THREE.Vector3();
  const aim = { valid: false, cell: new THREE.Vector3(), face: 0, id: -1, T: 20, P: 0, dist: Infinity };
  const ctx = {
    sim: null, dt: 0, stepsPerFrame: 0, eye, dir, aim, wheel: 0,
    primary: false, secondary: false, primaryPressed: false, secondaryPressed: false, player: body, viewBobbing: false,
  };
  const actor = { id, at: eye };
  body.status.actor = actor;   // its statuses' events say whose (status.js)
  // it hurt the player: a breather before its next attack
  const offLanded = povEvents.on('player:hit', (e) => { if (e.by === id) agent.landed(); });
  const hit = {};

  const removeTarget = addTarget({
    id,
    get alive() { return spawned && !body.dead; },
    box(min, max) {
      min.set(body.pos.x - HW, body.pos.y, body.pos.z - HW);
      max.set(body.pos.x + HW, body.pos.y + BODY_HEIGHT, body.pos.z + HW);
    },
    facing: (out) => out.copy(dir),   // where it looks (the knife's backstab test)
    body,                             // its statuses scale its weapons (targets.js dealtScale)
    hurt(amount, cause, d, opts) {
      body.hurt(amount * DAMAGE_TAKEN, cause, opts);
      agent.stagger();   // a hit stops its wind-up
      body.applyImpulse(tmp.set(d.x, Math.max(d.y, 0) + KNOCK_UP, d.z).normalize().multiplyScalar(HIT_KNOCKBACK));
      agent.alert(povEvents.actor?.id ?? PLAYER);   // it knows where its attacker is now
    },
  });

  // drop in at SPAWN_DIST from the player, on a random bearing, inside the box (or at `at`)
  function spawn(sim, at = home()) {
    const g = sim.g, p = world.player.pos;
    const a = Math.random() * 2 * Math.PI;
    const x = THREE.MathUtils.clamp(p.x + Math.cos(a) * SPAWN_DIST, EDGE, g.nx - EDGE);
    const z = THREE.MathUtils.clamp(p.z + Math.sin(a) * SPAWN_DIST, EDGE, g.nz - EDGE);
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
    get agent() { return agent; },
    get kit() { return kit; },
    // what it's doing (checks): its goal, weapon, tool, pack
    get debug() {
      return {
        style, goal: agent.lastGoal, weapon: agent.weapon, tool: agent.intent.tool, sees: agent.sees, knows: agent.knows, pack: pack(id).cells.length, refusal: kit.lastRefusal?.text ?? null,
        range: agent.mode ?? null, flight: agent.flight ?? null, fuel: body.jetFuel, jetting: body.jetting,
      };
    },
    update(dt, w) {
      world = w;
      const sim = env.getSim();
      if (!sim || dt <= 0) return;
      if (!spawned) spawn(sim);
      if (body.dead) {
        deadTime += dt;
        kit.putAway();
        if (deadTime >= respawnS) spawn(sim);
      }
      const alive = !body.dead;

      // think: the brain on the ground plane (Yuka keeps its own velocity; only the position follows the body)
      agent.position.set(body.pos.x, 0, body.pos.z);
      if (alive && ai.world.ready) { agent.think(dt); agent.update(dt); } else agent.clearIntent();
      const it = agent.intent;

      // the body: the steered velocity is the wished move
      const sp = Math.hypot(agent.velocity.x, agent.velocity.z);
      const share = alive && sp > 1e-3 ? Math.min(1, it.share) : 0;
      input.move.x = share ? (agent.velocity.x / sp) * share : 0;
      input.move.z = share ? (agent.velocity.z / sp) * share : 0;
      input.sprint = it.sprint;
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
      eye.copy(body.pos).setY(body.pos.y + EYE_HEIGHT);
      if (it.look) dir.set(it.look.x - eye.x, it.look.y - eye.y, it.look.z - eye.z);
      else if (got > 1) dir.set(body.vel.x, 0, body.vel.z);
      if (dir.lengthSq() < 1e-9) dir.set(0, 0, -1);
      dir.normalize();
      yaw = Math.atan2(-dir.x, -dir.z);

      // the hands: the tool the brain wants, with its buttons, as this NPC
      if (alive && it.tool) {
        pick();
        ctx.sim = sim; ctx.dt = dt; ctx.stepsPerFrame = w.stepsPerFrame; ctx.toolRate = body.perks.toolRate;
        ctx.primary = it.primary; ctx.secondary = it.secondary;
        ctx.primaryPressed = it.primaryPressed; ctx.secondaryPressed = it.secondaryPressed;
        // its tools' hands at its eye, turned along its aim (the physgun's beam leaves from there)
        w.toWorld(eye, worldEye);
        viewmodel.position.copy(worldEye);
        viewmodel.quaternion.setFromUnitVectors(look.set(0, 0, -1), dir);
        viewmodel.updateMatrixWorld(true);
        povEvents.as(actor, () => kit.use(it.tool, ctx));
        if ((it.tool === 'AXE' || it.tool === 'PICKAXE') && it.primaryPressed) chopT = CHOP_S;
      } else if (kit.held) kit.putAway();

      // the figure
      chopT = Math.max(0, chopT - dt);
      for (const [k, obj] of Object.entries(held)) obj.visible = alive && k === it.tool;
      w.toWorld(body.pos, vFeet);
      figure.setVisible(spawned);
      figure.update(dt, {
        feet: vFeet, scale: w.scale, yaw, worldToGrid: w.worldToGrid,
        speedH: got, velY: body.vel.y, onGround: body.onGround, inLiquid: body.inLiquid, headInLiquid: body.headInLiquid,
        dead: body.dead, deadTime, heat: body.feel?.heat ?? 0, jetting: body.jetting, status: body.status,
        chop: chopT > 0 ? 1 : it.chop,
      });
    },
    setVisible(v) { figure.setVisible(v && spawned); },
    reset() { spawned = false; kit.putAway(); figure.setVisible(false); },
    // a fresh NPC at `at` (grid cells): health, memory and cooldowns reset (playtests)
    placeAt(at) { const sim = env.getSim(); if (sim && world) spawn(sim, at); },
    dispose() { offLanded(); removeTarget(); kit.dispose(); figure.dispose(); body.dispose(); },
  };
}

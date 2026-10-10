import * as THREE from 'three';
import { ELEMENTS, E, K } from '../../elements.js';
import { CELL_M } from '../../scale.js';
import { SEED_MAX } from '../../shaders/common.js';
import { BODY_HEIGHT, BODY_WIDTH } from '../constants.js';
import { povEvents } from '../events.js';
import { addTarget, targetsInBox, PLAYER } from '../targets.js';
import { createWorldModel } from '../ai/world.js';
import { sharedTransfer, Load, cellsNear, ballRadius } from '../tools/transfer.js';
import { loadRapier, createPhysics } from './physics.js';
import { createLook } from './look.js';
import { JEEP, buildJeep } from './jeep.js';
import { HOVERBIKE, buildHoverbike } from './hoverbike.js';
import './vehicles.css';

// Vehicles for first person (docs/vehicles.md): a Warthog-style jeep and a
// drifty hoverbike, rigid bodies in Rapier (physics.js) on a voxel collider
// made from the CPU copy of the cells.
//
// Where they come from: "homes", each keeping one vehicle alive and bringing
// it back RESPAWN_S after it's destroyed. A home is a Jeep pad or Hoverbike pad
// (spawners.js, the palette's Entities) or an entry of spawnLayout(layout) (an
// arena's list). Nothing loads (Rapier, the cells' copy) until a home exists
// in first person.
//
// The shell (pov/index.js) calls, each POV frame:
//   vehicles.beforeBody(player)  // seated: the body sits in the seat
//   player.update(...)
//   vehicles.update(dt, frame)   // the physics, the meshes, run-overs, wrecks
//   vehicles.afterBody(player)   // seated: the body moves with the seat
//   vehicles.chase(camera, dir)  // seated: the third-person chase camera
// and vehicles.use(player) on E (get in, get out, or right an overturned one).

const KINDS = { jeep: { spec: JEEP, build: buildJeep }, hoverbike: { spec: HOVERBIKE, build: buildHoverbike } };
export const VEHICLE_KINDS = Object.keys(KINDS);

const RESPAWN_S = 8;                     // s from a vehicle's destruction to a new one on its home (as the NPCs' 8 s)
const ENTER_REACH = 1.8;                 // m from the body's middle to the hull's box that E reaches
const OVERTURNED_UP = 0.35;              // the hull's up · world up below this: overturned (E rights it, as in Halo)
const RIGHT_LIFT = 1.2;                  // m a righted vehicle is lifted before it's set level
const FALL_OUT = -6;                     // m below the floor: it fell out of the world, destroyed
const SEAT_DROP = 0.35;                  // m from the seat's hips down to where the seated body's feet count
const EXIT_GAP = 0.5;                    // m beside the hull an exiting body is set down
const EXIT_RISE = 4;                     // cells an exit spot may be raised to find room for the body
// running bodies over (Halo's splatter): harmless at a jog, deadly at a sprint
const SPLAT_MIN = 3;                     // m/s the vehicle must close at before it hurts
const SPLAT_KILL = 10;                   // m/s at which it kills outright...
const SPLAT_DAMAGE = 2.2;                // ...this many body-healths (past the player's and the NPCs' damage shares)
const SPLAT_REACH = 1;                   // cells around the hull's box that count as a hit
const SPLAT_COOLDOWN = 0.6;              // s before the same vehicle hurts the same body again
// blasts (povEvents 'blast' / 'explosion'): an impulse with a quadratic falloff, and damage
const BLAST_RADIUS = 7;                  // m out to which a blast shoves vehicles
const BLAST_IMPULSE = 14000;             // N·s at the middle: throws a 3 t jeep 4.7 m/s, flips it if off-centre
const BLAST_MAX_DV = 14;                 // m/s a blast gives a body at most (a light hoverbike isn't fired into orbit)
const BLAST_UP = 0.6;                    // upward share added to the push's direction
const BLAST_DAMAGE = 5;                  // body-healths at the middle: a bomb at the wheel nearly wrecks a jeep
const BLAST_LEVER = 0.6;                 // m off the centre of mass the shove lands (toward the blast): it spins it
// heat (lava, fire, a torch): a vehicle in it burns
const HEAT_DAMAGE = 1;                   // body-healths per second while any part touches a hot cell
// going up: its tank. The bomb's mechanism (tools/bomb.tool.js): gunpowder with a detonator
// at its ignition point, so the engine's burn runs through it as a wave. Then it burns.
const CHARGE = { jeep: 64, hoverbike: 27 };   // cells of gunpowder (4³, 3³): a fuel tank's worth of bang
const CHARGE_SLACK = 2.5;                // candidate cells per charge cell (some are full)
const EJECT_DAMAGE = 0.7;                // body-healths the driver takes when it goes up under them
const WRECK_BURN_S = 14;                 // s the wreck keeps burning...
const WRECK_FIRE_EVERY = 0.35;           // ...a puff of FIRE every this many seconds...
const WRECK_FIRE_CELLS = 5;              // ...this many cells of it...
const WRECK_FIRE_R = 2.5;                // ...in the air within this many cells of its top
const WRECK_KEEP_S = 24;                 // s before the wreck is cleared away
const MS = 3.6;                          // km/h per m/s (the speedometer)
const STATS_EASE = 0.05;                 // share of each frame in the eased update time

const IDLE = { throttle: 0, steer: 0, brake: false, boost: false, parked: true, dead: false };
const DEAD = { ...IDLE, dead: true };
const UP = new THREE.Vector3(0, 1, 0);

let nextId = 1;

// env = { renderer, scene, hud, getSim, getVolume, getScale, getSpawners, requestRender }
export function createVehicles(env) {
  const homes = new Map();               // key → { key, kind, team, at (grid feet), yaw, vehicle, wait }
  const vehicles = [];                   // live vehicles and wrecks
  let layout = [];                       // spawnLayout's entries
  let R = null, phys = null, cells = null, loading = false, failed = false;
  let seated = null;                     // the vehicle the player drives
  const drive = { throttle: 0, steer: 0, brake: false, boost: false, parked: false, dead: false };
  const root = new THREE.Group();
  root.name = 'vehicles';
  env.scene.add(root);
  const hud = createHud();
  let frameInfo = null;

  // ---- grid ↔ metres
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), q = new THREE.Quaternion();
  const posM = (v, out = new THREE.Vector3()) => { const t = v.impl.body.translation(); return out.set(t.x, t.y, t.z); };
  const rotQ = (v, out = q) => { const r = v.impl.body.rotation(); return out.set(r.x, r.y, r.z, r.w); };
  const velM = (v, out = new THREE.Vector3()) => { const l = v.impl.body.linvel(); return out.set(l.x, l.y, l.z); };
  const local = (v, x, y, z, out = new THREE.Vector3()) => out.set(x, y, z).applyQuaternion(rotQ(v)).add(posM(v, tmp2));
  const toGrid = (m, out = new THREE.Vector3()) => out.copy(m).divideScalar(CELL_M);

  // the hull's box in grid cells, axis-aligned around its turned extents
  const corner = new THREE.Vector3();
  function boxGrid(v, min, max, pad = 0) {
    const [hx, hy, hz] = v.spec.HALF;
    min.set(Infinity, Infinity, Infinity); max.set(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < 8; i++) {
      local(v, i & 1 ? hx : -hx, i & 2 ? hy : -hy - v.spec.BELOW, i & 4 ? hz : -hz, corner).divideScalar(CELL_M);
      min.min(corner); max.max(corner);
    }
    min.subScalar(pad); max.addScalar(pad);
  }

  // ---- loading (Rapier and the cells' copy, once)
  function ensure() {
    if (phys || loading || failed) return false;
    loading = true;
    loadRapier().then((rapier) => {
      R = rapier;
      cells = createWorldModel({ renderer: env.renderer, getSim: env.getSim });
      phys = createPhysics(R, cells);
    }).catch((err) => { failed = true; console.error('Vehicles: Rapier failed to load', err); })
      .finally(() => { loading = false; });
    return false;
  }

  // ---- making and losing vehicles
  function spawn(home) {
    const k = KINDS[home.kind];
    const look = createLook();
    const at = home.at.clone().multiplyScalar(CELL_M);
    const id = `vehicle:${nextId++}`;
    const impl = k.build(R, phys, look, { at, yaw: home.yaw, team: home.team, key: id });
    const v = {
      id, kind: home.kind, spec: k.spec, team: home.team, home: home.key,
      impl, look, health: k.spec.HEALTH, alive: true, driver: null, wreckT: 0, fireWait: 0,
      lastHit: new Map(), removeTarget: null,
    };
    v.removeTarget = addTarget({
      id: v.id,
      get team() { return v.team; },
      get alive() { return v.alive; },
      box: (min, max) => boxGrid(v, min, max),
      hurt(amount, cause, d) { damage(v, amount, cause); if (d) push(v, d, amount); },
    });
    root.add(impl.root);
    vehicles.push(v);
    home.vehicle = v;
    return v;
  }
  function remove(v) {
    if (seated === v) seated = null;
    v.removeTarget?.();
    v.impl.dispose();
    v.look.dispose();
    v.impl.root.removeFromParent();
    vehicles.splice(vehicles.indexOf(v), 1);
    for (const h of homes.values()) if (h.vehicle === v) h.vehicle = null;
  }
  const ROUND_SHOVE = 600;               // N·s a round's blow shoves a hull (an 8 g slug at 400 m/s is 3; this is felt, not real)
  function push(v, d, amount) {
    const j = ROUND_SHOVE * amount;
    v.impl.body.applyImpulse({ x: d.x * j, y: d.y * j, z: d.z * j }, true);
  }
  function damage(v, amount, cause) {
    if (!v.alive) return;
    v.health -= amount;
    v.lastCause = cause;
    if (v.health <= 0) explode(v);
  }

  // It goes up: the tank's charge, the engine's blast, a burning wreck.
  function explode(v) {
    v.alive = false;
    v.health = 0;
    v.wreckT = 0;
    v.look.char(1);
    v.impl.driver.visible = false;
    const home = homes.get(v.home);
    if (home && home.vehicle === v) { home.vehicle = null; home.wait = RESPAWN_S; }
    const center = toGrid(posM(v));
    if (seated === v) {
      const player = frameInfo?.player;
      dismount(player);
      player?.hurt(EJECT_DAMAGE, `Killed when the ${v.spec.name.toLowerCase()} blew up`);
    }
    const sim = env.getSim();
    if (sim) {
      const n = CHARGE[v.kind];
      const charge = new Load(n);
      const powder = ELEMENTS[E.GUNPOWDER];
      for (let i = 0; i < n; i++) charge.cells.push([E.GUNPOWDER, i === n - 1 ? powder.ignite : powder.temp, powder.life, Math.random() * SEED_MAX]);
      sharedTransfer(env).put(charge, { cells: cellsNear(center, ballRadius(n * CHARGE_SLACK), sim.g), vel: new THREE.Vector3() });
    }
    povEvents.emit('vehicle:destroyed', { id: v.id, kind: v.kind, team: v.team, point: center.clone(), cause: v.lastCause ?? null });
    // the vehicle's own blast (by: its id): not one the player set off, so it hurts them in full
    povEvents.as({ id: v.id, at: center.clone() }, () => povEvents.emit('blast', { point: center.clone() }));
  }

  // a wreck burns: FIRE cells in the air over it
  function burn(v, dt) {
    v.wreckT += dt;
    if (v.wreckT > WRECK_KEEP_S) { remove(v); return true; }
    if (v.wreckT > WRECK_BURN_S) return false;
    v.fireWait -= dt;
    if (v.fireWait > 0) return false;
    v.fireWait = WRECK_FIRE_EVERY;
    const sim = env.getSim();
    if (!sim) return false;
    const fire = ELEMENTS[E.FIRE];
    const load = new Load(WRECK_FIRE_CELLS);
    for (let i = 0; i < WRECK_FIRE_CELLS; i++) load.cells.push([E.FIRE, fire.temp, fire.life, Math.random() * SEED_MAX]);
    const top = toGrid(local(v, 0, v.spec.HALF[1] + CELL_M, 0));
    sharedTransfer(env).put(load, { cells: cellsNear(top, WRECK_FIRE_R, sim.g), vel: new THREE.Vector3() });
    return false;
  }

  // ---- blasts: every vehicle within reach is shoved, the live ones hurt
  function onBlast({ point }) {
    if (!phys || !point) return;
    const p = tmp.copy(point).multiplyScalar(CELL_M);
    for (const v of [...vehicles]) {
      const c = posM(v);
      const d = c.distanceTo(p);
      if (d > BLAST_RADIUS) continue;
      const f = (1 - d / BLAST_RADIUS) ** 2;
      const dir = c.clone().sub(p);
      if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
      dir.normalize().addScaledVector(UP, BLAST_UP).normalize();
      const body = v.impl.body;
      const j = Math.min(BLAST_IMPULSE * f, body.mass() * BLAST_MAX_DV);
      const at = c.clone().addScaledVector(dir, -BLAST_LEVER);
      body.applyImpulseAtPoint({ x: dir.x * j, y: dir.y * j, z: dir.z * j }, at, true);
      if (v.alive) damage(v, BLAST_DAMAGE * f, 'Blown up');
    }
  }
  const offs = [povEvents.on('blast', onBlast), povEvents.on('explosion', onBlast)];

  // ---- homes: pads and the layout
  function syncHomes() {
    const sim = env.getSim();
    const want = new Map();
    const sp = env.getSpawners?.();
    const g = sim.g;
    const towardMiddle = (at) => Math.atan2(g.nx / 2 - at.x, g.nz / 2 - at.z);   // yaw that faces the box's middle (+z forward)
    if (sp && !g.windowed) {
      for (const kind of VEHICLE_KINDS) for (const s of sp.of(kind)) {
        const at = sp.feet(s);
        if (!at) continue;
        want.set(`pad:${s.id}`, { kind, team: s.team ?? null, at: at.clone(), yaw: towardMiddle(at) });
      }
    }
    layout.forEach((e, i) => want.set(`layout:${i}`, e));
    for (const [key, h] of homes) {
      if (want.has(key)) continue;
      if (h.vehicle && h.vehicle !== seated) remove(h.vehicle);
      homes.delete(key);
    }
    for (const [key, e] of want) {
      const h = homes.get(key);
      if (h) { h.at.copy(e.at); continue; }
      homes.set(key, { key, kind: e.kind, team: e.team, at: e.at.clone(), yaw: e.yaw, vehicle: null, wait: 0 });
    }
  }

  const bmin = new THREE.Vector3(), bmax = new THREE.Vector3(), tmin = new THREE.Vector3(), tmax = new THREE.Vector3(), sweep = new THREE.Vector3();
  // Nothing parked on the pad: a live vehicle there makes it wait; a wreck there is cleared away.
  function padClear(home) {
    const r = KINDS[home.kind].spec.LENGTH / CELL_M / 2;
    for (const v of [...vehicles]) {
      boxGrid(v, bmin, bmax);
      if (!(bmax.x > home.at.x - r && bmin.x < home.at.x + r && bmax.z > home.at.z - r && bmin.z < home.at.z + r && bmin.y < home.at.y + r)) continue;
      if (v.alive) return false;
      remove(v);
    }
    return true;
  }

  // ---- running bodies over
  const hits = [];
  function runOver(v, now, player, dt) {
    const vel = velM(v);
    const speed = vel.length();
    if (speed < SPLAT_MIN) return;
    boxGrid(v, bmin, bmax, SPLAT_REACH);
    // and what it swept through since the last frame (a slow frame mustn't let it pass through a body)
    const back = sweep.copy(vel).multiplyScalar(-dt / CELL_M);
    bmin.min(tmin.copy(bmin).add(back)); bmax.max(tmax.copy(bmax).add(back));
    const driverTeam = v.driver ? (player?.team ?? v.team) : v.team;
    const center = toGrid(posM(v)).add(back);   // where it was: what it's driving into is ahead of that
    for (const t of targetsInBox(bmin, bmax, v.id, hits)) {
      if (String(t.id).startsWith('vehicle:')) continue;            // hulls meet in Rapier
      if (t.id === PLAYER && seated) continue;                      // the driver sits inside it
      if (driverTeam && t.team && t.team === driverTeam) continue;  // no team damage
      if (t.id === PLAYER && player?.team && player.team === driverTeam) continue;
      if (now - (v.lastHit.get(t.id) ?? -Infinity) < SPLAT_COOLDOWN) continue;
      t.box(tmin, tmax);
      const toward = tmp.addVectors(tmin, tmax).multiplyScalar(0.5).sub(center);
      if (toward.dot(vel) <= 0) continue;                            // it's behind the motion
      const amount = THREE.MathUtils.clamp((speed - SPLAT_MIN) / (SPLAT_KILL - SPLAT_MIN), 0, 1) * SPLAT_DAMAGE;
      v.lastHit.set(t.id, now);
      const d = vel.clone().normalize();
      t.hurt(amount, `Run over by a ${v.spec.name.toLowerCase()}`, d);
      povEvents.emit('vehicle:splat', { id: v.id, target: t.id, speed, point: toward.add(center).clone() });
    }
  }

  // ---- seats
  function seatFeet(v, out) {
    const s = v.spec.SEAT;
    local(v, s[0], s[1] - SEAT_DROP, s[2], out);
    return out.divideScalar(CELL_M);
  }
  function nearest(player) {
    const p = tmp.copy(player.pos).setY(player.pos.y + BODY_HEIGHT / 2);
    let best = null, bd = Infinity;
    for (const v of vehicles) {
      boxGrid(v, bmin, bmax);
      const d = Math.hypot(Math.max(bmin.x - p.x, 0, p.x - bmax.x), Math.max(bmin.y - p.y, 0, p.y - bmax.y), Math.max(bmin.z - p.z, 0, p.z - bmax.z)) * CELL_M;
      if (d < bd) { bd = d; best = v; }
    }
    return best && bd <= ENTER_REACH ? best : null;
  }
  const CAMERA_STOPS = (i) => i !== E.EMPTY && (cells.kind(i) === K.SOLID || cells.kind(i) === K.POWDER);   // the camera sees through liquids
  const upness = (v) => tmp.set(0, 1, 0).applyQuaternion(rotQ(v)).y;

  function mount(v, player) {
    seated = v;
    v.driver = PLAYER;
    v.impl.driver.visible = true;
    player.vel.set(0, 0, 0);
    env.hud?.toast?.(`${v.spec.name}: W/S drive · A/D steer · Space ${v.kind === 'jeep' ? 'handbrake' : 'hop'} · Shift boost · E get out`);
    povEvents.emit('vehicle:enter', { id: v.id, kind: v.kind });
  }
  // Out beside the driver's door, else the other side, behind, in front, on top: the first spot with room for the body.
  function dismount(player) {
    const v = seated;
    if (!v) return;
    seated = null;
    v.driver = null;
    v.impl.driver.visible = false;
    povEvents.emit('vehicle:exit', { id: v.id, kind: v.kind });
    if (!player) return;
    const [hx, hy, hz] = v.spec.HALF;
    const side = Math.sign(v.spec.SEAT[0]) || 1;
    const spots = [[side * (hx + EXIT_GAP), 0, 0], [-side * (hx + EXIT_GAP), 0, 0], [0, 0, -(hz + EXIT_GAP)], [0, 0, hz + EXIT_GAP], [0, hy + EXIT_GAP, 0]];
    const feet = new THREE.Vector3();
    let placed = false;
    for (const [x, y, z] of spots) {
      local(v, x, y - hy, z, feet).divideScalar(CELL_M);
      for (let up = 0; up <= EXIT_RISE && !placed; up++) {
        feet.y = Math.max(feet.y, 0);
        if (roomFor(feet)) { placed = true; break; }
        feet.y += 1;
      }
      if (placed) break;
    }
    if (!placed) local(v, 0, hy + EXIT_GAP, 0, feet).divideScalar(CELL_M);
    player.pos.copy(feet);
    player.vel.copy(velM(v)).divideScalar(CELL_M);   // you keep the vehicle's momentum
  }
  function roomFor(feet) {
    if (!cells?.ready) return true;
    const hw = BODY_WIDTH / 2;
    for (let y = Math.floor(feet.y); y < feet.y + BODY_HEIGHT; y++)
      for (let z = Math.floor(feet.z - hw); z < feet.z + hw; z++)
        for (let x = Math.floor(feet.x - hw); x < feet.x + hw; x++)
          if (cells.blocks(x, y, z)) return false;
    // and not inside another hull
    for (const v of vehicles) {
      boxGrid(v, bmin, bmax);
      if (feet.x + hw > bmin.x && feet.x - hw < bmax.x && feet.z + hw > bmin.z && feet.z - hw < bmax.z && feet.y + BODY_HEIGHT > bmin.y && feet.y < bmax.y) return false;
    }
    return true;
  }
  function rightUp(v) {
    const body = v.impl.body;
    const t = body.translation();
    const f = tmp.set(0, 0, 1).applyQuaternion(rotQ(v));
    const yaw = Math.atan2(f.x, f.z);
    const qq = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    body.setTranslation({ x: t.x, y: t.y + RIGHT_LIFT, z: t.z }, true);
    body.setRotation({ x: qq.x, y: qq.y, z: qq.z, w: qq.w }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  // ---- the frame
  const centers = [];
  const worldPos = new THREE.Vector3();
  const stats = { ms: 0 };                // the update's CPU time, eased (checks)
  function update(dt, f) {
    const t0 = performance.now();
    try { frame(dt, f); } finally { stats.ms += (performance.now() - t0 - stats.ms) * STATS_EASE; }
  }
  function frame(dt, f) {
    frameInfo = f;
    const sim = env.getSim();
    if (!sim) return;
    const g = sim.g;
    if (g.windowed && !vehicles.length) { hud.show(null); return; }   // boxes only for now: a world's window would have to carry them
    if (!phys) {
      if (wanted()) ensure();
      hud.show(null);
      return;
    }
    syncHomes();
    cells.update(dt);
    if (!cells.ready) return;
    for (const h of homes.values()) {
      if (h.vehicle) continue;
      h.wait -= dt;
      if (h.wait <= 0 && padClear(h)) spawn(h);
    }
    centers.length = 0;
    for (const v of vehicles) centers.push(Object.assign(toGrid(posM(v)), { key: v.id, ...v.spec.GROUND }));
    phys.syncTerrain(centers);
    phys.step(dt, (h) => {
      for (const v of vehicles) v.impl.step(h, !v.alive ? DEAD : v === seated ? drive : IDLE, cells);
    });
    const now = performance.now() / 1000;
    let moving = false;
    for (const v of [...vehicles]) {
      if (v.alive && v.impl.state.hot) damage(v, HEAT_DAMAGE * dt, 'Burned');
      if (posM(v).y < FALL_OUT) { if (v.alive) explode(v); remove(v); continue; }
      if (v.alive) runOver(v, now, f.player, dt);
      else if (burn(v, dt)) continue;   // cleared away
      if (velM(v).lengthSq() > 1e-4) moving = true;
    }
    // the meshes, in the scene
    const vol = env.getVolume(), scale = env.getScale();
    for (const v of vehicles) {
      const r = v.impl.root;
      toGrid(posM(v), worldPos).multiplyScalar(scale).add(vol.position);
      r.position.copy(worldPos);
      r.quaternion.copy(rotQ(v));
      r.scale.setScalar(scale / CELL_M);
      v.look.bind(vol, g);
      v.look.update(f.worldToGrid);
      v.impl.pose(dt);
    }
    root.visible = true;
    if (moving || vehicles.length) env.requestRender?.();
    // the HUD: what you drive, or what E would do
    if (seated) hud.show({ seated: seated.spec.name, health: Math.max(0, seated.health / seated.spec.HEALTH), kmh: Math.abs(seated.impl.speed) * MS, boost: seated.impl.state.boost });
    else if (f.live && f.player) {
      const v = nearest(f.player);
      hud.show(v ? { prompt: !v.alive ? null : upness(v) < OVERTURNED_UP ? `Flip the ${v.spec.name.toLowerCase()}` : v.kind === 'jeep' ? 'Drive the jeep' : 'Ride the hoverbike' } : null);
    } else hud.show(null);
  }
  // before Rapier loads: does anything want a vehicle?
  function wanted() {
    const sp = env.getSpawners?.();
    const g = env.getSim()?.g;
    return layout.length > 0 || (!!sp && !g?.windowed && VEHICLE_KINDS.some((k) => sp.of(k).length));
  }

  return {
    root,
    get list() { return vehicles; },
    get seated() { return seated; },
    get ready() { return !!phys && !!cells?.ready; },
    get physics() { return phys; },
    stats,
    get cells() { return cells; },
    drive,
    update,
    // E: get in the nearest vehicle in reach, out of the one you're in, or right an overturned one
    use(player) {
      if (seated) { dismount(player); return 'exit'; }
      if (!player || player.dead) return null;
      const v = nearest(player);
      if (!v || !v.alive) return null;
      if (upness(v) < OVERTURNED_UP) { rightUp(v); return 'flip'; }
      if (v.driver) return null;
      mount(v, player);
      return 'enter';
    },
    dismount,
    // the seated vehicle's heading as the POV camera's yaw (camera.js: yaw 0 looks down −z)
    headingYaw() {
      if (!seated) return 0;
      const f = tmp.set(0, 0, 1).applyQuaternion(rotQ(seated));
      return Math.atan2(-f.x, -f.z);
    },
    beforeBody(player) {
      if (!seated) return;
      seatFeet(seated, player.pos);
      player.vel.set(0, 0, 0);
    },
    afterBody(player) {
      if (!seated) return;
      if (player.dead) { dismount(player); return; }
      seatFeet(seated, player.pos);
      player.vel.copy(velM(seated)).divideScalar(CELL_M);
    },
    // The chase camera: behind the hull along the look, pulled in when a wall is in the way.
    chase(camera, dir) {
      if (!seated) return false;
      const vol = env.getVolume(), scale = env.getScale();
      const c = seated.spec.CHASE;
      const target = posM(seated).addScaledVector(UP, c.lift);
      let dist = c.dist;
      if (cells?.ready) {
        const o = toGrid(target, new THREE.Vector3());
        const back = tmp.copy(dir).negate();
        const hit = cells.raycast(o, back, dist / CELL_M + 1, CAMERA_STOPS, {});
        if (hit.valid) dist = Math.max(1, Math.min(dist, hit.dist * CELL_M - CHASE_WALL_GAP));
      }
      const camM = target.clone().addScaledVector(dir, -dist);
      camera.position.copy(toGrid(camM)).multiplyScalar(scale).add(vol.position);
      camera.lookAt(toGrid(target).multiplyScalar(scale).add(vol.position));
      return true;
    },
    // An arena's vehicles: layout.vehicles = [{ kind: 'jeep'|'hoverbike', team: 'red'|'blue', at: [x, y, z] (grid cells, the ground under it), yaw (rad, 0 faces +z) }].
    // Each is kept alive and comes back RESPAWN_S after it's destroyed. spawnLayout(null) clears them.
    spawnLayout(l) {
      layout = (l?.vehicles ?? []).filter((e) => KINDS[e.kind]).map((e) => ({
        kind: e.kind, team: e.team ?? null, at: new THREE.Vector3(...e.at), yaw: e.yaw ?? 0,
      }));
      // a new layout replaces the old one's vehicles
      for (const [key, h] of homes) if (key.startsWith('layout:')) { if (h.vehicle && h.vehicle !== seated) remove(h.vehicle); homes.delete(key); }
      return layout.length;
    },
    // leaving POV (or a new scene): nobody drives, and the HUD goes
    reset(player) {
      if (seated) dismount(player);
      hud.show(null);
      root.visible = false;   // the god view doesn't step them: hidden, as the NPCs are
    },
    setVisible(v) { root.visible = v; if (!v) hud.show(null); },
    // checks: hurt a vehicle (as a weapon would)
    damage: (v, amount, cause = 'Test') => damage(v, amount, cause),
    dispose() {
      offs.forEach((off) => off());
      for (const v of [...vehicles]) remove(v);
      root.removeFromParent();
      hud.dispose();
    },
  };
}
const CHASE_WALL_GAP = 0.4;              // m the chase camera keeps off a wall behind it

// ---- the HUD: a prompt near a vehicle, the vehicle's health and speed while driving
function createHud() {
  const el = document.createElement('div');
  el.className = 'veh-hud';
  el.innerHTML = '<div class="veh-prompt"><kbd>E</kbd> <span></span></div><div class="veh-panel"><b></b><i><s></s></i><em></em><u><s></s></u></div>';
  document.body.append(el);
  const prompt = el.querySelector('.veh-prompt'), promptText = prompt.querySelector('span');
  const panel = el.querySelector('.veh-panel'), name = panel.querySelector('b'), bar = panel.querySelector('i s'), speed = panel.querySelector('em');
  const boostBar = panel.querySelector('u'), boostFill = boostBar.querySelector('s');
  let last = '';
  return {
    show(s) {
      const key = s ? JSON.stringify(s, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)) : '';
      if (key === last) return;
      last = key;
      el.classList.toggle('on', !!s);
      prompt.classList.toggle('on', !!s?.prompt);
      panel.classList.toggle('on', !!s?.seated);
      if (s?.prompt) promptText.textContent = s.prompt;
      if (s?.seated) {
        name.textContent = s.seated;
        bar.style.width = `${s.health * 100}%`;
        bar.classList.toggle('low', s.health < 0.3);
        speed.textContent = `${Math.round(s.kmh)} km/h`;
        boostBar.style.display = s.boost === undefined ? 'none' : '';
        boostFill.style.width = `${(s.boost ?? 0) * 100}%`;
      }
    },
    dispose() { el.remove(); },
  };
}

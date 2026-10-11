import * as THREE from 'three';
import { rocketFrag, toolPass, ROCKET } from '../shaders/povTools.js';
import { gravityScale, ROUND_GRAVITY } from './ballistics.js';
import { povEvents } from './events.js';
import { areaTargets, dealtScale, PLAYER } from './targets.js';
import { muzzleCell } from './tools/transfer.js';
import { heldMaterial } from './viewmodel.js';
import { wu, points, CAUSE } from './halo.js';

// The frag grenade: Halo 3's M9 (Halopedia, "H3:Frag Grenade"), thrown on G in
// a Halo match (combat.js for the player; ai/brain.js FRAG for the bots, through
// npc.js). It is thrown from the eye along the aim, whatever is in hand, flies
// on the shared projectiles (ballistics.js: real speed, real gravity), bounces
// off what it strikes (cells and bodies) and rolls to a stop, and goes off on
// Halo 3's fuse: half a second after its first bounce, never sooner than 1.3 s
// after the throw. So one thrown at a wall goes off on the rebound, in the air,
// as Halo 2's and 3's do.
//
// Going off is two things:
// - the sim's own blast: the rocket's pass (shaders/povTools.js rocketFrag: a
//   crater, a fireball and the pressure wave the engine carries on), so it
//   breaks what a rocket breaks, throws loose matter and bodies about, and its
//   overpressure hurts every body as any blast does (vitals.js), teammates and
//   the thrower included. The physics stays.
// - Halo's shrapnel: Halo 3's damage to every body in its radius, falling off
//   from the centre (DAMAGE_*), on the hit rules (targets.js areaTargets: no
//   teammates, nobody behind a wall when the bots' world model is loaded), as a
//   blow by the thrower, so the kill is theirs (game/index.js: body:hit and the
//   'blast' event's `by`). Its cause is 'grenade' (halo.js CAUSE).
// Near the centre the two together kill from a full shield; out to about 2 m
// the shrapnel alone pops one (Halo 3: the frag is the shield popper).
//
// Halo 3's dead drop their grenades: a body that dies holding some (body.grenades)
// spills them where it fell, unarmed, and a live body that walks over one picks
// it up, to FRAG_CARRY.
//
// Events: frag { action: 'throw' | 'bounce' | 'pickup', point } (sound);
// blast { point, kind: 'frag' } where it goes off (sound, shake, fireball,
// kill credit); round:move / round:end with kind 'frag' while it flies.
//
//   const frags = createFrags({ scene, getSim, getVolume, getScale, ballistics: () => engine, world: () => model });
//   frags.throw(body, eye, dir)   // true if it left the hand (the caller spends body.grenades)
//   frags.update(dt, stepsPerFrame)
//   throwFrag(body, eye, dir)     // the same, on the shell's engine (npc.js: the bots)

// ---- Halo 3's numbers (Halopedia, "H3:Frag Grenade")
export const FRAG_SPEED = wu(10);             // cells/s: "Projectile speed is 10 wu/s"...
export const FRAG_GRAVITY = 0.9;              // ...share of gravity it falls at: "with 90% gravity"
const FUSE_AFTER_BOUNCE_S = 0.5;              // s: "Detonates 0.5s after first bounce off ground,...
const FUSE_MIN_S = 1.3;                       // ...no sooner than 1.3s after being thrown"
const FUSE_MAX_S = 4;                         // s: one that never touches anything goes off anyway (ours, a safety)
const DAMAGE_INNER = 160;                     // points: "160 out to 0.5 wu,...
const DAMAGE_OUTER = 60;                      // ...down to 60 at 1.75 wu (radius)"
const R_INNER = wu(0.5);                      // cells (≈ 5)
const R_OUTER = wu(1.75);                     // cells (≈ 18): Halopedia's "kill radius" of 4.9 m, near enough
const VS_SPARTAN = 0.5;                       // "x0.5 vs spartan & elite health, x0.5 vs shields"
export const FRAG_CARRY = 2;                  // "Reserve ammo capacity: 2 grenades"

// ---- the bounce (by eye: Halopedia gives no figures; Halo 3's frag skids on a few metres past
// where it lands before its fuse runs out, and rolls to a stop soon after)
const RESTITUTION = 0.3;                      // share of the speed into a face it bounces back out with
const FRICTION = 0.35;                        // share of the speed along the face it keeps per bounce
const REST_SPEED = 4;                         // cells/s: slower than this off a bounce, it lies still
const UP_FACE = 0.5;                          // a face whose normal's y is above this is a floor it can lie on
const BOUNCES_MAX = 12;                       // bounces before it lies still wherever it is
const LIFT = 0.3;                             // cells off the face a bounce leaves from (not inside it)
const STANDOFF = 1;                           // cells off the face the blast is centred (rocket.tool.js STANDOFF)
const KIND = 'frag';

// ---- the dropped grenades (Halo 3's dead drop theirs)
const DROP_LIFT = 2;                          // cells above the feet they spill from
const DROP_SPEED = 6;                         // cells/s they're tossed out at, every way
const PICKUP_R = 3;                           // cells from the body's middle a grenade is picked up within
const PICKUP_LIFE_S = 30;                     // s a dropped one lies there (by eye: Halo 3 clears dropped gear after a while)

// ---- drawn (RS2-style low poly, as models.js): an olive body with a steel fuse cap
const DRAWN_SIZE = 0.6;                       // cells across: twice a real M9's 9.4 cm, so it reads at range
const BODY_COLOR = '#4d5a2e';
const CAP_COLOR = '#8a8d90';
const CAP = [0.35, 0.3];                      // cap radius and height, as shares of DRAWN_SIZE
const SPIN = 0.35;                            // rad it turns per frame it's drawn flying

let current = null;
// throw a frag from `eye` along `dir` on the shell's engine (the bots: npc.js); false if it can't
export const throwFrag = (body, eye, dir) => current?.throw(body, eye, dir) ?? false;

export function createFrags({ scene, getSim, getVolume, getScale, ballistics, world = () => null }) {
  const pass = toolPass(rocketFrag, () => ({ uCenter: { value: new THREE.Vector3() }, uFrame: { value: 0 } }));
  const group = new THREE.Group();
  group.name = 'pov-frags';
  scene.add(group);
  const bodyGeo = new THREE.IcosahedronGeometry(DRAWN_SIZE / 2, 0).scale(1, 1.2, 1);
  const capGeo = new THREE.CylinderGeometry(DRAWN_SIZE * CAP[0], DRAWN_SIZE * CAP[0], DRAWN_SIZE * CAP[1], 6).translate(0, DRAWN_SIZE * 0.6, 0);
  const bodyMat = heldMaterial(BODY_COLOR), capMat = heldMaterial(CAP_COLOR);
  const toWorld = (g, out) => out.copy(g).multiplyScalar(getScale()).add(getVolume().position);

  const live = new Set();       // every grenade: in flight, lying armed, or dropped
  const byRound = new Map();    // ballistics round id → its grenade
  const bodies = new Map();     // id → body of the match (game:spawn), for drops and pickups
  const wasDead = new Map();
  let frame = 0, lastBlast = null, thrown = 0;

  function mesh() {
    const m = new THREE.Group();
    m.add(new THREE.Mesh(bodyGeo, bodyMat), new THREE.Mesh(capGeo, capMat));
    group.add(m);
    return m;
  }
  function place(g) {
    g.mesh.scale.setScalar(getScale());
    toWorld(g.pos, g.mesh.position);
    globalThis.__app?.requestRender?.();
  }
  function remove(g) {
    live.delete(g);
    if (g.round) { byRound.delete(g.round); const id = g.round; g.round = 0; ballistics()?.cancel?.(id); }
    g.mesh.removeFromParent();
  }

  // one hop: from `from` at velocity `vel` (cells/s); it lies still if it's too slow or no round is free
  function fly(g, from, vel) {
    const sim = getSim(), engine = ballistics();
    const speed = vel.length();
    if (!sim || !engine || speed < REST_SPEED) return false;
    const gs = gravityScale(sim) * FRAG_GRAVITY;
    const id = povEvents.as(g.actor, () => engine.fire(from, vel.clone().divideScalar(speed), gs, {
      speed, kind: KIND, bodies: true, onStrike: (s) => bounce(g, id, s),
    }));
    if (!id) return false;
    g.round = id; g.resting = false;
    g.v0.copy(vel); g.gy = -ROUND_GRAVITY * gs;
    byRound.set(id, g);
    return true;
  }
  function rest(g, point, normal) {
    g.resting = true;
    g.face.copy(point); g.normal.copy(normal);
    g.pos.copy(point).addScaledVector(normal, DRAWN_SIZE / 2);
    g.mesh.rotation.set(0, Math.random() * Math.PI * 2, Math.PI / 2);   // on its side
    place(g);
  }

  // it struck a cell or a body: bounce off, or lie still
  const v = new THREE.Vector3(), n = new THREE.Vector3(), out = new THREE.Vector3(), from = new THREE.Vector3();
  function bounce(g, round, { hit, dir, normal }) {
    if (g.round !== round) return;
    byRound.delete(round);
    g.round = 0;   // its round:end is a landing, not a loss
    // the speed it arrives with: its launch plus gravity over the flight (a body's strike has no flight time: the launch speed)
    if (hit.t != null) v.copy(g.v0).setY(g.v0.y + g.gy * hit.t);
    else v.copy(dir).multiplyScalar(g.v0.length());
    n.copy(normal);
    g.pos.copy(hit.point);
    g.bounces++;
    if (g.bounced == null) g.bounced = g.t;
    povEvents.as(g.actor, () => povEvents.emit('frag', { action: 'bounce', point: hit.point.clone(), speed: v.length() }));
    const vn = v.dot(n);
    out.copy(v).addScaledVector(n, -vn).multiplyScalar(FRICTION).addScaledVector(n, -vn * RESTITUTION);
    from.copy(hit.point).addScaledVector(n, LIFT);
    const floor = n.y > UP_FACE;
    if (g.bounces < BOUNCES_MAX && fly(g, from, out)) return;
    // too slow to hop on: on a floor it lies there; off a wall or a ceiling it drops
    if (floor || g.bounces >= BOUNCES_MAX || !fly(g, from, out.set(0, -REST_SPEED, 0))) rest(g, hit.point, floor ? n : out.set(0, 1, 0));
  }

  function spawn(body, eye, dir, { armed = true, speed = FRAG_SPEED, carry = null } = {}) {
    const sim = getSim();
    if (!sim || !ballistics()) return null;
    const d = dir.clone().normalize();
    const m = muzzleCell(eye, d, body.pos, sim.g);
    if (!m) return null;
    const actor = povEvents.actor;
    const g = {
      actor, by: actor?.id ?? null, armed, t: 0, bounced: null, bounces: 0, round: 0, resting: false,
      pos: eye.clone().addScaledVector(d, m.t), v0: new THREE.Vector3(), gy: 0,
      face: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), mesh: mesh(),
    };
    const vel = d.multiplyScalar(speed);
    if (carry) vel.add(carry);
    live.add(g);
    if (!fly(g, g.pos.clone(), vel)) { remove(g); return null; }
    place(g);
    return g;
  }

  // ---- going off: the sim's blast, then Halo's shrapnel, both the thrower's
  const lo = new THREE.Vector3(), hi = new THREE.Vector3(), mid = new THREE.Vector3();
  function detonate(g) {
    const sim = getSim();
    const center = g.resting ? g.face.clone().addScaledVector(g.normal, STANDOFF) : g.pos.clone();
    remove(g);
    if (!sim) return;
    const mat = pass(sim);
    mat.uniforms.uCenter.value.copy(center);
    mat.uniforms.uFrame.value = ++frame;
    const r = ROCKET.PULSE_RADIUS;
    sim.touchCentres([center.x - r, center.y - r, center.z - r], [center.x + r, center.y + r, center.z + r]);
    sim.pass(mat);
    const hurt = [];
    povEvents.as(g.actor, () => {
      povEvents.emit('blast', { point: center.clone(), kind: KIND });
      const w = world();
      for (const { target, distance } of areaTargets(center, R_OUTER, g.by ?? PLAYER)) {
        target.box(lo, hi);
        mid.addVectors(lo, hi).multiplyScalar(0.5);
        if (w?.ready && !w.sees(center, mid)) continue;   // behind a wall
        const k = THREE.MathUtils.clamp((distance - R_INNER) / (R_OUTER - R_INNER), 0, 1);
        const dmg = THREE.MathUtils.lerp(DAMAGE_INNER, DAMAGE_OUTER, k) * VS_SPARTAN;
        // no knockback of its own: the blast's pressure throws the body
        target.hurt(points(dmg) * dealtScale(g.by), CAUSE.GRENADE, null, { exact: true });
        hurt.push({ id: target.id, points: +dmg.toFixed(1) });
      }
    });
    lastBlast = { point: center.clone(), by: g.by, hurt, t: +g.t.toFixed(2), bounced: g.bounced };
  }

  // ---- Halo 3's dropped grenades
  function drop(body, count) {
    for (let i = 0; i < count; i++) {
      const eye = body.pos.clone().setY(body.pos.y + DROP_LIFT);
      const dir = new THREE.Vector3().randomDirection().setY(Math.abs(Math.random()) + 0.5);
      povEvents.as(null, () => spawn(body, eye, dir, { armed: false, speed: DROP_SPEED }));
    }
  }
  const offs = [
    povEvents.on('round:move', ({ id, kind, to }) => {
      if (kind !== KIND) return;
      const g = byRound.get(id);
      if (!g) return;
      g.pos.copy(to);
      g.mesh.rotation.x += SPIN;
      place(g);
    }),
    // gone out of the box (a landing clears g.round first): lost
    povEvents.on('round:end', ({ id, kind }) => {
      if (kind !== KIND) return;
      const g = byRound.get(id);
      byRound.delete(id);
      if (g && g.round === id) { g.round = 0; remove(g); }
    }),
    povEvents.on('game:spawn', ({ id, body }) => { bodies.set(id, body); wasDead.set(id, false); }),
    povEvents.on('game:stop', () => {
      bodies.clear(); wasDead.clear();
      for (const g of [...live]) if (!g.armed) remove(g);   // the match's dropped grenades go with it
    }),
  ];

  const self = {
    // throw one from `eye` along `dir` (grid cells, unit), as povEvents.actor; true if it left the hand
    throw(body, eye, dir) {
      const g = spawn(body, eye, dir, { carry: body.vel ?? null });
      if (!g) return false;
      thrown++;
      povEvents.emit('frag', { action: 'throw', point: g.pos.clone() });
      return true;
    },
    // every frame; stepsPerFrame 0 (paused): the fuses wait, as the grenades in the air do
    update(dt, stepsPerFrame = 1) {
      if (!(dt > 0) || stepsPerFrame === 0) return;
      for (const g of [...live]) {
        g.t += dt;
        if (g.armed) {
          const fuse = g.bounced == null ? FUSE_MAX_S : Math.max(FUSE_MIN_S, g.bounced + FUSE_AFTER_BOUNCE_S);
          if (g.t >= fuse) detonate(g);
        } else if (g.t >= PICKUP_LIFE_S) remove(g);
      }
      // the dead spill theirs; the living pick them up
      for (const [id, b] of bodies) {
        if (b.dead && !wasDead.get(id) && b.grenades > 0) { drop(b, b.grenades); b.grenades = 0; }
        wasDead.set(id, !!b.dead);
        if (b.dead || b.grenades == null || b.grenades >= FRAG_CARRY) continue;
        mid.copy(b.pos).setY(b.pos.y + DROP_LIFT);
        for (const g of live) {
          if (g.armed || g.pos.distanceTo(mid) > PICKUP_R || b.grenades >= FRAG_CARRY) continue;
          b.grenades++;
          remove(g);
          povEvents.emit('frag', { action: 'pickup', point: g.pos.clone(), by: id === PLAYER ? undefined : id });
        }
      }
    },
    // the window moved over the world (docs/scaling.md D11): what lies still moves back with it
    windowShifted(dx, dz) {
      for (const g of live) {
        if (g.round) continue;   // (in flight: ballistics.js shifts the round)
        g.pos.x -= dx; g.pos.z -= dz; g.face.x -= dx; g.face.z -= dz;
        place(g);
      }
    },
    clear() { for (const g of [...live]) remove(g); },
    get count() { return live.size; },
    get armed() { return [...live].filter((g) => g.armed).length; },
    get thrown() { return thrown; },
    get lastBlast() { return lastBlast; },   // for checks: { point, by, hurt: [{ id, points }], t, bounced }
    get list() { return [...live].map((g) => ({ armed: g.armed, resting: g.resting, t: +g.t.toFixed(2), bounces: g.bounces, pos: g.pos.toArray().map((x) => +x.toFixed(1)) })); },
    dispose() {
      offs.forEach((off) => off());
      self.clear();
      group.removeFromParent();
      bodyGeo.dispose(); capGeo.dispose(); bodyMat.dispose(); capMat.dispose();
      pass.dispose();
      if (current === self) current = null;
    },
  };
  current = self;
  return self;
}

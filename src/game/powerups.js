import * as THREE from 'three';
import { BODY_HEIGHT } from '../pov/constants.js';

// Halo's power-ups on the map's shrines. During a Halo match each shrine's
// Noita perks (perkOrbs.js) are put away and an Overshield floats over its
// middle altar instead; the match's end puts the perks back. A body (the
// player's or a bot's) takes one by walking into it, Halo's way (power-ups are
// run over, not used), and it comes back RESPAWN_S later.
//
// The Overshield (Halopedia, "Overshield"): Halo 3's gives 200% of the shield,
// one green layer over the bar (Combat Evolved's and Reach's give 300%). It
// charges for about 3 s, the body untouchable meanwhile but by a melee to the
// back (every Halo from Combat Evolved to Halo 4), then the extra "gradually
// depletes over prolonged duration". vitals.js runs it (body.overshield()).

export const OVERSHIELD = {
  layers: 2,          // × the shield (Halo 3's 200%)
  chargeS: 3,         // s it charges, the body untouchable but by a backstab (Halopedia)
  drainS: 60,         // s the extra layer takes to drain away (Halopedia gives no rate: ours, a minute)
};
const RESPAWN_S = 120;            // s before a taken power-up comes back (Halopedia, "MLG": "All Powerups spawn after 120 seconds")
const PICKUP_R = 2.4;             // cells (horizontal) from a body's centre to the orb's that touch it
const PICKUP_UP = BODY_HEIGHT;    // cells: the orb within this height of the body's feet
const ORB_LIFT = BODY_HEIGHT * 0.55;   // cells from the floor to the orb's centre: chest height
const ORB_R = 1.1;                // cells, the orb's radius
const CORE_R = 0.55;              // cells, its bright core
const RING_R = [1.3, 1.7];        // cells, the floor ring's inner and outer radius
const PAD_LIFT = 0.05;            // cells above the floor (no z-fighting)
const BOB = 0.3;                  // cells the orb bobs...
const BOB_HZ = 0.4;               // ...this many times a second
const SPIN_HZ = 0.25;             // turns a second
const GLOW = '#5dff8a';           // Halo 3's green layer
const ORB_OPACITY = 0.38;
const CORE_OPACITY = 0.85;
const RING_OPACITY = 0.7;
const RING_WAITING = 0.18;        // the ring's opacity while the power-up is away

const basic = (opacity, extra = {}) => new THREE.MeshBasicMaterial({ color: GLOW, transparent: true, opacity, depthWrite: false, ...extra });

function orbModel() {
  const g = new THREE.Group();
  g.name = 'overshield';
  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(ORB_R, 2), basic(ORB_OPACITY, { blending: THREE.AdditiveBlending, wireframe: false }));
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(ORB_R * 1.02, 1), basic(ORB_OPACITY, { wireframe: true }));
  const core = new THREE.Mesh(new THREE.SphereGeometry(CORE_R, 16, 12), basic(CORE_OPACITY, { blending: THREE.AdditiveBlending }));
  const ball = new THREE.Group();
  ball.add(orb, shell, core);
  ball.position.y = ORB_LIFT;
  const ring = new THREE.Mesh(new THREE.RingGeometry(...RING_R, 40).rotateX(-Math.PI / 2).translate(0, PAD_LIFT, 0), basic(RING_OPACITY, { side: THREE.DoubleSide }));
  for (const m of [orb, shell, core, ring]) m.renderOrder = 1;   // after the volume, tested against its depth
  g.add(ball, ring);
  g.userData = { ball, ring };
  return g;
}

// app: getPerkOrbs(), getVolume(), getScale(); scene: where the orbs go
export function createPowerups({ app, scene }) {
  const root = new THREE.Group();
  root.name = 'halo-powerups';
  scene.add(root);
  let pads = [];     // { kind, feet (grid cells), obj, readyAt (game s) }
  let parked = [];   // the shrines' Noita orbs while a match runs: { key, feet, shrine }
  const v = new THREE.Vector3();

  // the match starts: the shrines' perks go away, a power-up over each middle altar
  function begin(t = 0) {
    end();
    const orbs = app.getPerkOrbs?.();
    if (!orbs) return;
    const shrines = new Map();
    for (const o of orbs.list) if (o.shrine) (shrines.get(o.shrine) ?? shrines.set(o.shrine, []).get(o.shrine)).push(o);
    for (const [shrine, list] of shrines) {
      const at = list.map((o) => ({ o, feet: orbs.feet(o, new THREE.Vector3()) })).filter((x) => x.feet);
      for (const x of at) parked.push({ key: x.o.key, feet: x.feet, shrine });
      list.forEach((o) => orbs.remove(o));
      if (!at.length) continue;
      const mid = at[Math.floor(at.length / 2)].feet;
      const obj = orbModel();
      root.add(obj);
      pads.push({ kind: 'overshield', feet: mid.clone(), obj, readyAt: t });
    }
  }

  // the match is over: the power-ups go, the perks come back (unless the scene was replaced
  // meanwhile and its shrines have new ones)
  function end() {
    for (const p of pads) { p.obj.removeFromParent(); p.obj.traverse((m) => { m.geometry?.dispose(); m.material?.dispose(); }); }
    pads = [];
    const orbs = app.getPerkOrbs?.();
    if (orbs && parked.length && !orbs.list.some((o) => o.shrine)) for (const p of parked) orbs.add(p.key, p.feet, p.shrine);
    parked = [];
  }

  // every frame of a Halo match: pickups (bodies: [{ id, body }] of the living), then the orbs' look
  function update(t, bodies) {
    const picked = [];
    for (const p of pads) {
      if (t < p.readyAt) continue;
      for (const { id, body } of bodies) {
        const dx = body.pos.x - p.feet.x, dz = body.pos.z - p.feet.z, dy = p.feet.y + ORB_LIFT - body.pos.y;
        if (dx * dx + dz * dz > PICKUP_R * PICKUP_R || dy < 0 || dy > PICKUP_UP) continue;
        if (!body.overshield?.(OVERSHIELD)) continue;
        p.readyAt = t + RESPAWN_S;
        picked.push({ id, kind: p.kind, point: p.feet.clone().setY(p.feet.y + ORB_LIFT) });
        break;
      }
    }
    const vol = app.getVolume?.(), scale = app.getScale?.() ?? 1;
    if (vol) {
      for (const p of pads) {
        const ready = t >= p.readyAt;
        const { ball, ring } = p.obj.userData;
        p.obj.position.copy(v.copy(p.feet).multiplyScalar(scale).add(vol.position));
        p.obj.scale.setScalar(scale);
        ball.visible = ready;
        ball.position.y = ORB_LIFT + BOB * Math.sin(t * BOB_HZ * Math.PI * 2);
        ball.rotation.y = t * SPIN_HZ * Math.PI * 2;
        ring.material.opacity = ready ? RING_OPACITY : RING_WAITING;
      }
    }
    return picked;
  }

  return {
    begin, end, update,
    setVisible(on) { root.visible = on; },
    get pads() { return pads.map((p) => ({ kind: p.kind, feet: p.feet.clone(), readyAt: p.readyAt })); },   // checks
  };
}

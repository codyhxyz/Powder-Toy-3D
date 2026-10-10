import * as THREE from 'three';
import { BODY_HEIGHT, BODY_WIDTH } from './pov/constants.js';

// Spawners: markers the god view sets on surfaces (the palette's Entities group).
//
//   enemy   in first person, keeps one NPC (pov/npc.js) alive here: it appears
//           here, and comes back here a few seconds after it dies (an axeman)
//   gunner  the same, a jetpack gunner (npc.js, style 'gunner'): Noita's jetpack Hiisi
//   worm    the same, a worm (pov/worm.js) that comes up here and burrows in
//   giantworm  the same, the giant worm (worm.js size 'giant')
//   player  where V drops you in (the one nearest the cursor) and where you respawn
//   jeep, hoverbike
//           in first person, keeps one vehicle (pov/vehicles/) parked here: it
//           comes back here a few seconds after it's destroyed
//   birds   keeps a flock of birds (birds/) homed here, in the god view and first person
//
// None is placed in any world by default; the lab's own axeman is the only one a scene brings.
//
// Clicking a surface with a spawner tool sets one; clicking at an existing one
// of that kind takes it away. A spawner stands on a world cell, like a sign, so
// in a world bigger than the grid it stays put while the window moves.
//
// Each shows as a glowing pad with a ghost of a body standing on it (the birds'
// has no ghost: its flock is on show); in first person the ghost hides and the pad stays.

export const SPAWNER = { ENEMY: 'enemy', GUNNER: 'gunner', WORM: 'worm', GIANT_WORM: 'giantworm', PLAYER: 'player', JEEP: 'jeep', HOVERBIKE: 'hoverbike', BIRDS: 'birds' };
// the kinds that keep a creature alive (pov/index.js); old spawners are 'enemy': axemen
export const ENEMY_KINDS = [SPAWNER.ENEMY, SPAWNER.GUNNER, SPAWNER.WORM, SPAWNER.GIANT_WORM];
const COLOR = { enemy: 0xe0453a, gunner: 0xe08a2a, worm: 0xb0607a, giantworm: 0x7a3550, player: 0x3fa7ff, jeep: 0x8fa04a, hoverbike: 0x5fd0e0, birds: 0xb58cff };
// A vehicle pad's ghost: the vehicle's footprint (cells, 0.3 m each: a 4.5 × 2.2 × 1.8 m jeep, a 2.5 × 1 × 1.2 m hoverbike)
const VEHICLE_GHOST = { jeep: [7.3, 6, 15], hoverbike: [3.3, 4, 8.3] };
const VEHICLE_PAD_R = { jeep: 8, hoverbike: 4.5 };   // cells, the pad's radius under it
const GHOSTLESS = new Set([SPAWNER.BIRDS]);   // kinds whose marker is only the pad
const TOGGLE_DIST = 3;        // cells: clicking this near an existing spawner of the kind removes it
const PAD_R = 1.4;            // cells, the pad's radius
const PAD_LIFT = 0.05;        // cells above the surface (no z-fighting)
const GHOST_OPACITY = 0.28;
const PAD_OPACITY = 0.55;
const MAX_PER_KIND = 8;       // NPCs are whole bodies with their own probes; a few is plenty

let nextId = 1;

// The feet a body would have standing on the struck face of a pick (the god view's hover):
// on top of it, or beside it, dropping down.
export function feetOnHit(hit, out = new THREE.Vector3()) {
  const c = hit.cell, axis = Math.floor(hit.face / 2), sign = hit.face % 2 === 0 ? 1 : -1;
  out.set(c.x + 0.5, c.y, c.z + 0.5);
  if (axis === 1) out.y = sign > 0 ? c.y + 1 : c.y - BODY_HEIGHT;
  else out.setComponent(axis, out.getComponent(axis) + sign);
  return out;
}

function marker(kind) {
  const color = COLOR[kind];
  const g = new THREE.Group();
  g.name = `spawner-${kind}`;
  const padR = VEHICLE_PAD_R[kind] ?? PAD_R;
  const pad = new THREE.Mesh(new THREE.CircleGeometry(padR, 32).rotateX(-Math.PI / 2).translate(0, PAD_LIFT, 0),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: PAD_OPACITY, depthWrite: false }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(padR * 0.85, padR, 32).rotateX(-Math.PI / 2).translate(0, PAD_LIFT * 2, 0),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false }));
  const r = BODY_WIDTH / 2;
  const v = VEHICLE_GHOST[kind];
  const ghost = GHOSTLESS.has(kind) ? null : new THREE.Mesh(v ? new THREE.BoxGeometry(...v).translate(0, v[1] / 2, 0) : new THREE.CapsuleGeometry(r, BODY_HEIGHT - 2 * r, 4, 12).translate(0, BODY_HEIGHT / 2, 0),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: GHOST_OPACITY, depthWrite: false }));
  for (const m of [pad, ring, ghost]) if (m) { m.renderOrder = 1; g.add(m); }   // after the volume, tested against its depth
  g.userData.ghost = ghost;
  return g;
}

export class Spawners {
  constructor({ scene, getSim, getVolume, getScale, onChange = () => {} }) {
    this.scene = scene;
    this.getSim = getSim;
    this.getVolume = getVolume;
    this.getScale = getScale;
    this.onChange = onChange;
    this.list = [];             // { id, kind, world: Vector3 (feet, world cells), obj }
    this.root = new THREE.Group();
    this.root.name = 'spawners';
    scene.add(this.root);
    this.ghosts = true;
  }

  // Set a spawner of `kind` with its feet at `feet` (grid cells), or take away
  // the one of that kind already there. Returns 'added', 'removed' or 'full'.
  toggle(kind, feet) {
    const sim = this.getSim();
    const world = feet.clone().add(sim.origin);
    const near = this.list.find((s) => s.kind === kind && s.world.distanceTo(world) < TOGGLE_DIST);
    if (near) { this.remove(near); return 'removed'; }
    if (this.of(kind).length >= MAX_PER_KIND) return 'full';
    this.add(kind, feet);
    return 'added';
  }

  add(kind, feet) {
    const s = { id: nextId++, kind, world: feet.clone().add(this.getSim().origin), obj: marker(kind) };
    this.root.add(s.obj);
    this.list.push(s);
    this.update();
    this.onChange();
    return s;
  }

  remove(s) {
    const i = this.list.indexOf(s);
    if (i < 0) return;
    this.list.splice(i, 1);
    s.obj.removeFromParent();
    s.obj.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.onChange();
  }

  clear() { for (const s of [...this.list]) this.remove(s); }

  of(kind) { return this.list.filter((s) => s.kind === kind); }

  // a spawner's feet in grid cells (the window's), or null while it's outside the window
  feet(s, out = new THREE.Vector3()) {
    const sim = this.getSim();
    out.copy(s.world).sub(sim.origin);
    const g = sim.g;
    return out.x >= 0 && out.z >= 0 && out.x < g.nx && out.z < g.nz ? out : null;
  }

  // the player spawner nearest p (grid cells), or null
  nearestPlayer(p) {
    let best = null, bd = Infinity;
    const f = new THREE.Vector3();
    for (const s of this.of(SPAWNER.PLAYER)) {
      if (!this.feet(s, f)) continue;
      const d = f.distanceTo(p);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  // in first person the ghosts hide (the pads stay)
  setGhosts(v) { this.ghosts = v; for (const s of this.list) if (s.obj.userData.ghost) s.obj.userData.ghost.visible = v; }

  // every frame: markers follow the world's scale, the volume and the window
  update() {
    const sim = this.getSim(), vol = this.getVolume(), scale = this.getScale();
    if (!sim || !vol) return;
    const f = new THREE.Vector3();
    for (const s of this.list) {
      const inside = this.feet(s, f);
      s.obj.visible = !!inside;
      if (!inside) continue;
      s.obj.position.copy(f).multiplyScalar(scale).add(vol.position);
      s.obj.scale.setScalar(scale);
    }
  }
}

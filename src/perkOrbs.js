import * as THREE from 'three';
import { PERK, shrineOffer } from './pov/perks.js';
import { BODY_HEIGHT, BODY_WIDTH } from './pov/constants.js';

// Perk orbs: the palette's Perks group sets them on surfaces, like the
// spawners (spawners.js), as markers, not cells. Each is the perk's icon
// floating at chest height over a glowing pad; a body (the player's, or an
// NPC's) that walks into it gains the perk (pov/index.js, pov/perks.js).
//
// Clicking a surface with a perk sets an orb; clicking at an orb of that perk
// takes it away. A shrine (Noita's Holy Mountain) sets SHRINE_OFFERS random
// ones in a row across the view: taking one takes the others with it. An orb
// stands on a world cell, so in a world bigger than the grid it stays put while
// the window moves.

const ORB_LIFT = BODY_HEIGHT * 0.5;   // cells from the surface to the icon's centre: chest height
const ORB_SIZE = 2.2;                 // cells across the icon sprite
const PAD_R = 1.1;                    // cells, the pad's radius
const PAD_LIFT = 0.05;                // cells above the surface (no z-fighting)
const PAD_OPACITY = 0.5;
const BOB = 0.25;                     // cells the icon bobs up and down...
const BOB_HZ = 0.5;                   // ...this many times a second
const TAKE_REACH = 0.6;               // cells beyond a body's box that still touch an orb's centre
const TOGGLE_DIST = 2;                // cells: clicking this near an orb of the same perk removes it
const SHRINE_SPACING = 4;             // cells between a shrine's orbs (1.2 m)
const MAX_ORBS = 64;                  // a scene's worth
const ICON_PX = 128;                  // the icon texture's size
const ICON_GLOW = 0.5;                // share of the icon's radius the glow fades over
const ICON_BACK = 'rgba(20,16,32,0.85)';   // the dark disc behind the emoji
const ICON_RING = 0.04;               // the disc's rim, as a share of the texture
const ICON_EMOJI = 0.4;               // emoji font size as a share of the texture
const ICON_EMOJI_DROP = 0.03;         // share of the texture the emoji is set down by (emoji glyphs sit high)
const BOB_PHASE_STEP = 0.37;          // bob cycles between orbs placed one after another, so neighbours don't bob in step

let nextId = 1, nextShrine = 1;

// one icon texture per perk, shared by its orbs
const icons = new Map();
function iconTexture(key) {
  if (icons.has(key)) return icons.get(key);
  const p = PERK[key];
  const c = document.createElement('canvas');
  c.width = c.height = ICON_PX;
  const g = c.getContext('2d');
  const r = ICON_PX / 2;
  const glow = g.createRadialGradient(r, r, r * (1 - ICON_GLOW), r, r, r);
  glow.addColorStop(0, p.color);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, ICON_PX, ICON_PX);
  g.beginPath();
  g.arc(r, r, r * (1 - ICON_GLOW), 0, Math.PI * 2);
  g.fillStyle = ICON_BACK;
  g.fill();
  g.lineWidth = ICON_PX * ICON_RING;
  g.strokeStyle = p.color;
  g.stroke();
  g.font = `${Math.round(ICON_PX * ICON_EMOJI)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(p.icon, r, r + ICON_PX * ICON_EMOJI_DROP);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  icons.set(key, t);
  return t;
}

function marker(key) {
  const g = new THREE.Group();
  g.name = `perk-${key}`;
  const color = new THREE.Color(PERK[key].color);
  const pad = new THREE.Mesh(new THREE.CircleGeometry(PAD_R, 32).rotateX(-Math.PI / 2).translate(0, PAD_LIFT, 0),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: PAD_OPACITY, depthWrite: false }));
  const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: iconTexture(key), transparent: true, depthWrite: false }));
  icon.scale.setScalar(ORB_SIZE);
  icon.position.y = ORB_LIFT;
  for (const m of [pad, icon]) { m.renderOrder = 1; g.add(m); }   // after the volume, tested against its depth
  g.userData.icon = icon;
  return g;
}

export class PerkOrbs {
  constructor({ scene, getSim, getVolume, getScale }) {
    this.getSim = getSim;
    this.getVolume = getVolume;
    this.getScale = getScale;
    this.list = [];             // { id, key, shrine (0 = none), world: Vector3 (feet, world cells), obj }
    this.root = new THREE.Group();
    this.root.name = 'perk-orbs';
    scene.add(this.root);
  }

  // Set an orb of `key` with its foot at `feet` (grid cells), or take away the
  // one of that perk already there. Returns 'added', 'removed' or 'full'.
  toggle(key, feet) {
    const world = feet.clone().add(this.getSim().origin);
    const near = this.list.find((o) => o.key === key && o.world.distanceTo(world) < TOGGLE_DIST);
    if (near) { this.remove(near); return 'removed'; }
    if (this.list.length >= MAX_ORBS) return 'full';
    this.add(key, feet);
    return 'added';
  }

  // A shrine centred on `feet` (grid cells), its orbs in a row along `across`
  // (a horizontal unit vector: the view's right). Returns the orbs, or null when full.
  shrine(feet, across, random = Math.random) {
    const keys = shrineOffer(undefined, random);
    if (this.list.length + keys.length > MAX_ORBS) return null;
    const shrine = nextShrine++;
    const mid = (keys.length - 1) / 2;
    return keys.map((k, i) => this.add(k, feet.clone().addScaledVector(across, (i - mid) * SHRINE_SPACING), shrine));
  }

  add(key, feet, shrine = 0) {
    const o = { id: nextId++, key, shrine, world: feet.clone().add(this.getSim().origin), obj: marker(key) };
    this.root.add(o.obj);
    this.list.push(o);
    this.update();
    return o;
  }

  remove(o) {
    const i = this.list.indexOf(o);
    if (i < 0) return;
    this.list.splice(i, 1);
    o.obj.removeFromParent();
    o.obj.traverse((m) => { m.geometry?.dispose(); m.material?.dispose(); });   // the icon textures are shared and kept
  }

  clear() { for (const o of [...this.list]) this.remove(o); }

  // an orb's foot in grid cells (the window's), or null while it's outside the window
  feet(o, out = new THREE.Vector3()) {
    const sim = this.getSim();
    out.copy(o.world).sub(sim.origin);
    const g = sim.g;
    return out.x >= 0 && out.z >= 0 && out.x < g.nx && out.z < g.nz ? out : null;
  }

  // The orb a body standing at `feet` (grid cells) touches, taken away with
  // the rest of its shrine; null if it touches none.
  takeAt(feet) {
    const hw = BODY_WIDTH / 2 + TAKE_REACH;
    const c = new THREE.Vector3();
    for (const o of this.list) {
      if (!this.feet(o, c)) continue;
      c.y += ORB_LIFT;
      if (Math.abs(c.x - feet.x) > hw || Math.abs(c.z - feet.z) > hw) continue;
      if (c.y < feet.y - TAKE_REACH || c.y > feet.y + BODY_HEIGHT + TAKE_REACH) continue;
      for (const s of o.shrine ? this.list.filter((x) => x.shrine === o.shrine) : [o]) this.remove(s);
      return { key: o.key, at: c.clone() };
    }
    return null;
  }

  // every frame: markers follow the world's scale, the volume and the window; the icons bob
  update(time = performance.now() / 1000) {
    const sim = this.getSim(), vol = this.getVolume(), scale = this.getScale();
    if (!sim || !vol) return;
    const f = new THREE.Vector3();
    for (const o of this.list) {
      const inside = this.feet(o, f);
      o.obj.visible = !!inside;
      if (!inside) continue;
      o.obj.position.copy(f).multiplyScalar(scale).add(vol.position);
      o.obj.scale.setScalar(scale);
      o.obj.userData.icon.position.y = ORB_LIFT + BOB * Math.sin((time * BOB_HZ + o.id * BOB_PHASE_STEP) * Math.PI * 2);
    }
  }
}

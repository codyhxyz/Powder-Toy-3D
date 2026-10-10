import * as THREE from 'three';

// Team banners over an arena (src/arenas): no element is red or blue, so a
// team's colours fly on poles, markers like the spawners (spawners.js), not
// cells. Each is a steel pole with a cloth hanging from a crossbar, standing
// on a grid cell. They're scenery: nothing collides with them.

export const TEAM_COLOR = { red: 0xd8423a, blue: 0x3a7fd8 };
const POLE_H = 12;                    // cells from the foot to the crossbar
const POLE_R = 0.18;                  // cells, the pole's radius
const POLE_COLOR = 0x9aa1ab;
const CLOTH_W = 3.2;                  // cells across the cloth...
const CLOTH_H = 6;                    // ...and down from the crossbar
const CLOTH_TAIL = 1.2;               // cells the swallowtail's notch cuts up into the cloth's foot
const SWAY = 0.08;                    // rad the cloth sways about the pole...
const SWAY_HZ = 0.35;                 // ...this many times a second
const SWAY_PHASE_STEP = 1.3;          // banners placed one after another sway out of step

// A swallowtailed cloth hanging from its top edge, in the xy plane (off the pole along +x).
function clothGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(CLOTH_W, 0);
  s.lineTo(CLOTH_W, -CLOTH_H);
  s.lineTo(CLOTH_W / 2, -CLOTH_H + CLOTH_TAIL);
  s.lineTo(0, -CLOTH_H);
  s.closePath();
  return new THREE.ShapeGeometry(s);
}

export class ArenaMarkers {
  constructor({ scene, getSim, getVolume, getScale }) {
    this.getSim = getSim;
    this.getVolume = getVolume;
    this.getScale = getScale;
    this.list = [];   // { world: Vector3 (foot, world cells), obj, cloth, phase }
    this.root = new THREE.Group();
    this.root.name = 'arena-markers';
    scene.add(this.root);
  }

  // banners: [{ team, at: [x, y, z] (grid cells: the pole's foot) }]
  set(banners) {
    this.clear();
    banners.forEach(({ team, at }, i) => {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(POLE_R, POLE_R, POLE_H, 8).translate(0, POLE_H / 2, 0),
        new THREE.MeshBasicMaterial({ color: POLE_COLOR }));
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(POLE_R, POLE_R, CLOTH_W + POLE_R, 6).rotateZ(Math.PI / 2)
        .translate(CLOTH_W / 2, POLE_H, 0), pole.material);
      const cloth = new THREE.Mesh(clothGeometry(), new THREE.MeshBasicMaterial({ color: TEAM_COLOR[team], side: THREE.DoubleSide }));
      cloth.position.y = POLE_H;
      g.add(pole, bar, cloth);
      // the cloth hangs toward the middle of the map (along z, so it reads from down the valley)
      g.rotation.y = at[2] < this.getSim().g.nz / 2 ? -Math.PI / 2 : Math.PI / 2;
      this.root.add(g);
      this.list.push({ world: new THREE.Vector3(at[0] + 0.5, at[1], at[2] + 0.5).add(this.getSim().origin), obj: g, cloth, phase: i * SWAY_PHASE_STEP });
    });
    this.update();
  }

  clear() {
    for (const m of this.list) {
      m.obj.removeFromParent();
      m.obj.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this.list = [];
  }

  // every frame: banners follow the world's scale and the volume, and sway
  update(t = performance.now() / 1000) {
    const sim = this.getSim(), vol = this.getVolume(), scale = this.getScale();
    if (!sim || !vol) return;
    for (const m of this.list) {
      m.obj.position.copy(m.world).sub(sim.origin).multiplyScalar(scale).add(vol.position);
      m.obj.scale.setScalar(scale);
      m.cloth.rotation.y = SWAY * Math.sin(2 * Math.PI * SWAY_HZ * t + m.phase);
    }
  }
}

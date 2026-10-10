import * as THREE from 'three';
import { BODY_HEIGHT } from '../pov/constants.js';
import { TEAM_CSS } from './rules.js';

// What a team game puts in the world: flag stands and flags, the hill and the
// siege core as glowing rings, and a team chevron over every bot (Halo's
// friendly waypoints: a teammate's shows through walls, an enemy's only in
// plain sight). Built in grid cells and placed like the spawners (spawners.js):
// grid × scale + the volume's position, after the volume (renderOrder 1).

const POLE_H = 7;                    // cells
const POLE_R = 0.15;
const CLOTH = [2.6, 1.6];            // cells (width, height)
const STAND_R = 2.2;                 // cells, the stand's pad
const PAD_LIFT = 0.05;               // cells above the floor (no z-fighting)
const RING_W = 0.6;                  // cells, a zone ring's width
const ZONE_OPACITY = 0.18;           // a zone's floor disc
const WALL_H = 6;                    // cells, a zone's glowing wall
const WALL_OPACITY = 0.22;
const CHEVRON = 0.9;                 // cells, its size
const CHEVRON_UP = BODY_HEIGHT + 1.6;   // cells above the feet
const NEUTRAL = '#e8e2d0';
const CONTESTED_HZ = 4;              // a contested zone flashes this fast

const basic = (color, opacity = 1, extra = {}) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, ...extra });

function flagModel(team) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(POLE_R, POLE_R, POLE_H, 8).translate(0, POLE_H / 2, 0), basic('#d8d8d8'));
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(...CLOTH).translate(CLOTH[0] / 2, POLE_H - CLOTH[1] / 2, 0), basic(TEAM_CSS[team], 0.95, { side: THREE.DoubleSide }));
  for (const m of [pole, cloth]) { m.renderOrder = 1; g.add(m); }
  g.userData.cloth = cloth;
  return g;
}

function padModel(color, r) {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 40).rotateX(-Math.PI / 2).translate(0, PAD_LIFT, 0), basic(color, ZONE_OPACITY));
  const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.1, r - RING_W), r, 48).rotateX(-Math.PI / 2).translate(0, PAD_LIFT * 2, 0), basic(color, 0.9));
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(r, r, WALL_H, 48, 1, true).translate(0, WALL_H / 2, 0), basic(color, WALL_OPACITY, { side: THREE.DoubleSide }));
  for (const m of [disc, ring, wall]) { m.renderOrder = 1; g.add(m); }
  g.userData.mats = [disc.material, ring.material, wall.material];
  return g;
}

function chevronModel() {
  const geo = new THREE.ConeGeometry(CHEVRON * 0.6, CHEVRON, 4).rotateX(Math.PI);   // a diamond's lower half, pointing down
  const m = new THREE.Mesh(geo, basic('#ffffff', 0.95));
  m.renderOrder = 2;
  return m;
}

export function createMarkers({ scene, getVolume, getScale }) {
  const root = new THREE.Group();
  root.name = 'game-markers';
  scene.add(root);
  const place = (obj, p) => {
    const s = getScale(), v = getVolume();
    obj.position.set(p.x, p.y, p.z).multiplyScalar(s).add(v.position);
    obj.scale.setScalar(s);
  };
  let stands = {}, flags = {}, zone = null, zoneR = 0;
  const chevrons = new Map();   // bot id → mesh

  function clear() {
    for (const o of [...root.children]) {
      root.remove(o);
      o.traverse((c) => { c.geometry?.dispose(); c.material?.dispose(); });
    }
    stands = {}; flags = {}; zone = null; chevrons.clear();
  }

  return {
    clear,
    setVisible(v) { root.visible = v; },
    // CTF: a stand per team and its flag
    flags(layout) {
      for (const team of Object.keys(layout.flags ?? {})) {
        const [x, y, z] = layout.flags[team];
        stands[team] = padModel(TEAM_CSS[team], STAND_R);
        stands[team].userData.at = { x, y, z };
        flags[team] = flagModel(team);
        root.add(stands[team], flags[team]);
      }
    },
    // a hill or the core: { x, y, z, r }, coloured by who holds it (null: no one)
    zone(z) {
      if (zone && zoneR !== z.r) { root.remove(zone); zone.traverse((c) => { c.geometry?.dispose(); c.material?.dispose(); }); zone = null; }
      if (!zone) { zone = padModel(NEUTRAL, z.r); zoneR = z.r; root.add(zone); }
      zone.userData.at = z;
    },
    noZone() { if (zone) { root.remove(zone); zone = null; } },
    // every frame: flags where they are, the zone's colour, chevrons over the bots
    update({ time, flagAt, zoneOwner, zoneContested, bots, myTeam }) {
      for (const [team, s] of Object.entries(stands)) place(s, s.userData.at);
      for (const [team, f] of Object.entries(flags)) {
        const p = flagAt(team);
        f.visible = !!p;
        if (p) { place(f, p); f.rotation.y = time * 0.8; }
      }
      if (zone) {
        place(zone, zone.userData.at);
        const flash = zoneContested && Math.sin(time * CONTESTED_HZ * Math.PI * 2) > 0;
        const color = flash ? '#ffffff' : zoneOwner ? TEAM_CSS[zoneOwner] : NEUTRAL;
        for (const m of zone.userData.mats) m.color.set(color);
      }
      const seen = new Set();
      for (const b of bots) {
        seen.add(b.id);
        let c = chevrons.get(b.id);
        if (!c) { c = chevronModel(); chevrons.set(b.id, c); root.add(c); }
        c.visible = b.alive && !!b.team;
        if (!c.visible) continue;
        place(c, { x: b.pos.x, y: b.pos.y + CHEVRON_UP, z: b.pos.z });
        c.rotation.y = time * 2;
        c.material.color.set(TEAM_CSS[b.team]);
        const friend = myTeam && b.team === myTeam;
        c.material.depthTest = !friend;   // a teammate's shows through walls
      }
      for (const [id, c] of chevrons) if (!seen.has(id)) { root.remove(c); c.geometry.dispose(); c.material.dispose(); chevrons.delete(id); }
    },
  };
}

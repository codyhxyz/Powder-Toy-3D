import * as THREE from 'three';
import { villageBuildings, buildingDoors, buildingAt, buildingPoint } from './buildings.js';
import { createDoorController, inReach, resolveBoxMotion } from './doors.js';
import { character, furniture, nameplate, dispose } from './models.js';
import { bounds, ITEMS, restPose, overlaps } from './state.js';
import { resolveCharacterMotion } from './characterCollision.js';

const box = (root, color, x, y, z, w, h, d) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }));
  mesh.position.set(x, y, z); root.add(mesh); return mesh;
};
export function createBuildingRuntime(parent, size, terrainClear = () => true) {
  const root = new THREE.Group(); root.name = 'village-buildings'; parent.add(root);
  const buildings = villageBuildings(size[0] === 3072), doors = createDoorController(buildingDoors(buildings));
  const models = new Map(), actors = [], furnishings = [];
  const at = (model, p) => model.position.set(size[0] / 2 + p.x, p.y, size[2] / 2 + p.z);
  for (const d of doors.doors) {
    const hinge = new THREE.Group(), leaf = new THREE.Group(); root.add(hinge); hinge.add(leaf);
    at(hinge, { x: d.x - Math.cos(d.yaw) * d.width / 2, y: d.floor, z: d.z + Math.sin(d.yaw) * d.width / 2 });
    hinge.rotation.y = d.yaw;
    box(leaf, '#936846', d.width / 2, d.height / 2, 0, d.width, d.height, 0.35);
    for (const face of [-1, 1]) {
      for (const y of [d.height * 0.27, d.height * 0.72]) box(leaf, '#b78658', d.width / 2, y, face * 0.19, d.width - 1.2, d.height * 0.35, 0.08);
      box(leaf, '#e1bd65', d.width - 0.7, d.height * 0.48, face * 0.3, 0.28, 0.35, 0.25);
    }
    models.set(d.id, leaf);
  }
  for (const b of buildings.filter(b => !b.original)) {
    for (const [i, authored] of b.items.entries()) {
      const p = buildingPoint(b, authored.x, authored.z), rotation = authored.rotation + b.yaw / (Math.PI / 2);
      const item = { ...authored, ...p, rotation, id: `${b.id}-${i}`, building: b };
      const model = furniture(item.kind); at(model, p); model.rotation.y = rotation * Math.PI / 2; root.add(model);
      furnishings.push(item);
    }
    if (['ableShop', 'tailor'].includes(b.id)) {
      // Existing village clothing models double as the tailor's dress forms.
      for (const [persona, x] of [['boy', -b.half[0] + 4], ['girl', b.half[0] - 4]]) {
        const form = character({ persona }), p = buildingPoint(b, x, -2);
        form.root.scale.setScalar(0.6); at(form.root, p); form.root.rotation.y = b.yaw + Math.PI; root.add(form.root);
        furnishings.push({ kind: 'chair', decor: true, rotation: 0, id: `${b.id}-${persona}-form`, building: b, ...p, customBounds: { x: p.x - 1, z: p.z - 1, w: 2, d: 2 }, customHeight: 4 });
      }
    }
    if (b.id === 'theatre') {
      const stage = new THREE.Group(); root.add(stage); at(stage, buildingPoint(b, 0, -13));
      box(stage, '#936846', 0, 0.4, 0, 22, 0.8, 5);
      for (const x of [-10.5, 10.5]) box(stage, '#b97368', x, 5, 1.8, 1, 9, 0.4);
      box(stage, '#b97368', 0, 9, 1.8, 22, 1, 0.4);
      // Stage is a solid platform, not an invisible walk-through prop.
      furnishings.push({ kind: 'table', id: 'stage', building: b, x: b.at[0], z: b.at[1] - 13, y: b.floor, customBounds: { x: b.at[0] - 11, z: b.at[1] - 15.5, w: 22, d: 5 }, customHeight: 0.8 });
      for (const x of [-10.5, 10.5]) furnishings.push({
        kind: 'table', decor: true, id: `curtain-${x}`, building: b, y: b.floor + 0.5,
        customBounds: { x: b.at[0] + x - 0.5, z: b.at[1] - 11.4, w: 1, d: 0.4 }, customHeight: 9,
      });
      furnishings.push({
        kind: 'table', decor: true, id: 'curtain-header', building: b, y: b.floor + 8.5,
        customBounds: { x: b.at[0] - 11, z: b.at[1] - 11.4, w: 22, d: 0.4 }, customHeight: 1,
      });
    }
    const p = buildingPoint(b, 0, b.half[1] > 16 ? -9 : -4.5), model = character(b.occupant);
    at(model.root, p); model.root.rotation.y = b.yaw + Math.PI; root.add(model.root);
    actors.push({ spec: b.occupant, building: b, model, ...p, height: new THREE.Box3().setFromObject(model.root).max.y - b.floor });
    const sign = nameplate(b.name); at(sign, { x: b.entry[0], y: b.floor + 14, z: b.entry[1] }); sign.rotation.y = b.yaw; root.add(sign);
  }
  const furnitureBoxes = () => furnishings.map(i => ({ ...(i.customBounds ?? bounds(i)), floor: i.y, top: i.y + (i.customHeight ?? ITEMS[i.kind].h) }));
  function restPathClear(item, from, to, radius, playerSize) {
    const b = item.building, cos = Math.cos(b.yaw), sin = Math.sin(b.yaw);
    const inside = p => {
      const x = p.x - b.at[0], z = p.z - b.at[1];
      return Math.abs(cos * x - sin * z) + radius <= b.half[0] - 2
        && Math.abs(sin * x + cos * z) + radius <= b.half[1] - 2;
    };
    if (!inside(from) || !inside(to) || !terrainClear(from, to, b.floor)) return false;
    const boxes = [...doors.colliders(), ...furnitureBoxes().filter((_, i) => furnishings[i].id !== item.id)]
      .filter(box => box.floor < b.floor + 6 * playerSize && box.top > b.floor);
    const path = resolveBoxMotion(from, to, radius, boxes);
    const actorsHere = actors.filter(a => a.building === b).map(a => ({ ...a, radius: 1.4 }));
    const characters = resolveCharacterMotion(from, to, 1.4 * playerSize, actorsHere);
    return Math.hypot(path.x - to.x, path.z - to.z) < 1e-5
      && Math.hypot(characters.x - to.x, characters.z - to.z) < 1e-5
      && !boxes.some(box => overlaps(box, { x: to.x - radius, z: to.z - radius, w: radius * 2, d: radius * 2 }));
  }
  return {
    buildings, doors, actors, furnishings,
    room: p => buildingAt(buildings.filter(b => !b.original), p),
    nearby(p, forward) {
      const door = doors.nearby(p, forward);
      if (door) return { kind: 'door', door, title: `${door.target ? 'Close' : 'Open'} ${door.name} door` };
      const room = this.room(p); if (!room) return null;
      const actor = actors.find(a => a.building === room && inReach(p, a, forward));
      if (actor) return { kind: 'talk', actor, title: `Talk to ${actor.spec.name}` };
      const item = furnishings.filter(i => i.building === room && !i.decor && (i.service || restPose(i)) && inReach(p, i, forward, 5))
        .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
      if (!item) return null;
      const title = { catalogue: 'Browse furniture catalogue', coffee: 'Order a cup of coffee', outfit: 'Choose an outfit', fish: 'Study creek fish', tools: 'Inspect the workbench', garden: 'Read the plant notes', clock: 'Inspect the old clock', notes: 'Read town notes', show: 'Watch a performance' }[item.service];
      return { kind: item.service ? 'service' : 'rest', item, title: title ?? `${restPose(item).kind === 'sleep' ? 'Sleep in' : 'Sit on'} ${ITEMS[item.kind].name.toLowerCase()}` };
    },
    tick(dt, time, p, radius, speaking) {
      doors.tick(dt, p, radius);
      for (const d of doors.doors) models.get(d.id).rotation.y = d.swing * d.progress * Math.PI / 2;
      for (const a of actors) {
        if (speaking === a && p) a.model.root.rotation.y = Math.atan2(a.x - p.x, a.z - p.z);
        a.model.animate(time, 0, speaking === a);
      }
    },
    collide(from, to, radius, actorRadius, height) {
      const boxes = [...doors.colliders(), ...furnitureBoxes()].filter(b => Math.min(from.y, to.y) < b.top - 0.01 && Math.max(from.y, to.y) + height > b.floor);
      const obstacles = actors.filter(a => Math.min(from.y, to.y) < a.y + a.height && Math.max(from.y, to.y) + height > a.y).map(a => ({ ...a, radius: 1.4 }));
      const characters = resolveCharacterMotion(from, to, actorRadius, obstacles);
      let motion = resolveBoxMotion(from, characters, radius, boxes);
      const boxBlocked = motion.blocked;
      // A box slide must not introduce a new path through a character.
      const checked = resolveCharacterMotion(from, motion, actorRadius, obstacles);
      motion = resolveBoxMotion(from, checked, radius, boxes);
      if (obstacles.some(a => Math.hypot(motion.x - a.x, motion.z - a.z) < actorRadius + a.radius - 1e-7))
        return { x: from.x, z: from.z, blocked: true };
      if (Math.hypot(motion.x - to.x, motion.z - to.z) > 1e-5
        && !terrainClear(from, { ...motion, y: to.y }))
        return { x: from.x, z: from.z, blocked: true };
      return { ...motion, blocked: boxBlocked || motion.blocked || characters.blocked || checked.blocked };
    },
    support(from, to, radius, height) {
      const footprint = { x: to.x - radius, z: to.z - radius, w: radius * 2, d: radius * 2 };
      return [...furnitureBoxes(), ...actors.map(a => ({ x: a.x - 1.4, z: a.z - 1.4, w: 2.8, d: 2.8, top: a.y + a.height }))]
        .filter(b => from.y >= b.top - 0.05 && to.y <= b.top && overlaps(b, footprint)).sort((a, b) => b.top - a.top)[0]?.top ?? null;
    },
    rest(item, p, radius, playerSize) {
      if (item.decor) return null;
      const pose = restPose(item, playerSize);
      if (!pose || ![pose.x, pose.z, pose.yaw].every(Number.isFinite)) return null;
      return restPathClear(item, p, pose, radius, playerSize) ? pose : null;
    },
    stand(item, from, entry, radius, playerSize) {
      const b = bounds(item), gap = radius + 0.2;
      const candidates = [entry, { x: b.x - gap, z: item.z }, { x: b.x + b.w + gap, z: item.z }, { x: item.x, z: b.z - gap }, { x: item.x, z: b.z + b.d + gap }];
      return candidates.find(p => restPathClear(item, from, p, radius, playerSize)) ?? null;
    },
    dispose() { doors.dispose(); dispose(root); models.clear(); actors.length = furnishings.length = 0; },
  };
}

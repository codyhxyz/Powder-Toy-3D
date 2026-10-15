import { reference, numbers, transformPoint, sourceActorMetadata } from './godot3.js';
import { sourceToCells } from './voxelize.js';
import { convexProjectionAxes } from './convexVolume.js';
import { DOOR_MOTION_VERSION, DOOR_DEFAULTS, IDENTITY_TRANSFORM, isRigidTransform, transformDoorVector, doorSweptBounds, padDoorBounds } from './doorMotion.js';

const ORDINARY = new Set(['Door.gd', 'Elevator_Door.gd', 'down_door.gd']);
const DOORS = new Set([...ORDINARY, 'Divine_Door.gd', 'Profane_Door.gd', 'Terror_Door.gd']);
export const scriptResource = (node, scene) => node.props.script ? scene.external.get(reference(node.props.script).id)?.path : null;
export function doorAncestor(mesh, scene) {
  let node = scene.nodes.get(mesh.nodePath);
  while (node) {
    if (DOORS.has(scriptResource(node, scene)?.split('/').pop())) return node.path;
    node = scene.nodes.get(node.parent);
  }
  return null;
}
/** Analyze once before SAT; bake the exact _ready closed pose, not a centered hinge. */
export function analyzeCrueltyDoors(scene, meshes, { cellMeters = 0.3 } = {}) {
  const doors = new Map(), meshOwners = new Map();
  for (const mesh of meshes) meshOwners.set(mesh, doorAncestor(mesh, scene));
  for (const node of scene.nodes.values()) {
    const sourceResource = scriptResource(node, scene), script = sourceResource?.split('/').pop();
    if (!DOORS.has(script)) continue;
    const leafMeshes = meshes.filter(m => meshOwners.get(m) === node.path);
    if (!leafMeshes.length) continue;
    const direct = [...scene.nodes.values()].filter(n => n.parent === node.path && n.type === 'MeshInstance');
    const selected = direct.at(-1), mesh = leafMeshes.find(m => m.nodePath === selected?.path);
    const kind = script === 'Door.gd' ? 'swing' : script === 'Elevator_Door.gd' ? 'sliding' : script === 'down_door.gd' ? 'vertical' : 'gate';
    const sourceProperties = sourceActorMetadata(node, scene).sourceProperties;
    const diagnostics = [];
    const record = { sourcePath: node.path, sourceResource, sourceProperties, kind, diagnostics, leafMeshes, supported: false };
    doors.set(node.path, record);
    if (!ORDINARY.has(script)) { diagnostics.push('Unsupported source progression gate'); continue; }
    if (!mesh?.rawLocalBounds || leafMeshes.length !== 1) diagnostics.push('Motion requires the last direct MeshInstance to be the only visible leaf mesh');
    const parent = scene.nodes.get(node.parent)?.worldTransform ?? IDENTITY_TRANSFORM;
    for (let n = selected; n; n = scene.nodes.get(n.parent)) {
      if (['translation', 'rotation', 'rotation_degrees', 'scale'].some(key => Object.hasOwn(n.props, key))) diagnostics.push(`Unsupported separate transform components at ${n.path}`);
      if (n.unresolvedParent) diagnostics.push(`Unresolved transform ancestor at ${n.path}`);
    }
    const root = node.localTransform, child = selected?.localTransform;
    if (node.unresolvedParent || !isRigidTransform(parent) || !isRigidTransform(root) || !isRigidTransform(child)) diagnostics.push('Unsupported unresolved, scaled, sheared or reflected door/parent/mesh transform');
    if (root && [root[1], root[3], root[5], root[7], root[4] - 1].some(v => Math.abs(v) > 2e-5)) diagnostics.push('Unsupported root pitch/roll: source assigns Euler rotation.y');
    const speedKey = kind === 'swing' ? 'rotation_speed' : 'speed';
    const speed = Object.hasOwn(node.props, speedKey) ? sourceProperties[speedKey] : DOOR_DEFAULTS[speedKey];
    if (!(typeof speed === 'number' && Number.isFinite(speed) && speed > 0)) diagnostics.push(`Unsupported ${speedKey}: expected a finite positive number`);
    if (diagnostics.length) continue;
    const localBounds = mesh.rawLocalBounds, p = localBounds.min, size = localBounds.max.map((v, k) => v - p[k]);
    const q = kind === 'swing' ? (size[0] > size[2] ? [p[0], 0, p[2] + size[2] / 2] : [p[0] + size[0] / 2, 0, p[2]]) : [p[0], 0, p[2]];
    // Literal mixed-space source arithmetic: root GLOBAL origin -= q;
    // child Transform.translated(q) adds child BASIS*q in root space.
    const pivot = node.worldTransform.slice(9).map((v, k) => v - q[k]);
    const localShift = transformDoorVector(child, q), worldShift = transformDoorVector(node.worldTransform, localShift);
    const closedSourceOffset = worldShift.map((v, k) => v - q[k]);
    for (const s of mesh.surfaces) {
      const positions = new Float64Array(s.positions.length);
      for (let i = 0; i < positions.length; i++) positions[i] = s.positions[i] + closedSourceOffset[i % 3];
      s.positions = positions;
    }
    const travel = kind === 'vertical' ? size[1] + DOOR_DEFAULTS.clearance : Math.max(size[0], size[2]) + DOOR_DEFAULTS.clearance;
    const parentDirection = kind === 'vertical' ? [0, -1, 0] : [size[0] >= size[2] ? -1 : 0, 0, size[0] <= size[2] ? -1 : 0];
    const parentY = transformDoorVector(parent, [0, 1, 0]);
    const motion = { version: DOOR_MOTION_VERSION, kind, pivot, axis: parentY.map(v => v / Math.hypot(...parentY)),
      ...(kind === 'swing' ? { angleRadians: -Math.PI / 2 } : { translation: transformDoorVector(parent, parentDirection.map(v => v * travel)), distance: travel }),
      speed, sourceSpeed: speed, speedProperty: speedKey, durationSeconds: (kind === 'swing' ? Math.PI / 2 : travel) / speed,
      autoCloseSeconds: kind === 'swing' ? null : DOOR_DEFAULTS.autoCloseSeconds,
      switchUseAutoCloseSeconds: null, closedSourceOffset, selectedMesh: mesh.nodePath, rawLocalBounds: localBounds, sourceRebase: q,
      defaults: { ...DOOR_DEFAULTS }, defaultCitations: [kind === 'swing' ? 'Scripts/Door.gd:5-6,26-40,55-64' : kind === 'sliding' ? 'Scripts/Elevator_Door.gd:3-4,17-22,27-37,44-89' : 'Scripts/down_door.gd:3-4,16-36,43-78'],
      adaptation: 'Nominal clamped endpoint; no one-tick overshoot or stop/toggle quirk; timer measured from activation' };
    const points = mesh.surfaces.flatMap(s => Array.from({ length: s.positions.length / 3 }, (_, i) => Array.from(s.positions.subarray(i * 3, i * 3 + 3))));
    // A surface-owned closed voxel lies at most sqrt(3) cells from a hit
    // point. Extra sqrt(3) covers rasterization of its moving unit cube.
    record.sweptSourceBounds = padDoorBounds(doorSweptBounds(motion, points), 2 * Math.sqrt(3) * cellMeters);
    Object.assign(record, { supported: true, motion });
  }
  return { doors, ownerForMesh: mesh => meshOwners.get(mesh), sweptBounds: [...doors.values()].filter(d => d.supported).map(d => d.sweptSourceBounds) };
}
export function doorMotionInCells(record, map) {
  if (!record?.supported) return null;
  const m = record.motion;
  return { ...m, units: 'world-cells; radians; seconds', pivot: sourceToCells(map, m.pivot),
    ...(m.translation ? { translation: m.translation.map(v => v / map.cellMeters), distance: m.distance / map.cellMeters, speed: m.speed / map.cellMeters } : {}),
    sweptBounds: { min: sourceToCells(map, record.sweptSourceBounds.min), max: sourceToCells(map, record.sweptSourceBounds.max) } };
}
export function crueltyInteractions(scene, meshes, map, ownedCells, analysis = null, appearanceTriangleIndices = {}) {
  const inventory = [...scene.nodes.values()].filter(n => n.props.script || n.instance).map(n => {
    const metadata = sourceActorMetadata(n, scene), script = scriptResource(n, scene)?.split('/').pop();
    const treatment = ORDINARY.has(script) ? (analysis ? analysis.doors.get(n.path)?.supported ? 'source-rigid-voxel-leaf-motion' : 'closed-unsupported-motion' : 'exclusive-cell-voxel-retraction')
      : DOORS.has(script) ? 'closed-unsupported-progression'
      : script === 'Ladder.gd' ? 'authored-volume-exported'
      : script === 'Exit.gd' ? 'normal-mission-extraction'
      : metadata.sourceResource?.includes('/Enemies/') || script === 'EnemyHandler.gd' ? 'destination-actor-see-mission-inventory'
      : n.instance ? 'external-scene-not-expanded' : 'script-not-ported';
    return { sourcePath: n.path, ...metadata, treatment };
  });
  const doors = [], ladders = [];
  for (const node of scene.nodes.values()) {
    const sourceResource = scriptResource(node, scene), script = sourceResource?.split('/').pop();
    if (DOORS.has(script)) {
      const points = [];
      for (const m of meshes) if (doorAncestor(m, scene) === node.path) for (const s of m.surfaces)
        for (let i = 0; i < s.positions.length; i += 3) points.push(sourceToCells(map, Array.from(s.positions.subarray(i, i + 3))));
      if (!points.length) continue;
      const min = [0, 1, 2].map(k => Math.floor(Math.min(...points.map(p => p[k])) - 1e-8));
      const max = [0, 1, 2].map(k => Math.floor(Math.max(...points.map(p => p[k])) + 1e-8) + 1);
      const analyzed = analysis?.doors.get(node.path), motion = doorMotionInCells(analyzed, map);
      const supported = analysis ? !!analyzed?.supported : ORDINARY.has(script), timed = supported && script !== 'Door.gd';
      doors.push({ sourcePath: node.path, sourceResource, bounds: { min, max }, cells: ownedCells[node.path] ?? [],
        kind: script === 'down_door.gd' ? 'vertical' : script === 'Elevator_Door.gd' ? 'sliding' : supported ? 'swing' : 'gate', supported,
        requirement: supported ? null : ORDINARY.has(script) ? 'Unsupported source motion; see diagnostics' : script === 'Divine_Door.gd' ? 'Requires intact soul (unsupported)' : script === 'Profane_Door.gd' ? 'Requires husk mode (unsupported)' : 'Requires hope discarded (unsupported)',
        sourceProperties: sourceActorMetadata(node, scene).sourceProperties, autoCloseSeconds: timed ? DOOR_DEFAULTS.autoCloseSeconds : null,
        ...(analysis ? { motion, diagnostics: analyzed?.diagnostics ?? [], appearanceTriangleIndices: appearanceTriangleIndices[node.path] ?? [] } : {}),
        ownershipWarning: ownedCells[node.path]?.length ? null : 'No exclusive voxels: overlapping static geometry is not removed',
        adaptation: motion ? motion.adaptation : supported ? 'Legacy instant voxel retraction' : 'Closed; unsupported source motion or progression; see diagnostics' });
    }
    if (script === 'Ladder.gd') for (const collider of scene.nodes.values()) {
      if (collider.parent !== node.path || collider.type !== 'CollisionShape' || collider.props.disabled === 'true') continue;
      const shape = scene.resources.get(reference(collider.props.shape).id);
      if (shape?.type !== 'ConvexPolygonShape') throw new Error(`Unsupported ladder volume: ${collider.path}`);
      const values = numbers(shape.props.points, 'PoolVector3Array'), points = [];
      for (let i = 0; i < values.length; i += 3) points.push(sourceToCells(map, transformPoint(collider.worldTransform, values.slice(i, i + 3))));
      ladders.push({ sourcePath: node.path, sourceResource, bounds: { min: [0, 1, 2].map(k => Math.min(...points.map(p => p[k]))), max: [0, 1, 2].map(k => Math.max(...points.map(p => p[k]))) }, points, axes: convexProjectionAxes(points) });
    }
  }
  return { version: 1, doors, ladders, inventory, cellEncoding: 'Flat [world-linear-cell-index, original-element-id] pairs; X fastest, then Y, Z. Exclusive moving-surface ownership only.' };
}

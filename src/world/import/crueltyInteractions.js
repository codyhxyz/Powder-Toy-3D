import { reference, numbers, transformPoint, sourceActorMetadata } from './godot3.js';
import { sourceToCells } from './voxelize.js';
import { convexProjectionAxes } from './convexVolume.js';

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
export function crueltyInteractions(scene, meshes, map, ownedCells) {
  const inventory = [...scene.nodes.values()].filter(n => n.props.script || n.instance).map(n => {
    const metadata = sourceActorMetadata(n, scene), script = scriptResource(n, scene)?.split('/').pop();
    const treatment = ORDINARY.has(script) ? 'exclusive-cell-voxel-retraction'
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
      const supported = ORDINARY.has(script), timed = supported && script !== 'Door.gd';
      doors.push({ sourcePath: node.path, sourceResource, bounds: { min, max }, cells: ownedCells[node.path] ?? [],
        kind: script === 'down_door.gd' ? 'vertical' : script === 'Elevator_Door.gd' ? 'sliding' : supported ? 'swing' : 'gate', supported,
        requirement: supported ? null : script === 'Divine_Door.gd' ? 'Requires intact soul (unsupported)' : script === 'Profane_Door.gd' ? 'Requires husk mode (unsupported)' : 'Requires hope discarded (unsupported)',
        sourceProperties: sourceActorMetadata(node, scene).sourceProperties, autoCloseSeconds: timed ? 5 : null,
        ownershipWarning: ownedCells[node.path]?.length ? null : 'No exclusive voxels: overlapping static geometry is not removed',
        adaptation: supported ? 'Instant voxel retraction; no moving leaf, source hinge/speed/audio not simulated' : 'Closed; original progression is not implemented' });
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

import { numbers, reference, transformPoint, sourceActorMetadata } from './godot3.js';
import { sourceToCells, importedCell } from './voxelize.js';
import { convexProjectionAxes } from './convexVolume.js';
import { BODY_WIDTH, BODY_HEIGHT } from '../../pov/constants.js';
import { ELEMENTS, K } from '../../elements.js';

export const GUARD_STYLES = {
  'res://Entities/Enemies/E_Grunt.tscn': 'gunner',
  'res://Entities/Enemies/E_Elite.tscn': 'gunner',
  'res://Entities/Enemies/E_Security.tscn': 'gunner',
  'res://Entities/Enemies/E_Cop_Revolver.tscn': 'gunner',
  'res://Entities/Enemies/E_Cop_Shotgun.tscn': 'gunner',
  'res://Entities/Enemies/E_Knifelord.tscn': 'axeman',
  'res://Entities/Enemies/E_Assassin.tscn': 'gunner',
};
export function actorVisualAncestor(node, scene) {
  let ancestor = scene.nodes.get(node.parent);
  while (ancestor) {
    if (ancestor.instance && scene.external.get(reference(ancestor.instance).id)?.path.includes('/Enemies/')) return ancestor;
    if (ancestor.props.script && scene.external.get(reference(ancestor.props.script).id)?.path === 'res://Scripts/EnemyHandler.gd') return ancestor;
    ancestor = scene.nodes.get(ancestor.parent);
  }
  return null;
}
export const hiddenActorHelper = (node, scene) => node.props.visible === 'false' && !!actorVisualAncestor(node, scene);
export function crueltyExcludeNode(node, scene) {
  // A hidden actor weapon/ray helper is not level terrain. Hidden static world
  // meshes are NOT dropped: they may contain authored collision geometry.
  // Animated character art is represented by destination NPCs, not duplicate
  // static terrain or loose MEAT. This also removes hidden actor ray helpers.
  if (actorVisualAncestor(node, scene)) return true;
  let parent = scene.nodes.get(node.parent);
  while (parent) {
    if (parent.type === 'Area') {
      const script = parent.props.script && scene.external.get(reference(parent.props.script).id)?.path;
      if (script !== 'res://Scripts/Water.gd') return true;
    }
    parent = scene.nodes.get(parent.parent);
  }
  return false;
}
function sourceNode(scene, path) {
  const node = scene.nodes.get(path);
  if (!node || node.unresolvedParent) throw new Error(`Missing authored mission node ${path}`);
  return node;
}
// Cruelty Squad's actor pivots commonly sit around1.5m over their surface
// band. Twice that span bounds a search; it cannot relocate actors to roofs.
const SUPPORT_SEARCH_METERS = 3;
export function actorBodyClear(map, words, at) {
  const half = BODY_WIDTH / 2;
  const low = [at[0] - half, at[1], at[2] - half];
  const high = [at[0] + half, at[1] + BODY_HEIGHT, at[2] + half];
  if (low.some((v, k) => v < 0 || high[k] > map.size[k])) return false;
  for (let x = Math.floor(low[0]); x < Math.ceil(high[0] - 1e-8); x++)
    for (let y = Math.floor(low[1]); y < Math.ceil(high[1] - 1e-8); y++)
      for (let z = Math.floor(low[2]); z < Math.ceil(high[2] - 1e-8); z++)
        if (ELEMENTS[importedCell(map, words, x, y, z)]?.kind === K.SOLID) return false;
  return true;
}
export function actorFeetAt(map, words, authored) {
  const p = sourceToCells(map, authored);
  for (let y = Math.floor(p[1]); y >= Math.max(0, p[1] - SUPPORT_SEARCH_METERS / map.cellMeters); y--) {
    if (ELEMENTS[importedCell(map, words, Math.floor(p[0]), y, Math.floor(p[2]))]?.kind !== K.SOLID) continue;
    const at = [p[0], y + 1, p[2]];
    if (actorBodyClear(map, words, at)) return at;
  }
  return null;
}
function normalEligible(node) {
  return !['hell_objective', 'hell_only', 'chaos_objective', 'chaos_only', 'disabled'].some((key) => node.props[key] === 'true') && node.props.visible !== 'false';
}
export function crueltyMission(scene, map, words, profile) {
  const authored = (path) => transformPoint(sourceNode(scene, path).worldTransform, [0, 0, 0]);
  const placementFailures = [];
  const placement = (path, role) => {
    const sourceAt = authored(path), at = actorFeetAt(map, words, sourceAt);
    if (!at) placementFailures.push({ sourcePath: path, sourceAt, role, bodyDimensions: [BODY_WIDTH, BODY_HEIGHT, BODY_WIDTH], reason: 'No SOLID support with full ordinary body clearance at authored X/Z within 3 meters below pivot' });
    return at;
  };
  const actor = (path, name, style = 'gunner', role = 'guard') => {
    const node = sourceNode(scene, path);
    if (!normalEligible(node)) throw new Error(`Non-normal actor in mission profile: ${path}`);
    const sourceAt = authored(path);
    return { id: path, name, at: placement(path, role), sourceAt, sourcePath: path, ...sourceActorMetadata(node, scene), style, ...(style === 'gunner' ? { weapons: ['GUN'] } : {}) };
  };
  const authoredTargets = profile.targets.map((path) => actor(path, `${profile.name} target (${sourceNode(scene, path).name ?? path})`, 'gunner', 'target'));
  const authoredGuards = [...scene.nodes.values()].filter((node) => node.instance && normalEligible(node) && !profile.targets.includes(node.path) && Object.hasOwn(GUARD_STYLES, scene.external.get(reference(node.instance).id)?.path))
    .map((node) => actor(node.path, node.name, GUARD_STYLES[scene.external.get(reference(node.instance).id).path]));
  const extractions = profile.exits.map((path) => {
    const exit = sourceNode(scene, path);
    if (!normalEligible(exit) || exit.props.monitoring === 'false') throw new Error(`Disabled/non-normal authored exit: ${path}`);
    const colliders = [...scene.nodes.values()].filter((node) => node.parent === path && node.type === 'CollisionShape');
    if (colliders.length !== 1) throw new Error(`Expected one authored convex exit volume: ${path}`);
    const points = [];
    for (const collider of colliders) {
      if (collider.props.disabled === 'true') throw new Error(`Disabled exit collision: ${collider.path}`);
      const shape = scene.resources.get(reference(collider.props.shape).id);
      if (shape?.type !== 'ConvexPolygonShape') throw new Error(`Unsupported extraction shape: ${path}`);
      const values = numbers(shape.props.points, 'PoolVector3Array');
      if (values.length < 12 || values.length % 3) throw new Error(`Invalid extraction points: ${path}`);
      for (let i = 0; i < values.length; i += 3) points.push(sourceToCells(map, transformPoint(collider.worldTransform, values.slice(i, i + 3))));
    }
    const min = [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k])));
    const max = [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k])));
    return { at: [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2], radius: Math.min(max[0] - min[0], max[2] - min[2]) / 2, height: max[1] - min[1], sourcePath: path, sourceAt: authored(path), bounds: { min, max },
      points, sourcePoints: points.map(p => p.map((n, k) => (n + map.origin[k]) * map.cellMeters)), axes: convexProjectionAxes(points) };
  });
  if (!extractions.length) throw new Error('Mission has no authored exit');
  const spawn = placement(profile.spawn, 'spawn');
  const available = !!spawn && authoredTargets.every((a) => a.at !== null);
  const spawnTransform = sourceNode(scene, profile.spawn).worldTransform;
  return { id: profile.id, name: profile.name, available, spawn, spawnYaw: Math.atan2(spawnTransform[6], spawnTransform[8]),
    sourceSpawn: authored(profile.spawn), sourceSpawnPath: profile.spawn, sourceSpawnTransform: spawnTransform,
    targets: authoredTargets.filter((a) => a.at), guards: authoredGuards.filter((a) => a.at), authoredTargets, authoredGuards, placementFailures,
    extraction: extractions[0], extractions };

}

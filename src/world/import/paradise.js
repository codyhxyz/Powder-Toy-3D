import { E } from '../../elements.js';
import { numbers, reference, transformPoint } from './godot3.js';
import { sourceToCells, importedCell } from './voxelize.js';

// Exact source names from Levels/Level2.tscn, not screenshot-derived geometry.
// Translation only: texture appearance is intentionally replaced by this
// game's physical elements. No game textures or models are shipped here.
const groups = {
  ROCK: ['1.png', 'BlackWall.png', 'Diamond_Tile.png', 'Granite1.png', 'GreyWall.png', 'Marble1.tres', 'Marble1red.tres', 'MarbleFace1.png', 'RedWall.png', 'Stone2.png', 'Stone2face.png', 'Stone3.png', 'Stone4.png', 'Stone_Tile.png', 'Stone_Tile_dark.png', 'Stone_Wall_1.png', 'Stone_wall_2.png', 'TealWall.png', 'Teal_Tile.png', 'Teal_Tile2.png', 'Wall_Crusty.png', 'Wall_Crusty_face.png', 'alien_1.png', 'alien_2.png', 'arches.png', 'bathroom.png', 'blue_yellow.png', 'catacomb.png', 'cobble1.png', 'cobble2.png', 'cyber_1.png', 'cyber_2.png', 'flower.png', 'freak_tile.png', 'frog1.png', 'greenwall.png', 'joe2.png', 'maario.png', 'mosaic_1.png', 'non_slip_tile.png', 'pizzahouse.png', 'plain_wall.png', 'plain_wall2.png', 'psycho_tile.png', 'star_tile.png'],
  WOOD: ['Wood1.png', 'Wood2.tres', 'Wood_Door2.png', 'greenplank.png', 'rug1.png'],
  METAL: ['Elevator1.png', 'chainlink.tres', 'grate.png', 'metal_door.png', 'divinedoor.png'],
  GLASS: ['glass1.tres', 'glass_green.tres'],
  WATER: ['water.tres'],
  MEAT: ['flesh.tres', 'flesh_tile.png'],
  CRYSTAL: ['light1.tres'],
};
export const PARADISE_MATERIALS = Object.fromEntries(Object.entries(groups).flatMap(([element, names]) => names.map((name) => [`res://Maps/textures/base/${name}`, E[element]])));
Object.assign(PARADISE_MATERIALS, {
  '__default__': E.WALL,
  'res://Imported_Mesh/Snirby.material': E.WOOD,
  'res://Maps/textures/special/exit.tres': E.EMPTY,
  'res://Maps/textures/suburb/funko.png': E.ROCK,
  'res://Maps/textures/suburb/suburb_brick_1.png': E.BRICK,
  'res://Maps/textures/suburb/suburb_brick_2.png': E.BRICK,
  'res://Maps/textures/suburb/suburb_grass.png': E.PLANT,
  'res://Maps/textures/suburb/suburb_grass_red.png': E.PLANT,
  'res://Maps/textures/suburb/suburb_roof_1.png': E.BRICK,
  'res://Maps/textures/suburb/suburb_roof_2.png': E.BRICK,
  'res://Maps/textures/suburb/suburb_wall_1.png': E.ROCK,
  'res://Maps/textures/suburb/suburb_wall_2.png': E.ROCK,
  'res://Maps/textures/suburb/suburb_wall_3.png': E.ROCK,
  'res://Maps/textures/swamp/swamptree.png': E.WOOD,
  'res://Maps/textures/swamp/swampwater1.tres': E.WATER,
});
export const PARADISE_NODES = {
  spawn: 'QodotMap/entity_9_Player',
  targets: ['Nerd_1', 'Nerd_2', 'Nerd_3'],
  extraction: 'QodotMap/entity_225_Exit',
};
export function paradiseExcludeNode(node, scene) {
  // Exit/ladder/message Areas are volumes, not walls. Water is actual matter.
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
// Cruelty Squad's authored player/guard roots commonly sit at y=1.5m over
// the surface band. Twice that span bounds a downward pivot/support search,
// rather than teleporting basement actors onto a distant floor or a roof.
const SUPPORT_SEARCH_METERS = 3;
function feetAt(map, words, authored) {
  const p = sourceToCells(map, authored);
  // Authored actor pivots are kept separately. Feet are the nearest imported
  // support under that pivot, NOT the column's roof/topmost ground. Thus
  // basement and multi-storey targets stay on their authored floors.
  for (let y = Math.floor(p[1]); y >= Math.max(0, p[1] - SUPPORT_SEARCH_METERS / map.cellMeters); y--) {
    if (importedCell(map, words, Math.floor(p[0]), y, Math.floor(p[2]))) return [p[0], y + 1, p[2]];
  }
  throw new Error(`No imported support below authored actor ${authored.join(',')}`);
}
export function paradiseMission(scene, map, words) {
  const authored = (path) => transformPoint(sourceNode(scene, path).worldTransform, [0, 0, 0]);
  const actor = (path, name, style = 'gunner') => {
    const sourceAt = authored(path);
    return { id: path, name, at: feetAt(map, words, sourceAt), sourceAt, sourcePath: path, style, weapons: ['GUN'] };
  };
  const names = ['G-TECH executive (Nerd_1)', 'G-TECH executive (Nerd_2)', 'G-TECH executive (Nerd_3)'];
  const targets = PARADISE_NODES.targets.map((path, i) => actor(path, names[i]));
  // Only the standard guards explicitly instantiated in this map. Conditional
  // Hope Eradicated/chaos actors are not fabricated or activated by this import.
  const guards = [...scene.nodes.values()].filter((node) => {
    if (!node.instance) return false;
    const path = scene.external.get(reference(node.instance).id)?.path;
    return ['res://Entities/Enemies/E_Grunt.tscn', 'res://Entities/Enemies/E_Elite.tscn', 'res://Entities/Enemies/E_Security.tscn'].includes(path);
  }).map((node) => actor(node.path, node.name));
  const exit = sourceNode(scene, PARADISE_NODES.extraction);
  const collider = [...scene.nodes.values()].find((node) => node.parent === exit.path && node.type === 'CollisionShape');
  if (!collider) throw new Error('Authored exit collision volume missing');
  const shape = scene.resources.get(reference(collider.props.shape).id);
  if (shape?.type !== 'ConvexPolygonShape') throw new Error('Unsupported extraction shape');
  const values = numbers(shape.props.points, 'PoolVector3Array'), points = [];
  for (let i = 0; i < values.length; i += 3) points.push(sourceToCells(map, transformPoint(collider.worldTransform, values.slice(i, i + 3))));
  const min = [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k])));
  const max = [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k])));
  return {
    id: 'paradise', name: 'Paradise', spawn: feetAt(map, words, authored(PARADISE_NODES.spawn)),
    sourceSpawn: authored(PARADISE_NODES.spawn), targets, guards,
    extraction: { at: [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2], radius: Math.min(max[0] - min[0], max[2] - min[2]) / 2, height: max[1] - min[1], sourcePath: exit.path, sourceAt: authored(exit.path), bounds: { min, max } },
  };
}

import { E } from '../elements.js';

// Sandustry's physical streams, built with TPT matter rather than item slots.
export const INDUSTRY_LIMIT = 128;
export const DEVICE_SIZE = 4;
// Castings must lose their visible heat, not reach room temperature beside a
// working foundry. Native heat/steam tests settle quenched metal around 230 C.
export const CASTING_TEMPERATURE = 400;
export const DEVICE_TYPES = Object.freeze({
  foundation: { name: 'Refractory block', cost: 1, color: '#929ba8', description: 'Stackable tungsten deck. Build catch walls, chutes and platforms.' },
  belt: { name: 'Conveyor', cost: 2, color: '#e4b45c', description: 'Moves loose grains forward along its deck.' },
  separator: { name: 'Separator', cost: 10, color: '#b7d077', description: 'Selected grains go forward. Other grains go right.' },
  ship: { name: 'Shipping intake', cost: 12, color: '#d9be84', description: 'Ships gold nuggets and cooled metal that enter its mouth.' },
  miner: { name: 'Mining agent', cost: 18, color: '#eda071', description: 'Drills the nearby face into loose debris. Catch its output.' },
  lift: { name: 'Grain lift', cost: 8, color: '#c8a7dc', description: 'Launches loose grains upward. Build a catch above it.' },
  pump: { name: 'Pump', cost: 14, color: '#7cbdd1', description: 'Moves real liquid from its inlet to an elevated outlet.' },
  heater: { name: 'Furnace', cost: 20, color: '#ea8765', factoryLegacy: true, description: 'Legacy built-in furnace. Existing machines keep their original heating behavior.' },
  hearth: { name: 'Coal hearth', cost: 20, color: '#ea8765', description: 'Thin tungsten shell. Feed coal behind the charge. Catch molten overflow beyond the raised front lip.' },
  gate: { name: 'Material gate', cost: 4, color: '#a6bd9c', description: 'A physical shutter. Open it to release material; closure waits for a clear opening.' },
});
export const FILTER_IDS = [E.NUGGETS, E.SAND, E.STONE, E.SCRAP, E.BROKENCOAL];
export const QUARRY_SPAWN = [48, 8, 84];
export const QUARRY_STARTERS = [
  { id: 'starter-belt', type: 'belt', x: 48, y: 8, z: 48, rotation: 0 },
  { id: 'starter-sorter', type: 'separator', x: 48, y: 8, z: 52, rotation: 0, filter: E.NUGGETS },
  { id: 'starter-output', type: 'belt', x: 48, y: 8, z: 56, rotation: 0 },
  { id: 'starter-ship', type: 'ship', x: 48, y: 8, z: 60, rotation: 0 },
];
// Rotate local cell indices inside the device's 4x4 footprint. Coordinates
// outside it describe ports; the same transform works for those too.
export function deviceCell(d, x, y, z) {
  for (let i = 0; i < d.rotation; i++) [x, z] = [3 - z, x];
  return [d.x + x, d.y + y, d.z + z];
}
export function deviceDirection(d) {
  return [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]][d.rotation];
}
export const baseMaterial = type => ['heater', 'hearth', 'pump', 'ship', 'foundation'].includes(type) ? E.TUNGSTEN : E.INSULATOR;

import { HOMES, FLOOR, HOME_Z } from './state.js';
import { CITY_FOLK_TOWN } from '../../world/scenes/cityFolk/town.js';
import { CITY_FOLK_CITY } from '../../world/scenes/cityFolk/city.js';

const yaw = { south: 0, west: -Math.PI / 2, north: Math.PI, east: Math.PI / 2 };
export function buildingPoint(b, x, z) {
  return { x: b.at[0] + Math.cos(b.yaw) * x + Math.sin(b.yaw) * z,
    y: b.floor, z: b.at[1] - Math.sin(b.yaw) * x + Math.cos(b.yaw) * z };
}
const item = (kind, x, z, rotation = 0, service = null) => ({ kind, x, z, rotation, service });
const person = (name, species, shirt, text, service = null) => ({ name, species, shirt, color: '#d9b487', pitch: 1.05, text, service });
const interiors = {
  townHall: { occupant: person('Mara', 'bear', '#789aaa', 'Welcome to town hall. The reception desk has today’s town notes.'), items: [item('writingBureau', -6, 0, 0, 'notes'), item('grandfatherClock', 6, 0), item('cottageChair', -6, 5), item('cottageShelf', 6, 5)] },
  nookShop: { occupant: person('Nutmeg', 'cat', '#83a274', 'Creek Supply stocks useful things for cozy homes. Browse the desk catalogue or ask me for an order.', 'catalogue'), items: [item('workshopDesk', -8, 0, 0, 'catalogue'), item('cottageShelf', 8, 0), item('workshopShelf', 8, 4), item('botanicalPlant', -8, 4)] },
  ableShop: { occupant: person('Tansy', 'rabbit', '#bf818e', 'Welcome to Thread & Thimble. Try the sewing bench: I can help you choose a new outfit.', 'outfit'), items: [item('workshopDesk', -8, 0, 0, 'outfit'), item('dresser', 8, 0), item('cottageChair', -8, 4), item('cottageShelf', 8, 4)] },
  museum: { occupant: person('Otis', 'bear', '#8a859f', 'The creek fish and old tools each have a story. Walk up to an exhibit to hear it.'), items: [item('aquariumStand', -12, 0, 0, 'fish'), item('workshopDesk', 12, 0, 0, 'tools'), item('botanicalPlant', -12, 6, 0, 'garden'), item('grandfatherClock', 12, 6, 0, 'clock')] },
  cafe: { occupant: person('Juniper', 'cat', '#9c7c60', 'Welcome to The Perch. There is always time for a cup and a little conversation.', 'coffee'), items: [item('writingBureau', 6, -3, 0, 'coffee'), item('table', 6, 3), item('chair', 6, 7), item('chair', 9, 3, 1), item('cottageShelf', 6, -7)] },
  emporium: { occupant: person('Lumen', 'cat', '#ac985e', 'Lantern Emporium carries every furniture set. The order desk sends your selection straight to your pockets.', 'catalogue'), items: [item('writingBureau', -10, 7, 0, 'catalogue'), item('workshopShelf', -17, -7), item('cottageShelf', -17, 0), item('botanicalShelf', 17, -7), item('botanicalSofa', 13, 4), item('grandfatherClock', 17, 9), item('aquariumStand', -17, 9)] },
  tailor: { occupant: person('Silke', 'rabbit', '#b78399', 'This is our city atelier. The sewing desk is ready whenever you fancy a different outfit.', 'outfit'), items: [item('workshopDesk', -10, 0, 0, 'outfit'), item('workshopDesk', 10, 0), item('dresser', -17, -7), item('dresser', 17, -7), item('cottageChair', -10, 5), item('cottageShelf', 17, 7)] },
  theatre: { occupant: person('Bram', 'bear', '#b97368', 'Welcome to Marquee Theatre. Take a seat, then visit the stage for tonight’s little performance.', 'show'), items: [item('workshopDesk', 0, -13, 0, 'show'), ...[-12, -7, 7, 12].flatMap(x => [item('cottageChair', x, 0, 2), item('cottageChair', x, 6, 2)]), item('lamp', -8, -13), item('lamp', 8, -13)] },
};
const cottages = [
  { name: 'Hazel’s reading cottage', occupant: person('Hazel', 'bear', '#a783a4', 'One chapter, one pot of tea. My reading chair is never in a hurry.'), items: [item('cottageBed', -7, 1), item('cottageShelf', 7, 0), item('rockingChair', 7, 5), item('writingBureau', -7, 6)] },
  { name: 'Fern’s garden cottage', occupant: person('Fern', 'rabbit', '#7caa73', 'A home should grow with you. I leave the middle clear so visitors get sunlight too.'), items: [item('botanicalBed', -7, 1), item('botanicalPlant', 7, 0, 0, 'garden'), item('botanicalSofa', 7, 5), item('botanicalLamp', -7, 6)] },
  { name: 'Rivet’s workshop cottage', occupant: person('Rivet', 'cat', '#668ca4', 'I make tiny inventions. The workbench is ready for a curious visitor.', 'tools'), items: [item('bunkBed', -7, 1), item('workshopDesk', 7, 0, 0, 'tools'), item('workshopShelf', 7, 5), item('workshopLamp', -7, 6)] },
  { name: 'Coral’s riverside cottage', occupant: person('Coral', 'bear', '#c98878', 'I collect river stories, not just fish. Come see what is swimming today.'), items: [item('bed', -7, 1), item('aquariumStand', 7, 0, 0, 'fish'), item('sofa', 7, 5), item('lamp', -7, 6)] },
];
export function villageBuildings(expanded = false) {
  const originals = HOMES.map((x, home) => ({ id: `home-${home}`, name: home ? 'Neighbor’s home' : 'Your home', at: [x, HOME_Z], entry: [x, HOME_Z - 11], floor: FLOOR, half: [12, 12], yaw: yaw.north, width: 8, height: 11, original: true }));
  if (!expanded) return originals;
  const town = Object.entries(interiors).filter(([id]) => CITY_FOLK_TOWN.landmarks[id]).map(([id, interior]) => {
    const b = CITY_FOLK_TOWN.landmarks[id], angle = yaw[b.facing];
    return { ...b, ...interior, id, yaw: angle, width: 8, height: 12, half: b.facing === 'west' ? [b.half[1], b.half[0]] : b.half };
  });
  const homes = CITY_FOLK_TOWN.landmarks.cottages.map((b, i) => ({ ...b, ...cottages[i], id: `cottage-${i}`, yaw: 0, width: 8, height: 12 }));
  const city = ['emporium', 'tailor', 'theatre'].map(id => ({ ...CITY_FOLK_CITY.landmarks[id], ...interiors[id], id, name: { emporium: 'Lantern Emporium', tailor: 'City atelier', theatre: 'Marquee Theatre' }[id], yaw: 0, width: 9, doorOffset: 0.5, height: 12 }));
  return [...originals, ...town, ...homes, ...city];
}
export function buildingAt(buildings, p) {
  if (!p) return null;
  return buildings.find(b => p.y >= b.floor - 1 && p.y < b.floor + 14 && Math.abs(p.x - b.at[0]) < (Math.abs(Math.cos(b.yaw)) * b.half[0] + Math.abs(Math.sin(b.yaw)) * b.half[1]) - 1.5
    && Math.abs(p.z - b.at[1]) < (Math.abs(Math.sin(b.yaw)) * b.half[0] + Math.abs(Math.cos(b.yaw)) * b.half[1]) - 1.5) ?? null;
}
// Match the authored EMPTY openings; nothing here edits voxel matter or saves.
export function buildingDoors(buildings) {
  const doors = buildings.map(b => ({ id: b.id, name: b.name, x: b.entry[0] + Math.cos(b.yaw) * (b.doorOffset ?? 0), z: b.entry[1] - Math.sin(b.yaw) * (b.doorOffset ?? 0), floor: b.floor, yaw: b.yaw, width: b.width, height: b.height }));
  if (buildings.some(b => b.id === 'museum')) doors.push({ id: 'museum-cafe', name: 'Museum / café', x: 278.5, z: -79.5, floor: 36, yaw: Math.PI / 2, width: 7, height: 12 });
  return doors;
}

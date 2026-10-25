import { E, ELEMENTS, K } from '../../elements.js';
import { createExhibitCatalog, STORAGE_REQUIREMENTS } from '../catalog.js';
import { ceilingLight } from './fixtures.js';

const COLUMNS = 24, ROWS = 8, TIERS = 2;
export const ARCHIVE_CAPACITY = COLUMNS * ROWS * TIERS;

// The story has authored hero exhibits. Every OTHER registry entry is stocked
// once here, grouped by physical kind and then storage status, never palette.
export function buildArchive({ box, elements = ELEMENTS, featured = [] }) {
  const catalog = createExhibitCatalog(elements);
  const heroes = new Set(featured);
  const order = ['air', 'powder', 'solid', 'liquid', 'gas', 'effect'];
  const entries = catalog.filter(e => !heroes.has(e.key)).sort((a, b) =>
    order.indexOf(a.category) - order.indexOf(b.category) ||
    a.status.localeCompare(b.status) || (a.elementId ?? -a.toolId) - (b.elementId ?? -b.toolId));
  if (entries.length > ARCHIVE_CAPACITY) throw new RangeError(`Preservation archive capacity ${ARCHIVE_CAPACITY} exceeded: ${entries.length} exhibits.`);
  box(4, 0, 8, 244, 2, 116, E.WALL);
  box(4, 2, 8, 6, 24, 116, E.WALL);
  box(242, 2, 8, 244, 24, 116, E.WALL);
  box(4, 2, 8, 244, 24, 10, E.WALL);
  box(4, 2, 114, 244, 24, 116, E.WALL);
  box(4, 24, 8, 244, 26, 116, E.WALL);
  box(90, 2, 114, 104, 14, 116, E.EMPTY);
  for (const x of [18, 64, 110, 156, 202]) for (const z of [24, 60, 96]) ceilingLight(box, x, 22, z, 12);
  const plaques = [{
    cell: [106, 10, 114], normal: [0, 0, -1],
    text: 'ACCOUNTING / Working exhibits upstairs. Everything else has a place here.',
  }];
  const stocks = [];
  for (let slot = 0; slot < entries.length; slot++) {
    const entry = entries[slot];
    const column = slot % COLUMNS, row = Math.floor(slot / COLUMNS) % ROWS;
    const tier = Math.floor(slot / (COLUMNS * ROWS));
    const x = 12 + column * 9, z = 16 + row * 12, y = 2 + tier * 10;
    // A shelf with separate glass cells: no shared specimen walls or air.
    box(x, y, z, x + 7, y + 1, z + 6, E.METAL);
    box(x, y + 1, z, x + 7, y + 7, z + 6, E.GLASS);
    box(x + 1, y + 1, z + 1, x + 6, y + 6, z + 5, E.EMPTY);
    if (entry.status === 'candidate' && entry.type === 'material') {
      const e = elements.find(e => e.key === entry.key);
      const height = e.kind === K.GAS ? 5 : e.kind === K.SOLID ? 2 : 3;
      box(x + 2, y + 1, z + 2, x + 5, y + 1 + height, z + 4, e.id);
    } else {
      // Empty, with a visible dark plinth: absence is explicit, never a fake sample.
      box(x + 2, y + 1, z + 2, x + 5, y + 2, z + 4, E.WALL);
    }
    const plaque = {
      cell: [x + 3, y, z], normal: [0, 0, -1], elementKey: entry.key, archive: true,
      text: `${entry.name} / ${entry.category} / ${entry.status === 'candidate' ? 'isolated specimen' :
        `needs ${STORAGE_REQUIREMENTS[entry.requirements.find(key => !STORAGE_REQUIREMENTS[key].supported)].label.toLowerCase()}`}`.slice(0, 80),
    };
    plaques.push(plaque);
    stocks.push({ ...entry, bounds: [x, y, z, x + 7, y + 7, z + 6] });
  }
  return { plaques, stocks, catalog };
}

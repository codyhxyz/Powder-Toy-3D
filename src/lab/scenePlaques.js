import { MAX_SIGNS } from '../shaders/probe.js';

export const SCENE_PLAQUE_LIMIT = 32;

export function nearbyPlaques(records, eye, limit = SCENE_PLAQUE_LIMIT) {
  return records.map((record, i) => ({
    ...record, sceneKey: record.elementKey ? `element:${record.elementKey}` : `story:${i}`,
    distance: record.cell.reduce((sum, n, axis) => sum + (n - eye[axis]) ** 2, 0),
  })).filter(record => record.distance < 96 ** 2 && Math.abs(record.cell[1] - eye[1]) < 19)
    .sort((a, b) => a.distance - b.distance).slice(0, Math.max(0, limit));
}

// Keep the complete authored/catalog manifest, but probe only nearby plates.
// Manual signs retain their slots and are never removed by this owner.
export class ScenePlaques {
  constructor(signs) { this.signs = signs; this.records = []; this.owned = new Map(); this.cell = ''; }
  set(records) {
    if (records === this.records) return;
    for (const sign of this.owned.values()) this.signs.remove(sign);
    this.owned.clear();
    this.records = records;
    this.cell = '';
  }
  update(eye) {
    // Adopt saved generated plates, instead of duplicating them after a save load.
    for (const sign of this.signs.list) if (sign.sceneKey) this.owned.set(sign.sceneKey, sign);
    for (const [key, sign] of this.owned) if (!this.signs.list.includes(sign)) this.owned.delete(key);
    const manual = this.signs.list.filter(sign => !sign.sceneKey).length;
    const cell = `${eye.map(n => Math.floor(n / 4)).join(',')}:${manual}:${this.signs.list.length}`;
    if (cell === this.cell) return;
    const selected = nearbyPlaques(this.records, eye, Math.min(SCENE_PLAQUE_LIMIT, MAX_SIGNS - manual));
    const keep = new Set(selected.map(record => record.sceneKey));
    for (const [key, sign] of this.owned) if (!keep.has(key)) {
      this.signs.remove(sign); this.owned.delete(key);
    }
    const vec = ([x, y, z]) => ({ x, y, z });
    for (const record of selected) if (!this.owned.has(record.sceneKey)) {
      const sign = this.signs.add({ ...record, cell: vec(record.cell), normal: vec(record.normal), edit: false, world: true });
      if (sign) this.owned.set(record.sceneKey, sign);
    }
    this.cell = `${eye.map(n => Math.floor(n / 4)).join(',')}:${manual}:${this.signs.list.length}`;
  }
}

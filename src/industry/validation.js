import { DEVICE_TYPES, FILTER_IDS, INDUSTRY_LIMIT } from './catalog.js';
import { E } from '../elements.js';
import { BODY_WIDTH, BODY_HEIGHT } from '../pov/constants.js';

export const deviceHeight = d => d.type === 'pump' ? 7 : 4;
export const overlaps = (a, b) => a.x < b.x + 4 && a.x + 4 > b.x && a.y < b.y + deviceHeight(b) && a.y + deviceHeight(a) > b.y && a.z < b.z + 4 && a.z + 4 > b.z;
export function deviceSpec(value, dims) {
  if (!value || !Object.hasOwn(DEVICE_TYPES, value.type)) throw new Error('Choose an Industry machine');
  const { type, x, y, z, rotation = 0, filter = E.NUGGETS, powered = false } = value;
  if (![x,y,z,rotation].every(Number.isInteger) || rotation < 0 || rotation > 3) throw new Error('Invalid machine coordinates or rotation');
  if (!Array.isArray(dims) || dims.length !== 3 || !dims.every(n => Number.isInteger(n) && n > 0)) throw new Error('Invalid Industry grid');
  if ([x,y,z].some((n,i) => n < 0 || n + (i === 1 ? deviceHeight(value) : 4) > dims[i])) throw new Error('Machine must fit inside the grid');
  if (!FILTER_IDS.includes(filter) || typeof powered !== 'boolean') throw new Error('Invalid machine filter or drive');
  return { type, x, y, z, rotation, filter, powered };
}
export function validateDevices(values, dims) {
  if (!Array.isArray(values) || values.length > INDUSTRY_LIMIT) throw new Error('Invalid Industry device count');
  const ids = new Set(), devices = [];
  for (const v of values) {
    const d = deviceSpec(v, dims);
    if (typeof v.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(v.id) || ids.has(v.id)) throw new Error('Invalid or duplicate Industry device ID');
    if (devices.some(other => overlaps(d, other))) throw new Error('Industry machines overlap');
    ids.add(v.id); devices.push({ id: v.id, ...d });
  }
  return devices;
}
export function overlapsBody(d, feet) {
  if (!feet) return false;
  const r = BODY_WIDTH / 2;
  return d.x < feet.x + r && d.x + 4 > feet.x - r && d.z < feet.z + r && d.z + 4 > feet.z - r && d.y < feet.y + BODY_HEIGHT && d.y + deviceHeight(d) > feet.y;
}

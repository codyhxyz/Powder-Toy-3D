import { WILLOW_COVE as COVE } from '../../world/scenes/willowCove.js';
import { ITEMS } from './catalog.js';
export { ITEMS } from './catalog.js';
export { RESIDENTS } from './residents.js';

// Animal Crossing's pockets and home storage; Minecraft-style snapped placement.
// Furniture coordinates are relative to the room, never the streaming window.
export const HOMES = [COVE.COTTAGE_A, COVE.COTTAGE_B, COVE.COTTAGE_C, COVE.COTTAGE_D];
export const FLOOR = COVE.LOW, HOME_Z = COVE.COTTAGE_Z, POCKETS = 20;
export const DRESSER = Object.freeze({ id: 'dresser', kind: 'dresser', x: 6, z: 6, rotation: 0 });
export function initialState() {
  return { version: 1, placed: [
    { id: 'bed', kind: 'bed', x: -6, z: 5, rotation: 0 },
    { id: 'table', kind: 'table', x: -6, z: -3, rotation: 0 },
    { id: 'chair', kind: 'chair', x: -6, z: -7, rotation: 0 },
    { id: 'lamp', kind: 'lamp', x: 7, z: -6, rotation: 0 },
  ], pockets: [{ id: 'plant', kind: 'plant' }, { id: 'sofa', kind: 'sofa' }], storage: [{ id: 'chair2', kind: 'chair' }, { id: 'lamp2', kind: 'lamp' }] };
}
export function bounds(item) {
  const spec = ITEMS[item.kind], turn = item.rotation % 2;
  const w = turn ? spec.d : spec.w, d = turn ? spec.w : spec.d;
  return { x: item.x - w / 2, z: item.z - d / 2, w, d };
}
// Pocket-only placement preview. Placed pieces use grounded grid movement.
export function carryTarget(item, player, yaw) {
  const b = bounds(item), sx = Math.sin(yaw), cz = Math.cos(yaw);
  const reach = 1.5 + Math.abs(sx) * b.w / 2 + Math.abs(cz) * b.d / 2;
  return { ...item, x: Math.round(player.x - sx * reach), z: Math.round(player.z - cz * reach) };
}
export function overlaps(a, b, margin = 0) {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.z < b.z + b.d + margin && a.z + a.d + margin > b.z;
}
const footprint = (p, radius) => ({ x: p.x - radius, z: p.z - radius, w: radius * 2, d: radius * 2 });
const sweep = (a, b) => ({
  x: Math.min(a.x, b.x), z: Math.min(a.z, b.z),
  w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
  d: Math.max(a.z + a.d, b.z + b.d) - Math.min(a.z, b.z),
});
const inside = b => b.x >= -9 && b.z >= -9 && b.x + b.w <= 9 && b.z + b.d <= 9;
const ease = value => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
export function cardinal({ x, z }) {
  if (!Number.isFinite(x + z) || Math.hypot(x, z) < 0.2) return null;
  // Animal Crossing's rook movement: X wins exact stick/keyboard ties.
  return Math.abs(x) >= Math.abs(z) ? { x: Math.sign(x), z: 0 } : { x: 0, z: Math.sign(z) };
}
export function playerPathClear(state, from, to, radius = 0.8, ignore = null) {
  if (!from || !to) return false;
  const path = sweep(footprint(from, radius), footprint(to, radius));
  return inside(path) && ![DRESSER, ...state.placed].some(i => i.id !== ignore && overlaps(path, bounds(i), 0.05));
}
function sides(item, radius) {
  const b = bounds(item), gap = radius + 0.12;
  return [
    { x: b.x - gap, z: item.z }, { x: b.x + b.w + gap, z: item.z },
    { x: item.x, z: b.z - gap }, { x: item.x, z: b.z + b.d + gap },
  ];
}
export function gripPosition(state, item, player, radius = 0.8) {
  return sides(item, radius)
    .sort((a, b) => Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z))
    .find(p => Math.hypot(p.x - player.x, p.z - player.z) <= 3.5 && playerPathClear(state, player, p, radius)) ?? null;
}
export function standPosition(state, item, from, entry, radius = 0.8) {
  return [entry, ...sides(item, radius)].find(p =>
    playerPathClear(state, p, p, radius) && playerPathClear(state, from, p, radius, item.id)) ?? null;
}
export function gripMove(state, item, player, direction, radius = 0.8) {
  if (!direction || !((Math.abs(direction.x) === 1 && direction.z === 0)
    || (direction.x === 0 && Math.abs(direction.z) === 1))) return { error: 'Move one direction at a time.' };
  const target = { ...item, x: item.x + direction.x, z: item.z + direction.z };
  const nextPlayer = { x: player.x + direction.x, z: player.z + direction.z };
  const error = placementError(state, target);
  if (error) return { error };
  const path = sweep(bounds(item), bounds(target));
  if ([DRESSER, ...state.placed].some(i => i.id !== item.id && overlaps(path, bounds(i), 0.25))
    || !playerPathClear(state, player, nextPlayer, radius, item.id)) return { error: 'No room to push or pull that way.' };
  return { target, player: nextPlayer };
}
export const moveProgress = seconds => ease((seconds - 0.07) / 0.28);
export function restPose(item, size = 1) {
  const spec = ITEMS[item?.kind];
  if (!spec || !(spec.seatHeight || spec.lyingHeight)) return null;
  const sleeping = !!spec.lyingHeight, yaw = item.rotation * Math.PI / 2;
  const z = sleeping ? -2.2 : -0.15;
  return {
    kind: sleeping ? 'sleep' : 'sit', x: item.x + Math.sin(yaw) * z,
    z: item.z + Math.cos(yaw) * z,
    y: sleeping ? spec.lyingHeight + 0.65 * size : spec.seatHeight - 1.25 * size, yaw,
  };
}
export function drawerFrame(seconds, closing = false, from = 1) {
  if (closing) {
    const t = ease(seconds / 0.25), extension = from * (1 - t);
    return { reach: 1 - t, pull: extension, extension, ready: false, done: seconds >= 0.25 };
  }
  const reach = ease(seconds / 0.22), pull = ease((seconds - 0.22) / 0.43);
  return { reach, pull, extension: pull, ready: seconds >= 0.65, done: false };
}
export function placementError(state, item, player = null) {
  if (!ITEMS[item.kind] || item.kind === 'dresser' || !Number.isInteger(item.x) || !Number.isInteger(item.z) || !Number.isInteger(item.rotation) || item.rotation < 0 || item.rotation > 3) return 'Choose a valid furniture position.';
  const b = bounds(item);
  if (b.x < -9 || b.z < -9 || b.x + b.w > 9 || b.z + b.d > 9) return 'Keep furniture inside the room.';
  // A permanent two-cell aisle joins the door, spawn and back wall; never trap a returning player.
  if (overlaps(b, { x: -2, z: -10, w: 4, d: 20 })) return 'Leave the doorway and center aisle clear.';
  if ([DRESSER, ...state.placed].some(p => p.id !== item.id && overlaps(b, bounds(p), 0.25))) return 'That space is already occupied.';
  if (player && overlaps(b, { x: player.x - 1, z: player.z - 1, w: 2, d: 2 })) return 'Move your character out of that space first.';
  return null;
}
export function validState(s) {
  if (!s || s.version !== 1 || !['placed', 'pockets', 'storage'].every(k => Array.isArray(s[k])) || s.pockets.length > POCKETS) return false;
  const all = [...s.placed, ...s.pockets, ...s.storage];
  if (all.length < 8 || all.length > 512 || new Set(all.map(i => i?.id)).size !== all.length) return false;
  const originals = new Map([...initialState().placed, ...initialState().pockets, ...initialState().storage].map(i => [i.id, i.kind]));
  // Keep every original item when extending a v1 save with catalogue orders.
  return [...originals].every(([id, kind]) => all.some(i => i?.id === id && i.kind === kind))
    && all.every(i => i && (originals.get(i.id) === i.kind
      || (/^order-[1-9]\d{0,5}$/.test(i.id) && Object.hasOwn(ITEMS, i.kind) && i.kind !== 'dresser')))
    && s.placed.every(i => !placementError(s, i));
}
// Atomic actions: a rejected move never removes an item from its original container.
export function change(state, action, { home = false, dresser = false, player = null } = {}) {
  if (!validState(state)) return { error: 'The furniture save is invalid.' };
  const next = structuredClone(state), { id, type } = action;
  if (type === 'order') {
    if (!home) return { error: 'Order furniture from the catalogue in your own home.' };
    if (!Object.hasOwn(ITEMS, action.kind) || action.kind === 'dresser') return { error: 'Choose a catalogue item.' };
    if (next.pockets.length >= POCKETS) return { error: 'Your pockets are full. Store or place something first.' };
    const all = [...next.placed, ...next.pockets, ...next.storage];
    if (all.length >= 512) return { error: 'Your furniture collection is full.' };
    const ids = new Set(all.map(i => i.id));
    let serial = 1;
    while (ids.has(`order-${serial}`)) serial++;
    next.pockets.push({ id: `order-${serial}`, kind: action.kind });
    return { state: next };
  }
  const source = ['placed', 'pockets', 'storage'].find(k => next[k].some(i => i.id === id));
  if (!source) return { error: 'Choose a furniture item.' };
  const item = next[source].find(i => i.id === id);
  let target;
  if (type === 'place') {
    if (!home || source === 'storage') return { error: 'Place furniture from your pockets inside your own home.' };
    const placed = { ...item, x: action.x, z: action.z, rotation: action.rotation };
    const error = placementError(next, placed, player);
    if (error) return { error };
    Object.assign(item, placed); target = 'placed';
  } else if (type === 'take' && source === 'placed') {
    if (!home) return { error: 'You can only rearrange your own home.' };
    target = 'pockets';
  } else if (type === 'store' && source === 'pockets') {
    if (!home || !dresser) return { error: 'Stand beside your dresser to store furniture.' };
    target = 'storage';
  } else if (type === 'withdraw' && source === 'storage') {
    if (!home || !dresser) return { error: 'Stand beside your dresser to take furniture out.' };
    target = 'pockets';
  } else return { error: 'That action is not available.' };
  if (target === 'pockets' && next.pockets.length >= POCKETS) return { error: 'Your pockets are full.' };
  next[source] = next[source].filter(i => i.id !== id);
  next[target].push(target === 'placed' ? item : { id: item.id, kind: item.kind });
  return { state: next };
}
export function loadState(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { state: initialState(), writable: true };
    const state = JSON.parse(raw);
    if (!validState(state)) throw new Error('Invalid save');
    return { state, writable: true };
  } catch {
    // Preserve unreadable/newer saves rather than replacing them with the starter room.
    return { state: initialState(), writable: false, warning: 'Could not read your furniture save. Playing temporarily; the existing save will not be overwritten.' };
  }
}

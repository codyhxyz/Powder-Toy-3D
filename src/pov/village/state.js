import { WILLOW_COVE as COVE } from '../../world/scenes/willowCove.js';

// Animal Crossing's pockets and home storage; Minecraft-style snapped placement.
// Furniture coordinates are relative to the room, never the streaming window.
export const HOMES = [COVE.COTTAGE_A, COVE.COTTAGE_B, COVE.COTTAGE_C, COVE.COTTAGE_D];
export const FLOOR = COVE.LOW, HOME_Z = COVE.COTTAGE_Z, POCKETS = 20;
export const ITEMS = Object.freeze({
  bed: { name: 'Patchwork bed', w: 4, d: 6, h: 2.85, color: '#7ba995' },
  chair: { name: 'Oak chair', w: 2, d: 2, h: 3.4, color: '#cf9c62' },
  table: { name: 'Round table', w: 4, d: 4, h: 3.05, color: '#d4ac77' },
  sofa: { name: 'Sage sofa', w: 6, d: 3, h: 3.1, color: '#81a994' },
  lamp: { name: 'Sunflower lamp', w: 2, d: 2, h: 4.2, color: '#e5bd66' },
  plant: { name: 'Leafy plant', w: 2, d: 2, h: 3.5, color: '#568c61' },
  dresser: { name: 'Oak dresser', w: 4, d: 3, h: 3.65, color: '#c99562' },
});
export const RESIDENTS = [
  { name: 'Maple', species: 'bear', home: 1, color: '#c59471', shirt: '#c87362', pitch: 0.85,
    lines: ['Welcome to Willow Cove! I am Maple. This little cottage is my cozy corner.', 'A chair, a good book, and a friend stopping by. That is my kind of afternoon!', 'Your house is the first cottage on the lane. Try opening your pockets to make it your own.'] },
  { name: 'Clover', species: 'rabbit', home: 2, color: '#e8d8b8', shirt: '#8da76b', pitch: 1.3,
    lines: ['Hi, neighbor! Clover here. Come in! I was just giving my plants a pep talk.', 'I keep my extra furniture in a dresser. More space for hopping around!', 'A room feels different when you turn a chair toward the window. Give it a try!'] },
  { name: 'Pippin', species: 'cat', home: 3, color: '#d9a66a', shirt: '#679fab', pitch: 1.1,
    lines: ['Oh, a visitor! I am Pippin. You can always find me pottering around my home.', 'The river sounds lovely today. Maybe I will take a walk later.', 'No two homes need to look alike. Mine needs a comfy place for a nap!'] },
];
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
// Animal Crossing-style carrying: hold the full-size piece just ahead of the
// player, snapping only the eventual drop position, not opening a floor editor.
export function carryTarget(item, player, yaw) {
  const b = bounds(item), sx = Math.sin(yaw), cz = Math.cos(yaw);
  const reach = 1.5 + Math.abs(sx) * b.w / 2 + Math.abs(cz) * b.d / 2;
  return { ...item, x: Math.round(player.x - sx * reach), z: Math.round(player.z - cz * reach) };
}
export function overlaps(a, b, margin = 0) {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.z < b.z + b.d + margin && a.z + a.d + margin > b.z;
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
  if (all.length !== 8 || new Set(all.map(i => i?.id)).size !== all.length) return false;
  const originals = new Map([...initialState().placed, ...initialState().pockets, ...initialState().storage].map(i => [i.id, i.kind]));
  return all.every(i => i && originals.get(i.id) === i.kind) && s.placed.every(i => !placementError(s, i));
}
// Atomic actions: a rejected move never removes an item from its original container.
export function change(state, action, { home = false, dresser = false, player = null } = {}) {
  if (!validState(state)) return { error: 'The furniture save is invalid.' };
  const next = structuredClone(state), { id, type } = action;
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

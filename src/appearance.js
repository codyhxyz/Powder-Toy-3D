import { E } from './elements.js';
import { PHYS } from './physics.js';

// Authored appearance, not a physical element. Only wood/plant's unused ctype
// and a bounded, reversible cedar-moss damp encoding carry these labels.
// Both fit the existing byte ctype in stamps, saved state and network cells.
export const Appearance = Object.freeze({
  NONE: 0, GRASS: 1, LEAVES: 2,
  LOG_X: 3, LOG_Y: 4, LOG_Z: 5,
  PLANK_X: 6, PLANK_Y: 7, PLANK_Z: 8,
  PLAIN: 9, BARK: 10,
});
const NAMES = Object.fromEntries(Object.entries(Appearance).map(([k, v]) => [k.toLowerCase().replaceAll('_', '-'), v]));
export const APPEARANCE_BASE = 240;
export const CEDAR_BASE = 224;
if (APPEARANCE_BASE + Appearance.BARK > 255 || CEDAR_BASE + PHYS.DAMP_REACH >= APPEARANCE_BASE) {
  throw new Error('Appearance codes must fit the existing ctype byte');
}

export function resolveAppearance(value) {
  const a = typeof value === 'string' ? NAMES[value] : value;
  if (!Object.values(Appearance).includes(a)) throw new Error(`Unknown appearance: ${value}`);
  return a;
}

function allowed(id, a) {
  if (id === E.PLANT) return a === Appearance.GRASS || a === Appearance.LEAVES || a === Appearance.PLAIN;
  if (id === E.WOOD) return a >= Appearance.LOG_X && a <= Appearance.BARK;
  return id === E.MOSS && a === Appearance.LEAVES;
}

export function appearanceOf(id, ctype) {
  const c = Math.floor(ctype);
  if (id === E.MOSS && c >= CEDAR_BASE && c <= CEDAR_BASE + PHYS.DAMP_REACH) return Appearance.LEAVES;
  const a = c - APPEARANCE_BASE;
  return id !== E.MOSS && allowed(id, a) ? a : Appearance.NONE;
}

export function physicalCtype(id, ctype) {
  const c = Math.floor(ctype);
  if (!appearanceOf(id, c)) return c;
  return id === E.MOSS ? c - CEDAR_BASE : 0;
}

export function appearanceCtype(id, ctype, appearance) {
  const a = resolveAppearance(appearance), c = physicalCtype(id, ctype);
  if (a === Appearance.NONE) return c;
  if (!allowed(id, a)) throw new Error(`Appearance ${appearance} is not valid for element ${id}`);
  if (!Number.isInteger(c) || (id === E.MOSS ? c < 0 || c > PHYS.DAMP_REACH : c !== 0)) {
    throw new Error('Appearance cannot replace a physical ctype');
  }
  return id === E.MOSS ? CEDAR_BASE + c : APPEARANCE_BASE + a;
}

export function rotateAppearance(a, turns) {
  if ((turns & 1) === 0) return a;
  if (a === Appearance.LOG_X) return Appearance.LOG_Z;
  if (a === Appearance.LOG_Z) return Appearance.LOG_X;
  if (a === Appearance.PLANK_X) return Appearance.PLANK_Z;
  if (a === Appearance.PLANK_Z) return Appearance.PLANK_X;
  return a;
}

export function rotateAppearanceCtype(id, ctype, turns) {
  const a = appearanceOf(id, ctype);
  return a ? appearanceCtype(id, ctype, rotateAppearance(a, turns)) : ctype;
}

// The shared scene subset disallows bit operations. These arithmetic helpers
// have identical JS/WGSL implementations and preserve physical-ID wrappers.
export const materialWord = (id, appearance = Appearance.NONE) => id + 256 * appearance;
export const materialId = word => word % 256;
export const materialAppearance = word => Math.floor(word / 256);
export const appearanceScope = Object.freeze({
  ...Object.fromEntries(Object.entries(Appearance).map(([k, v]) => [`AP_${k}`, v])),
  materialWord, materialId, materialAppearance,
});

export const appearanceWGSL = /* wgsl */ `
${Object.entries(Appearance).map(([k, v]) => `const AP_${k}: i32 = ${v};`).join('\n')}
const AP_CTYPE_BASE: i32 = ${APPEARANCE_BASE};
const AP_CEDAR_BASE: i32 = ${CEDAR_BASE};
fn appearanceAllowed(id: i32, a: i32) -> bool {
  if (id == E_PLANT) { return a == AP_GRASS || a == AP_LEAVES || a == AP_PLAIN; }
  if (id == E_WOOD) { return a >= AP_LOG_X && a <= AP_BARK; }
  return id == E_MOSS && a == AP_LEAVES;
}
fn appearanceOf(id: i32, ctype: f32) -> i32 {
  let c = i32(floor(ctype));
  if (id == E_MOSS && c >= AP_CEDAR_BASE && c <= AP_CEDAR_BASE + ${PHYS.DAMP_REACH}) { return AP_LEAVES; }
  let a = c - AP_CTYPE_BASE;
  return select(AP_NONE, a, id != E_MOSS && appearanceAllowed(id, a));
}
fn physicalCtype(id: i32, ctype: f32) -> f32 {
  if (appearanceOf(id, ctype) == AP_NONE) { return floor(ctype); }
  if (id == E_MOSS) { return floor(ctype) - f32(AP_CEDAR_BASE); }
  return 0.0;
}
fn appearanceCtype(id: i32, ctype: f32, a: i32) -> f32 {
  let c = physicalCtype(id, ctype);
  if (a == AP_NONE || !appearanceAllowed(id, a)) { return c; }
  if (id == E_MOSS) {
    if (c >= 0.0 && c <= ${PHYS.DAMP_REACH}.0) { return f32(AP_CEDAR_BASE) + c; }
  } else if (c == 0.0) { return f32(AP_CTYPE_BASE + a); }
  return c;
}
fn materialWord(id: i32, appearance: i32) -> i32 { return id + 256 * appearance; }
fn materialId(word: i32) -> i32 { return word % 256; }
fn materialAppearance(word: i32) -> i32 { return word / 256; }
`;

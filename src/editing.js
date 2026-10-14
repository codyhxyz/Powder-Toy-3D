import { ELEMENTS, E } from './elements.js';
import { PHYS } from './physics.js';

// The Powder Toy's editing tools in 3D (TPT: src/simulation/Editing.cpp,
// src/gui/game/tool/PropertyTool.cpp, src/gui/game/GameView.cpp):
//   PROP          set one property of the cells under the brush
//   line          Shift-drag: the brush swept along a segment on the paint plane
//   box           Ctrl/⌘-drag: a cuboid between the drag's corners
//   flood fill    Ctrl/⌘+Shift-click: a connected region
//   replace mode / specific delete, with a target element
// The brush's kernel (shaders/passes.js paintUpdateWGSL, an edit: sim.paint)
// applies all of them per cell; this file holds the rules the app and
// multiplayer share, kept free of the DOM and of the GPU so
// tools/editing-check.mjs can test them in node.

// ---- PROP (TPT's PropertyTool) ----
// The properties worth setting here, in the dialog's order: TPT's particle
// properties that the 3D state holds (type, ctype, temp, life, vx/vy, plus vz),
// and the cell's air pressure, which TPT keeps outside its particles. The
// index of each is its PROP_* in the brush's kernel.
export const PROP_FIELDS = [
  { key: 'type', label: 'Element (type)', hint: 'An element name or abbreviation: water, WATR, LAVA' },
  { key: 'ctype', label: 'ctype', hint: 'An element (what lava melted from, what clone copies) or a number' },
  { key: 'temp', label: 'Temperature', hint: '°C by default; end with K or F for kelvin or Fahrenheit' },
  { key: 'life', label: 'Life', hint: 'A number: a fuse\'s or fire\'s countdown, a fuel\'s store' },
  { key: 'vx', label: 'Velocity x', hint: `Cells per step, ${-PHYS.V_MAX} to ${PHYS.V_MAX}` },
  { key: 'vy', label: 'Velocity y (up)', hint: `Cells per step, ${-PHYS.V_MAX} to ${PHYS.V_MAX}` },
  { key: 'vz', label: 'Velocity z', hint: `Cells per step, ${-PHYS.V_MAX} to ${PHYS.V_MAX}` },
  { key: 'pressure', label: 'Air pressure', hint: `${PHYS.P_MIN} to ${PHYS.P_MAX}; it sets the air too, not only matter` },
];
export const PROP = Object.fromEntries(PROP_FIELDS.map((f, i) => [f.key.toUpperCase(), i]));
export const propIndex = (key) => PROP_FIELDS.findIndex((f) => f.key === key);
// ctype shares state A's w with the cell's random seed (the fraction): past
// this the float has too few bits left for the seed.
export const PROP_CTYPE_MAX = 4095;
// life has no physical bound; this keeps a typo from parking a number the
// shaders' timers would take forever to count down.
export const PROP_LIFE_MAX = 1e6;
const KELVIN = 273.15;       // °C at 0 K
const F_PER_C = 1.8, F_AT_0C = 32;

// (WGSL consts; the name is the GLSL version's, docs/webgpu.md W2)
export const propGLSL = () => PROP_FIELDS.map((f, i) => `const PROP_${f.key.toUpperCase()}: u32 = ${i}u;`).join('\n');

// An element by TPT's rules (AccessPropertyParse.cpp: GetParticleType, then a
// plain number): its key, abbreviation or name in any case, or its id.
export function parseElement(text) {
  const s = String(text).trim();
  if (!s) return -1;
  const u = s.toUpperCase();
  const it = ELEMENTS.find((e) => e.key === u || e.abbr === u || e.name.toUpperCase() === u)
    ?? ELEMENTS.find((e) => e.key === u.replace(/[\s-]+/g, '_'));
  if (it) return it.id;
  return /^\d+$/.test(s) && +s < ELEMENTS.length ? +s : -1;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const num = (s) => (NUMBER.test(s) ? Number(s) : NaN);
const fmt = (v) => String(+v.toFixed(4));

// TPT's StringToTemperature (Format.cpp): a number, in °C here unless it ends
// in K or F (TPT's default scale is the player's; ours is °C).
export function parseTemperature(text) {
  let s = String(text).trim().toUpperCase().replace(/°/g, '');
  let toC = (v) => v;
  if (s.endsWith('K')) { s = s.slice(0, -1); toC = (v) => v - KELVIN; }
  else if (s.endsWith('F')) { s = s.slice(0, -1); toC = (v) => (v - F_AT_0C) / F_PER_C; }
  else if (s.endsWith('C')) s = s.slice(0, -1);
  const v = num(s.trim());
  return Number.isFinite(v) ? toC(v) : NaN;
}

const range = (v, lo, hi, unit = '') => (v >= lo && v <= hi ? null : `Between ${lo} and ${hi}${unit}`);
// Whether a property's value is in range (the host checks guests' values with
// this too): an error message, or null.
export function propRangeError(field, v) {
  if (!Number.isFinite(v)) return 'Not a number';
  switch (field) {
    case PROP.TYPE: return Number.isInteger(v) && v >= 0 && v < ELEMENTS.length ? null : 'Not an element';
    case PROP.CTYPE: return Number.isInteger(v) && v >= 0 && v <= PROP_CTYPE_MAX ? null : `An element, or a whole number up to ${PROP_CTYPE_MAX}`;
    case PROP.TEMP: return range(v, PHYS.CELL_TEMP_MIN, PHYS.CELL_TEMP_MAX, ' °C');
    case PROP.LIFE: return range(v, -PROP_LIFE_MAX, PROP_LIFE_MAX);
    case PROP.VX: case PROP.VY: case PROP.VZ: return range(v, -PHYS.V_MAX, PHYS.V_MAX);
    case PROP.PRESSURE: return range(v, PHYS.P_MIN, PHYS.P_MAX);
    default: return 'Not a property';
  }
}

// TPT's AccessProperty::Parse: the text typed for a property, as
// { ok: true, value, shown } or { ok: false, error }. shown is how the HUD
// names the value.
export function parseProp(field, text) {
  const s = String(text ?? '').trim();
  if (!s) return { ok: false, error: 'Type a value' };
  const element = field === PROP.TYPE || field === PROP.CTYPE ? parseElement(s) : -1;
  let v;
  if (element >= 0) v = element;
  else if (field === PROP.TYPE) return { ok: false, error: 'Not an element' };
  else if (field === PROP.TEMP) v = parseTemperature(s);
  else v = num(s);
  const error = propRangeError(field, v);
  if (error) return { ok: false, error };
  const shown = element >= 0 ? ELEMENTS[v].name : field === PROP.TEMP ? `${fmt(v)} °C` : fmt(v);
  return { ok: true, value: v, shown };
}

// ---- line and box (TPT's DrawLine and DrawRect) ----
// A box from two corner points on the paint plane (Ctrl-drag): TPT's
// CreateBox fills every cell between its corners; here that footprint, as
// tall as the brush (2 × radius, centred on the plane, so it sits on the
// surface that was clicked as the brush does), the way a WorldEdit cuboid
// selection spans its two corners. As the paint pass reads it: a centre and
// how far the box reaches past a brush of that radius along each axis
// (grow), with its half size and the cells it covers [lo, hi) for the ghost.
export function boxFromCorners(a, b, radius, dims) {
  const lo = [Math.floor(Math.min(a.x, b.x)), 0, Math.floor(Math.min(a.z, b.z))];
  const hi = [Math.floor(Math.max(a.x, b.x)) + 1, 0, Math.floor(Math.max(a.z, b.z)) + 1];
  lo[1] = a.y - radius; hi[1] = a.y + radius;
  if (dims) for (let k = 0; k < 3; k++) { lo[k] = Math.max(lo[k], 0); hi[k] = Math.min(hi[k], dims[k]); }
  const half = lo.map((v, k) => Math.max((hi[k] - v) / 2, 0));
  const center = { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 };
  return { center, half, grow: half.map((h) => h - radius), lo, hi };
}

// Brush centres covering a stroke, for the particle tools (rays.js), which
// paint dabs, not cells: one per RAY_DAB_SPACING radii along a line, or on a
// grid filling a box, at most RAY_DABS_MAX.
export const RAY_DAB_SPACING = 1;
export const RAY_DABS_MAX = 64;
export function strokeDabs(center, end = center, grow = [0, 0, 0], radius = 1) {
  const step = Math.max(radius * RAY_DAB_SPACING, 1);
  const out = [];
  if (grow.some((g) => g > 0)) {
    const n = grow.map((g) => Math.max(1, Math.ceil((2 * Math.max(g, 0)) / step) + 1));
    for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) for (let k = 0; k < n[2]; k++) {
      if (out.length >= RAY_DABS_MAX) return out;
      const at = [i, j, k].map((q, d) => (n[d] > 1 ? -Math.max(grow[d], 0) + (2 * Math.max(grow[d], 0) * q) / (n[d] - 1) : 0));
      out.push({ x: center.x + at[0], y: center.y + at[1], z: center.z + at[2] });
    }
    return out;
  }
  const len = Math.hypot(end.x - center.x, end.y - center.y, end.z - center.z);
  const n = Math.min(RAY_DABS_MAX, Math.floor(len / step) + 1);
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    out.push({ x: center.x + (end.x - center.x) * t, y: center.y + (end.y - center.y) * t, z: center.z + (end.z - center.z) * t });
  }
  return out;
}

// ---- flood fill (TPT's FloodParts and flood_prop) ----
// TPT fills the 4-connected run of one particle type (or of empty space) from
// the clicked pixel: here the 6-connected cells of one element. In 3D an
// element's fill of open air would fill the sky, so the app gives it a ceiling
// (maxY: the top of the brush, as a liquid finds its level). TPT's stack
// overflows at a screenful (XRES·YRES); here a region bigger than
// FLOOD_MAX_CELLS (a 64³ cube) is refused whole rather than filled in part.
export const FLOOD_MAX_CELLS = 1 << 18;
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// a: state A read back (fetchA layout, RGBA floats per atlas texel); g: the
// grid layout; texel(x, y, z): a cell's texel in it (sim.js cellTexel);
// start: [x, y, z]; id: the element the region is made of.
// openSides: the grid's x and z walls aren't walls (a World's window), so a
// region reaching one runs on past it and is refused.
// Returns { cells (Int32Array of cell numbers x + nx·(z + nz·y)), lo, hi }
// (inclusive), or { error: 'start' | 'cap' | 'edge' }.
export function floodRegion(a, g, texel, start, { id, maxY = g.ny - 1, cap = FLOOD_MAX_CELLS, openSides = false }) {
  const { nx, ny, nz } = g;
  const idAt = (x, y, z) => Math.round(a[texel(x, y, z) * 4]);
  const [sx, sy, sz] = start;
  const top = Math.min(maxY, ny - 1);
  if (!(sx >= 0 && sx < nx && sy >= 0 && sy <= top && sz >= 0 && sz < nz) || idAt(sx, sy, sz) !== id) return { error: 'start' };
  const seen = new Uint8Array(nx * ny * nz);
  const queue = new Int32Array(cap + 1);
  const lo = [sx, sy, sz], hi = [sx, sy, sz];
  let head = 0, tail = 0;
  const at = sx + nx * (sz + nz * sy);
  seen[at] = 1;
  queue[tail++] = at;
  while (head < tail) {
    const c = queue[head++];
    const x = c % nx, z = Math.floor(c / nx) % nz, y = Math.floor(c / (nx * nz));
    if (openSides && (x === 0 || x === nx - 1 || z === 0 || z === nz - 1)) return { error: 'edge' };
    if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x;
    if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y;
    if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
    for (const [dx, dy, dz] of N6) {
      const qx = x + dx, qy = y + dy, qz = z + dz;
      if (qx < 0 || qx >= nx || qy < 0 || qy > top || qz < 0 || qz >= nz) continue;
      const q = qx + nx * (qz + nz * qy);
      if (seen[q]) continue;
      seen[q] = 1;
      if (idAt(qx, qy, qz) !== id) continue;
      if (tail > cap - 1) return { error: 'cap' };
      queue[tail++] = q;
    }
  }
  return { cells: queue.subarray(0, tail), lo, hi };
}

// The region as a mask over the state atlas (one byte per texel, MASK_ON in
// the region's cells), for the brush's kernel (sim.paint's mask: it uploads the
// bytes as they are; the kernel finds a cell's byte by its atlas texel, as
// every CPU-built array is laid out, docs/webgpu.md C2). shift: grid cells [dx, dz]
// to move it by (a World window that moved since the read: app.js pickedNow);
// cells it moves out of the grid are dropped.
export const MASK_ON = 255;
export function regionMask(g, texel, cells, [dx, dz] = [0, 0]) {
  const { nx, nz } = g;
  const data = new Uint8Array(g.width * g.height);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (const c of cells) {
    const x = (c % nx) + dx, z = (Math.floor(c / nx) % nz) + dz, y = Math.floor(c / (nx * nz));
    if (x < 0 || x >= nx || z < 0 || z >= nz) continue;
    data[texel(x, y, z)] = MASK_ON;
    count++;
    const p = [x, y, z];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  }
  return { data, lo, hi, count };
}

// Fill: read the state back, find the region from req.cell and run the brush
// over it with req.stroke (the brush's tool, filters and PROP value;
// filter is set to the region's element, so cells that changed since the read
// are left alone). before() runs right before the pass (the app's undo
// snapshot). Resolves to { count } or { error } (floodRegion's, or 'gone' when
// the simulation was replaced meanwhile).
export async function runFill(sim, req, { openSides = false, before } = {}) {
  const o = sim.origin.clone();
  // Edit predicates must include hidden fractional liquids, not visual dither.
  const a = await sim.readStateAAsync({ physical: true });
  if (sim.disposed) return { error: 'gone' };
  const texel = (x, y, z) => sim.cellTexel(x, y, z);
  const r = floodRegion(a, sim.g, texel, req.cell, { id: req.id, maxY: req.maxY, openSides });
  if (r.error) return r;
  const m = regionMask(sim.g, texel, r.cells, [o.x - sim.origin.x, o.z - sim.origin.z]);
  if (!m.count) return { error: 'gone' };
  before?.();
  sim.paint({ ...req.stroke, center: { x: 0, y: 0, z: 0 }, filter: req.id, mask: { data: m.data, lo: m.lo, hi: m.hi } });
  return { count: m.count };
}

// One-shot strokes (a line, a box, a fill) put every cell down at once, as
// TPT's do; a held brush spawns an element at its spawn density per frame.
export const oneShotRate = (tool, rate) => (tool >= 0 && ELEMENTS[tool].spawn > 0 ? Math.max(rate, 1) / ELEMENTS[tool].spawn : rate);

// The element an element fill fills: TPT's FloodParts fills empty space (cm = 0).
export const FILL_AIR = E.EMPTY;

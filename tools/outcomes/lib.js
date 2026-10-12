// Measurements the outcome tests share (tools/outcomes/tests/*): levels, height maps, footprints,
// censuses and the text dumps every failing test prints as its evidence. Pure functions of a Grid
// (tools/outcomes/engine.js); they load in Node and in a page.
import { at, inGrid } from './engine.js';

/** The liquid surface over column (x, z): the top liquid cell's y plus its fill (≤ 1), or 0 (lean-sim levels()). */
export function columnLevel(g, x, z) {
  let top = 0;
  for (let y = 0; y < g.ny; y++) {
    const a = g.amount[at(g, x, y, z)];
    if (a > 0) top = y + Math.min(a, 1);
  }
  return top;
}

/** The mean surface over the columns x0..x1, z0..z1 (inclusive). */
export function meanLevel(g, x0, x1, z0, z1) {
  let s = 0, n = 0;
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { s += columnLevel(g, x, z); n++; }
  return s / n;
}

/** The lowest and highest surface over those columns. */
export function levelRange(g, x0, x1, z0, z1) {
  let lo = Infinity, hi = -Infinity;
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { const l = columnLevel(g, x, z); lo = Math.min(lo, l); hi = Math.max(hi, l); }
  return [lo, hi];
}

/**
 * The mass census of a Grid (what engine.census() returns): cells per element name, cells per class (air, solid, powder, liquid,
 * gas), liquid per element (fills, plus particles in flight over liquid cells, in cells) and particles in
 * flight per element (in cells of liquid).
 * @param {object} g a Grid
 * @param {object} e the engine (nameOf, kindOf)
 */
export function tally(g, e) {
  const cells = {}, classes = {}, liquid = {}, particles = {};
  for (let i = 0; i < g.id.length; i++) {
    const n = e.nameOf(g.id[i]), k = e.kindOf(g.id[i]);
    cells[n] = (cells[n] ?? 0) + 1;
    classes[k] = (classes[k] ?? 0) + 1;
    if (g.amount[i] > 0 && k === 'liquid') liquid[n] = (liquid[n] ?? 0) + g.amount[i];
  }
  for (const p of g.particles ?? []) { const n = e.nameOf(p.id); particles[n] = (particles[n] ?? 0) + p.mass; }
  return { size: [g.nx, g.ny, g.nz], cells, classes, liquid, particles };
}

/** Liquid in the grid, in cells: every fill plus every particle in flight (amount bins each particle into
 * the one cell it is in, air cells included, so a sum over cells counts each once). */
export function liquidMass(g) {
  let m = 0;
  for (let i = 0; i < g.amount.length; i++) m += g.amount[i];
  return m;
}

/** Cells of the given ids, as [x, y, z] lists. */
export function cellsOf(g, ids) {
  const set = new Set(ids), out = [];
  for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) if (set.has(g.id[at(g, x, y, z)])) out.push([x, y, z]);
  return out;
}

/** Per column (x + nx·z), the top cell of the given ids plus one, or 0: a height map. */
export function heightMap(g, ids) {
  const set = new Set(ids), H = new Int16Array(g.nx * g.nz);
  for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) if (set.has(g.id[at(g, x, y, z)])) H[x + g.nx * z] = y + 1;
  return H;
}

// ---- roundness ----
// A footprint is a set of columns (x, z). Rays from its centroid find how far it reaches; a lattice can't draw
// a small disc round, so the reading is divided by what the roundest footprint of as many cells reads.

const FAN = 9, FAN_HALF = Math.PI / 16, RAY_STEP = 0.05;   // rays per direction, ±11.25° about it, cells

/** How far the footprint reaches from (cx, cz) along the angle th: the farthest point of it, to RAY_STEP. */
function exit(nx, nz, cx, cz, th, inside) {
  const dx = Math.cos(th), dz = Math.sin(th), end = Math.hypot(nx, nz);
  let r = 0;
  for (let s = RAY_STEP / 2; s < end; s += RAY_STEP) {
    const x = Math.floor(cx + dx * s), z = Math.floor(cz + dz * s);
    if (x >= 0 && z >= 0 && x < nx && z < nz && inside(x, z)) r = s + RAY_STEP / 2;
  }
  return r;
}

/** The mean reach over FAN rays spread ±FAN_HALF about each of the four directions base + k·90°. */
function fanReach(nx, nz, cx, cz, base, inside) {
  let s = 0;
  for (let q = 0; q < 4; q++) for (let i = 0; i < FAN; i++) s += exit(nx, nz, cx, cz, base + (q * Math.PI) / 2 - FAN_HALF + (2 * FAN_HALF * i) / (FAN - 1), inside);
  return s / (4 * FAN);
}

/** The roundest footprint of about `count` cells about (cx, cz): every cell whose centre is within the radius
 * whose disc holds the number of cells nearest `count`. */
function latticeDisc(nx, nz, cx, cz, count) {
  const d = [];
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) d.push(Math.hypot(x + 0.5 - cx, z + 0.5 - cz));
  d.sort((a, b) => a - b);
  const k = Math.min(Math.max(count, 1), d.length), dk = d[k - 1];
  let hi = k; while (hi < d.length && d[hi] <= dk + 1e-9) hi++;          // cells in the disc through the k-th
  let lo = k - 1; while (lo > 0 && d[lo - 1] >= dk - 1e-9) lo--;         // cells in the disc just inside it
  const R = hi - k <= k - lo || lo === 0 ? dk + 1e-9 : d[lo - 1] + 1e-9;
  return (x, z) => Math.hypot(x + 0.5 - cx, z + 0.5 - cz) <= R;
}

/**
 * How round a footprint is: docs/v2.md 11 P4's "diagonal/axis ratio", measured so a round footprint reads 1
 * on the lattice. From the footprint's centroid, the farthest point of it along 72 rays in steps of 0.05 cell
 * (9 rays over ±11.25° about each axis and each diagonal); the diagonal mean over the axis mean is `raw`.
 * `ratio` is raw over the same reading of the roundest footprint the lattice allows with as many cells about
 * the same centre: a footprint of a few dozen cells can't be rounder than that (the 60-cell "disc" about a
 * cell corner is an 8×8 square less its corners and reads 1.16 raw), so a lattice disc reads 1, not up to
 * ±16 % off. Calibration (selfCheck() below, run by every tools/outcomes.mjs): lattice discs of radius 3-9
 * read 1; discs about an off-lattice centre 0.93-1.02; squares of side 9 cells or more 1.18-1.41 and
 * diamonds 0.70-0.84 (the old whole-cell rays from a fixed point read lattice discs 0.86-1.13).
 * @param {(x: number, z: number) => boolean} inside
 * @returns {{ area: number, cx: number, cz: number, rAxis: number, rDiag: number, raw: number, lattice: number,
 *   ratio: number, rEq: number }} rEq: the radius of a disc of the footprint's area
 */
export function roundness(nx, nz, inside) {
  let area = 0, sx = 0, sz = 0;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) if (inside(x, z)) { area++; sx += x + 0.5; sz += z + 0.5; }
  if (!area) return { area: 0, cx: NaN, cz: NaN, rAxis: 0, rDiag: 0, raw: 0, lattice: 1, ratio: 0, rEq: 0 };
  const cx = sx / area, cz = sz / area;
  const rAxis = fanReach(nx, nz, cx, cz, 0, inside), rDiag = fanReach(nx, nz, cx, cz, Math.PI / 4, inside);
  const disc = latticeDisc(nx, nz, cx, cz, area);
  const lattice = fanReach(nx, nz, cx, cz, Math.PI / 4, disc) / fanReach(nx, nz, cx, cz, 0, disc);
  const raw = rDiag / rAxis;
  return { area, cx, cz, rAxis, rDiag, raw, lattice, ratio: raw / lattice, rEq: Math.sqrt(area / Math.PI) };
}

/**
 * The roundness measure's own check, on footprints whose answer is known: lattice discs (radius 3-9 by
 * quarter cells, about a cell's centre and a cell's corner) read 1 within 3 %; discs about an off-lattice
 * centre within 8 %; squares and diamonds of side 9 cells or more outside 1 ± tol. Rows that fail, or [].
 * @param {number} tol the roundness tolerance the tests use (thresholds.js ROUND_TOL)
 */
export function selfCheck(tol) {
  const N = 40, bad = [], rows = [];
  const add = (label, _c, f, ok) => { const r = roundness(N, N, f).ratio; rows.push([label, r]); if (!ok(r)) bad.push(`${label}: ${r.toFixed(3)}`); };
  for (let R = 3; R <= 9 + 1e-9; R += 0.25) {
    add(`disc r ${R} about a cell centre`, 20.5, (x, z) => Math.hypot(x - 20, z - 20) <= R + 1e-9, (r) => Math.abs(r - 1) <= 0.03);
    add(`disc r ${R} about a cell corner`, 20, (x, z) => Math.hypot(x + 0.5 - 20, z + 0.5 - 20) <= R + 1e-9, (r) => Math.abs(r - 1) <= 0.03);
    add(`disc r ${R} about (20.8, 20.7)`, 20.8, (x, z) => Math.hypot(x + 0.5 - 20.8, z + 0.5 - 20.7) <= R, (r) => Math.abs(r - 1) <= 0.08);
  }
  for (const h of [4, 4.5, 5, 6, 7, 8, 9]) {
    const c = Number.isInteger(h) ? 20.5 : 20;   // about a cell's centre (odd sides), a cell's corner (even sides)
    add(`square of side ${2 * h + 1}`, c, (x, z) => Math.max(Math.abs(x + 0.5 - c), Math.abs(z + 0.5 - c)) <= h + 1e-9, (r) => r > 1 + tol);
    add(`diamond of side ${2 * h + 1}`, c, (x, z) => Math.abs(x + 0.5 - c) + Math.abs(z + 0.5 - c) <= h + 1e-9, (r) => r < 1 - tol);
  }
  return { bad, rows };
}

/** A map over columns as text, a row per z (z0..z1), a character per x (x0..x1). */
export function mapText(nx, nz, ch, { x0 = 0, x1 = nx - 1, z0 = 0, z1 = nz - 1 } = {}) {
  const rows = [];
  for (let z = z0; z <= z1; z++) { let s = ''; for (let x = x0; x <= x1; x++) s += ch(x, z); rows.push(s); }
  return rows.join('\n');
}

/** An x-y slice (top row first), a character per cell from ch(x, y). */
export function sliceText(g, ch, { x0 = 0, x1 = g.nx - 1, y0 = 0, y1 = g.ny - 1 } = {}) {
  const rows = [];
  for (let y = y1; y >= y0; y--) { let s = ''; for (let x = x0; x <= x1; x++) s += ch(x, y); rows.push(`|${s}|`); }
  return rows.join('\n');
}

/** A height (or count) as one character: '.' for 0, digits, then letters, '#' past 35. */
export const digit = (v) => (v <= 0 ? '.' : v < 10 ? String(Math.floor(v)) : v < 36 ? String.fromCharCode(55 + Math.floor(v)) : '#');

/** The liquid in column (x, z), summed over y, as '.', a tenth digit or '#' (full or more). */
export function amountChar(g, x, z, y0 = 0, y1 = g.ny - 1) {
  let f = 0;
  for (let y = y0; y <= y1; y++) f += g.amount[at(g, x, y, z)];
  return f <= 0 ? '.' : f >= 1 ? (f >= 10 ? '#' : String.fromCharCode(65 + Math.min(25, Math.floor(f) - 1))) : String(Math.min(9, Math.floor(10 * f)));
}

/** Rounded for reports. */
export const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
export const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);

/** A criterion: what was measured, against what, and whether it held (note: how it was read, printed beside it). */
export const crit = (name, measured, ok, threshold, unit = '', note = '') => ({ name, measured, ok: Boolean(ok), threshold, unit, ...(note ? { note } : {}) });

/**
 * Advances `seconds` in chunks of `every`, asking for activity after each: the first game time the
 * engine reported itself idle (its own idleSince when it knows it, else the chunk's end), or null, and
 * how finely that time is known (`resolution`, s: a step, or the chunk). onChunk(t) runs after each chunk
 * (await it for reads).
 */
export async function advanceWatching(e, seconds, { every = 0.25, onChunk = null } = {}) {
  let idleAt = null, last = null;
  const end = e.time + seconds;
  while (e.time < end - 1e-9) {
    await e.advance(Math.min(every, end - e.time));
    last = await e.activity();
    if (last.idle && idleAt === null) idleAt = last.idleSince ?? e.time;
    if (!last.idle) idleAt = null;   // (a write woke it: rest is where it stays)
    if (onChunk) await onChunk(e.time, last);
  }
  const resolution = last?.idleSince !== undefined ? 1 / e.info.stepsPerSecond : every;
  return { idleAt, activity: last, resolution };
}

/** A rest time's note: how finely it was read. */
export const restNote = (resolution) => `read every ${+resolution.toFixed(3)} s`;

/** True when a cell holds liquid in an engine-agnostic sense (any amount). */
export const wet = (g, x, y, z) => inGrid(g, x, y, z) && g.amount[at(g, x, y, z)] > 0;

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
 * The mass census (engine.census()): cells per element name, cells per class (air, solid, powder, liquid,
 * gas), liquid per element (fills, plus particles in flight over liquid cells, in cells) and particles in
 * flight per element (in cells of liquid).
 * @param {object} g a Grid
 * @param {object} e the engine (nameOf, kindOf)
 */
export function census(g, e) {
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

/**
 * A footprint's reach from (cx, cz) along the four axes and the four diagonals, averaged per kind
 * (lean-sim heap()'s ext): along each ray in steps of one cell (√2 on a diagonal), the farthest step
 * whose column is in the footprint.
 * @param {(x: number, z: number) => boolean} inside
 */
export function reach(nx, nz, cx, cz, inside, maxSteps = Math.max(nx, nz)) {
  const ext = (dx, dz) => {
    let r = 0;
    for (let k = 0; k < maxSteps; k++) {
      const x = Math.floor(cx + dx * (k + 0.5)), z = Math.floor(cz + dz * (k + 0.5));
      if (x >= 0 && z >= 0 && x < nx && z < nz && inside(x, z)) r = Math.hypot(dx, dz) * (k + 1);
    }
    return r;
  };
  const axis = [ext(1, 0), ext(-1, 0), ext(0, 1), ext(0, -1)];
  const diag = [ext(1, 1), ext(-1, -1), ext(1, -1), ext(-1, 1)];
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return { axis, diag, rAxis: mean(axis), rDiag: mean(diag) };
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

/** A criterion: what was measured, against what, and whether it held. */
export const crit = (name, measured, ok, threshold, unit = '') => ({ name, measured, ok: Boolean(ok), threshold, unit });

/**
 * Advances `seconds` in chunks of `every`, asking for activity after each: the first game time the
 * engine reported itself idle (its own idleSince when it knows it, else the chunk's end), or null.
 * onChunk(t) runs after each chunk (await it for reads).
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
  return { idleAt, activity: last };
}

/** True when a cell holds liquid in an engine-agnostic sense (any amount). */
export const wet = (g, x, y, z) => inGrid(g, x, y, z) && g.amount[at(g, x, y, z)] > 0;

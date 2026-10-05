import { ELEMENTS, E, K } from '../elements.js';

// Physics lint: what will go wrong the moment the sim runs a construction.
//
// The sim moves matter in 2×2×2 blocks, so a grain or a drop can slip through a
// gap that only touches diagonally (an edge or a corner). Every check here
// therefore uses all 26 neighbours. Cells the construction leaves unset count as
// open air; the ground under y = 0 counts as solid.

const SAMPLES = 3;            // example cells listed per issue
const UNSET = -1;             // a cell the construction doesn't define
const GROUND = -2;            // the surface the construction stands on (y < 0)

const N26 = [];
for (let dz = -1; dz <= 1; dz++)
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) N26.push([dx, dy, dz]);
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
// where matter can go: liquids spread sideways and down, powders only fall or topple down
const LIQUID_MOVES = N26.filter(([, dy]) => dy <= 0);
const POWDER_MOVES = N26.filter(([, dy]) => dy < 0);

const nameOf = (id) => (id === E.EMPTY ? 'AIR' : ELEMENTS[id].key);
const isOpen = (id) => id === UNSET || id === E.EMPTY || (id >= 0 && ELEMENTS[id].kind === K.GAS);
const flows = (id) => id >= 0 && (ELEMENTS[id].kind === K.LIQUID || ELEMENTS[id].kind === K.POWDER);

// A dense copy of the construction padded by one cell on every side. Row 0 is
// the ground; a cell at height y sits in row y + 1.
class Grid {
  constructor(cells) {
    let x0 = Infinity, y1 = -Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < cells.n; i++) {
      x0 = Math.min(x0, cells.x[i]); x1 = Math.max(x1, cells.x[i]);
      z0 = Math.min(z0, cells.z[i]); z1 = Math.max(z1, cells.z[i]);
      y1 = Math.max(y1, cells.y[i]);
    }
    Object.assign(this, { x0, z0, size: [x1 - x0 + 1, y1 + 1, z1 - z0 + 1] });
    const W = this.W = x1 - x0 + 3, H = this.H = y1 + 3, D = this.D = z1 - z0 + 3;
    this.ids = new Int16Array(W * H * D).fill(UNSET);
    this.temp = new Float32Array(W * H * D);
    this.ctype = new Uint8Array(W * H * D);
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) this.ids[this.index(x, 0, z)] = GROUND;
    for (let i = 0; i < cells.n; i++) {
      const j = this.index(cells.x[i] - x0 + 1, cells.y[i] + 1, cells.z[i] - z0 + 1);
      this.ids[j] = cells.id[i];
      this.temp[j] = cells.temp[i];
      this.ctype[j] = cells.ctype[i];
    }
  }

  index(x, y, z) { return (z * this.H + y) * this.W + x; }
  coords(j) { return [j % this.W, Math.floor(j / this.W) % this.H, Math.floor(j / (this.W * this.H))]; }
  world(j) { const [x, y, z] = this.coords(j); return [x + this.x0 - 1, y - 1, z + this.z0 - 1]; }
  inside(x, y, z, yLo = 0, yHi = this.H - 1) { return x >= 0 && z >= 0 && x < this.W && z < this.D && y >= yLo && y <= yHi; }
  at(x, y, z) { return this.inside(x, y, z) ? this.ids[this.index(x, y, z)] : UNSET; }

  // Does fn hold for any neighbour of cell j (by offset) within rows yLo..yHi?
  some(j, offsets, fn, yLo, yHi) {
    const [x, y, z] = this.coords(j);
    for (const [dx, dy, dz] of offsets) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (this.inside(nx, ny, nz, yLo, yHi) && fn(this.index(nx, ny, nz))) return true;
    }
    return false;
  }
}

// Face-connected bodies of liquid and powder, and the top row of each.
function fluidBodies(g) {
  const body = new Int32Array(g.ids.length).fill(-1);
  const tops = [];
  for (let j = 0; j < g.ids.length; j++) {
    if (!flows(g.ids[j]) || body[j] >= 0) continue;
    const b = tops.length;
    let top = 0;
    const stack = [j];
    body[j] = b;
    while (stack.length) {
      const k = stack.pop();
      top = Math.max(top, g.coords(k)[1]);
      g.some(k, N6, (n) => { if (body[n] < 0 && flows(g.ids[n])) { body[n] = b; stack.push(n); } return false; });
    }
    tops.push(top);
  }
  return { body, tops };
}

// Mark the open air reachable from outside the construction, at or below `level`.
function floodOutside(g, level, outside) {
  outside.fill(0);
  const stack = [];
  const reach = (n) => { if (!outside[n] && isOpen(g.ids[n])) { outside[n] = 1; stack.push(n); } return false; };
  for (let y = 1; y <= level; y++)
    for (let z = 0; z < g.D; z++)
      for (let x = 0; x < g.W; x++)
        if (x === 0 || z === 0 || x === g.W - 1 || z === g.D - 1) reach(g.index(x, y, z));
  while (stack.length) g.some(stack.pop(), N26, reach, 1, level);
}

// Liquid that can flow out, and powder that can topple off. Matter can't climb,
// so for a body whose surface is at level L only air at or below L counts. Bodies
// are grouped by surface level: one flood per level.
function escapes(g) {
  const { body, tops } = fluidBodies(g);
  const leaking = [], sliding = [];
  const outside = new Uint8Array(g.ids.length);
  for (const level of [...new Set(tops)].sort((a, b) => a - b)) {
    floodOutside(g, level, outside);
    for (let j = 0; j < g.ids.length; j++) {
      if (body[j] < 0 || tops[body[j]] !== level) continue;
      const powder = ELEMENTS[g.ids[j]].kind === K.POWDER;
      if (g.some(j, powder ? POWDER_MOVES : LIQUID_MOVES, (n) => outside[n], 1, level)) (powder ? sliding : leaking).push(j);
    }
  }
  return { leaking, sliding };
}

// Checks that look at one cell and its neighbours.
function cellProblems(g) {
  const falling = [], sourceless = [], burning = [];
  const openAt = (n) => isOpen(g.ids[n]);
  for (let j = 0; j < g.ids.length; j++) {
    const id = g.ids[j];
    if (id < 0) continue;
    const e = ELEMENTS[id];
    const [x, y, z] = g.coords(j);
    if (e.kind === K.POWDER && isOpen(g.at(x, y - 1, z))) falling.push(j);
    if (id === E.CLONE && !g.ctype[j]) sourceless.push(j);
    // (cells never sit on the grid's edge: the padding ring keeps all their neighbours inside)
    if (e.ignite && g.temp[j] >= e.ignite && g.some(j, N6, openAt)) burning.push(j);
  }
  return { falling, sourceless, burning };
}

const namesIn = (g, list) => [...new Set(list.map((j) => nameOf(g.ids[j])))].join(', ');

export function lint(cells, { maxSpan } = {}) {
  const issues = [];
  const counts = {};
  if (!cells.n) return { ok: false, cells: 0, size: [0, 0, 0], counts, issues: [{ code: 'empty', severity: 'error', count: 0, message: 'The construction has no cells.', hint: 'Place at least one cell.', sample: [] }] };
  for (let i = 0; i < cells.n; i++) { const key = nameOf(cells.id[i]); counts[key] = (counts[key] ?? 0) + 1; }

  const g = new Grid(cells);
  const add = (code, severity, list, message, hint) => {
    if (list.length) issues.push({ code, severity, count: list.length, message, hint, sample: list.slice(0, SAMPLES).map((j) => g.world(j)) });
  };
  const { leaking, sliding } = escapes(g);
  add('leak', 'error', leaking, `${leaking.length} cells of ${namesIn(g, leaking)} can flow out of the construction.`,
    'Seal the container. Liquid slips through gaps that only touch diagonally, so walls must be face-connected: a curved shell needs a band at least 1.5 cells wide.');
  add('powder_slides', 'warning', sliding, `${sliding.length} cells of ${namesIn(g, sliding)} can topple off the construction.`,
    'Fine for a loose pile that should settle. To hold powder in place, contain it or support every cell from below and diagonally below.');
  const { falling, sourceless, burning } = cellProblems(g);
  add('unsupported_powder', 'error', falling, `${falling.length} powder cells have nothing under them and will fall.`,
    'Rest powders on something, or build that part from a solid such as WALL, ROCK, WOOD or METAL.');
  add('clone_no_source', 'warning', sourceless, `${sourceless.length} CLONE cells have no source element.`,
    "Give clones a source, e.g. put(x, y, z, 'CLONE', { ctype: 'WATER' }); otherwise they copy whatever touches them first.");
  add('ignites_on_place', 'info', burning, `${burning.length} cells start above their ignition temperature and will burn immediately.`,
    'Intended for a lit fire; otherwise place them at room temperature.');

  if (maxSpan && Math.max(...g.size) > maxSpan) {
    issues.push({ code: 'too_big', severity: 'error', count: 1, sample: [],
      message: `The construction is ${g.size.join(' × ')} cells; the grid fits at most ${maxSpan}.`, hint: 'Scale it down with T.' });
  }
  return { ok: !issues.some((i) => i.severity === 'error'), cells: cells.n, size: g.size, counts, issues };
}

// ---------------------------------------------------------------- reports

const withSeverity = (r, severity) => r.issues.filter((i) => i.severity === severity);
const issueList = (list) => list.map((i) => `${i.code.replace(/_/g, ' ')} (${i.count})`).join(', ');

// One readable paragraph, for tool results and the CLI.
export function formatReport(r) {
  const head = `${r.cells} cells, ${r.size.join(' × ')} (w × h × d). ` +
    Object.entries(r.counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') + '.';
  if (!r.issues.length) return `${head}\nNo physics problems found.`;
  return [head, ...r.issues.map((i) => `${i.severity.toUpperCase()} ${i.code}: ${i.message} ${i.hint}` +
    (i.sample.length ? ` Examples: ${i.sample.map((p) => `(${p.join(', ')})`).join(' ')}.` : ''))].join('\n');
}

// One status line, for the UI.
export function summarizeReport(r) {
  const errors = withSeverity(r, 'error'), warnings = withSeverity(r, 'warning');
  const parts = [`${r.cells.toLocaleString()} cells · ${r.size.join('×')}`];
  parts.push(errors.length ? `problems: ${issueList(errors)}` : 'no physics problems');
  if (warnings.length) parts.push(`note: ${issueList(warnings)}`);
  return parts.join(' · ');
}

export const errorCount = (r) => withSeverity(r, 'error').length;

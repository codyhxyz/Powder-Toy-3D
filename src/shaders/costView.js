// The cost view (docs/profiler.md "Cost view"): the lit tracer's modules with per-pixel work
// counters, and nothing else changed.
//
// Honest by construction. The counted module is the live pipeline's own WGSL text (the box volume's,
// shaders/render.js volumeFrag; the world march's whole module or split stages, shaders/world/march.js)
// with spans inserted, each fenced `/*cost{*/ … /*}cost*/`. Nothing is removed or rewritten:
// stripCost(costify(code)) === code, and verifyCost() also proves every span is one of the few kinds
// below (a counter increment, the counters' declarations, the store that writes them). The tracer
// itself is never copied, so the counters follow whatever the march becomes, and an anchor that stops
// matching throws (a counter that silently reads 0 would lie).
//
// The variant writes the same colour and depth (or G-buffer words), and its counters into a write-only
// rgba32uint storage texture in group 0 (the next free binding), COST_STORAGE_ROWS rows a pixel:
// twenty-four counters, 16 bits each, saturating. A stage writes them where its work ends (after the
// trace, before the shade's return, as the reflection is returned), before any discard, so a ray that
// crossed the world and hit nothing shows its cost too. gfx/costView.js draws the live pipeline and
// this one on the same frame state and compares what they wrote before it trusts a single count.

import { volumeFrag, VOLUME_LAYOUTS, LAYOUT_NAMES, VolumeParams, volumePipeline, REALISTIC_LEVELS, VOLUME_VIEWS } from './render.js';
import { isMaterialView } from '../views.js';
import { STAGE } from './common.js';
import { worldMarchFrag, WORLD_MARCH_LAYOUTS, worldMarchLayoutNames, worldMarchPipeline, MarchParams, MARCH_STAGES, marchSplits } from './world/march.js';
import { WC_OWN } from './world/copy.js';

// A box skip's region is a cube of 2r + 1 bricks (gfx/core.js skipEmpty: brickDist's radius r); at
// this many bricks a side (64 cells, the world's level-2 node) or more it is counted with the 64³ jumps.
const BOX_BIG_SKIP_BRICKS = 16;

/**
 * The counters, in slot order. Each counts work, not time: the variant's speed
 * says nothing about the real shader's (counter writes change its registers).
 * where: what is counted, by the module's own names.
 */
export const COST_COUNTERS = [
  { key: 'march', label: 'main march steps', where: "iterations of traceView's main loop (refraction restarts included)" },
  { key: 'brickSkips', label: 'empty-region jumps', where: "traceView's jumps over empty bricks (skipEmpty; curved: warpSkip)" },
  { key: 'cellSteps', label: 'cells stepped', where: "traceView's DDA advances (the crisp-only fast path, ddaStep; curved: warpAdvance)" },
  { key: 'shadowSteps', label: 'sun-ray walk steps', where: 'iterations of sunRayClear (secondary shadow rays)' },
  { key: 'nearSteps', label: 'near-field / AO / lamp walk steps', where: 'iterations of traceNearSteps' },
  { key: 'reflSteps', label: 'reflection march steps', where: 'iterations of reflectHit (the traced reflection)' },
  { key: 'refractions', label: 'refraction bends', where: 'liquidInterface and crystalInterface calls (each restarts the main march)' },
  { key: 'rootIters', label: 'surface root-finder iterations', where: 'iterations of surfRoot and reflCross' },
  { key: 'shading', label: 'surface shadings', where: 'shadeHit calls' },
  { key: 'sunShadow', label: 'sun-shadow lookups', where: 'sunMapShadow and sunMapShadowAt calls (sunShadow / sunShadowAt reach the map through them)' },
  { key: 'fieldReads', label: 'field texture taps', where: 'fieldTex calls (1 tap) and cubicFetch8 calls (8 taps); the world: fieldTexL past its empty-level return, fieldFetch8 (8)' },
  { key: 'cellReads', label: 'cell reads', where: 'fetchAs, fetchBs, fetchNativeCore (state) and occIdOf (occupancy ids) calls; the world: wcCell' },
  // cellSteps by the class of the brick the step is in (they add up to cellSteps)
  { key: 'cellStepsOwn', label: 'cells stepped in bricks with matter', where: "cellSteps in a brick with cells of its own (the world: W's own MATTER bit; the box: its occupancy mask)" },
  { key: 'cellStepsDilated', label: 'cells stepped in flagged-only bricks', where: "cellSteps in a brick with no cell of its own, visited for its flags alone (the world: W's 1-brick dilation; the box: the fields' or media's reach)" },
  { key: 'cellStepsInterior', label: 'cells stepped in liquid-interior bricks', where: 'cellSteps in a brick flagged BRICK_LIQUID_INTERIOR' },
  // brickSkips by jump size (they add up to brickSkips, but for the curved view's warpSkip), and their length
  { key: 'skipBrick', label: 'jumps over one brick', where: "traceView's skipEmpty over the brick alone (the world: W's occupied 16³ node; the box: brickDist radius 0)" },
  { key: 'skip16', label: 'jumps over a 16³ node', where: "the world: an empty 16³ node of W's occupancy; the box: a cube of 3-15 bricks a side" },
  { key: 'skip64', label: 'jumps over a 64³ node', where: `the world: an empty 64³ node; the box: a cube of ${BOX_BIG_SKIP_BRICKS} bricks a side or more` },
  { key: 'skipCells', label: 'cells advanced by jumps', where: "traceView's skipEmpty jumps: the cells the walk moved (|Δx| + |Δy| + |Δz|)" },
];
export const COST_KINDS = COST_COUNTERS.map((c) => c.key);
const SLOT = Object.fromEntries(COST_KINDS.map((k, i) => [k, i]));
/** The jump split, which the curved view's warpSkip has not. */
const SKIP_SPLIT_KINDS = ['skipBrick', 'skip16', 'skip64', 'skipCells'];
/** Largest count a slot holds (16 bits; the march's slot keeps its top bit for coverage). */
export const COST_MAX = 0xffff;
export const COST_MARCH_MAX = 0x7fff;
/** Slot 0's coverage bit: the trace ran for this pixel. */
export const COST_COVERED_BIT = 0x8000;
/** Rows of the sink a pixel takes (four words a row, two 16-bit counters a word) ... */
export const COST_STORAGE_ROWS = Math.ceil(COST_COUNTERS.length / 8);
/** ... its u32 words (the slots past the counters stay 0) ... */
export const COST_WORDS = 4 * COST_STORAGE_ROWS;
/** ... and its 16-bit slots. */
const COST_SLOTS = 2 * COST_WORDS;

const OPEN = '/*cost{*/', CLOSE = '/*}cost*/';
const span = (s) => `${OPEN}${s}${CLOSE}`;
const bump = (k, n = 1) => `gCost[${SLOT[k]}] += ${n}u;`;
const pack = (a, b) => `costPack(${a}, ${b})`;
const at = (k) => `gCost[${SLOT[k]}]`;

// The storage sink: a write-only rgba32uint texture in group 0 at `binding`, COST_STORAGE_ROWS times
// the target's height, the pixel's words in rows ROWS·y … ROWS·y + ROWS - 1 (four a row).
export const COST_STORAGE_FORMAT = 'rgba32uint';
const wordOf = (i) => pack(i === 0 ? `(min(${at('march')}, ${COST_MARCH_MAX}u) | ${COST_COVERED_BIT}u)` : `gCost[${2 * i}]`, `gCost[${2 * i + 1}]`);
// The walk-kind flags: gCostSun is set by a sun ray that walks through traceNearSteps (the world's),
// gCostWalkSun is the walk's own copy; gCostMainSkip marks skipEmpty called by the main march.
const storagePrelude = (binding) => `
// ---- cost view counters (shaders/costView.js) ----
var<private> gCost: array<u32, ${COST_SLOTS}>;
var<private> gCostSun: bool;
var<private> gCostWalkSun: bool;
var<private> gCostMainSkip: bool;
fn costPack(a: u32, b: u32) -> u32 { return min(a, ${COST_MAX}u) | (min(b, ${COST_MAX}u) << 16u); }
@group(0) @binding(${binding}) var gCostTex: texture_storage_2d<${COST_STORAGE_FORMAT}, write>;
fn costStore() {
  let p = vec2i(floor(gFragCoord));
${Array.from({ length: COST_STORAGE_ROWS }, (_, r) => `  textureStore(gCostTex, vec2i(p.x, ${COST_STORAGE_ROWS} * p.y + ${r}), vec4u(${[0, 1, 2, 3].map((c) => wordOf(4 * r + c)).join(', ')}));`).join('\n')}
}
fn costPass(v: vec4f) -> vec4f { costStore(); return v; }
`;
const STORE = 'costStore();\n  ';
const STORE_AFTER = '\n  costStore();';
const PASS_OPEN = 'costPass(', PASS_CLOSE = ')';
const SUN_SET = 'gCostSun = true;';
const WALK_TAKE = 'gCostWalkSun = gCostSun; gCostSun = false;';
// a walker's step: the sun ray's or the near field's, by who asked (gCostWalkSun)
const WALK_BUMP = `gCost[select(${SLOT.nearSteps}u, ${SLOT.shadowSteps}u, gCostWalkSun)] += 1u;`;
// the main march's jumps: marked around its skipEmpty call, sized inside it, measured after it
const SKIP_MARK = 'gCostMainSkip = true; let costC0 = cell;';
const SKIP_DONE = `gCostMainSkip = false; gCost[${SLOT.skipCells}] += u32(abs(cell.x - costC0.x) + abs(cell.y - costC0.y) + abs(cell.z - costC0.z));`;
const SKIP_SIZE_WORLD = `if (gCostMainSkip) { gCost[select(select(${SLOT.skipBrick}u, ${SLOT.skip16}u, n == OCC_NODE_1), ${SLOT.skip64}u, n == OCC_NODE_2)] += 1u; }`;
const SKIP_SIZE_BOX = `if (gCostMainSkip) { gCost[select(select(${SLOT.skipBrick}u, ${SLOT.skip16}u, r > 0), ${SLOT.skip64}u, 2 * r + 1 >= ${BOX_BIG_SKIP_BRICKS})] += 1u; }`;
// a cell step's brick class: liquid interior, else own matter, else flagged only
const CELL_CLASS = (dilated) => `gCost[select(select(${SLOT.cellStepsOwn}u, ${SLOT.cellStepsDilated}u, ${dilated}), ${SLOT.cellStepsInterior}u, (flags & BRICK_LIQUID_INTERIOR) != 0u)] += 1u;`;
const CELL_CLASS_WORLD = CELL_CLASS(`(flags & ${WC_OWN.MATTER >>> 0}u) == 0u`);
const CELL_CLASS_BOX = CELL_CLASS('all(occM == vec2u(0u))');
// every span that isn't a plain bump, with the counters it counts
const SPECIAL = new Map([
  [STORE, []], [STORE_AFTER, []], [PASS_OPEN, []], [PASS_CLOSE, []], [SUN_SET, []], [WALK_TAKE, []],
  [WALK_BUMP, ['nearSteps', 'shadowSteps']], [SKIP_MARK, []], [SKIP_DONE, ['skipCells']],
  [SKIP_SIZE_WORLD, ['skipBrick', 'skip16', 'skip64']], [SKIP_SIZE_BOX, ['skipBrick', 'skip16', 'skip64']],
  [CELL_CLASS_WORLD, ['cellStepsOwn', 'cellStepsDilated', 'cellStepsInterior']], [CELL_CLASS_BOX, ['cellStepsOwn', 'cellStepsDilated', 'cellStepsInterior']],
]);
const isPrelude = (s) => /^\n\/\/ ---- cost view counters/.test(s) && s === storagePrelude(+(/@binding\((\d+)\) var gCostTex/.exec(s)?.[1] ?? -1));
const BUMP_RE = /^gCost\[(\d+)\] \+= (\d+)u;$/;

// ---- a small WGSL scanner: comments skipped, brackets balanced ----
function skipComment(code, i) {
  if (code.startsWith('//', i)) { const e = code.indexOf('\n', i); return e < 0 ? code.length : e; }
  if (code.startsWith('/*', i)) { const e = code.indexOf('*/', i + 2); return e < 0 ? code.length : e + 2; }
  return i;
}
// index just past the bracket matching the one at `open`
function matchClose(code, open) {
  const o = code[open], c = { '(': ')', '{': '}', '[': ']' }[o];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const j = skipComment(code, i);
    if (j !== i) { i = j - 1; continue; }
    if (code[i] === o) depth++;
    else if (code[i] === c && --depth === 0) return i + 1;
  }
  throw new Error(`costView: unbalanced ${o} at ${open}`);
}
// [bodyOpen, bodyEnd) of `fn name(…) … {…}`: bodyOpen is its `{`; null if the module has no such fn
function fnBody(code, name) {
  const m = new RegExp(`\\bfn ${name}\\(`).exec(code);
  if (!m) return null;
  const params = matchClose(code, m.index + m[0].length - 1);
  const open = code.indexOf('{', params);
  return [open, matchClose(code, open)];
}
// positions just past each loop header's `{` in [a, b) whose header matches re
function loopOpens(code, [a, b], re) {
  const out = [], loop = /\bfor \(|\bloop \{/g;
  loop.lastIndex = a;
  for (let m; (m = loop.exec(code)) && m.index < b;) {
    if (m[0] === 'loop {') { if (re.test('loop')) out.push(m.index + m[0].length); continue; }
    const close = matchClose(code, m.index + m[0].length - 1);
    const open = code.indexOf('{', close);
    if (re.test(code.slice(m.index, close))) out.push(open + 1);
  }
  return out;
}
// positions just past each occurrence of `stmt` in [a, b)
function stmtEnds(code, [a, b], stmt) {
  const out = [];
  for (let i = code.indexOf(stmt, a); i >= 0 && i < b; i = code.indexOf(stmt, i + 1)) out.push(i + stmt.length);
  return out;
}

// positions at each occurrence of `stmt` in [a, b)
function stmtStarts(code, [a, b], stmt) {
  const out = [];
  for (let i = code.indexOf(stmt, a); i >= 0 && i < b; i = code.indexOf(stmt, i + 1)) out.push(i);
  return out;
}

// Where each counter counts. fn: a function's entry; loop: iterations of the loops of fn whose
// header matches ('loop' matches a bare loop); after / before: right after / before each occurrence
// of a statement in fn. A rule whose function the module lacks (curved-only, a read format's, the
// world's or the box's readers) inserts nothing; unless: skipped when the module has that function;
// when: a test of the function's text. text: the span (a plain bump of k by default); counts: what
// it counts (k by default). costify throws if a required counter counts nowhere.
const RULES = [
  { k: 'march', loop: 'traceView', header: /BEND_EXTRA_STEPS/ },
  // the main march's jumps: counted, marked for skipEmpty's size split, measured
  { k: 'brickSkips', after: 'traceView', stmt: 'ax = skipEmpty(bc, ro, rd, istp, &cell, &tMax, &tEnter);' },
  { k: 'brickSkips', after: 'traceView', stmt: 'warpSkip(&walk, bc, true);' },
  { k: 'skipCells', before: 'traceView', stmt: 'ax = skipEmpty(bc, ro, rd, istp, &cell, &tMax, &tEnter);', text: SKIP_MARK, counts: [] },
  { k: 'skipCells', after: 'traceView', stmt: 'ax = skipEmpty(bc, ro, rd, istp, &cell, &tMax, &tEnter);', text: SKIP_DONE },
  { k: 'skipBrick', after: 'skipEmpty', stmt: 'if (!wcOccupied(2u, c)) { n = OCC_NODE_2; } else if (!wcOccupied(1u, c)) { n = OCC_NODE_1; }', text: SKIP_SIZE_WORLD, counts: ['skipBrick', 'skip16', 'skip64'] },
  { k: 'skipBrick', after: 'skipEmpty', stmt: 'let r = max(brickDistAt(bc), 0);', text: SKIP_SIZE_BOX, counts: ['skipBrick', 'skip16', 'skip64'] },
  // the main march's cell steps, and each one's brick class
  ...['cell[ax] += istp[ax];', 'ax = ddaStep(istp, tDelta, &cell, &tMax);', 'warpAdvance(&walk);'].flatMap((stmt) => [
    { k: 'cellSteps', after: 'traceView', stmt },
    { k: 'cellStepsOwn', after: 'traceView', stmt, world: true, text: CELL_CLASS_WORLD, counts: ['cellStepsOwn', 'cellStepsDilated', 'cellStepsInterior'] },
    { k: 'cellStepsOwn', after: 'traceView', stmt, world: false, text: CELL_CLASS_BOX, counts: ['cellStepsOwn', 'cellStepsDilated', 'cellStepsInterior'] },
  ]),
  // the box's sun ray walks itself; the world's asks traceNearSteps (lcNext steps it), flagged
  { k: 'shadowSteps', loop: 'sunRayClear', header: /MAX_STEPS|marchMaxSteps/ },
  { k: 'shadowSteps', fn: 'sunRayClear', when: (c, body) => c.slice(...body).includes('traceNearSteps('), text: SUN_SET, counts: [] },
  { k: 'nearSteps', fn: 'traceNearSteps', text: WALK_TAKE, counts: [] },
  { k: 'nearSteps', loop: 'traceNearSteps', header: /maxSteps/, unless: 'lcNext', text: WALK_BUMP, counts: ['nearSteps', 'shadowSteps'] },
  { k: 'nearSteps', loop: 'lcNext', header: /^loop$/, text: WALK_BUMP, counts: ['nearSteps', 'shadowSteps'] },
  { k: 'reflSteps', loop: 'reflectHit', header: /REFL_MAX_STEPS/ },
  { k: 'refractions', fn: 'liquidInterface' },
  { k: 'refractions', fn: 'crystalInterface' },
  { k: 'rootIters', loop: 'surfRoot', header: /SURF_ROOT_STEPS/ },
  { k: 'rootIters', loop: 'reflCross', header: /SURF_ROOT_STEPS/ },
  { k: 'shading', fn: 'shadeHit' },
  { k: 'sunShadow', fn: 'sunMapShadow' },
  { k: 'sunShadow', fn: 'sunMapShadowAt' },
  { k: 'fieldReads', fn: 'fieldTex', unless: 'fieldTexL' },
  { k: 'fieldReads', after: 'fieldTexL', stmt: 'if (!fieldHas(t, L)) { return vec4f(0.0); }' },
  { k: 'fieldReads', fn: 'cubicFetch8', n: 8 },
  { k: 'fieldReads', fn: 'fieldFetch8', n: 8 },
  { k: 'cellReads', fn: 'fetchAs' },
  { k: 'cellReads', fn: 'fetchBs' },
  { k: 'cellReads', fn: 'fetchNativeCore' },
  { k: 'cellReads', fn: 'occIdOf' },
  { k: 'cellReads', fn: 'wcCell' },
];

// Where the sink writes a module's counts: after the trace that does its work, as its reflection is
// returned, or before its final return.
const STORE_AT = [
  { after: 'let g = traceView(ro, rd, t0, bh);' },   // the split march
  { after: 'let h = traceView(ro, rd, t0, bh);' },   // the whole march, the box volume
  { wrap: 'return vec4f(reflectView(px, f), 0.0);', open: 'return '.length },   // the reflect stage
  { before: '  return o;\n}', need: 'let h = shadeView(' },   // the shade stage
];

function splice(code, ins) {
  ins.sort((a, b) => a[0] - b[0]);
  let out = '', from = 0;
  for (const [p, t] of ins) { out += code.slice(from, p) + t; from = p; }
  return out + code.slice(from);
}

const isWorld = (code) => /\bfn wcCell\(/.test(code);
/** The counters a whole module (the box volume's, the world's whole march) must count. */
export function costRequired(code) {
  const tv = fnBody(code, 'traceView');
  const trace = tv ? code.slice(...tv) : '';
  return COST_KINDS.filter((k) => !(SKIP_SPLIT_KINDS.includes(k) && !trace.includes('ax = skipEmpty(')));
}

/**
 * The cost variant of a lit module: `code` (the live pipeline's text) with counter spans inserted,
 * the counters stored to a storage texture at group 0 `binding`. require: the counters that must
 * count here (by default costRequired(code); a split stage counts only its share, and the check
 * proves the stages together count them all). Throws if an anchor is gone or a required counter
 * would count nowhere.
 * @param {string} code
 * @param {{ binding: number, require?: string[] }} opts
 * @returns {string}
 */
export function costify(code, { binding, require } = {}) {
  if (code.includes(OPEN)) throw new Error('costView: the module is already counted');
  if (!Number.isInteger(binding)) throw new Error('costView: the counters\' storage binding is required');
  const world = isWorld(code);
  const ins = [];   // [position, text]
  const counted = new Set();
  for (const r of RULES) {
    if (r.world !== undefined && r.world !== world) continue;
    const body = fnBody(code, r.fn ?? r.loop ?? r.after ?? r.before);
    if (!body || (r.unless && fnBody(code, r.unless)) || (r.when && !r.when(code, body))) continue;
    const s = span(r.text ?? bump(r.k, r.n));
    const where = r.fn ? [body[0] + 1] : r.loop ? loopOpens(code, body, r.header)
      : r.after ? stmtEnds(code, body, r.stmt) : stmtStarts(code, body, r.stmt);
    for (const p of where) ins.push([p, s]);
    if (where.length) for (const k of r.counts ?? [r.k]) counted.add(k);
  }
  const missing = (require ?? costRequired(code)).filter((k) => !counted.has(k));
  if (missing.length) throw new Error(`costView: no anchor for ${missing.join(', ')} (did the tracer change? shaders/costView.js RULES)`);
  const fs = fnBody(code, 'fs');
  if (!fs) throw new Error('costView: no fragment entry fs');
  const entry = code.slice(fs[0], fs[1]);
  const where = STORE_AT.find((w) => entry.includes(w.after ?? w.wrap ?? w.need));
  if (!where) throw new Error('costView: the entry changed (no place to write its counts)');
  if (where.after) {
    ins.push([fs[0] + entry.indexOf(where.after) + where.after.length, span(STORE_AFTER)]);
  } else if (where.wrap) {
    const i = fs[0] + entry.indexOf(where.wrap);
    ins.push([i + where.open, span(PASS_OPEN)], [i + where.wrap.length - 1, span(PASS_CLOSE)]);
  } else {
    ins.push([fs[0] + entry.lastIndexOf(where.before) + 2, span(STORE)]);
  }
  ins.push([0, span(storagePrelude(binding))]);
  return splice(code, ins);
}

/** The storage sink's binding in a group 0 of these layout entries: the next free one. */
export const costBinding = (entries) => Math.max(-1, ...entries.map((e) => e.binding)) + 1;
/** The sink's layout entry. */
export const costLayoutEntry = (binding) => ({ binding, visibility: STAGE.FRAGMENT, storageTexture: { access: 'write-only', format: COST_STORAGE_FORMAT, viewDimension: '2d' } });

/** `code` with every cost span removed. */
export const stripCost = (code) => code.replace(/\/\*cost\{\*\/[\s\S]*?\/\*\}cost\*\//g, '');

/**
 * Proves a cost module is `normal` plus counter spans only: stripping them gives `normal` exactly,
 * and each span is a counter increment, the counters' declarations or their store.
 * @returns {{ ok: boolean, spans: number, bumps: Record<string, number>, problems: string[] }}
 */
export function verifyCost(normal, cost, { require = COST_KINDS } = {}) {
  const problems = [], bumps = Object.fromEntries(COST_KINDS.map((k) => [k, 0]));
  let spans = 0;
  for (const m of cost.matchAll(/\/\*cost\{\*\/([\s\S]*?)\/\*\}cost\*\//g)) {
    spans++;
    const b = BUMP_RE.exec(m[1]);
    if (b && COST_KINDS[+b[1]]) bumps[COST_KINDS[+b[1]]]++;
    else if (SPECIAL.has(m[1])) for (const k of SPECIAL.get(m[1])) bumps[k]++;
    else if (!isPrelude(m[1])) problems.push(`span ${spans} is not a counter line: ${m[1].slice(0, 80)}`);
  }
  if (stripCost(cost) !== normal) problems.push('the module without its cost spans is not the normal module');
  for (const k of require) if (!bumps[k]) problems.push(`${k} counts nowhere`);
  return { ok: problems.length === 0, spans, bumps, problems };
}

// tools/check-wgsl.mjs (and the deploy's operator gate): the counted twins of every lit view's
// levels: the world march's, whole and split, and the box volume's, flat and curved. warm: never.
const withSink = (entries) => [...entries, costLayoutEntry(costBinding(entries))];
const worldCostCheck = (view, level, d, stage) => {
  const [frame, ...rest] = WORLD_MARCH_LAYOUTS(undefined, stage);
  return {
    name: `world.${view}.${level}.${stage}.cost`, view, detail: d(), kind: 'render', warm: () => false,
    code: (g) => costify(worldMarchFrag(g, { view, detail: d(), stage }), { binding: costBinding(frame), require: stage === 'whole' ? undefined : [] }),
    layouts: () => [withSink(frame), ...rest],
    layoutNames: [`${worldMarchLayoutNames(stage)[0]}_COST`, ...worldMarchLayoutNames(stage).slice(1)],
    params: MarchParams, ...worldMarchPipeline(stage),
  };
};
export const WGSL_CHECK = () => [
  ...VOLUME_VIEWS.filter(isMaterialView).flatMap((view) => Object.entries(REALISTIC_LEVELS).flatMap(([level, d]) =>
    ['whole', ...(marchSplits(d()) ? MARCH_STAGES : [])].map((stage) => worldCostCheck(view, level, d, stage)))),
  ...VOLUME_VIEWS.filter(isMaterialView).flatMap((view) => Object.entries(REALISTIC_LEVELS).flatMap(([k, d]) => [false, true].map((curved) => {
    const [frame, ...rest] = VOLUME_LAYOUTS();
    return {
      name: `volume.${view}.${k}${curved ? '.curved' : ''}.cost`, view, detail: d(), curved, warm: () => false,
      ...(curved ? { grids: ['64'] } : {}),
      kind: 'render',
      code: (g) => costify(volumeFrag(g, { view, detail: d(), curved }), { binding: costBinding(frame) }),
      layouts: () => [withSink(frame), ...rest],
      layoutNames: [`${LAYOUT_NAMES.volume[0]}_COST`, ...LAYOUT_NAMES.volume.slice(1)],
      params: VolumeParams,
      ...volumePipeline(),
    };
  }))),
];

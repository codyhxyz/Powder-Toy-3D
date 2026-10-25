// The cost view (docs/profiler.md "Cost view"): the volume's lit module with
// per-pixel work counters, and nothing else changed.
//
// Honest by construction. The counted module is the live pipeline's own WGSL
// text (gfx/volume.js builds it with shaders/render.js volumeFrag) with spans
// inserted, each fenced `/*cost{*/ … /*}cost*/`. Nothing is removed or
// rewritten: stripCost(costify(code)) === code, and verifyCost() also proves
// every span is one of the few kinds below (a counter increment, the counters'
// declarations, the outputs that carry them). The tracer itself is never
// copied, so the counters follow whatever the realistic march becomes, and an
// anchor that stops matching throws (a counter that silently reads 0 would lie).
//
// The variant writes the same colour (location 0) and depth, and two integer
// targets beside it (COST_TARGETS): twelve counters, 16 bits each, saturating.
// Pixels whose ray missed everything still write their counters, with colour 0
// and depth 1 (what a discard leaves under "over" blending, on a cleared
// target), so a ray through empty air shows its cost too. gfx/costView.js
// draws the live pipeline and this one on the same frame state and compares
// their colour before it trusts a single count.

import { volumeFrag, VOLUME_LAYOUTS, LAYOUT_NAMES, VolumeParams, volumePipeline, REALISTIC_LEVELS, VOLUME_VIEWS } from './render.js';
import { isMaterialView } from '../views.js';
import { STAGE } from './common.js';
import { worldMarchFrag, WORLD_MARCH_LAYOUTS, worldMarchLayoutNames, worldMarchPipeline, MarchParams, MARCH_STAGES, marchSplits } from './world/march.js';

/**
 * The counters, in slot order. Each counts work, not time: the variant's speed
 * says nothing about the real shader's (counter writes change its registers).
 * where: what is counted, by the module's own names.
 */
export const COST_COUNTERS = [
  { key: 'march', label: 'main march steps', where: "iterations of traceView's main loop (refraction restarts included)" },
  { key: 'brickSkips', label: 'bricks skipped', where: "traceView's empty-region jumps (skipEmpty; curved: warpSkip)" },
  { key: 'cellSteps', label: 'cells stepped', where: "traceView's DDA advances (the crisp-only fast path, ddaStep; curved: warpAdvance)" },
  { key: 'shadowSteps', label: 'sun-ray walk steps', where: 'iterations of sunRayClear (secondary shadow rays)' },
  { key: 'nearSteps', label: 'near-field / AO / lamp walk steps', where: 'iterations of traceNearSteps' },
  { key: 'reflSteps', label: 'reflection march steps', where: 'iterations of reflectHit (the traced reflection)' },
  { key: 'refractions', label: 'refraction bends', where: 'liquidInterface and crystalInterface calls (each restarts the main march)' },
  { key: 'rootIters', label: 'surface root-finder iterations', where: 'iterations of surfRoot and reflCross' },
  { key: 'shading', label: 'surface shadings', where: 'shadeHit calls' },
  { key: 'sunShadow', label: 'sun-shadow lookups', where: 'sunMapShadow and sunMapShadowAt calls (sunShadow / sunShadowAt reach the map through them)' },
  { key: 'fieldReads', label: 'field texture taps', where: 'fieldTex calls (1 tap) and cubicFetch8 calls (8 taps)' },
  { key: 'cellReads', label: 'cell reads', where: 'fetchAs, fetchBs, fetchNativeCore (state) and occIdOf (occupancy ids) calls' },
];
export const COST_KINDS = COST_COUNTERS.map((c) => c.key);
const SLOT = Object.fromEntries(COST_KINDS.map((k, i) => [k, i]));
/** Largest count a slot holds (16 bits; the march's slot keeps its top bit for coverage). */
export const COST_MAX = 0xffff;
export const COST_MARCH_MAX = 0x7fff;
/** Slot 0's coverage bit: the box was hit and traceView ran for this pixel. */
export const COST_COVERED_BIT = 0x8000;
/**
 * The variant's targets after the colour: 2 × 16-bit counters per u32. With
 * the scene's rgba16float colour that is 8 + 16 + 8 = 32 bytes per sample,
 * WebGPU's default maxColorAttachmentBytesPerSample (gpu/device.js asks no more).
 */
export const COST_TARGETS = [{ format: 'rgba32uint' }, { format: 'rg32uint' }];

const OPEN = '/*cost{*/', CLOSE = '/*}cost*/';
const span = (s) => `${OPEN}${s}${CLOSE}`;
const bump = (k, n = 1) => `gCost[${SLOT[k]}] += ${n}u;`;
const pack = (a, b) => `costPack(${a}, ${b})`;
const at = (k) => `gCost[${SLOT[k]}]`;

// Both sinks declare the counters, their packing and the walk-kind flags: gCostSun is set by a
// sun ray that walks through traceNearSteps (the world's), gCostWalkSun is the walk's own copy, so
// one walker's steps land in the walk type that asked for them.
const COUNTERS_WGSL = `
// ---- cost view counters (shaders/costView.js) ----
var<private> gCost: array<u32, ${COST_COUNTERS.length}>;
var<private> gCostSun: bool;
var<private> gCostWalkSun: bool;
fn costPack(a: u32, b: u32) -> u32 { return min(a, ${COST_MAX}u) | (min(b, ${COST_MAX}u) << 16u); }
fn costWords0() -> vec4u { return vec4u(${pack(`(min(${at('march')}, ${COST_MARCH_MAX}u) | ${COST_COVERED_BIT}u)`, at('brickSkips'))}, ${pack(at('cellSteps'), at('shadowSteps'))}, ${pack(at('nearSteps'), at('reflSteps'))}, ${pack(at('refractions'), at('rootIters'))}); }
fn costWords1() -> vec2u { return vec2u(${pack(at('shading'), at('sunShadow'))}, ${pack(at('fieldReads'), at('cellReads'))}); }
`;
// 'targets' (the box volume): two integer colour targets beside its colour (COST_TARGETS).
const PRELUDE = `${COUNTERS_WGSL}fn costWrite(o: ptr<function, VolumeFrag>) {
  (*o).cost0 = costWords0();
  (*o).cost1 = costWords1();
}
`;
const FIELDS = ' @location(1) cost0: vec4u, @location(2) cost1: vec2u,';
const MISS = 'if (!h.hit) { costWrite(&o); o.color = vec4f(0.0); o.depth = 1.0; return o; }\n  ';
const WRITE = 'costWrite(&o);\n  ';
// 'storage' (the world march's modules, whose colour targets are full: the march stage's G0 and G1
// take all 32 bytes a sample may have): a write-only rgba32uint storage texture in group 0 at
// `binding`, twice the scene target's height, the pixel's two words-groups in rows 2y and 2y + 1.
// Written where the stage's work is done (after the march's trace, before the shade's return, as
// the reflect's result is returned: costPass passes the value through unchanged).
export const COST_STORAGE_FORMAT = 'rgba32uint';
export const COST_STORAGE_ROWS = 2;
const storagePrelude = (binding) => `${COUNTERS_WGSL}@group(0) @binding(${binding}) var gCostTex: texture_storage_2d<${COST_STORAGE_FORMAT}, write>;
fn costStore() {
  let p = vec2i(floor(gFragCoord));
  textureStore(gCostTex, vec2i(p.x, ${COST_STORAGE_ROWS} * p.y), costWords0());
  textureStore(gCostTex, vec2i(p.x, ${COST_STORAGE_ROWS} * p.y + 1), vec4u(costWords1(), 0u, 0u));
}
fn costPass(v: vec4f) -> vec4f { costStore(); return v; }
`;
const STORE = 'costStore();\n  ';
const STORE_AFTER = '\n  costStore();';
const PASS_OPEN = 'costPass(', PASS_CLOSE = ')';
const SUN_SET = 'gCostSun = true;';
const WALK_TAKE = 'gCostWalkSun = gCostSun; gCostSun = false;';
const ALLOWED = new Set([PRELUDE, FIELDS, MISS, WRITE, STORE, STORE_AFTER, PASS_OPEN, PASS_CLOSE, SUN_SET, WALK_TAKE]);
const allowed = (s) => ALLOWED.has(s) || (/^\n\/\/ ---- cost view counters/.test(s) && s === storagePrelude(+(/@binding\((\d+)\) var gCostTex/.exec(s)?.[1] ?? -1)));
const BUMP_RE = /^gCost\[(\d+)\] \+= (\d+)u;$/;
// a walker's step: the sun ray's or the near field's, by who asked (gCostWalkSun)
const WALK_BUMP = `gCost[select(${SLOT.nearSteps}u, ${SLOT.shadowSteps}u, gCostWalkSun)] += 1u;`;
const WALK_BUMP_RE = new RegExp(`^${WALK_BUMP.replace(/[[\]()+]/g, '\\$&')}$`);

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

// Where each counter counts. fn: a function's entry; loop: iterations of the loops of fn whose
// header matches ('loop' matches a bare loop); after: right after each occurrence of a statement in
// fn. A rule whose function the module lacks (curved-only, a read format's, the world's or the box's
// readers) inserts nothing; unless: skipped when the module has that function (the world's
// fieldTexL counts the taps fieldTex makes). costify throws if a required counter counts nowhere.
const RULES = [
  { k: 'march', loop: 'traceView', header: /BEND_EXTRA_STEPS/ },
  { k: 'brickSkips', after: 'traceView', stmt: 'ax = skipEmpty(bc, ro, rd, istp, &cell, &tMax, &tEnter);' },
  { k: 'brickSkips', after: 'traceView', stmt: 'warpSkip(&walk, bc, true);' },
  { k: 'cellSteps', after: 'traceView', stmt: 'cell[ax] += istp[ax];' },
  { k: 'cellSteps', after: 'traceView', stmt: 'ax = ddaStep(istp, tDelta, &cell, &tMax);' },
  { k: 'cellSteps', after: 'traceView', stmt: 'warpAdvance(&walk);' },
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

// Where the storage sink writes a stage's counts: after the trace that does its work, as its
// reflection is returned, or before its final return.
const STORE_AT = [
  { after: 'let g = traceView(ro, rd, t0, bh);' },   // the split march
  { after: 'let h = traceView(ro, rd, t0, bh);' },   // the whole march
  { wrap: 'return vec4f(reflectView(px, f), 0.0);', open: 'return '.length },   // the reflect stage
  { before: '  return o;\n}', last: true, need: 'let h = shadeView(' },   // the shade stage
];

function splice(code, ins) {
  ins.sort((a, b) => a[0] - b[0]);
  let out = '', from = 0;
  for (const [p, t] of ins) { out += code.slice(from, p) + t; from = p; }
  return out + code.slice(from);
}

/**
 * The cost variant of a lit module: `code` (the live pipeline's text) with counter spans inserted.
 * sink 'targets' (the box volume: VolumeFrag's integer targets) or 'storage' (the world march's
 * modules: a storage texture at group 0 `binding`). require: the counters that must count here
 * (a split stage counts only its share; the check proves the stages together count them all).
 * Throws if an anchor is gone or a required counter would count nowhere.
 * @param {string} code
 * @param {{ sink?: 'targets' | 'storage', binding?: number, require?: string[] }} [opts]
 * @returns {string}
 */
export function costify(code, { sink = 'targets', binding, require = COST_KINDS } = {}) {
  if (code.includes(OPEN)) throw new Error('costView: the module is already counted');
  const ins = [];   // [position, text]
  const counted = new Set();
  for (const r of RULES) {
    const body = fnBody(code, r.fn ?? r.loop ?? r.after);
    if (!body || (r.unless && fnBody(code, r.unless)) || (r.when && !r.when(code, body))) continue;
    const s = span(r.text ?? bump(r.k, r.n));
    const at = r.fn ? [body[0] + 1] : r.loop ? loopOpens(code, body, r.header) : stmtEnds(code, body, r.stmt);
    for (const p of at) ins.push([p, s]);
    if (at.length) for (const k of r.counts ?? [r.k]) counted.add(k);
  }
  const missing = require.filter((k) => !counted.has(k));
  if (missing.length) throw new Error(`costView: no anchor for ${missing.join(', ')} (did the tracer change? shaders/costView.js RULES)`);
  const fs = fnBody(code, 'fs');
  if (!fs) throw new Error('costView: no fragment entry fs');
  if (sink === 'targets') {
    // the entry: the outputs, the miss, the write
    const st = /struct VolumeFrag \{[^}]*@builtin\(frag_depth\) depth: f32,/.exec(code);
    if (!st) throw new Error('costView: not a volume module (no VolumeFrag)');
    const miss = '  if (!h.hit) { discard; return o; }';
    const mi = code.indexOf(miss, fs[0]);
    const ret = code.lastIndexOf('  return o;\n}', fs[1]);
    if (mi < 0 || mi > fs[1] || ret < mi) throw new Error('costView: the volume entry changed (no miss discard / final return)');
    ins.push([0, span(PRELUDE)], [st.index + st[0].length, span(FIELDS)], [mi + 2, span(MISS)], [ret + 2, span(WRITE)]);
    return splice(code, ins);
  }
  if (sink !== 'storage' || !Number.isInteger(binding)) throw new Error('costView: sink is \'targets\' or \'storage\' with a binding');
  const entry = code.slice(fs[0], fs[1]);
  const where = STORE_AT.find((w) => entry.includes(w.after ?? w.wrap ?? w.need));
  if (!where) throw new Error('costView: the stage entry changed (no place to write its counts)');
  if (where.after) {
    const i = fs[0] + entry.indexOf(where.after) + where.after.length;
    ins.push([i, span(STORE_AFTER)]);
  } else if (where.wrap) {
    const i = fs[0] + entry.indexOf(where.wrap);
    ins.push([i + where.open, span(PASS_OPEN)], [i + where.wrap.length - 1, span(PASS_CLOSE)]);
  } else {
    const i = fs[0] + entry.lastIndexOf(where.before);
    ins.push([i + 2, span(STORE)]);
  }
  ins.push([0, span(storagePrelude(binding))]);
  return splice(code, ins);
}

/** The storage sink's binding in a group 0 of these layout entries: the next free one. */
export const costBinding = (entries) => Math.max(-1, ...entries.map((e) => e.binding)) + 1;

/** `code` with every cost span removed. */
export const stripCost = (code) => code.replace(/\/\*cost\{\*\/[\s\S]*?\/\*\}cost\*\//g, '');

/**
 * Proves a cost module is `normal` plus counter spans only: stripping them gives `normal` exactly,
 * and each span is a counter increment, the counters' declarations or their outputs.
 * @returns {{ ok: boolean, spans: number, bumps: Record<string, number>, problems: string[] }}
 */
export function verifyCost(normal, cost, { require = COST_KINDS } = {}) {
  const problems = [], bumps = Object.fromEntries(COST_KINDS.map((k) => [k, 0]));
  let spans = 0;
  for (const m of cost.matchAll(/\/\*cost\{\*\/([\s\S]*?)\/\*\}cost\*\//g)) {
    spans++;
    const b = BUMP_RE.exec(m[1]);
    if (b && COST_KINDS[+b[1]]) bumps[COST_KINDS[+b[1]]]++;
    else if (WALK_BUMP_RE.test(m[1])) { bumps.nearSteps++; bumps.shadowSteps++; }
    else if (!allowed(m[1])) problems.push(`span ${spans} is not a counter line: ${m[1].slice(0, 80)}`);
  }
  if (stripCost(cost) !== normal) problems.push('the module without its cost spans is not the normal module');
  for (const k of require) if (!bumps[k]) problems.push(`${k} counts nowhere`);
  return { ok: problems.length === 0, spans, bumps, problems };
}

/** The cost variant's pipeline description: the volume's, with the counters' targets after its colour. */
export const costPipeline = (base = volumePipeline()) => ({
  ...base,
  fragment: { ...base.fragment, targets: [...base.fragment.targets, ...COST_TARGETS] },
});

// the world march's twins (gfx/worldView.js costTwin): group 0 with the counters' storage texture
const worldCostCheck = (view, level, d, stage) => {
  const [frame, ...rest] = WORLD_MARCH_LAYOUTS(undefined, stage);
  const binding = costBinding(frame);
  return {
    name: `world.${view}.${level}.${stage}.cost`, view, detail: d(), kind: 'render', warm: () => false,
    code: (g) => costify(worldMarchFrag(g, { view, detail: d(), stage }), { sink: 'storage', binding, require: stage === 'whole' ? COST_KINDS : [] }),
    layouts: () => [[...frame, { binding, visibility: STAGE.FRAGMENT, storageTexture: { access: 'write-only', format: COST_STORAGE_FORMAT, viewDimension: '2d' } }], ...rest],
    layoutNames: [`${worldMarchLayoutNames(stage)[0]}_COST`, ...worldMarchLayoutNames(stage).slice(1)],
    params: MarchParams, ...worldMarchPipeline(stage),
  };
};
// tools/check-wgsl.mjs (and the deploy's operator gate): every lit view's levels, flat and curved;
// the world march's, whole and split. warm: never (the menu's warm-up never builds the cost view).
export const WGSL_CHECK = () => [...VOLUME_VIEWS.filter(isMaterialView).flatMap((view) => Object.entries(REALISTIC_LEVELS).flatMap(([level, d]) =>
  ['whole', ...(marchSplits(d()) ? MARCH_STAGES : [])].map((stage) => worldCostCheck(view, level, d, stage)))), ...VOLUME_VIEWS.filter(isMaterialView).flatMap((view) => Object.entries(REALISTIC_LEVELS).flatMap(([k, d]) => [false, true].map((curved) => ({
  name: `volume.${view}.${k}${curved ? '.curved' : ''}.cost`,
  view, detail: d(), curved, warm: () => false,
  ...(curved ? { grids: ['64'] } : {}),
  kind: 'render',
  code: (g) => costify(volumeFrag(g, { view, detail: d(), curved })),
  layouts: () => VOLUME_LAYOUTS(),
  layoutNames: LAYOUT_NAMES.volume,
  params: VolumeParams,
  ...costPipeline(),
}))))];

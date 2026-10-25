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

const PRELUDE = `
// ---- cost view counters (shaders/costView.js) ----
var<private> gCost: array<u32, ${COST_COUNTERS.length}>;
fn costPack(a: u32, b: u32) -> u32 { return min(a, ${COST_MAX}u) | (min(b, ${COST_MAX}u) << 16u); }
fn costWrite(o: ptr<function, VolumeFrag>) {
  (*o).cost0 = vec4u(${pack(`(min(${at('march')}, ${COST_MARCH_MAX}u) | ${COST_COVERED_BIT}u)`, at('brickSkips'))}, ${pack(at('cellSteps'), at('shadowSteps'))}, ${pack(at('nearSteps'), at('reflSteps'))}, ${pack(at('refractions'), at('rootIters'))});
  (*o).cost1 = vec2u(${pack(at('shading'), at('sunShadow'))}, ${pack(at('fieldReads'), at('cellReads'))});
}
`;
const FIELDS = ' @location(1) cost0: vec4u, @location(2) cost1: vec2u,';
const MISS = 'if (!h.hit) { costWrite(&o); o.color = vec4f(0.0); o.depth = 1.0; return o; }\n  ';
const WRITE = 'costWrite(&o);\n  ';
const ALLOWED = new Set([PRELUDE, FIELDS, MISS, WRITE]);
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
  const out = [], loop = /\bfor \(/g;
  loop.lastIndex = a;
  for (let m; (m = loop.exec(code)) && m.index < b;) {
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
// header matches; after: right after each occurrence of a statement in fn. A rule whose function
// the module lacks (curved-only, a read format's) inserts nothing; every counter must count
// somewhere, or costify throws.
const RULES = [
  { k: 'march', loop: 'traceView', header: /BEND_EXTRA_STEPS/ },
  { k: 'brickSkips', after: 'traceView', stmt: 'ax = skipEmpty(bc, ro, rd, istp, &cell, &tMax, &tEnter);' },
  { k: 'brickSkips', after: 'traceView', stmt: 'warpSkip(&walk, bc, true);' },
  { k: 'cellSteps', after: 'traceView', stmt: 'cell[ax] += istp[ax];' },
  { k: 'cellSteps', after: 'traceView', stmt: 'ax = ddaStep(istp, tDelta, &cell, &tMax);' },
  { k: 'cellSteps', after: 'traceView', stmt: 'warpAdvance(&walk);' },
  { k: 'shadowSteps', loop: 'sunRayClear', header: /MAX_STEPS/ },
  { k: 'nearSteps', loop: 'traceNearSteps', header: /maxSteps/ },
  { k: 'reflSteps', loop: 'reflectHit', header: /REFL_MAX_STEPS/ },
  { k: 'refractions', fn: 'liquidInterface' },
  { k: 'refractions', fn: 'crystalInterface' },
  { k: 'rootIters', loop: 'surfRoot', header: /SURF_ROOT_STEPS/ },
  { k: 'rootIters', loop: 'reflCross', header: /SURF_ROOT_STEPS/ },
  { k: 'shading', fn: 'shadeHit' },
  { k: 'sunShadow', fn: 'sunMapShadow' },
  { k: 'sunShadow', fn: 'sunMapShadowAt' },
  { k: 'fieldReads', fn: 'fieldTex' },
  { k: 'fieldReads', fn: 'cubicFetch8', n: 8 },
  { k: 'cellReads', fn: 'fetchAs' },
  { k: 'cellReads', fn: 'fetchBs' },
  { k: 'cellReads', fn: 'fetchNativeCore' },
  { k: 'cellReads', fn: 'occIdOf' },
];

/**
 * The cost variant of a lit volume module: `code` (volumeFrag's text, as the live pipeline has it)
 * with counter spans inserted. Throws if the module isn't a lit volume module or a counter would
 * count nowhere.
 * @param {string} code
 * @returns {string}
 */
export function costify(code) {
  if (code.includes(OPEN)) throw new Error('costView: the module is already counted');
  const ins = [];   // [position, text]
  const counted = new Set();
  for (const r of RULES) {
    const body = fnBody(code, r.fn ?? r.loop ?? r.after);
    if (!body) continue;
    const s = span(bump(r.k, r.n));
    const at = r.fn ? [body[0] + 1] : r.loop ? loopOpens(code, body, r.header) : stmtEnds(code, body, r.stmt);
    for (const p of at) ins.push([p, s]);
    if (at.length) counted.add(r.k);
  }
  const missing = COST_KINDS.filter((k) => !counted.has(k));
  if (missing.length) throw new Error(`costView: no anchor for ${missing.join(', ')} (did the tracer change? shaders/costView.js RULES)`);
  // the entry: the outputs, the miss, the write
  const fs = fnBody(code, 'fs');
  const st = /struct VolumeFrag \{[^}]*@builtin\(frag_depth\) depth: f32,/.exec(code);
  if (!fs || !st) throw new Error('costView: not a volume module (no fs / VolumeFrag)');
  const miss = '  if (!h.hit) { discard; return o; }';
  const mi = code.indexOf(miss, fs[0]);
  const ret = code.lastIndexOf('  return o;\n}', fs[1]);
  if (mi < 0 || mi > fs[1] || ret < mi) throw new Error('costView: the volume entry changed (no miss discard / final return)');
  ins.push([0, span(PRELUDE)], [st.index + st[0].length, span(FIELDS)], [mi + 2, span(MISS)], [ret + 2, span(WRITE)]);
  ins.sort((a, b) => a[0] - b[0]);
  let out = '', from = 0;
  for (const [p, t] of ins) { out += code.slice(from, p) + t; from = p; }
  return out + code.slice(from);
}

/** `code` with every cost span removed. */
export const stripCost = (code) => code.replace(/\/\*cost\{\*\/[\s\S]*?\/\*\}cost\*\//g, '');

/**
 * Proves a cost module is `normal` plus counter spans only: stripping them gives `normal` exactly,
 * and each span is a counter increment, the counters' declarations or their outputs.
 * @returns {{ ok: boolean, spans: number, bumps: Record<string, number>, problems: string[] }}
 */
export function verifyCost(normal, cost) {
  const problems = [], bumps = Object.fromEntries(COST_KINDS.map((k) => [k, 0]));
  let spans = 0;
  for (const m of cost.matchAll(/\/\*cost\{\*\/([\s\S]*?)\/\*\}cost\*\//g)) {
    spans++;
    const b = BUMP_RE.exec(m[1]);
    if (b && COST_KINDS[+b[1]]) bumps[COST_KINDS[+b[1]]]++;
    else if (!ALLOWED.has(m[1])) problems.push(`span ${spans} is not a counter line: ${m[1].slice(0, 80)}`);
  }
  if (stripCost(cost) !== normal) problems.push('the module without its cost spans is not the normal module');
  for (const k of COST_KINDS) if (!bumps[k]) problems.push(`${k} counts nowhere`);
  return { ok: problems.length === 0, spans, bumps, problems };
}

/** The cost variant's pipeline description: the volume's, with the counters' targets after its colour. */
export const costPipeline = (base = volumePipeline()) => ({
  ...base,
  fragment: { ...base.fragment, targets: [...base.fragment.targets, ...COST_TARGETS] },
});

// tools/check-wgsl.mjs (and the deploy's operator gate): every lit view's levels, flat and curved.
// warm: never (the menu's warm-up never builds the cost view).
export const WGSL_CHECK = () => VOLUME_VIEWS.filter(isMaterialView).flatMap((view) => Object.entries(REALISTIC_LEVELS).flatMap(([k, d]) => [false, true].map((curved) => ({
  name: `volume.${view}.${k}${curved ? '.curved' : ''}.cost`,
  view, detail: d(), curved, warm: () => false,
  ...(curved ? { grids: ['64'] } : {}),
  kind: 'render',
  code: (g) => costify(volumeFrag(g, { view, detail: d(), curved })),
  layouts: () => VOLUME_LAYOUTS(),
  layoutNames: LAYOUT_NAMES.volume,
  params: VolumeParams,
  ...costPipeline(),
}))));

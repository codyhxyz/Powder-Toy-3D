#!/usr/bin/env node
// Big maps are not a special case (src/wire/frameWires.js). Small maps draw
// through app.js's own frame, big maps through the WORLD renderer
// (src/wire/worldRenderFrame.js, app.js captureWorldRequest); a feature hooked
// into a wire must run on both. This CPU check (no browser, no GPU) fails when:
//   1. a frame path stops calling one of frameWires' dispatchers (each must be
//      called on the small-map path and the big-map path);
//   2. a per-frame wire hook is called by hand around the dispatchers, as
//      `wire('rays').beforeView(ctx)` or `for (const w of after) w.scene(ctx, rp)`
//      were: how the far field, the held tool's device check and every `before`
//      scene hook silently never ran on big maps (2026-10-23);
//   3. app.js loops a new hook over the wires that is neither a frame hook
//      (dispatch it through frameWires.js, both paths) nor a SHARED one below;
//   4. a wire or app.js skips the WORLD renderer's frame (`win?.render`)
//      without an `// Intentional (...)` comment saying why (CLAUDE.md, the
//      same-features-every-map rule);
//   5. code tests big map vs small map itself (`!win`, `app.win ?`,
//      `worldMode &&`, `g.windowed ?`, `isWorld(m)`, `inWorld()`) instead of
//      reading its row in src/mapKind.js, the one table of every difference;
//      or a row there is read nowhere.
// Usage: node tools/check-frame-wires.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_HOOKS, FRAME_DISPATCH } from '../src/wire/frameWires.js';
import { SMALL_MAP, BIG_MAP } from '../src/mapKind.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const failures = [];
const fail = (msg) => failures.push(msg);

// Hooks app.js runs outside the two frame paths, for every map alike (the tick's
// shared part, the build, settings): where each is dispatched, for the reader.
const SHARED = {
  boot: 'app.js boot, once',
  attach: 'app.js build',
  detach: 'app.js build',
  invalidate: 'app.js stopGraphics',
  detail: 'app.js detail switches',
  beforeStep: 'app.js tick, before the split into the two frame paths',
  follow: 'app.js tick, before the split',
  afterStep: 'app.js tick, before the split',
  busy: 'a query (deep idle, mesh frames, post-only frames), not a draw hook',
  meshesOnly: 'a flag read with busy',
};

// A function's text in `src` from `start` to its closing brace at column 0.
function functionText(src, start) {
  const at = src.indexOf(start);
  if (at < 0) return null;
  const end = src.indexOf('\n}\n', at);
  return src.slice(at, end < 0 ? undefined : end + 2);
}

const app = read('src/app.js');
const frame = read('src/wire/worldRenderFrame.js');
const capture = functionText(app, 'function captureWorldRequest(');
if (!capture) fail('src/app.js: function captureWorldRequest not found (the big-map request capture)');
const boxPath = capture ? app.replace(capture, '') : app;
const worldPath = `${frame}\n${capture ?? ''}`;

// 1. Both paths call every dispatcher.
for (const d of FRAME_DISPATCH) {
  const call = new RegExp(`frameWires\\.${d}\\(`);
  if (!call.test(boxPath)) fail(`small maps never call frameWires.${d}() (src/app.js frame: runView, frameHooks, drawScene)`);
  if (!call.test(worldPath)) fail(`big maps never call frameWires.${d}() (src/wire/worldRenderFrame.js recordWorldFrame, app.js captureWorldRequest)`);
}
const dispatchSrc = read('src/wire/frameWires.js');
for (const h of FRAME_HOOKS) {
  if (!new RegExp(`\\bw\\.${h}\\??\\.?\\(`).test(dispatchSrc)) fail(`src/wire/frameWires.js: FRAME_HOOKS lists ${h} but no dispatcher calls it`);
}

// 2. No frame hook called by hand anywhere in src but the dispatchers.
function* jsFiles(dir) {
  for (const name of readdirSync(join(root, dir))) {
    const p = join(dir, name);
    if (statSync(join(root, p)).isDirectory()) yield* jsFiles(p);
    else if (p.endsWith('.js')) yield p;
  }
}
const hookNames = [...FRAME_HOOKS, 'captureLighting'];
const handCall = new RegExp(`\\.(${hookNames.join('|')})\\??\\.?\\(\\s*(ctx|app)\\b`);
for (const p of jsFiles('src')) {
  const rel = relative(root, join(root, p));
  if (rel === join('src', 'wire', 'frameWires.js')) continue;
  read(p).split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    const m = line.match(handCall);
    if (m) fail(`${rel}:${i + 1}: the frame hook ${m[1]} is called by hand; dispatch it through frameWires (src/wire/frameWires.js) so big and small maps both run it`);
  });
}

// 3. Every hook app.js loops over the wires is a frame hook (via frameWires) or a shared one.
for (const m of app.matchAll(/\bw\.(\w+)\??\.?\(/g)) {
  const name = m[1];
  if (FRAME_HOOKS.includes(name)) continue;   // (rule 2 reports the call)
  if (!(name in SHARED) && name !== 'worldLoad') {
    const line = app.slice(0, m.index).split('\n').length;
    fail(`src/app.js:${line}: the wire hook ${name} is dispatched outside frameWires; add it to FRAME_HOOKS (src/wire/frameWires.js) and call it from both frame paths, or to SHARED in tools/check-frame-wires.mjs if it runs outside them for every map`);
  }
}
// Within the tick's split into the two frame paths, only queries.
const splitAt = app.indexOf('  let runDerived=false, runView=false;');
const splitEnd = app.indexOf("  // The HUD's rates", splitAt);
if (splitAt < 0 || splitEnd < 0) fail('src/app.js: the tick\'s split into the big-map and small-map frames was not found (update tools/check-frame-wires.mjs)');
else {
  const split = app.slice(splitAt, splitEnd);
  for (const m of split.matchAll(/\bw\.(\w+)\??\.?\(/g)) {
    if (m[1] !== 'busy') fail(`src/app.js tick: the wire hook ${m[1]} is called inside one frame path; call it through frameWires from both`);
  }
}

// 4. A skip of the WORLD renderer's frame says why.
const gate = /\bif\s*\(\s*!?\s*(app\.)?win\?\.render\s*\)/;
for (const p of ['src/app.js', ...[...jsFiles('src/wire')].filter((f) => !/worldRender(Frame)?\.js$/.test(f))]) {
  const lines = read(p).split('\n');
  lines.forEach((line, i) => {
    if (!gate.test(line)) return;
    const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
    if (!/Intentional \(/.test(context)) fail(`${p}:${i + 1}: a big-map skip (win?.render) without an "// Intentional (...)" comment within the 3 lines above`);
  });
}

// 5. Big vs small is read from src/mapKind.js, never tested ad hoc. A kind test is the window
// (`win`, app.js's own; `app.win`, `ctx.win` anywhere), `worldMode`, a grid's `g.windowed`,
// `isWorld(m)` or `inWorld()` used as a yes/no: `!x`, `x ?`, `x &&`, `&& x`, `x ||`, `if (x)`.
// Using the window (`win.size`, `win?.far`) or comparing it (`app.win !== world`) is not one;
// neither is a local `win` held from app.win (it is the window, already known to be there).
// The kind itself is decided in app.js build() (worldMode, then `mapKind = kindOf(...)`) and
// passed to kindOf / kindOfGrid; those are not tests either.
const KIND_SKIP = /^src\/(mapKind\.js|shaders\/|world\/|wire\/worldRender(Frame)?\.js|gfx\/worldVolume\.js)/;
const subjects = (own) => String.raw`(?:${own ? String.raw`(?<![\w.$])(?:win|worldMode)|` : ''}\b(?:app|ctx)\.(?:win|worldMode)|\bg\??\.windowed)`;
const kindTest = (own) => {
  const W = subjects(own), used = String.raw`(?!\s*(?:\.|\?\.|\[|[!=]==?))`;
  return new RegExp(String.raw`!+\s*${W}\b${used}|(?<![!=]=\s*)${W}\b\s*(?:\?(?![.?])|&&|\|\|)|(?:&&|\|\|)\s*${W}\b${used}|\bif\s*\(\s*${W}\s*\)|\bisWorld\(|\binWorld\(`);
};
const decided = (src) => {   // app.js build()'s lines that decide the kind
  const lines = src.split('\n'), from = lines.findIndex((l) => l.includes('worldMode = replicaMap')), to = lines.findIndex((l) => /^\s+mapKind = kindOf\(/.test(l));
  return from < 0 || to < from ? null : [from, to];
};
const rowsRead = new Set();
for (const p of jsFiles('src')) {
  if (p === join('src', 'mapKind.js')) continue;
  const src = read(p);
  for (const k of Object.keys(SMALL_MAP)) if (new RegExp(`\\.${k}\\b`).test(src)) rowsRead.add(k);
  if (KIND_SKIP.test(p) || (p === join('src', 'maps.js'))) continue;
  const own = p === join('src', 'app.js'), test = kindTest(own), span = own ? decided(src) : null;
  if (own && !span) fail('src/app.js: build()\'s kind decision (worldMode = replicaMap ... mapKind = kindOf(...)) was not found (update tools/check-frame-wires.mjs)');
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line) || (span && i >= span[0] && i <= span[1])) return;
    const code = line.replace(/\/\/.*$/, '').replace(/\bkindOf(Grid)?\([^)]*\)/g, '');
    if (test.test(code)) fail(`${p}:${i + 1}: a big/small map test of its own; read its row in src/mapKind.js (app.mapKind.<row>, kindOf / kindOfGrid / kindOfMap), adding the row there with why it differs`);
  });
}
for (const k of Object.keys(SMALL_MAP)) if (!rowsRead.has(k)) fail(`src/mapKind.js: the row ${k} is read nowhere in src; drop it or read it where the maps differ`);
if (Object.keys(BIG_MAP).join() !== Object.keys(SMALL_MAP).join()) fail('src/mapKind.js: SMALL_MAP and BIG_MAP have different rows');

if (failures.length) {
  console.error(`check-frame-wires: ${failures.length} problem(s): big maps and small maps must run the same wire hooks\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-frame-wires: both frame paths call ${FRAME_DISPATCH.join(', ')}; no hand-picked hook calls; every big-map skip is Intentional; big vs small is read from src/mapKind.js (${Object.keys(SMALL_MAP).length} rows)`);

// WGSL check (docs/webgpu.md I1, J4, W23). Replaces check-shaders.
//
// Every module under src/ that exports WGSL_CHECK (the convention is in
// src/gpu/checks.js) is imported in Node and its pipelines generated for each
// check grid. Then:
//   (a) validate: each distinct module text through createShaderModule and
//       getCompilationInfo on SwiftShader (Tint only, cheap): no errors, no
//       warnings. In Node, each @group/@binding declaration is matched against
//       the pipeline's layouts (buffer type, texture sample type and view
//       dimension, storage texture format and access), per-stage storage
//       buffers and storage textures are counted against 8/4 (SwiftShader
//       allows 10 buffers; only our requested limit catches an overrun), and
//       every dispatch size is computed for every grid, the giant volcano's
//       window included, ≤ 65,535 per dimension.
//   (b) build: create*PipelineAsync once per distinct module at its smallest
//       grid, within PIPELINE_BUDGET_MS (30 s); modules on a WGSL_MAC_ONLY
//       list are skipped with their reason. --time prints each creation time.
//   --curve: the compile-time curve of synthetic kernels on this device, with
//       the GPU process's log lines when one loses the device (W23).
//
// usage: node tools/check-wgsl.mjs [--time] [--no-build] [--only name,…] [--file part]
//        [--grid 32,64] [--budget ms] [--port N] [--browser-arg --some-switch]
//        [--curve [--family straight,branchy,ssa,swaps] [--sizes 200,400]]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser, gpuInfo } from './browser.mjs';
import { startVite } from './vite-server.mjs';
import { openHarness } from './harness/open.mjs';
import { PIPELINE_BUDGET_MS, MAX_WORKGROUPS, withVisibility, STAGE } from '../src/gpu/kernels.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const ONLY = opt('--only')?.split(',');
const FILE = opt('--file');
const TIME = flag('--time');
const BUILD = !flag('--no-build');
const CURVE = flag('--curve');
const BUDGET = Number(opt('--budget') ?? PIPELINE_BUDGET_MS);
const LIMITS = { storageBuffers: 8, storageTextures: 4, sampledTextures: 16 };

// The check grids: the test sizes, the box default (also the world window,
// 128³), the wide box, Dam Valley, and the giant volcano's window (384 tall).
export const GRIDS = { 32: [32, 32, 32], 64: [64, 64, 64], 128: [128, 128, 128], wide: [160, 96, 160], valley: [256, 96, 128], giant: [128, 384, 128] };
const GRID_KEYS = (opt('--grid')?.split(',') ?? Object.keys(GRIDS)).filter((k) => GRIDS[k]);

// gridLayout from src/sim.js when it imports, plus the WebGPU fields (C2, C5) when it lacks them
async function makeGrids() {
  let layout = null;
  try { ({ gridLayout: layout } = await import(pathToFileURL(join(ROOT, 'src/sim.js')))); } catch (e) {
    console.log(`note: src/sim.js doesn't import in Node (${e.message.split('\n')[0]}); grids carry only their sizes`);
  }
  return Object.fromEntries(Object.entries(GRIDS).map(([k, [nx, ny, nz]]) => {
    const g = { ...(layout ? layout(nx, ny, nz) : { nx, ny, nz }), name: k };
    g.slots ??= nx * ny * nz;
    g.bx ??= nx / 4; g.by ??= ny / 4; g.bz ??= nz / 4;
    g.nbricks ??= g.slots / 64;
    g.nsuper ??= g.slots / 1024;
    return [k, g];
  }));
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.js$/.test(n) ? [p] : [];
  });
}

// ---------------------------------------------------------------- bindings

const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Every resource declaration in a module: { group, binding, name, space, type }. */
export function parseBindings(code) {
  const out = [];
  const re = /((?:@(?:group|binding)\s*\(\s*\d+\s*\)\s*){2})var(?:\s*<([^>]*)>)?\s+([A-Za-z_]\w*)\s*:\s*([^;]+);/g;
  for (const m of stripComments(code).matchAll(re)) {
    out.push({
      group: Number(/@group\s*\(\s*(\d+)/.exec(m[1])[1]),
      binding: Number(/@binding\s*\(\s*(\d+)/.exec(m[1])[1]),
      space: m[2]?.split(',').map((s) => s.trim()) ?? null,
      name: m[3],
      type: m[4].trim(),
    });
  }
  return out;
}

const ACCESS = { write: 'write-only', read: 'read-only', read_write: 'read-write' };
// what a declaration needs from its layout entry, and whether `e` gives it
function matches(d, e) {
  if (d.space?.[0] === 'uniform') return e.buffer && (e.buffer.type ?? 'uniform') === 'uniform' ? null : 'a uniform buffer';
  if (d.space?.[0] === 'storage') {
    const want = d.space[1] === 'read_write' ? 'storage' : 'read-only-storage';
    return e.buffer?.type === want ? null : `a ${want} buffer`;
  }
  const t = d.type.replace(/\s+/g, '');
  if (t === 'sampler') return e.sampler && (e.sampler.type ?? 'filtering') !== 'comparison' ? null : 'a sampler';
  if (t === 'sampler_comparison') return e.sampler?.type === 'comparison' ? null : 'a comparison sampler';
  if (t === 'texture_external') return e.externalTexture ? null : 'an external texture';
  let m = /^texture_storage_(1d|2d|2d_array|3d)<(\w+),(\w+)>$/.exec(t);
  if (m) {
    const s = e.storageTexture;
    const want = `a ${m[1]} ${m[2]} storage texture (${ACCESS[m[3]]})`;
    return s && s.format === m[2] && (s.access ?? 'write-only') === ACCESS[m[3]] && (s.viewDimension ?? '2d') === m[1].replace('_', '-') ? null : want;
  }
  m = /^texture_depth_(multisampled_)?(2d|2d_array|cube|cube_array)$/.exec(t);
  if (m) {
    const x = e.texture;
    return x && x.sampleType === 'depth' && (x.viewDimension ?? '2d') === m[2].replace('_', '-') && Boolean(x.multisampled) === Boolean(m[1]) ? null : `a ${m[2]} depth texture`;
  }
  m = /^texture_(multisampled_)?(1d|2d|2d_array|3d|cube|cube_array)<(f32|i32|u32)>$/.exec(t);
  if (m) {
    const x = e.texture;
    const types = { f32: ['float', 'unfilterable-float'], i32: ['sint'], u32: ['uint'] }[m[3]];
    return x && types.includes(x.sampleType ?? 'float') && (x.viewDimension ?? '2d') === m[2].replace('_', '-') && Boolean(x.multisampled) === Boolean(m[1])
      ? null : `a ${m[2]} ${types.join('/')} texture`;
  }
  return `something for ${d.type}`;
}

const describe = (e) => (e.buffer ? `${e.buffer.type ?? 'uniform'} buffer` : e.texture ? `${e.texture.viewDimension ?? '2d'} ${e.texture.sampleType ?? 'float'} texture`
  : e.storageTexture ? `${e.storageTexture.viewDimension ?? '2d'} ${e.storageTexture.format} storage texture (${e.storageTexture.access ?? 'write-only'})`
    : e.sampler ? `${e.sampler.type ?? 'filtering'} sampler` : 'other');

const PARAMS_ENTRIES = [
  { binding: 0, buffer: { type: 'uniform', hasDynamicOffset: true } },
  { binding: 1, buffer: { type: 'uniform', hasDynamicOffset: true } },
];
// a pipeline's four groups as entry arrays (group 3: the params group unless given)
function normalizeGroups(layouts) {
  const g = [...(layouts ?? [])];
  while (g.length < 4) g.push(undefined);
  return g.map((x, i) => (x === 'PARAMS' || (i === 3 && x === undefined) ? PARAMS_ENTRIES : x === 'EMPTY' || !x ? [] : x));
}

function bindingProblems(code, groups) {
  const problems = [];
  const seen = new Set();
  for (const d of parseBindings(code)) {
    const where = `@group(${d.group}) @binding(${d.binding}) ${d.name}`;
    if (seen.has(`${d.group}/${d.binding}`)) problems.push(`${where}: declared twice`);
    seen.add(`${d.group}/${d.binding}`);
    const e = groups[d.group]?.find((x) => x.binding === d.binding);
    if (!e) { problems.push(`${where}: not in the layout of group ${d.group}`); continue; }
    const want = matches(d, e);
    if (want) problems.push(`${where}: WGSL wants ${want}, the layout has a ${describe(e)}`);
  }
  return problems;
}

// storage buffers, storage textures and sampled textures each stage sees
function stageCounts(groups, kind) {
  const stages = kind === 'render' ? { V: STAGE.VERTEX, F: STAGE.FRAGMENT } : { C: STAGE.COMPUTE };
  const out = {};
  for (const [s, bit] of Object.entries(stages)) {
    const c = { sb: 0, st: 0, tex: 0 };
    for (const e of groups.flat().map(withVisibility)) {
      if (!(e.visibility & bit)) continue;
      if (e.buffer && (e.buffer.type === 'storage' || e.buffer.type === 'read-only-storage')) c.sb++;
      if (e.storageTexture) c.st++;
      if (e.texture) c.tex++;
    }
    out[s] = c;
  }
  return out;
}

function dispatchProblems(entry, grids) {
  if (!entry.dispatch) return { problems: [], giant: null };
  const problems = [];
  let giant = null;
  for (const [k, g] of Object.entries(grids)) {
    let sizes = entry.dispatch(g);
    if (!Array.isArray(sizes[0])) sizes = [sizes];
    if (k === 'giant') giant = sizes;
    for (const s of sizes) {
      const [x, y = 1, z = 1] = s;
      if ([x, y, z].some((n) => !Number.isInteger(n) || n < 0 || n > MAX_WORKGROUPS)) problems.push(`dispatch [${s}] at ${k} is outside 0..${MAX_WORKGROUPS} per dimension (fold() it)`);
    }
  }
  return { problems, giant };
}

// ---------------------------------------------------------------- the curve's synthetic kernels

const REGS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
function straightKernel(n, salt) {
  const body = [];
  for (let k = 0; k < n; k++) {
    const x = REGS[k % 8], y = REGS[(k * 3 + 1) % 8], z = REGS[(k * 5 + 2) % 8];
    body.push([
      `  ${x} = ${x} * ${(1 + (k % 7) * 1e-4).toFixed(4)} + ${y}.yzwx;`,
      `  ${x} = select(${x}, ${z} * 0.5, ${y} > ${x});`,
      `  ${x} = clamp(${x} - ${y} * ${z}.w, vec4f(-8.0), vec4f(8.0));`,
      `  ${x} = ${x} + buf[(i + ${k}u) & 1023u] * ${z}.x;`,
    ][k % 4]);
  }
  return `// curve ${salt}: ${n} straight-line statements
@group(0) @binding(0) var<storage, read_write> buf: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
${REGS.map((r, j) => `  var ${r} = buf[(i + ${j}u) & 1023u];`).join('\n')}
${body.join('\n')}
  buf[i & 1023u] = ${REGS.join(' + ')};
}`;
}
// one `if` per rule on a loaded id, three statements each: the shape of
// per-element rules. (Not an else-if ladder: Tint refuses a chain longer than
// 127, "statement nesting depth / chaining length exceeds limit of 127".)
function branchyKernel(n, salt) {
  const rungs = Math.ceil(n / 5);
  const body = [];
  for (let r = 0; r < rungs; r++) {
    const x = REGS[r % 8], y = REGS[(r + 3) % 8];
    body.push(`  if (k == ${r}u) {`,
      `    ${x} = ${x} * ${(1 + (r % 5) * 1e-3).toFixed(3)} + ${y}.wzyx;`,
      `    ${y} = select(${y}, ${x} - 1.0, ${x}.x > ${(r % 9) / 9});`,
      `    ${x}.w = ${x}.w + buf[(i + ${r}u) & 1023u].x;`,
      '  }');
  }
  return `// curve ${salt}: ${rungs} rules
@group(0) @binding(0) var<storage, read_write> buf: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
${REGS.map((r, j) => `  var ${r} = buf[(i + ${j}u) & 1023u];`).join('\n')}
  let k = u32(abs(a.x) * 97.0) % ${rungs}u;
${body.join('\n')}
  buf[i & 1023u] = ${REGS.join(' + ')};
}`;
}
// the move's block solve (move.js moveBlockFrag): eight cells' mutable state
// (a, v, k, d, m) swapped inside nested ifs guarded by inlined helper calls
// and random draws, about 10 lines a rule
function swapsKernel(n, salt) {
  const rules = Math.ceil(n / 10);
  const body = [];
  for (let r = 0; r < rules; r++) {
    const x = r % 8, y = (r * 3 + 1 + (r >> 3)) % 8 === x ? (x + 1) % 8 : (r * 3 + 1 + (r >> 3)) % 8;
    body.push(`  if (!m${x} && canMove(k${x}, k${y}, d${x}, d${y})) {`,
      `    if (rnd(&rs) < ${((r % 7) + 1) / 8}) {`,
      `      let ta = a${x}; a${x} = a${y}; a${y} = ta;`,
      `      let tv = v${x}; v${x} = v${y}; v${y} = tv;`,
      `      let tk = k${x}; k${x} = k${y}; k${y} = tk;`,
      `      let td = d${x}; d${x} = d${y}; d${y} = td;`,
      `      m${x} = true; m${y} = true;`,
      `    } else { v${x} = v${x} * 0.9 + vec3f(rnd(&rs) * 0.01); }`,
      '  }');
  }
  const cells = Array.from({ length: 8 }, (_, j) => `  var a${j} = A[(i * 8u + ${j}u) & 1023u]; var v${j} = a${j}.yzw; var k${j} = i32(a${j}.x); var d${j} = density(k${j}, a${j}.y); var m${j} = false;`);
  return `// curve ${salt}: ${rules} swap rules over 8 cells
@group(0) @binding(0) var<storage, read_write> A: array<vec4f>;
fn pcg(v: u32) -> u32 { let s = v * 747796405u + 2891336453u; let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
fn rnd(rs: ptr<function, u32>) -> f32 { *rs = pcg(*rs); return f32(*rs >> 8u) * (1.0 / 16777216.0); }
fn density(k: i32, t: f32) -> f32 { return f32(k & 15) * 0.1 + t * 0.001; }
fn canMove(a: i32, b: i32, da: f32, db: f32) -> bool { return a != b && (da > db || (b & 3) == 0); }
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  var rs = i * 0x9e3779b9u;
${cells.join('\n')}
${body.join('\n')}
${Array.from({ length: 8 }, (_, j) => `  A[(i * 8u + ${j}u) & 1023u] = vec4f(f32(k${j}) + d${j}, v${j}) + select(vec4f(0.0), a${j}, m${j});`).join('\n')}
}`;
}
// generated-code shape: every statement a new scalar `let` reading earlier
// ones far back, so many values stay live at once (the move's block solve
// keeps about 112 scalars live, D2)
function ssaKernel(n, salt) {
  const body = [];
  for (let k = 8; k < n + 8; k++) {
    const a = k - 1, b = k - 1 - (k * 7) % Math.min(k - 1, 97), c = (k * 13) % k;
    body.push([
      `  let t${k} = t${a} * ${(1 + (k % 11) * 1e-4).toFixed(4)} + t${b};`,
      `  let t${k} = select(t${b}, t${c} - t${a}, t${a} > t${c});`,
      `  let t${k} = min(max(t${a}, t${c} * 0.5), t${b} + 1.0);`,
      `  let t${k} = t${a} + buf[(i + ${k}u) & 1023u] * t${c};`,
    ][k % 4]);
  }
  const last = Array.from({ length: 8 }, (_, j) => `t${n + 7 - j * Math.floor(n / 8)}`);
  return `// curve ${salt}: ${n} SSA statements
@group(0) @binding(0) var<storage, read_write> buf: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
${Array.from({ length: 8 }, (_, j) => `  let t${j} = buf[(i + ${j}u) & 1023u];`).join('\n')}
${body.join('\n')}
  buf[i & 1023u] = ${last.join(' + ')};
}`;
}

// ---------------------------------------------------------------- main

const grids = await makeGrids();
const files = walk(join(ROOT, 'src')).filter((f) => /export\s+(const|let|function)\s+WGSL_CHECK\b/.test(readFileSync(f, 'utf8')))
  .filter((f) => !FILE || relative(ROOT, f).includes(FILE));
let failures = 0;
const fail = (line) => { failures++; console.log(`FAIL ${line}`); };

const entries = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  let mod;
  try { mod = await import(pathToFileURL(f)); } catch (e) { fail(`${rel}: doesn't import in Node: ${e.message.split('\n')[0]}`); continue; }
  const list = typeof mod.WGSL_CHECK === 'function' ? mod.WGSL_CHECK() : mod.WGSL_CHECK;
  for (const entry of list ?? []) {
    if (ONLY && !ONLY.includes(entry.name)) continue;
    entries.push({ ...entry, kind: entry.kind ?? 'compute', file: rel, macOnly: mod.WGSL_MAC_ONLY?.[entry.name] ?? null });
  }
}
console.log(`check-wgsl: ${entries.length} pipeline(s) in ${files.length} module(s); grids ${GRID_KEYS.join(', ')}`);

// variants and the Node-side checks
const variants = [];
for (const entry of entries) {
  const keys = entry.grids === false ? [null] : (Array.isArray(entry.grids) ? entry.grids : Object.keys(GRIDS)).filter((k) => GRID_KEYS.includes(k));
  entry.variants = [];
  for (const k of keys) {
    const g = k ? grids[k] : null;
    let code, groups;
    try {
      code = entry.code(g);
      groups = normalizeGroups(entry.layouts?.(g));
    } catch (e) {
      fail(`${entry.name}@${k ?? '-'} (${entry.file}): generator threw: ${e.message.split('\n')[0]}`);
      continue;
    }
    const v = { entry, grid: k, key: `${entry.name}@${k ?? '-'}`, code, groups, lines: code.split('\n').length };
    v.problems = bindingProblems(code, groups);
    v.counts = stageCounts(groups, entry.kind);
    for (const [s, c] of Object.entries(v.counts)) {
      if (c.sb > LIMITS.storageBuffers) v.problems.push(`${s} stage: ${c.sb} storage buffers > ${LIMITS.storageBuffers}`);
      if (c.st > LIMITS.storageTextures) v.problems.push(`${s} stage: ${c.st} storage textures > ${LIMITS.storageTextures}`);
      if (c.tex > LIMITS.sampledTextures) v.problems.push(`${s} stage: ${c.tex} sampled textures > ${LIMITS.sampledTextures}`);
    }
    entry.variants.push(v);
    variants.push(v);
  }
  const d = dispatchProblems(entry, grids);
  entry.dispatchProblems = d.problems;
  entry.giant = d.giant;
}

const vite = await startVite({ harness: true });
const log = [];
// After a page has lost the GPU 3 times, Chromium blocks its origin from 3D
// APIs and requestAdapter() answers null (a 2000-line kernel lost 3 times in
// one browser; the 4th page had no adapter). (b) and --curve go on after a
// loss, so the block is turned off (--disable-gpu-process-crash-limit alone
// didn't help), and should a page still find no adapter, a new browser opens.
const browserArgs = ['--disable-domain-blocking-for-3d-apis', ...argv.flatMap((a, i) => (a === '--browser-arg' ? [argv[i + 1]] : []))];
const launch = () => launchBrowser({ args: browserArgs, browserLog: (line) => log.push({ t: Date.now(), line }) });
let browser = await launch();
let page = null;
const open = async () => {
  if (page) await page.close().catch(() => {});
  page = null;
  try {
    page = await openHarness(browser, vite, '/tools/harness/wgsl.html');
  } catch (e) {
    if (!/adapter/i.test(e.message)) throw e;
    console.log(`     (${e.message.split('\n')[0]}: a new browser)`);
    await browser.close().catch(() => {});
    browser = await launch();
    page = await openHarness(browser, vite, '/tools/harness/wgsl.html');
  }
  return page;
};
try {
  await open();
  const info = await gpuInfo(page);
  console.log(`gpu: ${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback adapter)' : ''}; budget ${BUDGET} ms`);

  // (a) validate every distinct text
  const unique = new Map();
  for (const v of variants) if (!unique.has(v.code)) unique.set(v.code, v.key);
  const results = new Map();
  const items = [...unique].map(([code, key]) => ({ key, code }));
  for (let i = 0; i < items.length; i += 16) {
    for (const r of await page.evaluate((batch) => window.__harness.run('validate', batch), items.slice(i, i + 16))) results.set(r.key, r);
  }
  console.log(`\n(a) validate: ${variants.length} variant(s), ${unique.size} distinct module text(s)`);
  for (const entry of entries) {
    const problems = [...entry.dispatchProblems];
    let tint = 0;
    for (const v of entry.variants) {
      const r = results.get(unique.get(v.code));
      tint += r.ms;
      for (const m of r.messages) if (m.type !== 'info') problems.push(`${v.key}: ${m.type} ${m.line}:${m.col} ${m.text}`);
      if (r.scope && !r.messages.some((m) => m.type === 'error')) problems.push(`${v.key}: ${r.scope.split('\n')[0]}`);
      for (const p of v.problems) problems.push(`${v.key}: ${p}`);
    }
    const lines = entry.variants.map((v) => v.lines);
    const counts = entry.variants[0]?.counts ?? {};
    const stages = Object.entries(counts).map(([s, c]) => `${s} sb ${c.sb}/8 st ${c.st}/4`).join(', ');
    const giant = entry.giant ? `, giant dispatch ${JSON.stringify(entry.giant.length === 1 ? entry.giant[0] : entry.giant)}` : '';
    const summary = `${entry.name} (${entry.file}): ${entry.variants.length} variant(s), ${Math.min(...lines)}–${Math.max(...lines)} lines, ${stages}${giant}, Tint ${tint.toFixed(0)} ms`;
    if (problems.length) fail(`${summary}\n     ${[...new Set(problems)].slice(0, 20).join('\n     ')}`);
    else console.log(`ok   ${summary}`);
  }

  // (b) build each distinct module at its smallest grid
  if (BUILD) {
    console.log(`\n(b) build at the smallest grid, budget ${BUDGET} ms${TIME ? '' : ' (--time prints each)'}`);
    const built = new Set();
    let n = 0, total = 0;
    for (const entry of entries) {
      const v = entry.variants[0];
      if (!v) continue;
      if (entry.macOnly) { console.log(`skip ${v.key}: WGSL_MAC_ONLY: ${entry.macOnly}`); continue; }
      const id = `${v.code}|${entry.entry ?? ''}|${JSON.stringify([entry.vertex, entry.fragment, entry.depthStencil, entry.constants])}`;
      if (built.has(id)) continue;
      built.add(id);
      const item = {
        name: v.key, kind: entry.kind, code: v.code, groups: v.groups, entry: entry.entry, constants: entry.constants,
        vertex: entry.vertex, fragment: entry.fragment, primitive: entry.primitive, depthStencil: entry.depthStencil, multisample: entry.multisample,
      };
      const r = await page.evaluate(([it, b]) => window.__harness.run('build', it, b), [item, BUDGET]);
      n++; total += r.ms;
      const line = `${v.key}: ${r.status}, pipeline ${r.ms.toFixed(0)} ms (module ${r.validateMs.toFixed(0)} ms)`;
      if (r.status !== 'ok') {
        fail(`${line}${r.message ? `\n     ${r.message.split('\n').slice(0, 8).join('\n     ')}` : ''}`);
        if (r.status === 'lost' || r.status === 'timeout') await open();
      } else if (TIME) console.log(`ok   ${line}`);
    }
    console.log(`     ${n} pipeline(s) built, ${total.toFixed(0)} ms in all`);
  }

  // the compile-time curve (W23, I1)
  if (CURVE) {
    console.log(`\ncurve: pipeline creation of synthetic kernels on this device (stops a family at its first loss or timeout)`);
    const families = {
      straight: [200, 600, 1000, 1400, 1800],
      branchy: [200, 400, 800, 1200, 1600],
      ssa: [200, 600, 1000, 1400, 2000, 2400],
      swaps: [200, 400, 600, 800, 1000, 1200, 1400, 1600, 2000, 2400],
    };
    const make = { straight: straightKernel, branchy: branchyKernel, ssa: ssaKernel, swaps: swapsKernel };
    const only = opt('--family')?.split(',');
    if (only) for (const k of Object.keys(families)) if (!only.includes(k)) delete families[k];
    const sizes = opt('--sizes')?.split(',').map(Number);
    if (sizes) for (const k of Object.keys(families)) families[k] = sizes;
    const salt = Date.now().toString(36);
    for (const [family, sizes] of Object.entries(families)) {
      for (const n of sizes) {
        const code = make[family](n, `${salt}-${family}-${n}`);
        const t0 = Date.now();
        const r = await page.evaluate(([it, b]) => window.__harness.run('build', it, b), [{
          name: `curve-${family}-${n}`, kind: 'compute', code, groups: [[{ binding: 0, buffer: { type: 'storage' } }]],
        }, BUDGET]).catch((e) => ({ status: 'lost', ms: Date.now() - t0, validateMs: 0, message: e.message }));
        console.log(`  ${family.padEnd(8)} ${String(code.split('\n').length).padStart(5)} lines  module ${r.validateMs.toFixed(0).padStart(4)} ms  pipeline ${r.ms.toFixed(0).padStart(6)} ms  ${r.status}${r.message ? `: ${r.message.split('\n')[0]}` : ''}`);
        if (r.status === 'ok') continue;
        if (r.status === 'lost') {
          await new Promise((res) => setTimeout(res, 500));
          const lines = log.filter((l) => l.t >= t0 - 100 && /ERROR|FATAL|lost|crash|Vulkan|VK_|Dawn|SwiftShader|watchdog|terminat|exit/i.test(l.line) && !/dbus|Floss|bluez/.test(l.line));
          console.log(`    GPU process log since the build started (${lines.length} line(s)):`);
          for (const l of lines.slice(-12)) console.log(`      ${l.line.slice(0, 300)}`);
        }
        await open();
        break;
      }
    }
  }
} finally {
  await browser.close();
  await vite.close();
}
console.log(failures ? `\ncheck-wgsl: ${failures} failure(s)` : '\ncheck-wgsl: clean');
process.exit(failures ? 1 : 0);

// CPU check: no pipeline the game builds binds more resources to one shader
// stage than every WebGPU device allows. A pipeline layout over a limit is a
// validation error at creation, and the view or the kernel that needed it
// never draws or runs (on WebGL2 it was a program over 16 texture units:
// "FRAGMENT shader texture image units count exceeds
// MAX_TEXTURE_IMAGE_UNITS(16)", 2026-10-11, the view with whitewater on).
// No GPU, no browser: the deploy runs it before the build
// (.github/workflows/deploy.yml).
//
// Every pipeline is what a module's WGSL_CHECK list says it builds (the
// convention: src/gpu/checks.js; the same lists tools/check-wgsl.mjs
// validates and builds), at every check grid it lists. For each, per shader
// stage, the layout entries whose visibility includes the stage
// (gpu/kernels.js withVisibility: an entry's default visibility as the
// device gets it) are counted against the spec's default limits, which are
// all the port asks for (docs/webgpu.md B2, C4): sampled textures 16,
// samplers 16, storage textures 4, storage buffers 8, uniform buffers 12
// (an external texture counts 4 sampled textures, a sampler and a uniform
// buffer, as the spec counts it), and per pipeline layout 8 dynamic uniform
// buffers, 4 dynamic storage buffers and 4 bind groups. Declarations in the
// WGSL are matched against the layout as check-wgsl's (a) matches them (a
// binding the layout lacks fails pipeline creation as surely). A failure
// names the pipeline, the grid, the stage and every binding it counted.
//
// Negative controls run first, synthetic pipelines one over each limit (17
// sampled textures, ...): each must fail here, or the check fails, and one at
// exactly every limit must pass.
//
//   node tools/check-sampler-budget.mjs [--only name,...] [--verbose]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withVisibility, STAGE } from '../src/gpu/kernels.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** WebGPU's default limits (the spec's; docs/webgpu.md B2 requests no more). */
export const LIMITS = Object.freeze({
  sampledTextures: 16,       // maxSampledTexturesPerShaderStage
  samplers: 16,              // maxSamplersPerShaderStage
  storageTextures: 4,        // maxStorageTexturesPerShaderStage
  storageBuffers: 8,         // maxStorageBuffersPerShaderStage
  uniformBuffers: 12,        // maxUniformBuffersPerShaderStage
  dynamicUniformBuffers: 8,  // maxDynamicUniformBuffersPerPipelineLayout
  dynamicStorageBuffers: 4,  // maxDynamicStorageBuffersPerPipelineLayout
  bindGroups: 4,             // maxBindGroups
});
const PER_STAGE = ['sampledTextures', 'samplers', 'storageTextures', 'storageBuffers', 'uniformBuffers'];
const WORDS = {
  sampledTextures: 'sampled textures', samplers: 'samplers', storageTextures: 'storage textures', storageBuffers: 'storage buffers',
  uniformBuffers: 'uniform buffers', dynamicUniformBuffers: 'dynamic uniform buffers', dynamicStorageBuffers: 'dynamic storage buffers', bindGroups: 'bind groups',
};

// The check grids (tools/check-wgsl.mjs GRIDS): the test sizes, the box
// default (also the world window, 128³), the wide box, Dam Valley, and the
// giant volcano's window (384 tall).
export const GRIDS = { 32: [32, 32, 32], 64: [64, 64, 64], 128: [128, 128, 128], wide: [160, 96, 160], valley: [256, 96, 128], giant: [128, 384, 128] };

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
// what a declaration needs from its layout entry, or null when `e` gives it (check-wgsl's rule)
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
    : e.sampler ? `${e.sampler.type ?? 'filtering'} sampler` : e.externalTexture ? 'external texture' : 'other');

const PARAMS_ENTRIES = [
  { binding: 0, buffer: { type: 'uniform', hasDynamicOffset: true } },
  { binding: 1, buffer: { type: 'uniform', hasDynamicOffset: true } },
];
/** A pipeline's groups as entry arrays (group 3: the params group unless given; check-wgsl's rule). */
export function normalizeGroups(layouts) {
  const g = [...(layouts ?? [])];
  while (g.length < 4) g.push(undefined);
  return g.map((x, i) => (x === 'PARAMS' || (i === 3 && x === undefined) ? PARAMS_ENTRIES : x === 'EMPTY' || !x ? [] : x));
}

/** Declarations the layout doesn't give (check-wgsl's (a) binding match). */
export function bindingProblems(code, groups) {
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

// what an entry costs in each per-stage class (the spec's binding slot rules)
function costs(e) {
  if (e.externalTexture) return { sampledTextures: 4, samplers: 1, uniformBuffers: 1 };
  if (e.texture) return { sampledTextures: 1 };
  if (e.sampler) return { samplers: 1 };
  if (e.storageTexture) return { storageTextures: 1 };
  if (e.buffer) return (e.buffer.type ?? 'uniform') === 'uniform' ? { uniformBuffers: 1 } : { storageBuffers: 1 };
  return {};
}

/**
 * Per-stage counts of a pipeline's layout, each with the bindings it counted
 * ('g2 b8 shadow'), and the per-layout ones: { stages: { V|F|C: { class:
 * { n, list } } }, layout: { class: { n, list } } }.
 * @param {GPUBindGroupLayoutEntry[][]} groups
 * @param {'compute' | 'render'} kind
 * @param {string} [code] the module, for the bindings' names
 */
export function bindingCounts(groups, kind, code = '') {
  const names = new Map(parseBindings(code).map((d) => [`${d.group}/${d.binding}`, d.name]));
  const label = (gi, e) => `g${gi} b${e.binding}${names.has(`${gi}/${e.binding}`) ? ` ${names.get(`${gi}/${e.binding}`)}` : ''}`;
  const stages = kind === 'render' ? { V: STAGE.VERTEX, F: STAGE.FRAGMENT } : { C: STAGE.COMPUTE };
  const add = (c, k, n, l) => { c[k] ??= { n: 0, list: [] }; c[k].n += n; c[k].list.push(n > 1 ? `${l} (×${n})` : l); };
  const out = { stages: {}, layout: {} };
  for (const [s, bit] of Object.entries(stages)) {
    const c = {};
    groups.forEach((entries, gi) => {
      for (const e of entries.map(withVisibility)) {
        if (!(e.visibility & bit)) continue;
        for (const [k, n] of Object.entries(costs(e))) add(c, k, n, label(gi, e));
      }
    });
    out.stages[s] = c;
  }
  groups.forEach((entries, gi) => {
    for (const e of entries) {
      if (!e.buffer?.hasDynamicOffset) continue;
      add(out.layout, (e.buffer.type ?? 'uniform') === 'uniform' ? 'dynamicUniformBuffers' : 'dynamicStorageBuffers', 1, label(gi, e));
    }
  });
  const used = groups.reduce((n, entries, gi) => (entries.length ? gi + 1 : n), 0);
  out.layout.bindGroups = { n: Math.max(used, groups.length > 4 ? groups.length : 0), list: [] };
  return out;
}

/** Every count over its limit: [{ stage, what, n, limit, list }]. */
export function overruns(counts) {
  const over = [];
  for (const [stage, c] of Object.entries(counts.stages)) {
    for (const k of PER_STAGE) if ((c[k]?.n ?? 0) > LIMITS[k]) over.push({ stage, what: k, n: c[k].n, limit: LIMITS[k], list: c[k].list });
  }
  for (const [k, v] of Object.entries(counts.layout)) if (v.n > LIMITS[k]) over.push({ stage: 'layout', what: k, n: v.n, limit: LIMITS[k], list: v.list });
  return over;
}

/** One pipeline variant's problems: overruns and binding mismatches, as lines. */
export function checkPipeline({ code, groups, kind }) {
  const counts = bindingCounts(groups, kind, code);
  const lines = overruns(counts).map((o) => `${o.stage === 'layout' ? 'pipeline layout' : `${{ V: 'vertex', F: 'fragment', C: 'compute' }[o.stage]} stage`}: `
    + `${o.n} ${WORDS[o.what]} > ${o.limit}${o.list.length ? `: ${o.list.join(', ')}` : ''}`);
  return { counts, problems: [...lines, ...bindingProblems(code, groups)] };
}

// ---------------------------------------------------------------- negative controls
// Synthetic pipelines, each `n` of one kind of binding in one stage's group 0
// (the params group 3 as every pipeline of ours has it): over a limit they
// must fail, at it they must pass.
const CONTROLS = {
  sampledTextures: { kind: 'render', decl: (i) => `var t${i}: texture_2d<f32>;`, entry: (i) => ({ binding: i, visibility: STAGE.FRAGMENT, texture: { sampleType: 'float' } }) },
  samplers: { kind: 'render', decl: (i) => `var s${i}: sampler;`, entry: (i) => ({ binding: i, visibility: STAGE.FRAGMENT, sampler: { type: 'filtering' } }) },
  storageTextures: { kind: 'compute', decl: (i) => `var o${i}: texture_storage_2d<rgba8unorm, write>;`, entry: (i) => ({ binding: i, visibility: STAGE.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } }) },
  storageBuffers: { kind: 'compute', decl: (i) => `var<storage, read> b${i}: array<u32>;`, entry: (i) => ({ binding: i, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }) },
  // (the params group's two uniforms count too: n more in group 0)
  uniformBuffers: { kind: 'compute', base: 2, decl: (i) => `var<uniform> u${i}: vec4f;`, entry: (i) => ({ binding: i, visibility: STAGE.COMPUTE, buffer: { type: 'uniform' } }) },
};
function control(what, n) {
  const c = CONTROLS[what];
  const k = n - (c.base ?? 0);
  const code = Array.from({ length: k }, (_, i) => `@group(0) @binding(${i}) ${c.decl(i)}`).join('\n');
  return { name: `control ${n} ${WORDS[what]}`, kind: c.kind, code, groups: normalizeGroups([Array.from({ length: k }, (_, i) => c.entry(i))]) };
}
// an external texture is 4 sampled textures: 4 of them and one texture are 17
const externalControl = () => ({
  name: 'control 4 external textures + 1 texture', kind: 'render',
  code: `${[0, 1, 2, 3].map((i) => `@group(0) @binding(${i}) var x${i}: texture_external;`).join('\n')}\n@group(0) @binding(4) var t: texture_2d<f32>;`,
  groups: normalizeGroups([[...[0, 1, 2, 3].map((i) => ({ binding: i, visibility: STAGE.FRAGMENT, externalTexture: {} })),
    { binding: 4, visibility: STAGE.FRAGMENT, texture: { sampleType: 'float' } }]]),
});

/** Runs the controls: { ok, lines }. */
export function runControls() {
  const lines = [];
  let ok = true;
  const expect = (p, fail) => {
    const { problems } = checkPipeline(p);
    const caught = problems.length > 0;
    if (caught !== fail) ok = false;
    lines.push(`${caught === fail ? 'ok  ' : 'FAIL'} ${p.name}: ${caught ? `fails (${problems[0].split(':')[0]}: ${problems[0].split(':')[1].trim()})` : 'passes'}${caught === fail ? '' : ` — expected it to ${fail ? 'fail' : 'pass'}`}`);
  };
  for (const what of PER_STAGE) {
    expect(control(what, LIMITS[what] + 1), true);
    expect(control(what, LIMITS[what]), false);
  }
  expect(externalControl(), true);
  return { ok, lines };
}

// ---------------------------------------------------------------- the game's pipelines
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.js$/.test(n) ? [p] : [];
  });
}

async function makeGrids() {
  const { gridLayout } = await import(pathToFileURL(join(ROOT, 'src/sim.js')));
  return Object.fromEntries(Object.entries(GRIDS).map(([k, [nx, ny, nz]]) => [k, { ...gridLayout(nx, ny, nz), name: k }]));
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
  const verbose = argv.includes('--verbose');
  const t0 = performance.now();

  const controls = runControls();
  for (const l of controls.lines) if (verbose || l.startsWith('FAIL')) console.log(l);
  console.log(`negative controls: ${controls.ok ? 'each limit + 1 fails, each limit passes' : 'NOT CAUGHT (the check is broken)'}`);

  const grids = await makeGrids();
  const files = walk(join(ROOT, 'src')).filter((f) => /export\s+(const|let|function)\s+WGSL_CHECK\b/.test(readFileSync(f, 'utf8')));
  let failures = controls.ok ? 0 : 1, variants = 0, pipelines = 0;
  const worst = {};   // class → { n, where, list }
  for (const f of files) {
    const rel = relative(ROOT, f);
    let mod;
    try { mod = await import(pathToFileURL(f)); } catch (e) {
      failures++;
      console.log(`FAIL ${rel}: doesn't import in Node: ${e.message.split('\n')[0]}`);
      continue;
    }
    const list = typeof mod.WGSL_CHECK === 'function' ? mod.WGSL_CHECK() : mod.WGSL_CHECK;
    for (const entry of list ?? []) {
      if (only && !only.includes(entry.name)) continue;
      pipelines++;
      const keys = entry.grids === false ? [null] : Array.isArray(entry.grids) ? entry.grids : Object.keys(GRIDS);
      for (const k of keys) {
        const g = k ? grids[k] : null, where = `${entry.name}@${k ?? '-'} (${rel})`;
        let code, groups;
        try {
          code = entry.code(g);
          groups = normalizeGroups(entry.layouts?.(g));
        } catch (e) {
          failures++;
          console.log(`FAIL ${where}: generator threw: ${e.message.split('\n')[0]}`);
          continue;
        }
        variants++;
        const { counts, problems } = checkPipeline({ code, groups, kind: entry.kind ?? 'compute' });
        for (const [s, c] of Object.entries(counts.stages)) {
          for (const [what, v] of Object.entries(c)) if (v.n > (worst[what]?.n ?? -1)) worst[what] = { n: v.n, where: `${where} ${s}`, list: v.list };
        }
        if (problems.length) {
          failures++;
          console.log(`FAIL ${where}\n     ${problems.join('\n     ')}`);
        }
      }
    }
  }
  const ms = performance.now() - t0;
  console.log(`${pipelines} pipeline(s), ${variants} variant(s) over the check grids, in ${files.length} module(s); ${(ms / 1000).toFixed(1)} s`);
  for (const what of PER_STAGE) {
    const w = worst[what];
    if (w) console.log(`most ${WORDS[what]}: ${w.n}/${LIMITS[what]} ${w.where}${verbose ? `: ${w.list.join(', ')}` : ''}`);
  }
  console.log(failures ? `${failures} pipeline variant(s) or check(s) over the binding budget or failing` : 'every pipeline within the binding budget');
  process.exit(failures ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

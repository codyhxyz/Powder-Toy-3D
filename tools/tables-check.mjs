// The element tables, the prelude and the shared bindings on a real WebGPU
// device (docs/webgpu.md C5, C6, F6, I1): every module U1 emits compiles with
// no error or warning, every layout it describes builds a pipeline and binds,
// every table field read back through its accessor equals the JS value, and
// pcg, seedWorld, u32ToF32, i32ToF32 and rnd equal a JS reference
// (Math.fround) bit for bit on 65,536 inputs. Also the typed consts, the slot
// layout against its JS mirror, FrameUniforms' and the header's packing, the
// brick record's decoders, and editMain's writers (in place and two-phase,
// with their marks) and the debug prelude's out-of-grid counter.
//
// It starts its own Vite (the Vite JS API, 127.0.0.1, a free port from
// --port, default 5311, strictPort) to serve tools/harness/tables.html, and
// launches Chromium through tools/browser.mjs with WebGPU on. Everything is
// generated here in Node and sent to the page (the WGSL lab).
//   node tools/tables-check.mjs [--port N] [--time]
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { launchBrowser, newTestPage } from './browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PORT = 5311;
const PORT_TRIES = 20;
// WebGPU in headless Chromium needs this flag (docs/webgpu.md I1). Passed with
// the launcher's own GPU flags, which an args list replaces in tools/browser.mjs.
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'];

export const b64 = (bytes) => {
  const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Buffer.from(u8).toString('base64');
};
export const fromB64 = (s) => {
  const b = Buffer.from(s, 'base64');
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice().buffer;
};

// Vite on the first free port from `port` (strictPort: never someone else's server).
async function startVite(port) {
  const { createServer } = await import('vite');
  for (let p = port; p < port + PORT_TRIES; p++) {
    const server = await createServer({
      root: ROOT, configFile: false, logLevel: 'error', clearScreen: false,
      server: { host: '127.0.0.1', port: p, strictPort: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    try {
      await server.listen();
      return { server, port: p };
    } catch (e) {
      await server.close();
      if (!/in use|EADDRINUSE/i.test(String(e.message))) throw e;
    }
  }
  throw new Error(`no free port in ${port}-${port + PORT_TRIES - 1}`);
}

// Run fn(lab) with the WGSL lab open; closes the browser and the server however it ends.
export async function withLab(fn, { port = BASE_PORT } = {}) {
  const { server, port: used } = await startVite(port);
  let browser;
  try {
    browser = await launchBrowser({ args: GPU_ARGS });
    const page = await newTestPage(browser, { mode: 'manual' });
    page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
    await page.goto(`http://127.0.0.1:${used}/tools/harness/tables.html`);
    await page.waitForFunction(() => window.lab?.ready || window.lab?.error, null, { timeout: 60000 });
    const error = await page.evaluate(() => window.lab.error);
    if (error) throw new Error(`WGSL lab: ${error}`);
    const lab = {
      port: used,
      info: () => page.evaluate(() => window.lab.info()),
      compile: (code, label) => page.evaluate(([c, l]) => window.lab.compile(c, l), [code, label]),
      run: (job) => page.evaluate((j) => window.lab.run(j), job),
    };
    return await fn(lab);
  } finally {
    await browser?.close();
    await server.close();
  }
}

// ---------------------------------------------------------------- reporting
export function reporter() {
  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    if (!ok) failures++;
    return ok;
  };
  return { check, failures: () => failures };
}
const SHOWN = 6;   // mismatches listed per check
// a job's own check: reported through check (whatever it returns), true when it ran
const ran = (check, name, r) => { check(name, r.ok, r.error ?? msgText(r.messages)); return r.ok; };
const msgText = (msgs) => msgs.map((m) => `${m.type} ${m.line}:${m.col} ${m.message}`).slice(0, SHOWN).join(' | ');
const clean = (msgs) => !msgs.some((m) => m.type === 'error' || m.type === 'warning');

// ---------------------------------------------------------------- words
// Expected values as the u32 words a probe kernel writes: f32 as Math.fround's
// bits, i32 two's complement, bool 1 or 0, vectors component by component.
const f32bits = (x) => new Uint32Array(new Float32Array([x]).buffer)[0];
const COMPS = { f32: 1, i32: 1, u32: 1, bool: 1, vec2f: 2, vec3f: 3, vec4f: 4, vec2i: 2, vec3i: 3, vec4i: 4, vec2u: 2, vec3u: 3, vec4u: 4 };
const scalarOf = (type) => (type === 'bool' ? 'bool' : type.length === 3 ? type : { f: 'f32', i: 'i32', u: 'u32' }[type.at(-1)]);
function words(type, v) {
  const n = COMPS[type], sc = scalarOf(type), arr = n === 1 ? [v] : Array.from(v);
  if (arr.length !== n) throw new Error(`${type}: ${v}`);
  return arr.map((x) => (sc === 'f32' ? f32bits(x) : sc === 'bool' ? +!!x : sc === 'i32' ? (x | 0) >>> 0 : x >>> 0));
}
// WGSL that writes expression e of type `type` as words at outBuf[o + k]
function store(type, e, o) {
  const n = COMPS[type], sc = scalarOf(type);
  const one = (x) => (sc === 'f32' || sc === 'i32' ? `bitcast<u32>(${x})` : sc === 'bool' ? `select(0u, 1u, ${x})` : x);
  if (n === 1) return [`outBuf[${o}] = ${one(e)};`];
  return ['x', 'y', 'z', 'w'].slice(0, n).map((c, k) => `outBuf[${o} + ${k}u] = ${one(`(${e}).${c}`)};`);
}
const u32s = (buf) => new Uint32Array(buf);
function compareWords(got, want, label) {
  const bad = [];
  for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) bad.push(`${label(i)}: got 0x${got[i].toString(16)}, want 0x${want[i].toString(16)}`);
  return bad;
}

// ---------------------------------------------------------------- jobs
// Layout entries plus what the lab makes for them (data, size, read).
const withData = (entries, extras) => entries.map((e) => ({ ...e, ...(extras[e.binding] ?? {}) }));
const outEntry = (binding, size) => ({ binding, visibility: 4, buffer: { type: 'storage' }, size, read: true });
const inEntry = (binding, data) => ({ binding, visibility: 4, buffer: { type: 'read-only-storage' }, data: b64(data) });

export async function mods() {
  const [common, bindings, host, elements, electricity, materials, incand, sky, physics] = await Promise.all([
    import('../src/shaders/common.js'), import('../src/shaders/bindings.js'), import('../src/shaders/hostStruct.js'),
    import('../src/elements.js'), import('../src/electricity.js'), import('../src/gfx/materials.js'),
    import('../src/gfx/incandescence.js'), import('../src/gfx/sky.js'), import('../src/physics.js')]);
  return { ...common, ...bindings, ...host, el: elements, elec: electricity, mat: materials, incand, sky, physics };
}
function paramsGroup(M, { header = {}, params = null } = {}) {
  const h = new ArrayBuffer(M.Header.size);
  M.Header.write(new DataView(h), 0, { origin: [0, 0, 0], src: 0, dst: 0, ...header });
  return withData(M.LAYOUT.PARAMS, { 0: { data: b64(h) }, 1: params ? { data: b64(params) } : { size: 256 } });
}
const tablesGroup = (M) => withData(M.LAYOUT.TABLES, { 0: { data: b64(M.tablesBuffer()) } });

// ---------------------------------------------------------------- A. every module compiles
const GRIDS = [[32, 32, 32], [64, 64, 64], [128, 128, 128], [160, 96, 160], [64, 128, 64], [128, 384, 128]];
const SAMPLE_UPDATE = `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  if (p.y < 3) { *oA = vec4f(f32(E_SAND), a.y, 0.0, a.w); }
}`;
export function moduleList(M) {
  const g64 = { nx: 64, ny: 64, nz: 64 };
  const editParams = M.hostStruct('EditParams', { ...M.EDIT_FIELDS, center: 'vec3f', radius: 'f32' }, { space: 'uniform' });
  const editKernel = (reads, debug) => `${M.prelude(g64, { ...M.STATE_OPTS.STATE_RW, debug })}
${editParams.wgsl}
@group(3) @binding(1) var<uniform> P: EditParams;
${SAMPLE_UPDATE}
${M.editMain('update', { reads })}`;
  const list = [];
  for (const [name, o] of Object.entries({ ...M.STATE_OPTS, NONE: { state: false } })) {
    list.push([`prelude 64³ ${name}`, M.prelude(g64, o)]);
    list.push([`prelude 64³ ${name} debug`, M.prelude(g64, { ...o, debug: true })]);
  }
  for (const [nx, ny, nz] of GRIDS) list.push([`prelude ${nx}×${ny}×${nz} STATE_RW`, M.prelude({ nx, ny, nz }, M.STATE_OPTS.STATE_RW)]);
  list.push(['prelude 64³ supertile sleep unit', M.prelude({ ...g64, sleepUnit: M.SUPER }, M.STATE_OPTS.STATE_RW)]);
  const render = M.prelude(g64, M.STATE_OPTS.STATE_RO);
  list.push(['render library: materials, sky, FrameUniforms', `${render}\n${M.mat.materialsGLSL()}\n${M.sky.skyGLSL()}\n${M.frameBindings()}`]);
  for (const variant of ['LIGHTING', 'LIGHTING_SHADOW', 'LIGHTING_GI', 'LIGHTING_GISRC']) {
    list.push([`lighting ${variant}`, `${render}\n${M.frameBindings()}\n${M.lightingBindings({ variant })}`]);
  }
  list.push(['lighting, no far field or aeration', `${render}\n${M.frameBindings()}\n${M.lightingBindings({ far: false, aeration: false })}`]);
  list.push(['brick record alone', `${M.prelude(g64, { state: false })}\n${M.brickInfoWGSL}`]);
  list.push(['react electricity', `${M.prelude(g64, M.STATE_OPTS.STATE_RW)}\n${M.elec.electricReactGLSL}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let p = vec3i(gid);
  var a = fetchA(p);
  var na: array<vec4f, 6>;
  var nid: array<i32, 6>;
  var rs = seed3(p, 1u, 0x7au);
  var T = a.y;
  var life = a.z;
  var ctype = floor(a.w);
  electric(eid(a), &T, &life, &ctype, &na, &nid, 6, &rs);
  a = vec4f(a.x, T, life, ctype + fract(a.w));
  var c = vec4f(a);
  _ = sparkCell(&c);
  writeState(p, a, fetchB(p), fetchF(p));
}`]);
  list.push(['editMain own', editKernel('own', false)]);
  list.push(['editMain own debug', editKernel('own', true)]);
  list.push(['editMain neighbours', editKernel('neighbours', false)]);
  return list;
}

export async function compileAll(lab, M, { check }) {
  let n = 0, worst = 0, lines = 0;
  for (const [name, code] of moduleList(M)) {
    const msgs = await lab.compile(code, name);
    n++;
    lines = Math.max(lines, code.split('\n').length);
    if (!clean(msgs)) check(`compiles: ${name}`, false, msgText(msgs));
    worst += msgs.length;
  }
  check(`every emitted module compiles with no error or warning (${n} modules, the largest ${lines} lines)`, true);
}

// ---------------------------------------------------------------- B. layouts build and bind
const RUN_GRID = { nx: 32, ny: 16, nz: 16 };
function stateGroup(M, opts, g, extras = {}) {
  const { slots } = M.gridDims(g), marks = M.marksLayout(g).words * 4;
  const sizes = { 0: 2 * slots * 16, 1: 2 * slots * 16, 2: 2 * slots * 4, 3: marks, 4: 64 };
  return M.stateLayout(opts).map((e) => ({ ...e, size: sizes[e.binding], ...(extras[e.binding] ?? {}) }));
}
async function layoutChecks(lab, M, { check }, times) {
  const g = RUN_GRID;
  for (const [name, opts] of Object.entries(M.STATE_OPTS)) {
    for (const debug of [false, true]) {
      const o = { ...opts, debug }, rw = o.state === 'read_write';
      const touch = [
        '_ = KIND(1); _ = H.src;',
        o.state && '_ = fetchA(vec3i(0)); _ = fetchB(vec3i(0)); _ = fetchAs(0u);',
        o.flags && '_ = fetchF(vec3i(0));',
        rw && 'writeState(vec3i(0), fetchA(vec3i(0)), fetchB(vec3i(0)), fetchF(vec3i(0)));',
        o.marks && 'atomicAdd(&marks[MARK_DBG], 0u);',
        o.act === 'read' && '_ = act[0];',
        o.act === 'read_write' && 'atomicAdd(&act[0], 0u);',
      ].filter(Boolean).join('\n  ');
      const code = `${M.prelude(g, o)}\n@compute @workgroup_size(1) fn main() {\n  ${touch}\n}`;
      const r = await lab.run({ label: `${name}${debug ? ' debug' : ''}`, code, dispatch: [1, 1, 1],
        groups: [tablesGroup(M), stateGroup(M, o, g), [], paramsGroup(M)] });
      times.push([`layout ${name}${debug ? ' debug' : ''}`, r.pipelineMs]);
      check(`LAYOUT.${name}${debug ? ' (debug prelude)' : ''} matches prelude(g, STATE_OPTS.${name}): builds, binds, runs`, r.ok, r.error ?? msgText(r.messages));
    }
  }
  // the render groups: L.FRAME + L.STATE_RO + each LIGHTING variant + L.PARAMS
  for (const variant of ['LIGHTING', 'LIGHTING_SHADOW', 'LIGHTING_GI', 'LIGHTING_GISRC']) {
    const uses = M.lightingVariant(variant).map(({ binding, name, type }) => {
      if (type.startsWith('texture_storage_2d')) return `textureStore(${name}, vec2i(0), vec4f(1.0));`;
      if (type.startsWith('texture_storage_3d')) return `textureStore(${name}, vec3i(0), vec4f(1.0));`;
      if (type === 'sampler') return `_ = textureSampleLevel(tFS, ${name}, vec3f(0.5), 0.0);`;
      if (type.startsWith('texture_3d')) return `_ = textureLoad(${name}, vec3i(0), 0);`;
      if (type.startsWith('texture_2d_array')) return `_ = textureLoad(${name}, vec2i(0), 0, 0);`;
      if (type.startsWith('texture_2d')) return `_ = textureLoad(${name}, vec2i(0), 0);`;
      const rw = M.RENDER_LAYOUT[variant].find((e) => e.binding === binding).buffer.type === 'storage';
      return rw ? `${name}[0] = ${name}[0];` : `_ = ${name}[0];`;
    }).join('\n  ');
    const body = `_ = KIND(1); _ = FU.sun; _ = FU.far; _ = fetchA(vec3i(0)); _ = brickAt(vec3i(0)); _ = brickDistAt(vec3i(0));\n  ${uses}`;
    const base = `${M.prelude(g, M.STATE_OPTS.STATE_RO)}\n${M.frameBindings()}\n${M.lightingBindings({ variant })}`;
    const groups = (stage) => [
      withData(M.RENDER_LAYOUT.FRAME, { 0: { data: b64(M.tablesBuffer()) }, 1: { size: M.FrameUniforms.size } }),
      stateGroup(M, M.STATE_OPTS.STATE_RO, g),
      M.RENDER_LAYOUT[variant].map((e) => ({ ...e, size: 1024 })),
      paramsGroup(M),
    ];
    const r = await lab.run({ label: variant, code: `${base}\n@compute @workgroup_size(1) fn main() {\n  ${body}\n}`, dispatch: [1, 1, 1], groups: groups() });
    times.push([`layout ${variant}`, r.pipelineMs]);
    check(`RENDER_LAYOUT.${variant} matches lightingBindings({ variant: '${variant}' }) in a compute pipeline`, r.ok, r.error ?? msgText(r.messages));
    if (variant === 'LIGHTING') {
      const code = `${base}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let c = vec2f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0);
  return FU.viewProj * FU.model * vec4f(c, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f {
  ${body}
  return vec4f(0.0);
}`;
      const rr = await lab.run({ label: 'LIGHTING render', code, render: { vertex: 'vs', fragment: 'fs' }, groups: groups() });
      times.push(['layout LIGHTING render', rr.pipelineMs]);
      check('RENDER_LAYOUT.LIGHTING and FRAME in a render pipeline (vertex + fragment), one draw', rr.ok, rr.error ?? msgText(rr.messages));
    }
  }
}

// ---------------------------------------------------------------- C. the tables, read back
// Independent of the field lists: each accessor's value restated from the
// element rows, the mechanisms, the looks and the electricity tables.
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hexToLinear = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255)); };
const inf = (x) => (x === Infinity ? 1e30 : x === -Infinity ? -1e30 : x);
export function expectedTables(M) {
  const { ELEMENTS, mechanisms, meltPoint, meltInto, breakInto } = M.el, m = mechanisms();
  const { CONDUCTS, WIRE, SPARK_COST } = M.elec, { LOOK, FOAMS } = M.mat;
  const elem = [
    ['KIND', 'i32', (e) => e.kind], ['RCLASS', 'i32', (e) => e.render], ['DENS', 'f32', (e) => e.dens], ['COND', 'f32', (e) => e.cond],
    ['CAP', 'f32', (e) => e.cap], ['GRAV', 'f32', (e) => e.grav], ['DRAG', 'f32', (e) => e.drag], ['FRICTION', 'f32', (e) => e.friction],
    ['JITTER', 'f32', (e) => e.jitter], ['FLOW', 'f32', (e) => e.flow], ['SLIDE', 'f32', (e) => e.slide], ['MELT', 'f32', (e) => meltPoint(e)],
    ['IGNITE', 'f32', (e) => e.ignite], ['FLASH', 'f32', (e) => e.flash], ['BURNRATE', 'f32', (e) => e.burnRate], ['BURNHEAT', 'f32', (e) => e.burnHeat],
    ['FLAMET', 'f32', (e) => e.flameT], ['SPAWNT', 'f32', (e) => e.temp], ['SPAWNLIFE', 'f32', (e) => e.life], ['SPAWNDENS', 'f32', (e) => e.spawn],
    ['RAD', 'f32', (e) => e.rad], ['COLORVAR', 'f32', (e) => e.var], ['MELTINTO', 'i32', (e) => meltInto(e)], ['HARD', 'f32', (e) => e.hard],
    ['BREAKINTO', 'i32', (e) => breakInto(e)], ['ACIDPROOF', 'bool', (e) => e.acidProof], ['ACIDIC', 'bool', (e) => e.acid], ['FIZZ', 'f32', (e) => e.fizz],
    ['LEAVES_ASH', 'bool', (e) => e.ash], ['COLOR', 'vec3f', (e) => hexToLinear(e.color).map((v) => +v.toFixed(4))], ['SIGMA', 'vec3f', (e) => e.sigma],
    ['INTO', 'vec4i', (e) => m.into[e.id]], ['OF', 'vec4i', (e) => m.of[e.id]], ['COLD', 'vec3f', (e) => m.cold[e.id].map(inf)],
    ['HOT', 'vec3f', (e) => m.hot[e.id].map(inf)], ['CRUSH_P', 'f32', (e) => inf(m.crushP[e.id])], ['BLAST', 'vec4f', (e) => m.blast[e.id].map(inf)],
    ['LIFE_BANK', 'bool', (e) => m.lifeBank[e.id]], ['BLAST_LIT', 'vec2f', (e) => m.blastLit[e.id].map(inf)],
    ['CONDUCTS', 'bool', (e) => CONDUCTS[e.id]], ['WIRE', 'bool', (e) => WIRE[e.id]], ['SPARK_COST', 'f32', (e) => +SPARK_COST[e.id].toPrecision(6)],
    ['FOAMS', 'bool', (e) => FOAMS.includes(e.key)],
    ['SURFCH', 'i32', (e) => LOOK[e.id].ch], ['MEDIACH', 'i32', (e) => LOOK[e.id].media], ['HAZE', 'f32', (e) => LOOK[e.id].haze],
    ['ROUGH', 'f32', (e) => LOOK[e.id].rough], ['METAL', 'f32', (e) => LOOK[e.id].metal], ['IOR', 'f32', (e) => LOOK[e.id].ior],
    ['SSS', 'f32', (e) => LOOK[e.id].sss], ['GLINT', 'f32', (e) => LOOK[e.id].glint], ['BEVEL', 'f32', (e) => LOOK[e.id].bevel],
    ['ALBEDO', 'vec3f', (e) => LOOK[e.id].alb], ['SCATALB', 'vec3f', (e) => LOOK[e.id].scatAlb], ['EMIT', 'vec3f', (e) => LOOK[e.id].emit],
    ['SURF', 'i32', (e) => LOOK[e.id].surf], ['SURFP', 'vec4f', (e) => LOOK[e.id].surfP], ['MACRO', 'vec4f', (e) => LOOK[e.id].macro], ['SHED', 'f32', (e) => LOOK[e.id].shed],
  ];
  const pad = (arr, empty) => (arr.length ? arr : [empty]);
  const rx = pad(m.rx, [0, 0, 0, 0, 0, 0, 0]);
  const tabs = [
    ['OUT', 'vec2f', pad(m.outs, [-1, 1]).map(([i, c]) => [i, inf(c)])],
    ['SPEC', 'vec2i', pad(m.specs, [0, 1])],
    ['RX', 'vec4f', rx.map((r) => r.slice(0, 4).map(inf))],
    ['RX_INTO', 'vec2i', rx.map((r) => [r[5], r[6]])],
    ['RX_PUFF', 'f32', rx.map((r) => inf(r[4]))],
    ['INCAND_TAB', 'vec4f', M.incand.INCAND_TABLE.map((k) => k.map((v) => +v.toPrecision(6)))],
  ];
  return { ELEMENTS, elem, tabs, lookup: m.lookup };
}
export async function tableCheck(lab, M, { check }, times) {
  const { ELEMENTS, elem, tabs, lookup } = expectedTables(M), ne = ELEMENTS.length;
  const W = elem.reduce((s, [, t]) => s + COMPS[t], 0) + ne;   // per element: every accessor, then its row of rxAt
  let at = 0;
  const body = [];
  for (const [fn, type] of elem) { body.push(...store(type, `${fn}(id)`, `o + ${at}u`)); at += COMPS[type]; }
  const tabBase = ne * W;
  const tabCode = [];
  let tabAt = tabBase;
  const tabOffsets = [];
  for (const [fn, type, rows] of tabs) {
    tabOffsets.push(tabAt);
    tabCode.push(`if (id < ${rows.length}) {\n    let o = ${tabAt}u + u32(id) * ${COMPS[type]}u;\n    ${store(type, `${fn}(id)`, 'o').join('\n    ')}\n  }`);
    tabAt += rows.length * COMPS[type];
  }
  // after the tables, the ambient air temperature (common.js airT(): PHYS.AMBIENT until a simulation sets it)
  const airAt = tabAt++;
  tabCode.push(`if (id == 0) { outBuf[${airAt}u] = bitcast<u32>(airT()); }`);
  const threads = Math.max(ne, ...tabs.map(([, , rows]) => rows.length));
  const code = `${M.prelude(RUN_GRID, { state: false })}
@group(2) @binding(0) var<storage, read_write> outBuf: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let id = i32(gid.x);
  if (id < NE) {
    let o = u32(id) * ${W}u;
    ${body.join('\n    ')}
    for (var b = 0; b < NE; b++) { outBuf[o + ${at}u + u32(b)] = bitcast<u32>(rxAt(id, b)); }
  }
  ${tabCode.join('\n  ')}
}`;
  const r = await lab.run({ label: 'tables', code, dispatch: [Math.ceil(threads / 64), 1, 1],
    groups: [tablesGroup(M), [], [outEntry(0, tabAt * 4)], paramsGroup(M)] });
  times.push(['tables probe', r.pipelineMs]);
  if (!ran(check, 'table probe kernel runs', r)) return;
  const got = u32s(fromB64(r.outputs['2.0']));
  const want = new Uint32Array(tabAt), label = [];
  ELEMENTS.forEach((e) => {
    let o = e.id * W;
    for (const [fn, type, get] of elem) for (const w of words(type, get(e))) { label[o] = `${fn}(${e.key})`; want[o++] = w; }
    for (let b = 0; b < ne; b++) { label[o] = `rxAt(${e.key}, ${ELEMENTS[b].key})`; want[o++] = lookup[e.id * ne + b]; }
  });
  tabs.forEach(([fn, type, rows], k) => rows.forEach((row, i) => words(type, row).forEach((w, c) => {
    const o = tabOffsets[k] + i * COMPS[type] + c;
    label[o] = `${fn}(${i})`; want[o] = w;
  })));
  label[airAt] = 'airT()'; want[airAt] = f32bits(M.physics.PHYS.AMBIENT);
  const bad = compareWords(got, want, (i) => label[i]);
  const fields = elem.length + 1 + tabs.length + 1;
  check(`every table field read back through its accessor equals JS (${fields} accessors, ${ne} elements, ${want.length} words)`,
    bad.length === 0, `${bad.length} differ: ${bad.slice(0, SHOWN).join('; ')}`);
}

// ---------------------------------------------------------------- D. hashes and conversions
const N_RNG = 65536;
const pcgJS = (v) => {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const seedWorldJS = (x, y, z, frame, salt) =>
  pcgJS((x >>> 0) + pcgJS((y >>> 0) + pcgJS((z >>> 0) + pcgJS((Math.imul(frame, 1664525) + salt) >>> 0)) >>> 0) >>> 0);
// Inputs: the edges of the conversions (2^24, 2^31, the last values rnd keeps
// below 1), then a Numerical Recipes LCG.
function rngInputs() {
  const edges = [0, 1, 255, 256, 257, 0xffffff, 0x1000000, 0x1000001, 0x1000003, 0x7fffff7f, 0x7fffff80, 0x7fffffc0, 0x7fffffff,
    0x80000000, 0x80000001, 0x80000080, 0x80000081, 0x80000180, 0xfffffe7f, 0xffffff00, 0xffffff7f, 0xffffff80, 0xffffff81, 0xffffffff];
  const salts = [0x51, 0x7a, 0x52, 0x5a, 0xb7];
  const ins = new Uint32Array(N_RNG * 6);
  let x = 12345;
  for (let i = 0; i < N_RNG; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const v = i < edges.length ? edges[i] : x;
    ins.set([v, ((v & 0x3ff) - 512) >>> 0, (((v >>> 10) & 0x3ff) - 300) >>> 0, (((v >>> 20) & 0x3ff) - 700) >>> 0, v >>> 9, salts[i % salts.length]], i * 6);
  }
  return ins;
}
async function rngCheck(lab, M, { check }, times) {
  const origin = [-137, 42, 1009];
  const ins = rngInputs();
  const code = `${M.prelude(RUN_GRID, { state: false })}
@group(2) @binding(0) var<storage, read> inBuf: array<u32>;
@group(2) @binding(1) var<storage, read_write> outBuf: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let x = inBuf[i * 6u];
  let w = vec3i(bitcast<i32>(inBuf[i * 6u + 1u]), bitcast<i32>(inBuf[i * 6u + 2u]), bitcast<i32>(inBuf[i * 6u + 3u]));
  let frame = inBuf[i * 6u + 4u];
  let salt = inBuf[i * 6u + 5u];
  let o = i * 8u;
  outBuf[o] = pcg(x);
  outBuf[o + 1u] = bitcast<u32>(u32ToF32(x));
  outBuf[o + 2u] = bitcast<u32>(i32ToF32(bitcast<i32>(x)));
  var rs = x;
  outBuf[o + 3u] = bitcast<u32>(rnd(&rs));
  outBuf[o + 4u] = rs;
  outBuf[o + 5u] = seedWorld(w, frame, salt);
  outBuf[o + 6u] = seed3(w, frame, salt);
  outBuf[o + 7u] = bitcast<u32>(f32(x));
}`;
  const r = await lab.run({ label: 'rng', code, dispatch: [N_RNG / 64, 1, 1],
    groups: [tablesGroup(M), [], [inEntry(0, ins), outEntry(1, N_RNG * 32)], paramsGroup(M, { header: { origin } })] });
  times.push(['hash probe', r.pipelineMs]);
  if (!ran(check, 'hash probe kernel runs', r)) return;
  const got = u32s(fromB64(r.outputs['2.1']));
  const names = ['pcg', 'u32ToF32', 'i32ToF32', 'rnd', 'rnd stream', 'seedWorld', 'seed3'];
  const bad = names.map(() => []);
  let plain = 0, ones = 0;
  for (let i = 0; i < N_RNG; i++) {
    const [x, wx, wy, wz, frame, salt] = ins.subarray(i * 6, i * 6 + 6);
    const p = pcgJS(x);
    const want = [p, f32bits(x), f32bits(x | 0), f32bits(Math.fround(Math.fround(p) * 2 ** -32)), p,
      seedWorldJS(wx, wy, wz, frame, salt), seedWorldJS((wx | 0) + origin[0], (wy | 0) + origin[1], (wz | 0) + origin[2], frame, salt)];
    want.forEach((w, k) => { if (got[i * 8 + k] !== w) bad[k].push(`x 0x${x.toString(16)}: got 0x${got[i * 8 + k].toString(16)}, want 0x${w.toString(16)}`); });
    if (got[i * 8 + 7] !== f32bits(x)) plain++;
    if (got[i * 8 + 3] === f32bits(1)) ones++;
  }
  names.forEach((n, k) => check(`${n} equals the JS reference bit for bit on ${N_RNG} inputs`, bad[k].length === 0,
    `${bad[k].length} differ: ${bad[k].slice(0, SHOWN).join('; ')}`));
  check('u32ToF32 rounds 0xffffff80 up to 2^32 (rnd can give exactly 1.0, D8.3)', got[21 * 8 + 1] === f32bits(2 ** 32) && got[20 * 8 + 1] === f32bits(0xffffff00));
  console.log(`info plain f32(u) differs from Math.fround on this device in ${plain} of ${N_RNG} inputs (docs/webgpu.md H1.28); rnd gave exactly 1.0 ${ones} times`);
}

// ---------------------------------------------------------------- E. typed consts
// Every `const NAME: type = literal;` the modules emit, read back: a typed
// literal is Math.fround of JS's number (C6), a vector's components too.
function parseConsts(text) {
  const consts = new Map();
  for (const [, name, type, expr] of text.matchAll(/^const (\w+): (f32|i32|u32|bool|vec[234][fiu]) = ([^;]+);/gm)) consts.set(name, { type, expr: expr.trim() });
  const num = (s) => {
    const t = s.trim();
    if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?[iuf]?$/i.test(t)) return Number(t.replace(/[iuf]$/i, ''));
    if (consts.has(t)) return value(t);
    const paren = /^\((.*)\)$/.exec(t);   // glf wraps negatives: (-273.15)
    if (paren) return num(paren[1]);
    const div = /^(.+?)\s*\/\s*(.+)$/.exec(t);
    if (div) { const a = num(div[1]), b = num(div[2]); return a === undefined || b === undefined ? undefined : a / b; }
    return undefined;
  };
  const value = (name) => {
    const { type, expr } = consts.get(name);
    if (type === 'bool') return expr === 'true' ? true : expr === 'false' ? false : undefined;
    const vec = /^vec[234][fiu]?\((.*)\)$/.exec(expr);
    if (vec) { const parts = vec[1].split(',').map(num); return parts.includes(undefined) ? undefined : parts; }
    return num(expr);
  };
  return [...consts.keys()].map((name) => ({ name, type: consts.get(name).type, value: value(name) }));
}
async function constCheck(lab, M, { check }, times) {
  const text = [M.prelude(RUN_GRID, M.STATE_OPTS.STATE_RW), M.mat.materialsGLSL(), M.sky.skyGLSL(), M.frameBindings(), M.brickInfoWGSL].join('\n');
  const all = parseConsts(text), known = all.filter((c) => c.value !== undefined);
  let at = 0;
  const body = [], want = [], label = [];
  for (const c of known) {
    body.push(...store(c.type, c.name, `${at}u`));
    for (const w of words(c.type, c.value)) { label.push(c.name); want.push(w); at++; }
  }
  const code = `${M.prelude(RUN_GRID, M.STATE_OPTS.STATE_RW)}\n${M.mat.materialsGLSL()}\n${M.sky.skyGLSL()}\n${M.frameBindings()}\n${M.brickInfoWGSL}
@group(2) @binding(0) var<storage, read_write> outBuf: array<u32>;
@compute @workgroup_size(1) fn main() {
  ${body.join('\n  ')}
}`;
  const g = RUN_GRID;
  const r = await lab.run({ label: 'consts', code, dispatch: [1, 1, 1],
    groups: [withData(M.RENDER_LAYOUT.FRAME, { 0: { data: b64(M.tablesBuffer()) }, 1: { size: M.FrameUniforms.size } }),
      stateGroup(M, M.STATE_OPTS.STATE_RW, g), [outEntry(0, at * 4)], paramsGroup(M)] });
  times.push(['consts probe', r.pipelineMs]);
  if (!ran(check, 'consts probe kernel runs', r)) return;
  const bad = compareWords(u32s(fromB64(r.outputs['2.0'])), want, (i) => label[i]);
  const skipped = all.filter((c) => c.value === undefined).map((c) => c.name);
  check(`every typed const reads back as Math.fround of its JS number (${known.length} consts; not literal: ${skipped.join(', ') || 'none'})`,
    bad.length === 0, `${bad.length} differ: ${bad.slice(0, SHOWN).join('; ')}`);
  const phys = Object.keys(M.physics.PHYS).filter((k) => !known.some((c) => c.name === k));
  check('every PHYS entry is among them', phys.length === 0, phys.join(', '));
}

// ---------------------------------------------------------------- F. the slot layout
async function slotCheck(lab, M, { check }, times) {
  for (const g of [{ nx: 32, ny: 16, nz: 16 }, { nx: 48, ny: 16, nz: 24 }]) {
    const { nx, ny, nz, slots } = M.gridDims(g);
    const pts = [];
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) pts.push([x, y, z]);
    const outside = [[-1, 6, 7], [-1, 0, 0], [nx, 0, 0], [0, -1, 0], [0, ny, 0], [0, 0, -5], [-4, -4, -4], [nx + 3, ny + 9, nz + 1]];
    pts.push(...outside);
    const ins = new Int32Array(pts.length * 4);
    pts.forEach((p, i) => ins.set(p, i * 4));
    const code = `${M.prelude(g, { state: false })}
@group(2) @binding(0) var<storage, read> inBuf: array<vec4i>;
@group(2) @binding(1) var<storage, read_write> outBuf: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= ${pts.length}u) { return; }
  let p = inBuf[i].xyz;
  let s = slotOf(p);
  let c = cellOf(s);
  let b = p >> vec3u(2u);
  let id = brickId(b);
  let bc = brickCoord(id);
  let o = i * 10u;
  outBuf[o] = s;
  outBuf[o + 1u] = bitcast<u32>(c.x); outBuf[o + 2u] = bitcast<u32>(c.y); outBuf[o + 3u] = bitcast<u32>(c.z);
  outBuf[o + 4u] = id;
  outBuf[o + 5u] = bitcast<u32>(bc.x); outBuf[o + 6u] = bitcast<u32>(bc.y); outBuf[o + 7u] = bitcast<u32>(bc.z);
  outBuf[o + 8u] = supertileOf(b);
  outBuf[o + 9u] = select(0u, 1u, inGrid(p));
}`;
    const r = await lab.run({ label: 'slots', code, dispatch: [Math.ceil(pts.length / 64), 1, 1],
      groups: [tablesGroup(M), [], [inEntry(0, ins), outEntry(1, pts.length * 40)], paramsGroup(M)] });
    times.push([`slot probe ${nx}×${ny}×${nz}`, r.pipelineMs]);
    if (!ran(check, `slot probe ${nx}×${ny}×${nz} runs`, r)) continue;
    const got = u32s(fromB64(r.outputs['2.1']));
    const bad = [], seen = new Set();
    pts.forEach(([x, y, z], i) => {
      const s = M.cellSlot(g, x, y, z), c = M.slotCell(g, s), b = [x >> 2, y >> 2, z >> 2];
      const id = M.brickIdOf(g, ...b), bc = M.brickCoordOf(g, id);
      const want = [s, ...c.map((v) => v >>> 0), id, ...bc.map((v) => v >>> 0), id >>> 4, +(i < slots)];
      const o = i * 10;
      if (want.some((w, k) => got[o + k] !== w)) bad.push(`(${x}, ${y}, ${z}): got [${[...got.subarray(o, o + 10)]}], want [${want}]`);
      if (i < slots) {
        if (s >= slots || seen.has(s) || c[0] !== x || c[1] !== y || c[2] !== z) bad.push(`(${x}, ${y}, ${z}): slot ${s} isn't a bijection`);
        seen.add(s);
      }
    });
    check(`slotOf, cellOf, brickId, brickCoord, supertileOf, inGrid equal their JS mirrors on ${nx}×${ny}×${nz} and ${outside.length} cells outside (a bijection onto [0, SLOTS))`,
      bad.length === 0, `${bad.length} differ: ${bad.slice(0, SHOWN).join('; ')}`);
  }
  check('slotOf(-1, 6, 7) = 763 (docs/webgpu.md C2)', M.cellSlot({ nx: 64, ny: 64, nz: 64 }, -1, 6, 7) === 763);
  // the brick-major order: a brick is a 64-slot run in tile order, a supertile a 1024-slot run
  const g = { nx: 64, ny: 32, nz: 48 };
  let ok = true;
  for (let s = 0; s < M.gridDims(g).slots; s += 37) {
    const [x, y, z] = M.slotCell(g, s);
    const tile = (x & 3) + 4 * (y & 1) + 8 * ((z & 3) + 4 * ((y & 3) >> 1));
    ok &&= (s & 63) === tile && s >> 6 === M.brickIdOf(g, x >> 2, y >> 2, z >> 2);
  }
  check('a brick is its 64 cells in tile order, a supertile 16 consecutive bricks (JS mirror, 64×32×48)', ok);
}

// ---------------------------------------------------------------- G. FrameUniforms, the header, the brick record
async function packingCheck(lab, M, { check }, times) {
  const values = {}, fields = M.FrameUniforms.fields;
  let k = 1;
  const next = (sc) => (sc === 'f32' ? k++ + 0.25 : sc === 'i32' ? -(k++) : k++);
  for (const f of fields) {
    if (f.elem) values[f.name] = Array.from({ length: f.count }, () => Array.from({ length: 4 }, () => next('f32')));
    else if (f.comps === 1) values[f.name] = next(f.scalar);
    else values[f.name] = Array.from({ length: f.comps }, () => next(f.scalar));
  }
  const buf = new ArrayBuffer(M.FrameUniforms.size);
  M.FrameUniforms.write(new DataView(buf), 0, values);
  const body = [], want = [];
  let at = 0;
  const put = (type, e, v) => { body.push(...store(type, e, `${at}u`)); words(type, v).forEach((w) => want.push(w)); at += COMPS[type]; };
  for (const f of fields) {
    if (f.elem) values[f.name].forEach((v, i) => put('vec4f', `FU.${f.name}[${i}]`, v));
    else if (f.type === 'mat4x4f') for (let c = 0; c < 4; c++) put('vec4f', `FU.${f.name}[${c}]`, values[f.name].slice(4 * c, 4 * c + 4));
    else put(f.type, `FU.${f.name}`, values[f.name]);
  }
  put('vec3i', 'H.origin', [-7, 11, 13]); put('u32', 'H.src', 1); put('u32', 'H.dst', 0);
  const infos = [{ bits: 21, air: 5, gas: 64, matter: true }, { bits: 0, air: 7, gas: 0, matter: false }, { bits: 31, air: 0, gas: 33, matter: true }];
  const packed = new Uint32Array(infos.map(M.packBrickInfo));
  for (const [i, x] of infos.entries()) {
    body.push(...store('u32', `brickBits(inBuf[${i}])`, `${at}u`)); want.push(x.bits); at++;
    body.push(...store('u32', `brickAir(inBuf[${i}])`, `${at}u`)); want.push(x.air); at++;
    body.push(...store('f32', `brickGas(inBuf[${i}])`, `${at}u`)); want.push(f32bits(x.gas / 64)); at++;
    body.push(...store('bool', `brickMatter(inBuf[${i}])`, `${at}u`)); want.push(+x.matter); at++;
    body.push(...store('u32', `brickInfoWord(${x.bits}u, ${x.air}u, ${x.gas}u, ${x.matter})`, `${at}u`)); want.push(packed[i]); at++;
  }
  const code = `${M.prelude(RUN_GRID, { state: false })}\n${M.frameBindings()}\n${M.brickInfoWGSL}
@group(2) @binding(0) var<storage, read> inBuf: array<u32>;
@group(2) @binding(1) var<storage, read_write> outBuf: array<u32>;
@compute @workgroup_size(1) fn main() {
  ${body.join('\n  ')}
}`;
  const r = await lab.run({ label: 'packing', code, dispatch: [1, 1, 1],
    groups: [withData(M.RENDER_LAYOUT.FRAME, { 0: { data: b64(M.tablesBuffer()) }, 1: { data: b64(buf) } }), [],
      [inEntry(0, packed), outEntry(1, at * 4)], paramsGroup(M, { header: { origin: [-7, 11, 13], src: 1, dst: 0 } })] });
  times.push(['packing probe', r.pipelineMs]);
  if (!ran(check, 'packing probe kernel runs', r)) return;
  const bad = compareWords(u32s(fromB64(r.outputs['2.1'])), want, (i) => `word ${i}`);
  check(`FrameUniforms (${fields.length} fields, ${M.FrameUniforms.size} B), the header and the brick record's decoders read back as JS packed them`,
    bad.length === 0, `${bad.length} differ: ${bad.slice(0, SHOWN).join('; ')}`);
}

// ---------------------------------------------------------------- H. editMain
async function editCheck(lab, M, { check }, times) {
  const g = RUN_GRID, { nx, ny, nz, slots } = M.gridDims(g), ml = M.marksLayout(g);
  const { E } = M.el;
  const SAND = E.SAND;
  // an initial state: copy 0 a pattern, copy 1 a marker that must stay; flags NEAR | SELF
  const A0 = new Float32Array(2 * slots * 4), B0 = new Float32Array(2 * slots * 4), F0 = new Uint32Array(2 * slots);
  const cells = [];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) cells.push([x, y, z]);
  const idAt = (x, y, z) => (x >= 8 && x < 12 && y >= 4 && y < 8 && z >= 4 && z < 8 ? SAND : (x + 2 * y + 3 * z) % 3 === 0 ? E.WATER : E.EMPTY);
  for (const [x, y, z] of cells) {
    const s = M.cellSlot(g, x, y, z);
    A0.set([idAt(x, y, z), 20 + y, 0, ((x * 7 + y * 13 + z * 29) % 97) / 100], 4 * s);
    A0.set([-1, -2, -3, -4], 4 * (slots + s));
    F0[s] = 3; F0[slots + s] = 0xbeef;
  }
  const runEdit = async (label, reads, update, extra, box, debug) => {
    const P = M.hostStruct('EditParams', { ...M.EDIT_FIELDS, ...extra.fields }, { space: 'uniform' });
    const pb = new ArrayBuffer(P.size);
    P.write(new DataView(pb), 0, { editLo: box[0], editHi: box[1], ...extra.values });
    const code = `${M.prelude(g, { ...M.STATE_OPTS.STATE_RW, debug })}\n${P.wgsl}\n@group(3) @binding(1) var<uniform> P: EditParams;\n${update}\n${M.editMain('update', { reads })}`;
    const nb = [0, 1, 2].map((k) => (box[1][k] >> 2) - (box[0][k] >> 2) + 1), n = nb[0] * nb[1] * nb[2];
    const dispatch = [n, 1, 1];
    const group1 = stateGroup(M, M.STATE_OPTS.STATE_RW, g, {
      0: { data: b64(A0), read: true }, 1: { data: b64(B0), read: true }, 2: { data: b64(F0), read: true }, 3: { read: true } });
    const group2 = reads === 'neighbours' ? [{ binding: M.EDIT_SCRATCH_BINDING, visibility: 4, buffer: { type: 'storage' }, size: 2 * n * 64 * 16 }] : [];
    const r = await lab.run({ label, code, steps: reads === 'own' ? [{ entry: 'main', dispatch }] : [{ entry: 'main', dispatch }, { entry: 'apply', dispatch }],
      groups: [tablesGroup(M), group1, group2, paramsGroup(M, { params: pb })] });
    times.push([label, r.pipelineMs]);
    if (!ran(check, `${label} runs`, r)) return null;
    return { A: new Float32Array(fromB64(r.outputs['1.0'])), F: u32s(fromB64(r.outputs['1.2'])), marks: u32s(fromB64(r.outputs['1.3'])) };
  };
  const verify = (label, out, newA, box) => {
    const bad = [], changedBricks = new Set();
    for (const [x, y, z] of cells) {
      const s = M.cellSlot(g, x, y, z);
      const want = newA(x, y, z) ?? Array.from(A0.subarray(4 * s, 4 * s + 4));
      const got = Array.from(out.A.subarray(4 * s, 4 * s + 4));
      const changed = want.some((v, k) => Math.fround(v) !== A0[4 * s + k]);
      if (got.some((v, k) => v !== Math.fround(want[k]))) bad.push(`A(${x}, ${y}, ${z}) = [${got}], want [${want}]`);
      if (changed) {
        changedBricks.add(s >>> 6);
        // a new id, temperature or ctype + seed: freshFlags (DIRTY, and MATTER unless it is now air)
        const fresh = [0, 1, 3].some((k) => Math.fround(want[k]) !== A0[4 * s + k]);
        const matter = Math.fround(want[0]) !== M.el.E.EMPTY ? 4 : 0;
        if (fresh && ((out.F[s] & 8) !== 8 || (out.F[s] & 4) !== matter)) bad.push(`F(${x}, ${y}, ${z}) = ${out.F[s]}: want DIRTY${matter ? ' | MATTER' : ''}`);
      } else if (out.F[s] !== 3) bad.push(`F(${x}, ${y}, ${z}) = ${out.F[s]}, unchanged: want 3`);
      if (out.A[4 * (slots + s)] !== -1 || out.F[slots + s] !== 0xbeef) bad.push(`copy 1 of (${x}, ${y}, ${z}) was written`);
    }
    const bit = (base, b) => (out.marks[base + (b >>> 5)] >>> (b & 31)) & 1;
    for (let b = 0; b < M.gridDims(g).nbricks; b++) {
      const want = +changedBricks.has(b);
      if (bit(ml.act, b) !== want || bit(ml.derived, b) !== want || out.marks[ml.foams + b] !== want) bad.push(`brick ${b} marks act ${bit(ml.act, b)} derived ${bit(ml.derived, b)} foams ${out.marks[ml.foams + b]}, want ${want}`);
    }
    if (out.marks[ml.dbg] !== 0) bad.push(`debug counter ${out.marks[ml.dbg]}`);
    check(`${label}: only the box's changed cells change, with writtenFlags; exactly their ${changedBricks.size} bricks marked; copy 1 untouched`,
      bad.length === 0, `${bad.length} wrong: ${bad.slice(0, SHOWN).join('; ')}`);
  };
  // in place: sand fills a ball inside a box that cuts it; a brick already sand inside it changes nothing
  const center = [10.25, 7.4, 6.1], radius = 4.3, box = [[5, 2, 1], [12, 12, 11]];
  const near = cells.filter(([x, y, z]) => Math.abs((x + 0.5 - center[0]) ** 2 + (y + 0.5 - center[1]) ** 2 + (z + 0.5 - center[2]) ** 2 - radius ** 2) < 1e-3);
  check('no cell centre sits on the test ball\'s edge (f32 and f64 agree on inside)', near.length === 0);
  const inBox = (x, y, z) => x >= box[0][0] && x <= box[1][0] && y >= box[0][1] && y <= box[1][1] && z >= box[0][2] && z <= box[1][2];
  for (const debug of [false, true]) {
    const label = `editMain own${debug ? ' (debug prelude)' : ''}`;
    const out = await runEdit(label, 'own', `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let d = vec3f(p) + 0.5 - P.center;
  if (dot(d, d) <= P.radius * P.radius) { *oA = vec4f(f32(E_SAND), a.y, 0.0, a.w); }
}`, { fields: { center: 'vec3f', radius: 'f32' }, values: { center, radius } }, box, debug);
    if (out) verify(label, out, (x, y, z) => {
      const d2 = (x + 0.5 - center[0]) ** 2 + (y + 0.5 - center[1]) ** 2 + (z + 0.5 - center[2]) ** 2;
      if (!inBox(x, y, z) || d2 > radius ** 2) return null;
      const s = M.cellSlot(g, x, y, z);
      return [SAND, A0[4 * s + 1], 0, A0[4 * s + 3]];
    }, box);
  }
  // two-phase: each cell of the box takes the state of the cell above it, as it was before the edit
  const box2 = [[3, 0, 2], [21, 14, 13]];
  const out = await runEdit('editMain neighbours', 'neighbours', `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let q = p + vec3i(0, 1, 0);
  if (inGrid(q)) { *oA = fetchA(q); }
}`, { fields: {}, values: {} }, box2, true);
  const inBox2 = (x, y, z) => x >= box2[0][0] && x <= box2[1][0] && y >= box2[0][1] && y <= box2[1][1] && z >= box2[0][2] && z <= box2[1][2];
  if (out) verify('editMain neighbours (two-phase)', out, (x, y, z) => {
    if (!inBox2(x, y, z) || y + 1 >= ny) return null;
    const q = M.cellSlot(g, x, y + 1, z);
    return Array.from(A0.subarray(4 * q, 4 * q + 4));
  }, box2);
  // the debug prelude counts accessors outside the grid, and drops the store
  const bad = await lab.run({ label: 'debug counter', dispatch: [1, 1, 1],
    code: `${M.prelude(g, { ...M.STATE_OPTS.STATE_RW, debug: true })}
@compute @workgroup_size(1) fn main() {
  let a = fetchA(vec3i(-1, 0, 0));
  writeState(vec3i(NX, 0, 0), a, fetchB(vec3i(0, NY, 0)), 7u);
  _ = fetchAs(SLOTS);
}`, groups: [tablesGroup(M), stateGroup(M, M.STATE_OPTS.STATE_RW, g, { 0: { data: b64(A0), read: true }, 3: { read: true } }), [], paramsGroup(M)] });
  times.push(['debug counter', bad.pipelineMs]);
  if (ran(check, 'debug counter kernel runs', bad)) {
    const marks = u32s(fromB64(bad.outputs['1.3'])), A = new Float32Array(fromB64(bad.outputs['1.0']));
    check('the debug prelude counts 4 accesses outside the grid (fetchA, writeState, fetchB, fetchAs) and stores nothing',
      marks[ml.dbg] === 4 && A.every((v, i) => v === A0[i]), `counted ${marks[ml.dbg]}`);
  }
}

// ---------------------------------------------------------------- CPU checks
function cpuChecks(M, { check }) {
  // FOAMS is the liquid detail's LIQ_PROPS (shaders/gfx/liquidDetail.js), which can't be imported here
  const src = readFileSync(join(ROOT, 'src/shaders/gfx/liquidDetail.js'), 'utf8');
  const props = /const LIQ_PROPS = \{([\s\S]*?)\n\};/.exec(src);
  const keys = props ? [...props[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]) : null;
  check('gfx/materials.js FOAMS lists the liquids shaders/gfx/liquidDetail.js LIQ_PROPS foams', keys && keys.join() === M.mat.FOAMS.join(),
    `LIQ_PROPS ${keys}, FOAMS ${M.mat.FOAMS}`);
  const { Tables } = M.tableLayout();
  check(`the tables' buffer is the struct's size (${Tables.size} B)`, M.tablesBuffer().byteLength === Tables.size);
  check('a brick record packs into 16 bytes (vec3f emit + u32 info)', M.BrickInfo.size === 16);
  check('the header is 48 bytes (vec3i origin, src, dst, format, capture, the ring\'s two words)', M.Header.size === 48 && M.Header.offsetOf('src') === 12 && M.Header.offsetOf('dst') === 16
    && M.Header.offsetOf('ring') === 28 && M.Header.offsetOf('ringed') === 32);
  const marks = M.marksLayout({ nx: 128, ny: 384, nz: 128 });
  check('the giant volcano window\'s marks fit (98,304 bricks)', marks.words === 2 * 3072 + 98304 + 1, JSON.stringify(marks));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const port = Number(arg('--port') ?? BASE_PORT);
  const t0 = Date.now();
  const rep = reporter();
  const M = await mods();
  cpuChecks(M, rep);
  const times = [];
  await withLab(async (lab) => {
    const info = await lab.info();
    console.log(`device: ${info.adapter.vendor} ${info.adapter.architecture}${info.adapter.isFallbackAdapter ? ' (fallback adapter)' : ''}; limits ${JSON.stringify(info.limits)}`);
    await compileAll(lab, M, rep);
    await layoutChecks(lab, M, rep, times);
    await tableCheck(lab, M, rep, times);
    await rngCheck(lab, M, rep, times);
    await constCheck(lab, M, rep, times);
    await slotCheck(lab, M, rep, times);
    await packingCheck(lab, M, rep, times);
    await editCheck(lab, M, rep, times);
    const after = await lab.info();
    rep.check('no uncaptured GPU errors, device not lost', !after.uncaptured.length && !after.lost, `${after.uncaptured.slice(0, 3)} ${after.lost ?? ''}`);
  }, { port });
  if (process.argv.includes('--time')) for (const [name, ms] of times) console.log(`time ${name}: ${ms.toFixed(0)} ms`);
  const slowest = times.reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0]);
  console.log(`pipelines: ${times.length}, slowest ${slowest[0]} ${slowest[1].toFixed(0)} ms; total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(rep.failures() ? `${rep.failures()} FAILED` : 'tables check: all checks pass');
  process.exit(rep.failures() ? 1 : 0);
}

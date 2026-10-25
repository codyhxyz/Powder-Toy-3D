// CPU check of the world fields (docs/seamless-world.md, "F"; src/gfx/worldFields.js,
// src/shaders/world/fields.js). No browser, no GPU.
//
//  1. naga on every WGSL module (the nine derivation kernels over W's stand-in, the sampling
//     functions with and without the close-up cubic), and the operator rules naga misses
//     (tools/check-wgsl-operators.mjs moduleProblems).
//  2. The planner on the real maps' plans (1024², Tinker Creek's 3072×1024, the Giant Volcano's
//     384 tall, a 128³ box), the camera wandering: the budget holds, a job never names one brick
//     of its clip twice (the toroidal slot map), every FINAL brick has its ring in the job, valid
//     stays in the clip, the levels fill, nest, and the coarsest holds the whole world.
//  3. A JS twin of the derivation kernels (the WGSL's arithmetic, stage for stage), run on the
//     real WorldFields's dispatches over a small synthetic world through a fake device, held bit
//     for bit against tools/field-reference.mjs (the window path's numbers: QuantizedFields, the
//     same oracle field-deriver checks hold the box path to) for every level-0 texel it holds:
//     after the load, after a scroll (which must rewrite exactly the slab that came in, wrapped
//     toroidally, vertical guard rows included), and every frame of a change (the EMA's history in
//     the clip cells, with the EMA sets the jobs flagged). Coarse levels: a flat floor's surface
//     sits where level 0 puts it.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as F from '../src/shaders/world/fields.js';
import { WorldFields, ClipLevel, planFrame, fieldClipValues, boxEmpty, boxHas, FIELD_BRICKS_PER_FRAME } from '../src/gfx/worldFields.js';
import { worldCopyStubWGSL } from './world-fields-stub.mjs';
import { prelude } from '../src/shaders/common.js';
import { materialsGLSL, MATERIAL_FIELDS, CHANNELS, THIN_MIN_PEAK, THIN_MASK_LO, THIN_MASK_HI, FIRE_BASE, HEAT_RANGE } from '../src/gfx/materials.js';
import { ELEMENTS, E } from '../src/elements.js';
import { PHYS } from '../src/physics.js';
import { FieldTestGPU } from './field-test-gpu.mjs';
import { QuantizedFields, emaWords, f, clamp, half, unhalf, pack2, unpack2, pack4, unpack4, roundEven } from './field-reference.mjs';
import { wcWord, wcUnword } from '../src/shaders/world/cellWord.js';
import { FIELD_EMA_SETTLE, FIELD_RUBBLE } from '../src/shaders/fields.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const fail = (m) => { bad++; console.error('FAIL', m); };
const check = (ok, m) => { if (!ok) fail(m); };

// ---------------------------------------------------------------- 1. naga and the operator rules
{
  const dir = mkdtempSync(join(tmpdir(), 'world-fields-'));
  // the operator gate's tokenizer and rules, as it runs them (one source: its own text, cut before its main)
  const gate = readFileSync(join(ROOT, 'tools/check-wgsl-operators.mjs'), 'utf8');
  const cut = gate.indexOf('// ---------------------------------------------------------------- main');
  const rulesFile = join(dir, 'rules.mjs');
  writeFileSync(rulesFile, `${gate.slice(0, cut).replace(/^import .*$/gm, '').replace(/^const ROOT[\s\S]*?;$/m, '').replace(/^const argv[\s\S]*?;$/m, '').replace(/^const FILE[\s\S]*?;$/m, '')}\nexport { moduleProblems };`);
  const { moduleProblems } = await import(pathToFileURL(rulesFile));
  const nagaOk = (name, code) => {
    const file = join(dir, `${name.replace(/\W/g, '_')}.wgsl`);
    writeFileSync(file, code);
    try { execFileSync('naga', [file], { stdio: 'pipe' }); } catch (e) { fail(`naga ${name}: ${String(e.stderr).slice(0, 2000)}`); }
    for (const p of moduleProblems(code)) fail(`operators ${name}: ${p}`);
  };
  for (const world of [[1024, 128, 1024], [3072, 128, 1024], [1024, 384, 1024], [128, 128, 128]]) {
    const plan = F.fieldClipPlan(world);
    for (const st of F.DERIVE_STAGES) nagaOk(`${st}@${world}`, F.worldFieldKernelWGSL(st, { plan, cap: FIELD_BRICKS_PER_FRAME, copyWGSL: worldCopyStubWGSL }));
  }
  for (const detail of [{}, { DETAIL_CUBIC_CLOSE: true }]) {
    nagaOk(`sampling${detail.DETAIL_CUBIC_CLOSE ? ' close' : ''}`, `${prelude({ nx: 128, ny: 128, nz: 128 }, { state: false })}
${materialsGLSL()}
${F.fieldsBindingsWGSL()}
${F.worldFieldsWGSL({ detail })}
@group(2) @binding(8) var<storage, read_write> probe: array<vec4f>;
@compute @workgroup_size(1) fn main() {
  let p = vec3f(10.5, 20.25, 30.75);
  gFieldLevel = fieldLevelFor(3.0);
  var acc = fieldTex(tFT, p) + surfField(p) + mediaField(p) + fieldCubic(tFM, p) + surfSample(p);
  acc += vec4f(fieldCubicGrad(tFS, p, CH_LIQUID), surfChannel(p, 1)) + vec4f(surfNormal(p, 0, vec3f(0.0, 1.0, 0.0)), cubicShare(p, 2));
  let t = surfCross(p, vec3f(0.0, -1.0, 0.0), 0, true, 0.0, 0.5, 1.0, 0.2, 0.4, 0.7);
  probe[0] = acc + vec4f(t, surfRoot(p, vec3f(1.0, 0.0, 0.0), 1, 0.0, 1.0, -0.2, 0.3), select(0.0, 1.0, gThin), SURF_ISO + NO_HIT + fieldCellsAt(p) + f32(fieldLevelAt(p)));
}`);
  }
}

// ---------------------------------------------------------------- 2. the planner on the real plans
{
  const rng = ((s) => () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32))(7);
  for (const world of [[1024, 128, 1024], [3072, 128, 1024], [1024, 384, 1024], [128, 128, 128]]) {
    const plan = F.fieldClipPlan(world), lay = F.fieldWorkLayout(plan, FIELD_BRICKS_PER_FRAME);
    const S = plan.texels, top = plan.levels.at(-1);
    check(top.worldBricks.every((v, i) => v <= top.clipBricks[i]), `${world}: the coarsest level (${top.clipBricks}) holds the world (${top.worldBricks})`);
    const levels = plan.levels.map((l) => new ClipLevel(l, lay));
    let cam = [world[0] * 0.3, Math.min(world[1] - 1, 70), world[2] * 0.6], frame = 0;
    const steps = [];
    for (let i = 0; i < 400; i++) {
      // a wander: walking, a sprint, now and then a teleport
      const r = rng();
      if (r < 0.01) cam = [rng() * world[0], rng() * world[1], rng() * world[2]];
      else cam = cam.map((v, a) => Math.max(0, Math.min(world[a] - 1, v + (a === 1 ? (rng() - 0.5) * 2 : (rng() - 0.3) * (r < 0.2 ? 24 : 6)))));
      const changes = rng() < 0.5 ? [{ lo: cam.map((v) => Math.floor(v + 10)), hi: cam.map((v) => Math.floor(v + 14)) }] : [];
      const jobs = planFrame(levels, { frame: ++frame, cam, changes });
      steps.push(jobs.length);
      const used = jobs.reduce((n, j) => n + j.entries.length, 0);
      check(used <= FIELD_BRICKS_PER_FRAME, `${world}: frame ${frame} uses ${used} bricks`);
      for (const j of jobs) {
        const L = levels[j.level.k], keys = new Set(), at = new Map();
        for (const w of j.entries) {
          const { b } = F.unpackEntry(w), k = L.key(b);
          if (keys.has(k)) fail(`${world}: a job names clip key ${k} twice`);
          keys.add(k); at.set(b.join(), w);
          check(boxHas(L.clip, b) && boxHas(L.world, b), `${world}: brick ${b} outside its clip or world`);
        }
        for (const w of j.entries) {
          if (!(w & F.FE.FINAL)) continue;
          const { b } = F.unpackEntry(w);
          check(boxHas(L.valid, b), `${world}: FINAL brick ${b} outside valid`);
          for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const q = [b[0] + dx, b[1] + dy, b[2] + dz];
            if (boxHas(L.world, q) && !at.has(q.join())) fail(`${world}: FINAL ${b} lacks ring brick ${q}`);
          }
        }
      }
      for (const L of levels) {
        const U = L.usable;
        check(boxEmpty(L.valid) || (L.valid.lo.every((v, i) => v >= U.lo[i]) && L.valid.hi.every((v, i) => v <= U.hi[i])), `${world}: valid outside usable`);
      }
    }
    // standing still, everything fills; then the regions nest and the coarsest is the world
    let still = 0;
    while (!levels.every((L) => L.complete) && still < 2000) { planFrame(levels, { frame: ++frame, cam }); still++; }
    check(levels.every((L) => L.complete), `${world}: the levels didn't fill`);
    const fc = fieldClipValues(plan, levels, world);
    for (let k = 0; k + 1 < levels.length; k++) {
      check(fc.lo[k].slice(0, 3).every((v, i) => v >= fc.lo[k + 1][i]) && fc.hi[k].slice(0, 3).every((v, i) => v <= fc.hi[k + 1][i]), `${world}: level ${k} not inside ${k + 1}`);
      check(cam.every((v, i) => v > fc.lo[k][i] && v < fc.hi[k][i]) || k > 0, `${world}: the camera outside level 0's region`);
    }
    const lt = fc.lo[levels.length - 1], ht = fc.hi[levels.length - 1];
    check(lt.slice(0, 3).every((v) => v <= -F.FIELD_FAR) && ht.slice(0, 3).every((v) => v >= F.FIELD_FAR), `${world}: the coarsest level doesn't hold the world (${lt}, ${ht})`);
    console.log(`planner ${world}: ${plan.n} levels, ${S}×${plan.rows}×${S} texels, thin ${plan.thinRows} rows; filled in ${still} still frames`);
  }
  // fieldLevelFor: level + blend never falls as the footprint grows (the JS twin of its WGSL)
  const levelFor = (fp, n) => { const lam = Math.log2(Math.max(fp, 1e-6)), l = Math.max(0, Math.min(n - 1, Math.floor(lam)));
    const t = Math.max(0, Math.min(1, (lam - l - (1 - F.FIELD_LEVEL_BLEND)) / F.FIELD_LEVEL_BLEND));
    return l + (lam < 0 || l >= n - 1 ? 0 : t * t * (3 - 2 * t)); };
  let last = 0;
  for (let fp = 0.01; fp < 300; fp *= 1.01) { const v = levelFor(fp, 6); if (v < last - 1e-9 || v - last > 0.2) fail(`fieldLevelFor jumps at ${fp}: ${last} → ${v}`); last = v; }
}

// ---------------------------------------------------------------- 3. the twin against the window path
const chOf = ELEMENTS.map((e) => MATERIAL_FIELDS.find((m) => m.fn === 'SURFCH').get(e));
const mdOf = ELEMENTS.map((e) => MATERIAL_FIELDS.find((m) => m.fn === 'MEDIACH').get(e));
const hazeOf = ELEMENTS.map((e) => MATERIAL_FIELDS.find((m) => m.fn === 'HAZE').get(e));
// shaders/fields.js fieldTarget, in floats (the coarse gather averages these)
function targetFloats(a) {
  const id = Math.trunc(a[0] + 0.5), ch = chOf[id], md = mdOf[id], sv = [0, 0, 0, 0], m = [0, 0, 0, 0];
  if (ch >= 0) sv[ch] = id === E.STONE ? 1 - FIELD_RUBBLE.LUMP * ((((a[3] % 1) * FIELD_RUBBLE.HASH) % 1)) : 1;
  if (md === 0) m[0] = clamp(a[2]); else if (md === 1) m[1] = hazeOf[id];
  else if (md === 2) { m[2] = FIRE_BASE + (1 - FIRE_BASE) * clamp(a[2]); m[3] = m[2] * clamp((a[1] - PHYS.AMBIENT) / HEAT_RANGE); }
  const crisp = id !== E.EMPTY && ch < 0 && md < 0;
  return { sv, m, weight: [0, 1, 2, 3].map((i) => (crisp || (i === 0 && ch > 0) ? 0 : 1)) };
}

const WORLD = [48, 24, 48], TEXELS = 32, ROWS = 16, BUDGET = 512;
const cellIndex = (c) => c[0] + WORLD[0] * (c[1] + WORLD[1] * c[2]);
const words = new Uint32Array(WORLD[0] * WORLD[1] * WORLD[2]);
const seedOf = (c) => ((Math.imul(c[0] * 73856093 ^ c[1] * 19349663 ^ c[2] * 83492791, 0x9e3779b1) >>> 8) / 16777216);
const set = (c, id, t = 20, aux = 1, ctype = 0) => { words[cellIndex(c)] = wcWord(id, ctype, t, aux); };
// a floor of rock (smooth: organic) at 6-7 with a bump, a sand pile, a pond, a wall column (crisp),
// rubble, a smoke puff and a fire
for (let z = 0; z < WORLD[2]; z++) for (let x = 0; x < WORLD[0]; x++) {
  const h = 6 + ((x * 7 + z * 3) % 5 === 0 && (x > 16 || z > 16) ? 1 : 0) + (Math.hypot(x - 30, z - 18) < 5 ? 2 : 0);
  for (let y = 0; y < h; y++) set([x, y, z], E.ROCK);
  if (Math.hypot(x - 12, z - 34) < 6) for (let y = h; y < h + 2; y++) set([x, y, z], E.WATER);
  if (Math.hypot(x - 36, z - 36) < 4) for (let y = h; y < h + 4 - Math.floor(Math.hypot(x - 36, z - 36)); y++) set([x, y, z], E.SAND);
  if (x === 20 && z >= 20 && z < 23) for (let y = h; y < 20; y++) set([x, y, z], E.WALL);
  if (x >= 40 && z < 6) set([x, h, z], E.STONE);
}
for (let i = 0; i < 30; i++) set([24 + (i % 4), 14 + ((i >> 2) % 3), 10 + (i >> 4)], E.SMOKE, 60, 0.6);
for (let i = 0; i < 12; i++) set([8 + (i % 3), 9 + (i >> 2), 8], E.FIRE, 900, 0.8);
const raw = (c) => { const u = wcUnword(words[cellIndex(c)]); return [u.id, f(u.t), f(u.aux), u.ctype + seedOf(c)].map(f); };

// the fake device (tools/field-test-gpu.mjs) and the twin run on its dispatches
const gpu = new FieldTestGPU({ emulateCopies: false });
globalThis.GPUBufferUsage.UNIFORM ??= 16;
gpu.device = { createSampler: (d) => ({ ...d }) };
gpu.stats = { flushes: 0 };
gpu.write = (buffer, offset, data) => { new Uint8Array(buffer.bytes, offset, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); };
const fields = new WorldFields(gpu, { layout: gpu.layout('WC', []), bindGroup: { stub: true }, size: WORLD },
  { copyWGSL: worldCopyStubWGSL, tables: { tables: true }, texels: TEXELS, rows: ROWS, budget: BUDGET });
const plan = fields.plan, lay = fields.layout, S = plan.texels;
const tex = new Map(Object.entries(fields.textures).map(([name, t]) => [t, { name, rows: t.size[1], data: new Float64Array(S * t.size[1] * S * 4) }]));
let written = new Set();
const NO = -1;
gpu.onDispatch = (k, { bind, params: P }) => {
  const stage = k.name.replace('worldField ', '');
  const g = bind[2], buf = (b) => new Uint32Array(g.entries.find((e) => e.binding === b).resource.buffer.bytes);
  const book = buf(0), work = buf(1);
  const [band0, rows, s, level] = P.band, rb = rows / 4, wt = WORLD.map((v) => Math.ceil(v / s));
  const inW = (q) => q.every((v, i) => v >= 0 && v < wt[i]);
  const slotKey = (b) => (b[0] % lay.cb) + lay.cb * ((b[1] % rb) + lay.rbMax * (b[2] % lay.cb));
  const local = (l) => l[0] + 4 * (l[1] + 4 * l[2]);
  const slotAt = (q) => { const e = book[lay.book.map + slotKey(q.map((v) => v >> 2))]; return (e >>> 16) === P.stamp ? (e & 65535) * 64 + local(q.map((v) => v & 3)) : NO; };
  const emaIdx = (c) => (c[0] % S) + S * ((c[1] % rows) + rows * (c[2] % S));
  const bandTexel = (q) => [q[0] % S, band0 + (q[1] % rows), q[2] % S];
  const SC = lay.sc, A = lay.work.a, B = lay.work.b, C = lay.work.c, EC = lay.emaCells;
  const store = (t, q, v) => { const T = tex.get(t), i = 4 * (q[0] + S * (q[1] + T.rows * q[2])); for (let c = 0; c < 4; c++) T.data[i + c] = v[c]; written.add(`${T.name}:${q}`); };
  const out = (b) => g.entries.find((e) => e.binding === b).resource.texture;
  if (stage === 'slots') {
    for (let e = 0; e < P.count; e++) book[lay.book.map + slotKey(F.unpackEntry(book[P.base + e]).b)] = ((P.stamp << 16) | (P.base + e)) >>> 0;
    return;
  }
  for (let e = 0; e < P.count; e++) {
    const w = book[P.base + e], { b } = F.unpackEntry(w);
    for (let li = 0; li < 64; li++) {
      const p = [b[0] * 4 + (li & 3), b[1] * 4 + ((li >> 2) & 3), b[2] * 4 + (li >> 4)], sl = (P.base + e) * 64 + li;
      const dir = [0, 0, 0]; dir[P.axis] = 1;
      if (stage === 'gather0') {
        if (!inW(p)) { for (let k2 = 0; k2 < 3; k2++) work[B + k2 * SC + sl] = 0; continue; }
        const h = emaIdx(p), target = emaWords(raw(p), false, null);
        let ws = work[h], wm = work[EC + h];
        if (w & F.FE.EMA) {
          const out2 = emaWords(raw(p), false, P.reset || (w & F.FE.FRESH) ? null : [ws, wm]);
          ws = work[h] = out2[0]; wm = work[EC + h] = out2[1];
        }
        work[B + sl] = ws; work[B + SC + sl] = wm; work[B + 2 * SC + sl] = target[2];
      } else if (stage === 'gather') {
        const sv = [0, 0, 0, 0], m = [0, 0, 0, 0], d = [0, 0, 0, 0];
        let count = 0;
        if (inW(p)) {
          const full = level < F.GATHER_FULL_LEVELS, ns = full ? s : F.GATHER_SAMPLES, st = full ? 1 : s / F.GATHER_SAMPLES, off = st >> 1;
          for (let z = 0; z < ns; z++) for (let y = 0; y < ns; y++) for (let x = 0; x < ns; x++) {
            const c = [p[0] * s + x * st + off, p[1] * s + y * st + off, p[2] * s + z * st + off];
            if (c.some((v, i) => v >= WORLD[i])) continue;
            const t = targetFloats(raw(c));
            for (let i = 0; i < 4; i++) { sv[i] += t.sv[i]; m[i] += t.m[i]; d[i] += t.weight[i]; }
            count++;
          }
        }
        const kk = 1 / Math.max(count, 1);
        work[B + sl] = pack4(sv.map((v) => v * kk)); work[B + SC + sl] = pack4(m.map((v) => v * kk)); work[B + 2 * SC + sl] = pack4(d.map((v) => v * kk));
      } else if (stage === 'blur' || stage === 'blurFinal') {
        const src = stage === 'blurFinal' || P.axis === 0 ? B : A, dst = P.axis === 0 ? A : B;
        const sv = [0, 0, 0, 0], m = [0, 0, 0, 0], d = [0, 0, 0, 0];
        for (let tap = 0; tap < 5; tap++) {
          const q = p.map((v, i) => v + dir[i] * (tap - 2));
          if (!inW(q)) continue;
          const t = slotAt(q);
          if (t === NO) continue;
          const v = unpack4(work[src + t]), media = unpack4(work[src + SC + t]), weight = unpack4(work[src + 2 * SC + t]);
          for (let i = 0; i < 4; i++) {
            const wv = f(P.w[tap][i]);
            sv[i] = f(sv[i] + f(wv * v[i])); m[i] = f(m[i] + f(f(P.w[tap][0]) * media[i])); d[i] = f(d[i] + f(wv * weight[i]));
          }
        }
        if (stage === 'blur') { work[dst + sl] = pack4(sv); work[dst + SC + sl] = pack4(m); work[dst + 2 * SC + sl] = pack4(d); }
        else {
          const o0 = sv.map((v, i) => f(f((d[i] >= f(0.02) ? 1 : 0) * v) / Math.max(d[i], f(0.02))));
          const o1 = m.map((v) => f(f((d[0] >= f(0.02) ? 1 : 0) * v) / Math.max(d[0], f(0.02))));
          work[C + sl] = pack2(o0.slice(0, 2)); work[C + SC + sl] = pack2(o0.slice(2)); work[C + 2 * SC + sl] = pack2(o1.slice(0, 2)); work[C + 3 * SC + sl] = pack2(o1.slice(2));
        }
      } else if (stage === 'boost0' || stage === 'boost') {
        const src = stage === 'boost0' ? C : P.axis === 1 ? A : B, dst = stage === 'boost0' || P.axis === 2 ? A : B;
        const acc = [0, 0, 0, 0], occ = [0, 0, 0, 0];
        for (let tap = -1; tap <= 1; tap++) {
          const q = p.map((v, i) => clamp(v + dir[i] * tap, 0, WORLD[i] - 1));
          const t = slotAt(q);
          if (t === NO) continue;
          const phi = stage === 'boost0' ? [...unpack2(work[C + t]), ...unpack2(work[C + SC + t])] : unpack4(work[src + t]);
          for (let i = 0; i < 4; i++) acc[i] = f(acc[i] + f((tap ? f(0.5 * f(1 - f(P.sm[i]))) : f(P.sm[i])) * phi[i]));
          if (stage === 'boost0') { const ch = chOf[Math.trunc(raw(q)[0])]; if (ch >= 0) occ[ch] = 1; }
          else { const o = unpack4(work[src + SC + t]); for (let i = 0; i < 4; i++) occ[i] = Math.max(occ[i], o[i]); }
        }
        work[dst + sl] = pack4(acc); work[dst + SC + sl] = pack4(occ);
      } else if (stage === 'peak' || stage === 'store') {
        if (!(w & F.FE.FINAL) || !inW(p)) continue;
        const phi = [...unpack2(work[C + sl]), ...unpack2(work[C + SC + sl])], med = [...unpack2(work[C + 2 * SC + sl]), ...unpack2(work[C + 3 * SC + sl])];
        let surf = phi.map(half), thin = null;
        if (stage === 'peak') {
          const peak = [0, 0, 0, 0];
          for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
            const q = [p[0] + x, p[1] + y, p[2] + z];
            if (!inW(q)) continue;
            const t = slotAt(q);
            if (t !== NO) { const a = unpack4(work[A + t]); for (let i = 0; i < 4; i++) peak[i] = Math.max(peak[i], a[i]); }
          }
          const occ = unpack4(work[A + SC + sl]);
          const k2 = peak.map((v, i) => Math.max(1, f(f(P.bulk[i]) / Math.max(v, f(THIN_MIN_PEAK)))));
          surf = phi.map((v, i) => half(f(v * (occ[i] >= 0.5 ? k2[i] : 1))));
          thin = k2.map((v, i) => { const t = clamp(f(f(v - f(THIN_MASK_LO)) / f(f(THIN_MASK_HI) - f(THIN_MASK_LO)))); return occ[i] >= 0.5 ? f(f(t * t) * f(3 - f(2 * t))) : 0; });
        }
        const unorm = (v) => roundEven(clamp(v) * 255);
        const o = bandTexel(p), guard = p[1] % rows === 0 ? [o[0], band0 + rows, o[2]] : null;
        for (const q of guard ? [o, guard] : [o]) {
          store(out(2), q, surf); store(out(3), q, med.map(unorm));
          if (thin) store(out(4), q, thin.map(unorm));
        }
      }
    }
  }
};

// the window path (tools/field-reference.mjs) with the EMA as the jobs ran it: a cell of a brick a
// job flagged EMA blends from its history (or starts at its target, FRESH); every other cell keeps
// its history (the window's settled bricks, which the EMA pass skips)
class WindowPath extends QuantizedFields {
  constructor(hist) { super({ bounds: { min: [0, 0, 0], max: WORLD }, raw, active: false, smoothing: 1 }); this.hist = hist; }
  stage(name, p) {
    if (name !== 'ema') return super.stage(name, p);
    const h = this.hist.get(p.join());
    const target = emaWords(raw(p), false, null);
    return h ? [h[0], h[1], target[2]] : target;
  }
}
const hist = new Map();   // cell → the window path's EMA words
const advanceHistory = (jobs) => {
  for (const j of jobs) {
    if (j.level.k) continue;
    for (const w of j.entries) {
      if (!(w & F.FE.EMA)) continue;
      const { b } = F.unpackEntry(w);
      for (let li = 0; li < 64; li++) {
        const p = [b[0] * 4 + (li & 3), b[1] * 4 + ((li >> 2) & 3), b[2] * 4 + (li >> 4)];
        if (p.some((v, i) => v >= WORLD[i])) continue;
        const prev = w & F.FE.FRESH ? null : hist.get(p.join()) ?? null;
        hist.set(p.join(), emaWords(raw(p), false, prev).slice(0, 2));
      }
    }
  }
};
const T0 = tex.get(fields.textures.tFS), TM = tex.get(fields.textures.tFM), TT = tex.get(fields.textures.tFT);
const at = (T, q) => T.data.subarray(4 * (q[0] + S * (q[1] + T.rows * q[2])), 4 * (q[0] + S * (q[1] + T.rows * q[2])) + 4);
let compared = 0;
function compareLevel0(what) {
  const L = fields.levels[0], ref = new WindowPath(hist), l0 = plan.levels[0];
  let n = 0, worst = 0, cells = 0;
  for (let z = L.valid.lo[2] * 4; z < L.valid.hi[2] * 4; z++) for (let y = L.valid.lo[1] * 4; y < L.valid.hi[1] * 4; y++) for (let x = L.valid.lo[0] * 4; x < L.valid.hi[0] * 4; x++) {
    const p = [x, y, z];
    if (p.some((v, i) => v >= WORLD[i])) continue;
    const r = ref.stage('peak', p), q = [x % S, l0.band + (y % l0.rows), z % S];
    cells++;
    const s = at(T0, q), m = at(TM, q), t = at(TT, q);
    for (let i = 0; i < 4; i++) {
      if (s[i] !== r[i]) { if (n < 5) fail(`${what}: surf ${p} ch ${i}: ${unhalf(s[i])} vs window ${unhalf(r[i])}`); n++; }
      if (m[i] !== roundEven(clamp(unhalf(r[4 + i])) * 255)) { if (n < 5) fail(`${what}: media ${p} ch ${i}: ${m[i]} vs ${unhalf(r[4 + i])}`); n++; }
      worst = Math.max(worst, Math.abs(t[i] - roundEven(clamp(unhalf(r[8 + i])) * 255)));
    }
    if (y % l0.rows === 0) {
      const gq = [q[0], l0.band + l0.rows, q[2]];
      if (at(T0, gq).some((v, i) => v !== s[i])) { if (n < 5) fail(`${what}: guard row of ${p} differs`); n++; }
    }
  }
  if (worst > 1) fail(`${what}: thin mask off by ${worst} LSB`);
  if (n) fail(`${what}: ${n} texel channels differ from the window path`);
  compared += cells;
  return n;
}

// the load
let cam = [18, 10, 20];
const frames0 = fields.prime(gpu.frame, cam);
// (prime's jobs started every cell at its target: the window path's history is the targets)
for (let z = 0; z < WORLD[2]; z++) for (let y = 0; y < WORLD[1]; y++) for (let x = 0; x < WORLD[0]; x++) hist.set(`${x},${y},${z}`, emaWords(raw([x, y, z]), false, null).slice(0, 2));
compareLevel0('load');
console.log(`twin: loaded in ${frames0} frames (${fields.stats.jobs} jobs, ${fields.stats.bricks} bricks); level 0 valid ${JSON.stringify(fields.levels[0].valid)}`);

// a flat floor's surface sits at the same height at level 0 and level 1 (the coarse level is the
// prefiltered field, not a different surface): rock to y = 6 under (6, 6) .. (10, 10)
{
  const crossing = (T, l, x, z) => {
    const col = []; for (let y = 0; y < Math.ceil(WORLD[1] / l.s); y++) col.push(unhalf(at(T, [Math.floor(x / l.s) % S, l.band + (y % l.rows), Math.floor(z / l.s) % S])[3]));
    for (let y = 0; y + 1 < col.length; y++) if (col[y] >= 0.5 && col[y + 1] < 0.5) return (y + 0.5 + (col[y] - 0.5) / (col[y] - col[y + 1])) * l.s;
    return NaN;
  };
  const [l0, l1] = plan.levels;
  const h0 = crossing(T0, l0, 9, 9), h1 = crossing(T0, l1, 9, 9);
  check(Math.abs(h0 - 6) < 0.3 && Math.abs(h1 - h0) < 0.75, `floor: level 0 at ${h0}, level 1 at ${h1} (rock to 6)`);
  console.log(`twin: a flat floor's surface: level 0 at ${h0.toFixed(3)}, level 1 at ${h1.toFixed(3)} cells`);
}

// scrolls: the camera walks 8 cells along +x (two level-0 bricks), climbs 10 (level 0's band
// wraps vertically: 16 rows of a 24-cell world), then goes back diagonally: each time only the slab
// that came in is written, at its toroidal place (and its guard row), and level 0 is the window path
for (const move of [[8, 0, 0], [0, 10, 0], [-6, -3, -9], [-8, -9, 19]]) {
  const L = fields.levels[0], before = structuredClone(L.valid), l0 = plan.levels[0];
  written = new Set();
  cam = cam.map((v, i) => v + move[i]);
  let frames = 0;
  do { const jobs = fields.update(gpu.frame, cam, []); advanceHistory(jobs); frames++; } while (!fields.levels.every((x) => x.complete) && frames < 50);
  const expect = new Set();
  for (let z = L.valid.lo[2] * 4; z < L.valid.hi[2] * 4; z++) for (let y = L.valid.lo[1] * 4; y < L.valid.hi[1] * 4; y++) for (let x = L.valid.lo[0] * 4; x < L.valid.hi[0] * 4; x++) {
    const b = [x >> 2, y >> 2, z >> 2];
    if (boxHas(before, b) || [x, y, z].some((v, i) => v >= WORLD[i])) continue;
    expect.add(`tFS:${[x % S, l0.band + (y % l0.rows), z % S]}`);
    if (y % l0.rows === 0) expect.add(`tFS:${[x % S, l0.band + l0.rows, z % S]}`);
  }
  const got = new Set([...written].filter((k) => k.startsWith('tFS:') && +k.split(',')[1] <= l0.band + l0.rows));
  const extra = [...got].filter((k) => !expect.has(k)), missing = [...expect].filter((k) => !got.has(k));
  check(!extra.length && !missing.length, `scroll ${move}: ${extra.length} texels written outside the slab (${extra.slice(0, 3)}), ${missing.length} of it not written (${missing.slice(0, 3)})`);
  console.log(`twin: moved ${move} in ${frames} frame(s): ${got.size} level-0 texels rewritten, the slab exactly; valid ${JSON.stringify(before)} → ${JSON.stringify(L.valid)}`);
  compareLevel0(`after moving ${move}`);
}

// a change: the pond's water moves a cell along x for a few frames, then rests; every frame,
// level 0 equals the window path with the EMA the jobs ran, and nothing outside the change's
// reach is written
{
  const L = fields.levels[0];
  const water = [];
  for (let z = 0; z < WORLD[2]; z++) for (let x = 0; x < WORLD[0]; x++) for (let y = 0; y < WORLD[1]; y++) if (wcUnword(words[cellIndex([x, y, z])]).id === E.WATER) water.push([x, y, z]);
  for (let fr = 0; fr < FIELD_EMA_SETTLE + 4; fr++) {
    let box = null;
    if (fr < 3) {
      for (const c of water) set(c, E.EMPTY);
      for (const c of water) c[0] += 1;
      for (const c of water) set(c, E.WATER);
      const lo = [0, 1, 2].map((i) => Math.min(...water.map((c) => c[i])) - 1), hi = [0, 1, 2].map((i) => Math.max(...water.map((c) => c[i])) + 1);
      box = { lo, hi };
    }
    written = new Set();
    const jobs = fields.update(gpu.frame, cam, box ? [box] : []);
    advanceHistory(jobs);
    const ema = jobs.filter((j) => !j.level.k).flatMap((j) => [...j.entries].filter((w) => w & F.FE.EMA && !(w & F.FE.FRESH)));
    if (fr >= FIELD_EMA_SETTLE + 3) check(!ema.length, `change: the EMA still runs ${fr} frames on (${ema.length} bricks)`);
    if (fr < 3) check(ema.length > 0, `change: frame ${fr} ran no EMA (the pond outside level 0?)`);
    for (const k of written) {
      if (!k.startsWith('tFS:')) continue;
      const [x, y, z] = k.slice(4).split(',').map(Number);
      if (y >= plan.levels[0].band + plan.levels[0].rows + 1) continue;   // (coarse bands)
      const near = water.some((c) => Math.abs((c[0] % S) - x) <= 12 && Math.abs((c[2] % S) - z) <= 12);
      if (!near) { fail(`change: frame ${fr} wrote level-0 texel ${x},${y},${z} far from the water`); break; }
    }
    if (compareLevel0(`change frame ${fr}`)) break;
  }
  console.log(`twin: the pond moved 3 frames and settled (${FIELD_EMA_SETTLE} EMA frames): level 0 matched the window path every frame`);
}

const mem = fields.memory();
const real = new WorldFields(gpu, { layout: gpu.layout('WC', []), bindGroup: {}, size: [1024, 128, 1024] }, { copyWGSL: worldCopyStubWGSL });
const big = real.memory();
console.log(`memory at 1024×128×1024: textures ${(big.textures / 2 ** 20).toFixed(1)} MiB, book ${(big.book / 2 ** 20).toFixed(2)} MiB, work ${(big.work / 2 ** 20).toFixed(1)} MiB, total ${(big.total / 2 ** 20).toFixed(1)} MiB (twin ${(mem.total / 2 ** 20).toFixed(2)} MiB)`);
console.log(`twin: ${compared} level-0 cells compared with the window path, bit for bit (surface, media; thin within 1 LSB)`);
console.log(bad ? `world-fields-cpu-check: ${bad} failures` : 'world-fields-cpu-check: ok');
process.exit(bad ? 1 : 0);

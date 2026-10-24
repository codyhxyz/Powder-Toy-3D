// The writers of the world's light (shaders/world/light.js holds the readers and the layout):
//   shadowTraceFrag   a workgroup per shadow tile of the frame's list, a thread per texel: the
//                     texel's ray from above the world toward the ground through the world copy
//                     (shadowOptics.js's optical walk: opaque depth, translucent stretch, tint id and
//                     optical depth), then the tile's tag
//   probeUpdateFrag   a workgroup per probe of the frame's chunks, a thread per ray (PROBE.RAYS):
//                     light arriving from every direction, L1 SH, blended into the probe's history
//   probePublishFrag  a workgroup per chunk: the history's halves into the four band textures (and
//                     their guard texels), then the chunk's tag
//   glowSeedFrag, glowBlurFrag(axis), glowFinalFrag: a glow job's seeds (emission per texel) over
//                     its chunk grown by GLOW.REACH, the separable blur, the texture and the tag
// Every list is written by src/gfx/worldLight.js under its fixed per-frame budget. Writer group 2
// holds F's entries (0-7: the fields, for smooth surfaces and media), the readers' entries that
// kernel only reads (light.js LIGHT_BINDINGS), 17 linearClamp and the writer's own (21-27).
import { SHADOW, PROBE, GLOW, TAGS, SHADOW_TEXELS, LightUniforms, LIGHT_BINDINGS, lightDeclsWGSL, worldLightWGSL, clipTexSize } from './light.js';
import { uniformStruct } from '../../gpu/params.js';
import { STAGE } from '../common.js';
import { glf } from '../../glsl.js';

export const LW = Object.freeze({ A: 21, B: 22, JOBS: 23, TEX: 24, REPEAT: 28 });   // writer bindings (TEX..TEX+3: the bands)
export const MAX_JOBS = 256;
// The shadow writer's list: the bases it traces in (targets 0..CASCADES-1 the cascades, CASCADES the
// spare a sun turn fills), the world's centre and depth reference, and per job (tile i, j, target, slot).
export const ShadowJobs = uniformStruct('ShadowJobs', {
  count: 'u32',
  u: ['vec4f', SHADOW.CASCADES + 1], v: ['vec4f', SHADOW.CASCADES + 1], s: ['vec4f', SHADOW.CASCADES + 1],
  centre: 'vec4f', jobs: ['vec4i', MAX_JOBS],
});
// Probe and glow lists: per job (chunk lattice x, y, z, level | FIRST if the chunk just came into
// range: its history is another place's), the rays' rotation this frame (probes).
export const JOB_FIRST = 256;
export const ClipJobs = uniformStruct('ClipJobs', { count: 'u32', blend: 'f32', rot: 'mat3x3f', jobs: ['vec4i', MAX_JOBS] });

const W = (b) => ({ binding: b, visibility: STAGE.COMPUTE });
const storage = (b, write) => ({ ...W(b), buffer: { type: write ? 'storage' : 'read-only-storage' } });
const uniform = (b) => ({ ...W(b), buffer: { type: 'uniform' } });
const store3d = (b) => ({ ...W(b), storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } });
const readerEntries = (keep) => LIGHT_BINDINGS.filter(([n]) => keep.includes(n)).map(([binding, , , body]) => ({ binding, ...body, visibility: STAGE.COMPUTE }));
const sampler17 = { ...W(17), sampler: { type: 'filtering' } };
const noise16 = { ...W(16), texture: { sampleType: 'float', viewDimension: '3d' } };
const repeat = { ...W(LW.REPEAT), sampler: { type: 'filtering' } };
/** Writer group 2 layouts, without F's 0-7 (src/gfx/worldLight.js prepends F's layout entries where fields: true). */
export const WRITER_LAYOUT = {
  shadow: [...readerEntries([14]), storage(LW.B, true), uniform(LW.JOBS)],
  probeUpdate: [...readerEntries([8, 9, 10, 11, 12, 14, 15]), noise16, sampler17, repeat, storage(LW.A, true), uniform(LW.JOBS)],
  probePublish: [storage(LW.A, false), storage(LW.B, true), uniform(LW.JOBS), ...[0, 1, 2, 3].map((k) => store3d(LW.TEX + k))],
  glowWork: [storage(LW.A, true), uniform(LW.JOBS)],
  glowFinal: [storage(LW.A, false), storage(LW.B, true), uniform(LW.JOBS), store3d(LW.TEX)],
};
const jobsDecl = (S) => `${S.wgsl}\n@group(2) @binding(${LW.JOBS}) var<uniform> J: ${S.name};`;

// ---- the shadow trace ----
/**
 * fields: smooth surfaces where their field is inside and media by their field (F's surfSample,
 * mediaField: needs F's WGSL and group 2 entries 0-7); false: by their cells (the CPU twin's model,
 * tools/world-light-cpu-check.mjs). The march's assembly comes before: prelude(g, { state: false }),
 * frame, materials, noise, glslMod, W's worldCopyWGSL (and F's, with fields).
 */
export const shadowTraceFrag = ({ fields = true } = {}) => /* wgsl */ `
${worldLightWGSL({ shadow: false, probes: false, glow: false, fields, writerFrame: true, sky: false })}
${lightDeclsWGSL({ skip: LIGHT_BINDINGS.map(([n]) => n).filter((n) => n !== 14) })}
${jobsDecl(ShadowJobs)}
// lcBuf as words: a tag's u32 alone (a vec4u component store may be a whole-vector read-modify-write,
// racing the workgroups of the neighbouring tiles: measured, tools/world-light-gpu-check.mjs)
@group(2) @binding(${LW.B}) var<storage, read_write> lcOut: array<u32>;   // lcBuf: the texels, then the tags
const SHADOW_TAU_MAX: f32 = SHADOW_TINT_ID_SCALE - 1.0;
const SHADOW_NO_HIT: f32 = 1e5;
const SHADOW_MEDIA_MIN_K: f32 = 1e-4;
const SH_STEPS: i32 = ${SHADOW.MAX_STEPS};
// LC is bound for the world's size (lcInWorld, lcWorldHit); the bases come in J (a spare's isn't in LC).
// The texel's ray (ro, rd): (opaque depth, translucent start, end, tint id · scale + optical depth).
fn shadowTexelWorld(ro: vec3f, rd: vec3f) -> vec4f {
  var oC = vec4f(SHADOW_NO_HIT, SHADOW_NO_HIT, SHADOW_NO_HIT, 0.0);
  let inv = 1.0 / rd;
  let wh = lcWorldHit(ro, inv);
  var t = max(wh.x, 0.0);
  var tid = 0;
  var lid = E_WATER;
  var tau = 0.0;
  var hit = false;
  var steps = SH_STEPS;
  if (wh.y > t) {
    loop {
      let h = lcNext(ro, rd, inv, t, wh.y, ${fields}, &steps);
      if (!h.ok) { break; }
      let id = wcId(h.w);
      let tE = h.t;
      let tX = h.tOut;
      t = tX;
      if (lcIsCrisp(id)) {
        let rc = RCLASS(id);
        if (rc != R_GLASS && id != E_CRYSTAL) { oC.x = tE; hit = true; break; }
        // glass, and crystal by its cell (Intentional (world light): the prism's chord is the march's,
        // gfx/crystal.js, which reads the physics window; its cell is within a cell of it)
        if (tid == 0 || RCLASS(tid) == R_GAS) { if (tid == 0) { oC.y = tE; } tid = id; }
        tau += meanSigma(id) * (tX - tE);
        oC.z = tX;
        continue;
      }${fields ? /* wgsl */ `
      // a smooth surface or a medium by its field (shadowOptics.js): the opaque channels' root
      // between the cell's ends and middle, the liquid's path length by the trapezoid
      let tM = 0.5 * (tE + tX);
      let pA = surfSample(ro + rd * tE);
      let pM = surfSample(ro + rd * tM);
      let pB = surfSample(ro + rd * tX);
      let oA = max(pA.y, max(pA.z, pA.w));
      let oM = max(pM.y, max(pM.z, pM.w));
      let oB = max(pB.y, max(pB.z, pB.w));
      var tOp = SHADOW_NO_HIT;
      if (oA >= LC_SURF_ISO) { tOp = tE; }
      else if (oM >= LC_SURF_ISO) { tOp = tE + (tM - tE) * (LC_SURF_ISO - oA) / max(oM - oA, 1e-6); }
      else if (oB >= LC_SURF_ISO) { tOp = tM + (tX - tM) * (LC_SURF_ISO - oM) / max(oB - oM, 1e-6); }
      let tEnd = min(tOp, tX);
      let inL = step(vec3f(LC_SURF_ISO), vec3f(pA.x, pM.x, pB.x));
      let lenL = 0.5 * ((inL.x + inL.y) * (tM - tE) + (inL.y + inL.z) * (tX - tM));
      if (lenL > 0.0) {
        if (RCLASS(id) == R_LIQUID) { lid = id; }
        if (tid == 0 || RCLASS(tid) == R_GAS) { if (tid == 0) { oC.y = tE; } tid = lid; }
        tau += meanSigma(lid) * lenL * (tEnd - tE) / max(tX - tE, 1e-6);
        oC.z = tEnd;
      }
      if ((wcInfo(h.c >> vec3u(2u)) & ${1 /* BRICK_INFO.MEDIA */}u) != 0u) {
        let m = mediaField(ro + rd * (0.5 * (tE + tEnd)));
        let dm = max(m.xy - MEDIA_FLOOR, vec2f(0.0)) * (1.0 / (1.0 - MEDIA_FLOOR));
        let k = dot(MD_EXT.xy * (1.0 - MD_ALBEDO.xy * MD_G.xy), dm);
        if (k > SHADOW_MEDIA_MIN_K) {
          if (tid == 0) { oC.y = tE; tid = select(E_STEAM, E_SMOKE, m.x > m.y); }
          tau += k * (tEnd - tE);
          oC.z = tEnd;
        }
      }
      if (tOp < SHADOW_NO_HIT) { oC.x = tOp; hit = true; break; }` : /* wgsl */ `
      // by cells: a liquid's fill of the cell's length tints, gas casts nothing, the rest blocks
      let rc = RCLASS(id);
      if (rc == R_LIQUID) {
        if (tid == 0 || RCLASS(tid) == R_GAS) { if (tid == 0) { oC.y = tE; } tid = id; }
        tau += meanSigma(id) * (tX - tE) * wcAux(h.w);
        oC.z = tX;
      } else if (rc != R_GAS && !isGasLike(id)) { oC.x = tE; hit = true; break; }`}
    }
  }
  if (!hit && rd.y < 0.0) { oC.x = ro.y / -rd.y; }   // the floor under the world
  oC.w = f32(tid) * SHADOW_TINT_ID_SCALE + min(tau, SHADOW_TAU_MAX);
  return oC;
}
@compute @workgroup_size(${SHADOW.TILE}, ${SHADOW.TILE}) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32, @builtin(local_invocation_id) lid: vec3u) {
  let jn = wg.x + wg.y * ${MAX_JOBS / 16}u;
  if (jn >= J.count) { return; }
  let job = J.jobs[jn];
  let tgt = u32(job.z);
  let slot = u32(job.w);
  let ij = job.xy * SH_TILE + vec2i(lid.xy);
  let a = (vec2f(ij) + 0.5) * J.u[tgt].w;
  let s = J.s[tgt].xyz;
  let ro = J.centre.xyz + s * J.centre.w + J.u[tgt].xyz * a.x + J.v[tgt].xyz * a.y;
  let w = lcWrap2(ij, SH_RES);
  let texel = bitcast<vec4u>(shadowTexelWorld(ro, lcSafeDir(-s)));
  let at = (slot * u32(SH_RES * SH_RES) + u32(w.x + SH_RES * w.y)) * 4u;
  for (var c = 0u; c < 4u; c++) { lcOut[at + c] = texel[c]; }
  if (li == 0u) { lcOut[LC_TAGS_AT * 4u + shTagIndex(slot, job.xy)] = lcTag(vec3i(job.xy, i32(J.s[tgt].w))); }
}
`;
// Its dispatch for n jobs: [16, ceil(n / 16)] workgroups (a job a workgroup, 16 a row).
export const shadowTraceDispatch = (n) => [Math.min(n, MAX_JOBS / 16), Math.ceil(n / (MAX_JOBS / 16)), 1];

// ---- the probes ----
const probeIndexWGSL = /* wgsl */ `
// probe lattice point L of level k: its history's first word pair (four bands, a vec2u each)
fn prHist(k: u32, L: vec3i) -> u32 {
  let w = lcWrap(L, PR_N);
  return (k * u32(PR_N * PR_N * PR_N) + u32(w.x + PR_N * (w.y + PR_N * w.z))) * 4u;
}
fn prLocal(i: u32) -> vec3i { return vec3i(i32(i % ${PROBE.CHUNK}u), i32((i / ${PROBE.CHUNK}u) % ${PROBE.CHUNK}u), i32(i / ${PROBE.CHUNK * PROBE.CHUNK}u)); }`;
const HALF_MAX = 65504;
/** A probe's update: PROBE.RAYS rays a workgroup, reduced to L1 SH and blended into its history. */
export const probeUpdateFrag = ({ fields = true } = {}) => /* wgsl */ `
${worldLightWGSL({ fields, caustics: false, writerFrame: true, repeatSampler: 'lwRepeat' })}
${lightDeclsWGSL()}
@group(2) @binding(16) var tMediaNoise: texture_3d<f32>;   // the clouds' deck (gfx/mediaNoise.js)
@group(2) @binding(17) var linearClamp: sampler;
@group(2) @binding(${LW.REPEAT}) var lwRepeat: sampler;
${jobsDecl(ClipJobs)}
@group(2) @binding(${LW.A}) var<storage, read_write> hist: array<vec2u>;
${probeIndexWGSL}
const PR_RAYS: u32 = ${PROBE.RAYS}u;
const PR_STEPS: i32 = ${PROBE.MAX_STEPS};
const PR_RANGE: vec2f = vec2f(${PROBE.RANGE.map(glf).join(', ')});
const PR_HIT_LIFT: f32 = 0.5;          // cells off a hit face its light is looked up at
const PR_HALF_MAX: f32 = ${glf(HALF_MAX)};
const GOLDEN: f32 = ${glf(Math.PI * (3 - Math.sqrt(5)))};
var<workgroup> wsum: array<array<vec4f, 4>, ${PROBE.RAYS}>;
// Ray i of n: spherical Fibonacci (an even spread), turned by this frame's rotation (DDGI's).
fn prDir(i: u32) -> vec3f {
  let y = 1.0 - (f32(i) + 0.5) * 2.0 / f32(PR_RAYS);
  let r = sqrt(max(1.0 - y * y, 0.0));
  let a = f32(i) * GOLDEN;
  return normalize(J.rot * vec3f(r * cos(a), y, r * sin(a)));
}
// The light arriving at ro from direction rd: (radiance, sky visibility).
fn prTrace(k: u32, ro: vec3f, rd0: vec3f) -> vec4f {
  let rd = lcSafeDir(rd0);
  let inv = 1.0 / rd;
  let range = select(1e9, PR_RANGE[min(k, 1u)], k + 1u < PR_LEVELS);
  let wh = lcWorldHit(ro, inv);
  var t = max(wh.x, 0.0);
  let tEnd = min(range, max(wh.y, t));
  var thr = vec3f(1.0);    // what translucent matter on the way lets through
  var steps = PR_STEPS;
  loop {
    if (t >= tEnd) { break; }
    let h = lcNext(ro, rd, inv, t, tEnd, false, &steps);
    if (!h.ok) { break; }
    t = h.tOut;
    let id = wcId(h.w);
    if (isGasLike(id)) { continue; }
    let rc = RCLASS(id);
    if (rc == R_GLASS || rc == R_LIQUID) { thr *= exp(-SIGMA(id) * (h.tOut - h.t)); continue; }
    // opaque: what its face sends back (hitLight's model: sun, glow, the probes' bounce, its own light)
    let n = lcEntryNormal(rd, h.ax);
    let hp = ro + rd * h.t + n * PR_HIT_LIFT;
    let a = wcA(h.c);
    var sun = vec3f(0.0);
    let ndl = max(dot(n, FU.sun), 0.0);
    if (ndl > 0.0) { sun = FU.sunCol * ndl * select(vec3f(1.0), sunShadowAt(hp), FU.shadows != 0u); }
    let bounce = giIrradiance(probeAt(hp), n);
    let L = ALBEDO(id) * (sun + bounce + sampleLight(hp) * FU.lightGain) + cellEmission(id, a.y, floor(a.w)) + sparkEmit(id, floor(a.w));
    return vec4f(thr * L, 0.0);
  }
  if (t < wh.y - LC_EPS && k + 1u < PR_LEVELS && steps > 0) {
    // past this level's range: the next level's light from here on, in this direction
    let e = ro + rd * tEnd;
    var q: vec3f;
    var g = lcOpenProbe();
    if (prInside(k + 1u, e, &q) > 0.0) { g = prAt(k + 1u, q); }
    let a = clamp(SH_Y0 * g.c0.a + SH_Y1 * (g.cx.a * rd.x + g.cy.a * rd.y + g.cz.a * rd.z), 0.0, 1.0);
    return vec4f(thr * giRadiance(g, rd, 0.0), dot(thr, vec3f(1.0 / 3.0)) * a);
  }
  // out of the world: the sky above, the sunlit ground below (shaders/gi.js giGroundLightWGSL)
  if (rd.y > 0.0) { return vec4f(thr * skyRadiance(rd), dot(thr, vec3f(1.0 / 3.0))); }
  return vec4f(thr * GROUND_ALB * (FU.sunCol * max(FU.sun.y, 0.0) + FU.skyUp), 0.0);
}
fn half4(v: vec4f) -> vec2u {
  let c = clamp(v, vec4f(-PR_HALF_MAX), vec4f(PR_HALF_MAX));
  return vec2u(pack2x16float(c.xy), pack2x16float(c.zw));
}
fn unhalf4(w: vec2u) -> vec4f { return vec4f(unpack2x16float(w.x), unpack2x16float(w.y)); }
@compute @workgroup_size(${PROBE.RAYS}) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let jn = wg.y;
  if (jn >= J.count) { return; }   // uniform per workgroup
  let job = J.jobs[jn];
  let k = u32(job.w) & 255u;
  let first = (u32(job.w) & ${JOB_FIRST}u) != 0u;
  let L = job.xyz * PR_CHUNK + prLocal(wg.x);
  let S = f32(LC.prO[k].w);
  let P = (vec3f(L) + 0.5) * S;
  let d = prDir(li);
  let r = prTrace(k, P, d) * (4.0 * PI_L / f32(PR_RAYS));
  wsum[li] = array<vec4f, 4>(r * SH_Y0, r * (SH_Y1 * d.x), r * (SH_Y1 * d.y), r * (SH_Y1 * d.z));
  workgroupBarrier();
  for (var w = PR_RAYS / 2u; w > 0u; w >>= 1u) {
    if (li < w) {
      for (var b = 0; b < 4; b++) { wsum[li][b] += wsum[li + w][b]; }
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    let h = prHist(k, L);
    let blend = select(J.blend, 1.0, first);
    for (var b = 0u; b < 4u; b++) {
      hist[h + b] = half4(mix(unhalf4(hist[h + b]), wsum[0][b], blend));
    }
  }
}
`;
// a workgroup per probe of a chunk (x) and per job (y)
export const probeUpdateDispatch = (n) => [PROBE.CHUNK ** 3, n, 1];

/** The history into the band textures (with the guards) and the chunk's tag. A workgroup a chunk. */
export const probePublishFrag = () => /* wgsl */ `
${jobsDecl(ClipJobs)}
@group(2) @binding(${LW.A}) var<storage, read> hist: array<vec2u>;
@group(2) @binding(${LW.B}) var<storage, read_write> lcOut: array<u32>;   // lcBuf as words: its tags (past the texels), one u32 each
const LC_TAGS_AT: u32 = ${SHADOW_TEXELS}u;
fn putTag(w: u32, t: u32) { lcOut[LC_TAGS_AT * 4u + w] = t; }
${[0, 1, 2, 3].map((k) => `@group(2) @binding(${LW.TEX + k}) var band${k}: texture_storage_3d<rgba16float, write>;`).join('\n')}
const PR_N: i32 = ${PROBE.N};
const PR_CHUNK: i32 = ${PROBE.CHUNK};
const PR_CHUNKS: i32 = ${PROBE.N / PROBE.CHUNK};
const TAG_PROBE: u32 = ${TAGS.PROBE}u;
fn lcWrap(a: vec3i, n: i32) -> vec3i { return ((a % n) + n) % n; }
fn lcTag(c: vec3i) -> u32 { let m = vec3u(c) & vec3u(1023u); return 0x80000000u | m.x | (m.y << 10u) | (m.z << 20u); }
${probeIndexWGSL}
fn put(t: u32, x: vec3i, v: vec4f) {
  switch t {
    case 0u: { textureStore(band0, x, v); }
    case 1u: { textureStore(band1, x, v); }
    case 2u: { textureStore(band2, x, v); }
    default: { textureStore(band3, x, v); }
  }
}
@compute @workgroup_size(${PROBE.CHUNK ** 3}) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  if (wg.x >= J.count) { return; }
  let job = J.jobs[wg.x];
  let k = u32(job.w) & 255u;
  let L = job.xyz * PR_CHUNK + prLocal(li);
  let w = lcWrap(L, PR_N);
  let h = prHist(k, L);
  let base = vec3i(i32(k) * (PR_N + 1), 0, 0);
  for (var b = 0u; b < 4u; b++) {
    let v = vec4f(unpack2x16float(hist[h + b].x), unpack2x16float(hist[h + b].y));
    // the texel and, where it is the first of its axis, the guard past the level's end that copies it
    for (var g = 0; g < 8; g++) {
      let gm = vec3i(g & 1, (g >> 1u) & 1, (g >> 2u) & 1);
      if (any((gm == vec3i(1)) & (w != vec3i(0)))) { continue; }
      put(b, base + w + gm * PR_N, v);
    }
  }
  if (li == 0u) {
    let wc = lcWrap(job.xyz, PR_CHUNKS);
    putTag(TAG_PROBE + k * u32(PR_CHUNKS * PR_CHUNKS * PR_CHUNKS) + u32(wc.x + PR_CHUNKS * (wc.y + PR_CHUNKS * wc.z)), lcTag(job.xyz));
  }
}
`;
export const probePublishDispatch = (n) => [n, 1, 1];

// ---- the glow ----
const G = GLOW.CHUNK + 2 * GLOW.REACH;   // texels a side of a job's seeds
export const GLOW_SCRATCH = G ** 3 + GLOW.CHUNK * G * G + GLOW.CHUNK * GLOW.CHUNK * G;   // vec4fs a job
// the blur's two 5-tap passes an axis (shaders/passes.js glowBlurWeightsWGSL) as one 9-tap kernel,
// with both passes' gain: the same light as the old six passes over the brick grid
const W5 = [0.10, 0.22, 0.36, 0.22, 0.10];
const LIGHT_BLUR_GAIN = 1.15;
export const GLOW_W9 = Array.from({ length: 9 }, (_, i) => W5.reduce((s, a, j) => s + (i - j >= 0 && i - j < 5 ? a * W5[i - j] : 0), 0) * LIGHT_BLUR_GAIN ** 2);
const glowCommonWGSL = /* wgsl */ `
${jobsDecl(ClipJobs)}
const GL_G: i32 = ${G};
const GL_CHUNK_: i32 = ${GLOW.CHUNK};
const GL_REACH: i32 = ${GLOW.REACH};
const GL_SCRATCH: u32 = ${GLOW_SCRATCH}u;
const GL_X_AT: u32 = ${G ** 3}u;
const GL_Y_AT: u32 = ${G ** 3 + GLOW.CHUNK * G * G}u;
var<private> GW9: array<f32, 9> = array<f32, 9>(${GLOW_W9.map(glf).join(', ')});
// thread i of a region of size s: its local coordinates
fn glLocal(i: u32, s: vec3i) -> vec3i { let n = i32(i); return vec3i(n % s.x, (n / s.x) % s.y, n / (s.x * s.y)); }
fn glIdx(l: vec3i, s: vec3i) -> u32 { return u32(l.x + s.x * (l.y + s.y * l.z)); }`;
/** A job's seeds: the mean emission of each texel's cells (level 0 every cell of the brick, level 1 one a brick). */
export const glowSeedFrag = () => /* wgsl */ `
${glowCommonWGSL}
@group(2) @binding(${LW.A}) var<storage, read_write> scr: array<vec4f>;
const FIRE_GLOW_BASE: f32 = 0.6;
const FIRE_GLOW_T: f32 = 1500.0;
const FIRE_GLOW_GAIN: f32 = 1.5;
const GLOW_FACE_GAIN: f32 = 4.0;   // a brick's depth in cells (passes.js GLOW_FACE_GAIN = BS)
const GL_SPACING: vec2i = vec2i(${GLOW.SPACING.join(', ')});
fn glIn(c: vec3i) -> bool { return all(c >= vec3i(0)) && all(c < WC.size); }
fn glOpenFaces(c: vec3i) -> f32 {
  var n = 0.0;
  for (var k = 0; k < 6; k++) {
    var q = c;
    q[k >> 1u] += select(1, -1, (k & 1) == 0);
    if (q.y < 0) { continue; }
    if (!glIn(q)) { n += 1.0; continue; }
    let id = wcId(wcCell(q));
    if (RCLASS(id) != R_OPAQUE && id != E_CRYSTAL) { n += 1.0; }
  }
  return n;
}
// shaders/passes.js brickFrag's emission, a cell of the world copy
fn glEmit(c: vec3i) -> vec3f {
  let a = wcA(c);
  let id = eid(a);
  if (id == E_FIRE || id == E_PLASMA) { return blackbody(a.y) * (FIRE_GLOW_BASE + a.y / FIRE_GLOW_T) * FIRE_GLOW_GAIN; }
  if (isGasLike(id) || !(a.y > INCAND_T0 || luminous(id) || sparkLive(id, floor(a.w)) || lampLit(id, floor(a.w)))) { return vec3f(0.0); }
  let ce = cellEmission(id, a.y, floor(a.w)) * SHED(id) + sparkEmit(id, floor(a.w)) * select(1.0, LAMP_ROOM_GAIN, id == E_LAMP);
  if (dot(ce, ce) <= 0.0) { return vec3f(0.0); }
  if (RCLASS(id) == R_OPAQUE || id == E_CRYSTAL) { return ce * glOpenFaces(c) * GLOW_FACE_GAIN; }
  return ce;
}
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  if (wg.y >= J.count) { return; }
  let i = wg.x * 64u + li;
  if (i >= u32(GL_G * GL_G * GL_G)) { return; }
  let job = J.jobs[wg.y];
  let k = u32(job.w) & 255u;
  let T = job.xyz * GL_CHUNK_ - GL_REACH + glLocal(i, vec3i(GL_G));
  let S = GL_SPACING[k];
  let c0 = T * S;
  var e = vec3f(0.0);
  if (k == 0u) {
    if (wcOccupied(0u, c0)) {
      for (var j = 0; j < 64; j++) { e += glEmit(c0 + vec3i(j & 3, (j >> 2u) & 3, j >> 4u)); }
      e /= 64.0;
    }
  } else if (wcOccupied(1u, c0)) {
    // one cell a brick, its middle (Intentional (world light): the far glow is a coarse estimate)
    let nb = S / 4;
    for (var j = 0; j < nb * nb * nb; j++) {
      let b = vec3i(j % nb, (j / nb) % nb, j / (nb * nb));
      let c = c0 + b * 4 + 2;
      if (wcOccupied(0u, c)) { e += glEmit(c); }
    }
    e /= f32(nb * nb * nb);
  }
  scr[wg.y * GL_SCRATCH + i] = vec4f(e, 0.0);
}
`;
export const glowSeedDispatch = (n) => [Math.ceil(G ** 3 / 64), n, 1];
/** A blur pass along axis 0 (x: seeds → X, its region CHUNK × G × G) or 1 (y: X → Y, CHUNK × CHUNK × G). */
export const glowBlurFrag = (axis) => {
  const src = axis === 0 ? [G, G, G] : [GLOW.CHUNK, G, G];
  const dst = axis === 0 ? [GLOW.CHUNK, G, G] : [GLOW.CHUNK, GLOW.CHUNK, G];
  const off = (v) => (axis === 0 ? `vec3i(${v}, 0, 0)` : `vec3i(0, ${v}, 0)`);
  return /* wgsl */ `
${glowCommonWGSL}
@group(2) @binding(${LW.A}) var<storage, read_write> scr: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  if (wg.y >= J.count) { return; }
  let i = wg.x * 64u + li;
  let ds = vec3i(${dst.join(', ')});
  if (i >= u32(ds.x * ds.y * ds.z)) { return; }
  let l = glLocal(i, ds);
  let base = wg.y * GL_SCRATCH;
  var s = vec4f(0.0);
  for (var k = 0; k < 9; k++) {
    // the source region starts GL_REACH earlier along this axis
    let q = l + ${off('k')};
    s += scr[base + ${axis === 0 ? '0u' : 'GL_X_AT'} + glIdx(q, vec3i(${src.join(', ')}))] * GW9[k];
  }
  scr[base + ${axis === 0 ? 'GL_X_AT' : 'GL_Y_AT'} + i] = s;
}
`;
};
export const glowBlurDispatch = (axis, n) => [Math.ceil((axis === 0 ? GLOW.CHUNK * G * G : GLOW.CHUNK * GLOW.CHUNK * G) / 64), n, 1];
/** The z pass into the texture (with the guards), and the chunk's tag. */
export const glowFinalFrag = () => /* wgsl */ `
${glowCommonWGSL}
@group(2) @binding(${LW.A}) var<storage, read> scr: array<vec4f>;
@group(2) @binding(${LW.B}) var<storage, read_write> lcOut: array<u32>;   // lcBuf as words: its tags (past the texels), one u32 each
const LC_TAGS_AT: u32 = ${SHADOW_TEXELS}u;
fn putTag(w: u32, t: u32) { lcOut[LC_TAGS_AT * 4u + w] = t; }
@group(2) @binding(${LW.TEX}) var glowOut: texture_storage_3d<rgba16float, write>;
const GL_N: i32 = ${GLOW.N};
const GL_CHUNKS: i32 = ${GLOW.N / GLOW.CHUNK};
const TAG_GLOW: u32 = ${TAGS.GLOW}u;
const GL_HALF_MAX: f32 = ${glf(HALF_MAX)};
fn lcWrap(a: vec3i, n: i32) -> vec3i { return ((a % n) + n) % n; }
fn lcTag(c: vec3i) -> u32 { let m = vec3u(c) & vec3u(1023u); return 0x80000000u | m.x | (m.y << 10u) | (m.z << 20u); }
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  if (wg.y >= J.count) { return; }
  let i = wg.x * 64u + li;
  let ds = vec3i(GL_CHUNK_);
  if (i >= u32(GL_CHUNK_ * GL_CHUNK_ * GL_CHUNK_)) { return; }
  let l = glLocal(i, ds);
  let job = J.jobs[wg.y];
  let k = u32(job.w) & 255u;
  let base = wg.y * GL_SCRATCH;
  var s = vec4f(0.0);
  for (var t = 0; t < 9; t++) {
    s += scr[base + GL_Y_AT + glIdx(l + vec3i(0, 0, t), vec3i(GL_CHUNK_, GL_CHUNK_, GL_G))] * GW9[t];
  }
  let v = vec4f(min(s.rgb, vec3f(GL_HALF_MAX)), 1.0);
  let w = lcWrap(job.xyz * GL_CHUNK_ + l, GL_N);
  let o = vec3i(i32(k) * (GL_N + 1), 0, 0);
  for (var g = 0; g < 8; g++) {
    let gm = vec3i(g & 1, (g >> 1u) & 1, (g >> 2u) & 1);
    if (any((gm == vec3i(1)) & (w != vec3i(0)))) { continue; }
    textureStore(glowOut, o + w + gm * GL_N, v);
  }
  if (wg.x == 0u && li == 0u) {
    let wc = lcWrap(job.xyz, GL_CHUNKS);
    putTag(TAG_GLOW + k * u32(GL_CHUNKS * GL_CHUNKS * GL_CHUNKS) + u32(wc.x + GL_CHUNKS * (wc.y + GL_CHUNKS * wc.z)), lcTag(job.xyz));
  }
}
`;
export const glowFinalDispatch = (n) => [Math.ceil(GLOW.CHUNK ** 3 / 64), n, 1];
export { LightUniforms, clipTexSize };

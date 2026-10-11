// Compresses the character model with EXT_meshopt_compression (meshoptimizer's
// codec; figureReal.js decodes it with three's MeshoptDecoder) and checks the
// result against its input before writing it. tools/character-pack.mjs runs it
// on every pack; run it alone to compress a GLB that isn't yet:
//
// usage: node tools/character-compress.mjs [in.glb] [out.glb]
//   (default: public/models/character/body.glb, in place; an input that is
//   already compressed is left alone)
//
// Every buffer goes through meshopt's codec, which is lossless and leaves the
// file small even where the host sends it uncompressed (Cloudflare's default
// compression doesn't cover model/gltf-binary). Lossy, and by how much on the
// body:
// - animation rotations: 16-bit quaternions (meshopt's filter), within 1e-4 rad
//   of the float track; this is most of the file. The one translation track
//   (the pelvis) keeps a 23-bit mantissa: float, in effect.
// - normals: 8-bit octahedral (meshopt's filter), within 1.1°; the body is lit
//   diffuse only (figure.js figureFrag), so N.L moves by under 0.02.
// - skin weights: 16-bit, each in its own slot (not re-sorted, so garb.js files
//   every vertex under the same heaviest bone), within 2e-5 once three
//   normalizes them.
// Together: every vertex skinned at every keyframe of every clip lands within
// 0.2 mm of where the float file puts it, on a 1.82 m body. UVs come through
// within UV_LIMIT; the textures (WebP) are copied as they are.
// Kept exactly: positions stay float32, in metres, and the vertices keep their
// order. garb.js fits the robe to the bind pose in metres and takes the hip
// height from the first thigh vertex, and figureReal.js sizes the body from the
// positions' bounds; quantized positions would move a scale into the inverse
// bind matrices, and meshopt's reorder would move the hip.
//
// The check decodes the output with three's own decoder (the one the game
// runs), compares it with the input (names, extras, rest pose, triangles,
// positions, normals, weights, every animation track, and every vertex skinned
// at every keyframe of every clip) and writes nothing past CHECK_LIMITS.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { NodeIO, MathUtils, Logger, Accessor } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization, EXTTextureWebP } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const DEFAULT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public/models/character/body.glb');
const WEIGHT_MAX = 0xffff;      // skin weights as normalized 16-bit
const TRANSLATION_BITS = 23;   // meshopt's exponential filter: mantissa bits (glTF-Transform asks for 12)
// Past any of these nothing is written. Distances in metres on the 1.82 m body.
export const CHECK_LIMITS = {
  restPose: 1e-6,            // bones' rest translation, rotation, scale: float noise only
  positionM: 0,              // positions are not quantized: bit-exact
  normalRad: 0.026,          // 8-bit octahedral: 1.5°
  uv: 1 / 8192,              // an eighth of a texel of the 1024² maps
  weight: 1e-4,              // a few 16-bit steps
  rotationRad: 2e-4,         // any bone, any keyframe
  translationM: 1e-5,        // any bone, any keyframe
  skinnedM: 5e-4,            // any vertex skinned at any keyframe of any clip: half a millimetre
};

// The encoder with the translation filter's precision raised.
const encoder = {
  ...MeshoptEncoder,
  encodeFilterExp: (source, count, stride, _bits, mode) => MeshoptEncoder.encodeFilterExp(source, count, stride, TRANSLATION_BITS, mode),
};
const io = () => new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization, EXTTextureWebP])
  .registerDependencies({ 'meshopt.encoder': encoder, 'meshopt.decoder': MeshoptDecoder });

// a GLB's JSON chunk
const glbJson = (glb) => JSON.parse(Buffer.from(glb.buffer, glb.byteOffset + 20, new DataView(glb.buffer, glb.byteOffset).getUint32(12, true)).toString('utf8'));
export const isCompressed = (glb) => (glbJson(glb).extensionsUsed ?? []).includes('EXT_meshopt_compression');

// The compressed GLB, and the check's report. Throws if the check fails.
export async function compressCharacter(input) {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  if (isCompressed(input)) throw new Error('the model is already meshopt-compressed');
  const src = await io().readBinary(new Uint8Array(input));
  const doc = await io().readBinary(new Uint8Array(input));   // a second copy to work on
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  // weights to 16-bit, each in its own slot: positions stay float (above); normals and animation get meshopt's filters on write
  for (const prim of doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())) {
    for (const sem of prim.listSemantics().filter((x) => x.startsWith('WEIGHTS_'))) {
      const acc = prim.getAttribute(sem);
      if (acc.getNormalized() || acc.getComponentType() !== Accessor.ComponentType.FLOAT) continue;
      acc.setArray(Uint16Array.from(acc.getArray(), (w) => Math.round(Math.min(Math.max(w, 0), 1) * WEIGHT_MAX))).setNormalized(true);
    }
  }
  doc.createExtension(KHRMeshQuantization).setRequired(true);   // the filter's int8 normals need it
  doc.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const asset = doc.getRoot().getAsset();   // its generator reads glTF-Transform's: keep the pack's too
  asset.generator = `${glbJson(input).asset.generator ?? 'unknown'}; tools/character-compress.mjs (${asset.generator})`;
  const output = await io().writeBinary(doc);
  const report = compare(src, await io().readBinary(output));   // read back through three's decoder
  return { output, report };
}

// ---- the check

const fail = (msg) => { throw new Error(`character-compress check: ${msg}`); };
const names = (list) => list.map((p) => p.getName());
const same = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${what} differ: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); };
const elements = (acc) => {
  const out = [];
  for (let i = 0; i < acc.getCount(); i++) out.push(acc.getElement(i, []));
  return out;
};
const quatAngle = (a, b) => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / (Math.hypot(...a) * Math.hypot(...b));
  return 2 * Math.acos(Math.min(1, d));
};
const triangles = (idx) => {
  const out = [];
  for (let i = 0; i < idx.length; i += 3) {
    const t = [idx[i], idx[i + 1], idx[i + 2]];
    const k = t.indexOf(Math.min(...t));
    out.push(`${t[k]},${t[(k + 1) % 3]},${t[(k + 2) % 3]}`);
  }
  return out;
};
const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const vecAngle = (a, b) => {
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]));
  return Math.acos(Math.min(1, Math.max(-1, d)));
};

// skin influences of a vertex as three uses them: normalized to sum 1 (GLTFLoader's normalizeSkinWeights)
function influences(joints, weights, i) {
  const j = joints[i], w = weights[i];
  const sum = w.reduce((s, x) => s + x, 0) || 1;
  const m = new Map();
  for (let k = 0; k < 4; k++) if (w[k] > 0) m.set(j[k], (m.get(j[k]) ?? 0) + w[k] / sum);
  return m;
}

// the bone garb.js files a vertex under: its heaviest influence, the first slot on a tie
const heaviest = (m) => [...m.entries()].reduce((x, y) => (y[1] > x[1] ? y : x))[0];

function compare(a, b) {
  const ra = a.getRoot(), rb = b.getRoot();
  same(names(ra.listNodes()), names(rb.listNodes()), 'node names');
  same(names(ra.listMaterials()), names(rb.listMaterials()), 'material names');
  same(names(ra.listAnimations()), names(rb.listAnimations()), 'clip names');
  same(ra.listAnimations().map((x) => x.getExtras()), rb.listAnimations().map((x) => x.getExtras()), 'clip extras (speed)');
  same(ra.listSkins().map((s) => names(s.listJoints())), rb.listSkins().map((s) => names(s.listJoints())), 'skin joints');
  const r = { restPose: 0, position: 0, normal: 0, uv: 0, weight: 0, jointSetsChanged: 0, mainBoneChanged: 0, vertices: 0, rotation: 0, translation: 0, clips: {} };
  // glTF-Transform writes a scale within 1e-5 of 1 as 1 (the source's 0.99999994s)
  ra.listNodes().forEach((na, i) => {
    const nb = rb.listNodes()[i];
    const ta = [na.getTranslation(), na.getRotation(), na.getScale()].flat(), tb = [nb.getTranslation(), nb.getRotation(), nb.getScale()].flat();
    r.restPose = Math.max(r.restPose, ...ta.map((v, k) => Math.abs(v - tb[k])));
  });

  // ---- meshes
  const primsA = ra.listMeshes().flatMap((m) => m.listPrimitives()), primsB = rb.listMeshes().flatMap((m) => m.listPrimitives());
  if (primsA.length !== primsB.length) fail('primitive count differs');
  const skinData = [];
  primsA.forEach((pa, pi) => {
    const pb = primsB[pi];
    same(pa.listSemantics().sort(), pb.listSemantics().sort(), 'attributes');
    same(pa.getMaterial()?.getName(), pb.getMaterial()?.getName(), 'primitive material');
    // meshopt's index codec may rotate a triangle's corners (winding kept): same triangles, same order
    const [ia, ib] = [pa, pb].map((p) => triangles(p.getIndices().getArray()));
    if (ia.length !== ib.length || ia.some((t, i) => t !== ib[i])) fail('triangles differ');
    const [posA, posB] = [pa, pb].map((p) => elements(p.getAttribute('POSITION')));
    const [norA, norB] = [pa, pb].map((p) => elements(p.getAttribute('NORMAL')));
    const [uvA, uvB] = [pa, pb].map((p) => (p.getAttribute('TEXCOORD_0') ? elements(p.getAttribute('TEXCOORD_0')) : null));
    const [jA, jB] = [pa, pb].map((p) => elements(p.getAttribute('JOINTS_0')));
    const [wA, wB] = [pa, pb].map((p) => elements(p.getAttribute('WEIGHTS_0')));
    if (posA.length !== posB.length) fail('vertex count differs');
    r.vertices += posA.length;
    for (let i = 0; i < posA.length; i++) {
      r.position = Math.max(r.position, ...posA[i].map((v, k) => Math.abs(v - posB[i][k])));
      r.normal = Math.max(r.normal, vecAngle(norA[i], norB[i]));
      if (uvA) r.uv = Math.max(r.uv, ...uvA[i].map((v, k) => Math.abs(v - uvB[i][k])));
      const ia = influences(jA, wA, i), ib = influences(jB, wB, i);
      for (const j of new Set([...ia.keys(), ...ib.keys()])) r.weight = Math.max(r.weight, Math.abs((ia.get(j) ?? 0) - (ib.get(j) ?? 0)));
      if ([...ia.keys()].sort().join() !== [...ib.keys()].sort().join()) r.jointSetsChanged++;
      if (heaviest(ia) !== heaviest(ib)) r.mainBoneChanged++;
    }
    skinData.push({ pos: posA, inflA: posA.map((_, i) => influences(jA, wA, i)), inflB: posA.map((_, i) => influences(jB, wB, i)) });
  });

  // ---- animation tracks, keyframe by keyframe
  const clipsA = ra.listAnimations(), clipsB = rb.listAnimations();
  clipsA.forEach((ca, ci) => {
    const cb = clipsB[ci];
    const chA = ca.listChannels(), chB = cb.listChannels();
    if (chA.length !== chB.length) fail(`${ca.getName()}: channel count differs`);
    const c = { rotation: 0, rotationBone: '', translation: 0, translationBone: '', skinned: 0, keyframes: 0 };
    chA.forEach((xa, k) => {
      const xb = chB[k];
      const bone = xa.getTargetNode().getName(), p = xa.getTargetPath();
      same([bone, p], [xb.getTargetNode().getName(), xb.getTargetPath()], `${ca.getName()} channel ${k} target`);
      const sa = xa.getSampler(), sb = xb.getSampler();
      same(sa.getInterpolation(), sb.getInterpolation(), 'interpolation');
      same(Array.from(sa.getInput().getArray()), Array.from(sb.getInput().getArray()), `${ca.getName()} ${bone} keyframe times`);
      const oa = elements(sa.getOutput()), ob = elements(sb.getOutput());
      for (let i = 0; i < oa.length; i++) {
        if (p === 'rotation') {
          const e = quatAngle(oa[i], ob[i]);
          if (e > c.rotation) { c.rotation = e; c.rotationBone = bone; }
        } else {
          const e = dist(oa[i], ob[i]);
          if (e > c.translation) { c.translation = e; c.translationBone = bone; }
        }
      }
    });
    // every vertex, skinned at every keyframe of the clip
    const times = [...new Set(chA.flatMap((x) => Array.from(x.getSampler().getInput().getArray())))].sort((x, y) => x - y);
    c.keyframes = times.length;
    const skinA = ra.listSkins()[0], skinB = rb.listSkins()[0];
    for (const t of times) {
      const ma = jointMatrices(ra, skinA, ca, t), mb = jointMatrices(rb, skinB, cb, t);
      for (const s of skinData) {
        for (let i = 0; i < s.pos.length; i++) {
          const va = skinVertex(s.pos[i], s.inflA[i], ma), vb = skinVertex(s.pos[i], s.inflB[i], mb);
          c.skinned = Math.max(c.skinned, dist(va, vb));
        }
      }
    }
    r.rotation = Math.max(r.rotation, c.rotation);
    r.translation = Math.max(r.translation, c.translation);
    r.clips[ca.getName()] = c;
  });
  r.skinned = Math.max(...Object.values(r.clips).map((c) => c.skinned));

  const over = [
    ['rest pose', r.restPose, CHECK_LIMITS.restPose], ['position', r.position, CHECK_LIMITS.positionM],
    ['normal', r.normal, CHECK_LIMITS.normalRad], ['uv', r.uv, CHECK_LIMITS.uv], ['weight', r.weight, CHECK_LIMITS.weight],
    ['rotation', r.rotation, CHECK_LIMITS.rotationRad], ['translation', r.translation, CHECK_LIMITS.translationM],
    ['skinned vertex', r.skinned, CHECK_LIMITS.skinnedM],
  ].filter(([, v, lim]) => v > lim);
  if (over.length) fail(over.map(([k, v, lim]) => `${k} error ${v} > ${lim}`).join('; '));
  if (r.jointSetsChanged || r.mainBoneChanged) fail(`${r.jointSetsChanged} vertices changed joints, ${r.mainBoneChanged} their heaviest bone`);
  return r;
}

// ---- posing: each joint's world matrix times its inverse bind matrix, at time t of a clip

function sample(sampler, t) {
  const times = sampler.getInput().getArray(), acc = sampler.getOutput();
  const interp = sampler.getInterpolation();
  if (interp === 'CUBICSPLINE') fail('cubic-spline tracks are not handled');
  let i = 0;
  while (i < times.length - 1 && times[i + 1] <= t) i++;
  const a = acc.getElement(i, []);
  if (interp === 'STEP' || i === times.length - 1 || t <= times[i]) return a;
  const b = acc.getElement(i + 1, []);
  const u = (t - times[i]) / (times[i + 1] - times[i]);
  if (a.length === 4) {   // nlerp along the short arc (both files the same way)
    const sgn = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
    const q = a.map((v, k) => v * (1 - u) + sgn * b[k] * u);
    const n = Math.hypot(...q);
    return q.map((v) => v / n);
  }
  return a.map((v, k) => v * (1 - u) + b[k] * u);
}

function mul(a, b) {   // column-major 4x4
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) {
    o[c * 4 + rr] = a[rr] * b[c * 4] + a[4 + rr] * b[c * 4 + 1] + a[8 + rr] * b[c * 4 + 2] + a[12 + rr] * b[c * 4 + 3];
  }
  return o;
}

function jointMatrices(root, skin, clip, t) {
  const trs = new Map();
  for (const n of root.listNodes()) trs.set(n, { translation: n.getTranslation(), rotation: n.getRotation(), scale: n.getScale() });
  for (const ch of clip.listChannels()) trs.get(ch.getTargetNode())[ch.getTargetPath()] = sample(ch.getSampler(), t);
  const world = new Map();
  const visit = (n, parent) => {
    const { translation, rotation, scale } = trs.get(n);
    const local = MathUtils.compose(translation, rotation, scale, new Array(16));
    world.set(n, parent ? mul(parent, local) : local);
    for (const c of n.listChildren()) visit(c, world.get(n));
  };
  for (const scene of root.listScenes()) for (const n of scene.listChildren()) visit(n, null);
  const ibm = skin.getInverseBindMatrices();
  return skin.listJoints().map((j, i) => mul(world.get(j), ibm.getElement(i, [])));
}

function skinVertex(p, infl, mats) {
  const o = [0, 0, 0];
  for (const [j, w] of infl) {
    const m = mats[j];
    o[0] += w * (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]);
    o[1] += w * (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]);
    o[2] += w * (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]);
  }
  return o;
}

// ---- report

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
export function sizes(bytes) {
  const raw = bytes.length;
  const gzip = zlib.gzipSync(bytes, { level: 9 }).length;
  const brotli = zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  return `${kb(raw)} raw, ${kb(gzip)} gzip, ${kb(brotli)} brotli`;
}
export function formatReport(r) {
  const deg = (rad) => `${(rad * 180 / Math.PI).toFixed(3)}°`;
  const mm = (m) => `${(m * 1000).toFixed(4)} mm`;
  const lines = [
    `rest pose within ${r.restPose.toExponential(1)}; ${r.vertices} vertices: position error ${r.position} m, normals within ${deg(r.normal)}, UVs within ${r.uv.toExponential(1)}, weights within ${r.weight.toExponential(1)}`
      + ` (same joints and heaviest bone on every vertex)`,
    'clip      keys  worst rotation (bone)          worst translation (bone)        worst skinned vertex',
  ];
  for (const [name, c] of Object.entries(r.clips)) {
    lines.push(`${name.padEnd(8)} ${String(c.keyframes).padStart(5)}  ${`${c.rotation.toExponential(2)} rad (${c.rotationBone})`.padEnd(30)} `
      + `${`${mm(c.translation)} (${c.translationBone})`.padEnd(31)} ${mm(c.skinned)}`);
  }
  lines.push(`worst: rotation ${r.rotation.toExponential(2)} rad, translation ${mm(r.translation)}, skinned vertex ${mm(r.skinned)}`);
  return lines.join('\n');
}

// ---- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inPath = process.argv[2] ?? DEFAULT_PATH;
  const outPath = process.argv[3] ?? inPath;
  const input = fs.readFileSync(inPath);
  if (isCompressed(input)) {
    console.log(`${inPath} is already meshopt-compressed; nothing to do`);
  } else {
    const { output, report } = await compressCharacter(input);
    fs.writeFileSync(outPath, output);
    console.log(formatReport(report));
    console.log(`before: ${sizes(input)}\nafter:  ${sizes(Buffer.from(output))}\nwrote ${outPath}`);
  }
}

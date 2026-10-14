// Builds public/models/character/body.glb, the realistic body (figureReal.js):
// Quaternius's Superhero Male from Universal Base Characters (CC0, the free
// Standard tier) with his skin, eye and eyebrow textures, playing only the clips
// the body uses from Quaternius's Universal Animation Library (CC0), retargeted
// onto his skeleton. Then tools/character-compress.mjs compresses the result
// with meshopt and checks it against the uncompressed one.
//
// usage: node tools/character-pack.mjs <Superhero_Male_FullBody.gltf|Superhero_Female_FullBody.gltf> <UAL1_Standard.glb> <UAL1_Standard_RM.glb> [out.glb] [--raw <uncompressed.glb>]
//   (the .gltf from the Universal Base Characters Standard zip's "Base Characters/Godot - UE" folder,
//   with its .bin and textures beside it; the two .glb from the Universal Animation Library Standard
//   zip's Unreal-Godot folder: the _RM twin has root motion baked in, which gives each locomotion
//   clip its natural ground speed. --raw also writes the uncompressed pack, for Blender.)
//
// Retargeting. Both rigs have the same 65 bones by name, but the superhero's
// rest pose differs (up to 17° at the neck, 14° at the chest, 12° at the
// clavicles) and his bones are a few percent longer. The clips are local
// rotations for the mannequin's rest pose, so played as they are they would
// hunch and twist him. Each bone instead gets the same world-space turn away
// from its rest pose as the mannequin's bone (what three's
// SkeletonUtils.retargetClip and Unreal's IK Retargeter do): with C(b) the
// constant from the mannequin's rest world rotation of b to the superhero's,
//   local(b) = C(parent)⁻¹ · clipLocal(b) · C(b)
// for every keyframe, exactly (a constant on each side, so slerp between keys
// is kept too), and a bone the clip leaves at rest stays at his rest. Moves of
// the hips (the pelvis's translation) scale by his hip height over the
// mannequin's, as Unreal's retargeter scales the pelvis, and so does each
// clip's ground speed, so the feet stay planted.
//
// What it keeps: the mesh, skin and textures, each map re-encoded to WebP at a
// game size (EXT_texture_webp); not the roughness map (the body is lit diffuse,
// figure.js figureFrag), nor the eyes' and eyebrows' normal maps, nor the UV
// sets and vertex colours past the first UV set.
//
// Wizard boxers. The pack ships his skin twice, with black boxers (the glTF's)
// and white ones (the Textures folder's "Light"), identical but for the cloth,
// and the white one carries the cloth's folds. Where they differ, the skin map
// gets the white cloth's shading times the hat's purple (garb.js), in linear
// light, scaled so the cloth's mean matches the hat: one purple for hat and
// boxers.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeIO, Logger } from '@gltf-transform/core';
import { EXTTextureWebP } from '@gltf-transform/extensions';
import { Quaternion, Vector3 } from 'three';
import { GARB_COLORS } from '../src/pov/garb.js';
import { compressCharacter, formatReport, sizes } from './character-compress.mjs';

const args = process.argv.slice(2);
const rawAt = args.indexOf('--raw');
const rawPath = rawAt >= 0 ? args.splice(rawAt, 2)[1] : null;
const [bodyPath, ualPath, rmPath, outArg] = args;
if (!bodyPath || !ualPath || !rmPath) {
  console.error('usage: node tools/character-pack.mjs <Superhero_Male_FullBody.gltf|Superhero_Female_FullBody.gltf> <UAL1_Standard.glb> <UAL1_Standard_RM.glb> [out.glb] [--raw <uncompressed.glb>]');
  process.exit(1);
}
const outPath = outArg ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public/models/character/body.glb');

// source clip → the name figureReal.js plays
const CLIPS = [
  ['Idle_Loop', 'idle'],
  ['Walk_Loop', 'walk'],
  ['Jog_Fwd_Loop', 'jog'],
  ['Sprint_Loop', 'sprint'],
  ['Jump_Loop', 'fall'],
  ['Swim_Fwd_Loop', 'swim'],
  ['Swim_Idle_Loop', 'tread'],
  ['Death01', 'death'],
];
// The maps kept, by material: [glTF texture slot, edge in texels, WebP quality].
// 1024² covers the body at any size it is drawn (it fills the screen's height at
// 1080p only up close); the normal map, which carries the muscles' definition,
// gets the higher quality, since its blocks show up as dents in the light.
const MAPS = {
  MI_Superhero_Male: [['baseColor', 1024, 88], ['normal', 1024, 94]],
  MI_Superhero_Female: [['baseColor', 1024, 88], ['normal', 1024, 94]],
  MI_Eyes: [['baseColor', 128, 90]],
  MI_Hair_1: [['baseColor', 256, 85]],   // the eyebrows (greyscale: figureReal.js tints them)
  MI_Hair_2: [['baseColor', 256, 85]],
};
const female = path.basename(bodyPath) === 'Superhero_Female_FullBody.gltf';
const BOXERS = {
  material: female ? 'MI_Superhero_Female' : 'MI_Superhero_Male',
  white: female ? '../Textures/T_Superhero_Female_Light_BaseColor.png' : '../Textures/T_Superhero_Male_Ligh.png',
  color: GARB_COLORS.hat,                           // linear albedo
  edge: [12, 48],                                   // sRGB levels of difference between the two skins: no cloth at or below, all cloth at or above
};
const LUMA = [0.2126, 0.7152, 0.0722];   // Rec. 709 luminance of linear RGB
const KEEP_ATTRIBUTES = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'];
const REST_EPS = 1e-4;         // a track within this of its node's rest value at every key is dropped
const ROOT_BONE = 'root';      // the bone the _RM twin moves
const HIP_BONE = 'pelvis';     // its rest height sets the scale of moves of the hips (and the ground speed)
const COMPONENTS = { rotation: 'VEC4', translation: 'VEC3', scale: 'VEC3' };

const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const BYTE_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => toLinear(i / 255));

// an image's pixels as 8-bit RGB, and back (ImageMagick does the file formats)
function readRGB(file) {
  const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', file]).toString().split(' ').map(Number);
  return { w, h, data: execFileSync('magick', [file, '-alpha', 'off', '-depth', '8', 'rgb:-'], { maxBuffer: 1 << 28 }) };
}
const writePNG = (file, { w, h, data }) => execFileSync('magick', ['-size', `${w}x${h}`, '-depth', '8', 'rgb:-', file], { input: data });

// the black-boxers skin with its boxers dyed (above), written to `out`
function dyeBoxers(blackFile, whiteFile, out) {
  const black = readRGB(blackFile), white = readRGB(whiteFile);
  if (black.w !== white.w || black.h !== white.h) throw new Error('the two skins differ in size');
  const n = black.w * black.h, cloth = new Float32Array(n);
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(black.data[i * 3 + c] - white.data[i * 3 + c]));
    cloth[i] = smooth(BOXERS.edge[0], BOXERS.edge[1], d);
    if (cloth[i] === 1) { for (let c = 0; c < 3; c++) sum += LUMA[c] * BYTE_TO_LINEAR[white.data[i * 3 + c]]; count++; }
  }
  if (!count) throw new Error('the two skins do not differ: no boxers to dye');
  const scale = count / sum;   // the white cloth's mean luminance → 1
  const data = Buffer.from(black.data);
  for (let i = 0; i < n; i++) {
    if (!cloth[i]) continue;
    for (let c = 0; c < 3; c++) {
      const dyed = Math.min(BYTE_TO_LINEAR[white.data[i * 3 + c]] * scale * BOXERS.color[c], 1);
      const v = BYTE_TO_LINEAR[black.data[i * 3 + c]] * (1 - cloth[i]) + dyed * cloth[i];
      data[i * 3 + c] = Math.round(toSrgb(v) * 255);
    }
  }
  writePNG(out, { w: black.w, h: black.h, data });
  return count / n;
}

const io = () => new NodeIO().registerExtensions([EXTTextureWebP]);
const quiet = (doc) => { doc.setLogger(new Logger(Logger.Verbosity.WARN)); return doc; };

// ---- the body: its glTF with only the kept maps, as WebP
async function readBody(file) {
  const dir = path.dirname(file);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const resources = {};
  for (const b of json.buffers) resources[b.uri] = fs.readFileSync(path.join(dir, decodeURIComponent(b.uri)));
  const slots = { baseColor: (m) => m.pbrMetallicRoughness, normal: (m) => m };
  const slotKey = { baseColor: 'baseColorTexture', normal: 'normalTexture' };
  const images = [], textures = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'character-pack-'));
  for (const m of json.materials) {
    const keep = MAPS[m.name];
    if (!keep) throw new Error(`no maps listed for material ${m.name}`);
    const kept = {};
    for (const [slot, size, quality] of keep) {
      const ref = slots[slot](m)?.[slotKey[slot]];
      if (!ref) throw new Error(`${m.name} has no ${slot} map`);
      const src = json.images[json.textures[ref.index].source];
      const name = path.basename(decodeURIComponent(src.uri), '.png');
      let file = path.join(dir, decodeURIComponent(src.uri));
      if (m.name === BOXERS.material && slot === 'baseColor') {
        const dyed = path.join(tmp, `${name}_dyed.png`);
        const share = dyeBoxers(file, path.join(dir, BOXERS.white), dyed);
        console.log(`clothing: ${(share * 100).toFixed(1)}% of ${name} dyed`);
        file = dyed;
      }
      const webp = path.join(tmp, `${name}.webp`);
      execFileSync('cwebp', ['-quiet', '-q', String(quality), '-resize', String(size), String(size), file, '-o', webp]);
      resources[`${name}.webp`] = fs.readFileSync(webp);
      images.push({ uri: `${name}.webp`, mimeType: 'image/webp', name });
      textures.push({ sampler: json.textures[ref.index].sampler, extensions: { EXT_texture_webp: { source: images.length - 1 } } });
      kept[slot] = { ...ref, index: textures.length - 1 };
    }
    m.pbrMetallicRoughness = { ...m.pbrMetallicRoughness, baseColorTexture: kept.baseColor };
    delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    if (kept.normal) m.normalTexture = kept.normal; else delete m.normalTexture;
  }
  fs.rmSync(tmp, { recursive: true });
  json.images = images;
  json.textures = textures;
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), 'EXT_texture_webp'])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), 'EXT_texture_webp'])];
  const doc = quiet(await io().readJSON({ json, resources }));
  for (const prim of doc.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())) {
    for (const sem of prim.listSemantics()) {
      if (KEEP_ATTRIBUTES.includes(sem)) continue;
      const acc = prim.getAttribute(sem);
      prim.setAttribute(sem, null);
      if (!acc.listParents().some((p) => p !== doc.getRoot())) acc.dispose();
    }
  }
  return doc;
}

const body = await readBody(bodyPath);
const ual = quiet(await io().read(ualPath)), rm = quiet(await io().read(rmPath));

// ---- the rigs: each node's rest world rotation, by name
function restWorld(doc) {
  const out = new Map();
  const visit = (n, parent) => {
    const q = parent.clone().multiply(new Quaternion(...n.getRotation()));
    out.set(n.getName(), q);
    for (const c of n.listChildren()) visit(c, q);
  };
  for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) visit(n, new Quaternion());
  return out;
}
const nodeByName = (doc) => new Map(doc.getRoot().listNodes().map((n) => [n.getName(), n]));
const srcNodes = nodeByName(ual), dstNodes = nodeByName(body);
const srcRest = restWorld(ual), dstRest = restWorld(body);
const joints = (doc) => doc.getRoot().listSkins()[0].listJoints().map((j) => j.getName());
if (joints(ual).join() !== joints(body).join()) throw new Error('the two rigs have different bones');
// C(b): from the mannequin's rest world rotation to the superhero's
const C = new Map([...dstRest].map(([name, q]) => [name, srcRest.get(name)?.clone().invert().multiply(q)]));
const parentName = (doc, node) => doc.getRoot().listNodes().find((n) => n.listChildren().includes(node))?.getName();
const hipScale = new Vector3(...dstNodes.get(HIP_BONE).getTranslation()).length() / new Vector3(...srcNodes.get(HIP_BONE).getTranslation()).length();

// ---- which tracks move: a (node, path) is kept if any kept clip moves it off its rest value
const clipByName = (doc, name) => {
  const a = doc.getRoot().listAnimations().find((x) => x.getName() === name);
  if (!a) throw new Error(`clip ${name} is missing`);
  return a;
};
const restOf = (node, p) => ({ rotation: node.getRotation(), translation: node.getTranslation(), scale: node.getScale() })[p];
const moving = new Set();
for (const [name] of CLIPS) {
  for (const ch of clipByName(ual, name).listChannels()) {
    const node = ch.getTargetNode(), p = ch.getTargetPath(), rest = restOf(node, p);
    const v = ch.getSampler().getOutput().getArray();
    if (v.some((x, k) => Math.abs(x - rest[k % rest.length]) > REST_EPS)) moving.add(`${node.getName()}/${p}`);
  }
}

// ---- natural speed of each clip from the root-motion twin (horizontal travel / duration), in the mannequin's metres
function clipSpeed(name) {
  const ch = clipByName(rm, name).listChannels().find((c) => c.getTargetNode().getName() === ROOT_BONE && c.getTargetPath() === 'translation');
  if (!ch) return 0;
  const t = ch.getSampler().getInput().getArray(), v = ch.getSampler().getOutput().getArray();
  const last = v.length - 3, dur = t[t.length - 1] - t[0];
  return dur > 0 ? Math.hypot(v[last] - v[0], v[last + 2] - v[2]) / dur : 0;   // glTF is y-up: travel in x and z
}

// ---- one keyframe track, retargeted
function retarget(node, p, values) {
  const name = node.getName(), parent = parentName(ual, srcNodes.get(name));
  const out = new Float32Array(values.length);
  if (p === 'rotation') {
    const left = C.get(parent).clone().invert(), right = C.get(name), q = new Quaternion();
    for (let i = 0; i < values.length; i += 4) {
      q.fromArray(values, i).premultiply(left).multiply(right).normalize();
      q.toArray(out, i);
    }
  } else if (p === 'translation') {
    // his rest, plus the mannequin's move off its rest turned into his parent's frame and scaled
    const turn = C.get(parent).clone().invert();
    const srcAt = new Vector3(...srcNodes.get(name).getTranslation()), dstAt = new Vector3(...dstNodes.get(name).getTranslation());
    const d = new Vector3();
    for (let i = 0; i < values.length; i += 3) {
      d.fromArray(values, i).sub(srcAt).applyQuaternion(turn).multiplyScalar(hipScale).add(dstAt);
      d.toArray(out, i);
    }
  } else {
    throw new Error(`${name}: a ${p} track is not handled`);
  }
  return out;
}

// ---- the clips, on the body's nodes
const buffer = body.getRoot().listBuffers()[0];
const timeAccessors = new Map();   // identical keyframe-time arrays share one accessor
function times(arr) {
  const key = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
  if (!timeAccessors.has(key)) timeAccessors.set(key, body.createAccessor().setType('SCALAR').setArray(new Float32Array(arr)).setBuffer(buffer));
  return timeAccessors.get(key);
}
const report = [];
for (const [name, as] of CLIPS) {
  const src = clipByName(ual, name);
  const speed = clipSpeed(name) * hipScale;
  const anim = body.createAnimation(as).setExtras({ source: name, speed: +speed.toFixed(4) });
  let n = 0;
  for (const ch of src.listChannels()) {
    const node = ch.getTargetNode(), p = ch.getTargetPath();
    if (!moving.has(`${node.getName()}/${p}`)) continue;
    const target = dstNodes.get(node.getName());
    if (!target) throw new Error(`the body has no ${node.getName()} node`);
    const s = ch.getSampler();
    if (s.getInterpolation() === 'CUBICSPLINE') throw new Error('cubic-spline tracks are not handled');
    const output = body.createAccessor().setType(COMPONENTS[p]).setArray(retarget(node, p, s.getOutput().getArray())).setBuffer(buffer);
    const sampler = body.createAnimationSampler().setInput(times(s.getInput().getArray())).setOutput(output).setInterpolation(s.getInterpolation());
    anim.addSampler(sampler).addChannel(body.createAnimationChannel().setTargetNode(target).setTargetPath(p).setSampler(sampler));
    n++;
  }
  report.push(`${as.padEnd(7)} ← ${name.padEnd(15)} ${n} tracks, speed ${speed.toFixed(3)} m/s`);
}

const asset = body.getRoot().getAsset();
asset.generator = 'powder-toy-3d tools/character-pack.mjs';
asset.copyright = 'Quaternius, CC0 1.0';
const packed = Buffer.from(await io().writeBinary(body));
if (rawPath) fs.writeFileSync(rawPath, packed);
const { output, report: check } = await compressCharacter(packed);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, output);
const worst = [...C].filter(([n]) => srcNodes.has(n)).reduce((w, [n, q]) => Math.max(w, 2 * Math.acos(Math.min(1, Math.abs(q.w)))), 0);
console.log(`retarget: rest poses differ by up to ${(worst * 180 / Math.PI).toFixed(1)}° (world), hips ×${hipScale.toFixed(4)}`);
console.log(report.join('\n'));
console.log(formatReport(check));
console.log(`moving tracks ${moving.size}; uncompressed ${sizes(packed)}`);
console.log(`wrote ${outPath}: ${sizes(Buffer.from(output))}`);

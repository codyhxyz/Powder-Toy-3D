// Builds public/models/character/mannequin.glb from Quaternius's Universal
// Animation Library (CC0): the mannequin mesh and its skin, plus only the clips
// the realistic body plays (figureReal.js). Plain glTF surgery, no
// dependencies: the source file is read as data, never run.
//
// usage: node tools/character-pack.mjs <UAL1_Standard.glb> <UAL1_Standard_RM.glb> [out.glb]
//   (both from the Standard zip's Unreal-Godot folder; the _RM twin has root
//   motion baked in, which gives each locomotion clip its natural ground speed)
//
// What it drops: the UV sets (the body is lit flat-coloured, no textures),
// every other clip, and any track that holds its node's rest value in every
// kept clip (scale tracks, most bone translations). Each kept clip gets
// extras.speed: how fast its root travels, in model units (metres) per second.
import fs from 'node:fs';
import path from 'node:path';

const [srcPath, rmPath, outArg] = process.argv.slice(2);
if (!srcPath || !rmPath) {
  console.error('usage: node tools/character-pack.mjs <UAL1_Standard.glb> <UAL1_Standard_RM.glb> [out.glb]');
  process.exit(1);
}
const outPath = outArg ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public/models/character/mannequin.glb');

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
const DROP_ATTRIBUTES = ['TEXCOORD_0', 'TEXCOORD_1'];
const REST_EPS = 1e-4;         // a track within this of its node's rest value at every key is dropped
const ROOT_BONE = 'root';      // the bone the _RM twin moves
const GLB_MAGIC = 0x46546c67, GLB_VERSION = 2, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
const ALIGN = 4;               // glTF chunk and buffer view alignment, bytes
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const REST = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${file} is not a GLB`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen;
  const binLen = buf.readUInt32LE(binStart);
  if (buf.readUInt32LE(binStart + 4) !== CHUNK_BIN) throw new Error(`${file} has no BIN chunk`);
  return { json, bin: buf.subarray(binStart + 8, binStart + 8 + binLen) };
}

// an accessor's bytes, tightly packed
function accessorBytes(g, i) {
  const a = g.json.accessors[i], bv = g.json.bufferViews[a.bufferView];
  const size = COMPONENTS[a.type] * COMPONENT_BYTES[a.componentType];
  if (bv.byteStride && bv.byteStride !== size) throw new Error('interleaved buffer views are not handled');
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return g.bin.subarray(start, start + a.count * size);
}
function accessorFloats(g, i) {
  const b = accessorBytes(g, i);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const src = readGlb(srcPath), rm = readGlb(rmPath);
const J = src.json;
const byName = (g, name) => {
  const a = g.json.animations.find((x) => x.name === name);
  if (!a) throw new Error(`clip ${name} is missing`);
  return a;
};

// ---- which tracks move: a (node, path) is kept if any kept clip moves it off its rest value
const moving = new Set();
for (const [name] of CLIPS) {
  const anim = byName(src, name);
  for (const ch of anim.channels) {
    const node = J.nodes[ch.target.node];
    const rest = node[ch.target.path] ?? REST[ch.target.path];
    const v = accessorFloats(src, anim.samplers[ch.sampler].output);
    const n = rest.length;
    for (let k = 0; k < v.length; k++) {
      if (Math.abs(v[k] - rest[k % n]) > REST_EPS) { moving.add(`${ch.target.node}/${ch.target.path}`); break; }
    }
  }
}

// ---- natural speed of each clip from the root-motion twin (horizontal travel / duration)
function clipSpeed(name) {
  const anim = byName(rm, name);
  const rootIdx = rm.json.nodes.findIndex((n) => n.name === ROOT_BONE);
  const ch = anim.channels.find((c) => c.target.node === rootIdx && c.target.path === 'translation');
  if (!ch) return 0;
  const t = accessorFloats(rm, anim.samplers[ch.sampler].input);
  const v = accessorFloats(rm, anim.samplers[ch.sampler].output);
  const last = v.length - 3, dur = t[t.length - 1] - t[0];
  // glTF is y-up: travel in x and z
  return dur > 0 ? Math.hypot(v[last] - v[0], v[last + 2] - v[2]) / dur : 0;
}

// ---- rebuild: new accessors, one buffer view each, packed into one buffer
const out = {
  asset: { version: '2.0', generator: 'powder-toy-3d tools/character-pack.mjs', copyright: 'Quaternius, CC0 1.0' },
  scene: 0,
  scenes: J.scenes,
  nodes: J.nodes,
  skins: [],
  meshes: [],
  materials: J.materials,
  animations: [],
  accessors: [],
  bufferViews: [],
  buffers: [],
};
const chunks = [];
let offset = 0;
const copied = new Map();        // source accessor → new accessor (shared inputs stay shared)
const byContent = new Map();     // identical keyframe-time arrays share one accessor
function addAccessor(i, { dedupe = false } = {}) {
  if (copied.has(i)) return copied.get(i);
  const bytes = accessorBytes(src, i);
  const key = dedupe ? bytes.toString('base64') : null;
  if (key && byContent.has(key)) { copied.set(i, byContent.get(key)); return byContent.get(key); }
  const a = { ...J.accessors[i] };
  const target = J.bufferViews[a.bufferView].target;
  delete a.byteOffset;
  a.bufferView = out.bufferViews.length;
  out.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) });
  chunks.push(bytes);
  offset += bytes.length;
  const pad = (ALIGN - (offset % ALIGN)) % ALIGN;
  if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
  const idx = out.accessors.push(a) - 1;
  copied.set(i, idx);
  if (key) byContent.set(key, idx);
  return idx;
}

for (const mesh of J.meshes) {
  out.meshes.push({
    ...mesh,
    primitives: mesh.primitives.map((p) => {
      const attributes = {};
      for (const [k, v] of Object.entries(p.attributes)) if (!DROP_ATTRIBUTES.includes(k)) attributes[k] = addAccessor(v);
      return { ...p, attributes, indices: addAccessor(p.indices) };
    }),
  });
}
for (const skin of J.skins) out.skins.push({ ...skin, inverseBindMatrices: addAccessor(skin.inverseBindMatrices) });

const report = [];
for (const [name, as] of CLIPS) {
  const anim = byName(src, name);
  const channels = [], samplers = [];
  for (const ch of anim.channels) {
    if (!moving.has(`${ch.target.node}/${ch.target.path}`)) continue;
    const s = anim.samplers[ch.sampler];
    samplers.push({ input: addAccessor(s.input, { dedupe: true }), output: addAccessor(s.output), interpolation: s.interpolation });
    channels.push({ sampler: samplers.length - 1, target: ch.target });
  }
  const speed = clipSpeed(name);
  out.animations.push({ name: as, channels, samplers, extras: { source: name, speed: +speed.toFixed(4) } });
  report.push(`${as.padEnd(7)} ← ${name.padEnd(15)} ${channels.length} tracks, speed ${speed.toFixed(3)} m/s`);
}

const bin = Buffer.concat(chunks);
out.buffers.push({ byteLength: bin.length });
let jsonBuf = Buffer.from(JSON.stringify(out), 'utf8');
const jsonPad = (ALIGN - (jsonBuf.length % ALIGN)) % ALIGN;
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);   // JSON pads with spaces
const header = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
header.writeUInt32LE(GLB_MAGIC, 0); header.writeUInt32LE(GLB_VERSION, 4); header.writeUInt32LE(total, 8);
jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(CHUNK_JSON, 4);
bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(CHUNK_BIN, 4);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, Buffer.concat([header, jh, jsonBuf, bh, bin]));
console.log(report.join('\n'));
console.log(`moving tracks ${moving.size} of ${J.nodes.length * 3}; wrote ${outPath} (${(total / 1024).toFixed(0)} KB)`);

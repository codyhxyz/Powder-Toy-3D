// Bakes the held tools' scanned models (pov/models.js GLB) from Poly Haven
// (CC0, https://polyhaven.com): for each asset below, its 1k glTF from the Poly
// Haven API (https://api.polyhaven.com/files/<id>) is cut down to the nodes the
// tool shows (one pistol of the two, no magazines or rounds), its textures
// re-encoded as WebP (EXT_texture_webp) at the asset's size, and its geometry
// quantized (KHR_mesh_quantization) and meshopt-compressed (EXT_meshopt_compression, which the game's GLTFLoader
// already decodes for the bodies), into public/models/tools/<id>/<id>.glb.
// public/models/tools/CREDITS.md is written with the assets and their authors.
// No GPU, no browser; needs ImageMagick (`magick`) and `cwebp`.
//
//   node tools/bake-tool-models.mjs [--only id,id] [--list] [--cache DIR]
//
// --list prints each asset's nodes (name, mesh, world bounds in metres) and
// bakes nothing: what KEEP below is picked from. --cache keeps the downloads
// in DIR (and reuses them); otherwise they go to a temporary folder, removed
// afterwards.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsVariants, KHRTextureTransform, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const LIST = argv.includes('--list');
const ONLY = opt('--only', '')?.split(',').filter(Boolean);
const CACHE = opt('--cache', null);
const RES = '1k';          // the smallest glTF Poly Haven publishes; smaller textures are scaled down from it

// The assets: the tool (catalog.js) each is for, its texture size (px; 512
// for the small ones, whose 1k maps would never show), and the nodes kept
// (names exactly as the asset has them; null keeps them all).
const ASSETS = [
  { id: 'rusted_spade_01', tool: 'SHOVEL', px: 1024, keep: null },
  { id: 'picke_dirty_01', tool: 'PICKAXE', px: 1024, keep: null },
  { id: 'wooden_axe', tool: 'AXE', px: 1024, keep: null },
  { id: 'fish_knife', tool: 'KNIFE', px: 512, keep: null },
  { id: 'trowel_01', tool: 'TROWEL', px: 512, keep: null },
  { id: 'wooden_bucket_01', tool: 'BUCKET', px: 1024, keep: null },
  // the asset lays out two pistols (a: slide forward, b: locked back) and its magazines and a round: pistol a only
  { id: 'service_pistol', tool: 'GUN', px: 512, keep: ['service_pistol_pistol_a', 'service_pistol_slide_a', 'service_pistol_hammer_a', 'service_pistol_trigger_a'] },
  // two bolts (a: closed, b: drawn back) and a loose round: the closed bolt
  // (its scope, cloth wrap and bolt share their own maps: those at 512)
  { id: 'bolt_action_rifle_7_62', tool: 'SNIPER', px: 1024, pxBy: { accesories: 512 }, keep: ['bolt_action_rifle_7_62', 'bolt_action_rifle_7_62_scope', 'bolt_action_rifle_7_62_wrap', 'bolt_action_rifle_7_62_bolt_a', 'bolt_action_rifle_7_62_trigger'] },
  { id: 'stick_grenade', tool: 'BOMB', px: 512, keep: null },
  { id: 'Lantern_01', tool: 'LANTERN', px: 512, keep: null },
];
// WebP quality (cwebp -q) per map: the colour hides compression in its own
// grain; normals show blocking as faceted light, so they keep more.
const QUALITY = { baseColor: 82, normal: 88, orm: 80 };

const API = 'https://api.polyhaven.com';
const json = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
async function download(url, path) {
  if (existsSync(path)) return;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(await r.arrayBuffer()));
}

await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsVariants, KHRTextureTransform, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

// a node's world bounds (metres), from its mesh's position accessors
function worldBounds(node) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const m = node.getWorldMatrix(), p = [0, 0, 0];
  for (const prim of node.getMesh()?.listPrimitives() ?? []) {
    const a = prim.getAttribute('POSITION');
    for (let i = 0; i < a.getCount(); i++) {
      a.getElement(i, p);
      for (let k = 0; k < 3; k++) {
        const w = m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k];
        lo[k] = Math.min(lo[k], w); hi[k] = Math.max(hi[k], w);
      }
    }
  }
  return { lo, hi };
}
const f3 = (v) => v.map((x) => x.toFixed(3)).join(' ');

// drop what nothing uses any more (gltf-transform's prune(), for the property types a model has)
function prune(doc) {
  const unused = (p) => p.listParents().every((q) => q.propertyType === PropertyType.ROOT);
  const root = doc.getRoot();
  for (const mesh of root.listMeshes()) {
    if (!unused(mesh)) continue;
    for (const prim of mesh.listPrimitives()) prim.dispose();   // (their accessors go with them below)
    mesh.dispose();
  }
  for (const list of [() => root.listMaterials(), () => root.listTextures(), () => root.listAccessors()]) {
    for (const p of list()) if (unused(p)) p.dispose();
  }
}

// Triangles and vertices put in the order the GPU's vertex cache and meshopt's coder like best
// (gltf-transform's reorder()): meshoptimizer's reorderMesh, then each vertex attribute remapped.
function reorder(doc) {
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices();
    const shared = (a) => a.listParents().filter((q) => q.propertyType === PropertyType.PRIMITIVE).length > 1;
    if (!idx || prim.getMode() !== 4 || shared(idx) || prim.listAttributes().some(shared)) continue;   // (4: triangles)
    const indices = new Uint32Array(idx.getArray());
    const [remap, unique] = MeshoptEncoder.reorderMesh(indices, true, true);   // (indices rewritten in place)
    idx.setArray(unique <= 65535 ? new Uint16Array(indices) : indices);
    for (const sem of prim.listSemantics()) {
      const acc = prim.getAttribute(sem), src = acc.getArray(), n = acc.getElementSize();
      const out = new src.constructor(unique * n);
      for (let v = 0; v < remap.length; v++) if (remap[v] !== 0xffffffff) for (let k = 0; k < n; k++) out[remap[v] * n + k] = src[v * n + k];
      acc.setArray(out);
    }
  }
}

// Vertex data quantized (what gltfpack and gltf-transform's quantize() do, KHR_mesh_quantization):
// positions to 16-bit steps across each mesh's own box (its node's transform undoes it), normals
// to 8 bits, UVs inside 0-1 to 16. A 30 cm lantern then moves in 5 µm steps.
function quantize(doc) {
  const root = doc.getRoot();
  const pack = (acc, Type, toInt) => {
    const src = acc.getArray(), out = new Type(src.length);
    for (let i = 0; i < src.length; i++) out[i] = toInt(src[i], i % acc.getElementSize());
    acc.setArray(out).setNormalized(true);
  };
  const S16 = 32767, U16 = 65535, S8 = 127;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    // (a mesh shared or a node with children would carry the box's scale on to what isn't boxed)
    if (!mesh || node.listChildren().length || mesh.listParents().filter((p) => p.propertyType === PropertyType.NODE).length > 1) continue;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const prim of mesh.listPrimitives()) {
      const a = prim.getAttribute('POSITION').getArray();
      for (let i = 0; i < a.length; i++) { lo[i % 3] = Math.min(lo[i % 3], a[i]); hi[i % 3] = Math.max(hi[i % 3], a[i]); }
    }
    const c = lo.map((l, k) => (l + hi[k]) / 2), h = Math.max(...lo.map((l, k) => (hi[k] - l) / 2), 1e-6);
    const done = new Set();
    for (const prim of mesh.listPrimitives()) {
      for (const sem of prim.listSemantics()) {
        const acc = prim.getAttribute(sem);
        if (done.has(acc) || acc.getComponentType() !== 5126) continue;   // (5126: float)
        done.add(acc);
        if (sem === 'POSITION') pack(acc, Int16Array, (v, k) => Math.round(((v - c[k]) / h) * S16));
        else if (sem === 'NORMAL') pack(acc, Int8Array, (v) => Math.round(v * S8));
        else if (sem.startsWith('TEXCOORD')) {
          const a = acc.getArray();
          if (a.every((v) => v >= 0 && v <= 1)) pack(acc, Uint16Array, (v) => Math.round(v * U16));
        }
      }
    }
    // the node: its own transform, then the box's centre and half size
    const t = node.getTranslation(), r = node.getRotation(), sc = node.getScale();
    const rc = rotate(r, c.map((v, k) => v * sc[k]));
    node.setTranslation(t.map((v, k) => v + rc[k])).setScale(sc.map((v) => v * h));
  }
  doc.createExtension(KHRMeshQuantization).setRequired(true);
}
// v turned by unit quaternion q ([x, y, z, w])
function rotate([x, y, z, w], [vx, vy, vz]) {
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

const tmp = CACHE ?? mkdtempSync(join(tmpdir(), 'tpt-tool-models-'));
const out = [];
try {
  for (const a of ASSETS) {
    if (ONLY?.length && !ONLY.includes(a.id)) continue;
    const [files, info] = await Promise.all([json(`${API}/files/${a.id}`), json(`${API}/info/${a.id}`)]);
    const g = files.gltf?.[RES]?.gltf;
    if (!g) throw new Error(`${a.id}: no ${RES} glTF`);
    const dir = join(tmp, a.id);
    const gltfPath = join(dir, `${a.id}.gltf`);
    await download(g.url, gltfPath);
    await Promise.all(Object.entries(g.include).map(([rel, f]) => download(f.url, join(dir, rel))));
    const doc = await io.read(gltfPath);
    const root = doc.getRoot();
    if (LIST) {
      console.log(`${a.id} (${info.name}):`);
      for (const n of root.listNodes()) {
        const b = n.getMesh() ? worldBounds(n) : null;
        console.log(`  ${n.getName()}${n.getMesh() ? ` mesh=${n.getMesh().getName()}` : ''}${b ? ` lo ${f3(b.lo)} hi ${f3(b.hi)}` : ''}`);
      }
      continue;
    }
    if (a.keep) {
      const keep = new Set(a.keep);
      // a kept node keeps its ancestors (their transforms) and its own children
      const kept = (n) => { for (let p = n; p; p = p.getParentNode()) if (keep.has(p.getName())) return true; return false; };
      const holdsKept = (n) => kept(n) || n.listChildren().some(holdsKept);
      for (const n of root.listNodes()) if (!holdsKept(n)) n.dispose();
    }
    prune(doc);
    reorder(doc);
    quantize(doc);
    // textures to WebP at the asset's size: colour as sRGB, the data maps (normal, ORM) as stored
    const role = new Map();
    for (const m of root.listMaterials()) {
      if (m.getBaseColorTexture()) role.set(m.getBaseColorTexture(), 'baseColor');
      if (m.getNormalTexture()) role.set(m.getNormalTexture(), 'normal');
      for (const t of [m.getMetallicRoughnessTexture(), m.getOcclusionTexture()]) if (t && !role.has(t)) role.set(t, 'orm');
    }
    for (const t of root.listTextures()) {
      const kind = role.get(t) ?? 'orm';
      const src = join(dir, `src-${t.getName() || 'tex'}-${kind}.png`), dst = src.replace(/\.png$/, '.webp');
      writeFileSync(src.replace(/\.png$/, '.in'), t.getImage());
      const px = Object.entries(a.pxBy ?? {}).find(([part]) => t.getName().includes(part))?.[1] ?? a.px;
      execFileSync('magick', [src.replace(/\.png$/, '.in'), '-resize', `${px}x${px}>`, `${kind === 'baseColor' ? 'PNG32' : 'PNG24'}:${src}`]);   // (colour keeps its alpha: the scope's glass)
      execFileSync('cwebp', ['-quiet', '-q', String(QUALITY[kind]), '-m', '6', '-exact', ...(kind === 'baseColor' ? ['-sharp_yuv'] : []), src, '-o', dst]);
      t.setImage(new Uint8Array(readFileSync(dst))).setMimeType('image/webp').setURI(`${t.getName() || kind}.webp`);
    }
    doc.createExtension(EXTTextureWebP).setRequired(true);
    doc.createExtension(EXTMeshoptCompression).setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
    // one buffer for the GLB
    const buffers = root.listBuffers();
    for (const b of buffers.slice(1)) { for (const acc of root.listAccessors()) if (acc.getBuffer() === b) acc.setBuffer(buffers[0]); b.dispose(); }
    const dest = join(ROOT, 'public', 'models', 'tools', a.id);
    mkdirSync(dest, { recursive: true });
    const glb = join(dest, `${a.id}.glb`);
    await io.write(glb, doc);
    const bytes = statSync(glb).size;
    const down = Object.values(g.include).reduce((s, f) => s + f.size, g.size);
    const tris = root.listMeshes().reduce((s, m) => s + m.listPrimitives().reduce((t, p) => t + (p.getIndices()?.getCount() ?? 0) / 3, 0), 0);
    out.push({ ...a, name: info.name, authors: Object.keys(info.authors ?? {}), bytes, down, tris });
    console.log(`${a.id}: ${(bytes / 1024).toFixed(0)} KB (from ${(down / 1024).toFixed(0)} KB), ${tris} triangles, ${root.listNodes().length} nodes`);
  }
} finally {
  if (!CACHE) rmSync(tmp, { recursive: true, force: true });
}

if (!LIST && !ONLY?.length) {
  const credits = `# Tool models

Scanned models of the held tools (src/pov/models.js GLB), from
[Poly Haven](https://polyhaven.com), released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain;
credit is not required, but given gladly). Each folder holds the asset's ${RES}
glTF baked by tools/bake-tool-models.mjs into one GLB: only the nodes the tool
shows, its maps as WebP, its geometry meshopt-compressed.

| Folder | Tool | Asset | Authors |
| --- | --- | --- | --- |
${out.map((t) => `| ${t.id} | ${t.tool} | [${t.name}](https://polyhaven.com/a/${t.id}) | ${t.authors.join(', ')} |`).join('\n')}
`;
  writeFileSync(join(ROOT, 'public', 'models', 'tools', 'CREDITS.md'), credits);
  console.log(`wrote public/models/tools/CREDITS.md; ${(out.reduce((s, t) => s + t.bytes, 0) / 1024).toFixed(0)} KB in all, from ${(out.reduce((s, t) => s + t.down, 0) / 1024).toFixed(0)} KB downloaded`);
}

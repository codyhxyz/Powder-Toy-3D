// Godot 3 text resources, read as data only: never execute game scripts.
// ArrayMesh layout reference: Godot 3.5 servers/visual_server.cpp,
// VisualServer::mesh_surface_make_offsets_from_format. This importer supports
// the interleaved, uncompressed-position buffers used by the shipped Level2.
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const fail = (message) => { throw new Error(message); };
export function numbers(value, constructor) {
  const match = value?.match(new RegExp(`^${constructor}\\(\\s*([\\s\\S]*?)\\s*\\)$`));
  if (!match) return fail(`Expected ${constructor}`);
  const result = match[1].trim() ? match[1].split(',').map(Number) : [];
  if (!result.every(Number.isFinite)) fail(`Invalid ${constructor}`);
  return result;
}
export function reference(value) {
  const m = value?.match(/^(ExtResource|SubResource)\(\s*(\d+)\s*\),?$/);
  if (!m) fail(`Invalid resource reference: ${value}`);
  return { kind: m[1], id: Number(m[2]) };
}
function primitiveString(raw) {
  const escapes = { a: '\u0007', b: '\b', t: '\t', n: '\n', v: '\u000b', f: '\f', r: '\r', e: '\u001b', '"': '"', "'": "'", '\\': '\\' };
  let value = '';
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] !== '\\') { value += raw[i]; continue; }
    const escaped = raw[++i];
    if (escaped === 'u' && /^[0-9a-f]{4}$/i.test(raw.slice(i + 1, i + 5))) { value += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16)); i += 4; }
    else if (Object.hasOwn(escapes, escaped)) value += escapes[escaped];
    else fail(`Unsupported Godot string escape: ${escaped}`);
  }
  return value;
}
/** Root-authored primitive overrides only; never evaluate GDScript/resource data. */
export function authoredPrimitiveProperties(node) {
  const result = {};
  for (const [key, raw] of Object.entries(node.props)) {
    if (key === 'script' || key === 'transform') continue;
    if (raw === 'true' || raw === 'false') result[key] = raw === 'true';
    else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) && Number.isFinite(Number(raw))) result[key] = Number(raw);
    else if (/^"(?:[^"\\]|\\[\s\S])*"$/.test(raw)) result[key] = primitiveString(raw);
  }
  return result;
}
export function sourceActorMetadata(node, scene) {
  const resource = node.instance ?? node.props.script;
  return { sourceResource: resource ? scene.external.get(reference(resource).id)?.path ?? null : null,
    sourceProperties: authoredPrimitiveProperties(node), sourceYaw: Math.atan2(node.worldTransform[6], node.worldTransform[8]) };
}
export function properties(body) {
  const result = {};
  const matches = [...body.matchAll(/^([\w/]+) = /gm)];
  matches.forEach((m, i) => { result[m[1]] = body.slice(m.index + m[0].length, matches[i + 1]?.index ?? body.length).trim(); });
  return result;
}
export function transformPoint(t, p) {
  return [0, 1, 2].map((k) => t[k] * p[0] + t[k + 3] * p[1] + t[k + 6] * p[2] + t[k + 9]);
}
function compose(a, b) {
  const origin = transformPoint(a, b.slice(9));
  const result = [];
  for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) result.push(a[k] * b[j * 3] + a[k + 3] * b[j * 3 + 1] + a[k + 6] * b[j * 3 + 2]);
  return [...result, ...origin];
}
// Shared parser for scenes and standalone .tres/.material resources. Script
// strings stay data; the conversion never evaluates Godot code.
export function parseGodot3Resource(text) {
  const top = text.match(/^\[gd_(scene|resource) ([^\n]*format=2)\]/);
  if (!top) fail('Expected a Godot 3 format=2 scene/resource');
  const type = top[2].match(/type="([^"]+)"/)?.[1];
  // Godot group arrays can make node headers span several lines.
  const headers = [...text.matchAll(/^\[(ext_resource|sub_resource|node|connection|editable|resource)(?: ([\s\S]*?))?\]\r?$/gm)];
  const external = new Map(), resources = new Map(), nodes = new Map();
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i], attrs = {};
    if (h[1] === 'connection' || h[1] === 'editable') continue;
    for (const m of (h[2] ?? '').matchAll(/(\w+)=("[^"]*"|(?:ExtResource|SubResource)\(\s*\d+\s*\)|\d+)/g)) attrs[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2];
    const props = properties(text.slice(h.index + h[0].length, headers[i + 1]?.index ?? text.length));
    const record = { ...attrs, props };
    if (h[1] === 'ext_resource') external.set(Number(attrs.id), record);
    else if (h[1] === 'sub_resource') resources.set(Number(attrs.id), record);
    else if (h[1] === 'resource') resources.set('root', { type, props });
    else {
      const path = attrs.parent == null ? '.' : attrs.parent === '.' ? attrs.name : `${attrs.parent}/${attrs.name}`;
      if (nodes.has(path)) fail(`Duplicate node ${path}`);
      nodes.set(path, { ...record, path });
    }
  }
  const world = (node, visiting = new Set()) => {
    if (node.worldTransform) return node.worldTransform;
    if (visiting.has(node.path)) fail('Cyclic node hierarchy');
    visiting.add(node.path);
    const local = node.props.transform ? numbers(node.props.transform, 'Transform') : IDENTITY;
    if (local.length !== 12) fail(`Invalid transform: ${node.path}`);
    node.localTransform = [...local];
    const parent = node.parent == null ? null : nodes.get(node.parent);
    // Overrides inside external PackedScenes cannot be resolved without that
    // scene. They are retained in the inventory, not assigned fake geometry.
    node.unresolvedParent = node.parent != null && !parent;
    node.worldTransform = compose(parent ? world(parent, visiting) : IDENTITY, local);
    return node.worldTransform;
  };
  for (const node of nodes.values()) world(node);
  return { external, resources, nodes, type };
}
export function parseGodot3Scene(text) {
  if (!/^\[gd_scene [^\n]*format=2\]/.test(text)) fail('Expected a Godot 3 format=2 .tscn');
  return parseGodot3Resource(text);
}
export function halfFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 31, fraction = bits & 1023;
  return sign * (exponent === 0 ? fraction * 2 ** -24 : exponent === 31 ? (fraction ? NaN : Infinity) : (1 + fraction / 1024) * 2 ** (exponent - 15));
}
function bytes(value) {
  const ns = numbers(value, 'PoolByteArray');
  if (!ns.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) fail('Invalid byte buffer');
  return new Uint8Array(ns);
}
export function decodeSurface(body) {
  const p = {};
  for (const m of body.matchAll(/^"(\w+)": (.*),?\r?$/gm)) p[m[1]] = m[2].replace(/,$/, '');
  const format = Number(p.format), count = Number(p.vertex_count), indexCount = Number(p.index_count);
  if (![97559, 97495].includes(format)) fail(`Unsupported Godot ArrayMesh format ${format}; do not guess buffer layout`);
  if (Number(p.primitive) !== 4) fail('Only triangle primitives are supported');
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(indexCount) || indexCount < 0 || indexCount % 3) fail('Invalid surface counts');
  // float32 XYZ (12), compressed normal/tangent (4 each), half UV (4).
  // Both formats have UV at byte 20. Per Godot 3.5 visual_server.h
  // ArrayType order, BONES (6) and WEIGHTS (7) FOLLOW TEX_UV (4): the
  // skinned 97495 stream adds 4-byte bones + 8-byte weights AFTER UV.
  // No octahedral/split-stream format is accepted here.
  const data = bytes(p.array_data), indices = bytes(p.array_index_data);
  const expectedStride = format === 97559 ? 24 : 36;
  if (data.length !== count * expectedStride) fail(`Unsupported vertex stream: ${data.length}/${count}, format ${format}`);
  const view = new DataView(data.buffer), positions = new Float64Array(count * 3), uvs = new Float64Array(count * 2), uvBits = new Uint16Array(count * 2);
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) {
    const n = view.getFloat32(i * expectedStride + k * 4, true);
    if (!Number.isFinite(n)) fail('Nonfinite vertex');
    positions[i * 3 + k] = n;
  }
  for (let i = 0; i < count; i++) for (let k = 0; k < 2; k++) {
    const bits = view.getUint16(i * expectedStride + 20 + k * 2, true);
    uvBits[i * 2 + k] = bits;
    // Keep source undefined UVs as data. Physics remains unchanged; the
    // appearance converter explicitly inventories/omits affected triangles.
    uvs[i * 2 + k] = halfFloat(bits);
  }
  const width = count >= 65536 ? 4 : 2;
  if (indices.length !== indexCount * width) fail('Invalid index buffer length');
  const iv = new DataView(indices.buffer), triangles = new Uint32Array(indexCount || count);
  if (!indexCount && count % 3) fail('Non-indexed triangle count invalid');
  for (let i = 0; i < triangles.length; i++) {
    const index = indexCount ? (width === 4 ? iv.getUint32(i * 4, true) : iv.getUint16(i * 2, true)) : i;
    if (index >= count) fail('Vertex index out of range');
    triangles[i] = index;
  }
  // Mesh.get_aabb() uses the stored surface AABB (which can include source
  // padding), not the baked world vertices. Retain it for script motion rules.
  const aabb = p.aabb ? numbers(p.aabb, 'AABB') : null;
  if (aabb && (aabb.length !== 6 || aabb.slice(3).some(v => v < 0))) fail('Invalid surface AABB');
  const rawLocalBounds = aabb ? { min: aabb.slice(0, 3), max: aabb.slice(0, 3).map((v, k) => v + aabb[k + 3]) }
    : { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  if (!aabb) for (let i = 0; i < positions.length; i++) {
    const k = i % 3;
    rawLocalBounds.min[k] = Math.min(rawLocalBounds.min[k], positions[i]); rawLocalBounds.max[k] = Math.max(rawLocalBounds.max[k], positions[i]);
  }
  return { positions, rawLocalBounds, uvs, uvBits, indices: triangles, material: p.material ? reference(p.material) : null, format };
}
export function materialPath(scene, ref) {
  if (ref.kind === 'ExtResource') return scene.external.get(ref.id)?.path ?? fail(`Missing external material ${ref.id}`);
  const r = scene.resources.get(ref.id);
  if (r?.type !== 'SpatialMaterial' || !r.props.albedo_texture) fail(`Material ${ref.id} has no translatable texture`);
  return materialPath(scene, reference(r.props.albedo_texture));
}
export function embeddedMeshes(scene, { excludeNode = () => false } = {}) {
  const meshes = [], decoded = new Map();
  for (const node of scene.nodes.values()) {
    if (node.type !== 'MeshInstance' || excludeNode(node, scene)) continue;
    if (node.unresolvedParent) fail(`Mesh parent unavailable: ${node.path}`);
    const ref = reference(node.props.mesh);
    if (ref.kind !== 'SubResource') fail(`External mesh unavailable: ${node.path}`);
    const resource = scene.resources.get(ref.id);
    if (resource?.type !== 'ArrayMesh') fail(`Unsupported mesh: ${node.path}`);
    if (!decoded.has(ref.id)) decoded.set(ref.id, Object.entries(resource.props).filter(([key]) => /^surfaces\/\d+$/.test(key)).map(([key, body]) => {
      try { return { ...decodeSurface(body), sourceSurface: key }; }
      catch (error) { throw new Error(`${node.path} ArrayMesh ${ref.id} ${key}: ${error.message}`); }
    }));
    const surfaces = decoded.get(ref.id).map((surface) => {
      const positions = new Float64Array(surface.positions.length);
      for (let i = 0; i < positions.length; i += 3) positions.set(transformPoint(node.worldTransform, surface.positions.subarray(i, i + 3)), i);
      const material = node.props.material_override ? reference(node.props.material_override) : surface.material;
      const resource = material?.kind === 'SubResource' ? scene.resources.get(material.id) : null;
      return { ...surface, positions, material, nodePath: node.path, materialProperties: resource?.props ?? null,
        albedoResource: resource?.props.albedo_texture ? reference(resource.props.albedo_texture) : null,
        materialPath: material ? materialPath(scene, material) : '__default__' };
    });
    const rawLocalBounds = { min: [0, 1, 2].map(k => Math.min(...surfaces.map(s => s.rawLocalBounds.min[k]))), max: [0, 1, 2].map(k => Math.max(...surfaces.map(s => s.rawLocalBounds.max[k]))) };
    meshes.push({ nodePath: node.path, rawLocalBounds, surfaces });
  }
  return meshes;
}

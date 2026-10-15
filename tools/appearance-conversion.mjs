import { APPEARANCE_VERSION, APPEARANCE_HEADER_WORDS as HW, APPEARANCE_TRIANGLE_WORDS as TW, APPEARANCE_MATERIAL_WORDS as MW, APPEARANCE_LIGHT_WORDS as LW, APPEARANCE_ENVIRONMENT_WORDS as EW, APPEARANCE_HEADER as H } from '../src/world/import/appearanceFormat.js';
import { transformPoint } from '../src/world/import/godot3.js';
import { sourceToCells } from '../src/world/import/voxelize.js';
import { doorBrickKeys } from '../src/world/import/doorMotion.js';
import { scalar, boolean, vector, sha256 } from './appearance-resources.mjs';
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = a => { const length = Math.hypot(...a); if (!(length > 0)) throw new Error('Degenerate source direction'); return a.map(v => v / length); };
// Affine functions live on the triangle's plane, not an arbitrary projection.
export function triangleAffine(triangle, uv) {
  const [a, b, c] = triangle, e = sub(b, a), f = sub(c, a);
  const ee = dot(e, e), ff = dot(f, f), ef = dot(e, f), det = ee * ff - ef * ef;
  if (!(det > 0)) throw new Error('Degenerate appearance triangle');
  const gu = e.map((v, i) => (v * ff - f[i] * ef) / det), gv = f.map((v, i) => (v * ee - e[i] * ef) / det);
  const affine = g => [...g, -dot(g, a)];
  const uvAffine = k => {
    const g = gu.map((v, i) => v * (uv[1][k] - uv[0][k]) + gv[i] * (uv[2][k] - uv[0][k]));
    return [...g, uv[0][k] - dot(g, a)];
  };
  const n = unit(cross(e, f));
  return { p0: a, u: uvAffine(0), v: uvAffine(1), normal: [...n, dot(n, a)], baryU: affine(gu), baryV: affine(gv) };
}
export function resolveSceneNodes(scene, { excludeNode = () => false } = {}) {
  const visible = n => n.props.visible !== 'false' && (n.parent == null || !scene.nodes.has(n.parent) || visible(scene.nodes.get(n.parent)));
  return [...scene.nodes.values()].filter(n => !excludeNode(n, scene) && visible(n));
}
export function extractLighting(resources, context, map, options) {
  const nodes = resolveSceneNodes(context.scene, options), lights = [], metadata = [];
  const sourceNode = n => {
    let script = null;
    if (n.props.script) { const s = resources.resolve(context, n.props.script); resources.read(s.identity); script = s.identity; }
    return { path: n.path, type: n.type, props: n.props, script };
  };
  for (const n of nodes) {
    const type = ['OmniLight', 'DirectionalLight', 'SpotLight'].indexOf(n.type);
    if (type < 0) continue;
    if (n.unresolvedParent) throw new Error(`Unresolved source light parent ${n.path}`);
    const p = n.props, prefix = type === 2 ? 'spot' : 'omni';
    lights.push({ position: sourceToCells(map, transformPoint(n.worldTransform, [0, 0, 0])), type,
      color: vector(p, 'light_color', 'Color', [1, 1, 1, 1]).slice(0, 3), energy: scalar(p, 'light_energy', 1) * (boolean(p, 'light_negative') ? -1 : 1),
      direction: unit(n.worldTransform.slice(6, 9).map(v => -v)), range: type === 1 ? 0 : scalar(p, `${prefix}_range`, 5) / map.cellMeters,
      attenuation: scalar(p, `${prefix}_attenuation`, 1), angle: scalar(p, 'spot_angle', 45), spotAttenuation: scalar(p, 'spot_angle_attenuation', 1), shadow: boolean(p, 'shadow_enabled') ? 1 : 0 });
    metadata.push(sourceNode(n));
  }
  const environments = nodes.filter(n => n.type === 'WorldEnvironment');
  if (environments.length !== 1) throw new Error(`Expected exactly one source WorldEnvironment, got ${environments.length}`);
  const node = environments[0], env = resources.resolve(context, node.props.environment), p = env.resource.props;
  let rotationDefault = 0, rotationAxisDefault = false;
  if (node.props.script) {
    const script = resources.resolve(context, node.props.script), code = resources.read(script.identity).toString('utf8');
    // Read exported defaults as data, never execute a source script. Explicit
    // node overrides win. Unknown script behaviours remain manifest metadata.
    rotationDefault = Number(code.match(/^export var rotation_speed\s*=\s*([-+\d.eE]+)\s*$/m)?.[1] ?? 0);
    rotationAxisDefault = code.match(/^export var z\s*=\s*(true|false)\s*$/m)?.[1] === 'true';
  }
  if (env.resource.type !== 'Environment') throw new Error(`Unsupported environment ${env.resource.type} at ${env.identity}`);
  let panorama, skyMetadata;
  if (p.background_sky) {
    const sky = resources.resolve(env, p.background_sky);
    if (sky.resource.type !== 'PanoramaSky') throw new Error(`Unsupported sky ${sky.resource.type} at ${sky.identity}; no replacement panorama invented`);
    panorama = resources.texture(sky, sky.resource.props.panorama);
    if (panorama.frameCount !== 1) throw new Error('Animated panorama unsupported');
    skyMetadata = { identity: sky.identity, props: sky.resource.props };
  }
  return { lights, environment: {
    ambient: vector(p, 'ambient_light_color', 'Color', [0, 0, 0, 1]).slice(0, 3), energy: scalar(p, 'ambient_light_energy', 1),
    fog: vector(p, 'fog_color', 'Color', [0.5, 0.6, 0.7, 1]).slice(0, 3), fogEnabled: boolean(p, 'fog_enabled') ? 1 : 0,
    begin: scalar(p, 'fog_depth_begin', 10) / map.cellMeters, end: scalar(p, 'fog_depth_end', 100) / map.cellMeters, curve: scalar(p, 'fog_depth_curve', 1), transmit: boolean(p, 'fog_transmit_enabled') ? 1 : 0,
    panorama, backgroundMode: scalar(p, 'background_mode', 0), orientation: vector(p, 'background_sky_orientation', 'Basis', [1, 0, 0, 0, 1, 0, 0, 0, 1]),
    rotationSpeed: scalar(node.props, 'rotation_speed', rotationDefault), rotationAxis: boolean(node.props, 'z', rotationAxisDefault) ? 1 : 0,
    skyContribution: scalar(p, 'ambient_light_sky_contribution', 1), backgroundEnergy: scalar(p, 'background_energy', 1),
    transmitCurve: scalar(p, 'fog_transmit_curve', 1), sunAmount: scalar(p, 'fog_sun_amount', 0), depthEnabled: boolean(p, 'fog_depth_enabled', true) ? 1 : 0,
  }, metadata: { lights: metadata, environment: { ...sourceNode(node), identity: env.identity, props: p, sky: skyMetadata } } };
}
export class AppearanceConversion {
  constructor(resources, context, meshes, mapping, doorAnalysis = null) {
    this.doorAnalysis = doorAnalysis; this.appearanceTriangleIndices = {}; this.doorBrickMemberships = new Map();
    this.resources = resources; this.context = context; this.materials = []; this.surfaceMaterials = new Map(); this.triangles = []; this.bricks = new Map(); this.losses = new Map();
    const indices = new Map();
    for (const mesh of meshes) for (const s of mesh.surfaces) {
      const element = mapping[s.materialPath];
      if (!element) continue;
      const m = resources.material(context, s, element), key = `${m.identity}:${element}`;
      if (!indices.has(key)) { indices.set(key, this.materials.length); this.materials.push(m); }
      this.surfaceMaterials.set(s, indices.get(key));
    }
  }
  onTriangle = ({ surface, owner, indexAt, triangle, brickDims, origin, cellMeters }) => {
    const materialIndex = this.surfaceMaterials.get(surface), m = this.materials[materialIndex];
    if (!m) throw new Error(`No appearance material for ${surface.materialPath}`);
    if (!surface.uvs) throw new Error('Source triangle missing UV stream');
    const uv = [0, 1, 2].map(j => [0, 1].map(k => surface.uvs[surface.indices[indexAt + j] * 2 + k] * m.scale[k] + m.offset[k]));
    if (uv.flat().some(v => !Number.isFinite(v))) {
      let loss = this.losses.get(surface);
      if (!loss) {
        loss = { reason: 'source-nonfinite-uv', node: surface.nodePath, surface: surface.sourceSurface, material: m.identity, physicalPath: surface.materialPath, triangleCount: 0, fallback: 'physical-substrate', evidence: [] };
        for (let v = 0; v < surface.uvs.length; v++) if (!Number.isFinite(surface.uvs[v])) loss.evidence.push({ vertex: Math.floor(v / 2), component: v % 2, format: surface.format, byteOffset: Math.floor(v / 2) * (surface.format === 97559 ? 24 : 36) + 20 + (v % 2) * 2, halfBits: `0x${surface.uvBits[v].toString(16).padStart(4, '0')}` });
        this.losses.set(surface, loss);
      }
      loss.triangleCount++;
      return undefined;
    }
    const record = triangleAffine(triangle, uv), seen = new Set(); let index;
    const add = key => {
      if (seen.has(key)) return;
      seen.add(key);
      if (!this.bricks.has(key)) this.bricks.set(key, []);
      this.bricks.get(key).push(index);
    };
    return p => {
      if (index == null) {
        index = this.triangles.length; this.triangles.push({ ...record, materialIndex });
        const door = this.doorAnalysis?.doors.get(owner);
        if (door?.supported) {
          (this.appearanceTriangleIndices[owner] ??= []).push(index);
          if (!this.doorBrickMemberships.has(owner)) {
            const b = door.sweptSourceBounds, map = { origin, cellMeters };
            this.doorBrickMemberships.set(owner, doorBrickKeys({ min: sourceToCells(map, b.min), max: sourceToCells(map, b.max) }, brickDims));
          }
          // Immutable directory envelopes; only existing 24-word affine
          // records move at runtime. Native UV/material/pixel ABI is untouched.
          for (const key of this.doorBrickMemberships.get(owner)) add(key);
        }
      }
      const b = p.map(v => Math.floor(v / 8)), key = b[0] + brickDims[0] * (b[1] + brickDims[1] * b[2]);
      add(key);
    };
  };
  pack(map, options) {
    const lighting = extractLighting(this.resources, this.context, map, options);
    const count = map.brickDims.reduce((a, b) => a * b, 1);
    const lists = [...this.bricks].sort(([a], [b]) => a - b);
    const directoryAt = HW, trianglesAt = directoryAt + count + lists.reduce((n, [, list]) => n + list.length + 1, 0);
    const materialsAt = trianglesAt + this.triangles.length * TW, lightsAt = materialsAt + this.materials.length * MW;
    const environmentAt = lightsAt + lighting.lights.length * LW;
    let total = environmentAt + EW;
    const textures = [], offsets = new Map();
    const addTexture = texture => {
      if (!texture) return 0;
      const key = `${texture.width}:${texture.height}:${texture.frameCount}:${sha256(texture.pixels)}`;
      if (!offsets.has(key)) { offsets.set(key, total); textures.push({ at: total, texture }); total += texture.pixels.length / 4; }
      return offsets.get(key);
    };
    const materialTextures = this.materials.map(m => addTexture(m.texture));
    const roughnessTextures = this.materials.map(m => addTexture(m.roughnessTexture));
    const metallicTextures = this.materials.map(m => addTexture(m.metallicTexture));
    const panoramaAt = addTexture(lighting.environment.panorama);
    if (!Number.isSafeInteger(total) || total > 0xffffffff) throw new Error('Appearance word address space exceeded');
    const words = new Uint32Array(total), floats = new Float32Array(words.buffer);
    const fs = (at, values) => { if (!values.every(Number.isFinite)) throw new Error('Nonfinite appearance record'); floats.set(values, at); };
    words[H.version] = APPEARANCE_VERSION; words[H.totalWords] = total; words.set(map.brickDims, H.brickDims);
    words[H.directoryAt] = directoryAt; words[H.trianglesAt] = trianglesAt; words[H.materialsAt] = materialsAt; words[H.materialCount] = this.materials.length;
    words[H.triangleCount] = this.triangles.length; words[H.lightsAt] = lightsAt; words[H.lightCount] = lighting.lights.length; words[H.environmentAt] = environmentAt;
    let at = directoryAt + count, maxBrickTriangles = 0;
    for (const [key, list] of lists) {
      if (!map.words[key]) throw new Error(`Appearance brick ${key} has no physics occupancy`);
      words[directoryAt + key] = at; words[at++] = list.length; words.set(list, at); at += list.length;
      maxBrickTriangles = Math.max(maxBrickTriangles, list.length);
      if (list.length >= 1024) throw new Error(`Appearance brick ${key} has ${list.length} triangles; fixed sampler requires <1024 (no truncation permitted)`);
    }
    words[H.maxBrickTriangles] = maxBrickTriangles;
    this.triangles.forEach((t, i) => {
      const a = trianglesAt + i * TW;
      fs(a, t.p0); words[a + 3] = t.materialIndex;
      fs(a + 4, [...t.u, ...t.v, ...t.normal, ...t.baryU, ...t.baryV]);
    });
    this.materials.forEach((m, i) => {
      const a = materialsAt + i * MW, t = m.texture;
      words.set([materialTextures[i], t?.width ?? 0, t?.height ?? 0, m.flags], a);
      fs(a + 4, [...m.albedo, ...m.emission, m.emissionEnergy, m.roughness, m.metallic, m.specular]);
      words[a + 15] = m.element; words[a + 16] = t?.frameCount ?? 0; floats[a + 17] = t?.fps ?? 0;
      words[a + 18] = t ? t.width * t.height : 0; words[a + 19] = m.mode;
      fs(a + 20, [scalar(m.params, 'snapRes', 50), boolean(m.params, 'paletteswap') ? 1 : 0]);
      words.set([roughnessTextures[i], m.roughnessTexture?.width ?? 0, m.roughnessTexture?.height ?? 0, m.roughnessChannel,
        metallicTextures[i], m.metallicTexture?.width ?? 0, m.metallicTexture?.height ?? 0, m.metallicChannel], a + 22);
    });
    lighting.lights.forEach((l, i) => {
      const a = lightsAt + i * LW;
      fs(a, l.position); words[a + 3] = l.type;
      fs(a + 4, [...l.color, l.energy, ...l.direction, l.range, l.attenuation, l.angle, l.spotAttenuation]); words[a + 15] = l.shadow;
    });
    const e = lighting.environment, a = environmentAt;
    fs(a, [...e.ambient, e.energy, ...e.fog]); words[a + 7] = e.fogEnabled;
    fs(a + 8, [e.begin, e.end, e.curve]); words[a + 11] = e.transmit;
    words.set([panoramaAt, e.panorama?.width ?? 0, e.panorama?.height ?? 0, e.backgroundMode], a + 12);
    fs(a + 16, e.orientation); floats[a + 25] = e.rotationSpeed; words[a + 26] = e.rotationAxis;
    fs(a + 27, [e.skyContribution, e.backgroundEnergy, e.transmitCurve, e.sunAmount]); words[a + 31] = e.depthEnabled;
    for (const { at, texture } of textures) for (let i = 0; i < texture.pixels.length / 4; i++) words[at + i] = texture.pixels.readUInt32LE(i * 4);
    const textureMetadata = t => t ? { identity: t.identity, width: t.width, height: t.height, frameCount: t.frameCount, fps: t.fps, importFlags: t.importFlags, sources: t.sources } : null;
    return { words, metadata: {
      version: APPEARANCE_VERSION, encoding: 'source-triangle-appearance-u32-v1', compression: 'gzip', totalWords: total, wordCount: total,
      triangleCount: this.triangles.length, materialCount: this.materials.length, lightCount: lighting.lights.length,
      maxBrickTriangles, brickCount: count, occupiedBricks: this.bricks.size,
      materials: this.materials.map((m, i) => ({ index: i, identity: m.identity, physicalPath: m.physicalPath, physicalElement: m.element, type: m.type, properties: m.props, uvScale: m.scale, uvOffset: m.offset, flags: m.flags, mode: m.mode, shader: m.shader, parameters: m.params, textureAt: materialTextures[i], texture: textureMetadata(m.texture), roughnessTextureAt: roughnessTextures[i], roughnessTexture: textureMetadata(m.roughnessTexture), roughnessChannel: m.roughnessChannel, metallicTextureAt: metallicTextures[i], metallicTexture: textureMetadata(m.metallicTexture), metallicChannel: m.metallicChannel })),
      textures: textures.map(({ at, texture }) => ({ at, words: texture.pixels.length / 4, sha256: sha256(texture.pixels), ...textureMetadata(texture) })),
      lighting: { ...lighting.metadata, panoramaAt, panorama: textureMetadata(e.panorama) },
      sources: this.resources.provenance(), losses: [...this.losses.values()],
      limitations: ['Authored static terrain triangles only; external prop/actor scenes and scripts are not executed.', 'Source shader modes and source script properties are recorded for renderer ports; this conversion does not animate geometry or lights.', 'Original PNG RGBA8 pixels preserved without resampling; GPU import compression/mip generation/alpha-border fixup are not baked into pixels.'],
    } };
  }
}
export function littleEndianWords(words) {
  const buffer = Buffer.alloc(words.byteLength);
  words.forEach((word, i) => buffer.writeUInt32LE(word, i * 4));
  return buffer;
}

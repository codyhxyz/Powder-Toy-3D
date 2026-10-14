// Node-only source adapter. Shared Godot parser, no game/script execution.
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, relative, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseGodot3Resource, reference, numbers } from '../src/world/import/godot3.js';
import { APPEARANCE_FLAGS as F, APPEARANCE_MODES as M } from '../src/world/import/appearanceFormat.js';
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const godotString = (value) => JSON.parse(value.replace(/[\u0000-\u001f]/g, c => JSON.stringify(c).slice(1, -1)));
export function scalar(props, key, fallback) {
  const value = props[key] == null ? fallback : Number(props[key]);
  if (!Number.isFinite(value)) throw new Error(`Invalid source number ${key}: ${props[key]}`);
  return value;
}
export const boolean = (p, key, fallback = false) => p[key] == null ? fallback : p[key] === 'true' ? true : p[key] === 'false' ? false : (() => { throw new Error(`Invalid source boolean ${key}`); })();
export function vector(p, key, constructor, fallback) {
  const v = p[key] == null ? fallback : numbers(p[key], constructor);
  if (v.length !== fallback.length) throw new Error(`Invalid source ${key}`);
  return v;
}
function run(tool, args, maxBuffer = 256 * 1024 * 1024) {
  const r = spawnSync(tool, args, { maxBuffer, timeout: 120000 });
  // Ubuntu provides ImageMagick 6's separate commands; macOS uses version7's
  // 'magick' dispatcher. Both decode the original pixels without resampling.
  if (tool === 'magick' && r.error?.code === 'ENOENT') {
    return run(args[0] === 'identify' ? 'identify' : 'convert', args[0] === 'identify' ? args.slice(1) : args, maxBuffer);
  }
  if (r.error || r.status !== 0) throw new Error(`${tool} failed: ${r.error?.message ?? r.stderr?.toString().slice(-2000)}`);
  return r.stdout;
}
export const imageMagick = args => run('magick', args);
// Audited EXACT source shader code hashes. Never classify art by a filename or
// broad substring. A changed/unknown shader requires an explicit mode review.
export const SHADER_MODES = Object.freeze({
  e47877eb930b65c548c172babc57b33d0b8b563c322ec5d391e0fb8e4d76d835: M.unshaded,
  c6a5450feade9ff00030c309942d162fd4e074340e1465704a062c2605899bdf: M.flesh,
  '6801e9858cc63ba4add156d3d95a08473775f58adb12f5a38cf3571474b1775c': M.swampWater,
  b7ce70e3dc1ca3e76646b3e37f2739ed0e289402655fd67e8481507c73e9b3da: M.scroll,
  '3382031130735e0c1429821bc25adf1db953f0360477d9a13fa6f2d177c3d84a': M.water,
  '36147f08c324194325960cb749b6d2d854f12da1bdb8965ea6468d556d3ee3ca': M.realPSX,
  ff8beba47bd6805284ffda35f5e576099a66ddc6b2854a22cc69e8ede0403bcd: M.realPSXWobble,
  b94fc587ade48776c43589663ae958d267c34564aaaa3dc825da24b4e07c2ab0: M.psx,
});
export class AppearanceResources {
  constructor(sourceRoot, { gdre = process.env.GDRE_BIN, magick = 'magick' } = {}) {
    this.root = resolve(sourceRoot); this.gdre = gdre; this.magick = magick;
    this.resources = new Map(); this.textures = new Map(); this.sources = new Map();
  }
  disk(path) {
    if (!path.startsWith('res://')) throw new Error(`Unsupported source path ${path}`);
    const file = resolve(this.root, path.slice(6)), rel = relative(this.root, file);
    if (rel.startsWith('..') || rel.startsWith('/')) throw new Error(`Source path escapes root: ${path}`);
    return file;
  }
  read(path) {
    const data = readFileSync(this.disk(path));
    this.sources.set(path, { path, sha256: sha256(data), bytes: data.length });
    return data;
  }
  context(scene, path, text) {
    if (text != null) this.sources.set(path, { path, sha256: sha256(text), bytes: Buffer.byteLength(text) });
    return { scene, path };
  }
  load(path) {
    if (this.resources.has(path)) return this.resources.get(path);
    const data = this.read(path); let text = data.toString('utf8');
    if (['RSRC', 'RSCC'].includes(data.subarray(0, 4).toString())) {
      if (!this.gdre) throw new Error(`Binary Godot resource ${path}: configure --gdre /path/to/Godot-RE-Tools or GDRE_BIN for generic text export`);
      const temp = mkdtempSync(join(tmpdir(), 'tpt-appearance-resource-'));
      try {
        run(this.gdre, ['--headless', `--bin-to-txt=${this.disk(path)}`, `--output=${temp}`]);
        text = readFileSync(join(temp, basename(path)), 'utf8');
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    const scene = parseGodot3Resource(text), context = { scene, path };
    const result = { ...context, resource: scene.resources.get('root'), identity: path };
    if (!result.resource) throw new Error(`No root resource in ${path}`);
    this.resources.set(path, result);
    return result;
  }
  resolve(context, value) {
    const ref = typeof value === 'string' ? reference(value) : value;
    if (ref.kind === 'ExtResource') {
      const ext = context.scene.external.get(ref.id);
      if (!ext) throw new Error(`Missing external ${ref.id} in ${context.path}`);
      if (['Texture', 'StreamTexture', 'Shader'].includes(ext.type) && /\.(tres|res)$/i.test(ext.path)) return this.load(ext.path);
      if (['Texture', 'StreamTexture', 'Shader', 'Script'].includes(ext.type)) return { ...context, resource: ext, identity: ext.path, external: true };
      return this.load(ext.path);
    }
    const resource = context.scene.resources.get(ref.id);
    if (!resource) throw new Error(`Missing subresource ${ref.id} in ${context.path}`);
    return { ...context, resource, identity: `${context.path}::${ref.id}` };
  }
  texture(context, value) {
    const r = this.resolve(context, value), p = r.resource.props ?? {};
    if (r.external && ['Texture', 'StreamTexture'].includes(r.resource.type)) return this.png(r.identity);
    if (r.resource.type !== 'AnimatedTexture') throw new Error(`Unsupported texture ${r.resource.type} at ${r.identity}`);
    const unknown = Object.keys(p).filter(k => !/^(resource_name|flags|frames|fps|current_frame|pause|one_shot|frame_\d+\/(texture|delay_sec))$/.test(k));
    if (unknown.length) throw new Error(`Unsupported AnimatedTexture properties ${unknown.join(',')} at ${r.identity}`);
    const frames = scalar(p, 'frames', 1), fps = scalar(p, 'fps', 4);
    if (!Number.isInteger(frames) || frames < 1 || fps < 0 || boolean(p, 'one_shot') || boolean(p, 'pause') || scalar(p, 'current_frame', 0)) throw new Error(`Unsupported animation timing at ${r.identity}`);
    const images = [];
    for (let i = 0; i < frames; i++) {
      if (scalar(p, `frame_${i}/delay_sec`, 0) !== 0) throw new Error(`Unsupported nonuniform AnimatedTexture delay at ${r.identity}`);
      const image = this.texture(r, p[`frame_${i}/texture`]);
      if (image.frameCount !== 1) throw new Error(`Nested animation at ${r.identity}`);
      images.push(image);
    }
    if (images.some(f => f.width !== images[0].width || f.height !== images[0].height)) throw new Error(`AnimatedTexture dimensions differ at ${r.identity}`);
    const flags = scalar(p, 'flags', 7);
    if (!Number.isInteger(flags) || flags < 0 || flags > 23 || (flags & ~23)) throw new Error(`Unsupported AnimatedTexture flags ${flags} at ${r.identity}`);
    return { identity: r.identity, width: images[0].width, height: images[0].height,
      pixels: Buffer.concat(images.map(f => f.pixels)), frameCount: frames, fps,
      flags: (flags & 2 ? F.repeat : 0) | (flags & 4 ? F.filter : 0) | (flags & 1 ? F.mipmaps : 0) | (flags & 16 ? F.srgb : 0) | F.animated,
      sources: images.flatMap(f => f.sources), importFlags: { godotTextureFlags: flags }, props: p };
  }
  png(path) {
    if (this.textures.has(path)) return this.textures.get(path);
    const bytes = this.read(path);
    if (!path.toLowerCase().endsWith('.png')) throw new Error(`Unsupported texture format ${path}; expected recovered original PNG`);
    const imports = {};
    if (existsSync(`${this.disk(path)}.import`)) {
      const text = this.read(`${path}.import`).toString('utf8');
      const params = text.split('[params]')[1];
      if (!params) throw new Error(`Missing texture import params: ${path}`);
      for (const m of params.matchAll(/^([\w/]+)\s*=\s*(.*)$/gm)) imports[m[1]] = m[2];
      if (scalar(imports, 'size_limit', 0) || boolean(imports, 'process/premult_alpha') || boolean(imports, 'process/invert_color')) throw new Error(`Unsupported pixel-changing import flags at ${path}`);
    }
    // No resize, quantization, palette synthesis or filtering. PNG expands to
    // its native RGBA8 dimensions; original hash and import flags are retained.
    const dimensions = run(this.magick, ['identify', '-format', '%w %h %n', this.disk(path)]).toString().trim().split(/\s+/).map(Number);
    const [width, height, count] = dimensions;
    if (count !== 1 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 64000000) throw new Error(`Unsupported PNG dimensions ${path}`);
    const pixels = run(this.magick, [this.disk(path), '-alpha', 'on', '-depth', '8', 'RGBA:-']);
    if (pixels.length !== width * height * 4) throw new Error(`Invalid RGBA decode ${path}`);
    const result = { identity: path, width, height, pixels, frameCount: 1, fps: 0,
      flags: (boolean(imports, 'flags/repeat') ? F.repeat : 0) | (boolean(imports, 'flags/filter', true) ? F.filter : 0) | (boolean(imports, 'flags/mipmaps') ? F.mipmaps : 0) | (scalar(imports, 'flags/srgb', 0) === 1 ? F.srgb : 0),
      importFlags: imports, sources: [{ path, sha256: sha256(bytes), decodedSha256: sha256(pixels), width, height }] };
    this.textures.set(path, result); return result;
  }
  material(context, surface, element) {
    const r = surface.material ? this.resolve(context, surface.material) : { identity: '__default__', resource: { type: 'SpatialMaterial', props: {} } };
    const p = r.resource.props, type = r.resource.type;
    if (!['SpatialMaterial', 'ShaderMaterial'].includes(type)) throw new Error(`Unsupported material ${type} at ${r.identity}`);
    let texture, shader, roughnessTexture, metallicTexture, mode = M.spatial;
    const params = {};
    if (type === 'ShaderMaterial') {
      const unknownProperties = Object.keys(p).filter(k => k !== 'shader' && k !== 'resource_name' && !k.startsWith('shader_param/'));
      if (unknownProperties.length) throw new Error(`Unsupported ShaderMaterial properties ${unknownProperties.join(',')} at ${r.identity}`);
      const s = this.resolve(r, p.shader);
      const code = s.external ? this.read(s.identity).toString('utf8') : godotString(s.resource.props.code);
      const hash = sha256(code); mode = SHADER_MODES[hash];
      if (mode == null) throw new Error(`Unsupported source shader ${s.identity} sha256=${hash}; add an audited appearance mode, not substitute art`);
      shader = { identity: s.identity, sha256: hash, mode };
      for (const [k, v] of Object.entries(p)) if (k.startsWith('shader_param/')) params[k.slice(13)] = v;
      const unknown = Object.keys(params).filter(k => !['albedoTex', 'snapRes', 'paletteswap'].includes(k));
      if (unknown.length) throw new Error(`Unsupported shader parameters ${unknown.join(',')} at ${r.identity}`);
      if (p['shader_param/albedoTex']) texture = this.texture(r, p['shader_param/albedoTex']);
      else if (mode !== M.unshaded) throw new Error(`Shader missing albedoTex at ${r.identity}`);
    } else {
      const supported = /^(resource_name|flags_unshaded|flags_transparent|flags_vertex_lighting|flags_no_depth_test|params_diffuse_mode|params_specular_mode|params_blend_mode|params_cull_mode|params_depth_draw_mode|albedo_color|albedo_texture|metallic|metallic_specular|roughness|roughness_texture|roughness_texture_channel|metallic_texture|metallic_texture_channel|emission_enabled|emission|emission_energy|uv1_scale|uv1_offset|distance_fade_mode|proximity_fade_enable)$/;
      const unknown = Object.keys(p).filter(k => !supported.test(k));
      if (unknown.length) throw new Error(`Unsupported SpatialMaterial properties ${unknown.join(',')} at ${r.identity}`);
      if (boolean(p, 'flags_vertex_lighting') || boolean(p, 'flags_no_depth_test') || scalar(p, 'distance_fade_mode', 0) || boolean(p, 'proximity_fade_enable') || scalar(p, 'params_depth_draw_mode', 0) !== 0 || ![0, 2].includes(scalar(p, 'params_cull_mode', 0))) throw new Error(`Unsupported SpatialMaterial rendering flags at ${r.identity}`);
      if (p.albedo_texture) texture = this.texture(r, p.albedo_texture);
      if (p.roughness_texture) roughnessTexture = this.texture(r, p.roughness_texture);
      if (p.metallic_texture) metallicTexture = this.texture(r, p.metallic_texture);
      if ([roughnessTexture, metallicTexture].some(t => t && t.frameCount !== 1)) throw new Error(`Animated PBR maps unsupported at ${r.identity}`);
    }
    const scale = vector(p, 'uv1_scale', 'Vector3', [1, 1, 1]), offset = vector(p, 'uv1_offset', 'Vector3', [0, 0, 0]);
    let flags = texture?.flags ?? 0;
    if (boolean(p, 'flags_transparent') || mode === M.water || mode === M.psx) flags |= F.transparent;
    if (boolean(p, 'flags_unshaded') || mode === M.unshaded || mode === M.psx) flags |= F.unshaded;
    if (scalar(p, 'params_cull_mode', 0) === 2 || [M.water, M.realPSX, M.realPSXWobble].includes(mode)) flags |= F.doubleSided;
    const blend = scalar(p, 'params_blend_mode', 0), diffuse = scalar(p, 'params_diffuse_mode', 0), specularMode = scalar(p, 'params_specular_mode', 0);
    if (![0, 1, 2, 3, 4].includes(blend) || ![0, 1, 2, 3, 4].includes(diffuse) || ![0, 1, 2, 3, 4].includes(specularMode)) throw new Error(`Unsupported material mode at ${r.identity}`);
    flags |= blend << F.blendShift | diffuse << F.diffuseShift | specularMode << F.specularShift;
    if (![0, 1, 2, 3, 4].includes(scalar(p, 'roughness_texture_channel', 0)) || ![0, 1, 2, 3, 4].includes(scalar(p, 'metallic_texture_channel', 0))) throw new Error(`Unsupported PBR texture channel at ${r.identity}`);
    return { identity: r.identity, physicalPath: surface.materialPath, element, type, props: p, shader, params, texture, roughnessTexture, metallicTexture,
      roughnessChannel: scalar(p, 'roughness_texture_channel', 0), metallicChannel: scalar(p, 'metallic_texture_channel', 0), flags, mode, scale, offset,
      albedo: vector(p, 'albedo_color', 'Color', [1, 1, 1, 1]),
      emission: boolean(p, 'emission_enabled') ? vector(p, 'emission', 'Color', [0, 0, 0, 1]).slice(0, 3) : [0, 0, 0],
      emissionEnergy: scalar(p, 'emission_energy', 1), roughness: scalar(p, 'roughness', 1), metallic: scalar(p, 'metallic', 0), specular: scalar(p, 'metallic_specular', 0.5),
    };
  }
  provenance() { return [...this.sources.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }
}

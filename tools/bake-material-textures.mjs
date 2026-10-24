// Bakes the realistic view's scanned material textures (gfx/materialTextures.js)
// from Poly Haven (CC0, https://polyhaven.com): for each asset below, its 1k
// maps from the Poly Haven API (https://api.polyhaven.com/files/<id>) are
// packed into two lossy WebP images under public/textures/<id>/:
//   albedo.webp   rgb: the diffuse (albedo) map, sRGB as published
//   surface.webp  r, g: the normal map's x and y (OpenGL convention, +y up the
//                 image), b: the roughness map
// and src/gfx/textureSet.js is written: each asset's real tile size (the API's
// dimensions, metres), its mean linear albedo and its mean roughness, which the
// material table needs at load time (gfx/materials.js LOOKS tex) without the
// images. No GPU, no browser; needs ImageMagick (`magick`) and `cwebp`.
//
//   node tools/bake-material-textures.mjs [--res 1k] [--keep]
//
// The downloads go to a fresh temporary folder, removed afterwards (--keep
// leaves it and prints where).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const RES = opt('--res', '1k');
const KEEP = argv.includes('--keep');

// The assets. An asset's index is its id in gfx/textureSet.js; the GPU array's
// layers are handed out as the assets load (gfx/materialTextures.js), so the
// order only has to stay stable (append, don't reorder: the far view's tables
// and saved captures name assets by index). Each is picked by eye from its
// preview (https://cdn.polyhaven.com/asset_img/primary/<id>.png) for the
// element that names it (gfx/materials.js LOOKS tex).
const ASSETS = [
  'dense_sand', 'bark_brown_02', 'concrete_wall_008', 'brown_planks_04',
  'dark_rock_02',       // ROCK: weathered grey rock, layered and cracked
  'dark_rock',          // BASALT: near-black, rough volcanic rock
  'sandstone_cracks',   // SANDSTONE: tan, crazed natural sandstone
  'marble_rock_01',     // LIMESTONE: pale grey, cracked
  'rock_wall_10',       // COAL: dark, blocky, layered
  'gray_rocks',         // STONE: angular grey rubble
  'snow_02',            // SNOW: wind-crusted snow
  'brown_mud_02',       // MUD: wet brown mud
  'clay_plaster',       // CLAY: smooth fine clay
  'burned_ground_01',   // ASH: burnt, ashy ground
  'brick_wall_04',      // BRICK: red brick in mortar
  'brick_gravel',       // RUBBLE: crushed brick
  'rusty_metal_02',     // SCRAP: scuffed, rust-spotted steel
  'white_plaster_02',   // CERAMIC: matte white bisque
  'leafy_grass',        // PLANT's grass (the big maps' meadows: appearance GRASS)
];
// WebP quality (cwebp -q) of each image: the albedo hides compression in its
// own grain; the normals show blocking as faceted light, so they keep more.
const ALBEDO_Q = 80;
const SURFACE_Q = 85;
const MM_PER_M = 1000;
const DECIMALS = 4;   // of the means written to textureSet.js

const API = 'https://api.polyhaven.com';
const json = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
async function download(url, path) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  writeFileSync(path, Buffer.from(await r.arrayBuffer()));
}
const magick = (...args) => execFileSync('magick', args, { encoding: 'utf8' }).trim();

const tmp = mkdtempSync(join(tmpdir(), 'tpt-textures-'));
const out = [];
try {
  for (const id of ASSETS) {
    const [files, info] = await Promise.all([json(`${API}/files/${id}`), json(`${API}/info/${id}`)]);
    const url = (map) => {
      const f = files[map]?.[RES]?.jpg?.url;
      if (!f) throw new Error(`${id}: no ${RES} jpg ${map} map`);
      return f;
    };
    const dir = join(tmp, id);
    mkdirSync(dir);
    const diff = join(dir, 'diff.jpg'), nor = join(dir, 'nor_gl.jpg'), rough = join(dir, 'rough.jpg');
    await Promise.all([download(url('Diffuse'), diff), download(url('nor_gl'), nor), download(url('Rough'), rough)]);
    const dest = join(ROOT, 'public', 'textures', id);
    mkdirSync(dest, { recursive: true });
    const surfPng = join(dir, 'surface.png');
    // normal x, y and roughness into one rgb image
    magick(nor, '-separate', '(', rough, '-channel', 'R', '-separate', ')', '-delete', '2', '-set', 'colorspace', 'sRGB', '-combine', surfPng);
    execFileSync('cwebp', ['-quiet', '-q', String(ALBEDO_Q), '-m', '6', '-sharp_yuv', diff, '-o', join(dest, 'albedo.webp')]);
    execFileSync('cwebp', ['-quiet', '-q', String(SURFACE_Q), '-m', '6', '-exact', surfPng, '-o', join(dest, 'surface.webp')]);
    // means: albedo decoded to linear (ImageMagick's RGB is linear), roughness as stored
    const mean = magick(diff, '-colorspace', 'RGB', '-format', '%[fx:mean.r] %[fx:mean.g] %[fx:mean.b]', 'info:').split(/\s+/).map((v) => +(+v).toFixed(DECIMALS));
    const roughMean = +(+magick(rough, '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:')).toFixed(DECIMALS);
    const [w, h] = info.dimensions;
    const bytes = ['albedo.webp', 'surface.webp'].reduce((s, f) => s + statSync(join(dest, f)).size, 0);
    out.push({ id, name: info.name, tileM: +(Math.max(w, h) / MM_PER_M).toFixed(DECIMALS), mean, roughMean, authors: Object.keys(info.authors ?? {}), bytes });
    console.log(`${id}: ${(bytes / 1024).toFixed(0)} KB, tile ${(Math.max(w, h) / MM_PER_M).toFixed(2)} m, mean albedo ${mean.join(' ')}, mean roughness ${roughMean}`);
  }
} finally {
  if (KEEP) console.log(`downloads kept in ${tmp}`); else rmSync(tmp, { recursive: true, force: true });
}

const js = `// Generated by tools/bake-material-textures.mjs: don't edit, re-run it.
// The realistic view's scanned material textures (Poly Haven, CC0:
// public/textures/CREDITS.md). Each is two layers of gfx/materialTextures.js's
// array (albedo; normal x, y, roughness), placed there as it loads. tileM: the
// metres one tile of it covers (the scan's real size); mean: its mean albedo,
// linear rgb; roughMean: its mean roughness; bytes: its two images' download
// size. A LOOKS entry picks one by id (gfx/materials.js tex).
export const TEXTURE_SET = [
${out.map(({ id, tileM, mean, roughMean, bytes }) => `  { id: '${id}', tileM: ${tileM}, mean: [${mean.join(', ')}], roughMean: ${roughMean}, bytes: ${bytes} },`).join('\n')}
];
`;
writeFileSync(join(ROOT, 'src', 'gfx', 'textureSet.js'), js);
const credits = `# Material textures

Scanned PBR textures for the realistic view (src/gfx/materialTextures.js), from
[Poly Haven](https://polyhaven.com), released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain;
credit is not required, but given gladly). Each folder holds the asset's ${RES}
maps repacked by tools/bake-material-textures.mjs: \`albedo.webp\` (diffuse) and
\`surface.webp\` (normal x and y, OpenGL convention, and roughness).

| Folder | Asset | Authors |
| --- | --- | --- |
${out.map((t) => `| ${t.id} | [${t.name}](https://polyhaven.com/a/${t.id}) | ${t.authors.join(', ')} |`).join('\n')}
`;
writeFileSync(join(ROOT, 'public', 'textures', 'CREDITS.md'), credits);
console.log(`wrote src/gfx/textureSet.js and public/textures/CREDITS.md; ${(out.reduce((s, t) => s + t.bytes, 0) / 1024).toFixed(0)} KB in all`);

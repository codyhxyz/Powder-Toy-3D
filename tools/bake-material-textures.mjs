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
  'rock_face_04',       // COAL: dark, cracked, layered rock face
  'gray_rocks',         // STONE: angular grey rubble
  'snow_02',            // SNOW: wind-crusted snow (flattened: ALBEDO_FLATTEN)
  'brown_mud_02',       // MUD: wet brown mud
  'clay_plaster',       // CLAY: smooth fine clay
  'moon_dusted_04',     // ASH: fine grey dust (lunar regolith: as fine and as grey as wood ash)
  'red_brick',          // BRICK: red clay brick in mortar (21.5 cm bricks: the scan's own size)
  'brick_gravel',       // RUBBLE: crushed brick
  'rusty_metal_02',     // SCRAP: scuffed, rust-spotted steel (its rust non-metal: METAL_MASK)
  'long_white_tiles',   // CERAMIC: glazed white tiles
  'leafy_grass',        // PLANT's grass (the big maps' meadows: appearance GRASS)
  'metal_plate',        // METAL: steel diamond plate (its paint and rust greyed: ALBEDO_FLATTEN)
  'blue_metal_plate',   // BATTERY, SWITCH, TSNS: painted steel panels (greyed, then painted each one's colour)
  'wood_chips',         // SAWDUST: fine wood chips
  'rust_coarse_01',     // THERMITE: coarse iron oxide
  'hessian_230',        // FUSE: coarse woven jute cord
  'forest_leaves_02',   // MOSS, NOITA_LUSH: moss clumps over a forest floor
  'concrete_floor_worn_001', // the small maps' floor (shaders/gfx/surface.js floorAlb): plain sealed concrete, scuffed
];
// WebP quality (cwebp -q) of each image: the albedo hides compression in its
// own grain; the normals show blocking as faceted light, so they keep more.
const ALBEDO_Q = 80;
const SURFACE_Q = 85;
const MASK_Q = 60;    // the metal mask (alpha): lossy, as smooth as the rust it follows
const MM_PER_M = 1000;
const SQUARE_JPG_Q = 95;   // JPEG quality of a scan's maps re-saved square (below)
// Albedos flattened before packing: desaturated, and every texel's departure
// from the mean scaled by `contrast`. Snow is calibrated ~2.4x brighter than
// the scan (its look's albedo 0.9 against the photo's 0.38), which made the
// photo's dark track marks stand out; real fresh snow barely varies in tone,
// so its relief is left to the normal map.
// Painted steel is greyed whole (contrast 1: only its colour goes), so each
// look paints it its own colour channel by channel without the blue showing
// through; the diamond plate's green paint and rust are greyed and calmed, as
// it stands for bare steel.
// The fuse's jute weave is drawn ~10x darker than the scan (tarred cord), where
// its threads' tone barely showed: its departures are scaled 2.5x (its look keeps
// the mean).
const ALBEDO_FLATTEN = { snow_02: { contrast: 0.35 }, metal_plate: { contrast: 0.7 }, blue_metal_plate: { contrast: 1 }, hessian_230: { contrast: 2.5 } };
const PERCENT = 100;
// Metal masks, in the albedo's alpha (1: bare metal, 0: not; an asset without
// one is opaque: all as its look says). Rust is iron oxide, a dielectric: drawn
// as metal it mirrored the sky in orange and read as gold flecks. Where the
// scan is saturated (rust's orange against the grey steel), the mask falls
// from 1 at saturation lo to 0 at hi (HSL saturation, 0-1). The view
// multiplies the look's metalness by it (shaders/gfx/surface.js matTextured).
const METAL_MASK = { rusty_metal_02: { lo: 0.2, hi: 0.35 } };
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
    // The texture array's layers are square (gfx/materialTextures.js): a scan
    // that isn't (hessian_230's 1024×1018) is stretched to its longer side,
    // a fraction of a percent, and drawn at that side's real size (tileM).
    for (const map of [diff, nor, rough]) {
      const [mw, mh] = magick(map, '-format', '%w %h', 'info:').split(' ').map(Number);
      if (mw !== mh) { const n = Math.max(mw, mh); magick(map, '-resize', `${n}x${n}!`, '-quality', String(SQUARE_JPG_Q), map); }
    }
    const dest = join(ROOT, 'public', 'textures', id);
    mkdirSync(dest, { recursive: true });
    const surfPng = join(dir, 'surface.png');
    // normal x, y and roughness into one rgb image
    magick(nor, '-separate', '(', rough, '-channel', 'R', '-separate', ')', '-delete', '2', '-set', 'colorspace', 'sRGB', '-combine', surfPng);
    const flat = ALBEDO_FLATTEN[id];
    const metalMask = METAL_MASK[id];
    const albedo = flat || metalMask ? join(dir, 'albedo.png') : diff;
    if (flat) {
      // grey, then u -> mean + (u - mean) * contrast; PNG24 keeps three channels (a grey png reads as one)
      const m = +magick(diff, '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:');
      magick(diff, '-colorspace', 'Gray', '-evaluate', 'multiply', String(flat.contrast),
        '-evaluate', 'add', `${m * (1 - flat.contrast) * PERCENT}%`, '-colorspace', 'sRGB', `PNG24:${albedo}`);
    }
    if (metalMask) {
      magick(diff, '(', '+clone', '-colorspace', 'HSL', '-channel', 'G', '-separate', '+channel',
        '-level', `${metalMask.lo * PERCENT}%,${metalMask.hi * PERCENT}%`, '-negate', ')',
        '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', `PNG32:${albedo}`);
    }
    execFileSync('cwebp', ['-quiet', '-q', String(ALBEDO_Q), '-m', '6', '-sharp_yuv', '-exact', '-alpha_q', String(MASK_Q), albedo, '-o', join(dest, 'albedo.webp')]);
    execFileSync('cwebp', ['-quiet', '-q', String(SURFACE_Q), '-m', '6', '-exact', surfPng, '-o', join(dest, 'surface.webp')]);
    // means: albedo decoded to linear (ImageMagick's RGB is linear), roughness as stored
    const mean = magick(albedo, '-colorspace', 'RGB', '-format', '%[fx:mean.r] %[fx:mean.g] %[fx:mean.b]', 'info:').split(/\s+/).map((v) => +(+v).toFixed(DECIMALS));
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

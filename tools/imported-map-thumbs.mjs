// CPU voxel renders of the shipped Cruelty source imports, NOT screenshots.
// Rebuild: node tools/imported-map-thumbs.mjs [--loading] [profile.id ...] (ImageMagick required).
// --loading renders dedicated 2560×1600 artwork from the cells, never upscales the card.
// Orthographic dollhouse views use the game's element colours, not source texture
// pixels (which the import does not ship). No actors, props or invented geometry.
// The three interior views are explicitly roof/upper-storey CUTAWAYS: cells at
// y >= ceiling are omitted for both camera and shadow rays. Camera framing also
// crops distant scenery; no source data or runtime scene is changed.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createImportedMapScene } from '../src/world/scenes/importedMap.js';
import { CRUELTY_PROFILES } from '../src/world/import/crueltyProfiles.js';
import { ELEMENTS, E } from '../src/elements.js';
import { trace } from './descent-thumb.mjs';

// Keys are profile.id, as registered by installProfile in localMap.js, NOT the
// scene keys (`${profile.id}Local`). Coordinates are shipped voxel coordinates.
export const VIEWS = {
  // Entry offices, central hall and courtyard/pool, with the roof removed.
  pharmakokinetiks: { target: [226, 49, 378], offset: [0.75, 1.6, -1], span: 370, ceiling: 60 },
  // Uncut exterior: the central neighbourhood and its intersecting streets.
  paradise: { target: [545, 320, 615], offset: [0.55, 1.35, -0.8], span: 1000 },
  // Police-station rooms, stairs and waterfront; upper floors removed.
  androgenAssault: { target: [355, 264, 425], offset: [0.65, 1.7, -0.85], span: 570, ceiling: 275 },
  // Close view of the playable apartment rooms, not the distant skyline slabs.
  apartmentAtrocity: { target: [322, 281, 380], offset: [0.8, 1.65, 1], span: 195, ceiling: 293 },
};
const unit = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const palette = ELEMENTS.map(e => {
  const hex = parseInt(e.color.slice(1), 16);
  return [hex >> 16 & 255, hex >> 8 & 255, hex & 255];
});

export function loadScene(id) {
  if (!Object.hasOwn(VIEWS, id) || !CRUELTY_PROFILES.some(p => p.id === id && !p.blocked)) throw new Error(`Unknown published preview: ${id}`);
  const manifestURL = new URL(`../public/local-maps/${id}.json`, import.meta.url);
  const map = JSON.parse(readFileSync(manifestURL, 'utf8'));
  if (map.id !== id) throw new Error(`Profile mismatch: ${id}`);
  const raw = gunzipSync(readFileSync(new URL(map.dataFile, manifestURL)));
  // One packed sparse scene (~13–30 MB), no enormous dense world/column cache.
  // Explicit LE decoding also makes generation portable to big-endian hosts.
  const words = new Uint32Array(raw.byteLength / 4);
  const data = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < words.length; i++) words[i] = data.getUint32(i * 4, true);
  return createImportedMapScene(map, words);
}

export function renderImported(scene, view, size = 400) {
  const [width, height] = Array.isArray(size) ? size : [size, size];
  const bounds = [...scene.size];
  bounds[1] = Math.min(bounds[1], view.ceiling ?? bounds[1]);
  const offset = unit(view.offset), forward = offset.map(x => -x);
  const right = unit(cross(forward, [0, 1, 0])), up = cross(right, forward);
  const distance = Math.hypot(...scene.size) * 2;
  const eye = view.target.map((v, a) => v + offset[a] * distance);
  const sun = unit([-0.55, 0.85, -0.35]);
  const sky = [174, 201, 223];
  const rgb = Buffer.alloc(width * height * 3), materials = new Map();
  let hits = 0;
  // Use the scene's actual sparse lookup; trace bounds apply only the documented
  // horizontal cut plane. Nothing is filled, recoloured or synthesized.
  const cell = (x, y, z) => scene.cell(x, y, z);
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const u = ((px + 0.5) / width - 0.5) * view.span * width / height;
    const v = (0.5 - (py + 0.5) / height) * view.span;
    const origin = eye.map((x, a) => x + right[a] * u + up[a] * v);
    const hit = trace(origin, forward, bounds, cell);
    let colour = sky;
    if (hit) {
      if (hit.id === E.EMPTY || scene.cell(...hit.at) !== hit.id) throw new Error('Render hit differs from shipped scene');
      hits++;
      const material = materials.get(hit.id) ?? { count: 0, at: hit.at };
      material.count++; materials.set(hit.id, material);
      const light = Math.max(0, dot(hit.normal, sun));
      const point = origin.map((x, a) => x + forward[a] * hit.distance + hit.normal[a] * 0.001);
      const shadow = light > 0 && trace(point, sun, bounds, cell);
      const shade = 0.48 + light * (shadow ? 0.1 : 0.62);
      colour = palette[hit.id].map(x => x * shade);
    }
    for (let a = 0; a < 3; a++) rgb[(py * width + px) * 3 + a] = Math.max(0, Math.min(255, Math.round(colour[a])));
  }
  return { rgb, hits, materials };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const loading = process.argv.includes('--loading');
  const ids = process.argv.slice(2).filter(a => a !== '--loading');
  const size = loading ? [2560, 1600] : [400, 400];
  const quality = loading ? 90 : 80;
  for (const id of ids.length ? ids : Object.keys(VIEWS)) {
    const start = performance.now();
    const scene = loadScene(id);
    const { rgb, hits, materials } = renderImported(scene, VIEWS[id], size);
    const file = fileURLToPath(new URL(`../public/maps/${id}${loading ? '-loading' : ''}.webp`, import.meta.url));
    execFileSync('magick', ['ppm:-', '-quality', String(quality), file], { input: Buffer.concat([Buffer.from(`P6\n${size.join(' ')}\n255\n`), rgb]) });
    console.log(JSON.stringify({ id, file, size, quality, cutaway: VIEWS[id].ceiling ?? null,
      hits, materials: Object.fromEntries([...materials].map(([id, stats]) => [ELEMENTS[id].name, stats])),
      seconds: +((performance.now() - start) / 1000).toFixed(2), gpuSeconds: 0 }));
  }
}

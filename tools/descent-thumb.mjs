// CPU render of Descent's home view: actual generated voxels and element palette,
// with software lighting (not a screenshot). No browser, simulation or GPU slot.
// Rebuild: node tools/descent-thumb.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { importedCell } from '../src/world/import/voxelize.js';
import { ELEMENTS, E } from '../src/elements.js';

const unit = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

// Exact voxel traversal, including entry from outside the world's bounds.
export function trace(origin, direction, size, cell) {
  let enter = 0, leave = Infinity, normal = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    if (direction[a] === 0) {
      if (origin[a] < 0 || origin[a] >= size[a]) return null;
      continue;
    }
    const t0 = -origin[a] / direction[a], t1 = (size[a] - origin[a]) / direction[a];
    const near = Math.min(t0, t1);
    if (near > enter) { enter = near; normal = [0, 0, 0]; normal[a] = -Math.sign(direction[a]); }
    leave = Math.min(leave, Math.max(t0, t1));
  }
  if (leave <= enter) return null;
  let distance = enter + 1e-6;
  const at = origin.map((x, a) => Math.floor(x + direction[a] * distance));
  const step = direction.map(Math.sign);
  const delta = direction.map(x => x === 0 ? Infinity : Math.abs(1 / x));
  const next = direction.map((x, a) => x === 0 ? Infinity : ((at[a] + (step[a] > 0 ? 1 : 0)) - origin[a]) / x);
  while (distance < leave && at.every((x, a) => x >= 0 && x < size[a])) {
    const id = cell(...at);
    if (id !== E.EMPTY) return { id, at: [...at], normal, distance };
    const a = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
    distance = next[a];
    at[a] += step[a];
    next[a] += delta[a];
    normal = [0, 0, 0]; normal[a] = -step[a];
  }
  return null;
}

export function renderDescent(size = 400) {
  // The first biome shows the spatial fold better than the initial sanctuary.
  const map = JSON.parse(readFileSync(new URL('../public/local-maps/noitaCoal.json', import.meta.url)));
  const bytes = gunzipSync(readFileSync(new URL(`../public/local-maps/${map.dataFile}`, import.meta.url)));
  const words = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const [sx, sy, sz] = map.size;
  const cache = new Uint16Array(sx * sy * sz).fill(65535);
  const cell = (x, y, z) => {
    const i = x + sx * (y + sy * z);
    if (cache[i] === 65535) cache[i] = importedCell(map, words, x, y, z);
    return cache[i];
  };
  const target = [256, 105, 256], eye = [-80, 320, -100];
  const forward = unit(target.map((x, a) => x - eye[a]));
  const right = unit(cross(forward, [0, 1, 0])), up = cross(right, forward);
  const fov = 0.35;
  const sun = unit([-0.55, 0.8, 0.35]);
  const palette = ELEMENTS.map(e => {
    const hex = parseInt(e.color.slice(1), 16);
    return [hex >> 16 & 255, hex >> 8 & 255, hex & 255];
  });
  const rgb = Buffer.alloc(size * size * 3);
  const materials = new Set();
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const u = (2 * (px + 0.5) / size - 1) * fov, v = (1 - 2 * (py + 0.5) / size) * fov;
    const direction = unit(forward.map((x, a) => x + right[a] * u + up[a] * v));
    const hit = trace(eye, direction, map.size, cell);
    const sky = [13, 17, 26];
    let colour = sky;
    if (hit) {
      materials.add(hit.id);
      const light = Math.max(0, dot(hit.normal, sun));
      const point = eye.map((x, a) => x + direction[a] * hit.distance + hit.normal[a] * 0.001);
      const shadow = light > 0 && trace(point, sun, map.size, cell);
      const shade = 0.5 + light * (shadow ? 0.12 : 0.7);
      const fog = Math.min(0.08, hit.distance / 5000);
      colour = palette[hit.id].map((x, a) => x * shade * (1 - fog) + sky[a] * fog);
    }
    for (let a = 0; a < 3; a++) rgb[(py * size + px) * 3 + a] = Math.max(0, Math.min(255, Math.round(colour[a])));
  }
  return { rgb, materials };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const start = performance.now();
  const { rgb, materials } = renderDescent();
  const file = fileURLToPath(new URL('../public/maps/descent.webp', import.meta.url));
  execFileSync('magick', ['ppm:-', '-quality', '80', file], { input: Buffer.concat([Buffer.from('P6\n400 400\n255\n'), rgb]) });
  console.log(`Descent: 400×400, ${materials.size} materials, ${((performance.now() - start) / 1000).toFixed(2)}s CPU, 0s GPU → ${file}`);
}

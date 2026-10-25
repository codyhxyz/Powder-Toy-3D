// CPU preview of actual generated voxels, adapted from descent-thumb.mjs.
// Software lighting, NOT a game screenshot. Clear panes/gases are omitted
// from the sightline; the authored frames and specimen geometry remain exact.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { E, ELEMENTS, R } from '../src/elements.js';
import { buildPreservation, PRESERVATION_SIZE } from '../src/lab/preservation/index.js';
import { trace } from './descent-thumb.mjs';

const unit = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((n, x, i) => n + x * b[i], 0);
export function preservationVolume() {
  const [nx, ny, nz] = PRESERVATION_SIZE, ids = new Uint8Array(nx * ny * nz);
  const index = (x, y, z) => (y * nz + z) * nx + x;
  buildPreservation({
    set(x, y, z, id) { ids[index(x, y, z)] = id; },
    box(x0, y0, z0, x1, y1, z1, id) {
      for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) ids.fill(id, index(x0, y, z), index(x1 - 1, y, z) + 1);
    },
  });
  return (x, y, z) => {
    const id = ids[index(x, y, z)];
    return [R.GLASS, R.GAS, R.NONE].includes(ELEMENTS[id].render) ? E.EMPTY : id;
  };
}
export function renderPreservation(size = 400, pose = 'arrival') {
  const cell = preservationVolume();
  const eye = pose === 'arrival' ? [20, 33, 28] : [184, 41, 92];
  const target = pose === 'arrival' ? [36, 34, 52] : [224, 32, 92];
  const forward = unit(target.map((x, a) => x - eye[a]));
  const right = unit(cross(forward, [0, 1, 0])), up = cross(right, forward), sun = unit([-0.3, 0.8, -0.1]);
  const fov = Math.tan(75 * Math.PI / 360);
  const palette = ELEMENTS.map(e => {
    const n = parseInt(e.color.slice(1), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  });
  const rgb = Buffer.alloc(size * size * 3), materials = new Set();
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (2 * (x + .5) / size - 1) * fov, v = (1 - 2 * (y + .5) / size) * fov;
    const direction = unit(forward.map((n, a) => n + right[a] * u + up[a] * v));
    const hit = trace(eye, direction, PRESERVATION_SIZE, cell);
    let color = [130, 155, 178];
    if (hit) {
      materials.add(hit.id);
      const point = eye.map((n, a) => n + direction[a] * hit.distance + hit.normal[a] * .001);
      const direct = Math.max(0, dot(hit.normal, sun));
      const shadow = direct > 0 && trace(point, sun, PRESERVATION_SIZE, cell);
      const shade = hit.id === E.LAMP ? 1.1 : .48 + direct * (shadow ? .1 : .52);
      color = palette[hit.id].map(n => n * shade);
    }
    for (let a = 0; a < 3; a++) rgb[(y * size + x) * 3 + a] = Math.max(0, Math.min(255, Math.round(color[a])));
  }
  return { rgb, materials };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { rgb, materials } = renderPreservation();
  execFileSync('magick', ['ppm:-', '-quality', '85', 'public/maps/preservationLab.webp'], {
    input: Buffer.concat([Buffer.from('P6\n400 400\n255\n'), rgb]),
  });
  console.log(`Preservation: actual geometry, ${materials.size} visible materials, software lighting, 0 GPU use.`);
}

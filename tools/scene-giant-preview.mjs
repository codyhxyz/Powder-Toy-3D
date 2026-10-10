// CPU previews and checks of the giant volcano (src/world/scenes/giantVolcano.js)
// from its JS twin: no GPU, fine on battery.
//
//   node tools/scene-giant-preview.mjs [out dir]
//
// Writes a top-down map (each column's topmost matter in its element's
// colour, darker the lower it stands) and a cross-section (x across, y up)
// through the summit. It also checks that the O(1) tree lookup finds every
// cell of every tree (each tree's shape, painted on its own, against what the
// scene says is there) and that ground() is the top of its column.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ELEMENTS, E } from '../src/elements.js';
import { giantVolcano, volcCell, volcTrees, volcTreePart, VOLC_TREE_BOX, VOLC_SIZE } from '../src/world/scenes/giantVolcano.js';

const OUT = process.argv[2] ?? join(tmpdir(), 'scene-giant');
const SEED = 20261008;            // a world seed (world/generator.js WORLD_SEED)
const SHADE_MIN = 0.35;           // a column at the bottom of the world is drawn this bright (1 at the top)
const SECTION_V = 1;              // the cross-section's pixels per cell up (as across: true to its shape)
const AIR = [235, 240, 248];      // the cross-section's air
const [WX, WY, WZ] = VOLC_SIZE;
mkdirSync(OUT, { recursive: true });

const rgb = (id) => { const n = parseInt(ELEMENTS[id].color.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

function png(file, w, h, px) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log(`wrote ${file}`);
}

let failures = 0;
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };

function preview(scene, cellId, sections) {
  const P = scene.params({ size: VOLC_SIZE, seed: SEED });
  const t0 = Date.now();
  const top = Buffer.alloc(WX * WZ * 3);
  const census = new Map();
  for (let z = 0; z < WZ; z++)
    for (let x = 0; x < WX; x++) {
      const g = scene.ground(x, z, P);
      const id = g > 0 ? cellId(x, g - 1, z) : E.EMPTY;
      if (g > 0 && id === E.EMPTY) fail(`${scene.key}: ground(${x}, ${z}) = ${g} but that cell is air`);
      census.set(ELEMENTS[id].key, (census.get(ELEMENTS[id].key) ?? 0) + 1);
      const k = SHADE_MIN + (1 - SHADE_MIN) * (g / WY);
      rgb(id).forEach((c, i) => { top[(z * WX + x) * 3 + i] = Math.round(c * k); });
    }
  png(join(OUT, `${scene.key}-top.png`), WX, WZ, top);
  const H = WY * SECTION_V;
  for (const zc of sections) {
    const sec = Buffer.alloc(WX * H * 3);
    for (let y = 0; y < WY; y++)
      for (let x = 0; x < WX; x++) {
        const id = cellId(x, y, zc);
        const c = id === E.EMPTY ? AIR : rgb(id);
        for (let r = 0; r < SECTION_V; r++) c.forEach((v, i) => { sec[(((WY - 1 - y) * SECTION_V + r) * WX + x) * 3 + i] = v; });
      }
    png(join(OUT, `${scene.key}-section-z${zc}.png`), WX, H, sec);
  }
  console.log(`${scene.key}: top elements`, Object.fromEntries(census), `start`, scene.start(P, [128, 128]).map(Math.round),
    `(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

preview(giantVolcano, (x, y, z) => volcCell(x, y, z, SEED), [WZ / 2]);

// every cell of every tree, as the scene sees it
const trees = volcTrees(SEED);
let cells = 0;
const B = VOLC_TREE_BOX;
for (const t of trees) {
  for (let y = t.base - B.below; y <= t.base + B.above; y++)
    for (let z = t.z - B.reach; z <= t.z + B.reach; z++)
      for (let x = t.x - B.reach; x <= t.x + B.reach; x++) {
        const want = volcTreePart(t, x, y, z);
        if (want === E.EMPTY) continue;
        cells++;
        const got = volcCell(x, y, z, SEED);
        if (got !== want) { fail(`tree at ${t.x}, ${t.z}: cell ${x}, ${y}, ${z} is ${ELEMENTS[got].key}, not ${ELEMENTS[want].key}`); break; }
      }
}
console.log(`giantVolcano: ${trees.length} trees, ${cells} tree cells all found by the lookup`);
console.log(failures ? `${failures} failure(s)` : 'all OK');
process.exit(failures ? 1 : 0);

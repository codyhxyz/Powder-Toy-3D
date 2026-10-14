// CPU-only check of react's compact stencil indices and boundary semantics.
// No browser/device. Optional --naga validates both paths, including debug.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { reactFrag } from '../src/shaders/react.js';

const grid = { nx: 32, ny: 32, nz: 32 };
const code = reactFrag(grid);
// Execute the actual scalar index formulas, not an independently maintained
// copy. This deliberately supports only these tiny helpers' WGSL subset.
function body(name) {
  const start = code.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, name);
  const open = code.indexOf('{', start);
  let end = open + 1, depth = 1;
  for (; depth; end++) {
    if (code[end] === '{') depth++;
    if (code[end] === '}') depth--;
  }
  return code.slice(open + 1, end - 1);
}
function scalarJS(text) {
  return text.replace(/\b(let|var)\b/g, 'let')
    .replace(/\b(\d+)u\b/g, '$1')
    .replace(/\b[ui]32\(/g, '(')
    .replace(/\b(l)\.([xyz])/g, (_, v, a) => `${v}[${'xyz'.indexOf(a)}]`);
}
const vec3i = (...v) => v;
const select = (a, b, condition) => condition ? b : a;
const tileIndex = new Function('l', scalarJS(body('reactTileIndex')));
const haloCell = new Function('k', 'vec3i', 'select', scalarJS(body('reactHaloCell')));
// cellOf's brick contribution is constant within the group; keep the actual
// atlas local-coordinate expression and lane decode from common.js.
const cellBody = body('cellOf');
assert.ok(cellBody.includes('brickCoord(s >> 6u) * BS + vec3i('));
const localCell = new Function('s', 'vec3i', scalarJS(cellBody.replace('brickCoord(s >> 6u) * BS + ', '')));
const own = (li) => localCell(li, vec3i);
const halo = (k) => haloCell(k, vec3i, select);
const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
assert.match(body('FACES'), /d\[i >> 1u\] = 1 - 2 \* \(i & 1\)/);
const add = (a, b) => a.map((x, i) => x + b[i]);
const allSlots = Array.from({ length: 64 }, (_, li) => own(li));
for (let li = 0; li < 64; li++) assert.equal(tileIndex(own(li)), li);
const writers = new Set();
for (let li = 0; li < 64; li++) for (let k = li; k < 96; k += 64) {
  assert.ok(!writers.has(k));
  writers.add(k);
  assert.equal(tileIndex(halo(k)), 64 + k);
  allSlots[64 + k] = halo(k);
}
assert.equal(writers.size, 96);
assert.equal(new Set(allSlots.map(String)).size, 160);
for (let li = 0; li < 64; li++) for (const face of faces) {
  const neighbor = add(own(li), face);
  assert.deepEqual(allSlots[tileIndex(neighbor)], neighbor);
}

// Every brick/cell/face of these grids, including corners, all six box faces,
// and a one-brick box (wrapped halos can alias an interior cell).
let groups = 0, neighborChecks = 0;
for (const dims of [[4, 4, 4], [8, 12, 16], [32, 32, 32]]) {
  const inGrid = (p) => p.every((x, i) => x >= 0 && x < dims[i]);
  for (const edge of ['loop', 'solid', 'void']) {
    const edgeCell = (p) => edge === 'loop' ? p.map((x, i) => (x + dims[i]) % dims[i]) : p;
    // Synthetic bit patterns for both vec4 payloads: no floating arithmetic.
    const fetch = (p) => {
      assert.ok(inGrid(p), `out-of-grid fetch: ${p}`);
      const s = p[0] + dims[0] * (p[1] + dims[1] * p[2]);
      return Array.from({ length: 8 }, (_, i) => (Math.imul(s + 1, 2654435761) ^ Math.imul(i + 1, 2246822519)) >>> 0);
    };
    for (let z = 0; z < dims[2]; z += 4) for (let y = 0; y < dims[1]; y += 4) for (let x = 0; x < dims[0]; x += 4) {
      const origin = [x, y, z];
      for (const quiet of [false, true]) for (const rays of [0, 1]) {
        groups++;
        const tile = [], loads = [];
        for (let li = 0; li < 64; li++) {
          tile[li] = fetch(add(origin, own(li)));
          loads.push(li);
        }
        if (!quiet || rays !== 0) for (let li = 0; li < 64; li++) for (let k = li; k < 96; k += 64) {
          const q = edgeCell(add(origin, halo(k)));
          if (inGrid(q)) { tile[64 + k] = fetch(q); loads.push(64 + k); }
        }
        assert.equal(new Set(loads).size, loads.length);
        assert.equal(loads.length, quiet && rays === 0 ? 64 : allSlots.filter((l) => inGrid(edgeCell(add(origin, l)))).length);
        for (let li = 0; li < 64; li++) {
          const p = add(origin, own(li)), a = fetch(p);
          assert.deepEqual(tile[li], a);
          if (quiet && rays === 0) continue;
          for (const face of faces) {
            const q = edgeCell(add(p, face));
            // As in reactCell: only in-grid neighbors read the tile; boundary
            // construction uses this cell's T/P (solid) or ambient (void).
            const boundary = edge === 'void' ? ['ambient', 0] : ['wall', a[1], a[7]];
            const expected = inGrid(q) ? fetch(q) : boundary;
            const actual = inGrid(q) ? tile[tileIndex(add(own(li), face))] : boundary;
            assert.deepEqual(actual, expected);
            neighborChecks++;
          }
        }
      }
    }
  }
}
assert.match(code, /if \(!quiet \|\| P.rays != 0u\)/);
assert.match(code, /let q = edgeCell\(origin \+ reactHaloCell\(k\)\);\s*if \(inGrid\(q\)\)/);
assert.match(code, /workgroupBarrier\(\);\s*if \(reactCell\(p, quiet, li\)\)/);
assert.match(code, /let faces = i32\(P.faces\)/);
const reference = reactFrag(grid, { tiled: false });
assert.ok(!reference.includes('reactTileIndex') && !reference.includes('reactA['));
assert.match(reference, /na\[i\] = fetchA\(q\)/);
console.log(`PASS: 64 own + 96 halo slots; 384 local neighbor indices; ${groups} group cases; ${neighborChecks} boundary/neighbor comparisons`);

if (process.argv.includes('--naga')) {
  const dir = mkdtempSync(join(tmpdir(), 'react-tile-check-'));
  try {
    let checked = 0;
    for (const dims of [[32, 32, 32], [160, 96, 160], [128, 384, 128]]) {
      for (const tiled of [false, true]) for (const debug of [false, true]) {
        const file = join(dir, `${dims.join('-')}-${tiled}-${debug}.wgsl`);
        writeFileSync(file, reactFrag({ nx: dims[0], ny: dims[1], nz: dims[2] }, { tiled, debug }));
        execFileSync('naga', [file], { stdio: 'inherit' });
        checked++;
      }
    }
    console.log(`PASS: Naga validation of ${checked} shaders (3 grids × tiled/reference × debug/production)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

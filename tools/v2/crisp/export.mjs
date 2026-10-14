// Export box presets as raw id grids (u8, x fastest, then z, then y) plus the element
// table fields the look mock needs. usage: node export.mjs <repo> <outdir>
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const R = process.argv[2], OUT = process.argv[3];
const S = await import(pathToFileURL(`${R}/src/sim.js`));
const P = await import(pathToFileURL(`${R}/src/presets.js`));
const { ELEMENTS } = await import(pathToFileURL(`${R}/src/elements.js`));

function dump(name, nx, ny, nz, tag = '') {
  const g = S.gridLayout(nx, ny, nz);
  let A = null;
  const sim = { g, cellTexel: (x, y, z) => S.cellTexel(g, x, y, z), load: (a) => { A = a; } };
  sim.blankState = S.Simulation.prototype.blankState.bind(sim);
  P.buildPreset(name, sim);
  const ids = new Uint8Array(nx * ny * nz), temp = new Float32Array(nx * ny * nz);
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const t = S.cellTexel(g, x, y, z) * 4, i = x + nx * (z + nz * y);
    ids[i] = A[t]; temp[i] = A[t + 1];
  }
  writeFileSync(`${OUT}/${name}${tag}.ids`, ids);
  writeFileSync(`${OUT}/${name}${tag}.temp`, Buffer.from(temp.buffer));
  return { name: name + tag, nx, ny, nz };
}
const grids = [dump('lab', 128, 128, 128), dump('volcano', 128, 128, 128), dump('lab', 64, 64, 64, '64'), dump('volcano', 64, 64, 64, '64')];
const els = ELEMENTS.map((e) => ({ key: e.key, kind: e.kind, render: e.render, color: e.color, var: e.var ?? 0,
  sigma: e.sigma ?? null, temp: e.temp ?? 20 }));
writeFileSync(`${OUT}/meta.json`, JSON.stringify({ grids, els }, null, 1));
console.log(grids);

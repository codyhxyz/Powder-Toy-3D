import { DataUtils } from 'three';
import { E, ELEMENTS, K, R } from '../elements.js';
import { runGenerator, bake, MAX_FOOT } from '../constructions/runtime.js';
import { BUILTINS } from '../constructions/builtins.js';
import { decodeBrick, BRICK_FLOATS } from './store.js';
import { buildSurfaceMesh } from './surfaceMesh.js';
import { buildFoliageMesh } from './foliageMesh.js';
import { isFoliageCell } from '../foliage.js';

const baked = new Map();
const inside = (p, b) => p.every((v, i) => v >= b[i] && v < b[i + 3]);

self.onmessage = ({ data: d }) => {
  try {
    const { token, raw, layout: L, origin, height, pad, bounds, live, planted, wb, trees, edits } = d;
    const sy = height + 2 * pad, size = [L.side, sy, L.side];
    const ids = new Uint8Array(L.side * sy * L.side), foliage = new Uint8Array(ids.length);
    const index = (x, y, z) => x + L.side * (y + sy * z);
    const localIndex = (p) => index(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
    const volume = [...origin, ...origin.map((v, i) => v + size[i])];
    // Scene/live cells: (id, °C) as halves, with bit 0 tagging foliage.
    // Integer ids have that bit clear; truncation still recovers the id.
    // Temperature's high half (including its sign) is untouched.
    for (let z = 0; z < L.side; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < L.side; x++) {
      const wy = y - pad, i = index(x, y, z);
      if (wy < 0) ids[i] = E.ROCK;
      else if (wy < height) {
        const word = raw[x + L.side * (z + L.side * wy)];
        ids[i] = Math.trunc(DataUtils.fromHalfFloat(word & 0xffff));
        foliage[i] = ids[i] === E.PLANT ? word & 1 : 0;
      }
    }
    // The same construction and rotation as WorldWindow.bakeTree. Only new
    // columns get generated trees: visited columns come from stored edits,
    // and the live window was captured directly on the GPU.
    for (const t of trees) {
      const key = `${t.seed},${t.size},${t.variant},${t.quarter}`;
      if (!baked.has(key)) {
        baked.set(key, bake(runGenerator(BUILTINS.TREE, { size: t.size, seed: t.seed, variant: t.variant }), t.quarter));
        if (baked.size > 256) baked.delete(baked.keys().next().value);
      }
      const s = baked.get(key);
      if (!s) continue;
      const at = [t.x - s.base.x, t.y - s.base.y, t.z - s.base.z];
      for (let z = 0; z < s.d; z++) for (let x = 0; x < s.w; x++) {
        const wx = at[0] + x, wz = at[2] + z;
        if (wx < origin[0] || wz < origin[2] || wx >= volume[3] || wz >= volume[5]) continue;
        if (wx < 0 || wz < 0 || wx >= wb[0] * 4 || wz >= wb[2] * 4) continue;
        if (planted[Math.floor(wx / 4) + wb[0] * Math.floor(wz / 4)]) continue;
        const base = (x + s.w * s.h * z) * 4;
        if (s.data[base] && s.data[base + 3] >= 0.5) {
          // Match stampMany's footing: fill air/liquid only when support is
          // reached within the construction's declared footing depth.
          const depth = Math.min(MAX_FOOT, s.foot), fill = [];
          for (let down = 1; down <= depth; down++) {
            const p = [wx, at[1] - down, wz];
            if (!inside(p, volume) || inside(p, live)) break;
            const kind = ELEMENTS[ids[localIndex(p)]].kind;
            if (kind !== K.EMPTY && kind !== K.GAS && kind !== K.LIQUID) {
              for (const at of fill) { ids[at] = s.data[base] - 1; foliage[at] = 0; }
              break;
            }
            fill.push(localIndex(p));
          }
        }
        for (let y = 0; y < s.h; y++) {
          // Baked stamps encode id + 1; zero means "do not overwrite".
          const p = [wx, at[1] + y, wz], cell = (x + s.w * (y + s.h * z)) * 4, encoded = s.data[cell];
          if (encoded && inside(p, volume) && !inside(p, live)) {
            const i = localIndex(p);
            ids[i] = encoded - 1;
            foliage[i] = isFoliageCell(ids[i], s.data[cell + 2]); // baked stamp z is ctype
          }
        }
      }
    }
    const A = new Float32Array(BRICK_FLOATS), B = new Float32Array(BRICK_FLOATS);
    for (const { at, bytes } of edits) {
      decodeBrick(bytes, A, 0, B, 0);
      for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const p = [at[0] + x, at[1] + y, at[2] + z];
        if (inside(p, volume) && !inside(p, live)) {
          const i = localIndex(p), cell = (x + 4 * (y + 4 * z)) * 4;
          ids[i] = A[cell];
          foliage[i] = isFoliageCell(ids[i], A[cell + 3]); // state A.w is ctype + seed, A.z is life
        }
      }
    }
    const liquid = ids.some((id) => ELEMENTS[id]?.render === R.LIQUID);
    // Leaves own separate cell-local clusters, never a closed surface-net crown.
    // Preserve the source ids for leaves and liquids; ground PLANT stays solid.
    const terrain = ids.slice();
    for (let i = 0; i < terrain.length; i++) if (foliage[i]) terrain[i] = E.EMPTY;
    const mesh = buildSurfaceMesh(terrain, { size, origin, bounds, step: token.step });
    const leaves = [0, 1].map(lod => buildFoliageMesh(ids, foliage, { size, origin, bounds, lod }));
    const transfer = [mesh, ...leaves].flatMap(m => Object.values(m).filter(a => ArrayBuffer.isView(a)).map(a => a.buffer));
    self.postMessage({ token, ...mesh, leaves, liquid }, [...new Set(transfer)]);
  } catch (err) {
    self.postMessage({ token: d.token, error: String(err.stack || err) });
  }
};

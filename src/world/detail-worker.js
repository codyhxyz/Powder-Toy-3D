import { DataUtils, BufferGeometry, BufferAttribute } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { E, ELEMENTS, K, R } from '../elements.js';
import { runGenerator, bake, MAX_FOOT } from '../constructions/runtime.js';
import { BUILTINS } from '../constructions/builtins.js';
import { decodeBrick, BRICK_FLOATS } from './store.js';
import { buildSurfaceMesh } from './surfaceMesh.js';

const baked = new Map();
const inside = (p, b) => p.every((v, i) => v >= b[i] && v < b[i + 3]);

self.onmessage = ({ data: d }) => {
  try {
    const { token, raw, layout: L, origin, height, pad, bounds, live, planted, wb, trees, edits } = d;
    const sy = height + 2 * pad, size = [L.side, sy, L.side];
    const ids = new Uint8Array(L.side * sy * L.side);
    const index = (x, y, z) => x + L.side * (y + sy * z);
    const localIndex = (p) => index(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
    const volume = [...origin, ...origin.map((v, i) => v + size[i])];
    for (let z = 0; z < L.side; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < L.side; x++) {
      const wy = y - pad;
      const texel = x + (z % L.cols) * L.side + (wy + Math.floor(z / L.cols) * height) * L.width;
      ids[index(x, y, z)] = wy < 0 ? E.ROCK : wy >= height ? E.EMPTY : DataUtils.fromHalfFloat(raw[texel * 4]);
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
              for (const at of fill) ids[at] = s.data[base] - 1;
              break;
            }
            fill.push(localIndex(p));
          }
        }
        for (let y = 0; y < s.h; y++) {
          // Baked stamps encode id + 1; zero means "do not overwrite".
          const p = [wx, at[1] + y, wz], encoded = s.data[(x + s.w * (y + s.h * z)) * 4];
          if (encoded && inside(p, volume) && !inside(p, live)) ids[localIndex(p)] = encoded - 1;
        }
      }
    }
    const A = new Float32Array(BRICK_FLOATS), B = new Float32Array(BRICK_FLOATS);
    for (const { at, bytes } of edits) {
      decodeBrick(bytes, A, 0, B, 0);
      for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const p = [at[0] + x, at[1] + y, at[2] + z];
        if (inside(p, volume) && !inside(p, live)) ids[localIndex(p)] = A[(x + 4 * (y + 4 * z)) * 4];
      }
    }
    const liquid = ids.some((id) => ELEMENTS[id]?.render === R.LIQUID);
    const mesh = buildSurfaceMesh(ids, { size, origin, bounds, step: token.step });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
    geometry.setAttribute('element', new BufferAttribute(mesh.ids, 1));
    const indexed = mergeVertices(geometry);
    mesh.positions = indexed.attributes.position.array;
    mesh.normals = indexed.attributes.normal.array;
    mesh.ids = indexed.attributes.element.array;
    mesh.indices = indexed.index.array;
    const transfer = Object.values(mesh).filter((a) => ArrayBuffer.isView(a)).map((a) => a.buffer);
    self.postMessage({ token, ...mesh, liquid }, [...new Set(transfer)]);
  } catch (err) {
    self.postMessage({ token: d.token, error: String(err.stack || err) });
  }
};

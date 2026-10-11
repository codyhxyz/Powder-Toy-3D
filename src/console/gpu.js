import * as THREE from 'three';
import { rawMat } from '../sim.js';
import { stateUniforms, SUPER_TEX } from '../shaders/common.js';
import { scriptEditFrag } from '../shaders/script.js';
import { EDIT_TEX_W } from './world.js';

// The console's GPU backend for ScriptWorld (console/world.js): reads blocks
// of the state back and applies queued edits with the script pass
// (shaders/script.js).
//
// A block is a supertile (shaders/common.js: 16 × 8 × 8 cells), one
// SUPER_TEX × SUPER_TEX square of the state atlas, numbered as the atlas
// numbers them, so a block reads back as one small rectangle.

// A read of at least this many blocks whose atlas rows hold at most
// ROW_READ_SPARE times as many blocks reads those rows in one rectangle
// instead of a rectangle per block.
const ROW_READ_MIN_BLOCKS = 8;
const ROW_READ_SPARE = 4;

export function createGpuBackend(getSim) {
  let mat = null, matSim = null, tex = null;
  const where = [0, 0];   // locate's result (reused)
  const T = SUPER_TEX, BLOCK_FLOATS = T * T * 4;

  // block i's square out of a rectangle of whole atlas rows from row r0
  function extract(i, a, b, g, r0) {
    const bx = (i % g.stw) * T, by = (Math.floor(i / g.stw) - r0) * T;
    const da = new Float32Array(BLOCK_FLOATS), db = new Float32Array(BLOCK_FLOATS);
    for (let ty = 0; ty < T; ty++) {
      const src = ((by + ty) * g.width + bx) * 4;
      da.set(a.subarray(src, src + T * 4), ty * T * 4);
      db.set(b.subarray(src, src + T * 4), ty * T * 4);
    }
    return { a: da, b: db };
  }

  return {
    epoch() { const s = getSim(); return `${s.id}:${s.origin.x},${s.origin.y},${s.origin.z}`; },
    size() { const g = getSim().g; return [g.nx, g.ny, g.nz]; },
    get blockCount() { const g = getSim().g; return g.stx * g.sty * g.stz; },
    blockTexels: T * T,

    locate(x, y, z) {
      const s = getSim(), g = s.g;
      const t = s.cellTexel(x, y, z);
      const u = t % g.width, v = Math.floor(t / g.width);
      where[0] = Math.floor(u / T) + g.stw * Math.floor(v / T);
      where[1] = (v % T) * T + (u % T);
      return where;
    },

    readBlocks(list, sync) {
      const s = getSim(), g = s.g;
      const out = new Map();
      const rows = list.map((i) => Math.floor(i / g.stw));
      const r0 = Math.min(...rows), r1 = Math.max(...rows);
      if (list.length >= ROW_READ_MIN_BLOCKS && (r1 - r0 + 1) * g.stw <= list.length * ROW_READ_SPARE) {
        const h = (r1 - r0 + 1) * T;
        const a = new Float32Array(g.width * h * 4), b = new Float32Array(g.width * h * 4);
        const done = () => { for (const i of list) out.set(i, extract(i, a, b, g, r0)); return out; };
        if (sync) { s.readStateRect(0, r0 * T, g.width, h, a, b); return done(); }
        return s.readStateRect(0, r0 * T, g.width, h, a, b, true).then(done);
      }
      const reads = list.map((i) => {
        const d = { a: new Float32Array(BLOCK_FLOATS), b: new Float32Array(BLOCK_FLOATS) };
        out.set(i, d);
        return s.readStateRect((i % g.stw) * T, Math.floor(i / g.stw) * T, T, T, d.a, d.b, !sync);
      });
      return sync ? out : Promise.all(reads).then(() => out);
    },

    applyEdits(chunk) {
      const s = getSim();
      if (matSim !== s) {
        mat?.dispose();
        mat = rawMat(scriptEditFrag(s.g), {
          ...stateUniforms(), tEdit: { value: null }, uCount: { value: 0 }, uRows: { value: 1 },
          uLo: { value: new THREE.Vector3() }, uHi: { value: new THREE.Vector3() },
        });
        mat.name = 'scriptEdit';
        matSim = s;
      }
      const h = chunk.rows * 3;
      if (!tex || tex.image.height !== h) {
        tex?.dispose();
        tex = new THREE.DataTexture(chunk.data, EDIT_TEX_W, h, THREE.RGBAFormat, THREE.FloatType);
      } else tex.image.data = chunk.data;
      tex.needsUpdate = true;
      const u = mat.uniforms;
      u.tEdit.value = tex;
      u.uCount.value = chunk.count;
      u.uRows.value = chunk.rows;
      u.uLo.value.fromArray(chunk.lo);
      u.uHi.value.fromArray(chunk.hi);
      for (const id of chunk.ids) s.rays.noteElement(id);   // an emitter (plutonium) wakes the particle layer, as the brush does
      s.touch(chunk.lo, chunk.hi);   // only the bricks there rebuild, only those supertiles wake (sim.js touch)
      s.pass(mat);
    },

    dispose() { mat?.dispose(); tex?.dispose(); mat = tex = matSim = null; },
  };
}

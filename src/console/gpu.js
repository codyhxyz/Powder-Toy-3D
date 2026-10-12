import { SUPER_TEX } from '../shaders/common.js';
import { ScriptEditParams, SCRIPT_EDIT_LAYOUT, scriptEditUpdateWGSL, scriptEditDeclsWGSL } from '../shaders/script.js';

// The console's GPU backend for ScriptWorld (console/world.js): reads blocks
// of the state back and applies queued edits with the script edit
// (shaders/script.js: sim.edit over the batch's box, in place).
//
// A block is a supertile (shaders/common.js: 16 × 8 × 8 cells), one
// SUPER_TEX × SUPER_TEX square of the state atlas, numbered as the atlas
// numbers them, so a block reads back as one small rectangle
// (sim.readStateRect).
//
// Every read is asynchronous (docs/webgpu.md W6). A typed command's reads,
// which the WebGL build made synchronously (one stall per block), wait for
// the GPU instead: readBlocks(list, true) throws an error carrying retry(),
// which records the read and resolves once its blocks are here; the console
// runs a typed command as a coroutine (console/lua.js), so the builtin that
// read yields there, the console flushes the command's writes, awaits retry()
// and resumes the coroutine, and the builtin runs again and finds its blocks
// (served once, to that retry). So a command still reads the world exactly as
// its own writes and steps left it, a few frames later instead of a stall.

// A read of at least this many blocks whose atlas rows hold at most
// ROW_READ_SPARE times as many blocks reads those rows in one rectangle
// instead of a rectangle per block.
const ROW_READ_MIN_BLOCKS = 8;
const ROW_READ_SPARE = 4;
// The edits' storage buffer starts this big (bytes) and doubles as needed.
const EDIT_BUFFER_MIN = 64 * 1024;

export function createGpuBackend(getSim) {
  let kernel = null, kernelSim = null, buffer = null, bufferGpu = null;
  let queued = [];        // edit chunks waiting for the kernel to build (applied in order)
  let fetched = null;     // { epoch, map }: the blocks a typed command's retry brought in
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

  // the edit kernel for the current simulation (made per simulation: its grid's)
  function kernelFor(s) {
    if (kernelSim !== s) {
      kernel = s.editKernel('scriptEdit', {
        update: scriptEditUpdateWGSL, params: ScriptEditParams, reads: 'own', decls: scriptEditDeclsWGSL, layout: SCRIPT_EDIT_LAYOUT,
      });
      kernelSim = s;
      queued = [];
    }
    return kernel;
  }
  const built = (k) => k.main.state === 'ready';

  // one chunk's edit (the sim's current simulation, its kernel built)
  function apply(s, chunk) {
    const bytes = chunk.data.byteLength;
    let old = null;
    if (!buffer || buffer.size < bytes || bufferGpu !== s.gpu) {
      let size = EDIT_BUFFER_MIN;
      while (size < bytes) size *= 2;
      if (bufferGpu === s.gpu) old = buffer; else buffer?.destroy();
      buffer = s.gpu.createBuffer({ label: 'console edits', size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      bufferGpu = s.gpu;
    }
    // (ordered: the open frame, which may read the buffer as it was, is submitted first)
    s.gpu.write(buffer, 0, chunk.data);
    // a buffer it outgrew goes once the work submitted with it is done
    if (old) s.gpu.queue.onSubmittedWorkDone().then(() => old.destroy(), () => old.destroy());
    for (const id of chunk.ids) s.rays.noteElement(id);   // an emitter (plutonium) wakes the particle layer, as the brush does
    // cells given a new element lose their paint, as after a brush stroke (src/deco.js)
    s.edit(kernel, { lo: chunk.lo, hi: chunk.hi }, { count: chunk.count, rows: chunk.rows }, { bind: [{ buffer }], scrub: true });
  }

  // Resolves once the edit kernel is built and every edit queued meanwhile is recorded.
  function settled(s) {
    const k = kernelFor(s);
    if (built(k)) return Promise.resolve();
    return k.ready.then(() => {
      if (kernelSim !== s || s.disposed) return;
      const list = queued;
      queued = [];
      for (const c of list) apply(s, c);
    });
  }

  // The blocks in `list`, read now (recorded at this call, or once the edit
  // kernel is built and the edits queued for it are in): a promise of a Map.
  function read(list) {
    const s = getSim(), g = s.g;
    const out = new Map();
    if (!list.length) return Promise.resolve(out);
    const record = () => {
      if (s.disposed) throw new Error('console: the grid changed while reading it');
      const rows = list.map((i) => Math.floor(i / g.stw));
      const r0 = Math.min(...rows), r1 = Math.max(...rows);
      if (list.length >= ROW_READ_MIN_BLOCKS && (r1 - r0 + 1) * g.stw <= list.length * ROW_READ_SPARE) {
        const h = (r1 - r0 + 1) * T;
        const a = new Float32Array(g.width * h * 4), b = new Float32Array(g.width * h * 4);
        return s.readStateRect(0, r0 * T, g.width, h, a, b, true).then(() => {
          for (const i of list) out.set(i, extract(i, a, b, g, r0));
          return out;
        });
      }
      return Promise.all(list.map((i) => {
        const d = { a: new Float32Array(BLOCK_FLOATS), b: new Float32Array(BLOCK_FLOATS) };
        out.set(i, d);
        return s.readStateRect((i % g.stw) * T, Math.floor(i / g.stw) * T, T, T, d.a, d.b, true);
      })).then(() => out);
    };
    return built(kernelFor(s)) ? record() : settled(s).then(record);
  }

  const backend = {
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

    // sync: a typed command's read. Its blocks if a retry brought them in;
    // else it throws, and the error's retry() reads them (see the top).
    readBlocks(list, sync) {
      if (!sync) return read(list);
      const epoch = backend.epoch();
      if (fetched?.epoch === epoch && list.every((i) => fetched.map.has(i))) {
        const out = new Map(list.map((i) => [i, fetched.map.get(i)]));
        fetched = null;
        return out;
      }
      fetched = null;
      const err = new Error('console: this read waits for the GPU (a typed command reads as a coroutine: console/lua.js)');
      err.retry = () => read(list).then((map) => { fetched = { epoch, map }; });
      throw err;
    },

    applyEdits(chunk) {
      const s = getSim();
      if (built(kernelFor(s))) { apply(s, chunk); return; }
      // the first batch on a grid waits for its kernel: kept (the chunk's data
      // is its own) and applied in order once it is built; reads wait for them
      queued.push(chunk);
      if (queued.length === 1) settled(s).catch((err) => console.error('console: the edit kernel failed to build', err));
    },

    dispose() { buffer?.destroy(); buffer = bufferGpu = kernel = kernelSim = fetched = null; queued = []; },
  };
  return backend;
}

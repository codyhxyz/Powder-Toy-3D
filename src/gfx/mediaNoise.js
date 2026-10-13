// Tileable 3D detail noise for smoke, steam and fire (shaders/gfx/media.js),
// built once on the CPU. One tile spans MEDIA_NOISE_CELLS world cells.
//   r  billows: inverted Worley (cellular) fBm, the cauliflower puffs of
//      steam and smoke
//   g  wisps: Perlin fBm, streakier than the billows, frays thin gas
//   b  flame tongues (read stretched along y): Perlin fBm, another seed
//   a  flame flicker: Perlin fBm, another seed
// g, b and a together also make the vector that curls (domain-warps) the gas.
// Every channel is histogram-equalised to uniform on [0, 1] (mean 0.5), so
// the shader can modulate density around its mean without biasing it.
// It is a 64³ rgba8unorm 3D texture in the render kernels' lighting group
// (shaders/bindings.js binding 10, sampled with linearRepeat).
import { idleCallback } from '../gpu/kernels.js';

export const MEDIA_NOISE_SIZE = 64;   // texels per side

// Lattice periods (cells per tile) of each channel's octaves, coarse to fine,
// and the octave weights (each octave halves). The finest keeps 4 texels per
// lattice cell: coarser lattices filter into facets, which sharp density
// edges (flames) then trace as terraces.
const BILLOW_PERIODS = [4, 8, 16];
const WISP_PERIODS = [5, 10, 16];
const TONGUE_PERIODS = [4, 8, 16];
const FLICKER_PERIODS = [4, 8, 16];
const OCTAVE_WEIGHTS = [0.57, 0.29, 0.14];
// the finest lattice period of any channel (lattice cells per tile): close-up
// detail (shaders/gfx/mediaDetail.js) reads the tile scaled down from here
export const NOISE_FINEST_PERIOD = Math.max(...BILLOW_PERIODS, ...WISP_PERIODS, ...TONGUE_PERIODS, ...FLICKER_PERIODS);
// Hash seeds of the channels (each octave adds its index), so they're independent.
const BILLOW_SEED = 11, WISP_SEED = 23, TONGUE_SEED = 37, FLICKER_SEED = 53;
const HIST_BINS = 4096;               // equalisation histogram resolution
const TEXEL_MAX = 255;                // 8-bit texel value of 1.0

// Integer lattice hash to [0, 1): large odd multipliers per coordinate, then an
// xorshift-multiply avalanche (the constants are the hash's, not tuning).
function hash(i, j, k, seed) {
  let h = (i * 374761393 + j * 668265263 + k * 2147483647 + seed * 974634541) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const wrap = (i, p) => (i < 0 ? i + p : i >= p ? i - p : i);   // i is at most one period out

// Per-lattice-point tables for period p: feature points (Worley) and
// gradients (Perlin), 3 floats each.
function table(p, seed, make) {
  const t = new Float32Array(p * p * p * 3);
  for (let i = 0; i < p * p * p; i++) make(t, i * 3, seed + i * 3);
  return t;
}
const featurePoints = (p, seed) => table(p, seed, (t, o, h) => {
  for (let c = 0; c < 3; c++) t[o + c] = hash(h, c, p, seed);
});
// Perlin's 12 edge gradients
const GRAD = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
const gradients = (p, seed) => table(p, seed, (t, o, h) => t.set(GRAD[Math.floor(hash(h, 0, p, seed) * GRAD.length)], o));

// Worley F1 distance (in lattice cells) with period p, at lattice coords (x, y, z).
function worley(fp, p, x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let d = 9;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const o = ((wrap(iz + dz, p) * p + wrap(iy + dy, p)) * p + wrap(ix + dx, p)) * 3;
        const fx = ix + dx + fp[o] - x, fy = iy + dy + fp[o + 1] - y, fz = iz + dz + fp[o + 2] - z;
        d = Math.min(d, fx * fx + fy * fy + fz * fz);
      }
  return Math.sqrt(d);
}

// Perlin gradient noise with period p, roughly in [-1, 1].
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
function perlin(gr, p, x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  let s = 0;
  for (let c = 0; c < 8; c++) {
    const ox = c & 1, oy = (c >> 1) & 1, oz = c >> 2;
    const o = ((wrap(iz + oz, p) * p + wrap(iy + oy, p)) * p + wrap(ix + ox, p)) * 3;
    const dot = gr[o] * (fx - ox) + gr[o + 1] * (fy - oy) + gr[o + 2] * (fz - oz);
    s += dot * (ox ? u : 1 - u) * (oy ? v : 1 - v) * (oz ? w : 1 - w);
  }
  return s;
}

// fBm of noise fn over the whole tile (N^3 texels), sign = +1 or -1, into
// out; a generator that yields after every z plane of an octave (~1-2 ms of
// Worley), so the tile can be built in short tasks (createMediaNoise).
function* fbmTile(N, fn, makeTable, periods, seed, sign, out) {
  for (let o = 0; o < periods.length; o++) {
    const p = periods[o];
    const t = makeTable(p, seed + o), k = p / N, wgt = sign * OCTAVE_WEIGHTS[o];
    for (let z = 0, i = 0; z < N; z++) {
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++, i++) out[i] += wgt * fn(t, p, (x + 0.5) * k, (y + 0.5) * k, (z + 0.5) * k);
      yield;
    }
  }
}

// Remap values to their rank: uniform on [0, 1] (a generator: it yields between its passes).
function* equalise(vals) {
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const k = (HIST_BINS - 1) / (hi - lo || 1);
  const cdf = new Float64Array(HIST_BINS);
  for (const v of vals) cdf[Math.round((v - lo) * k)]++;
  yield;
  let acc = 0;
  for (let i = 0; i < HIST_BINS; i++) { const c = cdf[i]; cdf[i] = (acc + 0.5 * c) / vals.length; acc += c; }
  const eq = vals.map((v) => cdf[Math.round((v - lo) * k)]);
  yield;
  return eq;
}

// The tile's texels, x fastest, 4 bytes each (r, g, b, a as above), as a
// generator of steps of a few ms each; its return value is the bytes.
function* mediaNoiseSteps() {
  const N = MEDIA_NOISE_SIZE, n3 = N * N * N;
  const channels = [
    [worley, featurePoints, BILLOW_PERIODS, BILLOW_SEED, -1],   // inverted: puffs around the feature points
    [perlin, gradients, WISP_PERIODS, WISP_SEED, 1],
    [perlin, gradients, TONGUE_PERIODS, TONGUE_SEED, 1],
    [perlin, gradients, FLICKER_PERIODS, FLICKER_SEED, 1],
  ];
  const data = new Uint8Array(n3 * 4);
  for (let c = 0; c < channels.length; c++) {
    const [fn, makeTable, periods, seed, sign] = channels[c];
    const raw = new Float32Array(n3);
    yield* fbmTile(N, fn, makeTable, periods, seed, sign, raw);
    const eq = yield* equalise(raw);
    for (let i = 0; i < n3; i++) data[i * 4 + c] = Math.round(eq[i] * TEXEL_MAX);
    yield;
  }
  return data;
}

// The tile's texels at once (x fastest, 4 bytes each).
export function mediaNoiseData() {
  const steps = mediaNoiseSteps();
  for (;;) { const r = steps.next(); if (r.done) return r.value; }
}

// Building the tile takes about half a second of CPU, so it happens after
// startup, in tasks of at most TASK_MS at idle time (docs/webgpu.md goal 4:
// no long main-thread task while pipelines build); until then every texel is
// neutral (each channel at its mean) and the gas draws without detail. The
// texture is made at its full size at once and filled in place, so the bind
// groups holding it never change.
const NEUTRAL = 128;
const TASK_MS = 8;
const TEX = { COPY_DST: 0x02, TEXTURE_BINDING: 0x04 };   // (GPUTextureUsage's bits)

/**
 * The device's media noise texture (one per device): { texture, view, ready },
 * ready resolving once the tile is in it.
 * @param {object} gpu
 */
export function createMediaNoise(gpu) {
  if (gpu._mediaNoise) return gpu._mediaNoise;
  const N = MEDIA_NOISE_SIZE;
  const texture = gpu.createTexture({
    label: 'media noise', size: [N, N, N], dimension: '3d', format: 'rgba8unorm', usage: TEX.TEXTURE_BINDING | TEX.COPY_DST,
  });
  const write = (data) => gpu.queue.writeTexture({ texture }, data, { bytesPerRow: N * 4, rowsPerImage: N }, [N, N, N]);
  write(new Uint8Array(N * N * N * 4).fill(NEUTRAL));
  // (a write lands before the next submit: a frame already recorded draws the tile a frame early, harmlessly)
  const ready = new Promise((resolve) => {
    const steps = mediaNoiseSteps();
    const pump = () => {
      if (gpu.failure || gpu.lost) { resolve(); return; }
      const t0 = performance.now();
      let r;
      do r = steps.next(); while (!r.done && performance.now() - t0 < TASK_MS);
      if (!r.done) { idleCallback(pump); return; }
      write(r.value);
      resolve();
    };
    idleCallback(pump);
  });
  gpu._mediaNoise = { texture, view: texture.createView({ label: 'media noise', dimension: '3d' }), ready };
  return gpu._mediaNoise;
}

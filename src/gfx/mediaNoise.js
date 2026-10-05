import * as THREE from 'three';

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
const HIST_BINS = 4096;               // equalisation histogram resolution

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

// fBm of noise fn over the whole tile (N^3 texels), sign = +1 or -1.
function fbmTile(N, fn, makeTable, periods, seed, sign) {
  const out = new Float32Array(N * N * N);
  periods.forEach((p, o) => {
    const t = makeTable(p, seed + o), k = p / N, wgt = sign * OCTAVE_WEIGHTS[o];
    for (let z = 0, i = 0; z < N; z++)
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++, i++) out[i] += wgt * fn(t, p, (x + 0.5) * k, (y + 0.5) * k, (z + 0.5) * k);
  });
  return out;
}

// Remap values to their rank: uniform on [0, 1].
function equalise(vals) {
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const k = (HIST_BINS - 1) / (hi - lo || 1);
  const cdf = new Float64Array(HIST_BINS);
  for (const v of vals) cdf[Math.round((v - lo) * k)]++;
  let acc = 0;
  for (let i = 0; i < HIST_BINS; i++) { const c = cdf[i]; cdf[i] = (acc + 0.5 * c) / vals.length; acc += c; }
  return vals.map((v) => cdf[Math.round((v - lo) * k)]);
}

export function createMediaNoise() {
  const N = MEDIA_NOISE_SIZE, n3 = N * N * N;
  const ch = [
    fbmTile(N, worley, featurePoints, BILLOW_PERIODS, 11, -1),   // inverted: puffs around the feature points
    fbmTile(N, perlin, gradients, WISP_PERIODS, 23, 1),
    fbmTile(N, perlin, gradients, TONGUE_PERIODS, 37, 1),
    fbmTile(N, perlin, gradients, FLICKER_PERIODS, 53, 1),
  ];
  const eq = ch.map(equalise);
  const data = new Uint8Array(n3 * 4);
  for (let i = 0; i < n3; i++)
    for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(eq[c][i] * 255);
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// Uniform holding the noise. Building it takes a few hundred ms of CPU, so it
// happens after startup; until then a neutral texel (every channel at its
// mean) draws the gas without detail.
const NEUTRAL = 128;
export function mediaNoiseUniform() {
  const tex = new THREE.Data3DTexture(new Uint8Array(4).fill(NEUTRAL), 1, 1, 1);
  tex.needsUpdate = true;
  const u = { value: tex };
  setTimeout(() => { u.value = createMediaNoise(); tex.dispose(); }, 0);
  return u;
}

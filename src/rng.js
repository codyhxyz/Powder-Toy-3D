// Seeded randomness and integer hashes the JS side shares: the same seed rolls
// the same shop, wand, tile scene or construction on every machine (Noita seeds
// every temple's stock from the world seed and the temple's place). Pure: node
// checks import it. GPU twins (shaders/common.js pcg, shaders/far.js mulberry32)
// mirror these and stay where they are.

// FNV-1a over a string's UTF-16 code units → uint32
const FNV_OFFSET = 0x811c9dc5, FNV_PRIME = 0x01000193;
export function hashString(s) {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, FNV_PRIME); }
  return h >>> 0;
}

// mix uint32s into one (a seed per site: run, level, index); murmur3's finalizer per step
const MIX_START = 0x9e3779b9;   // the golden-ratio constant: no zero start
export function mixSeed(...xs) {
  let h = MIX_START;
  for (const x of xs) {
    h = (h ^ (x >>> 0)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h;
}

// mulberry32: a small uint32 seed → a [0, 1) stream
const MULBERRY_STEP = 0x6d2b79f5;
const UINT_RANGE = 4294967296;   // 2^32: a uint32 to [0, 1)
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + MULBERRY_STEP) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT_RANGE;
  };
}

// PCG hash (uint32 → uint32), as shaders/common.js's pcg
export function pcg(v) {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

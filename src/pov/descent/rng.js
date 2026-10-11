// Seeded randomness for the Holy Mountain: the same run seed and level roll the
// same shop and the same nuggets (Noita seeds every temple's stock from the
// world seed and the temple's place). Pure: node checks import it.

// FNV-1a over a string (a level key) → uint32
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// mix uint32s into one (a seed per site: run, level, index); murmur3's finalizer per step
export function mixSeed(...xs) {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = (h ^ (x >>> 0)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h;
}

// mulberry32: a small uint32 seed → a [0, 1) stream
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

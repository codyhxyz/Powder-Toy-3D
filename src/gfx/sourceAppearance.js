import { gpuSafeMode } from '../startupSafety.js';

// A source level's read-only appearance shares the far grid's allocation,
// after its terrain Y planes. The far view already uses all 16 texture slots;
// each rgba16uint texel carries two exact u32 words, with no new binding.
export function appearanceRegion(bricks, wordCount = 0, maxDimension = 2048) {
  if (!Number.isSafeInteger(wordCount) || wordCount < 0) throw new Error('Invalid appearance word count');
  const [x, y, z] = bricks;
  const planes = Math.ceil(wordCount / (2 * x * z));
  if (y + planes > maxDimension) throw new Error('Source appearance exceeds the device texture limit');
  return { size: [x, y + planes, z], planes, uniform: [y, wordCount, x, z] };
}

export function packAppearancePlanes(words, region) {
  if (!(words instanceof Uint32Array) || words.length !== region.uniform[1]) throw new Error('Appearance word count differs from its manifest');
  const [x, , z] = region.size, y = region.planes;
  const packed = new Uint16Array(x * y * z * 4);
  for (let i = 0; i < words.length; i++) {
    const t = Math.floor(i / 2), px = t % x, pz = Math.floor(t / x) % z, py = Math.floor(t / (x * z));
    const at = 4 * (px + x * (py + y * pz)) + (i % 2) * 2;
    packed[at] = words[i] & 65535;
    packed[at + 1] = words[i] >>> 16;
  }
  return packed;
}

export function uploadAppearance(gpu, texture, words, region) {
  if (!region.planes) return;
  const [x, , z] = region.size;
  gpu.queue.writeTexture(
    { texture, origin: [0, region.uniform[0], 0] },
    packAppearancePlanes(words, region),
    { bytesPerRow: x * 8, rowsPerImage: region.planes },
    [x, region.planes, z],
  );
}
// Exact word-range update. Expand to u32 pairs so untouched neighbour words
// survive, then split at X rows (which also handles Y-plane/Z transitions).
export function uploadAppearanceRange(gpu, texture, words, region, from, count) {
  if (!(words instanceof Uint32Array) || words.length !== region.uniform[1] ||
      !Number.isSafeInteger(from) || !Number.isSafeInteger(count) || from < 0 || count < 0 || from + count > words.length) throw new Error('Invalid appearance update range');
  if (!count) return;
  const [x, , z] = region.size;
  let pair = Math.floor(from / 2), end = Math.ceil((from + count) / 2);
  while (pair < end) {
    const px = pair % x, pz = Math.floor(pair / x) % z, py = Math.floor(pair / (x*z));
    const n = Math.min(end-pair, x-px), packed = new Uint16Array(n*4);
    for (let i=0;i<n*2;i++) {
      const word = words[pair*2+i] ?? 0;
      packed[i*2]=word&65535; packed[i*2+1]=word>>>16;
    }
    gpu.queue.writeTexture({ texture, origin: [px, region.uniform[0]+py, pz] }, packed,
      { bytesPerRow: n*8, rowsPerImage: 1 }, [n,1,1]);
    pair += n;
  }
}
// Evaluated before WGSL generation, not a shader uniform. The recovery link
// excludes source shaders, downloads and allocations without changing saves.
export const SOURCE_APPEARANCE_ENABLED = !gpuSafeMode();

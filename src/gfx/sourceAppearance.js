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
// The renderer separately specializes shaders for source-capable scenes.
export const SOURCE_APPEARANCE_ENABLED = true;

import { ELEMENTS } from '../../../elements.js';

export const OUTSIDE = 255;
export const PALETTE_WORDS = 256;

export function validateTerrainManifest(route) {
  if (route.version !== 1 || route.encoding !== 'noita-folded-raster-u8-v1') throw new Error('Unsupported terrain raster');
  if (!Array.isArray(route.palette) || route.palette.length < 1 || route.palette.length > 255 || route.palette[0].name !== 'air' || route.palette[0].element !== 0) throw new Error('Invalid native terrain palette');
  for (const p of route.palette) if (!p.name || !Number.isInteger(p.element) || !ELEMENTS[p.element]) throw new Error(`Unmapped native material: ${p.name}`);
  if (!Number.isSafeInteger(route.fold.sourceWidth) || route.fold.sourceWidth <= 0) throw new Error('Invalid raster width');
  for (const [i,r] of route.regions.entries()) {
    const coreHeight=r.core[1]-r.core[0], terminal=i===route.regions.length-1;
    if (r.sourceHeight !== 320 || !Number.isInteger(r.sourceTop) || r.core[0] !== r.sourceTop + 32 || coreHeight <= 0 || coreHeight > 256 || (!terminal && coreHeight !== 256) || (i > 0 && route.regions[i-1].core[1] !== r.core[0]) || !/^[a-f0-9]{64}$/.test(r.sha256) || !r.file.endsWith('.binpack')) throw new Error(`Invalid terrain band: ${r.key}`);
  }
}

export function nativeIndex(words, index) {
  return (words[index >>> 2] >>> ((index & 3) * 8)) & 255;
}

// Read-only validation and packing: never replace native IDs with physical IDs.
export async function prepareTerrainWords(route, region, words) {
  const n = route.fold.sourceWidth * region.sourceHeight;
  if (words.length !== Math.ceil(n / 4)) throw new Error(`Truncated terrain raster: ${region.key}`);
  const bytes = new Uint8Array(words.length * 4), view = new DataView(bytes.buffer);
  for (let i = 0; i < words.length; i++) view.setUint32(i * 4, words[i], true);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  if (hash !== region.sha256) throw new Error(`Terrain checksum mismatch: ${region.key}`);
  for (let i = 0; i < n; i++) if (bytes[i] !== OUTSIDE && bytes[i] >= route.palette.length) throw new Error(`Unknown native palette index ${bytes[i]} at ${i}`);
  const packed = new Uint32Array(PALETTE_WORDS + words.length);
  route.palette.forEach((p, i) => { packed[i] = p.element; });
  packed.set(words, PALETTE_WORDS);
  return packed;
}

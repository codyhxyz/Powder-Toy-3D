import { ELEMENTS, K } from '../../../elements.js';
import { appearanceCtype, materialWord } from '../../../appearance.js';

export const OUTSIDE = 255;
export const PALETTE_WORDS = 256;
export const ENCODING = 'noita-folded-raster-u8-v2';
// Every band is this tall (32 rows of context, 256 core rows, 32 context).
export const BAND_HEIGHT = 320;
const OPEN_KINDS = new Set([K.EMPTY, K.LIQUID, K.GAS]);

// One band's payload: the native plane (immutable source bytes), the inflation
// depth plane (half cells; 0 = closed pixel) and the per-block backdrop plane.
// Byte offsets are the same for every band, so every band shares one shader.
export function terrainLayout(route) {
  const width = route.fold.sourceWidth, block = route.inflation.backdropBlock;
  const pixels = width * BAND_HEIGHT, blockWidth = width / block;
  const blocks = blockWidth * (BAND_HEIGHT / block);
  return { width, block, blockWidth, pixels, blocks, depthAt: pixels, backdropAt: 2 * pixels,
    bytes: 2 * pixels + blocks, words: Math.ceil((2 * pixels + blocks) / 4), maxDepth: 2 * route.inflation.maxHalfDepth };
}

export function validateTerrainManifest(route) {
  if (route.version !== 2 || route.encoding !== ENCODING) throw new Error('Unsupported terrain raster');
  if (!Array.isArray(route.palette) || route.palette.length < 1 || route.palette.length > 255 || route.palette[0].name !== 'air' || route.palette[0].element !== 0) throw new Error('Invalid native terrain palette');
  const names = new Set();
  for (const p of route.palette) {
    if (!p.name || names.has(p.name) || !Number.isInteger(p.element) || !ELEMENTS[p.element] ||
        (p.element === 0) !== (p.name === 'air')) throw new Error(`Unmapped native material: ${p.name}`);
    if (p.appearance !== undefined) appearanceCtype(p.element, 0, p.appearance);   // throws on a label its element can't carry
    names.add(p.name);
  }
  if (!Number.isSafeInteger(route.fold.sourceWidth) || route.fold.sourceWidth <= 0) throw new Error('Invalid raster width');
  const { maxHalfDepth: half, backdropMargin: margin, backdropBlock: block } = route.inflation ?? {};
  if (!Number.isInteger(half) || half < 1 || half > 127 || !Number.isInteger(margin) || margin < 1 ||
      !Number.isInteger(block) || block < 1 || route.fold.sourceWidth % block || BAND_HEIGHT % block) throw new Error('Invalid terrain inflation');
  // The slab holds the deepest envelope plus a skin of backdrop rock before the cap.
  if (route.fold.thickness !== 2 * (half + margin)) throw new Error('Fold thickness does not hold the inflation');
  for (const [i,r] of route.regions.entries()) {
    const coreHeight=r.core[1]-r.core[0], terminal=i===route.regions.length-1;
    if (r.sourceHeight !== BAND_HEIGHT || !Number.isInteger(r.sourceTop) || r.sourceTop % block || r.core[0] !== r.sourceTop + 32 || coreHeight <= 0 || coreHeight > 256 || (!terminal && coreHeight !== 256) || (i > 0 && route.regions[i-1].core[1] !== r.core[0]) || !/^[a-f0-9]{64}$/.test(r.sha256) || !/^[a-f0-9]{64}$/.test(r.fieldsSha256) || !r.file.endsWith('.binpack')) throw new Error(`Invalid terrain band: ${r.key}`);
  }
}

export function byteAt(words, offset) {
  return (words[offset >>> 2] >>> ((offset & 3) * 8)) & 255;
}

export function nativeIndex(words, index) {
  return byteAt(words, index);
}

// The material a source voxel holds: its native pixel inside the envelope (or
// at every depth for a closed pixel), the band's backdrop rock behind it.
export function inflatedIndex(words, layout, x, y, depth) {
  const index = x + layout.width * y, native = byteAt(words, index);
  if (native === OUTSIDE) return { native, material: OUTSIDE, layer: 'outside' };
  const open = byteAt(words, layout.depthAt + index);
  if (!open) return { native, material: native, layer: 'solid' };
  if (2 * Math.abs(depth) < open) return { native, material: native, layer: 'open' };
  const block = Math.floor(x / layout.block) + layout.blockWidth * Math.floor(y / layout.block);
  return { native, material: byteAt(words, layout.backdropAt + block), layer: 'backdrop' };
}

const sha256 = async (bytes) => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
};

// Read-only validation and packing: never replace native IDs with physical IDs.
export async function prepareTerrainWords(route, region, words) {
  const layout = terrainLayout(route);
  if (words.length !== layout.words) throw new Error(`Truncated terrain raster: ${region.key}`);
  const bytes = new Uint8Array(words.length * 4), view = new DataView(bytes.buffer);
  for (let i = 0; i < words.length; i++) view.setUint32(i * 4, words[i], true);
  if (await sha256(bytes.subarray(0, layout.pixels)) !== region.sha256) throw new Error(`Terrain checksum mismatch: ${region.key}`);
  if (await sha256(bytes.subarray(layout.pixels, layout.bytes)) !== region.fieldsSha256) throw new Error(`Terrain inflation checksum mismatch: ${region.key}`);
  const open = route.palette.map(p => OPEN_KINDS.has(ELEMENTS[p.element].kind));
  for (let i = 0; i < layout.pixels; i++) {
    const n = bytes[i], d = bytes[layout.depthAt + i];
    if (n !== OUTSIDE && n >= route.palette.length) throw new Error(`Unknown native palette index ${n} at ${i}`);
    // Only open pixels inflate; every open pixel is open at depth 0 (the native raster).
    if (d > layout.maxDepth || (n === OUTSIDE ? d !== 0 : (d > 0) !== open[n])) throw new Error(`Invalid inflation depth ${d} at ${i}`);
  }
  for (let i = 0; i < layout.blocks; i++) {
    const b = bytes[layout.backdropAt + i];
    if (b >= route.palette.length || ELEMENTS[route.palette[b].element].kind !== K.SOLID) throw new Error(`Invalid backdrop material ${b} at block ${i}`);
  }
  const packed = new Uint32Array(PALETTE_WORDS + words.length);
  // Palette words carry the native material's appearance label for the Noita view (src/appearance.js).
  route.palette.forEach((p, i) => { packed[i] = materialWord(p.element, p.appearance ?? 0); });
  packed.set(words, PALETTE_WORDS);
  return packed;
}

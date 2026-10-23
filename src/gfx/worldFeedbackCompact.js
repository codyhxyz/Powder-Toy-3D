// The World view's feedback, read back and decoded in proportion to its requests, not its world.
//
// A frame's feedback is a bitset the size of the world's brick book: six channel planes of one
// bit a brick, a status word, then a bit a Sun tile (world/renderAtlas.js worldBookLayout). On
// Descent (640x80x640 bricks) that is 6.15M words, 24 MiB. Each read copied all of it back
// (getMappedRange().slice) and scanned all six planes (renderAtlas.js requestedChannels) for a
// few thousand set bits, and a frame reads three times (eye, scene, final boundary): 5.3 s of
// requestedBricks, 1.7 s of copying and 2.5 s of GC in 40 s of Descent (real Chrome, 2026-10-22).
//
// The fix is the GPU feedback pattern of virtual texturing and streaming: UE5's Nanite streaming
// requests (the GPU appends each request to a capped buffer behind an atomic counter; the CPU
// reads back only that buffer) and id Tech 5's virtual texture feedback (the CPU analyses a small
// feedback buffer, never the texture's address space). After a frame's readers, one small compute
// pass (worldFeedbackCompactWGSL) appends each non-zero word of the feedback as (word index, word)
// to a capped list behind an atomic count. Only that list is read back, and the decoder sorts and
// expands its entries: bytes and work in proportion to the requests. The World view shader is
// unchanged: its request helper (shaders/worldAccess.js worldRequest) is inlined ~380 times, so an
// append there would multiply into the biggest compile in the app.
//
// Exact, always. The list's count is every non-zero word, so a count past the list's capacity is an
// overflow, and that read decodes the full copy of the feedback taken in the same submission, as
// before. A truncated list is not an option: a budget-dropped brick the view names every frame
// could fill it, and the owner settles a frame whose only misses are dropped bricks as complete
// (wire/worldRender.js worldSettleFeedback), so a frame with holes would be accepted.
import { READY } from '../world/renderAtlas.js';

/** count (every non-zero word, past capacity too), then a reserved word: the list is 8-byte aligned. */
export const WORLD_FEEDBACK_COMPACT_HEADER_WORDS = 2;
/** Words a list entry takes: the word's index in the feedback, then the word. */
export const WORLD_FEEDBACK_COMPACT_ENTRY_WORDS = 2;
const WORKGROUP = 256;
/** Feedback words each invocation reads: one atomic a run of up to 4 non-zero words. */
export const WORLD_FEEDBACK_COMPACT_WORDS_PER_THREAD = 4;
/** The smallest list, 32 KiB: a frame's typical dozens to thousands of misses fit it. */
export const WORLD_FEEDBACK_MIN_ENTRIES = 4096;
/** A list grows to twice a read's count, so a frame like the last one fits. */
const GROWTH = 2;
/** ...and halves once a read's count is under an eighth of it. */
const SHRINK_BELOW = 8;
/** The largest list holds a quarter of the words as entries: half the full copy's bytes. Past it a
 * read is cheaper as the full copy, behind the smallest list. */
const MAX_FRACTION = 4;
/** A Sun word's sort key: above every plane key ((word * 8 + plane) < 2^26). */
const SUN_KEY = 0x80000000;
const PLANES = 6;
const PLANE_BITS = 3;   // plane in a sort key's low bits

/** The compaction pass: compact.count += each run's non-zero words, each written while it fits. */
export const worldFeedbackCompactWGSL = () => /* wgsl */ `
// P: words to read, list capacity (entries). wire/worldRenderFrame.js reads the list back.
@group(0) @binding(0) var<uniform> P: vec4u;
@group(0) @binding(1) var<storage, read> feedback: array<u32>;
// list: (word index, word) pairs. (Scalars, not vec2u: the CPU checks' WGSL executor builds a
// vector through f32, which rounds a word past 2^24.)
struct WorldFeedbackCompact { count: atomic<u32>, reserved: u32, list: array<u32> }
@group(0) @binding(2) var<storage, read_write> compact: WorldFeedbackCompact;
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let first = ((wid.y * groups.x + wid.x) * ${WORKGROUP}u + lid) * ${WORLD_FEEDBACK_COMPACT_WORDS_PER_THREAD}u;
  if (first >= P.x) { return; }
  var w: array<u32, ${WORLD_FEEDBACK_COMPACT_WORDS_PER_THREAD}>;
  var n = 0u;
  for (var k = 0u; k < ${WORLD_FEEDBACK_COMPACT_WORDS_PER_THREAD}u; k++) {
    if (first + k < P.x) { w[k] = feedback[first + k]; }
    n += select(0u, 1u, w[k] != 0u);
  }
  if (n == 0u) { return; }
  var slot = atomicAdd(&compact.count, n);
  for (var k = 0u; k < ${WORLD_FEEDBACK_COMPACT_WORDS_PER_THREAD}u; k++) {
    if (w[k] != 0u) {
      if (slot < P.y) { compact.list[2u * slot] = first + k; compact.list[2u * slot + 1u] = w[k]; }
      slot++;
    }
  }
}
`;
export const WORLD_FEEDBACK_COMPACT_LAYOUT = Object.freeze([
  Object.freeze({ binding: 0, visibility: 4, buffer: Object.freeze({ type: 'uniform', minBindingSize: 16 }) }),
  Object.freeze({ binding: 1, visibility: 4, buffer: Object.freeze({ type: 'read-only-storage' }) }),
  Object.freeze({ binding: 2, visibility: 4, buffer: Object.freeze({ type: 'storage' }) }),
]);
/** Words a feedback decode reads: the planes, the status word and the Sun tiles' bits. */
export const worldFeedbackReadWords = (book, sunTileCount) => book.statusWord + 1 + Math.ceil(sunTileCount / 32);
export const worldFeedbackCompactBytes = capacity => (WORLD_FEEDBACK_COMPACT_HEADER_WORDS + WORLD_FEEDBACK_COMPACT_ENTRY_WORDS * capacity) * 4;
/** Workgroups to cover `words` (one dimension until it needs a second). */
export const worldFeedbackCompactGroups = words => Math.ceil(words / (WORKGROUP * WORLD_FEEDBACK_COMPACT_WORDS_PER_THREAD));
const pow2Ceil = n => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
/** The largest list a feedback of `words` words keeps (a power of two). */
export const worldFeedbackMaxEntries = words => Math.max(WORLD_FEEDBACK_MIN_ENTRIES, 2 ** Math.floor(Math.log2(Math.max(1, words / MAX_FRACTION))));
/** The next read's capacity after one of `count` non-zero words read with `capacity`. */
export function nextWorldFeedbackCapacity(words, capacity, count) {
  const max = worldFeedbackMaxEntries(words);
  if (count > max) return WORLD_FEEDBACK_MIN_ENTRIES;   // the full copy carries it; keep the list small
  if (count > capacity) return Math.min(max, pow2Ceil(GROWTH * count));
  if (count * SHRINK_BELOW < capacity) return Math.max(WORLD_FEEDBACK_MIN_ENTRIES, capacity / 2);
  return Math.min(max, capacity);
}

/** CPU twin of the pass (the CPU checks): its list in `order` (default: invocation order). */
export function compactWorldFeedbackCPU(feedback, words, capacity, order = null) {
  const found = [];
  for (let i = 0; i < words; i++) if (feedback[i] !== 0) found.push(i);
  const out = new Uint32Array(worldFeedbackCompactBytes(capacity) / 4);
  out[0] = found.length;
  const list = order ? order(found) : found;
  for (let s = 0; s < Math.min(capacity, list.length); s++) {
    out[WORLD_FEEDBACK_COMPACT_HEADER_WORDS + 2 * s] = list[s];
    out[WORLD_FEEDBACK_COMPACT_HEADER_WORDS + 2 * s + 1] = feedback[list[s]];
  }
  return out;
}

/** Sort scratch reused across decodes: a 64-bit key a list entry, (sort key << 32) | word. */
export function createWorldFeedbackScratch() {
  let keys = new BigUint64Array(0), halves = new Uint32Array(0);
  return {
    ops: 0,
    reserve(n) {
      if (keys.length < n) { keys = new BigUint64Array(pow2Ceil(n)); halves = new Uint32Array(keys.buffer); }
      return { keys, halves };
    },
  };
}

/**
 * Decodes a compacted feedback list (see worldFeedbackCompactWGSL) into exactly what
 * gfx/worldVolume.js decodeWorldFeedback makes of the whole feedback: requirements in brick order,
 * each brick once with its channels, the CELL ones' indices, the Sun tiles in order, the status.
 * null when the list overflowed: decode the full copy instead. Work: the list's entries and their
 * set bits (scratch.ops counts both), plus sorting the entries; nothing in the world's size.
 */
export function decodeCompactWorldFeedback(compact, book, sunTileCount, scratch = createWorldFeedbackScratch()) {
  const H = WORLD_FEEDBACK_COMPACT_HEADER_WORDS, capacity = (compact.length - H) / WORLD_FEEDBACK_COMPACT_ENTRY_WORDS;
  if (!(compact instanceof Uint32Array) || !Number.isInteger(capacity) || capacity < 0) throw new RangeError('compact feedback readback required');
  const count = compact[0];
  if (count > capacity) return null;
  const at = book.statusWord, planeWords = book.planeWords, planesEnd = PLANES * planeWords;
  const sunEnd = at + 1 + Math.ceil(sunTileCount / 32);
  const { keys, halves } = scratch.reserve(count);
  let n = 0, status = 0;
  for (let j = 0; j < count; j++) {
    const index = compact[H + 2 * j], word = compact[H + 2 * j + 1];
    let key;
    if (index < planesEnd) { const plane = Math.floor(index / planeWords); key = ((index - plane * planeWords) << PLANE_BITS | plane) >>> 0; }
    else if (index === at) { status = word; continue; }
    else if (index < sunEnd) key = SUN_KEY + (index - at - 1);
    else continue;   // past the Sun bits: no reader's
    halves[2 * n] = word; halves[2 * n + 1] = key; n++;   // little-endian: the key is the high half
  }
  keys.subarray(0, n).sort();
  const requirements = [], geometry = [], sun = [];
  const bx = book.bricks[0], by = book.bricks[1], bxy = bx * by, bricks = book.count;
  let ops = count;
  for (let i = 0; i < n;) {
    const key = halves[2 * i + 1];
    if (key >= SUN_KEY) {
      const base = (key - SUN_KEY) * 32;
      for (let v = halves[2 * i]; v; v &= v - 1) { ops++; const t = base + 31 - Math.clz32(v & -v); if (t < sunTileCount) sun.push(t); }
      i++; continue;
    }
    // One brick word's planes: consecutive keys, plane order.
    const word = key >>> PLANE_BITS, start = i;
    let any = 0;
    for (; i < n && halves[2 * i + 1] >>> PLANE_BITS === word; i++) any |= halves[2 * i];
    for (let v = any; v; v &= v - 1) {
      ops++;
      const bit = 31 - Math.clz32(v & -v), index = word * 32 + bit;
      if (index >= bricks) break;   // a world's last word past its count (bits ascend)
      let channels = 0;
      for (let k = start; k < i; k++) if (halves[2 * k] >>> bit & 1) channels |= 1 << (halves[2 * k + 1] & 7);
      requirements.push({ index, brick: [index % bx, Math.floor(index / bx) % by, Math.floor(index / bxy)], channels });
      if (channels & READY.CELL) geometry.push(index);
    }
  }
  scratch.ops = ops;
  return Object.freeze({ incomplete: status !== 0 || requirements.length !== 0 || sun.length !== 0, status, geometry, requirements, sun });
}

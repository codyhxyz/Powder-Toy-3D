import { BRICK_CELLS } from '../shaders/window.js';

// The world's edits (docs/scaling.md D11, "Leaving slabs"): every brick outside
// the window that differs from what the generator makes, compressed, keyed by
// world brick. A brick that comes back into the window leaves the store (the
// window holds it now) and is stored again when it leaves, if it still differs.
//
// A brick is its 64 cells in the D5 float layout, in the slab order of
// shaders/window.js: state A (element id, °C, life, ctype + seed) and B
// (velocity xyz, pressure) per cell. Coding is synchronous, because a shift
// writes back the bricks it uncovers in the same frame:
//   - the 512 floats are transposed into byte planes (channel, byte, cell), so
//     a channel that is the same in every cell becomes 4 planes of one
//     repeated byte, and runs line up;
//   - the planes are PackBits run-length coded (a header byte n: 0..127 copies
//     the next n + 1 bytes, -127..-1 repeats the next byte 1 - n times).
// Seeds are random and pressure decays to tiny unequal floats, so those planes
// stay near raw; ids, temperatures, life and velocity mostly vanish.

const CHANNELS = 8;                                  // A.xyzw, B.xyzw
const FLOAT_BYTES = 4;
export const BRICK_FLOATS = CHANNELS / 2 * BRICK_CELLS;   // floats of one state (A or B) per brick
const RAW_BYTES = CHANNELS * FLOAT_BYTES * BRICK_CELLS;   // 2048
const RUN_MAX = 128;                                 // longest run (or literal) one header byte covers
const RUN_MIN = 3;                                   // repeats shorter than this stay in a literal
const HEADER_LITERAL_MAX = 127;                      // header 0..127: n + 1 literal bytes
const HEADER_RUN = 257;                              // header (two's complement) for a run of k: 257 - k

const planes = new Uint8Array(RAW_BYTES);
const packed = new Uint8Array(RAW_BYTES + Math.ceil(RAW_BYTES / RUN_MAX) + 1);   // worst case: all literals

// Brick at float offset aOff of A and bOff of B (staging layout: RGBA per cell) → bytes.
export function encodeBrick(A, aOff, B, bOff) {
  const a8 = new Uint8Array(A.buffer, A.byteOffset + aOff * FLOAT_BYTES, BRICK_FLOATS * FLOAT_BYTES);
  const b8 = new Uint8Array(B.buffer, B.byteOffset + bOff * FLOAT_BYTES, BRICK_FLOATS * FLOAT_BYTES);
  // plane (c, k) holds byte k of channel c for every cell
  for (let c = 0; c < CHANNELS; c++) {
    const src = c < CHANNELS / 2 ? a8 : b8, ch = c % (CHANNELS / 2);
    for (let k = 0; k < FLOAT_BYTES; k++) {
      const p = (c * FLOAT_BYTES + k) * BRICK_CELLS;
      for (let l = 0; l < BRICK_CELLS; l++) planes[p + l] = src[(l * CHANNELS / 2 + ch) * FLOAT_BYTES + k];
    }
  }
  // PackBits
  let n = 0, i = 0;
  while (i < RAW_BYTES) {
    let run = 1;
    while (i + run < RAW_BYTES && run < RUN_MAX && planes[i + run] === planes[i]) run++;
    if (run >= RUN_MIN) {
      packed[n++] = HEADER_RUN - run;
      packed[n++] = planes[i];
      i += run;
      continue;
    }
    // a literal, up to the next run worth coding
    const start = i;
    while (i < RAW_BYTES && i - start < RUN_MAX) {
      if (i + RUN_MIN <= RAW_BYTES && planes[i] === planes[i + 1] && planes[i] === planes[i + 2]) break;
      i++;
    }
    packed[n++] = i - start - 1;
    packed.set(planes.subarray(start, i), n);
    n += i - start;
  }
  return packed.slice(0, n);
}

// bytes → the brick's A floats at aOff of A and its B floats at bOff of B.
export function decodeBrick(bytes, A, aOff, B, bOff) {
  let n = 0, i = 0;
  while (n < bytes.length) {
    const h = bytes[n++];
    if (h <= HEADER_LITERAL_MAX) {
      planes.set(bytes.subarray(n, n + h + 1), i);
      n += h + 1;
      i += h + 1;
    } else {
      planes.fill(bytes[n++], i, i + HEADER_RUN - h);
      i += HEADER_RUN - h;
    }
  }
  if (i !== RAW_BYTES) throw new Error(`stored brick decodes to ${i} bytes, not ${RAW_BYTES}`);
  const a8 = new Uint8Array(A.buffer, A.byteOffset + aOff * FLOAT_BYTES, BRICK_FLOATS * FLOAT_BYTES);
  const b8 = new Uint8Array(B.buffer, B.byteOffset + bOff * FLOAT_BYTES, BRICK_FLOATS * FLOAT_BYTES);
  for (let c = 0; c < CHANNELS; c++) {
    const dst = c < CHANNELS / 2 ? a8 : b8, ch = c % (CHANNELS / 2);
    for (let k = 0; k < FLOAT_BYTES; k++) {
      const p = (c * FLOAT_BYTES + k) * BRICK_CELLS;
      for (let l = 0; l < BRICK_CELLS; l++) dst[(l * CHANNELS / 2 + ch) * FLOAT_BYTES + k] = planes[p + l];
    }
  }
}

// Stored bricks by world brick, with the bytes they take.
export class BrickStore {
  // bricks: the world's size in bricks [x, y, z]
  constructor(bricks) {
    this.bricks = bricks;
    this.map = new Map();
    this.bytes = 0;
  }

  key(bx, by, bz) { return (bz * this.bricks[1] + by) * this.bricks[0] + bx; }
  has(key) { return this.map.has(key); }
  get size() { return this.map.size; }

  put(key, bytes) {
    this.bytes += bytes.length - (this.map.get(key)?.length ?? 0);
    this.map.set(key, bytes);
  }

  // The brick's bytes, removed from the store (undefined if it has none).
  take(key) {
    const b = this.map.get(key);
    if (b) { this.map.delete(key); this.bytes -= b.length; }
    return b;
  }

  drop(key) { this.take(key); }

  clear() { this.map.clear(); this.bytes = 0; }
}

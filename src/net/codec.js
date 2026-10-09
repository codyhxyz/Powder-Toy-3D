import * as THREE from 'three';
import { prelude, quadVert, stateOutGLSL } from '../shaders/common.js';

// World stream codec. The host packs the state into 4 bytes per cell holding
// only what guests render, and sends a keyframe or an XOR delta against the
// last frame it sent, deflated. Guests unpack it back into the state layout
// the renderer reads. Guests only render, so anything the renderer doesn't use
// is left out:
//   R  element id
//   G  temperature code (see TEMP below); air is always sent as ambient
//   B  life, only for elements whose look depends on it (smoke density, fire)
//   A  ctype (what lava melted from sets where its crust forms; what a clone copies)
// Velocity and pressure aren't sent (so a guest's grains are textured in
// place, without flow), and the per-grain colour seed is re-derived from the
// cell position on the guest.

const BYTE_MAX = 255;
const TEXEL_BYTES = 4; // RGBA8

// Temperature in one byte: linear steps up to LOG_START, then equal ratios up
// to MAX so glowing material (whose brightness rises steeply with temperature)
// changes in small relative steps.
const TEMP = {
  MIN: -100,       // °C; anything colder is sent as MIN (the heat view's scale bottoms out at −40)
  LINEAR_STEP: 4,  // °C per code below LOG_START
  LOG_START: 400,  // °C; just below where incandescence starts
  MAX: 6000,       // °C; the heat tool's cap
};
const TEMP_LINEAR_CODES = (TEMP.LOG_START - TEMP.MIN) / TEMP.LINEAR_STEP;
const TEMP_LOG_CODES = BYTE_MAX - TEMP_LINEAR_CODES;

// The guest's per-cell colour seed: same range the app uses for fresh cells.
const SEED_SALT = 0x5eed;
const SEED_SPAN = 0.999;

const f = (x) => x.toFixed(4); // a JS number as a GLSL float literal

const codecGLSL = /* glsl */ `
#define BYTE_MAX ${f(BYTE_MAX)}
#define TEMP_MIN ${f(TEMP.MIN)}
#define TEMP_LINEAR_STEP ${f(TEMP.LINEAR_STEP)}
#define TEMP_LOG_START ${f(TEMP.LOG_START)}
#define TEMP_MAX ${f(TEMP.MAX)}
#define TEMP_LINEAR_CODES ${f(TEMP_LINEAR_CODES)}
#define TEMP_LOG_CODES ${f(TEMP_LOG_CODES)}
#define SEED_SALT ${SEED_SALT}u
#define SEED_SPAN ${f(SEED_SPAN)}

float encodeTemp(float T) {
  float code = T < TEMP_LOG_START
    ? (max(T, TEMP_MIN) - TEMP_MIN) / TEMP_LINEAR_STEP
    : TEMP_LINEAR_CODES + TEMP_LOG_CODES * log(min(T, TEMP_MAX) / TEMP_LOG_START) / log(TEMP_MAX / TEMP_LOG_START);
  return clamp(round(code), 0.0, BYTE_MAX);
}
float decodeTemp(float code) {
  return code <= TEMP_LINEAR_CODES
    ? TEMP_MIN + code * TEMP_LINEAR_STEP
    : TEMP_LOG_START * pow(TEMP_MAX / TEMP_LOG_START, (code - TEMP_LINEAR_CODES) / TEMP_LOG_CODES);
}
bool sendsLife(int id) { return id == E_SMOKE || id == E_FIRE; }
`;

const packFrag = (g) => /* glsl */ `
${prelude(g)}
${codecGLSL}
out vec4 oP;
void main() {
  ivec3 p = cellFromFrag(ivec2(gl_FragCoord.xy));
  if (!inGrid(p)) { oP = vec4(0.0); return; }   // a texel holding no cell
  vec4 a = fetchA(p);
  int id = eid(a);
  float T = encodeTemp(id == E_EMPTY ? AMBIENT : a.y);
  float life = sendsLife(id) ? round(clamp(a.z, 0.0, 1.0) * BYTE_MAX) : 0.0;
  oP = vec4(float(id), T, life, clamp(floor(a.w), 0.0, BYTE_MAX)) / BYTE_MAX;
}
`;

const unpackFrag = (g) => /* glsl */ `
${prelude(g)}
${codecGLSL}
uniform sampler2D tPacked;   // in the state's atlas layout: texel f holds cell cellFromFrag(f)
${stateOutGLSL}
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec4 q = round(texelFetch(tPacked, fc, 0) * BYTE_MAX);
  uint rs = seed3(cellFromFrag(fc), 0u, SEED_SALT);
  writeState(vec4(q.x, decodeTemp(q.y), q.z / BYTE_MAX, q.w + rnd(rs) * SEED_SPAN), vec4(0.0));
}
`;

const passMaterial = (fragmentShader, uniforms) => new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3, vertexShader: quadVert, fragmentShader, uniforms, depthTest: false, depthWrite: false,
});

const sameGrid = (a, b) => a && b && a.nx === b.nx && a.ny === b.ny && a.nz === b.nz;

// Captures in flight at once. A readback resolves only once the GPU has
// caught up with everything queued before it, which is several frames when
// the GPU is the bottleneck, so captures overlap to keep the frame rate up.
const PACK_SLOTS = 3;

// Host side: pack the current state on the GPU and read it back without stalling.
export function createPacker(renderer) {
  let g = null, mat = null, free = [], generation = 0;
  function reset(next) {
    free.forEach((s) => s.target.dispose());
    mat?.dispose();
    g = next;
    generation++;
    mat = passMaterial(packFrag(g), { tA: { value: null } });
    free = Array.from({ length: PACK_SLOTS }, () => ({
      target: new THREE.WebGLRenderTarget(g.width, g.height, {
        depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      }),
      bytes: new Uint8Array(g.width * g.height * TEXEL_BYTES),
    }));
  }
  return {
    // Starts a capture of the sim's current state; resolves to { bytes, dims, release }
    // (call release() once done with bytes). Returns null while all slots are busy.
    pack(sim) {
      if (!sameGrid(g, sim.g)) reset(sim.g);
      const slot = free.pop();
      if (!slot) return null;
      mat.uniforms.tA.value = sim.stateA;
      sim.run(mat, slot.target);
      renderer.setRenderTarget(null);
      const gen = generation, dims = [g.nx, g.ny, g.nz];
      const release = () => { if (gen === generation) free.push(slot); else slot.target.dispose(); };
      return renderer.readRenderTargetPixelsAsync(slot.target, 0, 0, g.width, g.height, slot.bytes)
        .then(() => ({ bytes: slot.bytes, dims, release }), (err) => { release(); throw err; });
    },
  };
}

// Guest side: upload packed bytes and expand them into the sim's state.
export function createUnpacker() {
  let g = null, tex = null, mat = null;
  return {
    unpack(sim, bytes) {
      if (!sameGrid(g, sim.g)) {
        tex?.dispose(); mat?.dispose();
        g = sim.g;
        tex = new THREE.DataTexture(bytes, g.width, g.height, THREE.RGBAFormat, THREE.UnsignedByteType);
        mat = passMaterial(unpackFrag(g), { tPacked: { value: tex } });
      }
      tex.image.data = bytes;
      tex.needsUpdate = true;
      sim.run(mat, sim.targets[sim.cur]);
      sim.stillFlow();   // no velocity is sent, so a guest's grains are textured in place
    },
  };
}

// ---- frames: [kind, seq, nx, ny, nz] as uint32, then the deflated body ----
export const FRAME_KEY = 1;   // body is the packed state
export const FRAME_DELTA = 2; // body is packed XOR the previous frame
const HEADER_WORDS = 5;
const HEADER_BYTES = HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT;
const COMPRESSION = 'deflate-raw';

const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

export async function encodeFrame(kind, seq, dims, body) {
  const packed = await pipe(body, new CompressionStream(COMPRESSION));
  const out = new Uint8Array(HEADER_BYTES + packed.length);
  new Uint32Array(out.buffer, 0, HEADER_WORDS).set([kind, seq, ...dims]);
  out.set(packed, HEADER_BYTES);
  return out.buffer;
}

export async function decodeFrame(buf) {
  const [kind, seq, ...dims] = new Uint32Array(buf, 0, HEADER_WORDS);
  const body = await pipe(new Uint8Array(buf, HEADER_BYTES), new DecompressionStream(COMPRESSION));
  return { kind, seq, dims, body };
}

// out = a XOR b (word-wise); returns whether anything differs.
export function xorInto(out, a, b) {
  const words = (u8) => new Uint32Array(u8.buffer, u8.byteOffset, u8.length / Uint32Array.BYTES_PER_ELEMENT);
  const o = words(out), x = words(a), y = words(b);
  let diff = 0;
  for (let i = 0; i < o.length; i++) diff |= (o[i] = x[i] ^ y[i]);
  return diff !== 0;
}

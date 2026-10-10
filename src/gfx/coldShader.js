// Cold shader compiles: say so before the page freezes.
//
// Chrome on ANGLE/Metal builds a program's GPU pipeline on its first draw, and
// that draw holds the page's main thread until it is done (measured with
// tools/compile-bench.mjs --parallel: with KHR_parallel_shader_compile the
// link runs in the background, but the first drawArrays still blocks for the
// whole pipeline build). For the view raymarcher that is seconds, once per
// browser and shader version: after every deploy. A warm cache (the driver
// keeps compiled pipelines across sessions) makes it near instant.
//
// So when the view program is one this browser hasn't drawn before (by a hash
// of its source, remembered in localStorage), the app shows a message and
// holds the first frame back long enough for the message to paint; the freeze
// then happens under it instead of on a blank page.

const STORE = 'powder-toy-3d:warmShaders';
// programs remembered as warm (grid sizes × detail variants × recent deploys)
const KEEP = 16;
// ms between showing the message and the stall, so the page paints it first
// (gfx/detailGate.js waits the same for its variants)
export const WARN_PAINT_MS = 100;

// FNV-1a, 32 bit: a short fingerprint of a program's source
const FNV_OFFSET = 0x811c9dc5, FNV_PRIME = 0x01000193;
function hash(s) {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME);
  return (h >>> 0).toString(36);
}
const programKey = (mat) => hash(`${mat.vertexShader}\n${mat.fragmentShader}\n${Object.entries(mat.defines ?? {}).sort().join(';')}`);

function warmKeys() {
  try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; }
}

// warn(): show the message. watch(material) after building a view material;
// hold() at the top of each frame (true: skip this frame, the message is
// painting); drew() after a frame drew the view.
export function createColdShaderGuard(warn) {
  let pending = null;   // material to check on the next frame
  let drawing = null;   // key of the program the next view draw builds
  let holdUntil = 0;
  return {
    watch(mat) { pending = mat; },
    hold() {
      if (pending) {
        drawing = programKey(pending);
        pending = null;
        if (!warmKeys().includes(drawing)) {
          warn();
          holdUntil = performance.now() + WARN_PAINT_MS;
        }
      }
      return performance.now() < holdUntil;
    },
    drew() {
      if (!drawing) return;
      const keys = warmKeys().filter((k) => k !== drawing);
      keys.push(drawing);
      try { localStorage.setItem(STORE, JSON.stringify(keys.slice(-KEEP))); } catch { /* storage unavailable */ }
      drawing = null;
    },
  };
}

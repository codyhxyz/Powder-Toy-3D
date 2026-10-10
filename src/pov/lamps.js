import { gfxUniforms } from '../gfx/uniforms.js';
import { LAMP_MAX } from '../gfx/lamps.js';

// The lit hand lamps (the torch and lantern, held or thrown), handed to the
// world shader (gfx/lamps.js, shaders/gfx/lighting.js lampLight). A tool sets
// its lamp by a key of its own each time it moves or changes and removes it
// when it goes out. Past LAMP_MAX the thrown ones set longest ago are left
// dark; a lamp in hand always shines.
//
//   lamps.set(key, { pos, range, color, held })   // pos: grid cells (Vector3-like); range: cells; color: [r, g, b] linear × intensity
//   lamps.remove(key)

const lit = new Map();   // key → { pos: [x, y, z], range, color, held }, oldest first

function write() {
  const P = gfxUniforms.uLampPos.value, C = gfxUniforms.uLampCol.value;
  const all = [...lit.values()];
  const held = all.filter((l) => l.held).slice(0, LAMP_MAX);
  const thrown = all.filter((l) => !l.held);
  const list = [...thrown.slice(Math.max(0, thrown.length - (LAMP_MAX - held.length))), ...held];
  list.forEach((l, i) => {
    P.set([l.pos[0], l.pos[1], l.pos[2], l.range], i * 4);
    C.set([l.color[0], l.color[1], l.color[2], 0], i * 4);
  });
  gfxUniforms.uLampCount.value = list.length;
  globalThis.__app?.requestRender?.();
}

export const lamps = {
  set(key, { pos, range, color, held = false }) {
    lit.set(key, { pos: [pos.x, pos.y, pos.z], range, color: [...color], held });   // (a Map keeps first-set order: newest last)
    write();
  },
  remove(key) { if (lit.delete(key)) write(); },
  get count() { return lit.size; },
};

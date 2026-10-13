import { gfxUniforms } from '../gfx/uniforms.js';
import { LAMP_MAX } from '../gfx/lamps.js';

// The lit hand lamps (the torch and lantern, held or thrown), handed to the
// world shader (gfx/lamps.js, shaders/gfx/lighting.js lampLight). A tool sets
// its lamp by a key of its own each time it moves or changes and removes it
// when it goes out. Past LAMP_MAX the thrown ones set longest ago are left
// dark; a lamp in hand always shines.
//
// The wall torches nearest the eye (world/torchLights.js) take the slots left over,
// nearest first: fixed lamps, each lit only while its cell is still a torch.
//
//   lamps.set(key, { pos, range, color, held, radius, length })   // pos: grid cells (Vector3-like); range: cells; color: [r, g, b] linear × intensity;
//                                                                  // radius, length: the light's own size, cells (gfx/lamps.js)
//   lamps.remove(key)
//   lamps.setFixed([{ pos: [x, y, z], range, color, radius, length }, ...])   // the wall torches' (pos: grid cells, the head cell's centre)

const lit = new Map();   // key → { pos: [x, y, z], range, color, held, radius, length }, oldest first
let fixed = [];

function write() {
  const P = gfxUniforms.uLampPos.value, C = gfxUniforms.uLampCol.value, S = gfxUniforms.uLampShape.value;
  const all = [...lit.values()];
  const held = all.filter((l) => l.held).slice(0, LAMP_MAX);
  const thrown = all.filter((l) => !l.held);
  const list = [...thrown.slice(Math.max(0, thrown.length - (LAMP_MAX - held.length))), ...held];
  const n = list.length;
  list.push(...fixed.slice(0, LAMP_MAX - n));
  list.forEach((l, i) => {
    P.set([l.pos[0], l.pos[1], l.pos[2], l.range], i * 4);
    C.set([l.color[0], l.color[1], l.color[2], i >= n ? 1 : 0], i * 4);   // w 1: a fixed lamp (lighting.js lampLight)
    S.set([l.radius ?? 0, l.length ?? 0, 0, 0], i * 4);   // a lamp given no size is a point
  });
  gfxUniforms.uLampCount.value = list.length;
  globalThis.__app?.requestRender?.();
}

export const lamps = {
  set(key, { pos, range, color, held = false, radius, length }) {
    lit.set(key, { pos: [pos.x, pos.y, pos.z], range, color: [...color], held, radius, length });   // (a Map keeps first-set order: newest last)
    write();
  },
  remove(key) { if (lit.delete(key)) write(); },
  setFixed(list) { fixed = list; write(); },
  get count() { return lit.size; },
};

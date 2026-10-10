import { structuresOf } from './structures.js';
import { useWorldBake } from './bake.js';

// world/structures.js's placement off the main thread (world/bakeClient.js):
// given a world P and the build's bake, it posts back structuresOf(P)'s list,
// each structure's baked construction without its ghost (the preview's), its
// cells' buffer transferred (structures sharing one construction share it).
self.onmessage = ({ data: { P, bake } }) => {
  try {
    useWorldBake(bake);
    const list = structuresOf(P).map(({ s, ...r }) => ({ ...r, s: { w: s.w, h: s.h, d: s.d, data: s.data, foot: s.foot, base: s.base } }));
    self.postMessage({ ok: true, list }, [...new Set(list.map((r) => r.s.data.buffer))]);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.stack ?? err) });
  }
};

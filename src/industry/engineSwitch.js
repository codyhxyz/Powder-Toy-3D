// The Factory's ownership tags across a runtime physics switch.
//
// The machines mark the cells they own in V1's A.z: a closed gate's leaf is
// WALL with GATE_OWNER_MARKER (gates.js), a pump's backplate TUNGSTEN with
// PUMP_BACKPLATE_TAG (pumpStructure.js). V2 holds a non-liquid's life in a
// 16-bit payload (v2/layout.js nativeLife), so V1's tags import to exactly its
// clamp, and V2's kernels own that value (GATE_OWNER_MARKER_NATIVE,
// PUMP_BACKPLATE_TAG_NATIVE): V1 -> V2 needs nothing. The way back does: the
// V2 -> V1 export (shaders/compact.js compactA) can only give the clamp, which
// V1's kernels don't own, so a gate closed under V2 read DAMAGED under V1 and
// a pump built under V2 couldn't be dismantled. On that switch the machines'
// own cells get V1's tags back, before any V1 machine kernel reads them.
import { E } from '../elements.js';
import { GATE_OWNER_MARKER, GATE_OWNER_MARKER_NATIVE } from './gates.js';
import { PUMP_BACKPLATE_TAG, pumpBackplateCells } from './pumpStructure.js';
import { PUMP_BACKPLATE_TAG_NATIVE } from './construction.js';
import { deviceCell } from './catalog.js';

/** A V1 edit (sim.editKernel): in its box, a cell of element P.tagId whose A.z is P.fromTag gets P.toTag. */
export const RETAG_EDIT = {
  reads: 'own',
  params: { tagId: 'i32', fromTag: 'f32', toTag: 'f32' },
  update: /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  if (eid(a) == P.tagId && a.z == P.fromTag) { (*oA).z = P.toTag; }
}
`,
};

// The gate leaf (gates.js gateGeometry: x 0..3, y 1..3 at z 2) and the pump backplate.
const gateLeaf = d => { const c = []; for (let y = 1; y <= 3; y++) for (let x = 0; x < 4; x++) c.push(deviceCell(d, x, y, 2)); return c; };
const boxOf = cells => ({ lo: [0, 1, 2].map(a => Math.min(...cells.map(c => c[a]))), hi: [0, 1, 2].map(a => Math.max(...cells.map(c => c[a]))) });

/** The retag edits a V2 -> V1 switch owes these machines: [{ box, values: { id, from, to } }]. */
export function retagEdits(devices) {
  const out = [];
  for (const d of devices ?? []) {
    if (d?.type === 'gate') out.push({ box: boxOf(gateLeaf(d)), values: { tagId: E.WALL, fromTag: GATE_OWNER_MARKER_NATIVE, toTag: GATE_OWNER_MARKER } });
    else if (d?.type === 'pump') out.push({ box: boxOf(pumpBackplateCells(d)), values: { tagId: E.TUNGSTEN, fromTag: PUMP_BACKPLATE_TAG_NATIVE, toTag: PUMP_BACKPLATE_TAG } });
  }
  return out;
}

/**
 * Watches the grid's engine (sim.compact) and, on V2 -> V1, records the retag edits.
 * update(devices) before the machines step: false while a retag is owed but its
 * kernel is still building (the machines' V1 kernels must not read the cells yet).
 */
export function createEngineRetag({ getSim }) {
  let sim = null, native = false, kernel = null, owed = false;
  return {
    get owed() { return owed; },
    update(devices) {
      const now = getSim();
      if (!now) return true;
      if (now !== sim) { sim = now; native = !!now.compact; owed = false; kernel = null; }
      // (built ahead, while V2 runs, so a switch finds it ready)
      if (now.compactOwner && !kernel) kernel = now.editKernel('industryRetag', RETAG_EDIT);
      const nowNative = !!now.compact;
      if (native && !nowNative) owed = true;
      if (nowNative) owed = false;   // (back on V2 first: its own tags are still the cells')
      native = nowNative;
      if (!owed) return true;
      kernel ??= now.editKernel('industryRetag', RETAG_EDIT);
      if (kernel.main.state !== 'ready') return false;
      for (const { box, values } of retagEdits(devices)) now.edit(kernel, box, values);
      owed = false;
      return true;
    },
    reset() { sim = null; kernel = null; owed = false; },
  };
}


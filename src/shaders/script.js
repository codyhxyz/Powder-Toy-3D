import { STAGE, LAYOUT, EDIT_FIELDS, editKernelWGSL } from './common.js';
import { uniformStruct } from '../gpu/params.js';
import { fold } from '../gpu/kernels.js';
import { EDIT, EDIT_TEX_W, EDIT_SEARCH_STEPS } from '../console/world.js';

// The console's write kernel (src/console, docs/console.md): applies a batch
// of cell edits scripts queued (sim.partCreate, partKill, partProperty,
// sim.pressure ...), like the stamp applies a construction. An edit
// (docs/webgpu.md D6) over the batch's box, in place: it costs what one brush
// stroke does, and it is only dispatched when scripts wrote something.
//
// `edits` holds P.count edits sorted by cell key ((z · NY + y) · NX + x),
// EDIT_TEX_W per row, in three blocks of P.rows rows: (key, mask bits) /
// state A values / state B values (console/world.js packEdits, the WebGL
// build's edit texture as it was, a vec4f a texel). A cell inside the box
// binary-searches it for its own edit. The mask bits are console/world.js
// EDIT; a fresh cell (SPAWN) starts the way the brush starts one
// (shaders/passes.js paintUpdateWGSL), at rest and with its seed kept.
export const ScriptEditParams = uniformStruct('ScriptEditParams', {
  ...EDIT_FIELDS,
  count: 'i32',   // edits in the batch
  rows: 'i32',    // rows of EDIT_TEX_W in each of its three blocks
});
export const SCRIPT_EDIT_LAYOUT = [{ binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } }];
export const scriptEditDeclsWGSL = /* wgsl */ `
@group(2) @binding(0) var<storage, read> edits: array<vec4f>;
const EDIT_TEX_W: i32 = ${EDIT_TEX_W};
const EDIT_SEARCH_STEPS: i32 = ${EDIT_SEARCH_STEPS};
${Object.entries(EDIT).map(([k, v]) => `const EDIT_${k}: u32 = ${v}u;`).join('\n')}
fn editAt(j: i32, part: i32) -> vec4f { return edits[j + part * P.rows * EDIT_TEX_W]; }
`;
export const scriptEditUpdateWGSL = /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let key = (p.z * NY + p.y) * NX + p.x;
  var lo = 0;
  var hi = P.count - 1;
  var j = -1;
  for (var i = 0; i < EDIT_SEARCH_STEPS; i++) {
    if (lo > hi) { break; }
    let mid = (lo + hi) >> 1u;
    let k = i32(editAt(mid, 0).x);
    if (k == key) { j = mid; break; }
    if (k < key) { lo = mid + 1; } else { hi = mid - 1; }
  }
  if (j < 0) { return; }
  let m = u32(editAt(j, 0).y);
  let va = editAt(j, 1);
  let vb = editAt(j, 2);
  let id = eid(a);
  if ((m & EDIT_IF_EMPTY) != 0u && id != E_EMPTY) { return; }
  if ((m & EDIT_IF_MATTER) != 0u && id == E_EMPTY) { return; }
  let seed = fract(a.w);
  if ((m & EDIT_SPAWN) != 0u) {
    let n = i32(va.x + 0.5);
    let ctype = select(0.0, f32(E_STONE), n == E_LAVA);
    if (n == E_EMPTY) { *oA = vec4f(f32(E_EMPTY), airT(), 0.0, seed); }
    else { *oA = vec4f(f32(n), SPAWNT(n), SPAWNLIFE(n), ctype + seed); }
    *oB = vec4f(0.0, 0.0, 0.0, b.w);
  }
  if ((m & EDIT_TYPE) != 0u) {
    let n = i32(va.x + 0.5);
    if ((m & EDIT_SPAWN) == 0u && n != id) { (*oA).w = physicalCtype(id, a.w) + seed; }
    (*oA).x = f32(n);
  }
  if ((m & EDIT_TEMP) != 0u) { (*oA).y = va.y; }
  if ((m & EDIT_LIFE) != 0u) { (*oA).z = va.z; }
  if ((m & EDIT_CTYPE) != 0u) { (*oA).w = va.w + seed; }
  if ((m & EDIT_VX) != 0u) { (*oB).x = vb.x; }
  if ((m & EDIT_VY) != 0u) { (*oB).y = vb.y; }
  if ((m & EDIT_VZ) != 0u) { (*oB).z = vb.z; }
  if ((m & EDIT_PRESSURE) != 0u) { (*oB).w = vb.w; }
}
`;
// The whole module, as sim.editKernel('scriptEdit', …) builds it (check-wgsl).
export const scriptEditFrag = (g, { debug = false } = {}) => editKernelWGSL(g, {
  update: scriptEditUpdateWGSL, params: ScriptEditParams, reads: 'own', decls: scriptEditDeclsWGSL, debug,
});

/** tools/check-wgsl.mjs (docs/webgpu.md I1) */
export const WGSL_CHECK = [
  { name: 'scriptEdit', kind: 'compute', code: scriptEditFrag, params: ScriptEditParams, warm: false, workgroupSize: [4, 4, 4],
    layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, SCRIPT_EDIT_LAYOUT], dispatch: (g) => fold(g.nbricks) },
];

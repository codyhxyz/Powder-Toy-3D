// The physics region's slab fill from the world copy (docs/seamless-world.md, "P — physics region").
// A move fills the slab it uncovers with V2 native cores decoded from the world copy's cell words
// (shaders/world/cellWord.js), then the window lays the exact native store over it (world/window.js
// restoreNative). Trees come with the copy, so no CPU tree baking.
//
// The copy's word is lossy (a temperature code, 127 levels of fill or life, no colour seed), so a cell
// the world copy holds as the generator made it (its id, ctype and temperature code agree, and a liquid
// is whole) takes the generator's own import, bit for bit, as today's fill does: a brick the player never
// touched comes back exact, the leaving slab's diff still finds it equal to the generator, and the stores
// and saves keep their meaning (world/store.js: the bricks that differ from the generator). Only a cell
// the copy says is different (a tree, or an edit whose exact brick the store still holds) is decoded from
// the word: id, ctype and temperature from it, a liquid's fill from aux, and matter's life as aux times the
// element's spawn life (ELEMENTS[id].life). The exact store then overrides every edited brick.
//
// Groups: 0 the element tables, 1 the world copy (W's worldCopyWGSL: wcCell), 2 the scene's resources and
// V2's cores, banks and activity after them, 3 the params.
import { prelude, SALT } from '../common.js';
import { nativeImportHelpersWGSL, importAWGSL } from '../v2/leave.js';
import { nativeWriteCoreWGSL, NativeFillParams, nativeFillSize } from '../worldWrite.js';
import { cellWordWGSL, WC_AUX_MAX, wcTempCode } from './cellWord.js';
import { SCENE_BINDING } from '../../world/scenes/sceneGpu.js';
import { ELEMENTS } from '../../elements.js';
import { v2Rows, V2, FULL } from '../v2.js';
import { glf } from '../../glsl.js';

export { NativeFillParams as CopyFillParams, nativeFillSize as copyFillSize };
// The bindings of V2's cores, banks and activity in group 2, after the scene's.
export const COPY_FILL_WRITE_AT = SCENE_BINDING.next;
const WORD_LOOK_MASK = 0xffffff;   // a word's id, ctype and temperature code (cellWord.js bits 0-23)
const AUX_SHIFT = 24;

// The world copy's decoders come with its module once W lands (cellWord.js); declared here otherwise.
const withDecoders = (copyWGSL) => (/fn\s+wcId\s*\(/.test(copyWGSL) ? copyWGSL : `${cellWordWGSL}\n${copyWGSL}`);
// A scene's own names that the world copy's module also declares are renamed in the scene's text: Tinker
// Creek's generator has a wcCell of its own (world/scenes/willowCove.js, "wc" for Willow Cove).
function sceneBeside(copyWGSL, sceneGLSL) {
  const taken = new Set([...copyWGSL.matchAll(/\b(?:fn|const|var|struct|alias)\s*(?:<[^>]*>\s*)?([A-Za-z_]\w*)/g)].map((m) => m[1]));
  const clash = [...new Set([...sceneGLSL.matchAll(/\b(?:fn|const|struct|alias)\s+([A-Za-z_]\w*)/g)].map((m) => m[1]))].filter((n) => taken.has(n));
  return clash.reduce((code, n) => code.replace(new RegExp(`\\b${n}\\b`, 'g'), `scene_${n}`), sceneGLSL);
}

/** WGSL of the fill: copyWGSL W's world copy module (group 1, wcCell), sceneGLSL the scene's sceneCell. */
export const copyFillWGSL = (g, copyWGSL, sceneGLSL) => /* wgsl */ `
${prelude(g, { state: false })}
${nativeImportHelpersWGSL}
${importAWGSL(g)}
${withDecoders(copyWGSL)}
${sceneBeside(withDecoders(copyWGSL), sceneGLSL)}
${nativeWriteCoreWGSL(g, 2, COPY_FILL_WRITE_AT)}
${NativeFillParams.wgsl}
@group(3) @binding(1) var<uniform> P: NativeFillParams;
const WC_LIFE_FULL = array<f32, ${ELEMENTS.length}>(${ELEMENTS.map((e) => glf(Math.max(0, e.life ?? 0))).join(',')});
// The generator's cell, as the copy's word would hold it: its id, ctype and temperature code.
fn wcLookOf(a: vec4f) -> u32 {
  let id = u32(clamp(eid(a), 0, NE - 1));
  return id | ((u32(max(floor(a.w), 0.0)) & 255u) << 8u) | (wcTempCode(a.y) << 16u);
}
// The world copy's word at world cell w as a V2 core: the generator's import where they agree.
fn wcFillCore(word: u32, gen: vec4f, w: vec3i) -> vec4u {
  let id = u32(wcId(word));
  let liquid = cls(id) == C_LIQUID;
  let whole = ((word >> ${AUX_SHIFT}u) & 127u) == ${WC_AUX_MAX}u;
  if ((word & ${WORD_LOOK_MASK}u) == wcLookOf(gen) && (!liquid || whole)) { return importA(gen); }
  let seed = f32(seedWorld(w, 0u, ${SALT.WC_FILL}u) >> 16u) * (SEED_MAX / 65536.0);
  let life = select(wcAux(word) * WC_LIFE_FULL[id], 0.0, liquid);
  var c = importA(vec4f(f32(id), wcTemp(word), life, f32(wcCtype(word)) + seed));
  if (liquid) { c.y = (c.y & 0xff000000u) | max(1u, u32(round(wcAux(word) * f32(FULLU)))); }
  return c;
}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32) {
  let base = (P.lo >> vec3u(2u)) * BS;
  let nb = vec3u((P.hi - base + BS - 1) / BS);
  let k = foldId(wg, nwg);
  if (k >= nb.x * nb.y * nb.z) { return; }
  let p = base + vec3i(vec3u(k % nb.x, (k / nb.x) % nb.y, k / (nb.x * nb.y))) * BS + vec3i(i32(li & 3u), i32((li >> 2u) & 3u), i32(li >> 4u));
  if (any(p < P.lo) || any(p >= P.hi) || !inGrid(p)) { return; }
  let w = P.origin + p;
  nativeWriteCore(slotOf(p), wcFillCore(wcCell(w), sceneCell(w).A, w));
}`;

// ---- The same rule in JS (tools/world-move-cpu-check.mjs): which cells take the generator's import.
const ROWS = v2Rows();
/** The generator's state A (id, °C, life, ctype + seed) as a word's look (bits 0-23). */
export function wcLookOfA(a) {
  const id = Math.min(ELEMENTS.length - 1, Math.max(0, Math.floor(a[0] + 0.5)));
  return (id | ((Math.max(0, Math.floor(a[3])) & 255) << 8) | (wcTempCode(a[1]) << 16)) >>> 0;
}
/** Whether the fill takes the generator's cell a over the copy's word (else it decodes the word). */
export function copyFillKeepsGenerator(word, a) {
  const id = word & 255, liquid = ROWS[id]?.cls === V2.LIQUID, whole = ((word >>> AUX_SHIFT) & 127) === WC_AUX_MAX;
  return ((word & WORD_LOOK_MASK) >>> 0) === wcLookOfA(a) && (!liquid || whole);
}
/** A decoded liquid's fill (V2 FULL units) from the word's aux. */
export const copyFillLiquid = (word) => Math.max(1, Math.round(((word >>> AUX_SHIFT) & 127) / WC_AUX_MAX * FULL));

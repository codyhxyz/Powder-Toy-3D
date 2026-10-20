// The electric pass: V1's electricity at V1's rate (src/electricity.js, react.js
// electric). V1 steps NOMINAL_STEP_RATE times a second and each step every
// conductor, switch, powered clone and sensor reads all six face neighbours as
// the last step left them, so a spark front moves a cell a step. The contact
// block sees three partners on half the ticks, a quarter of that rate at best;
// electricity is this pass's instead. Each tick runs CT_ELEC_STEPS (v2/contact.js)
// steps, each a gather (every listed cell's next state from its own and its six
// neighbours' cores, into a scratch word when it changes: ctElecStep) and a
// commit (the words onto the cores, the Joule heat a declared source: ctElecApply),
// so a step reads only the step before, exactly as V1's ping-pong does.
//
// Cost goes where electricity is live. Step 0 gathers the awake bricks (the
// rest test's list: every electric change marks its brick busy, so a brick that
// could change is awake), skipping every cell that is not electric material
// without a neighbour read. A brick where step 0 changed anything lists its 3³
// neighbourhood (a front moves at most CT_ELEC_STEPS ≤ BS cells a tick: at most
// one brick on each axis), and steps 1-3 and every commit run over that list
// only. With no live electricity the list is empty and those dispatches do nothing.
import { contactWGSL as productionContactWGSL } from './contact.js';
import { v2Head, ARGS2, V2_CONTACT_LAYOUT, V2_ARGS_LAYOUT } from '../v2.js';
import { LAYOUT, gridDims } from '../common.js';
import { fold } from '../../gpu/kernels.js';

// The contact module's declarations this pass reaches, and nothing else: its structs, constants
// and row tables, and the functions the electric rules call (transitively). The block's rules
// (contactBlock and every rule only it calls) stay the block pass's alone, so this pass compiles
// small and the contact module still compiles once, in the block pass.
const ELECTRIC_ROOTS = ['ctElecMaterial', 'ctElecStep', 'ctElecApply', 'ctUnpack', 'ctPack', 'ctSeed', 'ctRoll', 'ctNew'];
export function electricContactWGSL(contactWGSL) {
  const parts = [], fns = new Map();
  let at = 0;
  const fnHead = /^fn\s+(\w+)\s*\(/;
  // split into top-level declarations: a function ends at its matching brace, anything else at a line end
  while (at < contactWGSL.length) {
    const rest = contactWGSL.slice(at), m = rest.match(fnHead);
    if (m && (at === 0 || contactWGSL[at - 1] === '\n')) {
      let i = contactWGSL.indexOf('{', at), depth = 0;
      for (; i < contactWGSL.length; i++) { if (contactWGSL[i] === '{') depth++; else if (contactWGSL[i] === '}' && --depth === 0) break; }
      const text = contactWGSL.slice(at, i + 1);
      fns.set(m[1], text); parts.push({ fn: m[1] });
      at = i + 1;
    } else {
      const end = contactWGSL.indexOf('\n', at);
      const stop = end < 0 ? contactWGSL.length : end + 1;
      parts.push({ text: contactWGSL.slice(at, stop) });
      at = stop;
    }
  }
  const keep = new Set(), todo = ELECTRIC_ROOTS.filter(n => fns.has(n));
  if (todo.length !== ELECTRIC_ROOTS.length) throw Error('electric pass: the contact module lacks its electric rules');
  while (todo.length) {
    const name = todo.pop();
    if (keep.has(name)) continue;
    keep.add(name);
    for (const [other] of fns) if (!keep.has(other) && new RegExp(`\\b${other}\\s*\\(`).test(fns.get(name))) todo.push(other);
  }
  return parts.map(p => (p.fn ? (keep.has(p.fn) ? fns.get(p.fn) : '') : p.text)).join('');
}

const MAIN = '@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) li: u32)';

// A listed brick: step 0 the awake list, later steps the electric list.
const listWGSL = /* wgsl */ `
var<workgroup> wgN: u32;
fn elecUse() -> u32 { return atomicLoad(&act2[V2_ELEC_COUNT + 1u]); }
fn elecListed(e: u32, awake: bool) -> u32 {
  if (awake) { return atomicLoad(&act2[V2_LIST + e]); }
  return atomicLoad(&act2[V2_ELEC_LIST + e]);
}`;

export const v2ElecGatherWGSL = (g, contactWGSL = productionContactWGSL) => /* wgsl */ `
${v2Head(g, { state: false }, 'contact')}
${electricContactWGSL(contactWGSL)}
${listWGSL}
var<workgroup> wgChanged: atomic<u32>;
// List a brick for this tick's later steps, once.
fn elecClaim(b: u32) {
  if (atomicOr(&act2[V2_ELEC_FLAG + b], 1u) == 0u) { atomicStore(&act2[V2_ELEC_LIST + atomicAdd(&act2[V2_ELEC_COUNT], 1u)], b); }
}
${MAIN} {
  let e = foldId(wg, nwg);
  let awake = P.elecStep == 0u;
  if (li == 0u) { wgN = select(elecUse(), useAwake(), awake); }
  if (e >= workgroupUniformLoad(&wgN)) { return; }
  let b = elecListed(e, awake);
  let s = b * 64u + li;
  let core = cells[s];
  let id = i32(cid(core));
  if (ctElecMaterial(id)) {
    let p = cellOf(s);
    let c = ctUnpack(core, banks[s]);
    var ns: array<CTCell, 6>;
    for (var k = 0; k < 6; k++) {
      let q = mEdge(p + face6(k));
      if (inGrid(q)) { let t = slotOf(q); ns[k] = ctUnpack(cells[t], banks[t]); }
      else { ns[k] = ctNew(CT_EMPTY, 0, 65536); ns[k].valid = 0; }
    }
    let word = ctElecStep(c, ns, ctRoll(ctSeed(p, P.tick), CT_ELEC_SALT + i32(P.elecStep)));
    if (word != 0) { atomicStore(&act2[V2_ELEC_SCRATCH + s], u32(word)); atomicStore(&wgChanged, 1u); }
  }
  if (!awake) { return; }
  workgroupBarrier();
  // (a brick of the 3³ per thread: mEdge's loop wrap as the activity scan's)
  if (li < 27u && atomicLoad(&wgChanged) != 0u) {
    let d = vec3i(i32(li % 3u), i32((li / 3u) % 3u), i32(li / 9u)) - vec3i(1);
    let n = mEdge((brickCoord(b) + d) * BS) / BS;
    if (all(n >= vec3i(0)) && all(n < vec3i(BX, BY, BZ))) { elecClaim(brickId(n)); }
  }
}
`;

// One thread: step 0's gather has listed the bricks; publish the list and its args, start it over.
export const v2ElecArgsWGSL = (g) => /* wgsl */ `
${v2Head(g)}
@group(2) @binding(3) var<storage, read_write> args: array<u32>;
@compute @workgroup_size(1)
fn main() {
  let n = atomicLoad(&act2[V2_ELEC_COUNT]);
  atomicStore(&act2[V2_ELEC_COUNT + 1u], n); atomicStore(&act2[V2_ELEC_COUNT], 0u);
  let y = max(1u, (n + 65534u) / 65535u);
  args[${ARGS2.ELEC}u] = (n + y - 1u) / y; args[${ARGS2.ELEC + 1}u] = y; args[${ARGS2.ELEC + 2}u] = 1u;
}
`;

export const v2ElecCommitWGSL = (g, contactWGSL = productionContactWGSL) => /* wgsl */ `
${v2Head(g, { state: false }, 'contact')}
${electricContactWGSL(contactWGSL)}
${listWGSL}
${MAIN} {
  let e = foldId(wg, nwg);
  if (li == 0u) { wgN = elecUse(); }
  if (e >= workgroupUniformLoad(&wgN)) { return; }
  let b = elecListed(e, false);
  // the last step: the brick's listed bit is clear for the next tick's step 0
  if (li == 0u && P.elecStep + 1u == u32(CT_ELEC_STEPS)) { atomicStore(&act2[V2_ELEC_FLAG + b], 0u); }
  let s = b * 64u + li;
  let word = atomicLoad(&act2[V2_ELEC_SCRATCH + s]);
  if (word == 0u) { return; }
  atomicStore(&act2[V2_ELEC_SCRATCH + s], 0u);
  let p = cellOf(s);
  let before = loadMaterial(s);
  let c = ctElecApply(ctUnpack(before.core, before.bank), i32(word), ctSeed(p, P.tick) ^ i32(P.elecStep));
  storeMaterial(s, before, Material(ctPack(c, before.core), c.bank));
  if (any(c.source != vec2u(0u))) { noteEnergySource(p, c.source); }
  markBusy(p);
}
`;

/** The pass's kernels for src/v2/physics.js (each built with the contact module it is given) and its bind family. */
export const V2_ELECTRIC_KERNELS = [
  { name: 'v2elecGather', code: v2ElecGatherWGSL, family: 'contact' },
  { name: 'v2elecArgs', code: v2ElecArgsWGSL, family: 'args', workgroupSize: [1, 1, 1] },
  { name: 'v2elecCommit', code: v2ElecCommitWGSL, family: 'contact' },
];
const familyLayouts = { contact: V2_CONTACT_LAYOUT, args: V2_ARGS_LAYOUT };
/** tools/check-wgsl.mjs, tools/check-sampler-budget.mjs (src/gpu/checks.js). */
export const WGSL_CHECK = V2_ELECTRIC_KERNELS.map(({ name, code, family, workgroupSize }) => ({ name, kind: 'compute', code: g => code(g),
  layouts: () => [LAYOUT.TABLES, 'EMPTY', familyLayouts[family]], dispatch: g => (workgroupSize ? [1, 1, 1] : fold(gridDims(g).nbricks)), tool: true }));

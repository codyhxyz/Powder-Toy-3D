// CPU-only: the activity pass over a GPU-built brick list is exact. A brick
// changes in the activity pass only if a busy brick lies in its 3³
// neighbourhood (its quiet run starts over) or its quiet run is still under
// its cap (it counts on); any other brick keeps quiet = cap, asleep, and a busy
// word activity would clear that is already zero (it was busy two ticks ago
// only if it was near one last tick, which reset its run). The scan scatters
// each busy brick to its neighbourhood (mEdge's loop wrap is symmetric) and
// lists every such brick once, and every awake brick; an asleep brick still
// counting toward the cap counts on in the scan instead (a near claim then
// starts it over in the pass). A twin of v2ActivityWGSL over every brick and a
// twin of the scan + listed pass must agree on every quiet, awake and busy
// word, the awake set and the busy count, tick after tick, on solid and loop
// edges, with sparse marks and whole-box writes. Dropping the quiet-run
// seeding, the wrap, the claim bit or the scan's count, or counting a brick
// twice or an awake brick in the scan, must break it.
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { v2ActivityWGSL, v2ActScanWGSL, v2ActLayout, QUIET_TICKS, QUIET_CAP } from '../../src/shaders/v2.js';

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function box(dims, loop) {
  const nb = dims[0] * dims[1] * dims[2], id = c => c[0] + dims[0] * (c[1] + dims[1] * c[2]);
  const coord = b => [b % dims[0], Math.floor(b / dims[0]) % dims[1], Math.floor(b / (dims[0] * dims[1]))];
  // activity's neighbour: mEdge((bc + d) * 4) / 4, kept only inside the grid
  const around = (b, sign = 1) => {
    const c = coord(b), out = [];
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      let n = [c[0] + sign * dx, c[1] + sign * dy, c[2] + sign * dz];
      if (loop) n = n.map((x, a) => ((x % dims[a]) + dims[a]) % dims[a]);
      if (n.every((x, a) => x >= 0 && x < dims[a])) out.push(id(n));
    }
    return out;
  };
  return { nb, around };
}
// v2ActivityWGSL: every brick.
function full(B, s, busyIn, busyOut) {
  let busy = 0; const list = [];
  for (let b = 0; b < B.nb; b++) {
    const near = B.around(b).some(n => busyIn[n]);
    if (busyIn[b]) busy++;
    const q = near ? 0 : Math.min(s.quiet[b] + 1, QUIET_CAP); s.quiet[b] = q;
    s.awake[b] = q < QUIET_TICKS ? 1 : 0; if (s.awake[b]) list.push(b);
    busyOut[b] = 0;
  }
  return { busy, list };
}
// v2ActScanWGSL then v2ActivityWGSL over the listed bricks.
function listed(B, s, busyIn, busyOut, variant) {
  const plist = [];
  const claim = (b, bits) => { const old = s.near[b]; s.near[b] |= bits; if (!(old & 2) || variant.noClaim) plist.push(b); };
  for (let b = 0; b < B.nb; b++) {
    if (busyIn[b]) for (const n of (variant.noWrap ? B.aroundNoWrap : B.around)(b, -1)) claim(n, 3);
    // the scan's own count: awake bricks are listed, asleep ones under the cap count on here
    const q = s.quiet[b], awake = q < (variant.scanAwake ? 0 : QUIET_TICKS);
    if (variant.noWarm) continue;
    if (awake || (variant.claimWarm && q < QUIET_CAP)) claim(b, 2);
    if (!awake && q < QUIET_CAP && !variant.noScanCount) s.quiet[b] = q + 1;
  }
  let busy = 0; const list = [];
  for (const b of plist) {
    const near = (s.near[b] & 1) !== 0; s.near[b] = 0;
    if (busyIn[b]) busy++;
    const q = near ? 0 : Math.min(s.quiet[b] + 1, QUIET_CAP); s.quiet[b] = q;
    s.awake[b] = q < QUIET_TICKS ? 1 : 0; if (s.awake[b]) list.push(b);
    busyOut[b] = 0;
  }
  return { busy, list };
}
function run(seed, dims, loop, variant = {}) {
  const random = rng(seed), B = box(dims, loop), noWrapBox = box(dims, false);
  B.aroundNoWrap = noWrapBox.around;
  const state = () => ({ quiet: new Uint32Array(B.nb).fill(QUIET_TICKS), awake: new Uint8Array(B.nb), near: new Uint32Array(B.nb) });
  const a = { s: state(), busy: [new Uint8Array(B.nb), new Uint8Array(B.nb)] }, b = { s: state(), busy: [new Uint8Array(B.nb), new Uint8Array(B.nb)] };
  for (let t = 1; t <= 300; t++) {
    const inA = t & 1 ? 0 : 1, outA = 1 - inA; // busyIn(t) is busyOut(t - 1)
    const ra = full(B, a.s, a.busy[inA], a.busy[outA]), rb = listed(B, b.s, b.busy[inA], b.busy[outA], variant);
    if (ra.busy !== rb.busy || ra.list.length !== rb.list.length || ra.list.slice().sort((x, y) => x - y).join() !== rb.list.slice().sort((x, y) => x - y).join()) return false;
    for (const k of ['quiet', 'awake']) if (a.s[k].join() !== b.s[k].join()) return false;
    if (b.s.near.some(x => x !== 0)) return false;
    // this tick's writers mark busyOut(t); now and then a whole-box write (modes, restores, window)
    const marks = random() < 0.25 ? 0 : Math.floor(random() * 4);
    for (let k = 0; k < marks; k++) { const m = Math.floor(random() * B.nb); a.busy[outA][m] = b.busy[outA][m] = 1; }
    if (random() < 0.02) for (const s of [a, b]) { s.busy[0].fill(1); s.busy[1].fill(1); }
    for (let i = 0; i < 2; i++) if (a.busy[i].join() !== b.busy[i].join()) return false;
  }
  return true;
}
const shapes = [[6, 4, 5], [2, 7, 3], [1, 1, 9], [8, 2, 2]];
let runs = 0;
for (const loop of [false, true]) for (const dims of shapes) for (let seed = 1; seed <= 12; seed++) {
  assert.ok(run(seed + 31 * runs, dims, loop), `listed activity differs: dims ${dims}, loop ${loop}, seed ${seed}`); runs++;
}
for (const [what, variant, loop] of [['no quiet-run seeding', { noWarm: true }, false], ['a scatter without the loop wrap', { noWrap: true }, true], ['no claim bit', { noClaim: true }, false],
  ['an asleep run the scan does not count', { noScanCount: true }, false], ['an asleep run counted in the scan and the pass', { claimWarm: true }, false],
  ['an awake run counted in the scan', { scanAwake: true }, false]]) {
  let broke = false;
  for (const dims of shapes) for (let seed = 1; seed <= 12 && !broke; seed++) broke = !run(seed, dims, loop, variant);
  assert.ok(broke, `${what} must break the listed activity`);
}
// The generated scan and pass are the twins above.
const g = gridLayout(16, 8, 8), scan = v2ActScanWGSL(g), act = v2ActivityWGSL(g), L = v2ActLayout(g);
assert.match(scan, /let n = mEdge\(\(bc \+ vec3i\(-dx, -dy, -dz\)\)\*BS\)\/BS;/);
assert.match(scan, /if \(atomicLoad\(&act2\[P\.busyIn \+ b\]\) != 0u\)/);
assert.match(scan, /let q = atomicLoad\(&act2\[V2_QUIET \+ b\]\);\s*if \(q < QUIET_TICKS\) \{ actClaim\(b, 2u\); \} else if \(q < QUIET_CAP\) \{ atomicStore\(&act2\[V2_QUIET \+ b\], q \+ 1u\); \}/);
// the scan's count follows the scatter: a busy brick's near claim on itself is in place before its pass
assert.ok(scan.indexOf('actClaim(brickId(n), 3u)') < scan.indexOf('atomicStore(&act2[V2_QUIET + b], q + 1u)'));
assert.match(scan, /if \(\(atomicOr\(&act2\[V2_NEAR \+ b\], bits\) & 2u\) == 0u\)/);
assert.match(act, /let near = \(atomicExchange\(&act2\[V2_NEAR \+ b\], 0u\) & 1u\) != 0u;/);
assert.match(act, /if \(near\) \{ q = 0u; \} else \{ q = min\(q \+ 1u, QUIET_CAP\); \}/);
assert.ok(L.near >= L.words && L.plist >= L.words, 'the scan words are not saved');
console.log(`activity list: ${runs} runs of 300 ticks identical to the all-brick pass (quiet, awake, busy words, awake set, busy count); 6 red variants caught`);

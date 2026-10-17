// CPU-only: every wake lands in the busy words the next activity pass reads.
// The activity pass of tick t reads busyIn(t) and clears busyOut(t) unread
// (v2ActivityWGSL), so a wake is kept only in busyOut(t) = busyIn(t + 1) when
// written during tick t or between ticks t and t + 1. This evaluates the
// markBusy target of the real generated WGSL of every writer family, with the
// params its real driver records, against that protocol for both tick parities.
// Before the fix the dynamics families (particles, blasts, air, jets) and the
// tools wrote busyIn(t), which the next activity pass clears: every such wake
// was lost.
import assert from 'node:assert/strict';
import { gridLayout } from '../../src/sim.js';
import { PhysicsV2 } from '../../src/v2/physics.js';
import { NativeDynamics } from '../../src/v2/dynamics.js';
import { nativeDynamicsHead, v2ActLayout, v2ColumnWGSL, v2ImportWGSL, v2RunsWGSL, v2PairsWGSL } from '../../src/shaders/v2.js';
import { particlesWGSL } from '../../src/shaders/v2/particles.js';
import { blastsWGSL } from '../../src/shaders/v2/blasts.js';
import { airWGSL } from '../../src/shaders/v2/air.js';
import { jetsWGSL } from '../../src/shaders/v2/jets.js';
import { nativeWeatherCommitWGSL } from '../../src/v2/nativeWeather.js';
import { nativeForceCommitWGSL } from '../../src/v2/nativeForcing.js';

const g = gridLayout(16, 8, 8), A = v2ActLayout(g), NB = g.nbricks;
// The busy-word index expression of markBusy (or the import's direct wake), as JS.
function target(code, pattern = /fn markBusy\(p: vec3i\) \{ let q=mEdge\(p\); if \(inGrid\(q\)\) \{ atomicStore\(&act2\[(.+?) \+ brickOfCell\(q\)\], 1u\); \} \}/) {
  const m = code.match(pattern);
  assert.ok(m, 'markBusy keeps its shared one-line form');
  const expr = m[1].replace(/\b(\d+)u\b/g, '$1');
  return P => Function('P', 'V2_BUSY0', 'NBRICKS', 'select', `return ${expr};`)(P, A.busy0, NB, (no, yes, c) => (c ? yes : no));
}
const owner = { sim: { origin: [0, 0, 0] }, layout: A, jets: { isReady: true }, tick: 0, _params: PhysicsV2.prototype._params };
owner.sim.compact = owner;
const dynamics = { owner, sequence: 1 };
const dynamicParams = (tick, extra) => NativeDynamics.prototype._params.call(dynamics, tick, extra);
const weatherParams = { wgsl: 'struct WakeParams { tick: u32 }', name: 'WakeParams' };

// [name, generated code, params at recording time (owner.tick is the last tick run, or the one running)]
const writers = [
  ['grid column (in tick)', v2ColumnWGSL(g), t => owner._params(t)],
  ['particles deposit (in tick)', particlesWGSL(g, nativeDynamicsHead, 'deposit'), t => dynamicParams(t)],
  ['blasts finish (in tick)', blastsWGSL(g, nativeDynamicsHead, 'finish'), t => dynamicParams(t)],
  ['air source (in tick)', airWGSL(g, nativeDynamicsHead, 'source'), t => dynamicParams(t)],
  ['column water runs (in tick)', v2RunsWGSL(g), t => owner._params(t)],
  ['column water pairs (in tick)', v2PairsWGSL(g), t => ({ ...owner._params(t), pairStage: 1 })],
  ['jets spawn (in tick)', jetsWGSL(g, 'spawn'), t => dynamicParams(t)],
  // tools record with the owner's tick, between ticks (applyToolImpulse, physgun, body coupling)
  ['tool impulse apply (between ticks)', blastsWGSL(g, nativeDynamicsHead, 'apply'), t => dynamicParams(t, { mode: 2 })],
  ['air tool (between ticks)', airWGSL(g, nativeDynamicsHead, 'tool'), t => dynamicParams(t, { mode: 3 })],
  // weather and forcing number their params as the tick about to run, and allocate through blasts
  ['weather commit (between ticks)', nativeWeatherCommitWGSL(g, weatherParams, 'air'), t => ({ tick: t + 1 })],
  ['forcing commit (between ticks)', nativeForceCommitWGSL(g, weatherParams, 'plan'), t => ({ tick: t + 1 })],
  ['forcing allocate (between ticks)', blastsWGSL(g, nativeDynamicsHead, 'apply'), t => dynamicParams(t + 1, { mode: 15 })],
];
const importTarget = target(v2ImportWGSL(g), /atomicStore\(&act2\[(P\.busyIn) \+ b\], 1u\)/);

let checked = 0;
for (const t of [1, 2, 7, 100]) {
  owner.tick = t;
  const busyIn = next => owner._params(next).busyIn;
  // The activity pass of tick t has run: it cleared busyOut(t). Whatever is written now must be read at t + 1.
  for (const [name, code, params] of writers) {
    const act = new Uint32Array(2 * NB), brick = 5;
    act[target(code)(params(t)) + brick] = 1;
    const seen = act[busyIn(t + 1) + brick] === 1; // activity(t + 1) reads busyIn(t + 1), then clears busyOut(t + 1) unread
    assert.ok(seen, `${name}: a wake at tick ${t} is lost (wrote word ${target(code)(params(t))}, activity ${t + 1} reads ${busyIn(t + 1)})`);
    checked++;
  }
  // The import records with the next tick's params (sync, or the tick's own first pass) and wakes its busyIn.
  assert.equal(importTarget(owner._params(t + 1)), busyIn(t + 1), 'the import wakes the busy words the next activity pass reads');
  checked++;
}
console.log(`wake parity: ${checked} writer/tick cases land in the busy words the next activity pass reads`);

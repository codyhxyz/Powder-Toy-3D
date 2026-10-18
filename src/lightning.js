import { createNativeWeatherKernel } from './v2/nativeWeather.js';
import {
  BoltParams, boltUpdateWGSL, boltDeclsWGSL, stormBrickFrag, stormScanFrag, StormParams, ScanParams, STORM_LAYOUT, STORM_KEY,
} from './shaders/lightning.js';
import { BOLT, STORM, boltPath, boltStart, toolStrikeR, stormColumns, pickStrike } from './bolt.js';
import { slotCell } from './sim.js';
import { fold } from './gpu/kernels.js';

// Lightning on the GPU: the Lightning tool's strikes and storms' (src/bolt.js
// has the shape and the rules, shaders/lightning.js the kernels;
// docs/webgpu.md G4). One bolt for both: strike() builds its path on the CPU
// and writes it with one edit over its bounds (sim.edit: in place, the
// bricks it changes marked for the activity map).
//
// Storms. Every STORM.POLL_STEPS steps, one dispatch finds the most charged
// cloud cell (react.js charges freezing cloud that snow falls through) and
// its key is read back through a result ring (gpu.readback.ring), a few
// frames later. If it is at breakdown and STORM.MIN_STEPS have passed since
// the last natural strike, a second small kernel scans the columns around it
// for the highest matter below, that is read back, and the bolt strikes the
// nearest (conductors counting nearer), spending the charge around its origin.
//
// A strike sparks the conductors it lands on (shaders/lightning.js calls
// src/electricity.js sparkCell; the CPU twin's World.strike, spark).

const RESULT_SLOTS = 4;   // storm reads in flight at most (one a poll, POLL_STEPS steps apart)
const VEC4 = 4;

// gpu: unused (each simulation's device is its own gpu); kept for the wire's call
export function createLightning({ onReady = () => {} } = {}) {
  let k = null, simId = -1, frame = 0;
  let nextPoll = 0, lastStrike = -Infinity, job = null, generation = 0;
  const rng = Math.random;
  const api = {
    strikes: 0,             // natural strikes so far (tools/mat-check)
    lastBolt: null,         // the last bolt's { from, to, segs, id } (tools/mat-check)
    strikeTool, update, strike,
    reset() { generation++; job = null; nextPoll = 0; lastStrike = -Infinity; api.lastBolt = null; },
    /** Resolves when the current simulation's kernels are built. */
    get ready() { return k?.ready ?? Promise.resolve(); },
  };

  // The kernels for sim's grid (pipelines are cached by source, so a rebuilt
  // grid of the same size builds nothing) and the storm's result rings.
  function ensure(sim) {
    if (sim.id === simId) return;
    const gpu = sim.gpu, g = sim.g;
    if (g.slots - 1 > STORM_KEY.SLOT_MAX) throw new Error(`lightning: a ${g.nx}×${g.ny}×${g.nz} grid has more slots than a storm key holds`);
    const L = gpu.layout('STORM', STORM_LAYOUT);
    const layouts = [sim.L.TABLES, sim.L.STATE_RO, L];
    const pick = gpu.readback.ring('storm pick', VEC4 * 4, RESULT_SLOTS);
    const scan = gpu.readback.ring('storm scan', STORM.CANDIDATES * VEC4 * 4, RESULT_SLOTS);
    const group = (ring, name) => gpu.bindGroup(L, [{ binding: 0, resource: { buffer: ring.buffer } }], name);
    const makeBolt = sim.compactOwner ? (name, spec) => createNativeWeatherKernel(sim, name, spec) : (name, spec) => sim.editKernel(name, spec);
    k = {
      bolt: makeBolt('bolt', { update: boltUpdateWGSL, params: BoltParams, reads: 'own', decls: boltDeclsWGSL }),
      search: gpu.kernel({ name: 'stormSearch', code: stormBrickFrag(g), layouts, params: StormParams, build: 'idle' }),
      scan: gpu.kernel({ name: 'stormScan', code: stormScanFrag(g), layouts, params: ScanParams, build: 'idle' }),
      pick, scanRing: scan, pickGroup: group(pick, 'storm pick'), scanGroup: group(scan, 'storm scan'),
    };
    k.ready = Promise.all([k.bolt.ready, k.search.ready, k.scan.ready]);
    simId = sim.id;
    nextPoll = sim.frame + STORM.POLL_STEPS;
    lastStrike = -Infinity;
    job = null;
  }
  const built = (kernel) => kernel.state === 'ready';
  const originOf = sim => [sim.origin.x, sim.origin.y, sim.origin.z];
  const capture = (sim, context = {}) => ({
    sim, id: sim.id, kernels: k, generation, origin: originOf(sim),
    frame: sim.frame, paints: sim.paints, wholeWrites: sim.wholeWrites,
    world: context.worldIdentity, epoch: context.worldEpoch,
  });
  const current = (sim, c, context = {}) => c.sim === sim && c.id === sim.id && c.kernels === k &&
    c.generation === generation && !sim.disposed && !sim.gpu.failure &&
    c.origin.every((v, i) => v === originOf(sim)[i]) && sim.frame >= c.frame &&
    c.paints === sim.paints && c.wholeWrites === sim.wholeWrites &&
    c.world === context.worldIdentity && c.epoch === context.worldEpoch;

  // Draw one bolt from `from` to `to` (cells, [x, y, z]). strikeR: the strike's
  // radius; origin and dischargeR: the cloud charge it spends (storms). Its
  // path is made now; the edit is recorded now, or once the kernel is built.
  function strike(sim, from, to, { strikeR = STORM.STRIKE_R, dischargeR = 0, id = -1 } = {}) {
    ensure(sim);
    const g = sim.g, size = [g.nx, g.ny, g.nz];
    const segs = boltPath(from, to, rng, size);
    const segA = [], segB = [];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const grow = (p, r) => { for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i] - r); hi[i] = Math.max(hi[i], p[i] + r); } };
    for (const s of segs) {
      segA.push([s.a[0], s.a[1], s.a[2], s.r]);
      segB.push([s.b[0], s.b[1], s.b[2], 0]);
      grow(s.a, s.r); grow(s.b, s.r);
    }
    grow(to, strikeR + BOLT.STRIKE_P_REACH);
    if (dischargeR > 0) grow(from, dischargeR);
    frame = (frame + 1) >>> 0;
    const values = { segA, segB, segs: segs.length, strike: to, strikeR, boltFrom: from, dischargeR, lo, hi, frame };
    job = null; // retire a natural decision superseded by this explicit strike
    const write = () => {
      if (sim.compactOwner) k.bolt.run(sim.touchCentres(lo, hi), values);
      else sim.edit(k.bolt, sim.touchCentres(lo, hi), values);
      api.lastBolt = { from, to, segs, id };
    };
    if (built(k.bolt.main)) write();
    else {
      const kernels = k, captured = capture(sim);
      kernels.bolt.ready.then(() => { if (current(sim, captured)) write(); }, () => {});
    }
    return segs;
  }

  // The Lightning tool: strike the surface under the cursor. hit: the app's
  // pick ({ cell, face, id }); radius: the brush radius.
  function strikeTool(sim, hit, radius) {
    ensure(sim);
    const g = sim.g, size = [g.nx, g.ny, g.nz];
    const n = [0, 0, 0];
    n[Math.floor(hit.face / 2)] = hit.face % 2 === 0 ? 1 : -1;
    const cell = [hit.cell.x, hit.cell.y, hit.cell.z];
    const to = [0, 1, 2].map((i) => cell[i] + 0.5 + n[i] * 0.5);
    return strike(sim, boltStart(to, rng, size), to, { strikeR: toolStrikeR(radius), id: hit.id });
  }

  // Call only during allowed host steps (including explicit manual stepping).
  // Readback callbacks deposit results; only this entry point scans or strikes.
  function update(sim, context = {}) {
    if (sim.disposed || sim.gpu.failure) { job = null; return; }
    ensure(sim);
    if (job && !current(sim, job.capture, context)) { job = null; nextPoll = 0; }
    if (job) {
      if (!job.done) return;
      const finished = job; job = null;
      if (finished.stage === 'poll') {
        if (finished.result) scan(sim, finished.result, context);
      } else if (finished.result && sim.frame - lastStrike >= STORM.MIN_STEPS) {
        lastStrike = sim.frame; api.strikes++;
        strike(sim, finished.origin, finished.result.to, {
          strikeR: STORM.STRIKE_R, dischargeR: STORM.DISCHARGE_R, id: finished.result.id,
        });
      }
      return;
    }
    if (sim.frame < nextPoll || !built(k.search) || !built(k.scan) || !built(k.bolt.main)) return;
    nextPoll = sim.frame + STORM.POLL_STEPS;
    if (sim.frame - lastStrike < STORM.MIN_STEPS) return;
    const kernels = k, f = sim.gpu.frame;
    const slot = kernels.pick.next();
    f.clear(kernels.pick.buffer, kernels.pick.offset(slot), kernels.pick.slotBytes);   // (its key is an atomicMax)
    kernels.search.dispatch(f, fold(sim.g.nbricks), { bind: [sim.tables, sim.compact ? sim.bindPhysicalRO : sim.bindRO, kernels.pickGroup], header: sim.readHeader({ physical: true }), params: { slot } });
    const pending = job = { stage: 'poll', capture: capture(sim, context), done: false, result: null };
    kernels.pick.read(slot).then((bytes) => {
      if (job !== pending) return;
      const key = new Uint32Array(bytes)[0];
      if (key === 0) return;
      const [x, y, z] = slotCell(sim.g, STORM_KEY.SLOT_MAX - (key & STORM_KEY.SLOT_MAX));
      pending.result = [x + 0.5, y + 0.5, z + 0.5];
    }).catch(() => {}).finally(() => { pending.done = true; if (job === pending) onReady(); });
  }

  function scan(sim, origin, context) {
    const g = sim.g, kernels = k;
    const cols = stormColumns(origin, [g.nx, g.ny, g.nz]);
    const slot = kernels.scanRing.next();
    kernels.scan.dispatch(sim.gpu.frame, [1, 1, 1], {
      bind: [sim.tables, sim.compact ? sim.bindPhysicalRO : sim.bindRO, kernels.scanGroup], header: sim.readHeader({ physical: true }),
      params: { cols: cols.map((c) => [c[0], c[1], 0, 0]), count: cols.length, fromY: Math.floor(origin[1]), slot },
    });
    const pending = job = { stage: 'scan', capture: capture(sim, context), origin, done: false, result: null };
    kernels.scanRing.read(slot).then((bytes) => {
      if (job !== pending) return;
      const buf = new Float32Array(bytes);
      const hits = cols.map((c, i) => ({ x: c[0], z: c[1], top: buf[i * VEC4], id: Math.round(buf[i * VEC4 + 1]), ok: buf[i * VEC4 + 2] > 0 }))
        .filter((h) => h.ok);
      pending.result = pickStrike(origin, hits);
    }).catch(() => {}).finally(() => { pending.done = true; if (job === pending) onReady(); });
  }

  // (the rings are the device's, its kernels cached by source: nothing of ours to free)
  api.dispose = () => { api.reset(); k = null; simId = -1; };
  return api;
}

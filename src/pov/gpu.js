import { routeNativePOV } from '../v2/interactions.js';
import { NativeTransfer } from '../v2/transfer.js';
import { coupleNativeBody } from '../v2/body.js';
// The first person's GPU work on WebGPU (docs/webgpu.md G2): every write to
// the world is an edit (sim.edit, D6: one dispatch over a box, in call order,
// the bricks it changes marked on the GPU), and every read is a probe whose
// answer goes into a slot of a result ring that lands 1–3 frames later (B7).
// Nothing here waits for the GPU.
//
//   const blow = toolPass(axeFrag);                       // a tool's pass: its family and tuning
//   blow(sim, { center, dir }, sim.touchCentres(lo, hi)); // false while its kernel is building
//   const pov = povGpu(sim);
//   pov.edit('povCouple', box, values);                   // a family by name
//   const answer = pov.probe('povProbe', { boxLo });      // Promise<ArrayBuffer>, or null (not built yet)
//
// Kernels are the sim's (an edit kernel's bind groups hold its buffers), but
// their pipelines are cached by their text, so another simulation of the same
// grid size builds nothing new (G2: never per sim.id). They build when POV
// starts (prepare(), from src/pov/index.js: B5's "POV families on entering
// POV") or on first use; until a kernel is built, its use is skipped (an edit
// returns false, a probe null). What has a cost besides its edit waits for
// every kernel (`ready`, B5's "a POV tool's use waits"): the toolbelt takes
// no input, the kick doesn't kick, rounds and grenades hold in the air with
// their blasts, the wands' batches stay queued. What is left skips a frame's
// edit harmlessly: a probe that doesn't land is one more frame of latency, a
// transfer that isn't issued is a busy engine, the body's coupling resumes
// next frame. The rings and the laser's shot buffers belong to the device,
// shared by every simulation on it.

import { POV_BODY_EDITS, povProbeFrag, ProbeParams, PROBE_BYTES, PROBE_DISPATCH, RING_LAYOUT } from '../shaders/povBody.js';
import { POV_KICK_EDITS, hookCellFrag, CellsParams, CELLS_MAX } from '../shaders/povKick.js';
import { POV_TOOL_EDITS, physgunComFrag, ComParams, COM_LAYOUT } from '../shaders/povTools.js';
import {
  POV_BORE_EDITS, burrowProbeFrag, BurrowProbeParams, BURROW_PROBE_DISPATCH, BURROW,
  laserReachFrag, laserFrag, LaserParams, LASER_REACH_LAYOUT, LASER_APPLY_LAYOUT, LASER_BEAM_BYTES, LASER_REACH_BYTES,
} from '../shaders/povBore.js';
import { POV_TRACE_EDITS, traceFrag, TraceParams, TRACE_BYTES } from '../shaders/povTrace.js';
import { transferFrag, TransferParams, TRANSFER_BYTES } from '../shaders/transfer.js';
import { WAND_EDITS, wandTraceFrag, WandTraceParams, WAND_TRACE_BYTES, WAND_RAYS, wandClearanceFrag, WandClearanceParams, WAND_CLEARANCE_BYTES } from '../shaders/wands.js';

// Every edit family (name → what sim.editKernel takes).
export const POV_EDITS = { ...POV_BODY_EDITS, ...POV_KICK_EDITS, ...POV_TOOL_EDITS, ...POV_BORE_EDITS, ...POV_TRACE_EDITS, ...WAND_EDITS };

// Every probe: its kernel, params, dispatch size and ring. A ring's slots
// outnumber the answers its users keep in flight (each user's own cap: three
// per body probe, three traces, …), so a slot is never written again before
// its copy is recorded (readback.js flushes first if it would be).
const PROBES = {
  povProbe: { code: povProbeFrag, params: ProbeParams, size: PROBE_DISPATCH, ring: [PROBE_BYTES, 32] },   // up to 10 bodies × 3
  povCells: { code: hookCellFrag, params: CellsParams, size: [1, 1, 1], ring: [CELLS_MAX * 16, 16] },
  povBurrowProbe: { code: burrowProbeFrag, params: BurrowProbeParams, size: BURROW_PROBE_DISPATCH, ring: [BURROW.PROBE_AHEAD * 16, 16] },
  povTrace: { code: traceFrag, params: TraceParams, size: [1, 1, 1], ring: [TRACE_BYTES, 16] },
  povWandTrace: { code: wandTraceFrag, params: WandTraceParams, size: [WAND_RAYS / 64, 1, 1], ring: [WAND_TRACE_BYTES, 8] },
  povWandClearance: { code: wandClearanceFrag, params: WandClearanceParams, size: [1, 1, 1], ring: [WAND_CLEARANCE_BYTES, 8] },
};
const TRANSFER_RING = [TRANSFER_BYTES, 16];   // 8 transfers in flight at most (tools/transfer.js MAX_IN_FLIGHT)
const LASER_RING = [LASER_REACH_BYTES, 8];

const devices = new WeakMap();   // gpu → the device's POV state
const sims = new WeakMap();      // sim → its PovGpu

// The device's POV state: named layouts, rings and their bind groups, the
// laser's shot buffers, and the kernels that don't bind the state writable
// (made per grid size: their text has the grid in it).
function deviceState(gpu) {
  let d = devices.get(gpu);
  if (d) return d;
  const S = GPUBufferUsage.STORAGE, CS = GPUBufferUsage.COPY_SRC;
  d = {
    layouts: {
      ring: gpu.layout('pov ring', RING_LAYOUT),
      com: gpu.layout('pov com', COM_LAYOUT),
      laserReach: gpu.layout('pov laser reach', LASER_REACH_LAYOUT),
      laserApply: gpu.layout('pov laser apply', LASER_APPLY_LAYOUT),
    },
    rings: new Map(),
    ringGroups: new Map(),
    kernels: new Map(),
    // the laser's shot: written by its reach kernel, read by its apply (and its indirect args)
    beam: gpu.createBuffer({ label: 'pov laser beam', size: LASER_BEAM_BYTES, usage: S | CS }),
    beamArgs: gpu.createBuffer({ label: 'pov laser args', size: 16, usage: S | CS | GPUBufferUsage.INDIRECT }),
    comGroups: new WeakMap(),
  };
  devices.set(gpu, d);
  return d;
}

// The ring `name` (made once per device) and its group 2 for the probes.
function ringOf(gpu, name, [bytes, slots]) {
  const d = deviceState(gpu);
  let r = d.rings.get(name);
  if (!r) {
    r = gpu.readback.ring(`pov ${name}`, bytes, slots);
    d.rings.set(name, r);
    d.ringGroups.set(name, gpu.bindGroup(d.layouts.ring, [{ binding: 0, resource: { buffer: r.buffer } }], `pov ${name} ring`));
  }
  return { ring: r, group: d.ringGroups.get(name) };
}

const ready = (k) => k.state === 'ready';

/** One simulation's POV kernels (povGpu(sim)). */
class PovGpu {
  constructor(sim) {
    this.sim = sim;
    this.gpu = sim.gpu;
    this.edits = new Map();
    this.d = deviceState(this.gpu);
  }

  // A kernel of ours that binds the state read-only or in its own way, made
  // once per device and grid size.
  _kernel(name, make) {
    const g = this.sim.g, key = `${name}@${g.nx}x${g.ny}x${g.nz}`;
    let k = this.d.kernels.get(key);
    if (!k) this.d.kernels.set(key, k = make());
    return k;
  }

  // The edit kernel of family `name` (built now if it isn't).
  editKernel(name) {
    let k = this.edits.get(name);
    if (!k) {
      const e = POV_EDITS[name];
      if (!e) throw new Error(`pov: no edit family ${name}`);
      this.edits.set(name, k = this.sim.editKernel(name, e));
    }
    return k;
  }

  /**
   * One edit of family `name` over `box` (docs/webgpu.md D6): its own dispatch
   * (two for a family that reads its neighbours), recorded now, in call order.
   * @param {string} name a POV_EDITS family
   * @param {{ lo: number[], hi: number[] } | null} box grid cells (sim.touchCentres), clipped to the grid
   * @param {object} values the family's params
   * @param {{ bind?: GPUBindingResource[] }} [opts]
   * @returns {boolean} false when nothing was recorded (no box, or the kernel is still building)
   */
  edit(name, box, values, opts) {
    if (this.sim.compact) {
      const routed = routeNativePOV(this.sim, name, box, values);
      if (routed !== null) return routed;
    }
    if (this.sim.compact && name === 'povCouple') return !!box && coupleNativeBody(this.sim, values);
    const k = this.editKernel(name);
    if (!box || !ready(k.main) || (k.apply && !ready(k.apply))) return false;
    this.sim.edit(k, box, values, opts);
    return true;
  }

  // A probe's kernel (PROBES), made once per device and grid.
  _probeKernel(name) {
    const p = PROBES[name], L = this.sim.L;
    return this._kernel(name, () => this.gpu.kernel({
      name, code: p.code(this.sim.g), params: p.params, layouts: [L.TABLES, L.STATE_RO, this.d.layouts.ring],
    }));
  }

  /**
   * Whether probe `name` can be recorded now (its kernel, started if it
   * wasn't, has built): for a caller that must not commit to a question it
   * can't ask yet (the rounds' traces).
   * @param {string} name a PROBES entry
   * @returns {boolean}
   */
  probeReady(name) { return ready(this._probeKernel(name)); }

  /**
   * A read-only probe: its kernel writes an answer into a slot of its ring,
   * recorded now over the state as it is (sim.probe).
   * @param {string} name a PROBES entry
   * @param {object} params its params, slot aside
   * @returns {Promise<ArrayBuffer> | null} the slot's bytes once they land; null while the kernel is building
   */
  probe(name, params) {
    const k = this._probeKernel(name);
    if (!ready(k)) return null;
    const { ring, group } = ringOf(this.gpu, name, PROBES[name].ring);
    const sim = this.sim;
    return sim.probe(k, PROBES[name].size, { ring, bind: [sim.tables, sim.bindRO, group], params });
  }

  /**
   * The physgun's centre of mass around `hold` into `buffer` (16 bytes,
   * STORAGE; the physgun's edit binds it read-only after this in the same
   * pass: GPU to GPU). False while the kernel is building.
   * @param {GPUBuffer} buffer
   * @param {number[]} hold grid cells
   */
  com(buffer, hold) {
    const k = this._comKernel();
    if (!ready(k)) return false;
    let group = this.d.comGroups.get(buffer);
    if (!group) this.d.comGroups.set(buffer, group = this.gpu.bindGroup(this.d.layouts.com, [{ binding: 0, resource: { buffer } }], 'pov com'));
    const sim = this.sim, state = sim.bindPhysicalRO;
    if (!state) return false;
    sim._dispatch(k, [1, 1, 1], { bind: [sim.tables, state, group], header: sim.readHeader({ physical: true }), params: { hold } });
    return true;
  }

  _comKernel() {
    const L = this.sim.L;
    return this._kernel('povCom', () => this.gpu.kernel({
      name: 'povCom', code: physgunComFrag(this.sim.g), params: ComParams, layouts: [L.TABLES, L.STATE_RO, this.d.layouts.com],
    }));
  }

  // A writer of ours that isn't an editMain kernel (the transfer, the laser):
  // what sim.edit does after its dispatch, for the app (version, wake: the
  // next step rebuilds the map; the GPU marked the changed bricks).
  _wrote() {
    this.sim.version++;
    this.sim.wake();
  }

  /**
   * One exact transfer (shaders/transfer.js): one dispatch that tests, ranks
   * and applies the slots, the answer into a ring slot.
   * @param {object} values TransferParams' fields (count, limit, mode, kinds, breaks, vel, cells, items)
   * @returns {Promise<ArrayBuffer> | null} TRANSFER_SLOTS vec4s; null while the kernel is building
   */
  transfer(values) {
    if (this.sim.compact) {
      this.nativeTransfer ??= new NativeTransfer(this.sim);
      return this.nativeTransfer.run(values);
    }
    if (values.items?.some(c => c.length > 4)) throw new Error('Native cargo must be placed with native physics; switching to v1 cannot discard fill/banks');
    const k = this._transferKernel();
    if (!ready(k)) return null;
    const sim = this.sim;
    const { ring, group } = ringOf(this.gpu, 'transfer', TRANSFER_RING);
    const slot = ring.next();
    sim._dispatch(k, [1, 1, 1], { bind: [sim.tables, sim.bindRW, group], header: sim.header(), params: { ...values, slot } });
    this._wrote();
    return ring.read(slot);
  }

  _transferKernel() {
    const sim = this.sim, L = sim.L;
    return this._kernel('povTransfer', () => this.gpu.kernel({
      name: 'povTransfer', code: transferFrag(sim.g), params: TransferParams, layouts: [L.TABLES, L.STATE_RW, this.d.layouts.ring],
      workgroupSize: [256, 1, 1],
    }));
  }

  /**
   * One laser shot (G2): the reach kernel walks the beam's axis and writes
   * its reach, the box it may change and the apply's indirect args; the
   * apply, dispatched from those args, burns the beam in place. Nothing waits
   * for the reach: it comes back through the ring.
   * @param {number[]} muzzle grid cells
   * @param {number[]} dir unit aim
   * @returns {Promise<{ reach: number, stopId: number }> | null} null while the kernels are building
   */
  laser(muzzle, dir) {
    const sim = this.sim, d = this.d;
    const [reach, apply] = this._laserKernels();
    if (!ready(reach) || !ready(apply)) return null;
    const state = sim.bindPhysicalRO;
    if (!state) return null;
    const { ring } = ringOf(this.gpu, 'laser', LASER_RING);
    d.laserReachGroup ??= this.gpu.bindGroup(d.layouts.laserReach, [
      { binding: 0, resource: { buffer: d.beam } }, { binding: 1, resource: { buffer: d.beamArgs } }, { binding: 2, resource: { buffer: ring.buffer } },
    ], 'pov laser reach');
    d.laserApplyGroup ??= this.gpu.bindGroup(d.layouts.laserApply, [{ binding: 0, resource: { buffer: d.beam } }], 'pov laser apply');
    const slot = ring.next();
    const header = sim.header();
    sim._dispatch(reach, [1, 1, 1], { bind: [sim.tables, state, d.laserReachGroup], header: sim.readHeader({ physical: true }), params: { muzzle, dir, slot } });
    sim._dispatch(apply, { indirect: d.beamArgs, offset: 0 }, { bind: [sim.tables, sim.bindRW, d.laserApplyGroup], header, params: { muzzle, dir, slot } });
    this._wrote();
    return ring.read(slot).then((bytes) => {
      const f = new Float32Array(bytes);
      return { reach: f[0], stopId: Math.round(f[1]) };
    });
  }

  _laserKernels() {
    const sim = this.sim, L = sim.L, d = this.d;
    return [
      this._kernel('povLaserReach', () => this.gpu.kernel({
        name: 'povLaserReach', code: laserReachFrag(sim.g), params: LaserParams, layouts: [L.TABLES, L.STATE_RO, d.layouts.laserReach],
        workgroupSize: [1, 1, 1],
      })),
      this._kernel('povLaser', () => this.gpu.kernel({
        name: 'povLaser', code: laserFrag(sim.g), params: LaserParams, layouts: [L.TABLES, L.STATE_RW, d.layouts.laserApply],
        workgroupSize: [4, 4, 4],
      })),
    ];
  }

  /**
   * Builds every POV kernel of this simulation (entering POV: B5). Resolves
   * when they are all ready.
   * @returns {Promise<unknown>}
   */
  prepare() {
    if (!this.prepared) {
      this.prepared = Promise.all([
        ...Object.keys(POV_EDITS).map((n) => this.editKernel(n).ready),
        ...Object.keys(PROBES).map((n) => this._probeKernel(n).ready),
        ...[this._comKernel(), this._transferKernel(), ...this._laserKernels()].map((k) => k.ready),
      ]).then(() => { this.built = true; });
      // (a kernel that fails to build fails the device, gpu.fail: B9; whoever awaits this still sees it)
      this.prepared.catch(() => {});
    }
    return this.prepared;
  }

  /**
   * Whether every POV kernel of this simulation is built (B5: what has a cost
   * besides its edit waits for them). Asking starts their build if nothing
   * has (prepare(): an NPC's tool, a check's toolbelt).
   */
  get ready() {
    if (!this.built) this.prepare();
    return this.built === true;
  }
}

/**
 * The POV kernels of a simulation.
 * @param {object} sim a Simulation
 * @returns {PovGpu}
 */
export function povGpu(sim) {
  let p = sims.get(sim);
  if (!p) sims.set(sim, p = new PovGpu(sim));
  return p;
}

/**
 * A stand-in for povGpu(sim) (node checks with a mock sim and no device:
 * tools/perks-cpu-check.mjs): { edit, probe, … } as PovGpu's.
 * @param {object} sim
 * @param {object} stand
 */
export function setPovGpu(sim, stand) { sims.set(sim, stand); }

/**
 * Builds every POV kernel for `sim` now (B5: on entering POV).
 * @param {object} sim
 * @returns {Promise<unknown>}
 */
export const preparePov = (sim) => povGpu(sim).prepare();

/**
 * A tool's pass (shaders/povTools.js axeFrag, flamerFrag, …: { edit, values }):
 * pass(sim, values, box) records one edit of the tool's family with its
 * tuning and `values`, over `box` (sim.touchCentres of what it may change).
 * @param {{ edit: string, values?: object }} tool
 * @returns {(sim: object, values: object, box: { lo: number[], hi: number[] }, opts?: object) => boolean}
 */
export function toolPass(tool) {
  const pass = (sim, values, box, opts) => povGpu(sim).edit(tool.edit, box, { ...tool.values, ...values }, opts);
  pass.dispose = () => {};
  return pass;
}

// The volume's light for the mesh layer's bind(volume, g) (the figure, the
// tool in hand, the NPCs, the vehicles). On WebGL their materials copied the
// raymarch material's uniforms; on WebGPU the volume is a plain Object3D
// (app.js) and the mesh layer's TSL lights read gfx/meshLight.js instead, so
// their bind() ignores what it is given (U13). Until that lands, a WebGL-era
// bind gets an empty uniform set to copy rather than a TypeError.
const NO_VOLUME_LIGHT = { material: { uniforms: {} } };
export const volumeLight = (volume) => (volume?.material?.uniforms ? volume : NO_VOLUME_LIGHT);

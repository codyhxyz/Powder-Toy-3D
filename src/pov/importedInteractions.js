import { Vector3 } from 'three';
import { EDIT_FIELDS, editKernelWGSL, LAYOUT } from '../shaders/common.js';
import { uniformStruct } from '../gpu/params.js';
import { BODY_HEIGHT, BODY_WIDTH } from './constants.js';
import { decodeImportedIndex } from '../world/import/importedInteractionState.js';
import { prepareDoorMove, doorStepBounds, DOOR_SOURCE_WORDS } from '../world/import/doorRuntime.js';

// Legacy manifests without motion retain instant exclusive-cell retraction.
// Motion manifests use the two-phase moving leaf below; boxes are only
// dispatch/occupancy bounds, never permission to carve arbitrary terrain.
export const IMPORTED_DOOR_EDIT = {
  params: { at: 'vec3i', size: 'vec3u', opening: 'u32', origin: 'vec3i', seed: 'u32' },
  layout: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
  decls: '@group(2) @binding(0) var<storage, read_write> doorCells: array<vec2u>;',
  update: /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let q = vec3u(p - P.at);
  let i = q.x + P.size.x * (q.y + P.size.y * q.z);
  let expected = doorCells[i].x;
  if (expected == 0u) { return; }
  if (P.opening != 0u) {
    doorCells[i].y = select(0u, 1u, eid(a) == i32(expected));
    if (doorCells[i].y == 0u) { return; }
    *oA = vec4f(0.0, SPAWNT(E_EMPTY), 0.0, 0.0);
    *oB = vec4f(0.0);
  } else {
    if (doorCells[i].y == 0u) { return; }
    if (eid(a) != E_EMPTY) { doorCells[i].y = 0u; return; }
    let id = i32(expected);
    let seed = u32ToF32(seedWorld(p + P.origin, P.seed, 0x1a90u)) * UINT_TO_UNIT * SEED_MAX;
    *oA = vec4f(f32(id), SPAWNT(id), SPAWNLIFE(id), seed);
    *oB = vec4f(0.0);
  }
}`,
};

export const IMPORTED_DOOR_MOTION_EDIT = {
  reads: 'neighbours',
  params: { at: 'vec3i', size: 'vec3u', sourceAt: 'u32', origin: 'vec3i', seed: 'u32' },
  layout: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
  decls: '@group(2) @binding(0) var<storage, read_write> motionCells: array<u32>;',
  update: /* wgsl */ `
fn update(p: vec3i, a: vec4f, b: vec4f, oA: ptr<function, vec4f>, oB: ptr<function, vec4f>) {
  let q = vec3u(p - P.at);
  let dst = 2u * (q.x + P.size.x * (q.y + P.size.y * q.z));
  let erase = motionCells[dst];
  let own = erase != 0u && eid(a) == i32(erase);
  if (own) { *oA = vec4f(0.0, SPAWNT(E_EMPTY), 0.0, 0.0); *oB = vec4f(0.0); }
  var link = motionCells[dst + 1u];
  var stamped = false;
  var stampedID = 0u;
  loop {
    if (link == 0u) { break; }
    let s = P.sourceAt + (link - 1u) * 12u;
    let old = vec3i(i32(motionCells[s]), i32(motionCells[s+1u]), i32(motionCells[s+2u]));
    let expected = motionCells[s+3u];
    let wasPlaced = motionCells[s+5u] != 0u;
    let oldA = fetchA(old);
    let alive = motionCells[s+4u] != 0u && (!wasPlaced || eid(oldA) == i32(expected));
    motionCells[s+7u] = select(0u, 1u, alive);
    motionCells[s+9u] = u32(eid(oldA));
    let canPlace = alive && (eid(a) == E_EMPTY || own) && (!stamped || stampedID == expected);
    motionCells[s+8u] = select(0u, 1u, canPlace);
    if (canPlace && !stamped) {
      if (wasPlaced) { *oA = oldA; *oB = fetchB(old); }
      else {
        let id = i32(expected);
        let seed = u32ToF32(seedWorld(p + P.origin, P.seed, 0x1a90u)) * UINT_TO_UNIT * SEED_MAX;
        *oA = vec4f(f32(id), SPAWNT(id), SPAWNLIFE(id), seed); *oB = vec4f(0.0);
      }
      stamped = true; stampedID = expected;
    }
    link = motionCells[s+6u];
  }
}`,
};

export const WGSL_CHECK = [{ name: 'importedDoorMotion', kind: 'compute', tool: true,
  code: g => editKernelWGSL(g, { ...IMPORTED_DOOR_MOTION_EDIT, params: uniformStruct('ImportedDoorMotionParams', { ...EDIT_FIELDS, ...IMPORTED_DOOR_MOTION_EDIT.params }) }),
  layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, [...IMPORTED_DOOR_MOTION_EDIT.layout, { binding: 15, visibility: 4, buffer: { type: 'storage' } }]],
}, { name: 'importedDoor', kind: 'compute', tool: true,
  code: g => editKernelWGSL(g, { ...IMPORTED_DOOR_EDIT, params: uniformStruct('ImportedDoorParams', { ...EDIT_FIELDS, ...IMPORTED_DOOR_EDIT.params }) }),
  layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, IMPORTED_DOOR_EDIT.layout],
}];

export function importedDoorOccupied(door, bodies, origin) {
  if (!door.bounds) return false;
  const { min, max } = door.bounds;
  return bodies.some(body => {
    if (!body?.pos) return false;
    const p = [body.pos.x + origin[0], body.pos.y + origin[1], body.pos.z + origin[2]];
    const half = BODY_WIDTH * (body.size ?? 1) / 2 + 0.15;
    const lo = [p[0] - half, p[1] - 0.15, p[2] - half];
    const hi = [p[0] + half, p[1] + (body.height ?? BODY_HEIGHT * (body.size ?? 1)) + 0.15, p[2] + half];
    return lo.every((v, k) => v < max[k] && hi[k] > min[k]);
  });
}
export function createImportedInteractions({ app, interact, getBodies, toast = () => {} }) {
  const kernels = new WeakMap(), motionKernels = new WeakMap();
  let lastError = null, disposed = false;
  const current = () => {
    if (disposed) return null;
    const world = app.getWorld?.(), sim = app.getSim?.();
    const scene = world?.scene, map = scene?.importManifest, state = scene?.interactionState;
    return map && state && sim ? { world, sim, scene, map, state, origin: [sim.origin.x, sim.origin.y, sim.origin.z] } : null;
  };
  const resident = (door, { sim, origin }) => {
    const bounds = door.motion?.sweptBounds ?? door.bounds;
    return bounds.min.every((n, k) => n >= origin[k] && bounds.max[k] <= origin[k] + [sim.g.nx, sim.g.ny, sim.g.nz][k]);
  };
  const autoClose = door => door.motion?.autoCloseSeconds ?? door.autoCloseSeconds;
  async function move(door, progress, c) {
    const { world, sim, state, map, origin } = c, epoch = state.epoch;
    const previous = state.ensure(door), from = previous.progress;
    const occupied = () => importedDoorOccupied({ bounds: doorStepBounds(map, door, from, progress, previous.alive) }, getBodies(), origin);
    if (occupied()) return false;
    let kernel = motionKernels.get(sim);
    if (!kernel) { kernel = sim.editKernel('importedDoorMotion', IMPORTED_DOOR_MOTION_EDIT); motionKernels.set(sim, kernel); }
    const valid = () => {
      const now=current();
      return state.epoch===epoch && now?.world===world && now?.sim===sim && now?.state===state && !sim.disposed;
    };
    const transaction = (async () => {
      await kernel.ready;
      if (!valid() || occupied()) return false;
      const plan = prepareDoorMove(map, door, previous, progress, origin);
      const buffer = sim.gpu.createBuffer({ label: 'moving imported door sources', size: plan.data.byteLength, usage: 0x80 | 0x08 | 0x04 });
      try {
        sim.gpu.write(buffer, 0, plan.data);
        const at = plan.min.map((v,k) => v-origin[k]);
        sim.edit(kernel, { lo: at, hi: plan.max.map((v,k) => v-origin[k]-1) },
          { at, size: plan.size, sourceAt: plan.sourceAt, origin, seed: world.P.seed >>> 0 }, { bind: [{ buffer }], scrub: true });
        // Only per-source result records, never the world or dense destination grid.
        const result = new Uint32Array(await sim.gpu.readback.buffer(buffer, plan.sourceAt*4, door.cells.length/2*DOOR_SOURCE_WORDS*4));
        if (!valid()) return false;
        const alive=[],placed=[],observed=[];
        for(let i=0;i<door.cells.length/2;i++) { const s=i*DOOR_SOURCE_WORDS; alive.push(result[s+7]); placed.push(result[s+8]); observed.push(result[s+9]); }
        state.move(door, progress, alive, placed, observed);
        app.requestRender?.(); return true;
      } finally { sim._retire(buffer); }
    })();
    world.pending = transaction;
    try { return await transaction; }
    catch(error) { lastError=String(error); console.error('Imported door motion failed',error); toast('Door interaction failed'); return false; }
    finally { if(world.pending===transaction) world.pending=null; }
  }
  async function use(door, automatic = false) {
    const c = current();
    if (!c || c.world.pending || !resident(door, c)) return false;
    if (!door.supported) { if (!automatic) toast(door.requirement); return false; }
    const { world, sim, state, map, origin } = c;
    if (door.motion) {
      if (!door.cells.length) { if (!automatic) toast('No exclusive door cells to move'); return false; }
      const previous = state.ensure(door), opening = !previous.targetOpen;
      if (!opening && autoClose(door) && !automatic) { toast('Closes automatically after 5 seconds'); return false; }
      state.target(door, opening); app.requestRender?.(); return true;
    }
    const previous = state.states.get(door.sourcePath), opening = !previous?.open;
    if (!opening && door.autoCloseSeconds && !automatic) { toast('Closes automatically after 5 seconds'); return false; }
    if (!opening && importedDoorOccupied(door, getBodies(), origin)) {
      if (!automatic) toast('Doorway occupied');
      return false;
    }
    if (!door.cells.length) { if (!automatic) toast('No exclusive door cells to move'); return false; }
    const epoch = state.epoch;
    let kernel = kernels.get(sim);
    if (!kernel) { kernel = sim.editKernel('importedDoor', IMPORTED_DOOR_EDIT); kernels.set(sim, kernel); }
    const transaction = (async () => {
      await kernel.ready;
      if (state.epoch !== epoch || current()?.world !== world || sim.disposed) return false;
      // The body may have walked into the doorway during pipeline creation.
      if (!opening && importedDoorOccupied(door, getBodies(), origin)) return false;
      const { min, max } = door.bounds, size = max.map((n, k) => n - min[k]);
      const dense = new Uint32Array(size.reduce((a, b) => a * b, 1) * 2);
      const offsets = [];
      for (let i = 0; i < door.cells.length; i += 2) {
        const p = decodeImportedIndex(map, door.cells[i]).map((n, k) => n - min[k]);
        const at = (p[0] + size[0] * (p[1] + size[1] * p[2])) * 2;
        offsets.push(at);
        dense[at] = previous?.alive && !previous.alive[i / 2] ? 0 : door.cells[i + 1];
        dense[at + 1] = previous?.alive?.[i / 2] ?? 0;
      }
      const buffer = sim.gpu.createBuffer({ label: 'imported door live mask', size: dense.byteLength, usage: 0x80 | 0x08 | 0x04 });
      try {
        sim.gpu.write(buffer, 0, dense);
        const at = min.map((n, k) => n - origin[k]);
        sim.edit(kernel, { lo: at, hi: max.map((n, k) => n - origin[k] - 1) }, { at, size, opening: opening ? 1 : 0, origin, seed: world.P.seed >>> 0 }, { bind: [{ buffer }], scrub: true });
        const result = new Uint32Array(await sim.gpu.readback.buffer(buffer, 0, dense.byteLength));
        if (state.epoch !== epoch || current()?.world !== world || sim.disposed) return false;
        const alive = offsets.map(at => result[at + 1]);
        if (opening) state.open(door, alive); else state.close(door, alive);
        app.requestRender?.();
        return true;
      } finally { sim._retire(buffer); }
    })();
    // WorldWindow.update already blocks shifts while pending. This serializes
    // live-mask capture, canonical/SD updates, and streaming diff generation.
    world.pending = transaction;
    try { return await transaction; }
    catch (error) { lastError = String(error); console.error('Imported door interaction failed', error); toast('Door interaction failed'); return false; }
    finally { if (world.pending === transaction) world.pending = null; }
  }
  const removeProvider = interact.provide(() => {
    const c = current();
    if (!c) return [];
    const body = getBodies()[0];
    if (!body?.pos) return [];
    return (c.map.interactions?.doors ?? []).filter(d => resident(d, c)).map(door => {
      const { min, max } = door.bounds;
      const here = [body.pos.x + c.origin[0], body.pos.y + (body.height ?? BODY_HEIGHT) * 0.8 + c.origin[1], body.pos.z + c.origin[2]];
      const point = here.map((n, k) => Math.max(min[k] + 0.5, Math.min(max[k] - 0.5, n)) - c.origin[k]);
      return { id: `imported:${door.sourcePath}`, position: new Vector3(...point), radius: 0.8,
        title: door.kind === 'gate' ? 'Sealed gate' : door.kind === 'sliding' ? 'Elevator door' : 'Door',
        lines: door.supported ? door.ownershipWarning ? [door.ownershipWarning] : [] : [door.requirement], verb: door.supported ? c.state.states.get(door.sourcePath)?.open ? autoClose(door) ? 'Auto-closes' : 'Close' : 'Open' : 'Inspect requirement', use: () => { void use(door); } };
    });
  });
  return {
    use,
    get lastError() { return lastError; },
    get timedDoor() {
      const c = current();
      return !!c && (c.map.interactions?.doors ?? []).some(d => {
        const s=c.state.states.get(d.sourcePath);
        return resident(d,c) && s && ((d.motion && s.progress!==s.desiredProgress) || (autoClose(d) && s.open));
      });
    },
    update(dt) {
      const c = current();
      if (!c || !Number.isFinite(dt) || dt < 0) return;
      // Timers start at use, and keep ticking while another edit is pending.
      for (const door of c.map.interactions?.doors ?? []) {
        const s=c.state.states.get(door.sourcePath);
        if (s?.open && autoClose(door)) s.elapsed += dt;
      }
      if (c.world.pending) return;
      for (const door of c.map.interactions?.doors ?? []) {
        const s=c.state.states.get(door.sourcePath);
        if (!s || !resident(door,c)) continue;
        if (s.open && autoClose(door) && s.elapsed>=autoClose(door)) {
          if (door.motion) { s.open=s.targetOpen=false; s.desiredProgress=0; }
          else { void use(door,true); break; }
        }
        if (!door.motion || s.progress===s.desiredProgress) continue;
        // Never accumulate a large pose jump behind GPU readback or streaming.
        const step=Math.min(dt,1/30)/door.motion.durationSeconds;
        const progress=s.desiredProgress>s.progress?Math.min(s.desiredProgress,s.progress+step):Math.max(s.desiredProgress,s.progress-step);
        if(progress!==s.progress && !importedDoorOccupied({bounds:doorStepBounds(c.map,door,s.progress,progress,s.alive)},getBodies(),c.origin)) {
          void move(door,progress,c); break;
        }
      }
    },
    dispose() { disposed=true; removeProvider(); },
  };
}

import { Vector3 } from 'three';
import { EDIT_FIELDS, editKernelWGSL, LAYOUT } from '../shaders/common.js';
import { uniformStruct } from '../gpu/params.js';
import { BODY_HEIGHT, BODY_WIDTH } from './constants.js';
import { decodeImportedIndex } from '../world/import/importedInteractionState.js';

// Cruelty Squad Door.gd: use toggles a 90-degree leaf at 2 rad/s;
// Elevator_Door.gd: 2 m/s slide, five-second timer. Supported voxel port:
// retract exclusive leaf cells instantly, retaining their destruction mask.
// No AABB carve/stamp: bounding boxes are dispatch/occupancy bounds ONLY.
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

export const WGSL_CHECK = [{ name: 'importedDoor', kind: 'compute', tool: true,
  code: g => editKernelWGSL(g, { ...IMPORTED_DOOR_EDIT, params: uniformStruct('ImportedDoorParams', { ...EDIT_FIELDS, ...IMPORTED_DOOR_EDIT.params }) }),
  layouts: () => [LAYOUT.TABLES, LAYOUT.STATE_RW, IMPORTED_DOOR_EDIT.layout],
}];

export function importedDoorOccupied(door, bodies, origin) {
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
  const kernels = new WeakMap();
  let lastError = null;
  const current = () => {
    const world = app.getWorld?.(), sim = app.getSim?.();
    const scene = world?.scene, map = scene?.importManifest, state = scene?.interactionState;
    return map && state && sim ? { world, sim, scene, map, state, origin: [sim.origin.x, sim.origin.y, sim.origin.z] } : null;
  };
  const resident = (door, { sim, origin }) => door.bounds.min.every((n, k) => n >= origin[k] && door.bounds.max[k] <= origin[k] + [sim.g.nx, sim.g.ny, sim.g.nz][k]);
  async function use(door, automatic = false) {
    const c = current();
    if (!c || c.world.pending || !resident(door, c)) return false;
    if (!door.supported) { if (!automatic) toast(door.requirement); return false; }
    const { world, sim, state, map, origin } = c;
    const previous = state.states.get(door.sourcePath), opening = !previous?.open;
    if (!opening && door.kind === 'sliding' && !automatic) { toast('Closes automatically after 5 seconds'); return false; }
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
        lines: door.supported ? [door.ownershipWarning ?? 'Voxel-retract adaptation'] : [door.requirement], verb: door.supported ? c.state.states.get(door.sourcePath)?.open ? door.kind === 'sliding' ? 'Auto-closes' : 'Close' : 'Open' : 'Inspect requirement', use: () => { void use(door); } };
    });
  });
  return {
    use,
    get lastError() { return lastError; },
    update(dt) {
      const c = current();
      if (!c || c.world.pending) return;
      for (const door of c.map.interactions?.doors ?? []) {
        const state = c.state.states.get(door.sourcePath);
        if (!state?.open || !door.autoCloseSeconds) continue;
        state.elapsed += dt;
        if (state.elapsed >= door.autoCloseSeconds && resident(door, c)) { void use(door, true); break; }
      }
    },
    dispose: removeProvider,
  };
}

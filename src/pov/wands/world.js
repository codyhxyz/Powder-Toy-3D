import * as THREE from 'three';
import { WAND_COMMANDS, WAND_RAYS, WAND_EFFECTS } from '../../shaders/wands.js';
import { povGpu } from '../gpu.js';
import { ELEMENTS, E } from '../../elements.js';
import { PHYS } from '../../physics.js';
import { gfxUniforms, WAND_LIGHTS } from '../../gfx/uniforms.js';

const READBACKS = 3;
const { clamp } = THREE.MathUtils;
const finiteVec = (v) => v && [v.x, v.y, v.z].every((x) => Number.isFinite(x) && Math.abs(x) <= 1e6);
const vector = (v) => new THREE.Vector3(v.x, v.y, v.z);
// All coordinates are grid cells, velocity cells/s. No inventory ownership.
// The world's GPU side is src/pov/gpu.js's: one edit per flush (the command
// batch, docs/webgpu.md D7), probes into result rings for traces and clearance.
export function createWandWorld({ getSim }) {
  const commands = [];
  const commandData = Array.from({ length: WAND_COMMANDS * 4 }, () => [0, 0, 0, 0]);   // row r of command i at r · WAND_COMMANDS + i
  const segmentData = Array.from({ length: WAND_RAYS * 2 }, () => [0, 0, 0, 0]);   // from rows, then to rows
  let sim = null, simId, generation = 0, disposed = false;
  let context = { dt: 0, stepsPerFrame: 0 }, flushed = false, held = false, shiftVersion = 0;
  const shifted = new THREE.Vector3();
  const stats = {
    queued: 0, rejected: 0, passes: 0, commands: 0, rays: 0, readbacks: 0,
    pending: 0, maxPending: 0, totalPasses: 0, totalCommands: 0, totalRays: 0,
    totalReadbacks: 0, failedReadbacks: 0, staleResults: 0, lights: 0,
    touched: null, limits: { commands: WAND_COMMANDS, passes: 1, rays: WAND_RAYS, readbacks: READBACKS, lights: WAND_LIGHTS },
  };
  function clearLights() {
    gfxUniforms.uWandLightCount.value = 0;
    stats.lights = 0;
  }
  function current() {
    if (disposed) return null;
    const next = getSim();
    if (next !== sim || next?.id !== simId) {
      generation++;
      commands.length = 0;
      clearLights();
      sim = next; simId = next?.id;
      shifted.set(0, 0, 0);
    }
    return sim;
  }
  function reject() { stats.rejected++; return false; }
  function queue(c) {
    if (!current() || flushed || commands.length >= WAND_COMMANDS || !c
        || !Object.hasOwn(WAND_EFFECTS, c.effect) || !finiteVec(c.center)
        || (c.shape != null && c.shape !== 'sphere')) return reject();
    for (const k of ['radius', 'power', 'temperature', 'dt']) if (c[k] != null && !Number.isFinite(c[k])) return reject();
    for (const k of ['dir', 'velocity']) if (c[k] != null && !finiteVec(c[k])) return reject();
    const creates = c.effect === 'emit' || c.effect === 'place';
    if (creates && (!Object.hasOwn(E, c.material) || c.material === 'EMPTY')) return reject();
    const id = creates ? E[c.material] : 0;
    const radius = clamp(c.radius ?? 1, 0.5, 32);
    const center = vector(c.center), g = sim.g;
    if (center.x + radius < 0 || center.y + radius < 0 || center.z + radius < 0
        || center.x - radius >= g.nx || center.y - radius >= g.ny || center.z - radius >= g.nz) return reject();
    const power = clamp(c.power ?? 1, c.effect === 'pressure' ? PHYS.P_MIN : 0, 6000);
    const dt = clamp(c.dt ?? context.dt, 0, 0.25);
    const stepTime = context.stepsPerFrame > 0 ? context.dt / context.stepsPerFrame : 0;
    const velocity = c.velocity ? vector(c.velocity).multiplyScalar(stepTime) : new THREE.Vector3();
    velocity.clampLength(0, PHYS.V_MAX);
    commands.push({ effect: WAND_EFFECTS[c.effect], center, radius, power, id,
      temperature: clamp(c.temperature ?? ELEMENTS[id].temp, PHYS.CELL_TEMP_MIN, PHYS.CELL_TEMP_MAX),
      velocity, force: clamp(power * dt * stepTime, 0, PHYS.V_MAX),
      dir: c.dir ? vector(c.dir).normalize() : new THREE.Vector3(0, 1, 0),
    });
    stats.queued++;
    return true;
  }
  function flush() {
    const s = current();
    if (!s || !commands.length || flushed) return;
    flushed = true;
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = lo.clone().negate();
    for (let i = 0; i < commands.length; i++) {
      const c = commands[i];
      commandData[i] = [...c.center.toArray(), c.radius];
      commandData[WAND_COMMANDS + i] = [c.effect, c.power, c.id, c.temperature];
      commandData[2 * WAND_COMMANDS + i] = [...c.velocity.toArray(), c.force];
      commandData[3 * WAND_COMMANDS + i] = [...c.dir.toArray(), 0];
      lo.min(c.center.clone().addScalar(-c.radius)); hi.max(c.center.clone().addScalar(c.radius));
    }
    lo.max(new THREE.Vector3()); hi.min(new THREE.Vector3(s.g.nx, s.g.ny, s.g.nz));
    if (lo.x > hi.x || lo.y > hi.y || lo.z > hi.z) { commands.length = 0; return; }
    // (the POV kernels still building, B5: the batch waits, kept for the next frame's flush ahead of that frame's)
    if (!povGpu(s).ready) { held = true; return; }
    povGpu(s).edit('povWand', s.touchCentres(lo.toArray(), hi.toArray()), { count: commands.length, lo, hi, commands: commandData });
    stats.passes++; stats.totalPasses++;
    stats.commands += commands.length; stats.totalCommands += commands.length;
    stats.touched = { lo: lo.toArray(), hi: hi.toArray() };
    commands.length = 0;
  }
  // At most READBACKS answers are in flight; each probe's answer lands in a
  // ring slot (src/pov/gpu.js). Failed traces reject: unavailable GPU evidence
  // must never mean empty space. Clearance alone has a fail-closed false result.
  async function probe(s, name, params, decode, fallback) {
    if (stats.pending >= READBACKS || stats.readbacks >= READBACKS) {
      if (fallback !== undefined) return fallback;
      throw new Error('Wand trace capacity reached');
    }
    const mine = generation, id = s.id, origin = shifted.clone();
    const read = povGpu(s).probe(name, params);
    if (!read) {   // (its kernel is still building: B5)
      if (fallback !== undefined) return fallback;
      throw new Error('Wand trace unavailable: its kernel is still building');
    }
    stats.pending++; stats.maxPending = Math.max(stats.maxPending, stats.pending);
    stats.readbacks++; stats.totalReadbacks++;
    try {
      const buf = new Float32Array(await read);
      if (disposed || generation !== mine || getSim() !== s || s.id !== id) {
        stats.staleResults++;
        if (fallback !== undefined) return fallback;
        throw new Error('Wand trace belongs to an inactive world');
      }
      return decode(buf, origin.sub(shifted));
    } catch (error) {
      stats.failedReadbacks++;
      if (fallback !== undefined) return fallback;
      throw error;
    } finally {
      stats.pending--;
    }
  }
  function trace(segments) {
    if (!Array.isArray(segments) || segments.length > WAND_RAYS) return Promise.reject(new RangeError(`trace accepts at most ${WAND_RAYS} segments`));
    const count = segments.length, s = current();
    if (!count) return Promise.resolve([]);
    if (!s || stats.readbacks >= READBACKS || stats.pending >= READBACKS)
      return Promise.reject(new Error('Wand trace unavailable'));
    if (segments.some((seg) => !finiteVec(seg?.from) || !finiteVec(seg?.to)))
      return Promise.reject(new TypeError('Wand trace needs finite endpoints'));
    segments.forEach((seg, i) => {
      segmentData[i] = [seg.from.x, seg.from.y, seg.from.z, 1];
      segmentData[WAND_RAYS + i] = [seg.to.x, seg.to.y, seg.to.z, 0];
    });
    stats.rays += segments.length; stats.totalRays += segments.length;
    // row r of ray i is vec4 r · WAND_RAYS + i of the answer (shaders/wands.js)
    return probe(s, 'povWandTrace', { segments: segmentData, count }, (buf, back) => Array.from({ length: count }, (_, i) => {
      const face = buf[i * 4 + 3];
      if (face < 0) return null;
      const p = (WAND_RAYS + i) * 4;
      const normal = new THREE.Vector3(); normal.setComponent(Math.floor(face / 2), face % 2 ? -1 : 1);
      return { cell: new THREE.Vector3().fromArray(buf, i * 4).add(back), normal,
        point: new THREE.Vector3().fromArray(buf, p).add(back), fraction: buf[p + 3],
        id: buf[(2 * WAND_RAYS + i) * 4 + 3] };
    }));
  }
  function clearance(feet) {
    const s = current();
    if (!s || !finiteVec(feet)) return Promise.resolve(false);
    const version = shiftVersion;
    return probe(s, 'povWandClearance', { feet }, (buf) => version === shiftVersion && buf[0] > 0.5, false);
  }
  function setLights(lights) {
    if (!current()) return;
    clearLights();
    if (!Array.isArray(lights)) return;
    for (const l of lights.slice(0, WAND_LIGHTS)) {
      if (!finiteVec(l?.position) || !Array.isArray(l.color) || l.color.length !== 3
          || !l.color.every(Number.isFinite) || !Number.isFinite(l.radius) || l.radius <= 0
          || !Number.isFinite(l.intensity) || l.intensity <= 0) continue;
      const i = stats.lights++;
      gfxUniforms.uWandLightPosition.value[i].set(l.position.x, l.position.y, l.position.z, clamp(l.radius, 0.5, 64));
      gfxUniforms.uWandLightColor.value[i].set(...l.color.map((v) => clamp(v, 0, 8)), clamp(l.intensity, 0, 16));
    }
    gfxUniforms.uWandLightCount.value = stats.lights;
  }
  return {
    stats, queue, flush, trace, clearance, setLights,
    begin(ctx = {}) {
      current();
      if (!held) commands.length = 0;
      held = false; flushed = false;
      context = { dt: Number.isFinite(ctx.dt) ? clamp(ctx.dt, 0, 0.25) : 0,
        stepsPerFrame: Number.isFinite(ctx.stepsPerFrame) ? Math.floor(clamp(ctx.stepsPerFrame, 0, 1000)) : 0 };
      for (const k of ['queued', 'rejected', 'passes', 'commands', 'rays', 'readbacks']) stats[k] = 0;
      stats.touched = null;
    },
    windowShifted(dx, dz) {
      if (!current() || !Number.isFinite(dx) || !Number.isFinite(dz) || Math.abs(dx) > 1e6 || Math.abs(dz) > 1e6) return;
      shiftVersion++;
      shifted.x += dx; shifted.z += dz;
      for (const c of commands) { c.center.x -= dx; c.center.z -= dz; }
      for (let i = 0; i < stats.lights; i++) {
        gfxUniforms.uWandLightPosition.value[i].x -= dx;
        gfxUniforms.uWandLightPosition.value[i].z -= dz;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation++; commands.length = 0; clearLights();
    },
  };
}

import * as THREE from 'three';
import { quadVert, stateUniforms } from '../../shaders/common.js';
import { WAND_COMMANDS, WAND_RAYS, WAND_EFFECTS, wandApplyFrag, wandTraceFrag, wandClearanceFrag } from '../../shaders/wands.js';
import { ELEMENTS, E } from '../../elements.js';
import { PHYS } from '../../physics.js';
import { gfxUniforms, WAND_LIGHTS } from '../../gfx/uniforms.js';

const READBACKS = 3;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finiteVec = (v) => v && [v.x, v.y, v.z].every((x) => Number.isFinite(x) && Math.abs(x) <= 1e6);
const vector = (v) => new THREE.Vector3(v.x, v.y, v.z);
const texture = (data, width, height) => {
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
};
const material = (name, fragmentShader, uniforms) => new THREE.RawShaderMaterial({
  name, glslVersion: THREE.GLSL3, vertexShader: quadVert, fragmentShader,
  uniforms: { ...stateUniforms(), ...uniforms }, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
});

// All coordinates are grid cells, velocity cells/s. No inventory ownership.
export function createWandWorld({ renderer, getSim }) {
  const commands = [];
  const commandData = new Float32Array(WAND_COMMANDS * 4 * 4);
  const commandTex = texture(commandData, WAND_COMMANDS, 4);
  const segmentData = new Float32Array(WAND_RAYS * 2 * 4);
  const segmentTex = texture(segmentData, WAND_RAYS, 2);
  const slots = Array.from({ length: READBACKS }, () => ({
    busy: false,
    target: new THREE.WebGLRenderTarget(WAND_RAYS, 3, {
      type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false,
    }),
  }));
  let sim = null, simId, mats = null, generation = 0, disposed = false;
  let context = { dt: 0, stepsPerFrame: 0 }, flushed = false, shiftVersion = 0;
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
      if (mats) Object.values(mats).forEach((m) => m.dispose());
      mats = null; sim = next; simId = next?.id;
      shifted.set(0, 0, 0);
    }
    if (!sim) return null;
    if (!mats) mats = {
      apply: material('wand-apply', wandApplyFrag(sim.g), {
        tCommands: { value: commandTex }, uCount: { value: 0 },
        uLo: { value: new THREE.Vector3() }, uHi: { value: new THREE.Vector3() },
      }),
      trace: material('wand-trace', wandTraceFrag(sim.g), { tSegments: { value: segmentTex } }),
      clearance: material('wand-clearance', wandClearanceFrag(sim.g), { uFeet: { value: new THREE.Vector3() } }),
    };
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
      commandData.set([...c.center.toArray(), c.radius], i * 4);
      commandData.set([c.effect, c.power, c.id, c.temperature], (WAND_COMMANDS + i) * 4);
      commandData.set([...c.velocity.toArray(), c.force], (2 * WAND_COMMANDS + i) * 4);
      commandData.set([...c.dir.toArray(), 0], (3 * WAND_COMMANDS + i) * 4);
      lo.min(c.center.clone().addScalar(-c.radius)); hi.max(c.center.clone().addScalar(c.radius));
    }
    lo.max(new THREE.Vector3()); hi.min(new THREE.Vector3(s.g.nx, s.g.ny, s.g.nz));
    if (lo.x > hi.x || lo.y > hi.y || lo.z > hi.z) { commands.length = 0; return; }
    commandTex.needsUpdate = true;
    const u = mats.apply.uniforms;
    u.uCount.value = commands.length; u.uLo.value.copy(lo); u.uHi.value.copy(hi);
    s.touchCentres(lo.toArray(), hi.toArray());
    const previous = renderer.getRenderTarget();
    try { s.pass(mats.apply); }
    finally { renderer.setRenderTarget(previous); }
    stats.passes++; stats.totalPasses++;
    stats.commands += commands.length; stats.totalCommands += commands.length;
    stats.touched = { lo: lo.toArray(), hi: hi.toArray() };
    commands.length = 0;
  }
  // Each busy target is held until its async read completes, even on disposal.
  // No synchronous fallback: context loss is a miss/failed clearance.
  async function probe(s, mat, width, height, decode, fallback) {
    const slot = slots.find((x) => !x.busy);
    if (!slot || stats.readbacks >= READBACKS) return fallback;
    const mine = generation, id = s.id, origin = shifted.clone();
    slot.busy = true;
    stats.pending++; stats.maxPending = Math.max(stats.maxPending, stats.pending);
    const buf = new Float32Array(width * height * 4);
    const previous = renderer.getRenderTarget();
    try {
      mat.uniforms.tA.value = s.stateA;
      mat.uniforms.tB.value = s.stateB;
      s.run(mat, slot.target);
      renderer.setRenderTarget(previous);
      stats.readbacks++; stats.totalReadbacks++;
      await renderer.readRenderTargetPixelsAsync(slot.target, 0, 0, width, height, buf);
      if (disposed || generation !== mine || getSim() !== s || s.id !== id) {
        stats.staleResults++; return fallback;
      }
      return decode(buf, origin.sub(shifted));
    } catch {
      stats.failedReadbacks++;
      return fallback;
    } finally {
      // Do not restore render state after awaiting: another frame owns it now.
      if (renderer.getRenderTarget() === slot.target) renderer.setRenderTarget(previous);
      slot.busy = false; stats.pending--;
      if (disposed) slot.target.dispose();
    }
  }
  function trace(segments) {
    if (!Array.isArray(segments) || segments.length > WAND_RAYS) return Promise.reject(new RangeError(`trace accepts at most ${WAND_RAYS} segments`));
    const count = segments.length, miss = Array(count).fill(null), s = current();
    if (!s || !segments.length || stats.readbacks >= READBACKS || slots.every((x) => x.busy)) return Promise.resolve(miss);
    segmentData.fill(0);
    segments.forEach((seg, i) => {
      if (!finiteVec(seg?.from) || !finiteVec(seg?.to)) return;
      segmentData.set([seg.from.x, seg.from.y, seg.from.z, 1], i * 4);
      segmentData.set([seg.to.x, seg.to.y, seg.to.z, 0], (WAND_RAYS + i) * 4);
    });
    segmentTex.needsUpdate = true;
    stats.rays += segments.length; stats.totalRays += segments.length;
    return probe(s, mats.trace, count, 3, (buf, back) => Array.from({ length: count }, (_, i) => {
      const face = buf[i * 4 + 3];
      if (face < 0) return null;
      const p = (count + i) * 4;
      const normal = new THREE.Vector3(); normal.setComponent(Math.floor(face / 2), face % 2 ? -1 : 1);
      return { cell: new THREE.Vector3().fromArray(buf, i * 4).add(back), normal,
        point: new THREE.Vector3().fromArray(buf, p).add(back), fraction: buf[p + 3],
        id: buf[(2 * count + i) * 4 + 3] };
    }), miss);
  }
  function clearance(feet) {
    const s = current();
    if (!s || !finiteVec(feet)) return Promise.resolve(false);
    const version = shiftVersion;
    mats.clearance.uniforms.uFeet.value.copy(feet);
    return probe(s, mats.clearance, 1, 1, (buf) => version === shiftVersion && buf[0] > 0.5, false);
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
      commands.length = 0; flushed = false;
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
      commandTex.dispose(); segmentTex.dispose();
      if (mats) Object.values(mats).forEach((m) => m.dispose());
      slots.filter((s) => !s.busy).forEach((s) => s.target.dispose());
    },
  };
}

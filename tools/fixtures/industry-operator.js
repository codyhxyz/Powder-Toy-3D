import * as THREE from 'three';
import { E, K, ELEMENTS } from '../../src/elements.js';
import { HAND_REACH } from '../../src/pov/constants.js';

const DT = 1 / 60;
const STEPS = 4;
let operatorSequence = 0;

const cleanError = error => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300);
const vec = value => value?.isVector3 ? value.clone() : new THREE.Vector3(...value);
const inside = (cell, g) => cell[0] >= 0 && cell[1] >= 0 && cell[2] >= 0
  && cell[0] < g.nx && cell[1] < g.ny && cell[2] < g.nz;

function bounded(promise, until, label) {
  if (Date.now() >= until) return Promise.reject(new Error(`${label}: case deadline reached`));
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: case deadline reached`)), Math.max(1, until - Date.now()));
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Match render.js pickStops: first non-gas voxel, within real hand reach. */
export async function firstOccupiedRayHit({ sim, eye, direction, deadline, flush = null }) {
  if (!sim?.readCell || !sim.g) throw new TypeError('ray probe requires a live simulation');
  const until = Number.isFinite(deadline) ? deadline : Date.now() + 20_000;
  const origin = [eye.x, eye.y, eye.z];
  const ray = [direction.x, direction.y, direction.z];
  const length = Math.hypot(...ray);
  if (!Number.isFinite(length) || length < 1e-9) return null;
  for (let axis = 0; axis < 3; axis++) ray[axis] /= length;

  const cell = origin.map(Math.floor);
  const step = ray.map(d => Math.sign(d));
  const delta = ray.map(d => d === 0 ? Infinity : Math.abs(1 / d));
  const next = ray.map((d, axis) => d > 0
    ? (cell[axis] + 1 - origin[axis]) / d
    : d < 0 ? (cell[axis] - origin[axis]) / d : Infinity);
  const maxSteps = Math.ceil(HAND_REACH * Math.sqrt(3)) + 4;
  let distance = 0;
  let face = -1;

  for (let count = 0; count < maxSteps && distance <= HAND_REACH; count++) {
    if (Date.now() >= until) throw new Error('operator ray: case deadline reached');
    if (inside(cell, sim.g)) {
      // Observe both promises immediately, including failures. Flush the copy
      // without advancing physics; an unsuccessful fence must not orphan a read.
      const [value] = await bounded(Promise.all([
        sim.readCell(cell[0], cell[1], cell[2]),
        Promise.resolve().then(() => flush?.()),
      ]), until, 'operator ray cell probe');
      const [state] = value;
      const id = Math.round(state[0]);
      if (id !== E.EMPTY && ELEMENTS[id]?.kind !== K.GAS) {
        // Starting inside matter has no entry face. Reject that test pose
        // rather than inventing a surface that a player could not aim at.
        if (face < 0) return null;
        return {
          valid: true,
          cell: new THREE.Vector3(...cell),
          id,
          T: state[1],
          dist: Math.max(0, distance),
          face,
        };
      }
    } else if (distance > 0) return null;

    const crossing = Math.min(...next);
    if (!Number.isFinite(crossing) || crossing > HAND_REACH) return null;
    // At an exact edge/corner, advance all tied axes so cells the ray only
    // touches at zero area cannot occlude the first genuinely entered voxel.
    const axes = [0, 1, 2].filter(axis => Math.abs(next[axis] - crossing) <= 1e-10);
    if (!axes.length) return null;
    const faceAxis = axes.reduce((best, axis) => Math.abs(ray[axis]) > Math.abs(ray[best]) ? axis : best, axes[0]);
    for (const axis of axes) {
      cell[axis] += step[axis];
      next[axis] += delta[axis];
    }
    face = faceAxis * 2 + (step[faceAxis] > 0 ? 1 : 0);
    distance = crossing;
  }
  return null;
}

const payload = load => (load?.cells ?? []).map(cell => ({
  id: cell[0], temperature: cell[1], life: cell[2], ctype: Math.floor(cell[3]), seed: cell[3] - Math.floor(cell[3]),
}));

/**
 * A CPU-driven controller for the real POV shovel and finite factory bucket.
 * It owns no clock: each update is called immediately before the caller's
 * ordinary four-step native frame.
 */
export async function createIndustryOperator({ sim, gpu, deadline, nativeStep } = {}) {
  if (!sim || !gpu || typeof nativeStep !== 'function') throw new TypeError('industry operator requires sim, GPU, and native-step callback');
  const until = Number.isFinite(deadline) ? deadline : Date.now() + 20_000;
  const ensureTime = label => { if (Date.now() >= until) throw new Error(`${label}: case deadline reached`); };
  const scene = new THREE.Scene();
  const volume = new THREE.Object3D();
  const viewmodel = new THREE.Group();
  const renderer = {};
  const toasts = [];
  const owner = `industry-line-operator:${Date.now()}:${++operatorSequence}`;
  let belt = null;
  let disposed = false;
  let hit = null;
  let input = null;
  let frameHits = 0;
  let frameMisses = 0;
  let hitSamples = [];

  const { preparePov } = await import('../../src/pov/gpu.js');
  await bounded(preparePov(sim), until, 'operator POV kernels ready');
  ensureTime('operator toolbelt setup');
  const { createToolbelt } = await import('../../src/pov/tools/index.js');
  belt = createToolbelt({
    renderer,
    scene,
    getSim: () => sim,
    getVolume: () => volume,
    getScale: () => 1,
    getStepsPerFrame: () => STEPS,
    getMode: () => 'factory',
    owner,
    hud: { toast: text => toasts.push(String(text)) },
    viewmodel,
    isActive: () => true,
  });
  belt.setVisible(true);
  const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: true, inLiquid: false, applyImpulse() {} };
  input = { eye: new THREE.Vector3(64, 64, 64), direction: new THREE.Vector3(0, -1, 0),
    primary: false, secondary: false, primaryPressed: false, secondaryPressed: false };
  const shovel = belt.tool('SHOVEL');
  const bucket = belt.tool('BUCKET');
  if (!shovel?.load || !bucket?.load) throw new Error('real industry shovel/bucket were not created');

  function setPose(pose) {
    const feet = vec(pose.feet);
    player.pos.copy(feet);
    const eye = feet.clone().add(new THREE.Vector3(0, 5, 0));
    let direction;
    if (pose.direction) direction = vec(pose.direction).normalize();
    else if (pose.target) direction = vec(pose.target).addScalar(0.5).sub(eye).normalize();
    else throw new TypeError('operator pose requires a ray target or direction');
    return { eye, direction };
  }

  async function beforeNativeFrame() {
    if (disposed) return;
    ensureTime('operator native-frame update');
    let aim = { valid: false };
    if (input.primary || input.secondary || input.primaryPressed || input.secondaryPressed) {
      hit = await firstOccupiedRayHit({ sim, eye: input.eye, direction: input.direction, deadline: until,
        flush: () => gpu.fence() });
      if (hit) {
        frameHits++;
        if (hitSamples.length < 24) hitSamples.push({ cell: hit.cell.toArray(), id: hit.id, face: hit.face, dist: hit.dist });
      } else frameMisses++;
      aim = hit ?? { valid: false };
    } else hit = null;
    belt.update({
      sim, dt: DT, stepsPerFrame: STEPS, toolRate: 1,
      eye: input.eye.clone(), dir: input.direction.clone(), aim,
      primary: input.primary, secondary: input.secondary,
      primaryPressed: input.primaryPressed, secondaryPressed: input.secondaryPressed,
      wheel: 0, drink: false, drinkPressed: false, player,
    });
    input.primaryPressed = false;
    input.secondaryPressed = false;
  }

  async function frame(label) {
    ensureTime(label);
    await bounded(nativeStep(4), until, label);
    await bounded(gpu.fence(), until, `${label} GPU fence`);
    await Promise.resolve();
  }

  async function waitFrames(count, label = 'operator settling') {
    for (let i = 0; i < count; i++) {
      ensureTime(label);
      input ??= { eye: new THREE.Vector3(), direction: new THREE.Vector3(0, -1, 0), primary: false, secondary: false,
        primaryPressed: false, secondaryPressed: false };
      input.primary = false; input.secondary = false;
      await frame(label);
    }
  }

  async function act({ tool, button, pose, maxFrames = 120, done = () => false, settleFrames = 1, label = `${tool} ${button}` } = {}) {
    if (!['SHOVEL', 'BUCKET'].includes(tool) || !['primary', 'secondary'].includes(button))
      throw new TypeError('operator action requires SHOVEL/BUCKET and primary/secondary');
    ensureTime(label);
    const rayPose = setPose(pose);
    belt.select(tool);
    input = {
      ...rayPose, primary: button === 'primary', secondary: button === 'secondary',
      primaryPressed: button === 'primary', secondaryPressed: button === 'secondary',
    };
    frameHits = 0;
    frameMisses = 0;
    hitSamples = [];
    let frames = 0;
    let failure = null;
    let lastActionHit = null;
    try {
      while (frames < maxFrames && !done()) {
        await frame(label);
        frames++;
        lastActionHit = hit ? { cell: hit.cell.toArray(), id: hit.id, face: hit.face, dist: hit.dist } : null;
      }
    } catch (error) {
      failure = cleanError(error);
    } finally {
      input.primary = false; input.secondary = false;
      input.primaryPressed = false; input.secondaryPressed = false;
    }
    try { await waitFrames(settleFrames, `${label} release settling`); }
    catch (error) { failure ??= cleanError(error); }
    const load = tool === 'BUCKET' ? bucket.load : shovel.load;
    const result = {
      label, tool, button, frames, completed: Boolean(done()), failure,
      pose: { feet: player.pos.toArray(), eye: rayPose.eye.toArray(), direction: rayPose.direction.toArray() },
      hitFrames: frameHits, missFrames: frameMisses, hitSamples: [...hitSamples],
      firstHit: hitSamples[0] ?? null, lastHit: lastActionHit,
      load: { count: load.count, reserved: load.reserved, out: load.out, payload: payload(load) },
      toasts: toasts.splice(0),
    };
    return result;
  }

  return {
    owner,
    belt,
    shovel,
    bucket,
    beforeNativeFrame,
    act,
    waitFrames,
    snapshot() {
      return {
        owner,
        selectedKey: belt.selectedKey,
        shovel: { count: shovel.load.count, reserved: shovel.load.reserved, out: shovel.load.out, payload: payload(shovel.load) },
        bucket: { count: bucket.load.count, reserved: bucket.load.reserved, out: bucket.load.out, payload: payload(bucket.load) },
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (input) { input.primary = false; input.secondary = false; }
      try { belt.setVisible(false); } catch {}
      try { belt.dispose(); } finally {
        try { belt.transfer?.dispose?.(); } catch {}
        try {
          const { allLoads } = await import('../../src/pov/tools/transfer.js');
          for (const key of allLoads().keys()) if (key.startsWith(`${owner}:`)) allLoads().delete(key);
        } catch {}
        viewmodel.removeFromParent();
        scene.clear();
      }
    },
  };
}

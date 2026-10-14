import { loadCrookState, startCrook, answerCrook } from './crook.js';
import { resolveCharacterMotion } from './characterCollision.js';

// Animal Crossing's doorstep introduction: a short walk, not a teleport or chase.
export function createCrookController(storage, seed) {
  const key = `willow-cove:crook:v1:${seed}`;
  const saved = loadCrookState(storage, key);
  let state = saved.state, phase = state.complete ? 'gone' : state.started ? 'idle' : 'waiting';
  let position = { x: 6, z: -17 }, previous = null, entered = false;
  let departing = 0;
  function save(next) {
    state = next;
    if (saved.writable) {
      try { storage.setItem(key, JSON.stringify(state)); }
      catch { saved.writable = false; saved.warning = 'Tim’s paperwork cannot be saved in this browser.'; }
    }
  }
  return {
    get state() { return { ...state }; },
    get phase() { return phase; },
    get position() { return { ...position }; },
    get visible() { return state.started && phase !== 'gone'; },
    get warning() { return saved.warning ?? ''; },
    close() { if (phase === 'talking') phase = 'idle'; },
    talk() { if (!state.started || state.complete) return false; phase = 'talking'; return true; },
    answer(id) {
      const next = answerCrook(state, id);
      if (next !== state) { save(next); if (state.complete) phase = 'departing'; }
    },
    tick(dt, player, { grounded = true, busy = false, radius = 1.4, obstacles = [], clear = () => true,
      motionFrom = previous } = {}) {
      if (!player) { previous = null; return false; }
      const p = { ...player }, step = Math.hypot(p.x - (previous?.x ?? p.x), p.z - (previous?.z ?? p.z));
      const walking = grounded && Math.abs(p.y) < 0.75 && Math.abs(previous?.y ?? 0) < 0.75
        && step <= Math.max(0.8, Math.min(dt, 0.1) * 45);
      if (!state.started) {
        if (Math.abs(p.x) < 9 && p.z > -10 && p.z < 9 && grounded && Math.abs(p.y) < 0.75) entered = true;
        // Cross the *outer* wall, through the eight-cell front doorway.
        if (entered && motionFrom && walking && Math.abs(motionFrom.y) < 0.75
          && Math.abs(motionFrom.x) < 2.5 && Math.abs(p.x) < 2.5
          && motionFrom.z >= -13 && p.z < -13 && motionFrom.z < -9
          && Math.hypot(p.x - motionFrom.x, p.z - motionFrom.z) <= Math.max(0.8, Math.min(dt, 0.1) * 45)) {
          save(startCrook(state)); phase = 'approaching';
        }
        if (!walking) entered = false;
      }
      previous = p;
      if (phase === 'departing') {
        const seconds = Math.min(Math.max(dt, 0), 0.1);
        departing += seconds;
        const distance = Math.hypot(8 - position.x, -26 - position.z);
        if (distance > 0.1) {
          const travel = Math.min(6 * seconds, distance);
          const target = { x: position.x + (8 - position.x) / distance * travel,
            z: position.z + (-26 - position.z) / distance * travel };
          const next = resolveCharacterMotion(position, target, 1.4, [...obstacles, { ...p, radius }]);
          if (clear(position, next)) position = { x: next.x, z: next.z };
        }
        if (departing >= 2.4) phase = 'gone';
        return false;
      }
      if (phase !== 'approaching' || busy) return false;
      // Never follow into a house, over a roof, or away from the clear front path.
      if (!grounded || Math.abs(p.y) >= 0.75 || p.z > -13 || p.z < -27 || Math.abs(p.x) > 9) {
        phase = 'idle'; return false;
      }
      const distance = Math.hypot(p.x - position.x, p.z - position.z), stop = radius + 1.4 + 0.8;
      if (distance <= stop + 0.1) { phase = 'talking'; return true; }
      const travel = Math.min(5 * Math.min(Math.max(dt, 0), 0.1), distance - stop);
      const target = { x: position.x + (p.x - position.x) / distance * travel,
        z: Math.min(-14.5, position.z + (p.z - position.z) / distance * travel) };
      const next = resolveCharacterMotion(position, target, 1.4, [...obstacles, { ...p, radius }]);
      if (clear(position, next)) position = { x: next.x, z: next.z };
      return false;
    },
  };
}

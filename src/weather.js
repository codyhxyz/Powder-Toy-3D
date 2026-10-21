// Minecraft's manually selected weather, with TPT's paused simulation clock:
// no scheduler, and atmosphere changes never advance while physics is paused.
export const WEATHER_STEPS_PER_SECOND = 240;
const PRESETS = {
  clear: { cloud: 0, rain: 0, storm: 0 },
  overcast: { cloud: 0.65, rain: 0, storm: 0 },
  rain: { cloud: 0.85, rain: 0.65, storm: 0 },
  storm: { cloud: 1, rain: 1, storm: 1 },
};
// Source strength ramps up; stopping sources never removes existing elements.
const SECONDS = { cloud: 8, rain: 4, storm: 4 };
const keys = Object.keys(SECONDS);
const defaults = () => ({ preset: 'clear', cloud: 0, rain: 0, storm: 0, wind: [0.8, 0.6], time: 0 });
const valid = (table, key) => {
  if (!Object.hasOwn(table, key)) throw new RangeError(`Unknown weather option: ${key}`);
};

export function createWeather() {
  const state = defaults(), target = { ...PRESETS.clear };
  const listeners = new Set();
  let lastClock = 0, version = 0, disposed = false;
  const changed = () => { version++; for (const fn of listeners) fn(); };
  const api = {
    state,
    get version() { return version; },
    get selection() { return { preset: state.preset }; },
    get active() { return keys.some((k) => state[k] > 0); },
    subscribe(fn) { if (!disposed) listeners.add(fn); return () => listeners.delete(fn); },
    setPreset(preset) {
      valid(PRESETS, preset);
      if (disposed || state.preset === preset) return false;
      state.preset = preset;
      Object.assign(target, PRESETS[preset]);
      for (const key of keys) if (!target[key]) state[key] = 0;
      changed();
      return true;
    },
    // Absolute simulation seconds, not wall time or the editable sun clock.
    // A rewound clock rebases without running an event backwards.
    update(clock) {
      if (!Number.isFinite(clock) || clock < 0) throw new RangeError('Weather clock must be finite, nonnegative seconds');
      if (disposed) return state;
      const dt = Math.max(0, clock - lastClock);
      lastClock = clock;
      if (!dt) return state;
      state.time += dt;
      const wasActive = api.active;
      for (const k of keys) {
        state[k] = target[k] + (state[k] - target[k]) * Math.exp(-dt / SECONDS[k]);
        if (Math.abs(state[k] - target[k]) < 1e-6) state[k] = target[k];
      }
      if (wasActive || api.active) version++;
      return state;
    },
    // Reset stops the sources; it never removes the clouds and rain already made.
    reset(clock = lastClock) {
      if (!Number.isFinite(clock) || clock < 0) throw new RangeError('Weather clock must be finite, nonnegative seconds');
      if (disposed) return false;
      Object.assign(state, defaults());
      Object.assign(target, PRESETS.clear);
      lastClock = clock;
      changed();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true; listeners.clear();
    },
  };
  return api;
}

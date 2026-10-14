// Minecraft's manually selected weather, with TPT's paused simulation clock:
// no scheduler, and atmosphere changes never advance while physics is paused.
export const WEATHER_STEPS_PER_SECOND = 240;
const PRESETS = {
  clear: { cloud: 0, rain: 0, storm: 0, ocean: 0 },
  overcast: { cloud: 0.65, rain: 0, storm: 0, ocean: 0 },
  rain: { cloud: 0.85, rain: 0.65, storm: 0, ocean: 0.5 },
  storm: { cloud: 1, rain: 1, storm: 1, ocean: 1 },
};
const FOG = { off: 0, light: 0.35, thick: 1 };
const OCEAN = { calm: 0, choppy: 0.5, rough: 1 };
// Source strength ramps up; stopping sources never removes existing elements.
const SECONDS = { cloud: 8, rain: 4, storm: 4, fog: 12, ocean: 18 };
const keys = Object.keys(SECONDS);
const defaults = () => ({ preset: 'clear', cloud: 0, rain: 0, storm: 0, fog: 0, ocean: 0, wind: [0.8, 0.6], time: 0 });
const valid = (table, key) => {
  if (!Object.hasOwn(table, key)) throw new RangeError(`Unknown weather option: ${key}`);
};

export function createWeather() {
  const state = defaults(), target = { ...PRESETS.clear, fog: 0 };
  const listeners = new Set();
  let fog = 'off', ocean = 'calm', lastClock = 0, version = 0, disposed = false;
  let eligible = false, active = false, pending = false, trigger = null, cancel = null, request = 0, error = '';
  const changed = () => { version++; for (const fn of listeners) fn(); };
  const api = {
    state,
    get version() { return version; },
    get selection() { return { preset: state.preset, fog, ocean }; },
    get active() { return pending || active || keys.some((k) => state[k] > 0); },
    get tsunami() { return { eligible, available: !!trigger, active, pending, error }; },
    subscribe(fn) { if (!disposed) listeners.add(fn); return () => listeners.delete(fn); },
    setPreset(preset) {
      valid(PRESETS, preset);
      if (disposed) return false;
      const cancelled = preset === 'clear' && api.cancelTsunami();
      // Repeated choices do not wipe independent fog/ocean overrides.
      if (state.preset === preset && (preset !== 'clear' || (fog === 'off' && ocean === 'calm'))) return !!cancelled;
      state.preset = preset;
      Object.assign(target, PRESETS[preset]);
      for (const key of ['cloud', 'rain', 'storm', 'ocean']) if (!target[key]) state[key] = 0;
      ocean = Object.keys(OCEAN).find((k) => OCEAN[k] === target.ocean);
      if (preset === 'clear') { fog = 'off'; target.fog = state.fog = 0; }
      changed();
      return true;
    },
    setFog(value) {
      valid(FOG, value);
      if (disposed || fog === value) return false;
      fog = value; target.fog = FOG[value];
      if (value === 'off') state.fog = 0;
      changed();
      return true;
    },
    setOcean(value) {
      valid(OCEAN, value);
      if (disposed || ocean === value) return false;
      ocean = value; target.ocean = OCEAN[value];
      if (value === 'calm') state.ocean = 0;
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
    // Reset cancels an event; it cannot undo any physical damage already caused.
    reset(clock = lastClock) {
      if (!Number.isFinite(clock) || clock < 0) throw new RangeError('Weather clock must be finite, nonnegative seconds');
      if (disposed) return false;
      api.cancelTsunami();
      Object.assign(state, defaults());
      Object.assign(target, PRESETS.clear, { fog: 0 });
      fog = 'off'; ocean = 'calm'; lastClock = clock; error = '';
      changed();
      return true;
    },
    setOceanEligible(value) {
      if (disposed || eligible === !!value) return false;
      eligible = !!value;
      if (!eligible) api.cancelTsunami();
      changed();
      return true;
    },
    // WebGPU validation is async and read-only. cancel must also invalidate any
    // pending validation in the event owner; late results cannot resurrect it.
    setTsunamiHooks(hooks = {}) {
      if (disposed) return false;
      if ((hooks.trigger != null && typeof hooks.trigger !== 'function') ||
          (hooks.cancel != null && typeof hooks.cancel !== 'function') ||
          (!!hooks.trigger !== !!hooks.cancel)) throw new TypeError('Tsunami hooks require both trigger and cancel functions');
      api.cancelTsunami();
      trigger = hooks.trigger ?? null; cancel = hooks.cancel ?? null;
      changed();
      return true;
    },
    async triggerTsunami() {
      if (disposed || !eligible || !trigger || active || pending) return false;
      const ticket = ++request;
      pending = true; error = ''; changed();
      try {
        const started = await trigger();
        if (disposed || ticket !== request) return false;
        pending = false; active = started === true;
        if (!active) error = 'No connected ocean source in the active area. Move closer to the coast.';
        changed();
        return active;
      } catch (cause) {
        if (disposed || ticket !== request) return false;
        pending = active = false;
        error = cause?.message || 'Unable to start the tsunami.';
        changed();
        throw cause;
      }
    },
    cancelTsunami() {
      if (disposed || (!active && !pending)) return false;
      ++request; active = pending = false; error = '';
      try { cancel?.(); } finally { changed(); }
      return true;
    },
    finishTsunami() {
      if (disposed || !active) return false;
      active = false; changed();
      return true;
    },
    dispose() {
      if (disposed) return;
      try { api.cancelTsunami(); }
      finally { disposed = true; trigger = cancel = null; listeners.clear(); }
    },
  };
  return api;
}

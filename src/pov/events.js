// POV event bus: what happens in first person, announced once, heard by anyone.
// The gun, the tools and the shell emit; sound (audio.js), effects (vfx.js) and
// feedback (camera kick, shake, hitmarker) listen. Nobody has to edit anybody
// else's file to react to a shot. Event names and payloads: docs/pov.md, "Events".

const listeners = new Map();

export const povEvents = {
  // fn(payload); returns an unsubscribe function
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name)?.delete(fn);
  },
  emit(name, payload = {}) {
    const set = listeners.get(name);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (err) { console.error(`povEvents '${name}' listener failed`, err); }
    }
  },
};

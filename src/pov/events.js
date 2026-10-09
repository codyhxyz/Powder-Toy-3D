// POV event bus: what happens in first person, announced once, heard by anyone.
// The gun, the tools and the shell emit; sound (audio.js), effects (vfx.js) and
// feedback (camera kick, shake, hitmarker) listen. Nobody has to edit anybody
// else's file to react to a shot. Event names and payloads: docs/pov.md, "Events".

//
// Actors: while an NPC's tools run (povEvents.as(actor, fn)), every emit
// carries by: actor.id and from: actor.at (its eye, grid cells), so listeners
// can tell its shots from the player's (sound at its position, no hitmarker or
// camera kick for the player), and its view punches are dropped: they belong
// to a camera it doesn't have.

const listeners = new Map();
const OWN_VIEW = new Set(['punch']);   // events about the player's own view, never an NPC's
let actor = null;

export const povEvents = {
  // run fn as actor ({ id, at }) and return what it returns
  as(who, fn) {
    const prev = actor;
    actor = who;
    try { return fn(); } finally { actor = prev; }
  },
  get actor() { return actor; },
  // fn(payload); returns an unsubscribe function
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name)?.delete(fn);
  },
  emit(name, payload = {}) {
    if (actor) {
      if (OWN_VIEW.has(name)) return;
      payload = { ...payload, by: actor.id, from: actor.at?.clone?.() ?? null };
    }
    const set = listeners.get(name);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (err) { console.error(`povEvents '${name}' listener failed`, err); }
    }
  },
};

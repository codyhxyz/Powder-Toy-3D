// What goes into a save besides the grid, by feature. Each feature registers
// a section under its own key and the save carries it from then on:
//
//   registerSaveSection('deco', {
//     save: () => data,             // JSON-able, or a typed array; may return a Promise; undefined: leave it out
//     load: (data, header) => {},   // after the grid and its state are in (header: the save's header)
//     absent: (header) => {},       // optional: a save without this section (made before it existed) is loading
//   });
//
// Sections save and load in the order they were registered, after the grid
// itself (saves/game.js). A save holding a key no one registered (a newer
// build's) loads without it, and a section with no data in a save gets
// absent(), so a feature can go back to its defaults: TPT's rule for the
// fields of its saves (format.js).
//
// Settings that belong to a world rather than to the player (TPT saves
// gravity, air and edge modes with the save) go in with
// registerSavedSettings(keys): the 'settings' section keeps them, and loading
// sets them and calls the app's onSettings (saves/game.js).

const sections = new Map();
const settingKeys = new Set();

export function registerSaveSection(key, { save, load, absent = null, validate = null, strict = false }) {
  if (typeof save !== 'function' || typeof load !== 'function') throw new Error(`save section '${key}': needs save and load`);
  sections.set(key, { save, load, absent, validate, strict });
}

export function unregisterSaveSection(key) { sections.delete(key); }

// settings keys (app.js settings) a save carries
export function registerSavedSettings(keys) { for (const k of keys) settingKeys.add(k); }
export const savedSettingKeys = () => [...settingKeys];

// [{ key, data }] for encodeSave, every registered section's. Every save()
// is called before any is awaited, so all of them see the same moment as the
// grid's readback (saves/game.js starts it in the same task); an async one
// should take what it needs before its first await.
export async function collectSections() {
  const started = [];
  for (const [key, s] of sections) {
    let p;
    try { p = Promise.resolve(s.save()); } catch (error) { p = Promise.reject(error); }
    // Observe every rejection immediately: a strict section may refuse before
    // other sections' asynchronous reads have finished.
    started.push([key, p.then(data => ({ data }), error => ({ error })), s.strict]);
  }
  const out = [];
  for (const [key, p, strict] of started) {
    const result = await p;
    if (Object.hasOwn(result, 'error')) { if (strict) throw result.error; failed(key, result.error); }
    else if (result.data !== undefined) out.push({ key, data: result.data });
  }
  return out;
}
const failed = (key, err) => console.error(`save: section '${key}' failed; the save goes without it`, err);

// Critical sections validate before prepare() can replace terrain or modes.
// Older sections and saves without the new section retain their existing behavior.
export async function validateSections(data, header) {
  for (const [key, s] of sections) await s.validate?.(data.get(key), header);
}

// Hand each registered section its data (a Map from decodeSave), or absent().
export async function applySections(data, header) {
  for (const [key, s] of sections) {
    try {
      if (data.has(key)) await s.load(data.get(key), header);
      else await s.absent?.(header);
    } catch (err) {
      if (s.strict) throw err;
      console.error(`load: section '${key}' failed; the rest of the save loaded`, err);
    }
  }
}

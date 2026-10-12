// ?shot=<name>: one shot of the side-by-side sheet (docs/v2.md 11, Week 0;
// tools/side-by-side/shots.mjs) in a player's own page, so the iPhone opens
// the same scene, camera and game time that tools/side-by-side.mjs captures
// on the Mac, through the same setup code (tools/side-by-side/engine.mjs),
// and then it's the player's: a still waits paused (Space runs it), a clip's
// action is set going and plays live. Inert without the parameter and never
// kept, as ?test= isn't: app.js imports this module only when it's there, and
// the scene the link boots isn't remembered as the one to boot next time.
// The page plays it on its own engine when it has one (window.__shotEngine,
// v2's behind ?engine=v2), as the tool does.
import { E, PROP_TOOL } from './elements.js';
import { PROP } from './editing.js';
import { shotByName } from '../tools/side-by-side/shots.mjs';
import { linkQuery, shotEngine, prepareShot, SETTINGS_STORE } from '../tools/side-by-side/engine.mjs';

// the stored settings that pick the scene a plain visit boots (app.js PERSIST)
const SCENE_KEYS = ['size', 'preset', 'scene'];

/**
 * The shot ?shot= names, its scene put into the boot's parameters (app.js
 * reads them next) unless the link sets them itself. Null for no such shot.
 * @param {URLSearchParams} params
 */
export function shotParams(params) {
  const shot = shotByName(params.get('shot'));
  if (!shot) { console.warn(`?shot=${params.get('shot')}: no such shot`); return null; }
  for (const [k, v] of Object.entries(linkQuery(shot.scene))) if (!params.has(k)) params.set(k, v);
  keepStoredScene();
  return shot;
}

// The app saves its settings with the scene it runs (loadPreset, and any
// later change), which here is the link's: whatever this page saves keeps
// the scene keys stored before it, so the next plain visit boots what it
// would have. The player's other settings save as ever.
function keepStoredScene() {
  let stored, before = null;
  try { stored = localStorage.getItem(SETTINGS_STORE); } catch { return; }   // (no storage: nothing kept)
  try { before = JSON.parse(stored ?? 'null'); } catch { /* unreadable: as the app takes it, none */ }
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (key === SETTINGS_STORE && this === globalThis.localStorage) {
      try {
        const saved = JSON.parse(value);
        for (const k of SCENE_KEYS) { if (before && k in before) saved[k] = before[k]; else delete saved[k]; }
        value = JSON.stringify(saved);
      } catch { /* not settings we know: saved as given */ }
    }
    return setItem.call(this, key, value);
  };
}

/**
 * The shot played to where the tool captures it, on the running game, then
 * handed over. app: window.__app; setPaused: app.js's (the toolbar follows).
 */
export async function playShot(app, shot, { setPaused }) {
  try {
    const engine = await shotEngine(app, { live: true, tables: { E, PROP_TOOL, PROP } });
    await prepareShot(engine, shot);
    engine.release?.();
    setPaused(shot.kind === 'still');
    app.hud.toast(shot.kind === 'still'
      ? `${shot.title}: ${(shot.settle ?? 0) + (shot.time ?? 0)} s in, paused. Space runs it`
      : `${shot.title}: running`);
  } catch (err) {
    console.error(`?shot=${shot.name} failed`, err);
    app.hud.toast(`${shot.title}: the shot failed to load`, { kind: 'error' });
  }
}

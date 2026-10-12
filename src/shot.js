// ?shot=<name>: one shot of the side-by-side sheet (docs/v2.md 11, Week 0;
// tools/side-by-side/shots.mjs) in a player's own page, so the iPhone opens
// the same scene, camera and game time that tools/side-by-side.mjs captures
// on the Mac, through the same setup code (tools/side-by-side/engine.mjs),
// and then it's the player's: a still waits paused (Space runs it), a clip's
// action is set going and plays live. Inert without the parameter and never
// kept, as ?test= isn't: app.js imports this module only when it's there.
// (A box scene's link loads its map, and the app remembers the map last
// played, as any ?preset= link does.)
import { E, PROP_TOOL } from './elements.js';
import { PROP } from './editing.js';
import { shotByName } from '../tools/side-by-side/shots.mjs';
import { linkQuery, createEngine, prepareShot } from '../tools/side-by-side/engine.mjs';

/**
 * The shot ?shot= names, its scene put into the boot's parameters (app.js
 * reads them next) unless the link sets them itself. Null for no such shot.
 * @param {URLSearchParams} params
 */
export function shotParams(params) {
  const shot = shotByName(params.get('shot'));
  if (!shot) { console.warn(`?shot=${params.get('shot')}: no such shot`); return null; }
  for (const [k, v] of Object.entries(linkQuery(shot.scene))) if (!params.has(k)) params.set(k, v);
  return shot;
}

/**
 * The shot played to where the tool captures it, on the running game, then
 * handed over. app: window.__app; setPaused: app.js's (the toolbar follows).
 */
export async function playShot(app, shot, { setPaused }) {
  try {
    const engine = await createEngine(app, { live: true, tables: { E, PROP_TOOL, PROP } });
    await prepareShot(engine, shot);
    setPaused(shot.kind === 'still');
    app.hud.toast(shot.kind === 'still'
      ? `${shot.title}: ${shot.time ?? 0} s in, paused. Space runs it`
      : `${shot.title}: running`);
  } catch (err) {
    console.error(`?shot=${shot.name} failed`, err);
    app.hud.toast(`${shot.title}: the shot failed to load`, { kind: 'error' });
  }
}

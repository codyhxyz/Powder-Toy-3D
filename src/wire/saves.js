// Saves (src/saves; docs/webgpu.md Sync log S4, U12): ⌘S or the toolbar's
// Save keeps the game in the Saves list, with a picture; the map menu's Saves
// (Esc, ⌘O) loads one, exports it as a .tpt3d file or opens one. Garry's
// Mod's way: a save is named for its map and the time, and listed with its
// thumbnail. A box save loads as a scene change, so ⌘Z takes it back; a World
// save, like any world load, can't be undone. A save is a full-state readback
// like the codec's, recorded at the moment it is asked for and read back
// without a stall (saves/game.js).
import { createSaves, SaveRefused } from '../saves/game.js';
import { registerSaveSection, registerSavedSettings } from '../saves/sections.js';
import { putSave, getSave, cleanName } from '../saves/local.js';
import { SIM_MODE_KEYS, SIM_MODE_DEFAULTS } from '../simModes.js';
import { mapOf } from '../maps.js';
import { ARENA_PRESETS } from '../presets.js';

const SAVE_THUMB_BG = '#0e1117';   // what a thumbnail's clear pixels (a box has no sky) sit on: the page's background
const SAVE_THUMB_TYPE = 'image/jpeg', SAVE_THUMB_QUALITY = 0.82;
const MB = 1024 * 1024;
// The save's picture for the Saves list: the next frame on screen, cropped and
// scaled down, read from the canvas in the frame's own task as the screenshot
// is (app.js saveScreenshot). It draws nothing extra (no second render, no
// pipeline to build). Resolves to a data URL, or null if no frame comes (a parked test page).
const SAVE_THUMB_SIZE = [320, 200];   // px: the views menu's thumbnails' size
const SAVE_THUMB_WAIT_MS = 1500;

let saves = null;
let saving = false, loadingSave = false;

const savesWire = {
  name: 'saves',
  ready: true,

  boot(app) {
    const { settings } = app;
    // the gravity and speed a world was saved with come back with it (TPT keeps gravity in a save)
    registerSavedSettings(['gravity', 'steps']);
    // The simulation modes (simModes.js) are the world's, as TPT keeps gravity,
    // air and edge modes in each save; a save from before them gets its map's
    // defaults back, not whatever was on before it loaded.
    registerSaveSection('simModes', {
      save: () => Object.fromEntries(SIM_MODE_KEYS.map((k) => [k, settings[k]])),
      load: (m) => app.setSimModes({ ...SIM_MODE_DEFAULTS, ...mapOf(settings)?.modes, ...m }),
      absent: () => app.resetSimModes(),
    });
    saves = createSaves({
      settings, getSim: () => app.sim, getWin: () => app.win,
      header: () => {
        const m = mapOf(settings);
        return {
          map: m?.key ?? null, mapName: m?.name ?? null, size: settings.size, preset: app.win ? null : settings.preset,
          world: app.win ? { scene: settings.scene, seed: app.worldSeed ?? null } : null,
          industryMode: app.industry?.state.active ? app.gamemode : undefined,
          guestCopy: app.mp.isGuest || undefined,   // a guest's copy of the host's world (no velocity or pressure: net/codec.js)
        };
      },
      thumbnail: () => saveThumbnail(app),
      prepare: (h) => prepareSave(app, h),
      finish: () => {
        if (app.win) app.placeVolume();
        app.post.reset();
        app.pov?.worldReplaced();
        app.birds?.worldReplaced();
        app.toolbar.setUndoEnabled(app.gamemode !== 'factory' && app.sim.canUndo);
        app.dock.sync();
        app.hud.setPaused(settings.paused);
        app.settingsPanel.sync();
        app.save();
        app.requestRender();
      },
      onSettings: () => { app.sim.gravity = settings.gravity; },
    });
    // the god camera in world cells, so it comes back over the same ground in a world whose window has moved
    const camToCells = (v) => [v.x / app.scale + app.anchor.x, v.y / app.scale, v.z / app.scale + app.anchor.y];
    const camFromCells = (a, out) => out.set((a[0] - app.anchor.x) * app.scale, a[1] * app.scale, (a[2] - app.anchor.y) * app.scale);
    registerSaveSection('camera', {
      save: () => (app.camState() === 'god' ? { position: camToCells(app.camera.position), target: camToCells(app.controls.target) } : undefined),
      load: (d) => {
        camFromCells(d.position, app.camera.position);
        camFromCells(d.target, app.controls.target);
        app.controls.update();
      },
      // saved in the body: in a world, the god view over the window (the window would chase a camera left elsewhere)
      absent: () => { if (app.win) { app.homeOver(app.sim.origin.x + app.sim.g.nx / 2, app.sim.origin.z + app.sim.g.nz / 2); app.rig.reset(true); } },
    });
    registerSaveSection('day', {
      save: () => ({ clock: app.day.clock }),
      load: (d) => { if (Number.isFinite(d.clock)) { app.day.clock = d.clock; app.updateSun(); } },
    });
    registerSaveSection('signs', { save: () => app.signs?.toJSON(), load: (d) => app.signs?.fromJSON(d), absent: () => app.signs?.clear() });
    registerSaveSection('spawners', { save: () => app.spawners?.toJSON(), load: (d) => app.spawners?.fromJSON(d) });
    registerSaveSection('perkOrbs', { save: () => app.perkOrbs?.toJSON(), load: (d) => app.perkOrbs?.fromJSON(d) });
  },

  // Save the game into the Saves list. Resolves to the save's meta (saves/local.js), or null.
  async saveGame(app, name) {
    if (saving) return null;
    saving = true;
    app.hud.toast('Saving…');
    try {
      const bytes = await saves.capture(cleanName(name) || saveName(app));
      const meta = await putSave(bytes);
      app.hud.toast(`Saved "${meta.name}" (${(bytes.length / MB).toFixed(1)} MB). Esc → Saves to load it`);
      return meta;
    } catch (err) {
      if (!(err instanceof SaveRefused)) console.error('save failed', err);
      app.hud.toast(err instanceof SaveRefused ? err.message : `Couldn't save: ${err.message}`);
      return null;
    } finally {
      saving = false;
    }
  },
  // Load a save: a local save's id, or a save file's bytes. Resolves to whether it loaded.
  async openSave(app, what) {
    if (loadingSave) return false;
    loadingSave = true;
    try {
      const bytes = typeof what === 'string' ? await getSave(what) : what;
      const h = await saves.apply(bytes);
      if (h) app.hud.toast(`Loaded "${h.name}"${h.world ? '' : app.sim.canUndo ? ' (⌘Z takes it back)' : ''}`);
      return !!h;
    } catch (err) {
      if (!(err instanceof SaveRefused)) console.error('load failed', err);
      app.hud.toast(err instanceof SaveRefused ? err.message : `Couldn't load that save: ${err.message}`);
      return false;
    } finally {
      loadingSave = false;
    }
  },
  // a loaded save taken back (undo): the box's signs, spawners and orbs too
  restoreSceneExtras(app, x) {
    app.settings.preset = x.preset;
    app.arenaLayout = x.preset in ARENA_PRESETS ? ARENA_PRESETS[x.preset].build().layout : null;
    app.resetSpawners(x.preset);
    app.spawners?.fromJSON(x.spawners);
    app.perkOrbs?.fromJSON(x.perkOrbs);
    app.signs?.fromJSON(x.signs);
    if (x.industry) app.industry?.fromJSON(x.industry); else app.industry?.reset();
    app.save();
  },
};

const saveName = (app) => {
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  return `${mapOf(app.settings)?.name ?? 'Custom'} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function saveThumbnail(app) {
  return new Promise((resolve) => {
    let done = false;
    app.onNextFrame(() => { if (!done) { done = true; resolve(takeSaveThumbnail(app)); } });
    app.requestRender();
    setTimeout(() => { if (!done) { done = true; resolve(null); } }, SAVE_THUMB_WAIT_MS);
  });
}
function takeSaveThumbnail(app) {
  try {
    const src = app.canvas, [w, h] = SAVE_THUMB_SIZE;
    const out = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = out.getContext('2d');
    ctx.fillStyle = SAVE_THUMB_BG;
    ctx.fillRect(0, 0, w, h);
    const k = Math.min(src.width / w, src.height / h);   // (cover: the middle of the view)
    ctx.drawImage(src, (src.width - w * k) / 2, (src.height - h * k) / 2, w * k, h * k, 0, 0, w, h);
    return out.toDataURL(SAVE_THUMB_TYPE, SAVE_THUMB_QUALITY);
  } catch (err) {
    console.warn('save: no thumbnail', err);
    return null;
  }
}

// Get the grid ready for a save: its map and size (a rebuild if they differ),
// else an undo snapshot. Resolves false to refuse.
async function prepareSave(app, h) {
  const { settings } = app;
  if (app.graphicsFailure) throw app.graphicsFailure;
  if (app.mp.guard()) return false;
  if (app.industry?.pending) throw new SaveRefused('Wait for the current Industry transfer before loading.');
  app.painting = false;
  app.pov?.exit(true);   // the body is left out of a save; you come back in the god view
  if (h.world) {
    if (app.mp.guardWorld()) return false;
    const scene = app.sceneByKey(h.world.scene);
    if (!(h.size in app.WORLDS) || scene.key !== h.world.scene) throw new SaveRefused('That save is of a world this version doesn\'t have');
    const seed = h.world.seed ?? undefined;
    if (!app.win || settings.size !== h.size || settings.scene !== scene.key || app.worldSeed !== seed) {
      settings.scene = scene.key;
      app.worldSeed = seed;
      app.setSize(h.size);
    }
    const w = app.win;
    if (w.size.some((n, i) => n !== h.world.size?.[i])) throw new SaveRefused('That save\'s world is a different size');
    await w.whenReady();   // (after the world's own start, which the switch queued first)
    return app.win === w;  // (switched again meanwhile: the newer pick wins)
  }
  const fits = (k) => app.SIZES[k]?.every((n, i) => n === h.dims[i]);
  const size = fits(h.size) ? h.size : Object.keys(app.SIZES).find(fits);
  if (!size) throw new SaveRefused(`This version has no ${h.dims.join(' × ')} grid`);
  const preset = h.preset ?? 'empty';
  if (settings.size !== size) {
    settings.preset = 'empty';   // (the save brings the cells: no building the map's scene first)
    app.setSize(size);
  } else {
    // undoable like any scene change; TPT takes a history snapshot before opening a local save (GameController.cpp OpenLocalBrowse)
    const extras = sceneExtras(app); // a strict machine snapshot can refuse before touching history
    app.sim.snapshot('Loaded save');
    app.sim.history.at(-1).note = { scene: extras };
  }
  settings.preset = preset;
  if (h.industryMode === 'factory' || h.industryMode === 'sandbox') await app.setMode(h.industryMode);
  else if (app.gamemode === 'factory') await app.setMode('sandbox');
  // an arena's layout (spawns, flags, shrines) is its build's, without its cells
  app.arenaLayout = preset in ARENA_PRESETS ? ARENA_PRESETS[preset].build().layout : null;
  app.signs?.clear();
  app.resetSpawners(preset);
  return true;
}

// What a box holds besides its cells (its scene, signs, spawners, perk orbs), for undoing a load.
const sceneExtras = (app) => ({ preset: app.settings.preset, signs: app.signs?.toJSON(), spawners: app.spawners?.toJSON(), perkOrbs: app.perkOrbs?.toJSON(), industry: app.industry?.toJSON() });

export default savesWire;

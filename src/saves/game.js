import { decodeWorldState, validateDecorationState } from '../world/persistence.js';
import { encodeSave, decodeSave, packCells, unpackCells } from './format.js';
import { collectSections, applySections, validateSections, savedSettingKeys } from './sections.js';
import { cellTexel } from '../sim.js';

// Saving and loading the game (format.js has the file, sections.js what
// features add). A save holds:
//   cells     every cell of the grid, exactly: state A (id, °C, life, ctype +
//             seed) and B (velocity, pressure), shuffled into byte planes
//             (format.js packCells). What derives from them (activity flags,
//             render fields, bricks, GI) is rebuilt on load, as after any load.
//   (rays     V1's photon and neutron list, in saves made before the V2 cutover: V2 doesn't read it.
//             V2's flying matter, its photons and neutrons too, is the physicsV2Dynamics section's.)
//   settings  the settings that belong to the world (sections.js registerSavedSettings)
//   world     in World: the stored edits outside the window (world/store.js)
//             and the brick columns whose trees are in, with the window's
//             origin, seed and scene in the header
// then every registered section (signs, spawners, the camera, the day...).
//
// The state is read back the way the multiplayer host reads it
// (net/codec.js): the copies are recorded at once (sim.readState, the
// particles' readList, a section's own reads: docs/webgpu.md B7) and resolve
// when the GPU gets there, so the frame never stalls and the save is the state
// at the moment it was asked for. Their kernels are built first, so nothing
// in that moment waits.
//
// app: { settings, getSim, getWin, header(), thumbnail(), prepare(header), finish(header), onSettings() }
//   header()         the save's description of the scene: { map, mapName, size, preset, world: { scene, seed } | null }
//   thumbnail()      resolves to the save's picture (a data URL) or null
//   prepare(header)  gets the grid ready for a save (switching map or size, an undo snapshot): resolves false to refuse
//   finish(header)   after everything is in (the volume, the view, the HUD)
//   onSettings()     after the saved settings were set

const CHANNELS = 4;                   // RGBA per texel

export class SaveRefused extends Error {}

export function createSaves(app) {
  const { settings } = app;

  // Capture the game now: resolves to the save's bytes. name: the save's name.
  async function capture(name) {
    const sim = app.getSim(), win = app.getWin();
    const release = win?.acquireReadLock(), identity = win?.historyIdentity;
    try {
      if (win) {
        if (!win.loaded) throw new SaveRefused('The world is still loading: try again in a moment');
        // a slab that left the window is still on its way into the store: wait for it
        while (win.pending || sim.deco?.pending) await Promise.all([win.pending, sim.deco?.pending]);
        if (win.persistenceError) throw new SaveRefused('World readback failed; saving would lose retained material');
        if (sim !== app.getSim()) throw new SaveRefused('The map changed while saving');
      }
      // the conversion to the atlas order, built before the moment
      await Promise.all([sim.prepare(sim.saveStatePass ?? 'toAtlas'), app.prepareCapture?.()]);
      // Interaction readbacks can begin during preparation too.
      while (win?.pending || sim.deco?.pending) await Promise.all([win?.pending, sim.deco?.pending]);
      if (sim !== app.getSim() || sim.disposed || win !== app.getWin() || identity !== win?.historyIdentity) throw new SaveRefused('The map changed while saving');
      // ---- from here to the readbacks, one task: everything below is the same moment ----
      const g = sim.g;
      // (V2: its own cells, read as V1's builds read `cells`: sim.readSaveState)
      const reads = [sim.readSaveState ? sim.readSaveState() : sim.readState()];
      const scene = app.header(), thumbnail = app.thumbnail?.() ?? null;
      const header = {
        name, created: new Date().toISOString(), ...scene,
        dims: [g.nx, g.ny, g.nz],
        world: win ? { ...scene.world, size: [...win.size], origin: [sim.origin.x, sim.origin.y, sim.origin.z] } : null,
      };
      const core = [
        { key: 'settings', data: Object.fromEntries(savedSettingKeys().filter((k) => k in settings).map((k) => [k, settings[k]])) },
      ];
      if (win) core.push({ key: 'worldStore', data: win.store.toBytes() }, { key: 'worldNativeStore', data: win.nativeStore.toBytes() }, { key: 'worldPlanted', data: win.planted.slice() });
      if (win?.scene.interactionState) core.push({ key: 'worldInteractions', data: win.scene.interactionState.snapshot() });
      const extra = collectSections();
      // ---- (the moment ends) ----
      const [[A, B], extras] = await Promise.all([reads[0], extra]);
      header.thumbnail = await thumbnail;
      const cells = packCells(header.dims, (x, y, z) => cellTexel(g, x, y, z), [A, B]);
      const sections = [{ key: 'cells', data: cells }, ...core];
      sections.push(...extras);
      return await encodeSave(header, sections);
    } finally { release?.(); }
  }

  // Load a save's bytes. Resolves to its header, or null if the app refused
  // (a guest; a world while playing together); throws on a broken file.
  async function apply(bytes) {
    const { header, sections } = await decodeSave(bytes);
    const cells = sections.get('cells');
    if (!(cells instanceof Uint8Array) || !Array.isArray(header.dims) || header.dims.length !== 3
        || header.dims.some(n => !Number.isSafeInteger(n) || n <= 0)
        || !Number.isSafeInteger(header.dims.reduce((a, n) => a * n, 32))
        || cells.length !== header.dims.reduce((a, n) => a * n, 32)) throw new Error('this save has an invalid grid');
    if (header.world) decodeWorldState(header.world, header.dims, sections.get('worldStore'), sections.get('worldPlanted'), sections.get('worldNativeStore'));
    else if (['worldStore', 'worldPlanted', 'worldNativeStore', 'decoStore'].some(key => sections.has(key))) throw new Error('World sections require a world');
    validateDecorationState(sections, header);
    await validateSections(sections, header);
    if (!await app.prepare(header)) return null;
    const sim = app.getSim(), win = app.getWin(), g = sim.g;
    if ([g.nx, g.ny, g.nz].some((n, i) => n !== header.dims[i])) throw new Error(`the save is ${header.dims.join('×')}, the grid ${g.nx}×${g.ny}×${g.nz}`);
    // A save whose V2 section restores V2's exact cells in a session V2 presents (app.nativeLoad):
    // its V1 `cells` aren't unpacked and written for V2 to replace (sim.loadNative).
    const native = !!app.nativeLoad?.(header, sections);
    let fill;
    if (native) fill = () => sim.loadNative();
    else {
      const [A, B] = sim.blankState();   // (texels past the last cell keep a blank state's values)
      unpackCells(header.dims, (x, y, z) => cellTexel(g, x, y, z), cells, [A, B]);
      fill = () => sim.load(A, B);
    }
    if (header.world) {
      if (!win) throw new Error('a world save, but no world is loaded');
      const store = sections.get('worldStore'), planted = sections.get('worldPlanted');
      if (!store || !planted) throw new Error('this world save has no world edits');
      win.loadSaved(header.world.origin, fill, store, planted, sections.get('worldInteractions'), sections.get('worldNativeStore'));
    } else fill();
    // (An old save's V1 photon and neutron list, its `rays` section, is not read: those particles lived
    // a fraction of a second, and V2's own flying matter comes back with physicsV2Dynamics.)
    // Intentional (decided under the user's delegation, 2026-10-22): V1's in-flight photons and
    // neutrons in a pre-cutover save are dropped on load; the cells they would have hit are kept.
    // The step counter isn't saved: storms and the cloud deck time themselves by it, and it only runs forward.
    const saved = sections.get('settings');
    if (saved) {
      for (const k of savedSettingKeys()) if (k in saved) settings[k] = saved[k];
      app.onSettings();
    }
    await applySections(sections, header);
    app.finish(header);
    return header;
  }

  return { capture, apply };
}

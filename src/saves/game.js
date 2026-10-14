import { encodeSave, decodeSave, packCells, unpackCells } from './format.js';
import { collectSections, applySections, validateSections, savedSettingKeys } from './sections.js';
import { cellTexel } from '../sim.js';
import { RAYS } from '../rays.js';

// Saving and loading the game (format.js has the file, sections.js what
// features add). A save holds:
//   cells     every cell of the grid, exactly: state A (id, °C, life, ctype +
//             seed) and B (velocity, pressure), shuffled into byte planes
//             (format.js packCells). What derives from them (activity flags,
//             render fields, bricks, GI) is rebuilt on load, as after any load.
//   rays      the fast-particle list (raysLayer.js: its four vec4s a particle,
//             as the WebGL build's four attachments, one after the other) and
//             where its brush writes next, while any are flying
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
const RAY_LISTS = 4;                  // the particle's vec4s (shaders/rays.js Particle; the WebGL build's attachments)
const RAY_SLOTS = RAYS.RAY_TEX * RAYS.RAY_TEX;

export class SaveRefused extends Error {}

export function createSaves(app) {
  const { settings } = app;

  // Capture the game now: resolves to the save's bytes. name: the save's name.
  async function capture(name) {
    const sim = app.getSim(), win = app.getWin();
    if (win) {
      if (!win.loaded) throw new SaveRefused('The world is still loading: try again in a moment');
      // a slab that left the window is still on its way into the store: wait for it
      while (win.pending) await win.pending.catch(() => {});
      if (sim !== app.getSim()) throw new SaveRefused('The map changed while saving');
    }
    // the conversion to the atlas order and the particles' kernels, built before the moment
    await Promise.all([sim.prepare('toAtlas'), sim.rays.prepare?.()]);
    // Interaction readbacks or streaming can begin during preparation too.
    while (win?.pending) await win.pending.catch(() => {});
    if (sim !== app.getSim() || sim.disposed) throw new SaveRefused('The map changed while saving');
    // ---- from here to the readbacks, one task: everything below is the same moment ----
    const g = sim.g;
    const reads = [sim.readState()];
    let rays = null;
    const raysCursor = sim.rays.cursor ?? 0;   // (where the particle brush writes next)
    if (sim.rays.active) rays = sim.rays.readList();
    const scene = app.header(), thumbnail = app.thumbnail?.() ?? null;
    const header = {
      name, created: new Date().toISOString(), ...scene,
      dims: [g.nx, g.ny, g.nz],
      world: win ? { ...scene.world, size: [...win.size], origin: [sim.origin.x, sim.origin.y, sim.origin.z] } : null,
    };
    const core = [
      { key: 'settings', data: Object.fromEntries(savedSettingKeys().filter((k) => k in settings).map((k) => [k, settings[k]])) },
    ];
    if (win) core.push({ key: 'worldStore', data: win.store.toBytes() }, { key: 'worldPlanted', data: win.planted.slice() });
    if (win?.scene.interactionState) core.push({ key: 'worldInteractions', data: win.scene.interactionState.snapshot() });
    const extra = collectSections();
    // ---- (the moment ends) ----
    const [[A, B], list, extras] = await Promise.all([reads[0], rays, extra]);
    header.thumbnail = await thumbnail;
    const cells = packCells(header.dims, (x, y, z) => cellTexel(g, x, y, z), [A, B]);
    const sections = [{ key: 'cells', data: cells }, ...core];
    if (list) {
      const data = new Float32Array(RAY_LISTS * RAY_SLOTS * CHANNELS);
      [list.l0, list.l1, list.l2, list.l3].forEach((l, i) => data.set(l, i * RAY_SLOTS * CHANNELS));
      sections.push({ key: 'rays', data }, { key: 'raysCursor', data: { cursor: raysCursor } });
    }
    sections.push(...extras);
    return encodeSave(header, sections);
  }

  // Load a save's bytes. Resolves to its header, or null if the app refused
  // (a guest; a world while playing together); throws on a broken file.
  async function apply(bytes) {
    const { header, sections } = await decodeSave(bytes);
    const cells = sections.get('cells');
    if (!cells || !Array.isArray(header.dims)) throw new Error('this save has no grid');
    await validateSections(sections, header);
    if (!await app.prepare(header)) return null;
    const sim = app.getSim(), win = app.getWin(), g = sim.g;
    if ([g.nx, g.ny, g.nz].some((n, i) => n !== header.dims[i])) throw new Error(`the save is ${header.dims.join('×')}, the grid ${g.nx}×${g.ny}×${g.nz}`);
    const [A, B] = sim.blankState();   // (texels past the last cell keep a blank state's values)
    unpackCells(header.dims, (x, y, z) => cellTexel(g, x, y, z), cells, [A, B]);
    if (header.world) {
      if (!win) throw new Error('a world save, but no world is loaded');
      const store = sections.get('worldStore'), planted = sections.get('worldPlanted');
      if (!store || !planted) throw new Error('this world save has no world edits');
      win.loadSaved(header.world.origin, () => sim.load(A, B), store, planted, sections.get('worldInteractions'));
    } else sim.load(A, B);
    // the particles in flight (sim.load let the old ones go). The step counter
    // isn't saved: storms and the cloud deck time themselves by it, and it only runs forward.
    const rays = sections.get('rays');
    if (rays?.length === RAY_LISTS * RAY_SLOTS * CHANNELS && sim.rays.writeList) {
      sim.rays.writeList(rays);
      sim.rays.cursor = (sections.get('raysCursor')?.cursor ?? 0) % RAY_SLOTS;
    }
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

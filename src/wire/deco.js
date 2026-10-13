// TPT's decoration layer (src/deco.js; docs/webgpu.md Sync log S3, U17): a
// colour painted onto matter that travels with it. Its tools, Ctrl+B, its
// save sections and the console's sim.decoColor. The layer is made on the
// first deco stroke (sim.ensureDeco); its save section reads the plane back
// without a stall, recorded in the save's moment (saves/sections.js).
import { decoView, prepareDeco, readDeco, uploadDeco, ensureDeco, DECO_BYTES, setDecoColor } from '../deco.js';
import { registerSaveSection } from '../saves/sections.js';
import { registerConsoleApi } from '../console/registry.js';
import { packCells, unpackCells } from '../saves/format.js';
import { BRICK_CELLS } from '../shaders/window.js';
import { cellTexel } from '../sim.js';

// The decoration layer (src/deco.js) goes with its save, as TPT saves deco with
// each particle: RGBA8 per cell in the save's cell order (format.js packCells),
// and a World's painted bricks outside the window as [brick key u32, its
// bytes] records. Both load after the cells, since Simulation.load wipes the paint.
const DECO_KEY_BYTES = 4;
const BYTE = 256;

const deco = {
  name: 'deco',
  ready: true,

  boot(app) {
    registerSaveSection('deco', {
      // (the read is recorded now, the save's moment; null while nothing is painted)
      save: () => {
        const sim = app.sim, read = readDeco(sim);
        if (!read) return undefined;
        const g = sim.g;
        return read.then((data) => (data ? packCells([g.nx, g.ny, g.nz], (x, y, z) => cellTexel(g, x, y, z), [data]) : undefined));
      },
      load: (planes, h) => {
        const g = app.sim.g, data = new Uint8Array(g.width * g.height * DECO_BYTES);
        unpackCells(h.dims, (x, y, z) => cellTexel(g, x, y, z), planes, [data]);
        uploadDeco(app.sim, data);
      },
    });
    registerSaveSection('decoStore', {
      save: () => {
        const store = app.sim.deco?.store;
        if (!store?.size) return undefined;
        const rec = DECO_KEY_BYTES + store.values().next().value.length;
        const out = new Uint8Array(store.size * rec), view = new DataView(out.buffer);
        let at = 0;
        for (const [k, b] of store) { view.setUint32(at, k, true); out.set(b, at + DECO_KEY_BYTES); at += rec; }
        return out;
      },
      load: (bytes) => {
        const store = ensureDeco(app.sim).store, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const rec = DECO_KEY_BYTES + BRICK_CELLS * DECO_BYTES;
        for (let at = 0; at + rec <= bytes.length; at += rec) store.set(view.getUint32(at, true), bytes.slice(at + DECO_KEY_BYTES, at + rec));
      },
    });
    // TPT's sim.decoColor: the deco tools' colour, read as a packed 0xAARRGGBB, set
    // packed or as r, g, b[, a] (0-255).
    registerConsoleApi('sim', 'decoColor', function (r, g, b, a) {
      if (r !== undefined && r !== null) {
        const rgba = g === undefined || g === null
          ? [(r >>> 16) & 0xff, (r >>> 8) & 0xff, r & 0xff, (r >>> 24) & 0xff]
          : [r, g, b ?? 0, a ?? BYTE - 1];
        setDecoColor(rgba);
        app.dock.sync();
      }
      const [cr, cg, cb, ca] = decoView.color;
      return ((ca * BYTE + cr) * BYTE + cg) * BYTE + cb;
    }, { args: '[packed | r, g, b[, a]]', doc: 'The deco tools\' colour, as 0xAARRGGBB.', writes: false });
  },
  // the layer is made on the first deco stroke (sim.ensureDeco)
  attach(app) { app.sim.decoFactory = (sim) => ensureDeco(sim); },

  // a deco tool was picked: its passes compile while the colour is picked (src/deco.js)
  prepare(app) { prepareDeco(app.sim); },
  // TPT's Ctrl+B (src/gui/game/GameView.cpp): draw decoration or not. The paint
  // stays either way (src/deco.js); off, everything draws as if undecorated.
  toggle(app) {
    decoView.show = !decoView.show;
    app.dock.sync();
    app.requestRender();
    app.hud.toast(decoView.show ? 'Decoration shown' : 'Decoration hidden');
  },
};

export default deco;

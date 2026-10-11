import * as THREE from 'three';
import { quadVert, BRICK } from './shaders/common.js';
import { flowShiftFrag, BRICK_CELLS } from './shaders/window.js';
import {
  decoGatherFrag, decoScrubFrag, decoPaintFrag, decoUndoFrag, decoCopyFrag, decoStageFrag, decoEditFrag, decoViewPackFrag, STAGE_W,
} from './shaders/deco.js';
import { DECO_ID0 } from './elements.js';
import { compileInBackground } from './gfx/programs.js';

// The Powder Toy's decoration layer ("deco"): a colour painted onto matter
// that travels with it. TPT keeps it per particle (dcolour, 0xAARRGGBB:
// src/simulation/Particle.h), paints it with the deco tools
// (src/gui/game/tool/DecorationTool.cpp → Simulation::ApplyDecoration*,
// src/simulation/Editing.cpp) and blends it over the element's colour by its
// alpha when drawing (src/graphics/Renderer.cpp), unless decoration display is
// off (Ctrl+B, src/gui/game/GameView.cpp).
//
// Storage: a third texture beside the state, RGBA8 in the state's atlas
// layout, ping-ponged like it (shaders/deco.js has the rules). The state's two
// RGBA32F textures have no spare bits (A's w already packs ctype and the
// cell's seed into one float), and the move pass's gather is the hottest pass
// there is, so the decoration rides in its own pass after the gather, reading
// the same slots: nothing is added to the move, react or any other step pass.
// It exists from the first deco stroke (or a load that brings decoration) and
// costs nothing until then: no textures, no programs, no pass. Once there, a
// step adds one full-screen pass (a slot, a state texel and a deco texel per
// moving cell; one quiet-map texel and a state texel per resting one), and an
// idle world, which skips its steps, skips it too. Anything that replaces the
// whole state (a load, a new world) clears it and switches it off again.
//
// It survives what the state survives:
//   - undo: each snapshot carries a copy of it (Simulation.snapshot / undo);
//   - the World's window: it moves with the cells on a shift, the slab that
//     leaves is read back into a store of its own (decorated bricks only, 256
//     bytes each) and comes back when the window returns (leave, enter);
//   - stamps and the brush: a cell they give a new element loses its paint,
//     as TPT's create_part resets it (scrub); everything else keeps it.
// Multiplayer v1: the host's state stream doesn't carry it, so guests see no
// decoration and can't paint it (app.js).

// The deco tools (elements.js DECO_TOOLS) in TPT's mode order (shaders/deco.js DECO_MODE).
const modeOf = (tool) => DECO_ID0 - tool;
export const DECO_BYTES = 4;   // RGBA8 per cell
// TPT's default decoration colour, (200, 100, 50) opaque
// (src/gui/game/GameModel.cpp, prefs Decoration.Red/Green/Blue/Alpha).
const DECO_DEFAULT = [200, 100, 50, 255];
const BYTE_MAX = 255;
const STORE_KEY = 'powder-toy-3d:deco';   // the picker's colour (TPT keeps it in its prefs too)

// The picker's colour (sRGB 0..255 and alpha) and whether decoration is drawn.
export const decoView = { show: true, color: [...DECO_DEFAULT] };
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  if (Array.isArray(saved) && saved.length === DECO_BYTES && saved.every((v) => Number.isInteger(v) && v >= 0 && v <= BYTE_MAX)) decoView.color = saved;
} catch { /* storage unavailable */ }
export function setDecoColor(rgba) {
  decoView.color = rgba.map((v) => Math.max(0, Math.min(BYTE_MAX, Math.round(v))));
  try { localStorage.setItem(STORE_KEY, JSON.stringify(decoView.color)); } catch { /* storage unavailable */ }
}
// Is sim's decoration drawn (display on, and anything decorated)?
export const decoShown = (sim) => !!sim.deco?.active && decoView.show;

const rawMat = (frag, uniforms, name) => Object.assign(new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3, vertexShader: quadVert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
}), { name });
const target = (w, h) => new THREE.WebGLRenderTarget(w, h, {
  type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
});
const dataTexture = (data, w, h, format, type) => {
  const t = new THREE.DataTexture(data, w, h, format, type);
  t.needsUpdate = true;
  return t;
};

class Deco {
  constructor(sim) {
    this.sim = sim;
    const g = sim.g;
    this.copies = [target(g.width, g.height), target(g.width, g.height)];
    this.cur = 0;
    this.active = false;   // the texture may hold decoration (else it is all 0 and nothing runs)
    this.mats = {};        // made on first use: a pass that never runs never compiles
    this.store = new Map();   // the World's decorated bricks outside the window, by world brick key (leave)
    this.pending = null;      // the leaving slab's readback (world/window.js waits for it)
    this.epoch = 0;           // bumped by reset: a readback of what was before lands nowhere
    this.clearTargets();
  }

  get texture() { return this.copies[this.cur].texture; }

  // The view's flow field (gfx/uniforms.js tFlowV) with the paint packed into
  // its spare w (shaders/gfx/deco.js says why), rebuilt when either changed:
  // a step, a paint, a load or a window move.
  viewFlow() {
    const sim = this.sim, key = `${sim.frame}|${sim.paints}|${sim.version}|${this.cur}|${this.epoch}`;
    if (key !== this.viewKey) {
      this.viewTarget ??= new THREE.WebGLRenderTarget(sim.g.width, sim.g.height, {
        type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      });
      const m = this.mat('viewPack', decoViewPackFrag(), { tFlow: { value: null } });
      m.uniforms.tDeco.value = this.texture;
      m.uniforms.tFlow.value = sim.flowTexture;
      const keep = sim.renderer.getRenderTarget();
      sim.run(m, this.viewTarget);
      sim.renderer.setRenderTarget(keep);
      this.viewKey = key;
    }
    return this.viewTarget.texture;
  }

  mat(key, frag, uniforms) {
    return (this.mats[key] ??= rawMat(frag, { tDeco: { value: null }, ...uniforms }, `deco${key[0].toUpperCase()}${key.slice(1)}`));
  }

  // Draw mat from the current copy into the other, which becomes current.
  write(mat) {
    mat.uniforms.tDeco.value = this.texture;
    this.sim.run(mat, this.copies[1 - this.cur]);
    this.cur = 1 - this.cur;
  }

  clearTargets() {
    const r = this.sim.renderer, keep = r.getRenderTarget(), color = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of this.copies) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setClearColor(color, alpha);
    r.setRenderTarget(keep);
  }

  // the passes a painting session runs: made (and compiled ahead, prepareDeco) on first use
  gatherMat() {
    return this.mat('gather', decoGatherFrag(this.sim.g), {
      tA: { value: null }, tQuiet: { value: null }, tSlots: { value: null }, uParity: { value: 0 }, uEdge: { value: 0 },
    });
  }
  paintMat() {
    return this.mat('paint', decoPaintFrag(this.sim.g), {
      tA: { value: null }, uCenter: { value: new THREE.Vector3() }, uRadius: { value: 1 }, uShape: { value: 0 },
      uMode: { value: 0 }, uColor: { value: new THREE.Vector4() },
    });
  }
  scrubMat() { return this.mat('scrub', decoScrubFrag(this.sim.g), { tA: { value: null }, tPrevA: { value: null } }); }

  // A step, after the move's gather (Simulation.step): the decoration follows the cells.
  step() {
    if (!this.active) return;
    const sim = this.sim;
    const m = this.gatherMat();
    m.uniforms.tA.value = sim.stateA;
    m.uniforms.tQuiet.value = sim.actQuiet.texture;
    m.uniforms.tSlots.value = sim.slots.texture;
    m.uniforms.uParity.value = sim.frame & 1;
    m.uniforms.uEdge.value = sim.mats.moveGather.uniforms.uEdge.value;   // the gather's edge mode (simModes.js)
    this.write(m);
  }

  // A deco tool's brush stroke (Simulation.paint).
  paint({ center, radius, shape, tool }) {
    const sim = this.sim;
    const u = this.paintMat().uniforms;
    u.tA.value = sim.stateA;
    u.uCenter.value.copy(center);
    u.uRadius.value = radius;
    u.uShape.value = shape;
    u.uMode.value = modeOf(tool);
    u.uColor.value.fromArray(decoView.color).divideScalar(BYTE_MAX);
    this.active = true;
    this.write(this.paintMat());
    sim.version++;   // the picture changed (gfx/pacing.js redraws on it)
  }

  // After a write to the state that isn't a step, whose state A before it was
  // prevA: cells it gave a new element, or emptied, lose their decoration.
  scrub(prevA) {
    if (!this.active) return;
    const m = this.scrubMat();
    m.uniforms.tA.value = this.sim.stateA;
    m.uniforms.tPrevA.value = prevA;
    this.write(m);
  }

  // The window moved by (dx, 0, dz) grid cells (Simulation.shift): the
  // decoration moves with the cells; the slab uncovered starts undecorated.
  shift(dx, dz) {
    if (!this.active) return;
    const m = this.mat('shift', flowShiftFrag(this.sim.g), { tFlowSrc: { value: null }, uShift: { value: new THREE.Vector3() } });
    m.uniforms.tFlowSrc.value = this.texture;
    m.uniforms.uShift.value.set(dx, 0, dz);
    this.write(m);
  }

  // Undo snapshots (Simulation.snapshot, undo): t carries a copy (t.deco), or
  // none if nothing was decorated when it was taken.
  snapshot(t) {
    if (!this.active) { t.deco = null; return; }
    if (!t.decoTarget) {
      t.decoTarget = target(this.sim.g.width, this.sim.g.height);
      const dispose = t.dispose.bind(t);
      t.dispose = () => { dispose(); t.decoTarget.dispose(); };
    }
    const m = this.mat('copy', decoCopyFrag(), { tSrc: { value: null } });
    m.uniforms.tSrc.value = this.texture;
    this.sim.run(m, t.decoTarget);
    t.deco = t.decoTarget;
  }

  // Bring snapshot t's decoration back, (dx, dz) being the grid cells the
  // window moved since it was taken: the cells it holds take its decoration
  // (none, if it has none); the rest keep theirs.
  restore(t, dx, dz) {
    if (!t.deco && !this.active) return;
    const m = this.mat('undo', decoUndoFrag(this.sim.g), {
      tSnap: { value: null }, uShift: { value: new THREE.Vector3() }, uBlank: { value: false },
    });
    m.uniforms.tSnap.value = t.deco?.texture ?? this.texture;
    m.uniforms.uBlank.value = !t.deco;
    m.uniforms.uShift.value.set(dx, 0, dz);
    this.write(m);
    this.active = true;
  }

  // Everything goes (a new state replaced the old: Simulation.load, a new world).
  reset() {
    if (!this.active && !this.store.size && !this.pending) return;
    this.clearTargets();
    this.store.clear();
    this.epoch++;
    this.active = false;
  }

  // ---- the World's window (world/window.js) ----
  // The slab of grid cells [lo, lo + 4·bricks) is about to leave: read its
  // decoration back, and keep each brick with any (key(slab brick x, y, z)
  // gives its world key) in the store, dropping the ones without.
  leave(lo, bricks, key) {
    if (!this.active) return;
    const sim = this.sim, r = sim.renderer;
    const n = bricks[0] * bricks[1] * bricks[2], rows = Math.ceil(n * BRICK_CELLS / STAGE_W);
    if (!this.stage || this.stage.height < rows) {
      this.stage?.dispose();
      this.stage = target(STAGE_W, rows);
    }
    const m = this.mat('stage', decoStageFrag(sim.g), { uLo: { value: new THREE.Vector3() }, uBricks: { value: new THREE.Vector3() } });
    m.uniforms.tDeco.value = this.texture;
    m.uniforms.uLo.value.set(...lo);
    m.uniforms.uBricks.value.set(...bricks);
    sim.run(m, this.stage);
    const buf = new Uint8Array(STAGE_W * rows * DECO_BYTES), brickBytes = BRICK_CELLS * DECO_BYTES;
    const keys = [], epoch = this.epoch;
    for (let i = 0; i < n; i++) keys.push(key(i % bricks[0], Math.floor(i / bricks[0]) % bricks[1], Math.floor(i / (bricks[0] * bricks[1]))));
    this.pending = r.readRenderTargetPixelsAsync(this.stage, 0, 0, STAGE_W, rows, buf).then(() => {
      if (epoch !== this.epoch) return;
      keys.forEach((k, i) => {
        const b = buf.subarray(i * brickBytes, (i + 1) * brickBytes);
        if (b.some((v) => v)) this.store.set(k, b.slice());
        else this.store.delete(k);
      });
    }).catch((err) => {
      console.error('deco: a leaving slab could not be read back; its decoration is lost', err);
    }).finally(() => { this.pending = null; });
  }

  // The slab of grid cells [lo, lo + 4·bricks) was uncovered: its stored
  // bricks come back (key as in leave), and leave the store.
  enter(lo, bricks, key) {
    if (!this.store.size) return;
    const sim = this.sim, g = sim.g;
    const slots = [];
    for (let bz = 0; bz < bricks[2]; bz++)
      for (let by = 0; by < bricks[1]; by++)
        for (let bx = 0; bx < bricks[0]; bx++) {
          const k = key(bx, by, bz);
          if (this.store.has(k)) slots.push([lo[0] / BRICK + bx, lo[1] / BRICK + by, lo[2] / BRICK + bz, k]);
        }
    if (!slots.length) return;
    const rows = Math.ceil(slots.length * BRICK_CELLS / STAGE_W), brickBytes = BRICK_CELLS * DECO_BYTES;
    const data = new Uint8Array(STAGE_W * rows * DECO_BYTES);
    const idx = new Float32Array(g.bwidth * g.bheight);
    const BX = g.nx / BRICK, BZ = g.nz / BRICK;
    slots.forEach(([bx, by, bz, k], s) => {
      data.set(this.store.get(k), s * brickBytes);
      this.store.delete(k);
      // brick (bx, by, bz)'s texel in the brick-resolution targets (sim.js brickTexel)
      idx[(Math.floor(by / g.btx) * BZ + bz) * g.bwidth + (by % g.btx) * BX + bx] = s + 1;
    });
    const texIdx = dataTexture(idx, g.bwidth, g.bheight, THREE.RedFormat, THREE.FloatType);
    const texD = dataTexture(data, STAGE_W, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    const m = this.mat('edit', decoEditFrag(g), { tEditIdx: { value: null }, tEditD: { value: null } });
    m.uniforms.tEditIdx.value = texIdx;
    m.uniforms.tEditD.value = texD;
    try { this.write(m); } finally { texIdx.dispose(); texD.dispose(); }
    this.active = true;
  }

  // ---- saves (src/deco.js readDeco / uploadDeco) ----
  read() {
    const { width, height } = this.sim.g;
    const data = new Uint8Array(width * height * DECO_BYTES);
    this.sim.renderer.readRenderTargetPixels(this.copies[this.cur], 0, 0, width, height, data);
    return data;
  }

  upload(data) {
    const { width, height } = this.sim.g;
    const tex = dataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    const m = this.mat('copy', decoCopyFrag(), { tSrc: { value: null } });
    m.uniforms.tSrc.value = tex;
    try { this.sim.run(m, this.copies[1 - this.cur]); } finally { tex.dispose(); }
    this.cur = 1 - this.cur;
    this.active = data.some((v) => v);
    this.sim.version++;
  }

  materials() { return Object.values(this.mats); }

  // (its materials go with Simulation.materials(), which disposes or retires them)
  dispose() {
    this.copies.forEach((t) => t.dispose());
    this.viewTarget?.dispose();
    this.stage?.dispose();
  }
}

// sim's decoration layer, made the first time it is needed.
export const ensureDeco = (sim) => (sim.deco ??= new Deco(sim));
// A deco tool was picked: make the layer (still switched off: nothing runs
// until the first stroke) and compile its passes in the background, so the
// first stroke doesn't stall on them.
export function prepareDeco(sim) {
  if (sim.deco) return;
  const d = ensureDeco(sim);
  compileInBackground(sim.renderer, [d.gatherMat(), d.paintMat(), d.scrubMat()]).catch(() => { /* compiled on first use instead */ });
}

// For saves (a save section's save and load): the decoration as RGBA8 per
// state-atlas texel (sim.cellTexel(x, y, z) * 4 is a cell's sRGB colour and
// alpha), or null if nothing is decorated; and the same back into sim (after
// its state is loaded: Simulation.load clears the decoration). A World's
// decorated bricks outside the window are sim.deco.store (world brick key →
// 256 bytes, its 64 cells in the slab order of shaders/window.js).
export function readDeco(sim) {
  return sim.deco?.active ? sim.deco.read() : null;
}
export function uploadDeco(sim, data) {
  const { width, height } = sim.g;
  if (!data || data.length !== width * height * DECO_BYTES) return false;
  ensureDeco(sim).upload(data);
  return true;
}

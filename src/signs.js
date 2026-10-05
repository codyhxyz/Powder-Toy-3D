import * as THREE from 'three';
import { quadVert } from './shaders/common.js';
import { signProbeFrag, MAX_SIGNS } from './shaders/probe.js';
import { ELEMENTS } from './elements.js';
import './signs.css';

// Text signs pinned to voxel faces, like The Powder Toy's signs but in 3D.
//
// Each sign is an HTML plate floating above its anchor (the centre of the clicked
// face), joined to it by a 1px stem and a dot. Labels are positioned with our own
// projection every frame. A tiny GPU pass (one fragment per sign) marches a DDA
// ray from the camera to every anchor to find out whether voxels hide it, and
// reads the attached cell's state for the live placeholders {t} {p} {e}. That
// pass runs at most every PROBE_MS and is read back asynchronously.

const MAX_CHARS = 80;
const PROBE_MS = 100;
const REF_DIST = 18;          // world units at which labels are drawn at 100%
const SCALE_MIN = 0.85, SCALE_MAX = 1.3;
const OCCLUDED_BELOW = 0.5;   // transmittance under which a sign counts as hidden
const PLACEHOLDER = /\{([tpe])\}/gi;

// Pick result face (axis * 2 + (normal negative ? 1 : 0)) -> integer normal.
export function faceNormal(face, out = new THREE.Vector3()) {
  const axis = Math.floor(face / 2);
  out.set(0, 0, 0).setComponent(axis, face % 2 === 0 ? 1 : -1);
  return out;
}

const fmt = {
  t: (d) => `${d.T.toFixed(1)}°C`,
  p: (d) => (Math.abs(d.P) < 0.005 ? 0 : d.P).toFixed(2),
  e: (d) => ELEMENTS[d.id]?.name ?? '–',
};

let nextId = 1;

export class Signs {
  constructor({ renderer, camera, container, getSim, getVolume, onChange = () => {} }) {
    this.renderer = renderer;
    this.camera = camera;
    this.container = container;
    this.getSim = getSim;
    this.getVolume = getVolume;
    this.onChange = onChange;
    this.list = [];
    this.visible = true;
    this.probeInterval = PROBE_MS;
    // backdrop blur costs ~0.3 ms per plate in the compositor; drop it when crowded
    this.blurLimit = 8;
    this.stats = { probes: 0, lastProbeMs: 0 }; // lastProbeMs = dispatch → data latency

    this.layer = document.createElement('div');
    this.layer.className = 'tpt-signs';
    container.appendChild(this.layer);

    // sign data for the probe: row 0 anchors, row 1 sample cells
    this.signData = new Float32Array(MAX_SIGNS * 2 * 4);
    this.signTex = new THREE.DataTexture(this.signData, MAX_SIGNS, 2, THREE.RGBAFormat, THREE.FloatType);
    this.signTex.needsUpdate = true;
    this.probeTarget = new THREE.WebGLRenderTarget(MAX_SIGNS, 1, {
      type: THREE.FloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.probeBuf = new Float32Array(MAX_SIGNS * 4);
    this.probeMat = null;
    this.gridKey = '';
    this.pending = false;
    this.lastProbe = -1e9;
    this.generation = 0;   // bumps on rebuild/clear so stale readbacks are dropped
    this.dataDirty = true;

    this._edit = null;     // sign whose input is focused
    this._v = new THREE.Vector3();
    this._camGrid = new THREE.Vector3();
    this._inv = new THREE.Matrix4();

    // add()/edit() may be called from a pointerdown handler (the app's sign tool). The
    // browser then moves focus on the following mousedown, which would blur the new
    // input at once, so focusing waits for that pointer to come back up.
    this._buttons = 0;
    this._onDown = (e) => { this._buttons = e.buttons || 1; };
    this._onUp = (e) => {
      if (e.type === 'pointermove' && !this._buttons) return;
      this._buttons = e.buttons || 0;
      const s = this._focusPending;
      if (!this._buttons && s) { this._focusPending = null; if (s === this._edit) this._focusInput(s); }
    };
    this._ptrEvents = [['pointerdown', this._onDown], ['pointerup', this._onUp], ['pointercancel', this._onUp], ['pointermove', this._onUp]];
    for (const [t, f] of this._ptrEvents) addEventListener(t, f, true);

    // keep each plate centred over its stem with whole-pixel offsets (crisp text)
    this.ro = new ResizeObserver((entries) => {
      for (const en of entries) {
        const box = en.borderBoxSize?.[0];
        const w = box ? box.inlineSize : en.target.offsetWidth;
        en.target.style.left = `${-Math.round(w / 2)}px`;
        en.target._h = box ? box.blockSize : en.target.offsetHeight;
      }
    });
  }

  // ---------------------------------------------------------------- public API

  get editing() { return this._edit !== null; }

  add({ cell, normal, text = '', edit = true }) {
    if (this.list.length >= MAX_SIGNS) {
      console.warn(`Signs: limit of ${MAX_SIGNS} reached`);
      return null;
    }
    const c = new THREE.Vector3(Math.round(cell.x), Math.round(cell.y), Math.round(cell.z));
    const n = new THREE.Vector3(Math.sign(Math.round(normal.x)), Math.sign(Math.round(normal.y)), Math.sign(Math.round(normal.z)));
    if (n.lengthSq() !== 1) n.set(0, 1, 0);
    const sign = {
      id: nextId++,
      cell: c,
      normal: n,
      text: clean(text),
      anchor: c.clone().addScalar(0.5).addScaledVector(n, 0.5),
      live: null,      // { id, T, P, transmittance } once the probe has run
      occluded: false,
      isNew: edit,
    };
    this._buildDom(sign);
    this.list.push(sign);
    this.dataDirty = true;
    this._renderText(sign);
    this._place(sign, this._frameInfo());
    this.onChange(this.list);
    if (edit) this.edit(sign);
    return sign;
  }

  // Open a sign's text input.
  edit(sign) {
    if (!sign || !this.list.includes(sign)) return;
    if (this._edit && this._edit !== sign) this._commit(this._edit);
    const d = sign.dom;
    this._edit = sign;
    sign.before = sign.text;
    d.root.classList.add('is-editing');
    d.input.value = sign.text;
    d.edit.dataset.value = sign.text;
    if (this._buttons) this._focusPending = sign;
    else this._focusInput(sign);
  }

  _focusInput(sign) {
    const input = sign.dom.input;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }

  remove(sign) {
    const i = this.list.indexOf(sign);
    if (i < 0) return;
    if (this._edit === sign) this._edit = null;
    this.list.splice(i, 1);
    this.ro.unobserve(sign.dom.plate);
    sign.dom.root.remove();
    this.dataDirty = true;
    this.onChange(this.list);
  }

  clear() {
    const had = this.list.length > 0;
    this._edit = null;
    for (const s of this.list) { this.ro.unobserve(s.dom.plate); s.dom.root.remove(); }
    this.list = [];
    this.dataDirty = true;
    this.generation++;
    if (had) this.onChange(this.list);
  }

  // The sim/volume were recreated: recompile the probe for the new grid layout.
  rebuild() {
    this.generation++;
    this.probeMat?.dispose();
    this.probeMat = null;
    this.gridKey = '';
    this.dataDirty = true;
  }

  setVisible(v) {
    this.visible = !!v;
    this.layer.style.display = this.visible ? '' : 'none';
    if (!this.visible && this._edit) this._commit(this._edit);
  }

  toJSON() {
    return this.list.map((s) => ({ cell: s.cell.toArray(), normal: s.normal.toArray(), text: s.text }));
  }

  fromJSON(arr) {
    const notify = this.onChange;
    this.onChange = () => {};
    try {
      this.clear();
      const v = (a) => (Array.isArray(a) ? new THREE.Vector3().fromArray(a) : new THREE.Vector3(a.x, a.y, a.z));
      for (const o of arr || []) {
        if (!o?.cell || !o?.normal || !clean(o.text)) continue;
        if (!this.add({ cell: v(o.cell), normal: v(o.normal), text: o.text, edit: false })) break;
      }
    } finally {
      this.onChange = notify;
    }
    this.onChange(this.list);
  }

  // Call every frame after the main render.
  update() {
    const sim = this.getSim();
    const volume = this.getVolume();
    if (!sim || !volume || !this.visible || this.list.length === 0) return;
    this._ensureProbe(sim);
    const info = this._frameInfo();
    let shown = 0;
    for (const s of this.list) shown += this._place(s, info) ? 1 : 0;
    const crowded = shown > this.blurLimit;
    if (crowded !== this._crowded) { this.layer.classList.toggle('is-crowded', crowded); this._crowded = crowded; }
    if (!this.pending && info.now - this.lastProbe >= this.probeInterval) this._probe(sim, info);
  }

  dispose() {
    for (const [t, f] of this._ptrEvents) removeEventListener(t, f, true);
    this.clear();
    this.ro.disconnect();
    this.layer.remove();
    this.probeMat?.dispose();
    this.probeTarget.dispose();
    this.signTex.dispose();
    this.disposed = true;
  }

  // ------------------------------------------------------------------ probe

  _ensureProbe(sim) {
    const g = sim.g;
    const key = `${g.nx}x${g.ny}x${g.nz}`;
    if (this.probeMat && key === this.gridKey) return;
    if (this.probeMat) this.rebuild();
    this.gridKey = key;
    this.probeMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: quadVert,
      fragmentShader: signProbeFrag(g),
      uniforms: {
        tA: { value: null }, tB: { value: null }, tBrick: { value: null }, tSigns: { value: this.signTex },
        uCam: { value: new THREE.Vector3() }, uCount: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
  }

  _uploadSigns(g) {
    const d = this.signData;
    d.fill(0);
    const row = MAX_SIGNS * 4;
    this.list.forEach((s, i) => {
      d.set([s.anchor.x, s.anchor.y, s.anchor.z, 1], i * 4);
      // floor signs (and anything else outside the grid) read the cell in front of the face
      const c = s.cell.clone();
      if (c.x < 0 || c.y < 0 || c.z < 0 || c.x >= g.nx || c.y >= g.ny || c.z >= g.nz) c.add(s.normal);
      d.set([c.x, c.y, c.z, 0], row + i * 4);
    });
    this.signTex.needsUpdate = true;
    this.dataDirty = false;
  }

  _probe(sim, info) {
    if (this.dataDirty) this._uploadSigns(sim.g);
    const n = this.list.length;
    const u = this.probeMat.uniforms;
    u.tA.value = sim.stateA;
    u.tB.value = sim.stateB;
    u.tBrick.value = sim.brick.texture;
    u.uCam.value.copy(info.camGrid);
    u.uCount.value = n;

    const prev = this.renderer.getRenderTarget();
    sim.run(this.probeMat, this.probeTarget);
    this.renderer.setRenderTarget(prev);

    const batch = this.list.slice();
    const gen = this.generation;
    const buf = this.probeBuf.subarray(0, n * 4);
    const t0 = info.now;
    this.pending = true;
    this.lastProbe = info.now;
    this.stats.probes++;
    this.renderer.readRenderTargetPixelsAsync(this.probeTarget, 0, 0, n, 1, buf).then(() => {
      this.pending = false;
      if (this.disposed || gen !== this.generation) return;
      this.stats.lastProbeMs = performance.now() - t0;
      batch.forEach((s, i) => {
        if (!this.list.includes(s)) return;
        const o = i * 4;
        s.live = { transmittance: buf[o], id: Math.round(buf[o + 1]), T: buf[o + 2], P: buf[o + 3] };
        s.occluded = buf[o] < OCCLUDED_BELOW;
        this._renderValues(s);
      });
    }).catch(() => { this.pending = false; });
  }

  // ------------------------------------------------------------ placement

  _frameInfo() {
    const volume = this.getVolume();
    const cam = this.camera;
    const canvas = this.renderer.domElement.getBoundingClientRect();
    const host = this.layer.getBoundingClientRect();
    volume?.updateMatrixWorld();
    cam.updateMatrixWorld();
    const camWorld = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    if (volume) this._camGrid.copy(camWorld).applyMatrix4(this._inv.copy(volume.matrixWorld).invert());
    return {
      now: performance.now(),
      volume, camWorld, camGrid: this._camGrid,
      w: canvas.width, h: canvas.height,
      ox: canvas.left - host.left, oy: canvas.top - host.top,
    };
  }

  _place(s, info) {
    const d = s.dom;
    if (!info.volume) return false;
    const v = this._v.copy(s.anchor).applyMatrix4(info.volume.matrixWorld);
    const dist = v.distanceTo(info.camWorld);
    v.applyMatrix4(this.camera.matrixWorldInverse);
    let show = v.z < -this.camera.near;
    let x = 0, y = 0;
    if (show) {
      v.applyMatrix4(this.camera.projectionMatrix);
      x = Math.round(info.ox + (v.x * 0.5 + 0.5) * info.w);
      y = Math.round(info.oy + (-v.y * 0.5 + 0.5) * info.h);
      const m = 160;
      show = x > info.ox - m && x < info.ox + info.w + m && y > info.oy - 40 && y < info.oy + info.h + m;
    }
    if (s === this._edit) show = true; // never yank the input away mid-edit
    if (show !== d.shown) { d.root.style.display = show ? '' : 'none'; d.shown = show; }
    if (!show) return false;

    const tr = `translate(${x}px,${y}px)`;
    if (tr !== d.tr) { d.root.style.transform = tr; d.tr = tr; }
    const sc = Math.round(THREE.MathUtils.clamp(REF_DIST / Math.max(dist, 1e-3), SCALE_MIN, SCALE_MAX) * 20) / 20;
    if (sc !== d.sc) {
      d.stem = Math.round(22 * sc);
      d.root.style.setProperty('--s', sc);
      d.root.style.setProperty('--stem', `${d.stem}px`);
      d.sc = sc;
    }
    const occ = s.occluded && s !== this._edit;
    if (occ !== d.occ) { d.root.classList.toggle('is-occluded', occ); d.occ = occ; }
    // nearer signs on top, and every visible sign above every hidden one
    const z = String(Math.max(1, 100000 - Math.round(dist * 100) - (occ ? 50000 : 0)));
    if (z !== d.z) { d.root.style.zIndex = z; d.z = z; }
    // no room above (anchor near the top edge): hang the plate below the anchor
    const below = y - d.stem - (d.plate._h || 24) < info.oy + 4;
    if (below !== d.below) { d.root.classList.toggle('is-below', below); d.below = below; }
    return true;
  }

  // ------------------------------------------------------------------ DOM

  _buildDom(sign) {
    const root = el('div', 'tpt-sign');
    const dot = el('div', 'tpt-sign-dot');
    const stem = el('div', 'tpt-sign-stem');
    const plate = el('div', 'tpt-sign-plate');
    plate.tabIndex = 0;
    plate.setAttribute('role', 'note');
    const text = el('span', 'tpt-sign-text');
    const edit = el('span', 'tpt-sign-edit');
    const input = el('input');
    input.type = 'text';
    input.maxLength = MAX_CHARS;
    input.size = 1;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = 'Sign text';
    edit.appendChild(input);
    const hint = el('div', 'tpt-sign-hint');
    hint.textContent = '{t} temperature · {p} pressure · {e} element';
    const del = el('button', 'tpt-sign-del');
    del.type = 'button';
    del.tabIndex = -1;
    del.title = 'Delete sign';
    del.setAttribute('aria-label', 'Delete sign');
    del.innerHTML = '<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    plate.append(text, edit, hint, del);
    root.append(stem, dot, plate);
    this.layer.appendChild(root);
    this.ro.observe(plate);
    sign.dom = { root, plate, text, edit, input, del, vals: [], shown: true };

    // Labels must never paint into the sim. Orbit / pan buttons and the wheel are
    // handed to the canvas so the camera still works with the cursor over a label.
    plate.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        this.renderer.domElement.dispatchEvent(new PointerEvent('pointerdown', e));
      }
    });
    plate.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      // keep focus in the input while clicking around the plate during an edit
      if (sign === this._edit && e.target !== input) e.preventDefault();
    });
    plate.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.renderer.domElement.dispatchEvent(new WheelEvent('wheel', e));
    }, { passive: false });
    plate.addEventListener('contextmenu', (e) => e.preventDefault());
    plate.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.button === 0 && sign !== this._edit && !del.contains(e.target)) this.edit(sign);
    });
    plate.addEventListener('keydown', (e) => {
      if (e.target !== plate) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); this.remove(sign); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.edit(sign); }
      else if (e.key === 'Escape') { e.stopPropagation(); plate.blur(); }
    });
    del.addEventListener('mousedown', (e) => e.preventDefault());
    del.addEventListener('click', (e) => { e.stopPropagation(); this.remove(sign); });

    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the app's hotkeys never see typing
      if (e.key === 'Enter') { e.preventDefault(); this._commit(sign); }
      else if (e.key === 'Escape') { e.preventDefault(); this._cancel(sign); }
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('input', () => { edit.dataset.value = input.value; });
    input.addEventListener('blur', () => { if (sign === this._edit) this._commit(sign, false); });
  }

  _endEdit(sign) {
    if (this._edit === sign) this._edit = null;
    sign.dom.root.classList.remove('is-editing');
  }

  _commit(sign, blur = true) {
    if (this._edit !== sign) return;
    const text = clean(sign.dom.input.value);
    this._endEdit(sign);
    if (blur) sign.dom.input.blur();
    if (!text) { this.remove(sign); return; }
    const changed = text !== sign.text || sign.isNew;
    sign.text = text;
    sign.isNew = false;
    this._renderText(sign);
    if (changed) this.onChange(this.list);
  }

  _cancel(sign) {
    if (this._edit !== sign) return;
    this._endEdit(sign);
    if (sign.isNew && !sign.before) { this.remove(sign); return; }
    sign.isNew = false;
    sign.dom.plate.focus({ preventScroll: true }); // Delete / Backspace now removes it
  }

  // Split the text into static runs and live placeholder spans.
  _renderText(sign) {
    const d = sign.dom;
    d.text.textContent = '';
    d.vals = [];
    let last = 0;
    for (const m of sign.text.matchAll(PLACEHOLDER)) {
      if (m.index > last) d.text.append(sign.text.slice(last, m.index));
      const span = el('span', 'tpt-sign-val');
      d.text.appendChild(span);
      d.vals.push({ k: m[1].toLowerCase(), el: span, v: null });
      last = m.index + m[0].length;
    }
    if (last < sign.text.length) d.text.append(sign.text.slice(last));
    d.root.classList.toggle('is-live', d.vals.length > 0);
    this._renderValues(sign);
  }

  _renderValues(sign) {
    for (const v of sign.dom.vals) {
      const s = sign.live && sign.live.id >= 0 ? fmt[v.k](sign.live) : '–';
      if (s !== v.v) { v.el.textContent = s; v.v = s; }
    }
  }
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function clean(t) {
  return String(t ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_CHARS);
}

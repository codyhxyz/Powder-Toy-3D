import * as THREE from 'three';
import { quadVert, stateUniforms } from './shaders/common.js';
import { stampFrag } from './shaders/stamp.js';
import { ELEMENTS, BUILDS, isBuild } from './elements.js';
import { h } from './ui/dom.js';
import { ICON } from './ui/icons.js';
import { runGenerator, bake, newSeed, makeRng, turnPoint, MAX_FOOT } from './constructions/runtime.js';
import { BUILTINS, SHRINE_ALTARS } from './constructions/builtins.js';
import builtinsSource from './constructions/builtins.js?raw';
import { renderIso, hexBytes, cellNoise, PREVIEW_VIEWS } from './constructions/preview.js';
import { summarizeReport } from './constructions/lint.js';
import { execSandboxed } from './constructions/sandbox.js';
import { buildSystemPrompt, buildChatPrompt, extractCode, MAX_NAME_CHARS } from './ai/prompt.js';
import {
  PROVIDERS, loadSettings, saveSettings, current, isConfigured, createModel, listModels,
  startOpenRouterSignIn, finishOpenRouterSignIn,
} from './ai/providers.js';
import {
  accountsEnabled, accountState, account, aiQuota, signIn, signOut, onAccountChange,
  signInOptions, freeDaily, PRIVACY_URL,
} from './account.js';
import './constructions.css';

// Constructions: whole structures (houses, trees, ...) placed with one click.
//
// Unlike TPT's stamps these are generators, not saved snapshots: each one is a
// small program (constructions/runtime.js) built from a seed, a size (the brush
// size) and a variant, so no two trees come out the same. They are made of
// ordinary elements and behave like them: a cottage's wooden walls burn while
// its stone chimney carries the fireplace smoke away, an igloo melts.
//
// The PROMPT construction runs code written by a model (any provider the
// player brings a key for, via the Vercel AI SDK: see ai/providers.js), pasted
// from any chatbot, or imported from a file. That code only ever runs in a
// sandboxed worker and is linted for physics problems before it can be placed.
// The AI SDK and provider packages load only when a generation starts.
//
// A ghost of the exact model follows the cursor and turns its front (+z) to
// face the camera. Clicking uploads the model as a small 3D texture and one GPU
// pass (shaders/stamp.js) writes it into the grid, growing footings under its
// base where the ground falls away.

const STORE = 'powder-toy-3d:builds';
const MINE_STORE = 'powder-toy-3d:my-constructions';
const PROMPT = 'PROMPT';           // the BUILDS key of the AI / custom construction
const NEW = 'new';                 // PROMPT choice: write a new one
const AGENT_SEED = 1;              // the seed generated code is checked at
const PREVIEW_PX = 512;            // longest side of each picture sent to the model
const RESULT_CACHE = 16;           // sandbox results kept (per code, seed and size)
const FILE_FORMAT = 'powder-toy-3d/construction';
const FILE_VERSION = 1;
const SEED_SALT = 0x9e3779b9;      // decorrelates the shuffle pick from the generator's own rnd
const GHOST_ALPHA = 0.6;
const GHOST_SHADE_MIN = 0.92;      // ghost cubes vary in brightness from this
const GHOST_TEXTURE = 0.16;        // ... to this much brighter
const HOLD_PX = 6;                 // pointer travel that brings the ghost back after placing
const DOCK_MARGIN_PX = 14;         // the dock's gap to the bottom of the window
const BAR_GAP_PX = 8;              // gap between the dock and the construction bar
const IMPORT_NAME_CHARS = 60;
// Points of a built-in construction the app hangs things on once it's placed
// (local cells: y up, base on y = 0, front +z): the shrine's perk orbs.
const ANCHORS = { SHRINE: SHRINE_ALTARS };
const DRAFT_STORE = 'powder-toy-3d:ai-draft'; // sessionStorage: the prompt being typed, across a sign-in

const loadJSON = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
const saveJSON = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } };
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// the prompt _signIn kept for when the page comes back, once
function takeDraft() {
  try {
    const draft = sessionStorage.getItem(DRAFT_STORE) ?? '';
    sessionStorage.removeItem(DRAFT_STORE);
    return draft;
  } catch { return ''; }
}

// a signed-in player's picture, or their initial when there's none (or it won't load)
function avatar(user) {
  const initial = h('span.avatar.initial', { text: (user.name.trim()[0] ?? '?').toUpperCase(), 'aria-hidden': 'true' });
  if (!user.avatar) return initial;
  const img = h('img.avatar', { src: user.avatar, alt: '', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(initial));
  return img;
}

// ---------------------------------------------------------------- ghost

const ghostVert = /* glsl */ `
varying vec3 vColor;
varying vec3 vNormal;
void main() {
  vColor = instanceColor;
  vNormal = normal; // instances are only translated, so these are grid-space normals
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const ghostFrag = /* glsl */ `
uniform float uAlpha;
varying vec3 vColor;
varying vec3 vNormal;
void main() {
  float lit = 0.55 + 0.45 * max(dot(vNormal, normalize(vec3(0.45, 0.8, 0.35))), 0.0);
  gl_FragColor = vec4(vColor * lit * uAlpha, uAlpha);
}`;

// ---------------------------------------------------------------- UI

const ICON_SHUFFLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3.5c3 0 4 10 7 10H20M4 17h3.5c1.3 0 2.2-1.8 3-4M20 7h-5.5c-1.3 0-2.2 1.8-3 4"/><path d="M17 4l3 3-3 3M17 14l3 3-3 3"/></svg>';
const ICON_DICE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.1"/><circle cx="15" cy="15" r="1.1"/><circle cx="15" cy="9" r="1.1"/><circle cx="9" cy="15" r="1.1"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';
const ICON_SPARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1-5.1-1.9 5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>';

// ---------------------------------------------------------------- module

export class Constructions {
  // onClose: the player dismissed the construction options (× or Esc)
  // requestRender: redraw for a change the view can't see (the ghost's instances)
  // onPlaced({ key, anchors }): a construction with ANCHORS was stamped; anchors in grid cells
  constructor({ scene, camera, settings, getSim, getVolume, getScale, onClose, requestRender, onPlaced }) {
    this.onClose = onClose;
    this.onPlaced = onPlaced;
    this.requestRender = requestRender;
    this.camera = camera;
    this.settings = settings;
    this.getSim = getSim;
    this.getVolume = getVolume;
    this.getScale = getScale;

    this.choice = loadJSON(STORE, {}).choice ?? {}; // build key -> variant, 'shuffle', or (PROMPT) an item id
    this.seed = newSeed();
    this.cells = null; this.cellsKey = '';
    this.baked = null; this.bakeKey = '';
    this.origin = new THREE.Vector3();
    this.valid = false;
    this.mat = null; this.gridKey = '';

    // PROMPT: the player's own constructions, their sandbox results, and the agent
    this.mine = loadJSON(MINE_STORE, []).filter((m) => m && typeof m.code === 'string');
    this.results = new Map();   // _itemKey() → { cells, report } | { error }
    this.pendingKey = null;
    this.draft = takeDraft();   // the prompt being typed
    this.status = '';
    this.running = null;        // AbortController of a generation in progress
    this.ai = loadSettings();   // BYOK provider, key, base URL and model
    this.models = [];           // model ids the current provider lists
    this.modelsFor = null;      // which provider/credentials `models` was listed for
    this.customModel = null;    // an AI SDK model set from code, overriding the settings
    finishOpenRouterSignIn()
      .then((done) => { if (done) { this.ai = loadSettings(); this._setStatus('Signed in with OpenRouter.'); this.barFor = null; } })
      .catch((err) => this._setStatus(err.message));
    // sign-in and quota changes redraw the account strip and the hint in place
    this.offAccount = onAccountChange(() => this._syncAccount());

    // ghost: a depth-only pass, then a translucent colour pass that only keeps
    // the frontmost faces, so it reads as one solid object rather than a jumble
    this.group = new THREE.Group();
    this.group.visible = false;
    this.geo = new THREE.BoxGeometry(1, 1, 1);
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true });
    this.colorMat = new THREE.ShaderMaterial({
      vertexShader: ghostVert, fragmentShader: ghostFrag,
      uniforms: { uAlpha: { value: GHOST_ALPHA } },
      transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.meshes = [];
    this.capacity = 0;
    this.outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xf4f6fa, transparent: true, opacity: 0.28, depthTest: false }));
    this.outline.renderOrder = 11;
    this.group.add(this.outline);
    scene.add(this.group);

    // after placing, hide the ghost until the pointer moves (it would sit on the new roof)
    this.pointer = [0, 0];
    this.hold = null;
    this._onMove = (e) => {
      this.pointer = [e.clientX, e.clientY];
      if (this.hold && Math.hypot(e.clientX - this.hold[0], e.clientY - this.hold[1]) > HOLD_PX) this.hold = null;
    };
    addEventListener('pointermove', this._onMove);

    this.bar = h('div.build-bar.panel', { role: 'toolbar', 'aria-label': 'Construction options' });
    // Esc closes it, even from its text fields (they keep other keys to themselves)
    this.bar.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.onClose?.();
    }, true);
    document.body.append(this.bar);
    this._tmp = new THREE.Vector3();
  }

  get ready() { return this.valid; }

  get maxSpan() { const g = this.getSim().g; return Math.min(g.nx, g.ny, g.nz); }

  // Call every frame. `active`: a construction is selected and the pointer is over the scene.
  update({ hover, active }) {
    const id = this.settings.tool;
    const build = isBuild(id) ? BUILDS.find((b) => b.id === id) : null;
    this._syncBar(build);
    this.valid = false;
    this.group.visible = false;
    if (!build || !active || !hover.valid || this.hold) return;
    const key = this._loadCells(build);
    if (!key || !this._bakeFacingCamera(key)) return;
    this._placeGhost(hover);
    this.valid = true;
  }

  // Make this.cells the construction to place. Returns its cache key, or null
  // while the player's code is still running in the sandbox (or failed).
  _loadCells(build) {
    const size = this.settings.radius;
    if (build.key === PROMPT) {
      const item = this.activeItem();
      if (!item) return null;
      const key = this._itemKey(item, this.seed, size);
      const res = this.results.get(key);
      if (!res) this._runItem(item, key);
      if (!res || res.error) return null;
      if (key !== this.cellsKey) Object.assign(this, { cells: res.cells, cellsKey: key, bakeKey: '' });
      return key;
    }
    const variant = this.variantFor(build);
    const key = `${build.key}|${variant}|${this.seed}|${size}`;
    if (key !== this.cellsKey) {
      const cells = runGenerator(BUILTINS[build.key], { size, seed: this.seed, variant });
      Object.assign(this, { cells, cellsKey: key, bakeKey: '' });
    }
    return key;
  }

  // Bake the cells with the front (+z) turned toward the camera, snapped to the grid axes.
  _bakeFacingCamera(key) {
    const f = this.camera.getWorldDirection(this._tmp);
    const quarter = Math.abs(f.x) > Math.abs(f.z) ? (f.x > 0 ? 3 : 1) : (f.z > 0 ? 2 : 0);
    const bk = `${key}|${quarter}`;
    this.quarter = quarter;
    if (bk !== this.bakeKey) {
      this.baked = bake(this.cells, quarter);
      this.bakeKey = bk;
      if (this.baked) this._setGhost(this.baked);
    }
    return !!this.baked;
  }

  // Sit the base on the hovered face (or hang it under / beside it) and move the ghost there.
  _placeGhost(hover) {
    const s = this.baked, g = this.getSim().g;
    const axis = Math.floor(hover.face / 2), dir = hover.face % 2 === 0 ? 1 : -1;
    const a = this._tmp.copy(hover.cell).setComponent(axis, hover.cell.getComponent(axis) + dir);
    const o = this.origin.copy(a).sub(s.base);
    if (axis === 0) o.x = dir > 0 ? a.x : a.x - s.w + 1;
    if (axis === 2) o.z = dir > 0 ? a.z : a.z - s.d + 1;
    if (axis === 1 && dir < 0) o.y = a.y - s.h + 1;
    // keep it inside the box when it fits
    if (s.w <= g.nx) o.x = THREE.MathUtils.clamp(o.x, 0, g.nx - s.w);
    if (s.d <= g.nz) o.z = THREE.MathUtils.clamp(o.z, 0, g.nz - s.d);
    o.y = Math.max(0, o.y);

    const scale = this.getScale();
    this.group.scale.setScalar(scale);
    this.group.position.copy(o).multiplyScalar(scale).add(this.getVolume().position);
    this.group.visible = true;
  }

  // Stamp the previewed construction into the grid. The caller snapshots for undo first.
  place() {
    if (!this.valid) return false;
    const key = BUILDS.find((b) => b.id === this.settings.tool)?.key;
    this._stamp(this.baked, this.origin);
    this._anchored(key, this.baked, this.origin, this.quarter);
    this.reroll();
    this.hold = [...this.pointer];
    this.valid = false;
    this.group.visible = false;
    return true;
  }

  // Stamp built-in construction `key` with its local origin (the middle of a
  // built-in's base) on grid cell `feet`, turned by `quarter`, without the
  // ghost (the world's own shrine). Returns its anchors in grid cells ([] if it has none).
  stampAt(key, feet, { quarter = 0, seed = newSeed(), size = this.settings.radius, variant } = {}) {
    const cells = runGenerator(BUILTINS[key], { size, seed, variant });
    const baked = bake(cells, quarter);
    if (!baked) return [];
    const origin = new THREE.Vector3(Math.round(feet.x), Math.round(feet.y), Math.round(feet.z)).sub(baked.base);
    this._stamp(baked, origin);
    return this._anchored(key, baked, origin, quarter);
  }

  // The anchors of construction `key` stamped as `baked` at `origin`, in grid
  // cells (each the centre of its cell's floor), handed to onPlaced.
  _anchored(key, baked, origin, quarter) {
    const local = ANCHORS[key];
    if (!local) return [];
    const anchors = local.map(([x, y, z]) => {
      const [X, Z] = turnPoint(x, z, quarter);
      return new THREE.Vector3(origin.x + baked.base.x + X + 0.5, origin.y + baked.base.y + y, origin.z + baked.base.z + Z + 0.5);
    });
    this.onPlaced?.({ key, anchors });
    return anchors;
  }

  // Stamp already baked cells (runtime.js bake) with their low corner at grid cell origin.
  stampBaked(s, origin) { this._stamp(s, origin); }

  // One GPU pass (shaders/stamp.js) writing baked cells into the grid at origin.
  _stamp(s, origin) {
    const sim = this.getSim(), g = sim.g;
    const gk = `${g.nx}x${g.ny}x${g.nz}`;
    if (gk !== this.gridKey) {
      this.mat?.dispose();
      this.mat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: quadVert,
        fragmentShader: stampFrag(g),
        uniforms: {
          ...stateUniforms(), tStamp: { value: null },
          uAt: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector3() },
          uFoot: { value: 0 }, uSeed: { value: 0 },
        },
        depthTest: false,
        depthWrite: false,
      });
      this.gridKey = gk;
    }
    const tex = new THREE.Data3DTexture(s.data, s.w, s.h, s.d);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.FloatType;
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    const u = this.mat.uniforms;
    u.tStamp.value = tex;
    u.uAt.value.copy(origin);
    u.uSize.value.set(s.w, s.h, s.d);
    u.uFoot.value = Math.min(s.foot, MAX_FOOT);
    u.uSeed.value = newSeed();
    sim.pass(this.mat);
    tex.dispose();
  }

  // New seed (and, when shuffling, maybe a new variant) for the next placement.
  reroll() { this.seed = newSeed(); }

  variantFor(build) {
    if (!build.variants) return undefined;
    const c = this.choice[build.key] ?? (build.shuffle ? 'shuffle' : build.variants[0][0]);
    if (c !== 'shuffle') return build.variants.some(([k]) => k === c) ? c : build.variants[0][0];
    return makeRng(this.seed ^ SEED_SALT).pick(build.variants)[0];
  }

  setVariant(build, key) {
    this.choice[build.key] = key;
    saveJSON(STORE, { choice: this.choice });
    this.reroll();
    this.barFor = null; // resync chips
  }

  // ---------------------------------------------------------------- PROMPT

  activeItem() {
    const c = this.choice[PROMPT];
    return c && c !== NEW ? this.mine.find((m) => m.id === c) ?? null : null;
  }

  _saveMine() { saveJSON(MINE_STORE, this.mine); }

  _setStatus(text) {
    this.status = text;
    if (this.statusEl) this.statusEl.textContent = text;
  }

  // Run a saved construction's code in the sandbox at the current seed and size.
  _runItem(item, key) {
    const known = this.results.get(key);
    if (known) { this._setStatus(known.error ? `Error: ${known.error}` : summarizeReport(known.report)); return; }
    if (this.pendingKey) return;
    this.pendingKey = key;
    const [, seed, size] = key.split('|').map(Number);
    execSandboxed(item.code, { size, seed, maxSpan: this.maxSpan })
      .then((res) => { this._remember(key, res); if (this.activeItem() === item) this._setStatus(summarizeReport(res.report)); })
      .catch((err) => { this._remember(key, { error: err.message }); if (this.activeItem() === item) this._setStatus(`Error: ${err.message}`); })
      .finally(() => { this.pendingKey = null; });
  }

  // cache key for a saved construction's cells: its code revision, seed and size
  _itemKey(item, seed = this.seed, size = this.settings.radius) {
    return `${item.id}:${item.rev ?? 0}|${seed}|${size}`;
  }

  _remember(key, value) {
    this.results.set(key, value);
    while (this.results.size > RESULT_CACHE) this.results.delete(this.results.keys().next().value);
  }

  _addItem(fields) {
    const item = { id: newId(), name: 'Untitled', prompt: '', model: '', created: new Date().toISOString(), ...fields };
    this.mine.push(item);
    this._saveMine();
    this._select(item.id);
    return item;
  }

  _select(id) {
    this.choice[PROMPT] = id;
    saveJSON(STORE, { choice: this.choice });
    this.barFor = null;
    const item = this.activeItem();
    this._setStatus(item ? 'Checking…' : '');
    if (item) this._runItem(item, this._itemKey(item));
  }

  // For experiments: generate with any AI SDK language model instead of the
  // settings, e.g. __app.builds.setModel(model). Pass null to go back.
  setModel(model) {
    this.customModel = model;
    this.barFor = null;
  }

  get modelLabel() {
    if (this.customModel) return this.customModel.modelId ?? 'custom model';
    const c = current(this.ai);
    return `${c.provider.label} · ${c.model}`;
  }

  get canGenerate() { return !!this.customModel || isConfigured(this.ai); }

  // generating with our free relay proxy (and so counting against the day's quota)
  get usesFree() { return !this.customModel && current(this.ai).provider.auth === 'free'; }

  async _generate() {
    const request = this.draft.trim();
    if (!this.canGenerate || !request || this.running) return;
    this.running = new AbortController();
    this.barFor = null;
    const size = this.settings.radius;
    const label = this.modelLabel;
    try {
      this._setStatus(`Asking ${label}…`);
      const [{ runAgent }, model] = await Promise.all([import('./ai/agent.js'), this.customModel ?? createModel(this.ai)]);
      const result = await runAgent({
        model,
        system: buildSystemPrompt({ examples: builtinsSource }),
        request,
        signal: this.running.signal,
        exec: (code) => execSandboxed(code, { size, seed: AGENT_SEED, maxSpan: this.maxSpan }),
        preview: async (cells) => PREVIEW_VIEWS.map((quarter) => {
          const img = renderIso(cells, { quarter, maxPx: PREVIEW_PX });
          const canvas = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
          canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
          return { mediaType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1] };
        }),
        onEvent: (e) => {
          if (e.type === 'exec') this._setStatus(`Running attempt ${e.attempt}…`);
          else if (e.type === 'report') this._setStatus(`Attempt ${e.attempt}: ${summarizeReport(e.report)}`);
          else if (e.type === 'exec_error') this._setStatus(`Attempt ${e.attempt} failed: ${e.message}`);
          else if (e.type === 'step' && e.step > 1) this._setStatus(`${this.status} · thinking…`);
        },
      });
      // show the player exactly what the model checked
      this.seed = AGENT_SEED;
      const item = { id: newId() };
      this._remember(this._itemKey(item, AGENT_SEED, size), { cells: result.cells, report: result.report });
      this._addItem({ id: item.id, name: result.name, prompt: request, code: result.code, model: label, description: result.description });
      const tokens = result.usage.inputTokens + result.usage.outputTokens;
      this._setStatus(`${result.finished ? 'Done' : 'Stopped at the step limit'}: ${summarizeReport(result.report)}${tokens ? ` · ${tokens.toLocaleString()} tokens` : ''}${this._freeLeft()}`);
    } catch (err) {
      this._setStatus(this.running?.signal.aborted ? 'Cancelled.' : `Generation failed: ${err.message}`);
    } finally {
      this.running = null;
      this.barFor = null;
    }
  }

  // ---------------------------------------------------------------- model settings

  _updateAI(patch, { relist = false } = {}) {
    const id = this.ai.provider;
    this.ai.providers[id] = { ...this.ai.providers[id], ...patch };
    saveSettings(this.ai);
    if (this.generateBtn) this.generateBtn.disabled = !this.canGenerate;
    if (this.genHint) this.genHint.textContent = this._genHint();
    if (relist) this.modelsFor = null;
  }

  // List the provider's models once per provider and credentials.
  _refreshModels() {
    const c = current(this.ai);
    const key = `${c.provider.id}|${c.apiKey ? 1 : 0}|${c.baseURL}`;
    if (key === this.modelsFor) return;
    this.modelsFor = key;
    this.models = [];
    listModels(this.ai).then((ids) => {
      if (this.modelsFor !== key) return;
      this.models = ids;
      if (this.modelList) this.modelList.replaceChildren(...ids.map((id) => h('option', { value: id })));
    });
  }

  // provider · credentials · model, and a one-line note
  _modelRow() {
    if (this.customModel) {
      return h('div.row.model-row', {},
        h('span.model-label', { text: `Model: ${this.modelLabel} (set from code)` }),
        h('button.chip', { type: 'button', text: 'Use settings', on: { click: () => this.setModel(null) } }));
    }
    const c = current(this.ai);
    const p = c.provider;
    const select = h('select.provider', { 'aria-label': 'Model provider' },
      PROVIDERS.map((x) => h('option', { value: x.id, text: x.label, selected: x.id === p.id })));
    select.addEventListener('change', () => { this.ai.provider = select.value; saveSettings(this.ai); this.modelsFor = null; this.barFor = null; });
    // A key is saved when the field is committed (Enter or leaving it): saving it
    // swaps the field for Forget key, which mustn't happen mid-typing.
    const field = (cls, type, placeholder, value, key, { relist = false, onCommit = false } = {}) => {
      const el = h(`input.${cls}`, { type, placeholder, value, spellcheck: 'false', autocomplete: 'off' });
      if (!onCommit) el.addEventListener('input', () => this._updateAI({ [key]: el.value.trim() }));
      el.addEventListener('change', () => {
        this._updateAI(onCommit ? { [key]: el.value.trim() } : {}, { relist });
        if (relist) this._refreshModels();
        if (onCommit) this.barFor = null;
      });
      el.addEventListener('keydown', (e) => e.stopPropagation());
      return el;
    };
    const forget = h('button.chip', { type: 'button', text: 'Forget key', title: 'Remove the key from this browser', on: { click: () => { this._updateAI({ apiKey: '' }, { relist: true }); this.barFor = null; } } });
    const auth = [];
    if (p.auth === 'oauth' && !c.apiKey) {
      auth.push(h('button.chip.on', { type: 'button', text: 'Sign in with OpenRouter', title: 'Leaves this page to approve on openrouter.ai; the scene reloads after', on: { click: () => startOpenRouterSignIn() } }));
    }
    if (p.auth === 'none' || p.auth === 'optional') auth.push(field('base-url', 'url', 'Server URL', c.baseURL, 'baseURL', { relist: true }));
    const keyHint = { optional: 'Key (optional)', oauth: 'or paste a key' }[p.auth] ?? 'API key';
    if (p.auth !== 'none' && p.auth !== 'free') auth.push(c.apiKey ? forget : field('api-key', 'password', keyHint, '', 'apiKey', { relist: true, onCommit: true }));
    const listId = 'build-model-list';
    this.modelList = h(`datalist#${listId}`, {}, this.models.map((id) => h('option', { value: id })));
    const model = p.fixedModel ? h('span.model-fixed', { text: p.fixedModel }) : field('model', 'text', 'Model id', c.model, 'model');
    if (!p.fixedModel) model.setAttribute('list', listId);
    this._refreshModels();
    return h('div.model', {},
      h('div.model-row', {}, h('span.field-label', { text: 'Model' }), select, model,
        auth.length > 0 && h('div.auth', {}, ...auth), this.modelList),
      h('p.note', { text: p.note }));
  }

  async _copyPrompt() {
    const request = this.draft.trim();
    if (!request) { this._setStatus('Describe the construction first.'); return; }
    try {
      await navigator.clipboard.writeText(buildChatPrompt({ examples: builtinsSource, request }));
      this._setStatus('Prompt copied. Paste it into any chatbot, then bring its code back with Paste code.');
    } catch {
      this._setStatus('Copying was blocked by the browser.');
    }
  }

  _export(item) {
    const blob = new Blob([JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, name: item.name, prompt: item.prompt, description: item.description ?? '', code: item.code }, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${item.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'construction'}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  _import() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
      try {
        const data = JSON.parse(await input.files[0].text());
        if (data?.format !== FILE_FORMAT || typeof data.code !== 'string') throw new Error('not a construction file');
        this._addItem({ name: String(data.name || 'Imported').slice(0, IMPORT_NAME_CHARS), prompt: String(data.prompt ?? ''), description: String(data.description ?? ''), code: data.code });
      } catch (err) {
        this._setStatus(`Import failed: ${err.message}`);
      }
    });
    input.click();
  }

  // Code editor for pasted, imported or hand-written constructions. The code is
  // only saved once it has run in the sandbox.
  _openEditor(item = null) {
    this.editor?.remove();
    const name = h('input.name', { type: 'text', placeholder: 'Name', value: item?.name ?? this.draft.trim().slice(0, MAX_NAME_CHARS), spellcheck: 'false' });
    const code = h('textarea.code', { spellcheck: 'false', placeholder: "Paste construction code, or a chatbot's whole reply.\n\nbox(-4, 0, -4, 4, 0, 4, 'WALL');\nball(0, 5, 0, 4, 'WATER');" });
    code.value = item?.code ?? '';
    const out = h('p.report');
    const close = () => { this.editor?.remove(); this.editor = null; };
    const run = h('button.chip.on', { type: 'button', text: item ? 'Run and save' : 'Run and add' });
    run.addEventListener('click', async () => {
      const src = extractCode(code.value);
      if (!src) { out.textContent = 'Nothing to run.'; return; }
      out.textContent = 'Running…';
      try { await this._saveEdited(item, src, name.value.trim()); close(); } catch (err) { out.textContent = `Error: ${err.message}`; }
    });
    const cancel = h('button.chip', { type: 'button', text: 'Cancel', on: { click: close } });
    // a dim backdrop, so the dialog reads as modal over the bar and the scene
    this.editor = h('div.build-editor-backdrop', {}, h('div.build-editor.panel', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Construction code' },
      h('h3', { text: item ? 'Edit construction' : 'Paste construction code' }), name, code, out, h('div.row', {}, run, cancel)));
    this.editor.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
    document.body.append(this.editor);
    (item || name.value ? code : name).focus();
  }

  // Run edited code in the sandbox; only code that runs is saved (throws otherwise).
  async _saveEdited(item, src, name) {
    const res = await execSandboxed(src, { size: this.settings.radius, seed: this.seed, maxSpan: this.maxSpan });
    if (item) {
      // a new revision, so the ghost and the cache stop using the old code's cells
      for (const k of [...this.results.keys()]) if (k.startsWith(`${item.id}:`)) this.results.delete(k);
      Object.assign(item, { code: src, name: name || item.name, rev: (item.rev ?? 0) + 1 });
      this._saveMine();
    } else {
      item = { id: newId(), name: name || 'Untitled', prompt: this.draft.trim(), code: src };
    }
    this._remember(this._itemKey(item), res); // before selecting, so it doesn't run twice
    if (this.mine.includes(item)) this._select(item.id); else this._addItem(item);
    this._setStatus(summarizeReport(res.report));
  }

  // ---------------------------------------------------------------- bar

  _syncBar(build) {
    this.bar.classList.toggle('show', !!build);
    if (build) this._positionBar();
    const sel = this._barKey(build);
    if (sel === this.barFor) return;
    this.barFor = sel;
    this.bar.classList.toggle('prompt', build?.key === PROMPT);
    if (build?.key === PROMPT) this._promptBar();
    else if (build) this._variantBar(build);
  }

  // sit just above the dock (or its collapsed tab)
  _positionBar() {
    const dock = document.querySelector('.dock:not(.collapsed)') ?? document.querySelector('.dock-tab');
    const top = dock ? dock.getBoundingClientRect().top : innerHeight - DOCK_MARGIN_PX;
    this.bar.style.bottom = `${Math.round(innerHeight - top + BAR_GAP_PX)}px`;
  }

  // what the bar shows; it is rebuilt only when this changes
  _barKey(build) {
    if (!build) return null;
    if (build.key !== PROMPT) return `${build.key}|${this.choice[build.key] ?? ''}`;
    return `${PROMPT}|${this.choice[PROMPT] ?? ''}|${this.mine.length}|${!!this.running}|${this.ai.provider}|${!!current(this.ai).apiKey}|${!!this.customModel}`;
  }

  // built-ins: variant chips (with shuffle) and a reroll
  _variantBar(build) {
    const current = build.variants ? (this.choice[build.key] ?? (build.shuffle ? 'shuffle' : build.variants[0][0])) : null;
    const chip = (key, label, icon) => h(`button.chip${current === key ? '.on' : ''}`, {
      type: 'button', 'aria-pressed': String(current === key),
      html: `${icon ?? ''}<span>${label}</span>`,
      on: { click: () => this.setVariant(build, key) },
    });
    this.bar.replaceChildren(...[
      build.variants && h('div.chips', {},
        chip('shuffle', 'Shuffle', ICON_SHUFFLE),
        build.variants.map(([k, label]) => chip(k, label))),
      h('button.chip.roll', {
        type: 'button', title: 'Roll a different one', html: `${ICON_DICE}<span>New seed</span>`,
        on: { click: () => this.reroll() },
      }),
    ].filter(Boolean));
  }

  _genHint() {
    if (!this.canGenerate) return 'Set up a model below to generate';
    const { user, quota } = accountState();
    if (this.usesFree && quota?.remaining === 0) return user ? 'No generations left today' : 'Sign in below to keep generating';
    return `⌘↵ to generate${user ? '' : this._freeLeft()}`; // signed in, the account strip shows what's left
  }
  // ' · 3 free left today' while the free provider is in use and the relay has said
  _freeLeft() {
    const q = accountState().quota;
    if (!this.usesFree || q?.remaining == null) return '';
    return ` · ${q.remaining} ${q.tier === 'paid' ? '' : 'free '}left today`;
  }

  // Free provider only: sign in for more generations, or who's signed in and what's left today.
  // Empty while the relay doesn't answer: there's nothing to sign in to.
  _accountStrip() {
    if (!this.usesFree || !accountsEnabled) return null;
    const { user, signedIn, checking, offline, quota, error } = accountState();
    if (!quota) aiQuota();             // each answer redraws the strip (_syncAccount)
    if (signedIn && !user) account();
    if (offline && !user) return h('div.account');
    if (user) {
      return h('div.account', {},
        avatar(user),
        h('span.account-name', { text: user.name, title: user.email || user.name }),
        quota?.remaining != null && h('span.account-left', { text: `${quota.remaining} left today` }),
        h('button.link', { type: 'button', text: 'Sign out', on: { click: () => signOut() } }));
    }
    if (signedIn && checking) return h('div.account', {}, h('span.account-pitch', { text: 'Signing in…' }));
    // nothing to offer until the relay says which sign-ins it has set up
    const options = signInOptions();
    if (!options.length) return error ? h('div.account', {}, h('span.account-pitch.failed', { text: error })) : h('div.account');
    // out of anonymous generations: signing in is the way on
    const out = quota?.remaining === 0;
    const pitch = error ?? (out ? `No free generations left today. Sign in for ${freeDaily()} a day.`
      : `Sign in for ${freeDaily()} free generations a day`);
    return h(`div.account${out ? '.urgent' : ''}`, {},
      h(`span.account-pitch${error ? '.failed' : ''}`, { text: pitch }),
      h('div.account-actions', {},
        options.map((p) => h(`button.chip${out ? '.on' : ''}`, {
          type: 'button', text: p.label, title: 'Leaves this page to sign in; the scene reloads after',
          on: { click: () => this._signIn(p.id) },
        })),
        h('a.link', { href: PRIVACY_URL, target: '_blank', rel: 'noopener', text: 'Privacy' })));
  }

  // account or quota changed: redraw the strip and the hint in place (rebuilding the bar would take the prompt's focus)
  _syncAccount() {
    if (this.accountEl?.isConnected) {
      const el = this._accountStrip();
      if (el) { this.accountEl.replaceWith(el); this.accountEl = el; }
    }
    if (this.genHint?.isConnected && !this.running) this.genHint.textContent = this._genHint();
  }

  // Signing in leaves the page: keep the prompt being typed for when it comes back
  _signIn(provider) {
    try { sessionStorage.setItem(DRAFT_STORE, this.draft); } catch { /* storage unavailable */ }
    signIn(provider);
  }

  // AI construction: a header with close, then either the prompt composer (new)
  // or the selected saved construction's actions, and the saved list
  _promptBar() {
    const item = this.activeItem();
    const current = item ? item.id : NEW;
    const button = (label, opts, fn) => h(`button.${opts.cls ?? 'chip'}${opts.on ? '.on' : ''}`, {
      type: 'button', title: opts.title, disabled: !!opts.disabled, html: `${opts.icon ?? ''}<span>${label}</span>`, on: { click: fn },
    });
    const head = h('div.bar-head', {},
      h('span.bar-title', {}, h('span.spark', { html: ICON_SPARK }), h('span', { text: 'AI construction' })),
      h('button.bar-close', { type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', html: ICON.close, on: { click: () => this.onClose?.() } }));
    const saved = (this.mine.length > 0) && h('div.saved', {},
      h('span.field-label', { text: 'Saved' }),
      h('div.chips', {},
        this.mine.map((m) => h(`button.chip${current === m.id ? '.on' : ''}`, {
          type: 'button', title: m.prompt || m.name, 'aria-pressed': String(current === m.id), text: m.name,
          on: { click: () => this._select(m.id) },
        })),
        h(`button.chip${current === NEW ? '.on' : ''}`, { type: 'button', html: `${ICON_PLUS}<span>New</span>`, on: { click: () => this._select(NEW) } })));

    let body;
    if (item) {
      body = [
        item.prompt && h('p.item-prompt', { text: item.prompt }),
        h('div.row', {},
          button('New seed', { icon: ICON_DICE, title: 'Run it again with a different seed' }, () => this.reroll()),
          button('Edit code', {}, () => this._openEditor(item)),
          button('Export', { title: 'Save as a .json file to share' }, () => this._export(item)),
          button('Delete', { cls: 'chip.danger' }, () => {
            if (!confirm(`Delete "${item.name}"?`)) return;
            this.mine = this.mine.filter((m) => m !== item);
            this._saveMine();
            this._select(NEW);
          })),
      ];
    } else {
      const input = h('textarea.prompt-input', { rows: 3, spellcheck: true, placeholder: 'Describe a construction: a lighthouse on a rocky island, a log bridge, a pagoda…' });
      input.value = this.draft;
      input.addEventListener('input', () => { this.draft = input.value; });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this._generate(); }
        e.stopPropagation();
      });
      this.generateBtn = this.running ? null : button('Generate', {
        cls: 'chip.primary', disabled: !this.canGenerate, title: 'Write it with the chosen model (⌘↵)',
      }, () => this._generate());
      this.genHint = h('span.gen-hint', { text: this.running ? 'Writing it…' : this._genHint() });
      this.accountEl = this._accountStrip();
      body = [
        h('div.composer', {}, input,
          h('div.composer-foot', {}, this.genHint, this.running ? button('Cancel', {}, () => this.running?.abort()) : this.generateBtn)),
        this._modelRow(),
        this.accountEl,
        h('div.links', {},
          button('Copy prompt for a chatbot', { cls: 'link', title: 'Paste it into any chatbot, then bring its code back with Paste code' }, () => this._copyPrompt()),
          button('Paste code', { cls: 'link', title: 'Run code from a chatbot or your own' }, () => this._openEditor()),
          button('Import file', { cls: 'link', title: 'Add a construction from a .json file' }, () => this._import())),
      ];
    }
    this.statusEl = h('p.status', { 'aria-live': 'polite', text: this.status });
    this.bar.replaceChildren(...[head, ...body, this.statusEl, saved].filter(Boolean));
  }

  // ---------------------------------------------------------------- ghost

  _setGhost(s) {
    const n = s.ghost.length / 4;
    if (n > this.capacity) {
      for (const m of this.meshes) { this.group.remove(m); m.dispose(); }
      this.capacity = Math.max(n, Math.ceil(this.capacity * 1.5), 1024);
      const depth = new THREE.InstancedMesh(this.geo, this.depthMat, this.capacity);
      const color = new THREE.InstancedMesh(this.geo, this.colorMat, this.capacity);
      color.instanceMatrix = depth.instanceMatrix;
      depth.instanceColor = color.instanceColor =
        new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
      depth.renderOrder = 9;
      color.renderOrder = 10;
      for (const m of [depth, color]) {
        m.frustumCulled = false;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(m);
      }
      this.meshes = [depth, color];
    }
    const [depth, color] = this.meshes;
    const mat = depth.instanceMatrix.array, col = depth.instanceColor.array;
    const rgb = ELEMENTS.map((e) => hexBytes(e.color).map((v) => v / 255));
    for (let i = 0; i < n; i++) {
      const x = s.ghost[i * 4], y = s.ghost[i * 4 + 1], z = s.ghost[i * 4 + 2], id = s.ghost[i * 4 + 3];
      mat.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x + 0.5, y + 0.5, z + 0.5, 1], i * 16);
      const c = rgb[id], k = GHOST_SHADE_MIN + GHOST_TEXTURE * cellNoise(x, y, z);
      col[i * 3] = c[0] * k; col[i * 3 + 1] = c[1] * k; col[i * 3 + 2] = c[2] * k;
    }
    depth.count = color.count = n;
    depth.instanceMatrix.clearUpdateRanges();
    depth.instanceMatrix.addUpdateRange(0, n * 16);
    depth.instanceMatrix.needsUpdate = true;
    depth.instanceColor.clearUpdateRanges();
    depth.instanceColor.addUpdateRange(0, n * 3);
    depth.instanceColor.needsUpdate = true;
    this.outline.scale.set(s.w, s.h, s.d);
    this.outline.position.set(s.w / 2, s.h / 2, s.d / 2);
    this.requestRender?.(); // the view key misses instance swaps, e.g. when a generation finishes
  }

  dispose() {
    removeEventListener('pointermove', this._onMove);
    this.offAccount();
    this.running?.abort();
    for (const m of this.meshes) m.dispose();
    this.group.removeFromParent();
    this.geo.dispose();
    this.depthMat.dispose();
    this.colorMat.dispose();
    this.outline.geometry.dispose();
    this.outline.material.dispose();
    this.mat?.dispose();
    this.bar.remove();
    this.editor?.remove();
  }
}

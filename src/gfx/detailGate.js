// Distance gating for the close-up detail features (gfx/detail.js).
//
// A feature compiled into the view's module costs time even where it draws
// nothing: a bigger shader runs slower everywhere (registers, occupancy). So
// an expensive feature is only compiled in while the camera is close enough
// for it to show. Each feature declares fadeM, the pixel footprint (metres
// per pixel) above which it draws nothing. The smallest footprint anywhere on
// screen is bounded by the distance from the camera to the grid box: inside
// the box (POV mode) every feature is in.
//
// Every variant is a module of the realistic view (shaders/render.js
// volumeFrag(g, { detail })), and building its pipeline is slow (on
// SwiftShader 8 s for the base variant with nothing on, 15 s with every
// feature in). Pipelines build asynchronously (docs/webgpu.md W18, B5), so the
// WebGL build's warm draw into a 1-pixel target is gone: a variant is drawn
// once its pipeline is ready, and until then the view keeps the variant it
// had. There are two:
//   base  the switched-on features gating can't help: low-cost ones, and
//         ones that show from any ordinary viewing distance (fadeM at or
//         above GATE_ALWAYS_M). Built at once (the view draws it).
//   near  base plus the rest, prefetched at idle time a moment after start-up
//         or a settings change, and shown when the camera is close and it is
//         ready: detail shows up late rather than the frame waiting.
// With the default (Balanced) switches only Smooth up close is gated.
// Only the realistic view has detail: in any other view nothing builds
// (docs/webgpu.md B5: boot builds the current view's module only), and the
// variants build when the view becomes realistic (setView).
import { DETAIL, settingKey } from './detail.js';
import { VIEWS } from '../views.js';
import { CELL_M } from '../scale.js';

// m per pixel. The god view's nearest surfaces are ~100 cells away (~2.7 cm
// per pixel at 1280×800): a feature that starts showing at or above this
// footprint is on screen from any ordinary view, so gating it saves nothing.
const GATE_ALWAYS_M = 0.05;
// Near comes in at the largest gated fadeM and goes out above it × this, so a
// camera hovering at the threshold doesn't flip variants every frame.
const GATE_HYSTERESIS = 1.25;
// ms after start-up (or a settings change) before the near variant starts building
export const PREWARM_DELAY_MS = 1500;
const DEG = Math.PI / 180;
const VIEW = 'realistic';   // the view the detail is part of
// a view as a VIEWS key; the app's settings.view is its id
function viewKey(view) {
  if (typeof view === 'string' && VIEWS.some((v) => v.key === view)) return view;
  const v = VIEWS.find((x) => x.id === view);
  if (!v) throw new Error(`detailGate: view ${view} is neither a src/views.js key nor an id (configure(volume, settings, view))`);
  return v.key;
}

const alwaysIn = (f) => f.cost === 'low' || f.fadeM === undefined || f.fadeM >= GATE_ALWAYS_M;
const definesOf = (features) => Object.fromEntries(features.map((f) => [f.define, 1]));

/**
 * The two variants for `settings` (detail_* switches): base and near (their
 * defines objects), and the footprint (m per pixel) below which near is
 * wanted (0: nothing gated). shaders/render.js's WGSL_CHECK lists the
 * default settings' pair, so the start menu warms what the view draws first.
 * @param {object} settings
 */
export function gateVariants(settings) {
  const on = DETAIL.filter((f) => settings[settingKey(f)]);
  const gated = on.filter((f) => !alwaysIn(f));
  return { base: definesOf(on.filter(alwaysIn)), near: definesOf(on), nearFadeM: Math.max(0, ...gated.map((f) => f.fadeM)) };
}
const keyOf = (d) => Object.keys(d).sort().join(',');
const component = (v, i) => (v.getComponent ? v.getComponent(i) : v[i]);

/**
 * @param {object} gpu (kept for the call's shape; the pipelines are the volume's)
 * @param {() => void} [onReady] a variant the view should now draw has become ready (redraw)
 * @param {() => void} [onCompile] a variant the view wants is still building (tell the user)
 */
export function createDetailGate(gpu, onReady = () => {}, onCompile = () => {}) {
  let volume = null;                // gfx/volume.js: its pipeline(view, detail, build)
  let view = VIEW;                  // the view drawn now (a VIEWS key)
  let base = {}, near = {};         // define sets of the two variants
  let applied = {};                 // the base the view draws (a changed base waits for its pipeline)
  let stale = null;                 // base isn't asked for yet: 'fresh' (a new volume) or 'changed' (a switch)
  let nearFadeM = 0;                // footprint below which near is wanted
  let wantNear = false;
  let nearPipe = null;              // the near variant's pipeline, once asked for
  let told = false;                 // onCompile has said so for the near variant wanted now
  let timer = 0;

  function askNear(build) {
    if (keyOf(near) === keyOf(base)) return;
    nearPipe = volume.pipeline(VIEW, near, build);
    if (build === 'now') nearPipe.build();
    const p = nearPipe, v = volume;
    p.ready.then(() => { if (volume === v && nearPipe === p && wantNear) onReady(); }, () => {});
  }
  const showNear = () => wantNear && nearPipe?.state === 'ready' && applied === base;
  // the realistic view is up: its base variant builds now (if it isn't yet),
  // its near one a moment later at idle time
  function enter() {
    if (stale) {
      const p = volume.pipeline(VIEW, base, 'now');
      if (stale === 'fresh' || p.state === 'ready') applied = base;
      else {
        // a switch changed: the base variant builds; the view keeps the old one until then
        onCompile();
        const v = volume, b = base;
        p.ready.then(() => { if (volume === v && base === b) { applied = b; onReady(); } }, () => {});
      }
      stale = null;
    }
    clearTimeout(timer);
    const vol = volume;
    if (nearFadeM) timer = setTimeout(() => { if (volume === vol && view === VIEW && !nearPipe) askNear('idle'); }, PREWARM_DELAY_MS);
  }

  return {
    /**
     * A new volume (grid rebuilt), new feature switches, or another view.
     * @param {object} vol gfx/volume.js's volume
     * @param {object} next the app's settings (detail_* switches)
     * @param {string | number} [nextView] the view drawn now: a src/views.js key or id (settings.view)
     */
    configure(vol, next, nextView = view) {
      view = viewKey(nextView);
      const fresh = vol !== volume;
      volume = vol;
      const { base: nextBase, near: nextNear, nearFadeM: fade } = gateVariants(next);
      nearFadeM = fade;
      if (fresh || keyOf(nextNear) !== keyOf(near)) { nearPipe = null; told = false; }
      near = nextNear;
      if (fresh || keyOf(nextBase) !== keyOf(base)) {
        base = nextBase;
        wantNear = false;
        stale = fresh || stale === 'fresh' ? 'fresh' : 'changed';
      }
      clearTimeout(timer);
      if (view === VIEW) enter();
    },
    /**
     * The view changed (settings.view): the detail's variants build when it becomes realistic.
     * @param {string | number} nextView a src/views.js key or id
     */
    setView(nextView) {
      const was = view;
      view = viewKey(nextView);
      if (view === was || !volume) return;
      if (view === VIEW) enter();
      else { clearTimeout(timer); wantNear = false; }
    },

    /**
     * Every rendered frame, before the view draws: the detail the realistic
     * view should draw with now (its defines object).
     * @param {object} camera a three PerspectiveCamera
     * @param {number[] | { getComponent: Function }} camGrid the camera in grid cells
     * @param {number[]} dims [nx, ny, nz]
     * @param {number} heightPx the scene target's height in pixels
     * @returns {object}
     */
    update(camera, camGrid, dims, heightPx) {
      if (!volume || !nearFadeM || view !== VIEW) return applied;
      let d2 = 0;
      for (let i = 0; i < 3; i++) {
        const c = component(camGrid, i);
        const e = c < 0 ? -c : c > dims[i] ? c - dims[i] : 0;
        d2 += e * e;
      }
      const fpM = Math.sqrt(d2) * CELL_M * 2 * Math.tan(camera.fov * DEG / 2) / heightPx;
      if (fpM < nearFadeM) wantNear = true;
      else if (fpM > nearFadeM * GATE_HYSTERESIS) wantNear = false;
      if (wantNear && (!nearPipe || nearPipe.state === 'idle')) askNear('now');
      if (wantNear && nearPipe?.state === 'pending' && !told) { told = true; onCompile(); }
      return showNear() ? near : applied;
    },

    /** 1 while the camera wants the near variant. */
    get level() { return wantNear ? 1 : 0; },
    /** Variants building: a changed base, and the near one (none outside the realistic view). */
    get pending() {
      if (view !== VIEW) return 0;
      return Number(!!volume && applied !== base) + Number(!!nearPipe && nearPipe.state !== 'ready' && nearPipe.state !== 'failed');
    },
    /** The view the gate is configured for (a src/views.js key). */
    get view() { return view; },
    /** The key of the variant update() returns now. */
    get shown() { return keyOf(showNear() ? near : applied); },
    dispose() { clearTimeout(timer); volume = nearPipe = null; },
  };
}

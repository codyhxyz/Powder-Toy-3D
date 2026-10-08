// Element tiles as live scenes: each draws its box with the engine port, and
// dock tiles run it while hovered. The cursor applies the game's own tools at
// the game's rates: Pressure on powders and liquids, the element's brush on
// gases, Heat on solids. Gravity, speed (steps per frame) and flow come from the
// app's settings. When the cursor leaves, the scene keeps going for a moment,
// then fades back to its resting frame. Only awake tiles tick.
import { K } from '../../elements.js';
import { makeScene, TILE, CELL } from './scenes.js';
import { drawScene } from './render.js';

const RUN = {
  FRAME_HZ: 60,              // scene frames per second (the game's tool + steps cadence)
  CURSOR_RADIUS: 4,          // cells (the game's default brush is 5 in a much bigger box)
  GAS_BRUSH_RADIUS: 3,       // cells; a smaller brush keeps a painted plume light
  PRESS_HOLD: 0.3,           // share of the Pressure tool while the cursor holds still...
  CURSOR_FULL_SPEED: 150,    // ...rising to all of it at this cursor speed (px/s)
  SETTLE_S: 1.2,             // keep running this long after the cursor leaves
  FADE_S: 0.5,               // then fade back to the resting frame
  WAKE_RATE: 6,              // 1/s, how fast the live shading comes in
  SLEEP_RATE: 3,             // 1/s, and goes
  SPEED_SMOOTH: 0.35,        // cursor speed smoothing per frame
  MAX_FRAMES_PER_TICK: 3,    // after a stall, skip ahead rather than catch up
  MAX_TICK_S: 0.1,
  SEED_STRIDE: 7919,         // per-element seed, so an element's resting frame is the same everywhere
};
const FRAME_DT = 1 / RUN.FRAME_HZ;
const DPR = () => Math.min(2, window.devicePixelRatio || 1);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const seedOf = (item) => (item.id + 1) * RUN.SEED_STRIDE;

let settings = null; // the app's settings object, read live
export function setTileSettings(s) { settings = s; }

// resting scenes are shared by every static tile of the same element
const restScenes = new Map();
const restScene = (item) => {
  if (!restScenes.has(item.id)) restScenes.set(item.id, makeScene(item, seedOf(item)));
  return restScenes.get(item.id);
};

class LiveTile {
  constructor(el, item, canvas) {
    this.el = el;
    this.item = item;
    this.canvas = canvas;
    this.scene = makeScene(item, seedOf(item));
    this.inside = false;
    this.pointer = { x: TILE / 2, y: TILE / 2, px: TILE / 2, py: TILE / 2, speed: 0 };
    this.activity = 0;
    this.away = 0; // s since the cursor left
    this.fade = 0; // 0..1 toward the resting frame
    el.addEventListener('pointerenter', (e) => { this.track(e); this.enter(); });
    el.addEventListener('pointermove', (e) => this.track(e));
    el.addEventListener('pointerleave', () => { this.inside = false; wake(this); });
  }
  track(e) {
    const r = this.el.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * TILE;
    this.pointer.y = ((e.clientY - r.top) / r.height) * TILE;
  }
  enter() {
    if (reducedMotion.matches || !settings.liveTiles) return; // settings: Element picker
    const p = this.pointer;
    p.px = p.x; p.py = p.y; p.speed = 0;
    this.inside = true;
    this.away = 0; this.fade = 0;
    wake(this);
  }
  // the game's frame: apply the tool once, then run `steps` engine steps
  tool() {
    const w = this.scene.world, p = this.pointer;
    const cx = p.x / CELL, cy = this.scene.y0 + (TILE - p.y) / CELL;
    if (this.item.kind === K.SOLID) w.heat(cx, cy, RUN.CURSOR_RADIUS);
    else if (this.item.kind === K.GAS) w.paint(cx, cy, RUN.GAS_BRUSH_RADIUS, this.item.id, settings.rate);
    else w.pressure(cx, cy, RUN.CURSOR_RADIUS, Math.min(1, RUN.PRESS_HOLD + p.speed / RUN.CURSOR_FULL_SPEED));
  }
  // one frame; false once the tile is back at rest
  frame() {
    const p = this.pointer, on = this.inside;
    p.speed += (Math.hypot(p.x - p.px, p.y - p.py) / FRAME_DT - p.speed) * RUN.SPEED_SMOOTH;
    p.px = p.x; p.py = p.y;
    this.activity += ((on ? 1 : 0) - this.activity) * (1 - Math.exp(-(on ? RUN.WAKE_RATE : RUN.SLEEP_RATE) * FRAME_DT));
    if (!on) {
      this.away += FRAME_DT;
      if (this.away > RUN.SETTLE_S) this.fade = Math.min(1, (this.away - RUN.SETTLE_S) / RUN.FADE_S);
      if (this.fade >= 1) {
        this.scene.world.copyFrom(this.scene.rest);
        this.activity = 0; this.fade = 0;
        return false;
      }
    }
    if (on) this.tool();
    const w = this.scene.world;
    w.gravity = settings.gravity;
    for (let i = 0; i < settings.steps; i++) w.step();
    return true;
  }
  render() {
    const ctx = this.canvas.getContext('2d'), s = (this.canvas.width / TILE);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, TILE, TILE);
    drawScene(ctx, this.scene, this.activity);
    if (this.fade > 0) {
      ctx.globalAlpha = this.fade;
      drawScene(ctx, { ...this.scene, world: this.scene.rest }, 0);
      ctx.globalAlpha = 1;
    }
  }
}

// one loop for every awake tile
const running = new Set();
let raf = 0, last = 0, acc = 0;
function wake(t) {
  running.add(t);
  if (!raf) { last = performance.now(); acc = 0; raf = requestAnimationFrame(tick); }
}
function tick(now) {
  const dt = Math.min(RUN.MAX_TICK_S, (now - last) / 1000);
  last = now;
  acc += dt;
  let frames = Math.floor(acc / FRAME_DT);
  acc -= frames * FRAME_DT;
  frames = Math.min(frames, RUN.MAX_FRAMES_PER_TICK);
  for (const t of running) {
    let awake = true;
    for (let f = 0; f < frames && awake; f++) awake = t.frame();
    t.render();
    if (!awake) running.delete(t);
  }
  raf = running.size ? requestAnimationFrame(tick) : 0;
}

// Puts an element's scene in a tile element at px CSS pixels. live: it runs when hovered.
export function mountTile(el, item, { px = TILE, live = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.round(px * DPR());
  canvas.setAttribute('aria-hidden', 'true');
  el.prepend(canvas);
  el.dataset.live = '';
  if (live) { new LiveTile(el, item, canvas).render(); return; }
  const ctx = canvas.getContext('2d'), s = canvas.width / TILE;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  drawScene(ctx, restScene(item), 0);
}

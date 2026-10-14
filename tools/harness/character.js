// The loading screen's player (src/ui/youViewer.js), kept here so a character
// can be looked at without booting a map. ?character=woman opens on her.
import { createYou, YOU_DRAG, YOU_YAW } from '/src/ui/youViewer.js';
import { nextYouZoom } from '/src/pov/character.js';

const CHARACTERS = ['woman', 'real', 'stick', 'spartan', 'boy', 'girl', 'maple', 'clover', 'pippin', 'crook'];
const picked = new URLSearchParams(location.search).get('character');
let character = CHARACTERS.includes(picked) ? picked : 'woman';
const VIEWS = { front: 0, side: Math.PI / 2, rear: Math.PI };
const selectedView = new URLSearchParams(location.search).get('view');
let view = Object.hasOwn(VIEWS, selectedView) ? selectedView : null, spinning = view === null;
let canvas = document.querySelector('#view');
let you = null, drag = null, last = 0, epoch = 0;
const err = document.querySelector('#err');

function size(target) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const height = Math.max(160, innerHeight - document.querySelector('nav').getBoundingClientRect().height - 24);
  target.width = Math.round(innerWidth * dpr);
  target.height = Math.round(height * dpr);
  target.style.height = `${height}px`;
}

async function show(next) {
  const token = ++epoch;
  drag = null;
  err.textContent = '';
  // A new canvas: dispose() drops the old one's WebGL context.
  const nextCanvas = document.createElement('canvas');
  nextCanvas.id = 'view';
  size(nextCanvas);
  let built;
  try {
    built = await createYou({
      canvas: nextCanvas, width: nextCanvas.width, height: nextCanvas.height, character: next, yaw: view ? VIEWS[view] : YOU_YAW,
    });
  } catch (e) {
    if (token !== epoch) return;
    console.error(e);
    err.textContent = `Couldn't show ${next}: ${e.message ?? e}`;
    return;
  }
  if (token !== epoch) { built.dispose(); return; }
  you?.dispose();
  canvas.replaceWith(nextCanvas);
  canvas = nextCanvas;
  you = built;
  character = next;
  you.frame();
  canvas.dataset.ready = 'true';
  const url = new URL(location.href);
  url.searchParams.set('character', character);
  history.replaceState(null, '', url);
  for (const button of document.querySelectorAll('[data-character]')) {
    button.setAttribute('aria-pressed', String(button.dataset.character === character));
  }
  updateView();
}

function updateView() {
  const url = new URL(location.href);
  if (view) url.searchParams.set('view', view); else url.searchParams.delete('view');
  history.replaceState(null, '', url);
  document.querySelector('#spin').setAttribute('aria-pressed', String(spinning));
  for (const button of document.querySelectorAll('[data-view]'))
    button.setAttribute('aria-pressed', String(!spinning && button.dataset.view === view));
}
addEventListener('pointerdown', (e) => {
  if (!you || e.button !== 0 || e.target !== canvas) return;
  drag = { x: e.clientX, yaw: you.yaw };
  spinning = false; view = null; updateView();
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
addEventListener('pointermove', (e) => {
  if (!drag || !you) return;
  you.yaw = drag.yaw + (e.clientX - drag.x) * YOU_DRAG;
  you.frame(0, false);
});
const release = () => { drag = null; canvas.classList.remove('dragging'); };
addEventListener('pointerup', release);
addEventListener('pointercancel', release);
addEventListener('wheel', (e) => {
  if (!you) return;
  e.preventDefault();
  you.setZoom(nextYouZoom(you.zoom, e.deltaY));
  you.frame(0, false);
}, { passive: false });
for (const button of document.querySelectorAll('[data-character]')) {
  button.addEventListener('click', () => show(button.dataset.character));
}
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    view = button.dataset.view; spinning = false;
    if (you) { you.yaw = VIEWS[view]; you.frame(0, false); }
    updateView();
  });
}
document.querySelector('#spin').addEventListener('click', () => {
  spinning = !spinning; if (spinning) view = null; updateView();
});

function loop(t) {
  // Static test checkpoints; browser callbacks remain normal for pointer events.
  if (window.__TPT_TEST_MODE__) return;
  requestAnimationFrame(loop);
  if (!you) return;
  const dt = last ? Math.min((t - last) / 1000, 0.1) : 0;
  last = t;
  you.frame(dt, spinning && drag == null);
}
requestAnimationFrame(loop);
show(character);

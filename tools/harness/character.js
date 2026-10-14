// The loading screen's player (src/ui/youViewer.js), kept here so a character
// can be looked at without booting a map. ?character=woman opens on her.
import { createYou, YOU_DRAG, YOU_YAW } from '/src/ui/youViewer.js';
import { nextYouZoom } from '/src/pov/character.js';

const CHARACTERS = ['woman', 'real', 'stick', 'spartan', 'boy', 'girl'];
const picked = new URLSearchParams(location.search).get('character');
let character = CHARACTERS.includes(picked) ? picked : 'woman';
let canvas = document.querySelector('#view');
let you = null, drag = null, last = 0, epoch = 0;
const err = document.querySelector('#err');

function size(target) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  target.width = Math.round(innerWidth * dpr);
  target.height = Math.round(innerHeight * dpr);
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
      canvas: nextCanvas, width: nextCanvas.width, height: nextCanvas.height, character: next, yaw: YOU_YAW,
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
  const url = new URL(location.href);
  url.searchParams.set('character', character);
  history.replaceState(null, '', url);
  for (const button of document.querySelectorAll('[data-character]')) {
    button.setAttribute('aria-pressed', String(button.dataset.character === character));
  }
}

addEventListener('pointerdown', (e) => {
  if (!you || e.button !== 0 || e.target !== canvas) return;
  drag = { x: e.clientX, yaw: you.yaw };
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

function loop(t) {
  requestAnimationFrame(loop);
  if (!you) return;
  const dt = last ? Math.min((t - last) / 1000, 0.1) : 0;
  last = t;
  you.frame(dt, drag == null);
}
requestAnimationFrame(loop);
show(character);

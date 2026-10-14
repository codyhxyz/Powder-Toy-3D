// The loading screen's live player (ui/youViewer.js) in a worker, drawing on
// the OffscreenCanvas the menu hands it (ui/menu.js): its frames go on while
// the page itself is held by the boot. Messages in:
//   { canvas, width, height, character }   build and draw one frame; posts 'ready' (or { failed })
//   { run: true|false }         breathe and turn, or stop
//   { drag: 'start'|'end' }, { dx }   a drag, dx CSS px from where it started
import { createYou, YOU_DRAG } from './youViewer.js';

const FRAME_MS = 1000 / 60;   // the frame's pace where a worker has no requestAnimationFrame
const tick = self.requestAnimationFrame
  ? (f) => self.requestAnimationFrame(f)
  : (f) => setTimeout(() => f(performance.now()), FRAME_MS);

let you = null, run = false, ticking = false, last = 0, held = null;
function loop(t) {
  if (!run) { ticking = false; return; }
  tick(loop);
  const dt = last ? (t - last) / 1000 : 0;
  last = t;
  you.frame(dt, held == null);
}
function start() {
  if (!you || !run || ticking) return;
  ticking = true;
  last = 0;
  tick(loop);
}

self.onmessage = async ({ data }) => {
  if (data.canvas) {
    try {
      you = await createYou({ canvas: data.canvas, width: data.width, height: data.height, character: data.character });
    } catch (err) {
      self.postMessage({ failed: String(err) });
      return;
    }
    you.frame();
    self.postMessage('ready');
    start();
  } else if ('run' in data) {
    run = data.run;
    start();
  } else if (data.drag === 'start') held = you?.yaw ?? null;
  else if (data.drag === 'end') held = null;
  else if ('dx' in data && you && held != null) you.yaw = held + data.dx * YOU_DRAG;
};

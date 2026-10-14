// Share the free camera's right button: erase only on a click's release.
// OrbitControls still owns pointer capture and every move once a drag starts.
const DRAG_PX = 6; // CSS pixels: tolerate a small hand/trackpad wobble.
export function bindBrushEraseClick(canvas, { canErase, erase }) {
  const view = canvas.ownerDocument.defaultView;
  let press = null;
  const cancel = () => { press = null; };
  const modified = e => e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
  const moved = e => Math.hypot(e.clientX - press.x, e.clientY - press.y) >= DRAG_PX;

  canvas.addEventListener('pointerdown', e => {
    press = e.button === 2 && e.buttons === 2 && !modified(e) && canErase()
      ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
  }, true);
  canvas.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.id) return;
    if (e.buttons !== 2 || modified(e) || moved(e) || !canErase()) { cancel(); return; }
    // Below the threshold, don't let OrbitControls turn a click into a tiny orbit.
    e.stopImmediatePropagation();
  }, true);
  view.addEventListener('pointerup', e => {
    if (!press || e.pointerId !== press.id) return;
    const click = e.button === 2 && !modified(e) && !moved(e) && canErase()
      && canvas.ownerDocument.elementFromPoint(e.clientX, e.clientY) === canvas;
    cancel(); // a drag that returned to its start can never become a click again
    if (click) erase(e);
  }, true);
  for (const type of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(type, cancel);
  for (const type of ['blur', 'keydown', 'wheel']) view.addEventListener(type, cancel, true);
}

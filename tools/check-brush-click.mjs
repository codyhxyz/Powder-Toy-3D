// The click/drag gate uses real EventTargets, without a GPU or a browser.
import assert from 'node:assert/strict';
import { bindBrushEraseClick } from '../src/brushInput.js';

const canvas = new EventTarget(), view = new EventTarget();
let allowed = true, overCanvas = true, erases = 0, moves = 0;
canvas.ownerDocument = { defaultView: view, elementFromPoint: () => overCanvas ? canvas : null };
bindBrushEraseClick(canvas, { canErase: () => allowed, erase: () => erases++ });
canvas.addEventListener('pointermove', () => moves++); // OrbitControls' bubble listener
const send = (type, patch = {}) => {
  const e = Object.assign(new Event(type), {
    button: 2, buttons: type === 'pointerup' ? 0 : 2,
    pointerId: 1, clientX: 100, clientY: 100, ...patch,
  });
  (['pointerup', 'blur', 'keydown', 'wheel'].includes(type) ? view : canvas).dispatchEvent(e);
};

send('pointerdown');
assert.equal(erases, 0, 'pressing/holding never erases');
send('pointermove', { clientX: 103, clientY: 102 });
assert.equal(moves, 0, 'small hand wobble cannot orbit');
send('pointerup', { clientX: 103, clientY: 102 });
assert.equal(erases, 1, 'a click erases once, on release');
send('pointerup');
assert.equal(erases, 1, 'duplicate release does not erase again');

send('pointerdown');
send('pointermove', { clientX: 106 });
assert.equal(moves, 1, 'crossing the threshold passes the move to OrbitControls');
send('pointermove');
send('pointerup');
assert.equal(erases, 1, 'dragging back to the start still never erases');

for (const modifier of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey']) {
  send('pointerdown', { [modifier]: true });
  send('pointerup');
  send('pointerdown');
  send('pointerup', { [modifier]: true });
}
for (const type of ['pointercancel', 'lostpointercapture', 'blur', 'keydown', 'wheel']) {
  send('pointerdown');
  send(type);
  send('pointerup');
}
send('pointerdown');
send('pointermove', { buttons: 3 });
send('pointerup');
send('pointerdown');
send('pointerup', { clientX: 110 }); // even if no move event arrived
send('pointerdown');
overCanvas = false;
send('pointerup');
overCanvas = true;
send('pointerdown');
allowed = false;
send('pointerup'); // entered first person or a blocked mode while holding
send('pointerdown');
send('pointermove');
send('pointerup'); // first person owns this entire gesture
allowed = true;
assert.equal(erases, 1, 'modifiers, cancellations, chords, outside releases and blocked modes never erase');
send('pointerdown');
send('pointerup', { pointerId: 2 });
assert.equal(erases, 1, 'another pointer cannot release the click');
send('pointerup');
assert.equal(erases, 2, 'the owning pointer can still release');
console.log('ok: click-on-release, drag threshold, camera jitter, cancellation and first-person isolation');

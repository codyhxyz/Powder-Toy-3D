import { h } from '../ui/dom.js';
import { gearByKey } from './tools/catalog.js';

// Touch controls for first person on phones and tablets (docs/pov.md, "Touch
// controls"). Nothing here moves the body or fires a tool: the stick, the look
// drag and the buttons fill the same inputs the keyboard and mouse do (index.js
// readInput, buttons, wheelNotches), so walking, driving and every tool behave
// exactly as on desktop. Shown only under TOUCH_MEDIA, so desktop is untouched.
//
// Left thumb: the move stick (pushed to its rim it runs, as a stick does in
// most phone shooters). Right thumb: the held tool's buttons, named by its
// catalog entry (tools/catalog.js `touch`), and jump (hold to fly), crouch or
// dive, kick and the vehicle. A drag anywhere else on the scene looks around;
// a look drag never fires a tool.

export const TOUCH_MEDIA = '(hover: none) and (pointer: coarse)';
const DEFAULT_ACTIONS = ['Use', 'Other'];   // a tool with no catalog `touch` entry
const STICK_REACH = 0.65;   // share of the stick's radius a thumb travels for full deflection
const STICK_DEAD = 0.12;    // deflection below this is no move (a resting thumb)
const STICK_RUN = 0.9;      // deflection past this sprints
const KNOB_TRAVEL = 0.55;   // share of the radius the knob moves at full deflection
const LOOK_GAIN = 1;        // look-drag px per mouse-movement px (the Sensitivity setting applies on top)

// opts: canvas, active () => bool (the body is live), turn(dx, dy) (mouse-movement px),
//       button(name, down, cancelled) ('primary' | 'secondary'), wheel(notches),
//       kick(), useVehicle()
export function createTouchControls({ canvas, active, turn, button, wheel, kick, useVehicle }) {
  const media = matchMedia(TOUCH_MEDIA);
  const state = { x: 0, z: 0, jump: false, down: false, sprint: false };
  const knob = h('span.touch-knob');
  const stick = h('div.touch-stick', { role: 'group', 'aria-label': 'Drag to move; drag to the edge to run' },
    h('span.touch-move-label', { text: 'Move' }), knob);
  const btn = (text, cls = '') => h(`button${cls}`, { type: 'button', text });
  const primary = btn('', '.touch-primary');
  const secondary = btn('');
  const jump = btn('Jump / fly');
  const down = btn('Crouch');
  const kicker = btn('Kick');
  const vehicle = btn('Vehicle');
  const nearer = btn('Nearer');
  const farther = btn('Farther');
  const distance = h('div.touch-row.touch-distance', {}, nearer, farther);
  const name = h('div.touch-tool-name');
  const tool = h('div.touch-row', {}, secondary, primary);
  const root = h('div.pov-touch', { 'aria-label': 'Touch controls' },
    stick, h('div.touch-actions', {}, name, distance, tool,
      h('div.touch-row', {}, vehicle, kicker), h('div.touch-row', {}, down, jump)));
  document.body.append(root);

  // One pointer per control, captured, so a thumb sliding off still holds it.
  const held = new Map();   // control → its release
  function bind(el, start, move, end) {
    let id = null;
    const release = (cancelled = false) => {
      if (id === null) return;
      const old = id;
      id = null;
      held.delete(el);
      end?.(cancelled);
      el.classList.remove('held');
      if (el.hasPointerCapture(old)) el.releasePointerCapture(old);
    };
    el.addEventListener('pointerdown', (e) => {
      if (!media.matches || !active() || id !== null || (el === canvas && e.pointerType !== 'touch')) return;
      e.preventDefault();   // no compatibility mouse events (the canvas's would ask for pointer lock)
      id = e.pointerId;
      held.set(el, release);
      el.setPointerCapture(id);
      el.classList.add('held');
      start(e);
    });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === id) move?.(e); });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      el.addEventListener(type, (e) => { if (e.pointerId === id) release(type !== 'pointerup'); });
    }
  }

  // the look: a drag on the scene turns the view as mouse movement does
  let lookX = 0, lookY = 0;
  bind(canvas, (e) => { lookX = e.clientX; lookY = e.clientY; }, (e) => {
    turn((e.clientX - lookX) * LOOK_GAIN, (e.clientY - lookY) * LOOK_GAIN);
    lookX = e.clientX; lookY = e.clientY;
  });

  // the stick: x right, z forward, each −1..1 (the keys' W/S and A/D, but analog)
  function steer(e) {
    const r = stick.getBoundingClientRect(), radius = r.width / 2;
    const x = (e.clientX - r.left - radius) / (radius * STICK_REACH);
    const z = (r.top + radius - e.clientY) / (radius * STICK_REACH);
    const length = Math.hypot(x, z), scale = Math.max(1, length);
    const moving = length >= STICK_DEAD;
    state.x = moving ? x / scale : 0;
    state.z = moving ? z / scale : 0;
    state.sprint = length > STICK_RUN;
    knob.style.transform = `translate(${state.x * radius * KNOB_TRAVEL}px, ${-state.z * radius * KNOB_TRAVEL}px)`;
  }
  bind(stick, steer, steer, () => {
    state.x = state.z = 0; state.sprint = false;
    knob.style.transform = '';
  });

  bind(primary, () => button('primary', true), null, (cancelled) => button('primary', false, cancelled));
  bind(secondary, () => button('secondary', true), null, (cancelled) => button('secondary', false, cancelled));
  bind(jump, () => { state.jump = true; }, null, () => { state.jump = false; });
  bind(down, () => { state.down = true; }, null, () => { state.down = false; });
  bind(kicker, () => kick());
  bind(vehicle, () => useVehicle());
  bind(nearer, () => wheel(1));    // +1: the wheel rolled toward you (physgun.tool.js: pulls the hold in)
  bind(farther, () => wheel(-1));

  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  const setHidden = (el, v) => { if (el.hidden !== v) el.hidden = v; };
  const reset = () => { for (const release of [...held.values()]) release(true); };
  media.addEventListener('change', reset);
  let lastTool, lastShown = false;
  return {
    state, reset,
    get enabled() { return media.matches; },
    // every frame: s = { live, tool (the held key), inLiquid, wantsWheel, driving, vehicles (any about) }
    update(s) {
      if (s.live !== lastShown) {
        lastShown = s.live;
        root.classList.toggle('show', s.live);
        if (!s.live) reset();
      }
      if (!s.live) return;
      const toolKey = s.driving ? null : s.tool;
      if (toolKey !== lastTool) {
        lastTool = toolKey;
        const g = gearByKey(toolKey);
        const [a, b] = toolKey ? g?.touch ?? DEFAULT_ACTIONS : [];
        setText(name, g?.name ?? '');
        setText(primary, a ?? '');
        setText(secondary, b ?? '');
        primary.hidden = !a;
        secondary.hidden = !b;
        if (!a) held.get(primary)?.(true);
        if (!b) held.get(secondary)?.(true);
      }
      // (only what changed is written: this runs every frame)
      setText(down, s.inLiquid ? 'Dive' : 'Crouch');
      setText(jump, s.driving ? 'Brake' : 'Jump / fly');
      setText(vehicle, s.driving ? 'Get out' : 'Vehicle');
      setHidden(down, s.driving);
      setHidden(kicker, s.driving);
      setHidden(vehicle, !s.vehicles);
      setHidden(distance, !s.wantsWheel || s.driving);
    },
  };
}

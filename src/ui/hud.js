import { h } from './dom.js';
import { ICON } from './icons.js';
import { CLASSES_ENABLED } from '../pov/classes.js';
import { createNotices } from './notices.js';

export function createHud() {
  // stats below the toolbar
  const fps = h('b'), cells = h('b'), steps = h('b'), res = h('b');
  const fpsUnit = document.createTextNode(' fps');
  // replace mode or specific delete, as TPT's HUD line says [REPLACE MODE] (GameView.cpp)
  const editMode = h('span.edit-mode');
  const stats = h('div.stats', {}, h('span', {}, fps, fpsUnit), h('span', {}, steps, ' steps/s'), h('span', {}, cells, ' cells'), h('span', {}, res), editMode);

  // hover readout (follows the cursor)
  const chip = h('i'), name = h('b'), temp = h('span'), pres = h('span');
  const readout = h('div.readout', {}, chip, name, temp, pres);

  const toasts = h('div.toasts');
  const TOUCH_FIRST = matchMedia('(hover: none) and (pointer: coarse)').matches;
  const hint = h('div.hint.panel', { html: TOUCH_FIRST
    ? '<b>Drag</b> to pour. <b>Two fingers</b> to turn and zoom.'
    : '<b>Drag</b> to pour. <b>Right-drag</b> to erase. <b>Alt-drag</b> to look around. Press <b>?</b> for shortcuts.' });

  // colour key for data views (heat, pressure, ...); hidden in the realistic view
  const legendBox = h('div.legend-box.panel', { 'aria-live': 'polite' });

  document.body.append(stats, readout, toasts, hint, legendBox);
  const notices = createNotices(toasts);

  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  const READOUT_DX = 16, READOUT_DY = 14;   // px: the hover readout sits below-right of the pointer
  const PRESSURE_SHOWN = 0.05;              // the readout lists pressure from this much on

  let hintTimer = setTimeout(() => hint.classList.add('gone'), 12000);

  return {
    // called every frame: only touch the DOM when a value changes (each write re-lays out the HUD)
    setStats({ fpsV, stepsV, cellsV, resV }) {
      // null fps: nothing is being drawn (a paused, still scene)
      setText(fps, fpsV == null ? 'idle' : fpsV.toFixed(0));
      setText(fpsUnit, fpsV == null ? '' : ' fps');
      setText(steps, stepsV.toFixed(0));
      setText(cells, cellsV);
      setText(res, resV);
    },
    showReadout(x, y, info) {
      if (!info) { readout.style.display = 'none'; return; }
      readout.style.display = 'flex';
      readout.style.transform = `translate(${x + READOUT_DX}px, ${y + READOUT_DY}px)`;
      readout.style.left = '0'; readout.style.top = '0';
      chip.style.background = info.color;
      setText(name, info.name);
      setText(temp, info.T == null ? (info.note ?? '') : `${info.T.toFixed(1)} °C`);
      setText(pres, info.P != null && Math.abs(info.P) >= PRESSURE_SHOWN ? `pressure ${info.P.toFixed(1)}` : '');
    },
    // a notice, GMod's (notices.js): opts { kind: 'generic' | 'error' | 'undo' | 'hint' | 'cleanup',
    // ms (default: the kind's length), icon }, or a number: ms
    toast(text, opts) { return notices.add(text, typeof opts === 'number' ? { ms: opts } : opts); },
    dismissHint() { clearTimeout(hintTimer); hint.classList.add('gone'); },
    setEditMode(text) { setText(editMode, text ?? ''); },
    setLegend(view) {
      const bars = [view?.legend, view?.legend2].filter(Boolean);
      legendBox.classList.toggle('show', bars.length > 0);
      legendBox.replaceChildren(...bars.map((l, i) => h('div.legend-row', {},
        h('div.legend-title', {}, h('span', { text: l.title ?? view.name }), i === 0 ? h('kbd', { text: view.hotkey }) : null),
        h('div.legend', { style: { background: l.css } }),
        h('div.legend-labels', {}, (l.labels ?? []).map(([txt]) => h('span', { text: txt }))))));
    },
  };
}

// Keyboard shortcut sheet.
export function createHelp(onClose) {
  const k = (...keys) => h('span', {}, keys.map((x) => h('kbd', { text: x })));
  const row = (label, ...keys) => h('div.key', {}, h('span', { text: label }), k(...keys));
  const el = h('div.modal-scrim', { on: { click: (e) => { if (e.target === el) onClose(); } } },
    h('div.help.panel', { role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
      h('header', {}, h('h2', { text: 'Shortcuts' }),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Close', html: ICON.close, on: { click: onClose } })),
      h('div.cols', {},
        h('h3', { text: 'Painting' }),
        row('Paint', 'Left drag'),
        row('Erase', 'Right drag'),
        row('Brush size', '[', ']'),
        row('Brush size', 'Shift', 'Scroll'),
        row('Sphere or cube brush', 'B'),
        row('Line (TPT\'s Shift-drag)', 'Shift', 'Left drag'),
        row('Box: brush-tall, between the corners', '⌘', 'Left drag'),
        row('Fill: open air up to the brush top, or what you click', '⌘', 'Shift', 'Click'),
        row('Replace mode: paint over material', 'X'),
        row('Specific delete: erase only the target', 'Delete'),
        row('Target for both: an element tile', '⌥', 'Click'),
        row('Target: the element under the cursor', '⌥', 'I'),
        row('Property tool: set a value under the brush', '⌘', 'P'),
        row('Show or hide decoration (the Deco tab\'s paint)', 'Ctrl', 'B'),
        row('Eyedropper: pick element under cursor', 'I'),
        row('Undo last change', '⌘', 'Z'),
        row('Find an element', '/'),
        h('h3', { text: 'Camera' }),
        row('Orbit', '⌥ / Alt', 'Left drag'),
        row('Pan', 'Shift', 'Right drag'),
        row('Zoom', 'Scroll'),
        row('Move', 'W', 'A', 'S', 'D'),
        row('Turn left / right', 'E', 'Q'),
        row('Move faster', 'Shift'),
        row('Reset camera', 'R'),
        h('h3', { text: 'First person' }),
        row('God view, or back in the body', 'V'),
        row('Look around', 'Mouse'),
        row('Walk', 'W', 'A', 'S', 'D'),
        row('Jump or swim up', 'Space'),
        row('Sprint (hold, or toggle in settings)', 'Shift'),
        row('Crouch (swim down in liquid)', 'C'),
        row('Kick: shove, break glass, kick off walls', 'F'),
        row('Zoom (hold; scroll to zoom further)', 'Z'),
        row('Use tool / its other action', 'Left', 'Right'),
        row('Pick a tool slot; again for the next in it', '1', '–', '6'),
        row('Spawn menu: a tool, or anything to spawn with the tool gun', 'Q'),
        row('Tool gun: pick up what you aim at', 'Middle'),
        row('Drink from the flask', 'H'),
        row('First or third person', 'F5 or Ctrl'),
        row('Get in or out of a vehicle (drive: W A S D, Space, Shift)', 'E'),
        CLASSES_ENABLED ? row('Choose a class, in Siege (Team Fortress 2\'s key)', ',') : null,
        row('Hide the HUD and hand', 'F1'),
        row('Free the mouse', 'Esc'),
        h('h3', { text: 'Simulation and interface' }),
        row('Pause or resume', 'Space'),
        row('Step one frame', '.'),
        row('Air mode: on, pressure off, velocity off, off, no update', 'Y'),
        row('Ambient heat on or off (gravity and edges: Settings)', 'U'),
        row('Switch view', '1', '–', '5'),
        row('Show or hide elements', 'T'),
        row('Chat, when playing together', 'T'),
        row(CLASSES_ENABLED ? 'Settings (in Siege, the gear)' : 'Settings', ','),
        row('Screenshot', 'P'),
        row('Scoreboard (hold)', 'Tab'),
        row('Save the game (in the body, ⌘ only)', '⌘', 'S'),
        row('Saves: load one, export it, open a file', '⌘', 'O'),
        row('Lua console, TPT\'s (scripts run every step: event.register)', '`'),
        row('Close menus; with none open, the map menu', 'Esc'),
      ),
      h('p', { text: 'Signs can show live values: write {t} for temperature, {p} for pressure and {e} for the element under the sign.' }),
      h('p', { text: 'Tools from The Powder Toy: Wind blows the way you drag the brush, Cyclone spins air and matter around it, Mix shuffles what is inside it, PGRV and NGRV pull matter in or push it out while held, and AMBP and AMBM warm or cool only the air.' }),
      h('p', { text: 'Deco (as in The Powder Toy) paints a colour onto matter: pick the colour and its alpha in the spawn menu. Paint moves with the matter and lasts through melting and burning; the brush, a construction or emptying a cell wipes it.' })));
  document.body.append(el);
  return {
    setOpen: (v) => el.classList.toggle('open', v),
    get isOpen() { return el.classList.contains('open'); },
  };
}

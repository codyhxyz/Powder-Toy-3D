import { h } from './dom.js';
import { ICON } from './icons.js';
import { CLASSES_ENABLED } from '../pov/classes.js';
import { KEYS, keycaps, label, slotKey, MOD, ALT } from '../keys.js';
import { VIEWS } from '../views.js';
import { SLOTS } from '../pov/tools/catalog.js';
import { createNotices } from './notices.js';

export function createHud({ onTogglePause }) {
  // Playback shares the bottom-right fps strip (steps/s, cells and resolution are the profiler's).
  const fps = h('b', { text: '–' });
  // replace mode or specific delete, as TPT's HUD line says [REPLACE MODE] (GameView.cpp)
  const editMode = h('span.edit-mode');
  const stats = h('div.stats', {}, h('span', {}, fps, ' fps'), editMode);
  const pause = h('button.icon-btn.pause-btn', { type: 'button', on: {
    click: onTogglePause,
    keydown: e => { if (e.code === 'Space' || e.code === 'Enter') e.stopPropagation(); },
  } });
  stats.append(pause);

  // hover readout (follows the cursor)
  const chip = h('i'), name = h('b'), temp = h('span'), pres = h('span');
  const readout = h('div.readout', {}, chip, name, temp, pres);

  const toasts = h('div.toasts');

  // colour key for data views (heat, pressure, ...); hidden in the realistic view
  const legendBox = h('div.legend-box.panel', { 'aria-live': 'polite' });

  document.body.append(stats, readout, toasts, legendBox);
  const notices = createNotices(toasts);

  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  const READOUT_DX = 16, READOUT_DY = 14;   // px: the hover readout sits below-right of the pointer
  const PRESSURE_SHOWN = 0.05;              // the readout lists pressure from this much on

  return {
    setPaused(paused) {
      pause.innerHTML = paused ? ICON.play : ICON.pause;
      pause.title = `${paused ? 'Resume' : 'Pause'} (${label(KEYS.escape)})`;
      pause.setAttribute('aria-label', pause.title);
      pause.classList.toggle('on', paused);
    },
    // called every frame: only touch the DOM when a value changes (each write re-lays out the HUD)
    // fpsV: the last measured rate, kept while nothing draws (app.js countHudRates); null before the first
    setStats({ fpsV }) {
      setText(fps, fpsV == null ? '–' : fpsV.toFixed(0));
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

// Controls sheet: the basics a first-time player needs, then every shortcut. The
// keys are keys.js's, the ones the handlers listen for; mouse buttons are named in words.
export function createHelp(onClose) {
  const SLASH = { sep: '/' };
  // a part: a binding from KEYS (its chords, 'or' between), a mouse word, or SLASH
  const part = (p) => (Array.isArray(p)
    ? keycaps(p).flatMap((caps, i) => [i ? h('span.key-sep', { text: 'or' }) : null, ...caps.map((c) => h('kbd', { text: c }))])
    : p.sep ? [h('span.key-sep', { text: p.sep })] : [h('kbd', { text: p })]);
  const row = (text, ...parts) => h('div.key', {}, h('span', { text }), h('span', {}, parts.flatMap(part)));
  const move = [KEYS.forward, KEYS.left, KEYS.back, KEYS.right];
  const views = VIEWS.map((v) => v.hotkey).sort();
  const slots = SLOTS.map((_, i) => slotKey(i));
  const el = h('div.modal-scrim', { on: { click: (e) => { if (e.target === el) onClose(); } } },
    h('div.help.panel', { role: 'dialog', 'aria-label': 'Controls' },
      h('header', {}, h('h2', { text: 'Controls' }),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Close', html: ICON.close, on: { click: onClose } })),
      h('div.cols', {},
        h('h3', { text: 'Basics' }),
        row('Paint', 'Left drag'),
        row('Erase', 'Right click'),
        row('Brush size', KEYS.brushSmaller, KEYS.brushBigger),
        row('Find an element', KEYS.find),
        row('Look around', 'Right drag'),
        row('Fly', ...move),
        row('Fly up / down', KEYS.flyUp, SLASH, KEYS.flyDown),
        row('Pause or resume (Sandbox)', KEYS.escape),
        row('Undo', KEYS.undo),
        row('Walk around in first person', KEYS.firstPerson),
        row('This sheet', KEYS.help),
        h('h3', { text: 'Painting' }),
        row('Paint', 'Left drag'),
        row('Erase on release (drag instead to look around)', 'Right click'),
        row('Brush size', KEYS.brushSmaller, KEYS.brushBigger),
        row('Brush size', 'Shift', 'Scroll'),
        row('Sphere or cube brush', KEYS.brushShape),
        row('Line (TPT\'s Shift-drag)', 'Shift', 'Left drag'),
        row('Box: brush-tall, between the corners', MOD, 'Left drag'),
        row('Fill: open air up to the brush top, or what you click', MOD, 'Shift', 'Click'),
        row('Replace mode: paint over material', KEYS.replaceMode),
        row('Specific delete: erase only the target', KEYS.specificDelete),
        row('Target for both: an element tile', ALT, 'Click'),
        row('Target: the element under the cursor', KEYS.target),
        row('Property tool: set a value under the brush', KEYS.property),
        row('Show or hide decoration (the Deco tab\'s paint)', KEYS.deco),
        row('Eyedropper: pick element under cursor', KEYS.eyedropper),
        row('Undo last change', KEYS.undo),
        row('Find an element', KEYS.find),
        h('h3', { text: 'Camera' }),
        row('Look around (hold; Roblox Studio\'s)', 'Right drag'),
        row('Fly where you look (Garry\'s Mod\'s noclip)', ...move),
        row('Fly up / down (Rust\'s noclip; E and Q, Roblox Studio\'s)', KEYS.flyUp, SLASH, KEYS.flyDown),
        row('Fly faster', KEYS.fast),
        row('Fly speed (Unreal\'s)', 'Hold right', 'Scroll'),
        row('Fly to what\'s under the cursor (Roblox Studio\'s focus)', KEYS.focus),
        row('Orbit around what you click (Blender\'s; trackpad too)', ALT, 'Drag'),
        row('Pan', 'Shift', 'Right drag'),
        row('Pan', 'Middle drag'),
        row('Zoom toward the cursor (Roblox Studio\'s, Blender\'s)', 'Scroll'),
        row('Reset camera', KEYS.resetCamera),
        h('h3', { text: 'First person' }),
        row('God view, or back in the body', KEYS.firstPerson),
        row('Look around', 'Mouse'),
        row('Walk', ...move),
        row('Jump or swim up', KEYS.jump),
        row('Sprint (hold, or toggle in settings)', KEYS.fast),
        row('Crouch (swim down in liquid)', KEYS.crouch),
        row('Kick: shove, break glass, kick off walls (Halo\'s melee in a match)', KEYS.kick),
        row('Zoom (hold; scroll to zoom further)', KEYS.zoom),
        row('Use tool / its other action', 'Left', 'Right'),
        row('Pick a tool slot; again for the next in it', slots[0], { sep: '–' }, slots[slots.length - 1]),
        row('Spawn menu (Garry\'s Mod\'s key; in Factory, Build)', KEYS.toolMenu),
        row('Tool gun: pick up what you aim at', 'Middle'),
        row('Tool gun: erase under the crosshair', 'Right'),
        row('Drink from the flask', KEYS.drink),
        row('First or third person', KEYS.view, { sep: 'or' }, KEYS.viewTap),
        row('Get in or out of a vehicle, pick up, buy', KEYS.use),
        row('Drive', ...move, KEYS.jump, KEYS.fast),
        row('Throw a grenade, in Halo', KEYS.grenade),
        row('Edit your wand, in Noita', KEYS.editWand),
        CLASSES_ENABLED ? row('Choose a class, in Siege (Team Fortress 2\'s key)', KEYS.classPicker) : null,
        row('Switch team, in a team match', KEYS.switchTeam),
        row('Hide the HUD and hand', KEYS.hideHud),
        row('Free the mouse', KEYS.escape),
        h('h3', { text: 'Simulation and interface' }),
        row('Pause or resume (Sandbox; in a gamemode, the menu)', KEYS.escape),
        row('Step one frame', KEYS.step),
        row('Air mode: on, pressure off, velocity off, off, no update', KEYS.airMode),
        row('Ambient heat on or off (gravity and edges: Settings)', KEYS.ambientHeat),
        row('Switch view', ...views),
        row('Hide or show the spawn menu, or its button (in Factory, Build)', KEYS.spawnMenu),
        row('Chat, when playing together', KEYS.chat),
        row(CLASSES_ENABLED ? 'Settings (in Siege, the gear)' : 'Settings', KEYS.settings),
        row('Screenshot', KEYS.screenshot),
        row('Scoreboard (hold)', KEYS.scoreboard),
        row('Save the game (in the body, ⌘ only)', KEYS.save),
        row('Saves: load one, export it, open a file', KEYS.openSaves),
        row('Lua console, TPT\'s (scripts run every step: event.register)', KEYS.console),
        row('Close menus; with none open, pause (Sandbox) or the menu', KEYS.escape),
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

import { h } from './dom.js';
import { ICON } from './icons.js';

export function createHud() {
  // stats (bottom right)
  const fps = h('b'), cells = h('b'), steps = h('b'), res = h('b');
  const stats = h('div.stats', {}, h('span', {}, fps, ' fps'), h('span', {}, steps, ' steps/s'), h('span', {}, cells, ' cells'), h('span', {}, res));

  // hover readout (follows the cursor)
  const chip = h('i'), name = h('b'), temp = h('span'), pres = h('span');
  const readout = h('div.readout', {}, chip, name, temp, pres);

  // paused pill
  const pill = h('div.pill.panel', {}, h('span.dot'), 'Paused', h('kbd', { text: 'Space' }));
  const toasts = h('div.toasts');
  const hint = h('div.hint.panel', { html: '<b>Drag</b> on the floor to pour. <b>Right-drag</b> to look around. Press <b>?</b> for shortcuts.' });

  // colour key for data views (heat, pressure, ...); hidden in the realistic view
  const legendBox = h('div.legend-box.panel', { 'aria-live': 'polite' });

  document.body.append(stats, readout, pill, toasts, hint, legendBox);

  let hintTimer = setTimeout(() => hint.classList.add('gone'), 12000);

  return {
    setStats({ fpsV, stepsV, cellsV, resV }) {
      fps.textContent = fpsV.toFixed(0);
      steps.textContent = stepsV.toFixed(0);
      cells.textContent = cellsV;
      res.textContent = resV;
    },
    showReadout(x, y, info) {
      if (!info) { readout.style.display = 'none'; return; }
      readout.style.display = 'flex';
      readout.style.transform = `translate(${x + 16}px, ${y + 14}px)`;
      readout.style.left = '0'; readout.style.top = '0';
      chip.style.background = info.color;
      name.textContent = info.name;
      temp.textContent = `${info.T.toFixed(1)} °C`;
      pres.textContent = Math.abs(info.P) >= 0.05 ? `pressure ${info.P.toFixed(1)}` : '';
    },
    setPaused: (p) => pill.classList.toggle('show', p),
    toast(text) {
      const t = h('div.toast.panel', { text });
      toasts.append(t);
      setTimeout(() => t.remove(), 2300);
    },
    dismissHint() { clearTimeout(hintTimer); hint.classList.add('gone'); },
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
        row('Brush size', '[', ']'),
        row('Brush size', 'Shift', 'Scroll'),
        row('Sphere or cube brush', 'B'),
        row('Paint over existing material', 'X'),
        row('Pick element under cursor', 'I'),
        row('Undo last change', '⌘', 'Z'),
        row('Find an element', '/'),
        h('h3', { text: 'Camera' }),
        row('Orbit', 'Right drag'),
        row('Orbit (trackpad)', '⌥', 'Drag'),
        row('Pan', 'Shift', 'Right drag'),
        row('Zoom', 'Scroll'),
        row('Move', 'W', 'A', 'S', 'D'),
        row('Turn left / right', 'Q', 'E'),
        row('Move faster', 'Shift'),
        row('Reset camera', 'R'),
        h('h3', { text: 'Simulation and interface' }),
        row('Pause or resume', 'Space'),
        row('Step one frame', '.'),
        row('Switch view', '1', '–', '5'),
        row('Show or hide elements', 'T'),
        row('Settings', ','),
        row('Screenshot', 'P'),
        row('Close menus', 'Esc'),
      ),
      h('p', { text: 'Signs can show live values: write {t} for temperature, {p} for pressure and {e} for the element under the sign.' })));
  document.body.append(el);
  return {
    setOpen: (v) => el.classList.toggle('open', v),
    get isOpen() { return el.classList.contains('open'); },
  };
}

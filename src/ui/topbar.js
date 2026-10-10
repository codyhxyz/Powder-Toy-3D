import { h } from './dom.js';
import { ICON } from './icons.js';
import { logoMark } from './logo.js';

export function createBrand() {
  const el = h('div.brand', { html: `${logoMark(34)}<div class="word">Powder Toy 3D<small>Falling-sand physics on the GPU</small></div>` });
  document.body.append(el);
  return el;
}

const legendCSS = (legend) =>
  legend ? `linear-gradient(90deg, ${legend.stops.map(([t, c]) => `${c} ${(t * 100).toFixed(1)}%`).join(', ')})` : null;

// Top-right toolbar plus the views popover.
export function createToolbar({ views, settings, actions }) {
  const swatch = h('span.swatch');
  const viewName = h('span');
  const viewBtn = h('button.view-btn', { type: 'button', title: 'Change view', 'aria-haspopup': 'dialog' },
    swatch, viewName, h('kbd'), h('span', { html: ICON.chevDown }));
  const kbd = viewBtn.querySelector('kbd');

  const btn = (icon, title, fn) => h('button.icon-btn', { type: 'button', title, 'aria-label': title, html: ICON[icon], on: { click: fn } });
  const pause = btn('pause', 'Pause (Space)', actions.togglePause);
  const undo = btn('undo', 'Undo (⌘Z)', actions.undo);
  const recenter = btn('recenter', 'Reset camera (R)', actions.resetCamera);
  // Camera: god view, or walking in first or third person; one click each (V and F do the same)
  const camOpt = (id, label, title) => h('button', { type: 'button', title, 'data-cam': id, on: { click: () => actions.setCamera(id) } }, label);
  const walk = h('div.seg.cam-seg', { role: 'group', 'aria-label': 'Camera' },
    h('span.ico', { html: ICON.person }),
    camOpt('god', 'God', 'God view: build and pour (V: noclip)'),
    camOpt('first', '1st', 'Walk in first person (V)'),
    camOpt('third', '3rd', 'Walk in third person (F swaps)'));
  const shot = btn('camera', 'Save screenshot (P)', actions.screenshot);
  const maps = btn('maps', 'Maps and gamemodes (Esc)', actions.openMenu);
  const gear = btn('gear', 'Settings (,)', actions.toggleSettings);
  const help = btn('help', 'Keyboard shortcuts (?)', actions.toggleHelp);
  // first person and the shortcut sheet need a keyboard: touch-first devices hide them (styles.css)
  walk.classList.add('keys-only');
  help.classList.add('keys-only');

  const bar = h('div.toolbar.panel', {}, viewBtn, h('span.sep'), pause, undo, recenter, walk, shot, h('span.sep'), maps, gear, help);

  // ---- views popover ----
  const cards = views.map((v) => {
    const canvas = h('canvas', { width: 320, height: 200 });
    const legend = v.legend ? [
      h('div.legend', { style: { background: legendCSS(v.legend) } }),
      v.legend.labels ? h('div.legend-labels', {}, v.legend.labels.map(([txt]) => h('span', { text: txt }))) : null,
    ] : null;
    const card = h('button.view-card', { type: 'button', on: { click: () => { actions.setView(v.id); close(); } } },
      h('div.thumb', {}, canvas, h('kbd', { text: v.hotkey })),
      h('div.name', {}, h('span', { text: v.name })),
      h('div.desc', { text: v.desc }),
      legend);
    return { v, card, canvas };
  });
  const pop = h('div.popover.views.panel', { role: 'dialog', 'aria-label': 'Views' },
    h('header', {}, h('h2', { text: 'Views' }), h('p', {}, 'Number keys switch views')),
    h('div.view-grid', {}, cards.map((c) => c.card)));

  document.body.append(bar, pop);

  let isOpen = false;
  function open() {
    isOpen = true;
    pop.classList.add('open');
    sync();
    // render live thumbnails of the current scene, one per frame so it stays smooth
    let i = 0;
    const next = () => {
      if (!isOpen || i >= cards.length) return;
      actions.renderThumb(cards[i].v.id, cards[i].canvas);
      i++;
      requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }
  function close() { isOpen = false; pop.classList.remove('open'); }
  viewBtn.addEventListener('click', (e) => { e.stopPropagation(); isOpen ? close() : open(); });
  addEventListener('pointerdown', (e) => { if (isOpen && !pop.contains(e.target) && !viewBtn.contains(e.target)) close(); });

  function sync() {
    const v = views.find((x) => x.id === settings.view) ?? views[0];
    viewName.textContent = v.name;
    kbd.textContent = v.hotkey;
    const thumb = cards.find((c) => c.v.id === v.id)?.canvas;
    swatch.style.background = legendCSS(v.legend) ?? 'linear-gradient(135deg, #dcbc74, #2a78d4)';
    if (thumb?.dataset.rendered) swatch.style.background = `center / cover url(${thumb.toDataURL()})`;
    for (const c of cards) c.card.classList.toggle('on', c.v.id === v.id);
    pause.innerHTML = settings.paused ? ICON.play : ICON.pause;
    pause.title = settings.paused ? 'Resume (Space)' : 'Pause (Space)';
    pause.classList.toggle('on', settings.paused);
  }

  return {
    sync,
    open, close,
    get isOpen() { return isOpen; },
    // 'god' | 'first' | 'third'
    setCamera(id) {
      for (const b of walk.querySelectorAll('button')) b.classList.toggle('on', b.dataset.cam === id);
    },
    setSettingsOpen: (v) => gear.classList.toggle('on', v),
    setUndoEnabled: (v) => { undo.disabled = !v; undo.style.opacity = v ? 1 : 0.4; },
  };
}

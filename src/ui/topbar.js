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

// Top-right toolbar plus the views popover. available: what this build can
// do yet ({ camera: the first- and third-person cameras, saves: Save }); what
// it can't is greyed out (app.js: src/wire's subsystems not ported yet).
export function createToolbar({ views, settings, actions, available = {} }) {
  const swatch = h('span.swatch');
  const viewName = h('span.view-name');
  const viewBtn = h('button.view-btn', { type: 'button', title: 'Change view', 'aria-haspopup': 'dialog' },
    swatch, viewName, h('span', { html: ICON.chevDown }));

  const btn = (icon, title, fn) => h('button.icon-btn', { type: 'button', title, 'aria-label': title, html: ICON[icon], on: { click: fn } });
  const pause = btn('pause', 'Pause (Space)', actions.togglePause);
  pause.classList.add('pause-btn');
  const pauseIcon = h('span', { 'aria-hidden': 'true' });
  const pauseLabel = h('span.pause-label');
  pause.replaceChildren(pauseIcon, pauseLabel);
  const undo = btn('undo', 'Undo (⌘Z)', actions.undo);
  const recenter = btn('recenter', 'Reset camera (R)', actions.resetCamera);
  // Camera: god view, or walking in first or third person; one click each (V and F5 do the same)
  const camOpt = (id, label, title) => h('button', { type: 'button', title, 'data-cam': id, on: { click: () => actions.setCamera(id) } }, label);
  const walk = h('div.cam-seg', { role: 'group', 'aria-label': 'Camera' },
    camOpt('god', 'God', 'God view: build and pour (V)'),
    camOpt('first', '1st', 'Walk in first person (V)'),
    camOpt('third', '3rd', 'Walk in third person (F5 or Ctrl swaps)'));
  const shot = btn('camera', 'Save screenshot (P)', actions.screenshot);
  // Save the game into the Saves list (Esc → Saves loads it), Garry's Mod's Save in its spawn menu's Saves
  const saveGame = btn('save', 'Save the game (⌘S)', () => actions.saveGame());
  const maps = btn('maps', 'Maps and gamemodes (Esc)', actions.openMenu);
  const gear = btn('gear', 'Settings (,)', actions.toggleSettings);
  const help = btn('help', 'Keyboard shortcuts (?)', actions.toggleHelp);
  // the shortcut sheet needs a keyboard: touch-first devices hide it (styles.css); the
  // cameras stay, first person having thumb controls there (pov/touch.js)
  help.classList.add('keys-only');

  const unavailable = (el, what) => {
    el.disabled = true;
    el.style.opacity = 0.4;
    el.title = `${what}: not in this WebGPU version yet`;   // (app.js notYet)
  };
  if (available.camera === false) for (const b of walk.querySelectorAll('button[data-cam="first"], button[data-cam="third"]')) unavailable(b, 'Walking in first or third person');
  if (available.saves === false) unavailable(saveGame, 'Saving the game');

  const bar = h('div.toolbar.panel', { role: 'group', 'aria-label': 'Simulation controls' },
    pause, h('span.sep'), viewBtn, walk, h('span.sep'), undo, recenter, saveGame, shot, maps, gear, help);

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
    viewBtn.setAttribute('aria-expanded', 'true');
    pop.classList.add('open');
    sync();
    // render live thumbnails of the current scene, one at a time so it stays
    // smooth (each is a GPU still read back: a view drawn for the first time
    // builds its pipeline first)
    let i = 0;
    const next = async () => {
      if (!isOpen || i >= cards.length) return;
      const c = cards[i++];
      try { await actions.renderThumb(c.v.id, c.canvas); } catch (err) { console.warn('views: no thumbnail', err); }
      requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }
  function close() { isOpen = false; pop.classList.remove('open'); viewBtn.setAttribute('aria-expanded', 'false'); }
  viewBtn.addEventListener('click', (e) => { e.stopPropagation(); isOpen ? close() : open(); });
  addEventListener('pointerdown', (e) => { if (isOpen && !pop.contains(e.target) && !viewBtn.contains(e.target)) close(); });

  function sync() {
    const v = views.find((x) => x.id === settings.view) ?? views[0];
    viewName.textContent = v.name;
    viewBtn.title = `Change view: ${v.name} (${v.hotkey})`;
    viewBtn.setAttribute('aria-label', viewBtn.title);
    viewBtn.setAttribute('aria-expanded', String(isOpen));
    const thumb = cards.find((c) => c.v.id === v.id)?.canvas;
    swatch.style.background = legendCSS(v.legend) ?? 'linear-gradient(135deg, #dcbc74, #2a78d4)';
    if (thumb?.dataset.rendered) swatch.style.background = `center / cover url(${thumb.toDataURL()})`;
    for (const c of cards) c.card.classList.toggle('on', c.v.id === v.id);
    pauseIcon.innerHTML = settings.paused ? ICON.play : ICON.pause;
    pauseLabel.textContent = settings.paused ? 'Paused' : 'Running';
    pause.title = settings.paused ? 'Resume (Space)' : 'Pause (Space)';
    pause.setAttribute('aria-label', pause.title);
    pause.classList.toggle('on', settings.paused);
  }

  return {
    sync,
    open, close,
    get isOpen() { return isOpen; },
    // 'god' | 'first' | 'third'
    setCamera(id) {
      for (const b of walk.querySelectorAll('button')) {
        b.classList.toggle('on', b.dataset.cam === id);
        b.setAttribute('aria-pressed', String(b.dataset.cam === id));
      }
    },
    setSettingsOpen: (v) => gear.classList.toggle('on', v),
    setUndoEnabled: (v) => { undo.disabled = !v; undo.style.opacity = v ? 1 : 0.4; },
  };
}

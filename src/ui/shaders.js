import { h } from './dom.js';
import { ICON } from './icons.js';
import { THUMB_SIZE } from '../views.js';

// A card still rendering after this long lets the next one start: its still lands on its canvas
// whenever it finishes, so one slow shader build can't hold up the whole menu.
const THUMB_WAIT_MS = 15000;

// `thumbUrl(id)`: the map's baked preview in a view (maps.js viewPreviewUrl, the start menu's
// map previews' way: shipped with the site, cached by the browser), or null where none is baked.
// `warmThumb(id)` starts building a view's shader.
export function createShaderPicker({ settings, views, renderThumb, warmThumb, thumbUrl, onChange, onClose, trigger }) {
  const cards = views.map(v => {
    const canvas = h('canvas', { width: THUMB_SIZE[0], height: THUMB_SIZE[1], 'aria-hidden': 'true' });
    const status = h('span.preview-status', { text: 'Loading preview…' });
    const card = h('button.view-card', { type: 'button', title: v.desc, 'aria-label': v.name,
      on: {
        click: () => { onChange(v.id); sync(); },
        keydown: e => {
          if (e.code === 'Space' || e.code === 'Enter') e.stopPropagation();
          if (e.code === 'Enter' && e.repeat) e.preventDefault();
        },
      },
    }, h('span.thumb', {}, canvas, status),
    h('span.name', {}, v.name, h('kbd', { text: v.hotkey })),
    v.legend ? h('span.legend', { style: { background: v.legend.css } }) : null);
    // src: the baked preview the card was given (thumbUrl); image: it shows a still, baked or live
    return { v, card, canvas, status, src: undefined, image: false };
  });
  const close = h('button.icon-btn', { type: 'button', title: 'Close shaders', 'aria-label': 'Close shaders',
    html: ICON.close, on: { click: onClose } });
  const el = h('div.popover.shader-picker.panel#shader-picker', { role: 'dialog', 'aria-label': 'Shaders',
    on: { keydown: e => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.code === 'Space' || e.code === 'Enter') e.stopPropagation();
    } },
  }, h('header', {}, h('h2', { text: 'Shaders' }), close),
  h('div.view-grid', { role: 'group', 'aria-label': 'Shader' }, cards.map(c => c.card)));
  document.body.append(el);
  document.addEventListener('pointerdown', e => {
    if (isOpen && !el.contains(e.target) && !trigger.contains(e.target)) onClose();
  });

  let isOpen = false, wasOpen = false, lastView, generation = 0, queue = Promise.resolve();
  function sync() {
    const view = settings.view;
    for (const c of cards) {
      c.card.classList.toggle('on', c.v.id === view);
      c.card.setAttribute('aria-pressed', String(c.v.id === view));
    }
    if (isOpen === wasOpen && view === lastView) return;
    wasOpen = isOpen;
    lastView = view;
    const run = ++generation;
    if (!isOpen) return;
    const srcs = cards.map(c => thumbUrl?.(c.v.id) ?? null);
    queue = queue.then(async () => {
      if (run !== generation) return;
      // Baked previews first: every card that has one shows it straight away.
      await Promise.all(cards.map(async (c, i) => {
        if (c.src === srcs[i]) return;
        const src = c.src = srcs[i];
        c.image = false;
        c.canvas.getContext('2d').clearRect(0, 0, c.canvas.width, c.canvas.height);
        c.status.hidden = false; c.status.textContent = 'Loading preview…';
        if (!src) return;
        const img = new Image();
        img.src = src;
        try { await img.decode(); } catch { return; }
        if (c.src !== src) return;
        c.canvas.getContext('2d').drawImage(img, 0, 0, c.canvas.width, c.canvas.height);
        c.image = true; c.status.hidden = true;
      }));
      // Then live ones, of the scene as it is now: the view on screen first (its shader is built),
      // then cards with no still, whose shaders all start building at once. A card with a baked
      // preview is redrawn only when its shader is built already: opening the menu builds none.
      const rank = c => (c.v.id === lastView ? 0 : c.image ? 2 : 1);
      const order = [...cards].sort((a, b) => rank(a) - rank(b));
      for (const c of order) if (!c.image) warmThumb?.(c.v.id);
      // One render at a time, including when the picker closes and reopens (a slow one gives way
      // after THUMB_WAIT_MS: readbacks copy the target as it is at the call, gpu/readback.js).
      for (const c of order) {
        if (run !== generation) return;
        const job = renderThumb(c.v.id, c.canvas, { build: !c.image }).then(rendered => {
          if (rendered) { c.image = true; c.status.hidden = true; }
          else if (!c.image) c.status.textContent = 'Select to preview';
        }, err => {
          if (!c.image) c.status.textContent = 'Preview unavailable';
          console.warn('views: no thumbnail', err);
        });
        await Promise.race([job, new Promise(resolve => setTimeout(resolve, THUMB_WAIT_MS))]);
        await new Promise(requestAnimationFrame);
      }
    });
  }
  function setOpen(v) {
    isOpen = !!v;
    el.classList.toggle('open', isOpen);
    el.inert = !isOpen;
    trigger.classList.toggle('on', isOpen);
    trigger.setAttribute('aria-expanded', String(isOpen));
    sync();
    if (isOpen) cards.find(c => c.v.id === settings.view)?.card.focus({ preventScroll: true });
    else if (el.contains(document.activeElement)) trigger.focus({ preventScroll: true });
  }
  setOpen(false);
  return {
    el, sync, setOpen, get isOpen() { return isOpen; },
  };
}

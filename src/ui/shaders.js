import { h } from './dom.js';
import { ICON } from './icons.js';

export function testFailureMessage(error) {
  const message = String(error?.message ?? error);
  const [first, next] = message.split('\n', 2);
  const shader = first.replace(/^GPU shader failed:\s*/, '').replace(/\.$/, '').slice(0, 96);
  const reason = message.includes('XPC_ERROR_CONNECTION_INTERRUPTED')
    ? 'Metal compiler connection interrupted' : next?.trim().slice(0, 160);
  return `Test failed: ${shader}.${reason ? ` ${reason}.` : ''} Showing Realistic. Select Test to retry.`;
}

export function createShaderPicker({ settings, views, renderThumb, onChange, onClose, trigger }) {
  const cards = views.map(v => {
    const canvas = v.experimental ? null : h('canvas', { width: 320, height: 200, 'aria-hidden': 'true' });
    const status = h('span.preview-status', { text: v.experimental ? 'Experimental renderer' : 'Loading preview…' });
    const description = v.experimental ? h('span.desc', {
      id: `view-status-${v.key}`, 'aria-live': 'polite', text: v.desc,
    }) : null;
    const card = h('button.view-card', { type: 'button', title: v.desc, 'aria-label': v.name,
      ...(description ? { 'aria-describedby': `view-status-${v.key}` } : {}),
      on: {
        click: () => { onChange(v.id); sync(); },
        keydown: e => {
          if (e.code === 'Space' || e.code === 'Enter') e.stopPropagation();
          if (e.code === 'Enter' && e.repeat) e.preventDefault();
        },
      },
    }, h('span.thumb', {}, canvas, status),
    h('span.name', {}, v.name, h('kbd', { text: v.hotkey })),
    description,
    v.legend ? h('span.legend', { style: { background: v.legend.css } }) : null);
    return { v, card, canvas, status, description };
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
    // One GPU readback at a time, including when the picker closes and reopens.
    queue = queue.then(async () => {
      for (const c of cards) {
        if (run !== generation) return;
        if (c.v.experimental) continue; // Legacy thumbnails cannot represent Test.
        try {
          const rendered = await renderThumb(c.v.id, c.canvas);
          c.status.hidden = !!rendered || c.canvas.dataset.rendered === '1';
          c.status.textContent = 'Select to preview';
        } catch (err) {
          c.status.textContent = 'Preview unavailable';
          console.warn('views: no thumbnail', err);
        }
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
    setTestStatus(text = 'Experimental renderer', detail) {
      const c = cards.find(c => c.v.key === 'test');
      if (!c) return;
      c.status.textContent = text;
      c.description.textContent = detail ?? c.v.desc;
      c.card.title = detail ?? c.v.desc;
    },
  };
}

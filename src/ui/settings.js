import { h } from './dom.js';
import { ICON } from './icons.js';

// Settings drawer built from a declarative spec.
//   { type: 'seg', key, options: [[value, label]], onChange }
//   { type: 'views', key, label, options: VIEWS, renderThumb, onChange }
//   { type: 'slider', key, label, min, max, step, def, fmt, onChange }
//   { type: 'switch', key, label, desc?, badge?, tier?, onChange }   (badge: a cost label, styled by tier)
//   { type: 'more', label, rows }   rows tucked under a collapsed disclosure
// A seg row may take value() instead of reading settings[key] (a derived setting),
// and cols: its options in rows of that many (too many to fit side by side),
// and disabled(): a one-line reason it can't be changed now (shown under it), else falsy.
//   { type: 'custom', el, sync }   an element the caller keeps up to date; sync runs with the others
// Any row may take hidden(): it shows only while that is false (checked when the rows sync).
export function createSettings({ settings, sections, footer, onClose }) {
  const syncers = [];

  const row = (r) => {
    const el = rowEl(r);
    if (el && r.hidden) syncers.push(() => { el.style.display = r.hidden() ? 'none' : ''; });
    return el;
  };

  const rowEl = (r) => {
    if (r.type === 'views') {
      const cards = r.options.map(v => {
        const canvas = h('canvas', { width: 320, height: 200, 'aria-hidden': 'true' });
        const status = h('span.preview-status', { text: 'Loading preview…' });
        const card = h('button.view-card', { type: 'button', title: v.desc, 'aria-label': v.name,
          on: {
            click: () => { r.onChange(v.id); syncAll(); },
            keydown: e => e.stopPropagation(),
          },
        }, h('span.thumb', {}, canvas, status),
        h('span.name', {}, v.name, h('kbd', { text: v.hotkey })),
        v.legend ? h('span.legend', { style: { background: v.legend.css } }) : null);
        return { v, card, canvas, status };
      });
      let wasOpen = false, lastView, generation = 0, queue = Promise.resolve();
      syncers.push(() => {
        const open = el.classList.contains('open'), view = settings[r.key];
        for (const c of cards) {
          c.card.classList.toggle('on', c.v.id === view);
          c.card.setAttribute('aria-pressed', String(c.v.id === view));
        }
        if (open === wasOpen && view === lastView) return;
        wasOpen = open;
        lastView = view;
        const run = ++generation;
        if (!open) return;
        // One GPU readback at a time, including when the drawer closes and reopens.
        queue = queue.then(async () => {
          for (const c of cards) {
            if (run !== generation) return;
            try {
              const rendered = await r.renderThumb(c.v.id, c.canvas);
              c.status.hidden = !!rendered || c.canvas.dataset.rendered === '1';
              c.status.textContent = 'Select to preview';
            } catch (err) {
              c.status.textContent = 'Preview unavailable';
              console.warn('views: no thumbnail', err);
            }
            await new Promise(requestAnimationFrame);
          }
        });
      });
      return h('div.view-grid', { role: 'group', 'aria-label': r.label }, cards.map(c => c.card));
    }
    if (r.type === 'seg') {
      const btns = r.options.map(([value, label]) => {
        const b = h('button', { type: 'button', text: label, on: { click: () => { r.onChange(value); syncAll(); } } });
        b.dataset.value = value;
        return b;
      });
      syncers.push(() => btns.forEach((b) => b.classList.toggle('on', String(r.value ? r.value() : settings[r.key]) === b.dataset.value)));
      const seg = h(r.cols ? 'div.seg.rows' : 'div.seg', { role: 'radiogroup', style: r.cols ? { '--cols': r.cols } : null }, btns);
      if (!r.disabled) return seg;
      // disabled(): a one-line reason while the row can't be changed, else falsy
      const note = h('p.row-note');
      syncers.push(() => {
        const why = r.disabled();
        btns.forEach((b) => { b.disabled = !!why; });
        note.textContent = why || '';
        note.hidden = !why;
      });
      return h('div', {}, seg, note);
    }
    if (r.type === 'slider') {
      const input = h('input', { type: 'range', min: r.min, max: r.max, step: r.step, 'aria-label': r.label });
      const out = h('output');
      const reset = h('button.reset', { type: 'button', title: 'Reset to default', html: ICON.reset });
      const field = h('div.field', {}, h('label', { text: r.label }), out, reset, input);
      const apply = (v) => { settings[r.key] = v; r.onChange?.(v); sync(); };
      input.addEventListener('input', () => apply(+input.value));
      reset.addEventListener('click', () => apply(r.def));
      const sync = () => {
        const v = settings[r.key];
        input.value = v;
        out.textContent = r.fmt ? r.fmt(v) : v;
        input.style.setProperty('--fill', `${((v - r.min) / (r.max - r.min)) * 100}%`);
        field.classList.toggle('changed', Math.abs(v - r.def) > 1e-9);
      };
      syncers.push(sync);
      return field;
    }
    if (r.type === 'switch') {
      const sw = h('button.switch', { type: 'button', role: 'switch', 'aria-label': r.label });
      sw.addEventListener('click', () => { settings[r.key] = !settings[r.key]; r.onChange?.(settings[r.key]); syncAll(); });
      syncers.push(() => sw.setAttribute('aria-checked', String(!!settings[r.key])));
      const label = r.badge
        ? h('span', {}, h('span', { text: r.label }), h(`span.badge.${r.tier}`, { text: r.badge }))
        : h('span', { text: r.label });
      const el = h('div.switch-row', {}, label, sw);
      if (r.desc) el.title = r.desc;
      return el;
    }
    if (r.type === 'more') {
      return h('details.more', {}, h('summary', { text: r.label }), r.rows.map(row));
    }
    if (r.type === 'custom') {
      if (r.sync) syncers.push(r.sync);
      return r.el;
    }
    return null;
  };

  const body = h('div.body', {}, sections.map((s) => h('section', {}, h('h3', { text: s.title }), s.rows.map(row))));
  const closeBtn = h('button.icon-btn', { type: 'button', title: 'Close settings', 'aria-label': 'Close settings', html: ICON.close, on: { click: () => onClose() } });
  const foot = footer ? h('div.footer', {}, footer.map(([label, fn, cls = '']) =>
    h(`button.btn.grow${cls}`, { type: 'button', text: label, on: { click: () => { fn(); syncAll(); } } }))) : null;
  const el = h('div.drawer.panel', { role: 'dialog', 'aria-label': 'Settings' },
    h('header', {}, h('h2', { text: 'Settings' }), closeBtn), body, foot);
  document.body.append(el);

  function syncAll() { syncers.forEach((f) => f()); }
  syncAll();
  return {
    el,
    sync: syncAll,
    focusViews() {
      const grid = el.querySelector('.view-grid');
      grid?.scrollIntoView({ block: 'nearest' });
      grid?.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
    },
    setOpen: (v) => { el.classList.toggle('open', v); syncAll(); },
    get isOpen() { return el.classList.contains('open'); },
  };
}

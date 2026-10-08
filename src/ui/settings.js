import { h } from './dom.js';
import { ICON } from './icons.js';

// Settings drawer built from a declarative spec.
//   { type: 'seg', key, options: [[value, label]], onChange }
//   { type: 'slider', key, label, min, max, step, def, fmt, onChange }
export function createSettings({ settings, sections, footer, onClose }) {
  const syncers = [];

  const row = (r) => {
    if (r.type === 'seg') {
      const btns = r.options.map(([value, label]) => {
        const b = h('button', { type: 'button', text: label, on: { click: () => { r.onChange(value); syncAll(); } } });
        b.dataset.value = value;
        return b;
      });
      syncers.push(() => btns.forEach((b) => b.classList.toggle('on', String(settings[r.key]) === b.dataset.value)));
      return h('div.seg', { role: 'radiogroup' }, btns);
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
    setOpen: (v) => { el.classList.toggle('open', v); if (v) syncAll(); },
    get isOpen() { return el.classList.contains('open'); },
  };
}

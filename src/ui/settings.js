import { h } from './dom.js';
import { ICON } from './icons.js';

// Settings drawer built from a declarative spec.
//   { type: 'seg', key, options: [[value, label]], onChange }
//   { type: 'slider', key, label, min, max, step, def, fmt, onChange }
//   { type: 'switch', key, label, def, onChange }
//   { type: 'buttons', buttons: [[label, fn, cls?]] }
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
        input.disabled = r.disabled?.() ?? false;
        field.style.opacity = input.disabled ? 0.5 : 1;
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
    if (r.type === 'buttons') {
      return h('div.btn-row', {}, r.buttons.map(([label, fn, cls = '']) =>
        h(`button.btn.grow${cls}`, { type: 'button', text: label, on: { click: () => { fn(); syncAll(); } } })));
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

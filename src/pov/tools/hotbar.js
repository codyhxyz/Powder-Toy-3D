import { h } from '../../ui/dom.js';
import { modelIcon } from '../models.js';
import { SLOTS } from './catalog.js';
import './hotbar.css';

// The hotbar, bottom centre: one box per slot of the catalog (Half-Life 2's
// weapon buckets, catalog.js), each with its number key, the icon of the tool
// it holds now (an OSRS-style sprite of its model), that tool's status (e.g.
// 'SAND ×37') and a pip per tool carried in it. After a switch, the slot's
// tools show above the bar for a moment, the one in hand lit: press the key
// again for the next.

export const HOTBAR_SLOTS = SLOTS.length;
export const slotKey = (i) => String((i + 1) % 10);   // slot i's number key
const NAME_SHOW_MS = 1800;        // how long the slot's tool names stay up after a switch
const SHAKE_MS = 360;             // .shake animation length (hotbar.css)

// onSelect(i): a slot was tapped (touch; in first person the pointer is locked)
export function createHotbar(onSelect) {
  const nameEl = h('div.hb-name');
  const slots = SLOTS.map((label, i) => {
    const icon = h('span.hb-icon');
    const status = h('span.hb-status');
    const pips = h('span.hb-pips');
    const el = h('button.hb-slot', { type: 'button', 'data-empty': '', disabled: true, title: label,
      on: { click: () => onSelect?.(i) } }, h('span.hb-num', { text: slotKey(i) }), icon, pips, status);
    return { el, icon, status, pips, label, text: '', names: [] };
  });
  const bar = h('div.hotbar', { role: 'toolbar', 'aria-label': 'Tools' }, nameEl, h('div.hb-row', {}, slots.map((s) => s.el)));
  document.body.append(bar);
  let nameTimer = 0;

  return {
    el: bar,
    // slot i holds `defs` ({ name, model, desc }, in order) and has `at` in hand (an index into them)
    setSlot(i, defs, at) {
      const s = slots[i];
      const def = defs[at];
      s.names = defs.map((d) => d.name);
      s.at = at;
      s.el.disabled = !def;
      s.pips.replaceChildren(...(defs.length > 1 ? defs.map((_, j) => h(`i${j === at ? '.on' : ''}`)) : []));
      if (!def) { s.el.setAttribute('data-empty', ''); s.icon.replaceChildren(); s.icon.dataset.model = ''; return; }
      s.el.removeAttribute('data-empty');
      s.el.title = `${s.label}: ${def.name}${def.desc ? `. ${def.desc}` : ''}`;
      s.el.setAttribute('aria-label', `${s.label}: ${def.name}`);
      if (s.icon.dataset.model === def.model) return;
      s.icon.dataset.model = def.model ?? '';
      s.icon.replaceChildren(def.model
        ? h('img', { src: modelIcon(def.model), alt: '', draggable: 'false' })
        : h('b', { text: def.key?.slice(0, 4) ?? '' }));
    },
    // light slot i and show its tools' names, the one in hand lit
    select(i) {
      slots.forEach((s, j) => {
        s.el.classList.toggle('on', j === i);
        s.el.setAttribute('aria-pressed', String(j === i));
      });
      const s = slots[i];
      nameEl.replaceChildren(...s.names.map((n, j) => h(`span${j === s.at ? '.on' : ''}`, { text: n })));
      nameEl.classList.toggle('show', s.names.length > 0);
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => nameEl.classList.remove('show'), NAME_SHOW_MS);
    },
    setStatus(i, text) {
      const s = slots[i];
      text = text ?? '';
      if (s.text === text) return;
      s.text = text;
      s.status.textContent = text;
    },
    shake(i) {
      const el = slots[i].el;
      el.classList.remove('shake');
      void el.offsetWidth;   // restart the animation
      el.classList.add('shake');
      setTimeout(() => el.classList.remove('shake'), SHAKE_MS);
    },
    setVisible(v) { bar.classList.toggle('show', !!v); },
    dispose() { clearTimeout(nameTimer); bar.remove(); },
  };
}

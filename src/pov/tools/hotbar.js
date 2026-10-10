import { h } from '../../ui/dom.js';
import { modelIcon } from '../models.js';
import { SLOTS } from './catalog.js';
import './hotbar.css';

// Numbered categories stay visible; switching opens the selected slot's
// vertical tool stack. Number keys cycle; unlocked pointers can pick a row.

export const HOTBAR_SLOTS = SLOTS.length;
export const slotKey = (i) => String((i + 1) % 10);   // slot i's number key
const STACK_SHOW_MS = 4000;
const SHAKE_MS = 360;             // .shake animation length (hotbar.css)

export function createHotbar(onSelect, onSelectTool) {
  const nameEl = h('div.hb-name', { role: 'status', 'aria-live': 'polite' });
  const heading = h('strong.hb-heading');
  const position = h('span.hb-position');
  const list = h('div.hb-tools', { role: 'group' });
  const hint = h('div.hb-cycle');
  const stack = h('div.hb-stack', { hidden: true },
    h('div.hb-head', {}, heading, position), list, hint,
    h('div.hb-help', { text: 'Wheel: all tools · Q: more tools' }));
  const slots = SLOTS.map((label, i) => {
    const icon = h('span.hb-icon');
    const status = h('span.hb-status');
    const count = h('span.hb-count', { 'aria-hidden': 'true' });
    const el = h('button.hb-slot', { type: 'button', 'data-empty': '', disabled: true, title: label,
      on: { click: () => onSelect?.(i) } }, h('span.hb-num', { text: slotKey(i) }), icon, count, status,
      h('span.hb-label', { text: label }));
    return { el, icon, status, count, label, text: '', defs: [], at: -1 };
  });
  const bar = h('div.hotbar', { inert: true }, stack, nameEl,
    h('div.hb-row', { role: 'toolbar', 'aria-label': 'Tool slots' }, slots.map((s) => s.el)));
  document.body.append(bar);
  let stackTimer = 0, selected = -1;

  function deferClose() {
    clearTimeout(stackTimer);
    stackTimer = setTimeout(() => {
      if (bar.matches(':hover') || bar.contains(document.activeElement)) return;
      stack.hidden = true;
    }, STACK_SHOW_MS);
  }
  bar.addEventListener('pointerenter', () => clearTimeout(stackTimer));
  bar.addEventListener('pointerleave', deferClose);
  bar.addEventListener('focusin', () => clearTimeout(stackTimer));
  bar.addEventListener('focusout', deferClose);

  const iconFor = (def) => def.model
    ? h('img', { src: modelIcon(def.model), alt: '', draggable: 'false' })
    : h('b', { text: def.key?.slice(0, 4) ?? '' });

  function showStack() {
    const s = slots[selected];
    if (!s?.defs.length) { stack.hidden = true; return; }
    heading.textContent = `${slotKey(selected)}  ${s.label}`;
    position.textContent = `${s.at + 1} / ${s.defs.length}`;
    list.setAttribute('aria-label', `${s.label} tools`);
    // Preserve keyboard focus when equipping a row rebuilds the list.
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    list.replaceChildren(...s.defs.map((def, j) => h(`button.hb-tool${j === s.at ? '.on' : ''}`, {
      type: 'button', 'data-key': def.key, title: def.desc,
      'aria-label': def.name, 'aria-pressed': String(j === s.at),
      on: { click: () => onSelectTool?.(def.key) },
    }, h('span.hb-icon', {}, iconFor(def)), h('span.hb-tool-name', { text: def.name }),
    j === s.at ? h('span.hb-equipped', { text: 'Equipped' }) : null)));
    hint.replaceChildren(
      h('span.hb-key-hint', { text: s.defs.length > 1 ? `Press ${slotKey(selected)} again: next tool` : `Press ${slotKey(selected)}: equip` }),
      h('span.hb-touch-hint', { text: 'Tap a tool to equip' }));
    stack.hidden = false;
    if (focused) [...list.children].find((el) => el.dataset.key === focused)?.focus({ preventScroll: true });
    deferClose();
  }

  return {
    el: bar,
    // slot i holds `defs` ({ name, model, desc }, in order) and has `at` in hand (an index into them)
    setSlot(i, defs, at) {
      const s = slots[i];
      const def = defs[at];
      s.defs = defs;
      s.at = at;
      s.el.disabled = !def;
      s.count.textContent = defs.length > 1 ? `${at + 1}/${defs.length}` : '';
      if (!def) {
        s.el.setAttribute('data-empty', '');
        s.el.setAttribute('aria-label', `${s.label}: empty`);
        s.el.title = `${s.label}: empty`;
        s.icon.replaceChildren(); s.icon.dataset.model = '';
        s.status.textContent = s.text = '';
        return;
      }
      s.el.removeAttribute('data-empty');
      s.el.title = `${s.label}: ${def.name}${def.desc ? `. ${def.desc}` : ''}`;
      s.el.setAttribute('aria-label', `${slotKey(i)} ${s.label}: ${def.name}, ${at + 1} of ${defs.length}`);
      if (s.icon.dataset.model === def.model) return;
      s.icon.dataset.model = def.model ?? '';
      s.icon.replaceChildren(iconFor(def));
    },
    // Keep the equipped name visible after the stack closes.
    select(i) {
      selected = i;
      slots.forEach((s, j) => {
        s.el.classList.toggle('on', j === i);
        s.el.setAttribute('aria-pressed', String(j === i));
      });
      const s = slots[i];
      nameEl.textContent = s.defs[s.at]?.name ?? '';
      bar.style.setProperty('--hb-slot', i);
      showStack();
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
    setVisible(v) {
      const opening = v && !bar.classList.contains('show');
      bar.classList.toggle('show', !!v);
      bar.inert = !v;
      if (opening) showStack();
      if (!v) { clearTimeout(stackTimer); stack.hidden = true; }
    },
    dispose() { clearTimeout(stackTimer); bar.remove(); },
  };
}

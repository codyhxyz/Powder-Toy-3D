import { h } from '../../ui/dom.js';
import { modelIcon } from '../models.js';
import { SLOTS } from './catalog.js';
import './hotbar.css';

// Half-Life 2's weapon selector, as Garry's Mod shows it: nothing on screen
// while you play. A number key or the wheel brings it up at the top centre, a
// small numbered box per slot and the chosen slot opened downward into one box
// per tool, then it fades. The tool in hand stays bottom right, where HL2 keeps
// its ammo. On a touch screen the slots stay up to tap.
// While it is up, a click picks what it shows and closes it, and the click
// doesn't fire (HL2 weapon_selection.cpp ProcessInput: IN_ATTACK or IN_ATTACK2
// selects, the button is swallowed, the selection hides).

export const HOTBAR_SLOTS = SLOTS.length;
export const slotKey = (i) => String((i + 1) % 10);   // slot i's number key
const SHOW_MS = 1500;             // HL2 hud_weaponselection.cpp FASTSWITCH_DISPLAY_TIMEOUT 1.5 s
const SHAKE_MS = 360;             // .shake animation length (hotbar.css)

export function createHotbar(onSelect, onSelectTool) {
  const nameEl = h('span.hb-name', { role: 'status', 'aria-live': 'polite' });
  const heldStatus = h('span.hb-held-status');
  const held = h('div.hb-held', {}, nameEl, heldStatus);
  const list = h('div.hb-tools', { role: 'group' });
  const stack = h('div.hb-stack', { hidden: true }, list);
  const slots = SLOTS.map((label, i) => {
    const status = h('span.hb-status');
    const count = h('span.hb-count', { 'aria-hidden': 'true' });
    const labelEl = h('span.hb-label', { text: label });
    const el = h('button.hb-slot', { type: 'button', 'data-empty': '', disabled: true, title: label,
      on: { click: () => onSelect?.(i) } }, h('span.hb-num', { text: slotKey(i) }), labelEl, count, status);
    const col = h('div.hb-col', {}, el);
    return { el, col, status, count, label, labelEl, text: '', defs: [], at: -1 };
  });
  const bar = h('div.hotbar', { inert: true, role: 'toolbar', 'aria-label': 'Tool slots' }, slots.map((s) => s.col));
  document.body.append(bar, held);
  let timer = 0, selected = -1, shown = false;

  // Up after a pick, longer while hovered or focused. Freeing the mouse with
  // Esc is not a tool-selection request; touch visibility lives in hotbar.css.
  const touch = matchMedia('(hover: none) and (pointer: coarse)');
  const free = () => !touch.matches && !document.pointerLockElement;
  function open() {
    if (!shown) return;
    bar.classList.add('open');
    clearTimeout(timer);
    timer = setTimeout(close, SHOW_MS);
  }
  function close() {
    clearTimeout(timer);
    if (bar.matches(':hover') || bar.contains(document.activeElement)) return;
    bar.classList.remove('open');
  }
  bar.addEventListener('pointerleave', () => { timer = setTimeout(close, SHOW_MS); });
  bar.addEventListener('focusout', () => { timer = setTimeout(close, SHOW_MS); });
  document.addEventListener('pointerlockchange', close);

  const iconFor = (def) => def.model
    ? h('img', { src: modelIcon(def.model), alt: '', draggable: 'false' })
    : h('b', { text: def.key?.slice(0, 4) ?? '' });

  function showStack() {
    const s = slots[selected];
    if (!s?.defs.length) { stack.hidden = true; return; }
    list.setAttribute('aria-label', `${s.label} tools`);
    // Preserve keyboard focus when equipping a row rebuilds the list.
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    list.replaceChildren(...s.defs.map((def, j) => h(`button.hb-tool${j === s.at ? '.on' : ''}`, {
      type: 'button', 'data-key': def.key, title: def.desc,
      'aria-label': def.name, 'aria-pressed': String(j === s.at),
      on: { click: () => onSelectTool?.(def.key) },
    }, h('span.hb-icon', {}, iconFor(def)), h('span.hb-tool-name', { text: def.name }))));
    s.col.append(stack);
    stack.hidden = false;
    if (focused) [...list.children].find((el) => el.dataset.key === focused)?.focus({ preventScroll: true });
  }

  function syncHeld() {
    const s = slots[selected];
    nameEl.textContent = s?.defs[s.at]?.name ?? '';
    heldStatus.textContent = s?.text ?? '';
  }

  return {
    el: bar,
    // the slots' labels: `labels` (a team game's carry: 'Primary', 'Secondary'), the slots past them
    // hidden; null: the catalog's (SLOTS)
    setLabels(labels) {
      slots.forEach((s, i) => {
        s.label = labels ? labels[i] ?? '' : SLOTS[i];
        s.labelEl.textContent = s.label;
        s.col.style.display = labels && i >= labels.length ? 'none' : '';
      });
    },
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
        s.status.textContent = s.text = '';
        return;
      }
      s.el.removeAttribute('data-empty');
      s.el.title = `${s.label}: ${def.name}${def.desc ? `. ${def.desc}` : ''}`;
      s.el.setAttribute('aria-label', `${slotKey(i)} ${s.label}: ${def.name}, ${at + 1} of ${defs.length}`);
    },
    select(i) {
      selected = i;
      slots.forEach((s, j) => {
        s.el.classList.toggle('on', j === i);
        s.el.setAttribute('aria-pressed', String(j === i));
      });
      syncHeld();
      showStack();
      open();
    },
    setStatus(i, text) {
      const s = slots[i];
      text = text ?? '';
      if (s.text === text) return;
      s.text = text;
      s.status.textContent = text;
      if (i === selected) heldStatus.textContent = text;
    },
    // a click while the selector is up: it closes, and the click is spent (true)
    confirm() {
      if (!bar.classList.contains('open') || free()) return false;
      clearTimeout(timer);
      bar.classList.remove('open');
      return true;
    },
    shake(i) {
      const el = slots[i].el;
      el.classList.remove('shake');
      void el.offsetWidth;   // restart the animation
      el.classList.add('shake');
      setTimeout(() => el.classList.remove('shake'), SHAKE_MS);   // a refusal never opens the selector: the player opens it
    },
    setVisible(v) {
      shown = !!v;
      bar.classList.toggle('show', shown);
      held.classList.toggle('show', shown);
      bar.inert = !shown;
      if (shown) showStack();
      else { clearTimeout(timer); bar.classList.remove('open'); }
    },
    dispose() {
      clearTimeout(timer);
      document.removeEventListener('pointerlockchange', close);
      bar.remove(); held.remove();
    },
  };
}

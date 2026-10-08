import { h, inkFor } from '../../ui/dom.js';
import './hotbar.css';

// Minecraft-style hotbar, bottom centre: HOTBAR_SLOTS slots, each with its key
// number, the tool's icon tile and its status (e.g. 'SAND ×37'). The selected
// tool's name shows above the bar for a moment after switching.

export const HOTBAR_SLOTS = 9;
const NAME_SHOW_MS = 1800;        // how long the tool name stays up after a switch
const SHAKE_MS = 360;             // .shake animation length (hotbar.css)
const TOOL_COLOR = '#8b93a3';     // tile colour of a tool that names none

export function createHotbar() {
  const nameEl = h('div.hb-name');
  const slots = [...Array(HOTBAR_SLOTS)].map((_, i) => {
    const icon = h('span.hb-icon');
    const status = h('span.hb-status');
    const el = h('div.hb-slot', { 'data-empty': '' }, h('span.hb-num', { text: String(i + 1) }), icon, status);
    return { el, icon, status, text: '' };
  });
  const bar = h('div.hotbar', { role: 'toolbar', 'aria-label': 'Tools' }, nameEl, h('div.hb-row', {}, slots.map((s) => s.el)));
  document.body.append(bar);
  let nameTimer = 0;

  return {
    el: bar,
    // def: { name, icon, desc, color? } or null for an empty slot
    setTool(i, def) {
      const s = slots[i];
      if (!def) { s.el.setAttribute('data-empty', ''); s.icon.replaceChildren(); return; }
      s.el.removeAttribute('data-empty');
      const color = def.color ?? TOOL_COLOR;
      s.icon.style.setProperty('--c', color);
      s.icon.style.setProperty('--ink', inkFor(color));
      s.el.title = def.desc ? `${def.name}: ${def.desc}` : def.name;
      s.el.dataset.name = def.name;
      const icon = def.icon ?? def.key?.slice(0, 4) ?? '';
      if (icon.trim().startsWith('<')) s.icon.innerHTML = icon;
      else s.icon.replaceChildren(h('b', { text: icon }));
    },
    select(i) {
      slots.forEach((s, j) => s.el.classList.toggle('on', j === i));
      const name = slots[i].el.dataset.name;
      nameEl.textContent = name ?? '';
      nameEl.classList.toggle('show', !!name);
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

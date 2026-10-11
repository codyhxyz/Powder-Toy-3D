import { h } from './dom.js';
import { decoView, setDecoColor } from '../deco.js';

// The deco tools' options (TPT's colour picker and its RGBA sliders,
// src/gui/game/GameView.cpp colourPicker): the colour, its alpha (how strongly
// it covers), and whether decoration is drawn at all (TPT's Ctrl+B). It lives
// in the spawn menu's options pane, shown while a deco tool is selected
// (ui/dock.js).
const BYTE_MAX = 255;
const hex2 = (v) => v.toString(16).padStart(2, '0');
const toHex = ([r, g, b]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const fromHex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

export function createDecoPicker({ onToggle }) {
  const color = h('input.deco-color', { type: 'color', 'aria-label': 'Decoration colour' });
  const alphaOut = h('output');
  const alpha = h('input', { type: 'range', min: 0, max: BYTE_MAX, step: 1, 'aria-label': 'Decoration alpha' });
  const swatch = h('span.deco-swatch', { 'aria-hidden': 'true' });
  const show = h('button.material-control', {
    type: 'button', title: 'Show decoration (Ctrl+B)', 'aria-label': 'Show decoration', on: { click: () => onToggle() },
  }, h('span', { text: 'Show decoration' }), h('kbd', { text: 'Ctrl B' }));
  const fill = (input) => input.style.setProperty('--fill', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
  const apply = () => {
    setDecoColor([...fromHex(color.value), +alpha.value]);
    sync();
  };
  color.addEventListener('input', apply);
  alpha.addEventListener('input', apply);
  const el = h('div.deco-only', { role: 'group', 'aria-label': 'Decoration colour' },
    h('label.material-range', {}, h('span', { text: 'Colour' }), color, swatch),
    h('label.material-range', {}, h('span', { text: 'Alpha' }), alpha, alphaOut),
    show);
  function sync() {
    const [r, g, b, a] = decoView.color;
    color.value = toHex([r, g, b]);
    alpha.value = a;
    alphaOut.textContent = a;
    fill(alpha);
    swatch.style.setProperty('--deco', `rgb(${r} ${g} ${b} / ${a / BYTE_MAX})`);
    show.setAttribute('aria-pressed', String(decoView.show));
  }
  sync();
  return { el, sync };
}

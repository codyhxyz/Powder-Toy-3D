import { h } from './dom.js';
import { tile, kindOf } from './dock.js';
import { toolById } from '../elements.js';

const KIND_LABEL = { powder: 'Powder', liquid: 'Liquid', gas: 'Gas', solid: 'Solid', tool: 'Tool', build: 'Construction' };
const deg = (t) => `${t} °C`;

// Short, factual chips derived from the element table.
function facts(it) {
  const out = [];
  if (it.id < 0) return out;
  const k = kindOf(it);
  if (k === 'powder' || k === 'liquid') out.push(['', `${+(it.dens / 10).toFixed(2)}×`, ' density of water']);
  if (k === 'gas') out.push(['Rises', '', '']);
  if (it.key === 'WATER') out.push(['Freezes ', deg(0), ''], ['Boils ', deg(100), '']);
  if (it.key === 'ICE' || it.key === 'SNOW') out.push(['Melts ', deg(0), '']);
  if (it.key === 'STEAM') out.push(['Condenses ', deg(100), '']);
  if (it.melt) out.push(['Melts ', deg(it.melt), '']);
  if (it.ignite) out.push([it.key === 'GUNPOWDER' ? 'Explodes ' : 'Ignites ', deg(it.ignite), '']);
  if (it.temp !== 20) out.push(['Starts at ', deg(it.temp), '']);
  if (it.cond >= 0.05) out.push(['Conducts heat well', '', '']);
  else if (it.cond <= 0.002 && it.kind !== 4) out.push(['Insulates', '', '']);
  return out;
}

export function createCard() {
  const el = h('aside.card.panel', { 'aria-live': 'polite' });
  document.body.append(el);
  let shown = null;
  return {
    show(id) {
      if (id === shown) return;
      shown = id;
      const it = toolById(id);
      el.replaceChildren(
        Object.assign(tile(it, '.big'), { tabIndex: -1, disabled: true }),
        h('div.title', { text: it.name }),
        h('div.kind', { text: KIND_LABEL[kindOf(it)] }),
        h('p', { text: it.desc }),
        h('div.facts', {}, facts(it).map(([a, b, c]) => h('span', {}, a, b ? h('b', { text: b }) : null, c))),
      );
    },
    setHidden: (v) => el.classList.toggle('hidden', v),
  };
}

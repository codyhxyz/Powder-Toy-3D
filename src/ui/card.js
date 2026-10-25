import { h } from './dom.js';
import { tile, kindOf } from './dock.js';
import { toolById } from '../elements.js';
import { elementFacts } from '../lab/facts.js';

const KIND_LABEL = { powder: 'Powder', liquid: 'Liquid', gas: 'Gas', solid: 'Solid', tool: 'Tool', build: 'Construction' };
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
        h('div.facts', {}, elementFacts(it).slice(0, 10).map(({ chips: [a, b, c] }) => h('span', {}, a, b ? h('b', { text: b }) : null, c))),
      );
    },
    setHidden: (v) => el.classList.toggle('hidden', v),
  };
}

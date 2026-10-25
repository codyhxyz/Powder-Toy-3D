import { h } from '../ui/dom.js';
import { itemByKey } from '../elements.js';
import { describeTag } from '../materialTraits.js';
import { createExhibitCatalog, STORAGE_REQUIREMENTS } from './catalog.js';
import './inspector.css';

// One reusable panel for any material plaque, including saved/co-op plaques.
// It reads the same catalog/facts as future exhibit generation, not sign text.
export function createElementInspector() {
  const catalog = new Map(createExhibitCatalog().map(entry => [entry.key, entry]));
  const dialog = h('dialog.material-inspector.panel', { 'aria-labelledby': 'material-inspector-title' });
  const close = h('button.material-inspector-close', { type: 'button', text: 'Close', 'aria-label': 'Close material facts' });
  const content = h('div');
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.append(close, content);
  document.body.append(dialog);
  return {
    show(key) {
      const entry = catalog.get(key), element = itemByKey(key);
      if (!entry || !element) return false;
      content.replaceChildren(
        h('p.material-inspector-kicker', { text: 'Material reference · Preservation' }),
        h('h2', { id: 'material-inspector-title', text: `${entry.name} · ${element.abbr}` }),
        h('p', { text: element.desc }),
        h('div.material-inspector-tags', {}, entry.tags.map(tag => h('span', { text: describeTag(tag).label }))),
        h('h3', { text: 'Modeled behavior and facts' }),
        h('ul', {}, entry.facts.map(fact => h('li', { text: fact.chips.join('') }))),
        h('p.material-inspector-note', { text: 'Unlisted transitions are not modeled or not applicable; they are not assumed to occur at 0 °C.' }),
        h('h3', { text: 'Persistent storage assessment' }),
        h('p', { text: entry.status === 'candidate' ? 'Candidate storage — containment still needs testing.' : 'Indefinite storage is unverified. This does not prohibit live demonstrations.' }),
        h('p', { text: entry.reason }),
        h('ul', {}, entry.requirements.map(key => h('li', {
          text: `${STORAGE_REQUIREMENTS[key].label}: ${STORAGE_REQUIREMENTS[key].reason}`,
        }))),
        h('p.material-inspector-note', { text: 'Working exhibits can change over time. Corporate notices are fiction; these facts do not claim indefinite stability or protection for the player.' }),
        h('details', {}, h('summary', { text: 'Tag definitions' }), h('dl', {}, entry.tags.flatMap(tag => {
          const definition = describeTag(tag);
          return [h('dt', { text: definition.label }), h('dd', { text: definition.description })];
        }))),
      );
      if (!dialog.open) {
        document.exitPointerLock?.();
        dialog.showModal();
      }
      close.focus();
      return true;
    },
    close: () => { if (dialog.open) dialog.close(); },
  };
}

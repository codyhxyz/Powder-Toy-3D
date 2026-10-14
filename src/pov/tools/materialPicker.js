import { h } from '../../ui/dom.js';
import { ELEMENTS } from '../../elements.js';
import { packContents } from './transfer.js';
import { BLOCK } from './dig.js';
import './materialPicker.css';

// Minecraft's inventory: see the whole pack and pick a material, not a blind cycle.
export function createMaterialPicker({ load, material, choose, onOpenChange, requestLock }) {
  const swatch = (id) => h('span.mp-swatch', { style: { background: ELEMENTS[id].color }, 'aria-hidden': 'true' });
  const label = h('span');
  const trigger = h('button.mp-trigger', { type: 'button', hidden: true, 'aria-haspopup': 'dialog',
    on: { click: show } }, label, h('span.mp-trigger-hint', { text: 'Materials' }));
  const search = h('input.mp-search', { type: 'search', placeholder: 'Find a material…', 'aria-label': 'Find a material',
    on: { input: render } });
  const summary = h('p.mp-summary');
  const list = h('div.mp-list', { role: 'group', 'aria-label': 'Collected materials' });
  const empty = h('p.mp-empty', { role: 'status' });
  const dialog = h('dialog.material-picker', { 'aria-labelledby': 'mp-title',
    on: { cancel: (e) => { e.preventDefault(); close(); }, click: (e) => { if (e.target === dialog) close(); } } },
  h('div.mp-body', {},
    h('div.mp-header', {}, h('h2#mp-title', { text: 'Build with…' }),
      h('button.mp-close', { type: 'button', text: 'Done', on: { click: () => close(true) } })),
    summary, search, list, empty,
    h('p.mp-help', { text: 'Pick a material, then left-click to build. Right-click to open your pack.' })));
  document.body.append(trigger, dialog);
  let version = -1, selected = null, previousFocus = null;

  function render() {
    const have = packContents(load);
    const query = search.value.trim().toLowerCase();
    const rows = have.filter(([id]) => `${ELEMENTS[id].name} ${ELEMENTS[id].abbr}`.toLowerCase().includes(query))
      .sort(([a], [b]) => ELEMENTS[a].name.localeCompare(ELEMENTS[b].name));
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    summary.textContent = `${have.length} material${have.length === 1 ? '' : 's'} in your pack · ${load.cells.length.toLocaleString()} cells`;
    list.replaceChildren(...rows.map(([id, n]) => {
      const active = id === material()?.[0];
      const blocks = Math.floor(n / BLOCK ** 3);
      return h('button.mp-material', { type: 'button', 'data-id': id, 'aria-pressed': String(active),
        on: { click: () => { choose(id); sync(); close(true); } } },
      swatch(id), h('span.mp-material-name', {}, h('strong', { text: ELEMENTS[id].name }),
        h('span', { text: blocks ? `${blocks.toLocaleString()} full block${blocks === 1 ? '' : 's'}` : 'Partial block' })),
      h('span.mp-quantity', {}, h('strong', { text: `${n.toLocaleString()} cells` }),
        h('span', { text: active ? 'Selected' : 'Select' })));
    }));
    empty.hidden = rows.length > 0;
    empty.textContent = have.length ? 'No matching material. Try another name.' : 'Your pack is empty. Dig with the shovel or pickaxe, then build here.';
    if (focused) [...list.children].find((el) => el.dataset.id === focused)?.focus({ preventScroll: true });
  }
  function sync() {
    const mat = material();
    if (version === load.version && selected === mat?.[0]) return;
    version = load.version; selected = mat?.[0];
    label.replaceChildren(...(mat ? [swatch(mat[0]), `${ELEMENTS[mat[0]].name} · ${mat[1].toLocaleString()}`] : ['Pack empty']));
    trigger.setAttribute('aria-label', `${mat ? ELEMENTS[mat[0]].name : 'Pack empty'}: choose building material`);
    if (dialog.open) render();
  }
  function show() {
    if (dialog.open) return;
    previousFocus = document.activeElement;
    search.value = '';
    render();
    onOpenChange?.(true);
    if (document.pointerLockElement) document.exitPointerLock();
    dialog.showModal();
    search.focus();
  }
  function close(resume = false) {
    if (!dialog.open) return;
    dialog.close();
    onOpenChange?.(false);
    previousFocus?.focus?.({ preventScroll: true });
    if (resume) requestLock?.();
  }
  function blockKeys(e) {
    if (!dialog.open) return;
    e.stopImmediatePropagation();
    if (e.code === 'Escape' && e.type === 'keydown') { e.preventDefault(); close(); }
    if (e.code === 'ArrowDown' && e.target === search) { e.preventDefault(); list.firstElementChild?.focus(); }
  }
  addEventListener('keydown', blockKeys, true);
  addEventListener('keyup', blockKeys, true);
  return {
    show, sync,
    get open() { return dialog.open; },
    setVisible(v) { trigger.hidden = !v; if (v) sync(); else close(); },
    dispose() {
      close();
      removeEventListener('keydown', blockKeys, true);
      removeEventListener('keyup', blockKeys, true);
      trigger.remove(); dialog.remove();
    },
  };
}

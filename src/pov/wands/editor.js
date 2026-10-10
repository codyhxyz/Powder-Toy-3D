import { h } from '../../ui/dom.js';
import { SPELLS, SPELL_BY_ID, PRESETS, DEFAULT_CONFIG } from './catalog.js';
import { compileWand } from './compiler.js';
import './editor.css';

const STORAGE_KEY = 'tpt3d.wand.v1';
const errorText = (error) => typeof error === 'string' ? error : error.message ?? JSON.stringify(error);
const copy = (def) => ({ ...def, cards: [...def.cards], config: { ...DEFAULT_CONFIG, ...def.config } });

export function createWandEditor({ runtime, onSave, onOpenChange, toast }) {
  let draft, previousFocus;
  let saved = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && raw.length <= 32000) {
      const def = JSON.parse(raw);
      if (def && typeof def.name === 'string' && def.name.length <= 80 && Array.isArray(def.cards)
          && def.cards.length <= 256 && def.cards.every((id) => typeof id === 'string')
          && def.config && typeof def.config === 'object' && !Array.isArray(def.config)
          && Object.values(def.config).every((v) => typeof v === 'number' && Number.isFinite(v))) {
        if (!compileWand(def.cards, def.config).errors.length) saved = { id: 'custom', name: def.name, cards: def.cards, config: def.config };
      }
    }
  } catch { /* Storage can be unavailable or contain an obsolete deck. */ }

  const name = h('input', { type: 'text', maxlength: 80, 'aria-label': 'Wand name', on: { input: () => { draft.name = name.value; } } });
  const preset = h('select', { 'aria-label': 'Wand recipe', on: { change: () => {
    const def = preset.value === 'saved' ? saved : PRESETS.find((p) => p.id === preset.value);
    if (def) { draft = copy(def); renderDefinition(); }
  } } });
  const search = h('input', { type: 'search', placeholder: 'Search spells', 'aria-label': 'Search spells', on: { input: renderLibrary } });
  const category = h('select', { 'aria-label': 'Spell category', on: { change: renderLibrary } },
    h('option', { value: '', text: 'All categories' }),
    [...new Set(SPELLS.map((s) => s.category))].map((c) => h('option', { value: c, text: c })));
  const library = h('ul.we-library');
  const deck = h('ol.we-deck', { 'aria-label': 'Ordered spell deck' });
  const stats = h('p.we-stats');
  const errors = h('div.we-errors', { role: 'status', 'aria-live': 'polite' });
  const preview = h('ol.we-preview', { 'aria-label': 'Cast preview' });
  const reservoir = h('p.we-note');
  const configInputs = {};
  const configs = h('div.we-config', {}, [
    ['manaMax', 'Max mana', 1], ['manaRegen', 'Mana / second', 1],
    ['castDelay', 'Cast delay (s)', 0.01], ['recharge', 'Recharge (s)', 0.01], ['capacity', 'Card capacity', 1],
  ].map(([key, label, step]) => {
    const input = h('input', { type: 'number', min: 0, step, 'aria-label': label, on: { input: () => {
      draft.config[key] = input.value === '' ? NaN : Number(input.value); renderPreview();
    } } });
    configInputs[key] = input;
    return h('label', {}, label, input);
  }));
  const save = h('button.we-save', { type: 'button', text: 'Save & equip', on: { click: () => {
    if (!draft || save.disabled) return;
    draft.name = draft.name.trim() || 'Custom wand';
    const result = runtime.setDefinition(copy(draft));
    if (result.errors.length) { errors.textContent = result.errors.map(errorText).join('\n'); return; }
    saved = { id: 'custom', name: draft.name.trim() || 'Custom wand', cards: [...draft.cards], config: { ...result.config } };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); }
    catch { toast?.('Wand equipped. Browser storage is unavailable; changes will not survive reload.'); }
    onSave?.(draft);
    close();
  } } });
  const cancel = h('button', { type: 'button', text: 'Cancel', on: { click: close } });
  const dialog = h('dialog.wand-editor', { 'aria-labelledby': 'we-title', on: { cancel: (e) => { e.preventDefault(); close(); } } },
    h('header.we-header', {}, h('h2#we-title', { text: 'Edit wand' }), h('p', { text: 'Build an ordered deck. Modifiers affect the next spell; roots fire in sequence.' })),
    h('div.we-loadout', {}, h('label', {}, 'Name', name), h('label', {}, 'Start from a recipe', preset)),
    reservoir,
    h('div.we-columns', {},
      h('section.we-spells', { 'aria-label': 'Spell library' }, h('h3', { text: 'Spell library' }), h('div.we-filters', {}, search, category), library),
      h('section.we-build', { 'aria-label': 'Wand deck' }, h('div.we-deck-heading', {}, h('h3', { text: 'Ordered deck' }),
        h('button', { type: 'button', text: 'Clear deck', on: { click: () => { draft.cards = []; renderDeck(); } } })), deck,
      configs, stats, errors, h('h3', { text: 'Cast preview' }), preview)),
    h('footer.we-footer', {}, h('span', { text: 'Esc cancels · Changes apply only on Save' }), cancel, save));
  document.body.append(dialog);

  function renderLibrary() {
    const query = search.value.trim().toLowerCase();
    const matches = SPELLS.filter((s) => (!category.value || category.value === s.category)
      && `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(query));
    library.replaceChildren(...matches.map((s) => h('li', {},
      h('div', {}, h('strong', { text: s.name }), h('small', { text: s.category }), h('p', { text: s.description })),
      h('button', { type: 'button', text: 'Add', 'aria-label': `Add ${s.name}`, on: { click: () => {
        if (draft.cards.length >= 256) { toast?.('Deck limit reached. Remove a card first.'); return; }
        draft.cards.push(s.id); renderDeck();
      } } }))));
    if (!matches.length) library.append(h('li.we-empty', { text: 'No spells match. Try another search or category.' }));
  }

  function renderDeck(focusIndex, action) {
    deck.replaceChildren(...draft.cards.map((id, i) => {
      const move = (delta) => {
        [draft.cards[i], draft.cards[i + delta]] = [draft.cards[i + delta], draft.cards[i]];
        renderDeck(i + delta, delta < 0 ? 'up' : 'down');
      };
      const title = SPELL_BY_ID[id]?.name ?? id;
      return h('li', {}, h('span', { text: title }),
        h('button', { type: 'button', text: 'Up', disabled: i === 0, 'data-action': 'up', 'aria-label': `Move ${title} up`, on: { click: () => move(-1) } }),
        h('button', { type: 'button', text: 'Down', disabled: i === draft.cards.length - 1, 'data-action': 'down', 'aria-label': `Move ${title} down`, on: { click: () => move(1) } }),
        h('button', { type: 'button', text: 'Remove', 'data-action': 'remove', 'aria-label': `Remove ${title}`, on: { click: () => {
          draft.cards.splice(i, 1); renderDeck(Math.min(i, draft.cards.length - 1), 'remove');
        } } }));
    }));
    if (!draft.cards.length) deck.append(h('li.we-empty', { text: 'Your deck is empty. Add a spell from the library.' }));
    if (focusIndex >= 0) {
      const row = deck.children[focusIndex];
      const target = row?.querySelector(`[data-action="${action}"]:not(:disabled)`) ?? row?.querySelector('button:not(:disabled)');
      target?.focus();
    }
    renderPreview();
  }

  function nodeText(node, indent = '') {
    const title = SPELL_BY_ID[node.id]?.name ?? node.id ?? node.effect;
    const lines = [`${indent}${title}${node.effect ? ` (${node.effect})` : ''}`];
    for (const child of node.children ?? []) lines.push(nodeText(child, `${indent}  `));
    if (node.payload) lines.push(`${indent}  On ${node.trigger}${node.params?.delay != null ? ` after ${node.params.delay}s` : ''}:`, nodeText(node.payload, `${indent}    `));
    return lines.join('\n');
  }
  function renderPreview() {
    const result = compileWand(draft.cards, draft.config);
    const s = result.stats;
    const invalid = Object.values(draft.config).some((v) => !Number.isFinite(v));
    const messages = result.errors.map(errorText);
    if (invalid) messages.unshift('Enter a finite number for every wand setting.');
    errors.replaceChildren(...messages.map((message) => h('p', { text: message })));
    save.disabled = messages.length > 0 || !result.casts.length;
    stats.textContent = `${draft.cards.length} cards · ${s.castCount} casts · ${s.totalMana} mana / cycle · ${Number(s.recharge).toFixed(2)}s recharge`;
    preview.replaceChildren(...result.casts.map((cast, i) => h('li', {},
      h('strong', { text: `Cast ${i + 1} · ${cast.params.mana} mana · ${Number(s.castDelays[i]).toFixed(2)}s delay` }),
      h('pre', { text: nodeText(cast) }))));
    if (!result.casts.length) preview.append(h('li.we-empty', { text: 'No cast yet. Add a base spell, then place modifiers before it.' }));
  }
  function renderDefinition() {
    name.value = draft.name ?? 'Custom wand';
    for (const [key, input] of Object.entries(configInputs)) input.value = draft.config[key];
    reservoir.textContent = `${draft.description ? `${draft.description} ` : ''}` + (draft.sandboxReservoir
      ? `${draft.sandboxReservoir.label}: finite starter reservoir (${draft.sandboxReservoir.count} ${draft.sandboxReservoir.material}). Equipping again does not refill it.`
      : 'Create cards make new material. Stored-material cards use only what this wand has collected.');
    renderDeck();
  }
  function close() {
    if (!dialog.open) return;
    dialog.close();
    onOpenChange?.(false);
    previousFocus?.focus?.({ preventScroll: true });
  }
  // Capture before the game's window handlers, including global hotkeys. Keep
  // browser text editing and native dialog Tab navigation; nothing reaches play.
  function blockKeys(e) {
    if (!dialog.open) return;
    e.stopImmediatePropagation();
    if (e.code === 'Escape' && e.type === 'keydown') { e.preventDefault(); close(); }
  }
  addEventListener('keydown', blockKeys, true);
  addEventListener('keyup', blockKeys, true);
  return {
    get open() { return dialog.open; },
    show() {
      if (dialog.open) return;
      previousFocus = document.activeElement;
      draft = copy(runtime.definition ?? saved ?? PRESETS[0]);
      preset.replaceChildren(h('option', { value: '', text: 'Current wand', disabled: true }),
        ...(saved ? [h('option', { value: 'saved', text: 'Saved custom wand' })] : []),
        ...PRESETS.map((p) => h('option', { value: p.id, text: p.name })));
      preset.value = '';
      search.value = ''; category.value = '';
      renderDefinition(); renderLibrary();
      onOpenChange?.(true);
      if (document.pointerLockElement) document.exitPointerLock();
      dialog.showModal();
      name.focus();
    },
    close,
    dispose() { close(); removeEventListener('keydown', blockKeys, true); removeEventListener('keyup', blockKeys, true); dialog.remove(); },
  };
}

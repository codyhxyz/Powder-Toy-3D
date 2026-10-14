import { h } from '../../ui/dom.js';
import { createActionButtons } from '../../ui/actionButtons.js';
import { ITEMS, POCKETS } from './state.js';
import { VILLAGE_TOOLS } from './actions.js';
import './village.css';

// Original icons, with the soft silhouettes of a toy furniture catalogue.
const paths = {
  bed: '<path fill="#b98555" d="M4 12h28v17H4z"/><path fill="#8bbbab" d="M6 12h24v11H6z"/><path fill="#fff9e8" d="M7 9h9v7H7zm13 0h9v7h-9z"/><path d="M4 9v22m28-22v22M4 25h28"/>',
  chair: '<path fill="#d5a96c" d="M10 5h16v16H10zM7 19h22v6H7z"/><path d="M10 25v7m16-7v7M15 9v6m6-6v6"/>',
  table: '<path fill="#b98555" d="M16 16h4v14h-4z"/><ellipse fill="#e4c18c" cx="18" cy="12" rx="14" ry="7"/><path d="M11 30h14"/>',
  sofa: '<path fill="#91b69c" d="M7 9q0-3 3-3h16q3 0 3 3v17H7z"/><path fill="#b7cda3" d="M9 17h18v8H9z"/><path fill="#719981" d="M4 15h6v12H4zm22 0h6v12h-6z"/><path d="M8 27v4m20-4v4M18 10v13"/>',
  lamp: '<path fill="#f4d575" d="m12 4-6 15h24L24 4z"/><path d="M18 19v12m-8 0h16"/>',
  plant: '<path fill="#bc7854" d="M10 23h16l-3 10H13z"/><path fill="#91bc6f" d="M18 22V10C5 1 3 18 18 17m0 3c16 0 16-18 0-10"/>',
  dresser: '<path fill="#d2a269" d="M6 5h24v26H6z"/><path d="M6 13h24M6 22h24M15 9h6m-6 9h6m-6 8h6"/>',
  leaf: '<path fill="currentColor" stroke="none" d="M29 4C16 1 5 9 5 19c0 9 10 13 17 9l-3-5 5-3 4 5c6-6 5-14 1-21ZM8 31l3 2 13-20-2-1Z"/>',
  home: '<path d="m4 16 14-12 14 12M8 14v17h20V14M15 31V21h6v10"/>',
  pockets: '<path d="M8 7h20v20l-10 6-10-6zM8 13h20M12 4v6m12-6v6"/>',
  close: '<path d="m11 11 14 14m0-14L11 25"/>',
  rotate: '<path d="M9 11a12 12 0 1 1-2 14M9 3v9H1"/>',
  arrow: '<path d="m13 8 10 10-10 10"/>',
  check: '<path d="m7 19 7 7L29 10"/>',
  sound: '<path d="M5 14h6l9-8v24l-9-8H5zM26 12q7 6 0 12"/>',
  mute: '<path d="M5 14h6l9-8v24l-9-8H5zM25 14l7 8m0-8-7 8"/>',
  hand: '<path fill="#fffdf2" d="M14 30 7 23q-3-4 1-5l6 4V7q0-5 4-3l2 13q6-5 10 1l-1 10-5 4Z"/>',
  shelf: '<path fill="#c99562" d="M5 4h26v28H5z"/><path d="M8 14h20M8 24h20M11 7v7m5-7v7m6-5 3 5M12 17v7m6-6v6"/>',
  desk: '<path fill="#d4ac77" d="M4 12h28v5H4zM22 17h8v12h-8z"/><path d="M7 17v15m22-3v3M22 23h8M9 5h10v7H9z"/>',
  clock: '<path fill="#b98452" d="M9 4h18v28H9z"/><circle cx="18" cy="12" r="6" fill="#fff9e6"/><path d="M18 8v4l3 2m-3 6v7m-3 0h6"/>',
};
export const icon = kind => h('span.village-icon', { 'aria-hidden': 'true', html: `<svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths[kind] ?? paths[ITEMS[kind]?.family] ?? paths.leaf}</svg>` });
const button = (text, click, props = {}) => h('button', { type: 'button', on: { click }, ...props }, text);
const keycap = text => h('kbd.village-keycap', { text, 'aria-hidden': 'true' });

export function createVillageUi({ context, act, primary, onOpen, onClose, speakNext, stopSpeech, toggleMute }) {
  let tab = 'pockets', selected = null, message = '', dialogue = null, theme = 'all';
  let revealTimer = null, revealed = 0, typed = null, nextButton = null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const title = h('h2#village-title'), subtitle = h('p.village-subtitle');
  const emblem = h('span.village-emblem', {}, icon('pockets'));
  const content = h('div.village-content');
  const status = h('p.village-status', { role: 'status', 'aria-live': 'polite' });
  const footer = h('footer.village-footer');
  const closeButton = button([icon('close'), h('span', { text: 'Close' })], close, { class: 'village-close', 'aria-label': 'Close pockets or dialogue' });
  const dialog = h('dialog.village-panel', { 'aria-labelledby': 'village-title' },
    h('header.village-panel-head', {}, emblem, title, closeButton), subtitle, content, status, footer);
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dialog.addEventListener('click', e => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  });
  const location = h('span.village-location');
  const actions = createActionButtons('Village actions');
  const hint = h('small.village-action-hint', { role: 'status', 'aria-live': 'polite' });
  const reply = h('span.sr-only', { role: 'status', 'aria-live': 'polite' });
  const tools = h('div.village-tools', { role: 'group', 'aria-label': 'World tools' }, ...VILLAGE_TOOLS.map((t, i) =>
    button([keycap(String(i + 1)), h('span', { text: t.name })], () => { act({ type: 'tool', key: t.key }); syncActions(); },
      { 'aria-pressed': 'false', title: t.hint })));
  const toolHelp = h('small.village-tool-help');
  const hud = h('div.village-hud', { hidden: true }, h('div.village-kit', {}, h('div.village-place', {}, icon('leaf'),
    h('div', {}, location, h('small.village-keyhelp', { text: 'WASD to walk · hold Space, release to leap' }),
      h('small.village-touchhelp', { text: 'Left stick to walk · hold Jump, release to leap' }))), tools, toolHelp),
    h('div.village-controls', {}, hint, actions.root), reply);
  document.body.append(hud, dialog);

  function syncActions() {
    const c = context(), active = c.active && !dialog.open, action = active ? primary() : null;
    const equipped = VILLAGE_TOOLS.find(t => t.key === c.tool) ?? VILLAGE_TOOLS[0];
    tools.hidden = !active || !!c.carry || !!c.grip || !!c.rest || !!c.busy; toolHelp.hidden = tools.hidden;
    [...tools.children].forEach((b, i) => b.setAttribute('aria-pressed', String(VILLAGE_TOOLS[i].key === c.tool)));
    const readout = c.tool && c.readout ? `${c.readout.name}${c.readout.note ? ` · ${c.readout.note}` : ''}` : '';
    const toolText = readout ? `${equipped.hint} ${readout}` : equipped.hint;
    if (toolHelp.textContent !== toolText) toolHelp.textContent = toolText;
    if (reply.textContent !== c.reaction) reply.textContent = c.reaction;
    const help = c.feedback || c.warning || (c.grip ? `${c.grip.name} · Move the stick or use WASD to push/pull one square.`
      : c.rest ? c.rest === 'sleep' ? 'Sleeping peacefully.' : 'Taking a little rest.'
      : c.busy ? 'Opening or closing the dresser…'
      : c.carry ? `${c.carry.name} · ${c.carry.error || 'Pocket placement preview. Green means you can set it down.'}`
      : c.home ? 'Walk up to furniture to use it or grab it.' : 'Walk up to a neighbor to talk.');
    if (hint.textContent !== help) hint.textContent = help;
    hint.hidden = !active || (!c.carry && !c.grip && !c.rest && !c.busy && !c.warning && !c.feedback && !c.reaction && !!action);
    const run = type => { act({ type }); syncActions(); };
    actions.update(!active ? [] : c.grip ? [
      { id: 'release', label: 'Let go', key: 'E', codes: ['KeyE', 'Escape'], run: () => run('cancel') },
      { id: 'stow', label: 'Put in pockets', key: 'I', codes: ['KeyI', 'KeyQ'], disabled: c.grip.moving, run: () => run('stow') },
    ] : c.rest ? [
      { id: 'stand', label: c.rest === 'sleep' ? 'Wake up' : 'Stand up', key: 'E', codes: ['KeyE', 'Escape'], run: () => run('cancel') },
    ] : c.busy ? [
      { id: 'cancel', label: 'Cancel', key: 'Esc', codes: ['Escape'], run: () => run('cancel') },
    ] : c.carry ? [
      { id: 'drop', label: 'Set down', key: 'E', codes: ['KeyE'], disabled: !!c.carry.error, run: () => run('drop') },
      { id: 'rotate', label: `Rotate · ${c.carry.rotation * 90}°`, key: 'R', codes: ['KeyR'], run: () => run('rotate') },
      { id: 'stow', label: 'Put in pockets', key: 'I', codes: ['KeyI', 'KeyQ'], run: () => run('stow') },
      { id: 'cancel', label: 'Cancel move', key: 'Esc', codes: ['Escape'], run: () => run('cancel') },
    ] : [
      ...(action ? [{ id: 'interact', label: action.title, key: 'E', codes: ['KeyE'], run: () => act({ type: 'interact' }) }] : []),
      ...(action?.secondary ? [{ id: 'grab-near', label: action.secondary.title, key: 'G', codes: ['KeyG'], run: () => act({ type: 'secondary' }) }] : []),
      ...(equipped.primary ? [{ id: 'tool-primary', label: equipped.primary, key: 'Click', run: () => run('tool-primary') }] : []),
      ...(equipped.secondary ? [{ id: 'tool-secondary', label: equipped.secondary, key: 'RMB', run: () => run('tool-secondary') }] : []),
      ...(!c.tool ? [{ id: 'punch', label: 'Punch', key: 'Click', run: () => run('punch') }] : []),
      { id: 'kick', label: 'Kick', key: 'F', codes: ['KeyF'], run: () => run('kick') },
      { id: 'pockets', label: 'Pockets', key: 'I', codes: ['KeyI', 'KeyQ'], run: () => open('pockets') },
    ]);
  }
  function stopReveal() { clearTimeout(revealTimer); revealTimer = null; }
  function reveal() {
    if (!dialogue || !dialog.open) return;
    if (typed) typed.textContent = dialogue.text.slice(0, revealed);
    const finished = revealed >= dialogue.text.length;
    if (nextButton) {
      nextButton.querySelector('span').textContent = finished ? (dialogue.choiceOnly ? 'Choose an answer' : 'Keep chatting') : 'Show full message';
      nextButton.disabled = finished && !!dialogue.choiceOnly;
      nextButton.hidden = nextButton.disabled;
      if (nextButton.disabled && document.activeElement === nextButton)
        content.querySelector('.village-topic')?.focus();
    }
    dialog.classList.toggle('is-revealing', !finished);
    if (!finished) revealTimer = setTimeout(() => { revealed++; reveal(); }, /[.!?]/.test(dialogue.text[revealed - 1] ?? '') ? 160 : 36);
    else revealTimer = null;
  }
  function advance() {
    if (!dialogue) return;
    if (revealed < dialogue.text.length) {
      stopReveal(); revealed = dialogue.text.length; reveal(); stopSpeech?.();
    } else if (!dialogue.choiceOnly) speakNext();
  }
  function close() {
    stopReveal();
    if (!dialog.open) return;
    dialog.close(); dialogue = null; selected = null; onClose();
    document.body.classList.remove('village-menu-open');
    syncActions();
  }
  function show() {
    if (onOpen() === false) return;
    document.body.classList.add('village-menu-open');
    if (!dialog.open) dialog.showModal();
    syncActions(); draw();
    (dialogue ? (nextButton?.disabled ? content.querySelector('.village-topic') : nextButton) : closeButton)?.focus();
  }
  function open(which = 'pockets') {
    const c = context();
    if (!c.active || c.carry || !['pockets', 'storage', 'catalogue'].includes(which) || (which === 'storage' && !c.dresser)) return;
    if (which === 'storage' && !c.storageReady) { act({ type: 'openStorage' }); return; }
    if (c.busy) return;
    stopReveal();
    tab = which; selected = null; message = ''; dialogue = null; show();
  }
  function action(a) {
    const result = act(a);
    if (result?.pending) return;
    message = (result?.error ?? context().warning) || 'All set!';
    dialog.dataset.result = result?.error ? 'error' : 'success';
    if (!result?.error) selected = null;
    draw();
  }
  function draw() {
    const focus = document.activeElement?.dataset.focus, c = context();
    content.replaceChildren(); footer.replaceChildren();
    dialog.dataset.surface = dialogue ? 'dialogue' : tab;
    title.textContent = dialogue ? dialogue.name : tab === 'catalogue' ? 'Furniture catalogue' : tab === 'storage' ? 'Your dresser' : 'Your pockets';
    emblem.replaceChildren(icon(tab === 'storage' ? 'dresser' : 'pockets'));
    subtitle.textContent = dialogue ? '' : tab === 'catalogue' ? 'Choose a piece for your home. Orders go straight into your pockets, free of charge.' : tab === 'storage' ? 'Tucked away, ready for another day.' : 'All your little possibilities, in one place.';
    status.textContent = message || c.warning || '';
    status.hidden = !status.textContent;
    if (dialogue) {
      dialog.style.setProperty('--speaker-color', dialogue.shirt);
      typed = h('span.village-typed', { 'aria-hidden': 'true' });
      const speech = h('p.village-dialogue', {}, h('span.sr-only', { text: dialogue.text }), typed);
      nextButton = button([h('span'), icon('arrow')], advance, { class: 'village-next', 'data-focus': 'next' });
      content.append(speech, h('div.village-choices', {},
        nextButton, ...(dialogue.choices ?? []).map(choice => button(choice.label, () => {
          if (dialogue.choiceOnly && revealed < dialogue.text.length) { advance(); return; }
          speakNext(choice.id);
        },
          { class: 'village-topic', 'data-focus': `topic-${choice.id}` })),
        ...(dialogue.choiceOnly ? [] : [button('See you soon!', close, { class: 'village-goodbye' })])));
      footer.append(h('span.village-chat-hint', {}, keycap('E'), h('span', { text: dialogue.choiceOnly ? 'Reveal message · choose an answer' : 'or tap to continue' })),
        button([icon(c.muted ? 'mute' : 'sound'), h('span', { text: c.muted ? 'Sound off' : 'Animalese' })],
          () => { toggleMute(); draw(); }, { class: 'village-sound', 'aria-label': c.muted ? 'Unmute animalese' : 'Mute animalese', 'data-focus': 'sound' }));
      stopReveal(); reveal();
    } else {
      drawCollection(c);
      footer.append(h('span.village-count', {}, icon(tab === 'storage' ? 'dresser' : 'pockets'),
        h('span', { text: tab === 'storage' ? `${c.state.storage.length} tucked away` : `${c.state.pockets.length} / ${POCKETS} pockets filled` })),
        h('span.village-footer-hint', {}, keycap('Esc'), h('span', { text: 'Close' })));
    }
    if (focus) [...dialog.querySelectorAll('[data-focus]')].find(el => el.dataset.focus === focus)?.focus();
  }
  function drawCollection(c) {
    const tabs = h('nav.village-tabs', { 'aria-label': 'Furniture collections' });
    for (const [key, label, symbol] of [['pockets', 'Pockets', 'pockets'], ['storage', 'Dresser', 'dresser'], ['catalogue', 'Catalogue', 'leaf']]) {
      tabs.append(button([icon(symbol), h('span', { text: label })], () => {
        if (key === 'storage') { open('storage'); return; }
        tab = key; selected = null; message = ''; draw();
      }, {
        'aria-current': tab === key ? 'page' : null, disabled: key === 'storage' && !c.dresser,
        title: key === 'storage' && !c.dresser ? 'Stand beside your dresser to open storage' : '',
      }));
    }
    content.append(tabs);
    const catalogue = tab === 'catalogue';
    if (catalogue) {
      const filter = h('select', { 'aria-label': 'Furniture theme', on: { change(e) { theme = e.target.value; selected = null; draw(); } } },
        h('option', { value: 'all', text: 'All sets' }),
        ...[...new Set(Object.values(ITEMS).map(i => i.theme ?? 'classic'))].map(value =>
          h('option', { value, text: value[0].toUpperCase() + value.slice(1) })));
      filter.value = theme;
      content.append(h('label.village-theme', {}, 'Browse a set ', filter));
    }
    const items = catalogue ? Object.entries(ITEMS).filter(([, spec]) => theme === 'all' || (spec.theme ?? 'classic') === theme)
      .map(([kind]) => ({ id: kind, kind })) : c.state[tab];
    const grid = h(`div.village-pockets${catalogue ? '.village-catalogue' : ''}`, { role: 'group', 'aria-label': `${tab} furniture` });
    const count = catalogue ? items.length : tab === 'pockets' ? POCKETS : Math.max(10, Math.ceil(items.length / 10) * 10);
    for (let i = 0; i < count; i++) {
      const item = items[i];
      if (!item) { grid.append(h('span.village-empty', { 'aria-label': 'Empty pocket' })); continue; }
      grid.append(button([icon(item.kind), h('span.village-item-label', { text: ITEMS[item.kind].name }), icon('hand')],
        () => { selected = item.id; message = ''; draw(); }, {
          class: 'village-slot', 'aria-pressed': String(item.id === selected), 'data-focus': item.id,
          'aria-label': ITEMS[item.kind].name, title: ITEMS[item.kind].name,
        }));
    }
    content.append(grid);
    const item = items.find(i => i.id === selected);
    if (item) {
      const menu = h('div.village-item-menu', { 'aria-label': `${ITEMS[item.kind].name} actions` },
        h('strong', { text: ITEMS[item.kind].name }));
      if (catalogue) {
        menu.append(h('p', { text: `${ITEMS[item.kind].theme ?? 'Classic'} set · ${ITEMS[item.kind].w} × ${ITEMS[item.kind].d} floor space` }),
          item.kind === 'dresser' ? h('p', { text: 'Included with your home. Walk up to it to open storage.' }) :
            button('Add to pockets', () => action({ type: 'order', kind: item.kind }), { disabled: !(c.home || c.catalogue) || c.state.pockets.length >= POCKETS }));
      } else if (tab !== 'storage') {
        menu.append(button('Take out to place', () => {
          const result = act({ type: 'grab', id: item.id });
          if (result?.error) { message = result.error; draw(); }
        }, { disabled: !c.home }));
        menu.append(button('Store in dresser', () => action({ type: 'store', id: item.id }), { disabled: !c.dresser }));
      } else menu.append(button('Take out', () => action({ type: 'withdraw', id: item.id })));
      content.append(menu);
    } else content.append(h('p.village-collection-hint', { text: items.length ? 'Pick something. Make a little change.' : tab === 'storage' ? 'Room for something lovely. Store furniture from your pockets.' : 'Nothing here just yet. Have a peek in your dresser.' }));
    if (!c.home) content.append(h('p.village-tip', { text: 'Make yourself at home in the first cottage at the west end of the lane.' }));
  }
  return {
    open, close, draw, get opened() { return dialog.open; }, get talking() { return !!dialogue; },
    handleKey(e) { syncActions(); return actions.handleKey(e); },
    dialogueKey(e) { if (dialogue && e.code === 'KeyE') { e.preventDefault(); if (!e.repeat) advance(); } },
    talk(resident, text, choices = [], options = {}) {
      stopReveal(); dialogue = { ...resident, text, choices, choiceOnly: !!options.choiceOnly }; revealed = reducedMotion.matches ? text.length : 0;
      message = ''; show();
    },
    update({ active, place }) {
      hud.hidden = !active;
      if (!active) close();
      else location.textContent = place;
      syncActions();
    },
  };
}

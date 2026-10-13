import { h } from './dom.js';
import './actionButtons.css';

// Contextual actions share one callback for tap, click and keyboard.
// update([{ id, label, key: 'E', codes: ['KeyE'], run, disabled? }]);
// Omit irrelevant actions. Owners forward handleKey after their menu/input guards.
export function createActionButtons(label = 'Available actions') {
  const root = h('div.action-buttons', { role: 'group', 'aria-label': label, hidden: true });
  const buttons = new Map();
  let actions = [];
  function update(next) {
    actions = next;
    root.hidden = !next.length;
    for (const [id, entry] of buttons) if (!next.some(a => a.id === id)) {
      entry.button.remove(); buttons.delete(id);
    }
    for (const [index, action] of next.entries()) {
      let entry = buttons.get(action.id);
      if (!entry) {
        const text = h('span.action-label', { 'aria-live': 'polite' });
        const key = h('kbd.action-key', { 'aria-hidden': 'true' });
        const button = h('button.action-button', { type: 'button', 'data-action': action.id, on: {
          click() {
            const current = actions.find(a => a.id === action.id);
            if (current && !current.disabled && !root.hidden) current.run();
          },
        } }, text, key);
        entry = { button, text, key }; buttons.set(action.id, entry); root.append(button);
      }
      if (root.children[index] !== entry.button) root.insertBefore(entry.button, root.children[index] ?? null);
      if (entry.text.textContent !== action.label) entry.text.textContent = action.label;
      if (entry.key.textContent !== (action.key ?? '')) entry.key.textContent = action.key ?? '';
      entry.key.hidden = !action.key;
      entry.button.disabled = !!action.disabled;
      if (action.key) entry.button.setAttribute('aria-keyshortcuts', action.key);
      else entry.button.removeAttribute('aria-keyshortcuts');
    }
  }
  return {
    root, update,
    handleKey(e) {
      if (root.hidden || e.isComposing || e.metaKey || e.ctrlKey || e.altKey
        || e.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return false;
      const action = actions.find(a => a.codes?.includes(e.code));
      if (!action) return false;
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat && !action.disabled) action.run();
      return true;
    },
    dispose() { actions = []; buttons.clear(); root.remove(); },
  };
}

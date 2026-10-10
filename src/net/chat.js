import { h } from '../ui/dom.js';

// Multiplayer chat, the Minecraft way: T opens a line at the bottom left, Enter
// sends, Esc closes. New lines show for a while and then fade; while the chat
// is open the whole recent history shows. Text is only ever set as textContent.

export const MAX_CHAT_CHARS = 256;  // Minecraft's chat limit; relay/worker.js enforces the same
const VISIBLE_MS = 10_000;          // a line stays up this long after it arrives (Minecraft: 200 ticks)
const FADE_MS = 1_000;              // then fades out over this long
const HISTORY_LINES = 100;          // lines kept (Minecraft keeps 100)
const SYSTEM_COLOR = '#ffe066';     // join and leave notices, Minecraft's yellow

export function createChat({ onSend }) {
  const log = h('div.chat-log', { role: 'log', 'aria-live': 'polite' });
  const input = h('input.chat-input', {
    type: 'text', maxLength: MAX_CHAT_CHARS, autocomplete: 'off', spellcheck: 'false', 'data-1p-ignore': true,
    placeholder: 'Say something to everyone here', 'aria-label': 'Chat message',
  });
  const el = h('div.chat', {}, log, input);
  document.body.append(el);

  let open = false;

  function add(line) {
    line.style.setProperty('--fade-ms', `${FADE_MS}ms`);
    setTimeout(() => line.classList.add('faded'), VISIBLE_MS);
    log.append(line);
    while (log.childElementCount > HISTORY_LINES) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  function setOpen(v) {
    open = v;
    el.classList.toggle('open', v);
    if (v) {
      if (document.pointerLockElement) document.exitPointerLock(); // free the mouse, as Minecraft does
      input.focus();
      log.scrollTop = log.scrollHeight;
    } else {
      input.value = '';
      input.blur();
    }
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keys typed here are text, not hotkeys
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = input.value.trim();
    if (text) onSend(text);
    setOpen(false);
  });
  input.addEventListener('blur', () => { if (open) setOpen(false); });

  return {
    get isOpen() { return open; },
    open: () => setOpen(true),
    close: () => setOpen(false),
    // A player's message: <name> text, the name in their colour.
    say(name, color, text) {
      add(h('p.chat-line', {}, h('span.chat-name', { style: { color }, text: `<${name}>` }), ` ${text}`));
    },
    // A notice from the game (someone joined or left).
    notice(text) {
      add(h('p.chat-line', { style: { color: SYSTEM_COLOR }, text }));
    },
    clear() { log.replaceChildren(); setOpen(false); },
  };
}

import { h } from '../../ui/dom.js';
import './debtBadge.css';

const IDENTITY = 'translate(0px, 0px) scale(1)';

/** Standalone HUD: active means village enabled, not unpaused or menu closed. */
export function createDebtBadge() {
  const number = h('span.village-debt-number');
  // An original Nibs mark: a split seed with a small floating notch.
  const glyph = h('span.village-debt-glyph', {
    'aria-hidden': 'true',
    html: '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false"><path d="M8 12Q5 23 15 27Q26 23 24 12L18 16L13 8Z" fill="currentColor"/><path d="m19 5 5 3-4 4" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="m14 16 2 6" stroke="#fff9e6" stroke-width="2" stroke-linecap="round"/></svg>',
  });
  const spoken = h('span.village-debt-spoken');
  const bubble = h('div.village-debt-badge', {
    hidden: true, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true',
    style: { transform: IDENTITY },
  }, h('div.village-debt-face', { 'aria-hidden': 'true' },
    glyph, number, h('span.village-debt-caption', { text: 'Your balance' })), spoken);
  document.body.append(bubble);
  const topLayer = typeof bubble.showPopover === 'function';
  if (topLayer) bubble.setAttribute('popover', 'manual');

  const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let animation = null, disposed = false, revealed = false, pending = false;
  let lastBalance = null;
  let lastModal = null;

  function hideOverlay() {
    try { if (bubble.matches?.(':popover-open')) bubble.hidePopover(); } catch { /* detached or unsupported */ }
    lastModal = null;
  }
  function showOverlay() {
    if (!topLayer) return;
    const modal = document.querySelector?.('dialog[open]') ?? null;
    try {
      // Native dialogs outrank every z-index. Reinsert the SAME noninteractive
      // bubble into the top layer when a later modal opens above it.
      if (modal !== lastModal && bubble.matches(':popover-open')) bubble.hidePopover();
      if (!bubble.matches(':popover-open')) bubble.showPopover();
      lastModal = modal;
    } catch { /* Older browsers still get the ordinary fixed HUD. */ }
  }

  function settle() {
    const previous = animation;
    animation = null;
    if (previous) {
      previous.onfinish = null;
      previous.oncancel = null;
      previous.cancel();
    }
    bubble.style.transform = IDENTITY;
    bubble.style.opacity = '1';
  }

  function reveal() {
    revealed = true;
    pending = false;
    if (typeof bubble.animate !== 'function') return;
    try {
      let frames, options;
      if (motion?.matches) {
        frames = [{ opacity: 0.65 }, { opacity: 1 }];
        options = { duration: 180, easing: 'ease-out' };
      } else {
        // FLIP the entire bubble, not separate icon/number copies. A backwards
        // fill holds the large central pose before one simultaneous flight.
        const rect = bubble.getBoundingClientRect();
        const x = window.innerWidth / 2 - (rect.left + rect.width / 2);
        const y = window.innerHeight / 2 - (rect.top + rect.height / 2);
        frames = [
          { transform: `translate(${x}px, ${y}px) scale(2)` },
          { transform: IDENTITY },
        ];
        options = {
          delay: 1200, duration: 750, fill: 'both',
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        };
      }
      animation = bubble.animate(frames, options);
      animation.onfinish = settle;
      animation.oncancel = settle;
    } catch {
      // The ordinary CSS pose is always a usable dock, even without WAAPI.
      settle();
    }
  }

  window.addEventListener('resize', settle);
  window.visualViewport?.addEventListener('resize', settle);
  motion?.addEventListener?.('change', settle);

  return {
    update({ active, balance, reveal: requested = false }) {
      if (disposed) return;
      if (requested && !revealed) pending = true;
      const visible = Boolean(active) && Number.isFinite(balance) && balance !== 0;
      bubble.hidden = !visible;
      if (!visible) {
        hideOverlay();
        settle();
        return;
      }
      showOverlay();
      if (balance !== lastBalance) {
        lastBalance = balance;
        const amount = Math.abs(balance).toLocaleString('en-US');
        number.textContent = `${balance < 0 ? '−' : ''}${amount}`;
        const label = balance < 0 ? `Your balance: debt ${amount} Nibs` : `Your balance: ${amount} Nibs`;
        bubble.setAttribute('aria-label', label);
        spoken.textContent = label;
      }
      if (pending && !revealed) reveal();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      hideOverlay();
      settle();
      window.removeEventListener('resize', settle);
      window.visualViewport?.removeEventListener('resize', settle);
      motion?.removeEventListener?.('change', settle);
      bubble.remove();
    },
  };
}

import { createHotbar, HOTBAR_SLOTS } from './hotbar.js';
import { sharedTransfer, emptyLoads } from './transfer.js';
import { povEvents } from '../events.js';

export { emptyLoads };

// The POV toolbelt: finds every ./*.tool.js, puts each in its hotbar slot, and
// drives the selected one. See docs/pov.md, "The tool contract".
//
// Tools get the shell's env plus:
//   env.transfer   the shared exact cell transfer (transfer.js)
//   env.feedback   the shared "can't" responses, the same for every tool:
//                    toast(text)         a toast
//                    notice(text)        a toast, at most once per NOTICE_INTERVAL per tool
//                    shake()             a shake of the tool's slot
//                    refuse(text, extra) a notice, a shake and tool:action 'refuse' (extra: { id, point })

const modules = import.meta.glob('./*.tool.js', { eager: true });
const DEFAULT_SLOT = 0;   // slot 1 (the shovel) is selected first
const NOTICE_INTERVAL = 1.5;   // s between repeats of a tool's notice and refuse toasts
const MS_PER_S = 1000;

export function createToolbelt(env) {
  const hotbar = createHotbar();
  const transfer = sharedTransfer(env);
  const tools = Array(HOTBAR_SLOTS).fill(null);   // { def, inst } per slot

  for (const [path, mod] of Object.entries(modules)) {
    const def = mod.default;
    if (!def?.create) continue;
    const i = (def.slot ?? 0) - 1;
    if (i < 0 || i >= HOTBAR_SLOTS || tools[i]) {
      console.warn(`toolbelt: ${path} wants slot ${def.slot}, which is ${tools[i] ? 'taken' : 'out of range'}`);
      continue;
    }
    let lastNotice = -Infinity;
    const feedback = {
      toast: (text) => env.hud?.toast?.(text),
      shake: () => hotbar.shake(i),
      notice(text) {
        const now = performance.now() / MS_PER_S;
        if (now - lastNotice < NOTICE_INTERVAL) return false;
        lastNotice = now;
        feedback.toast(text);
        return true;
      },
      refuse(text, extra) {
        if (!feedback.notice(text)) return;
        feedback.shake();
        povEvents.emit('tool:action', { tool: def.key.toLowerCase(), action: 'refuse', ...extra });
      },
    };
    tools[i] = { def, inst: def.create({ ...env, transfer, feedback }) };
    hotbar.setTool(i, def);
  }

  let selected = DEFAULT_SLOT;
  hotbar.select(selected);

  function select(i) {
    i = ((i % HOTBAR_SLOTS) + HOTBAR_SLOTS) % HOTBAR_SLOTS;
    if (i === selected) return;
    tools[selected]?.inst.deselect?.();
    selected = i;
    hotbar.select(i);
    env.requestRender?.();
  }

  // keys 1–9 pick a slot while in POV (and don't reach the god view's hotkeys)
  function onKey(e) {
    if (!env.isActive?.() || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const n = e.key >= '1' && e.key <= '9' && e.key.length === 1 ? +e.key : 0;
    if (!n || n > HOTBAR_SLOTS) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    select(n - 1);
  }
  addEventListener('keydown', onKey, { capture: true });

  return {
    get selected() { return selected; },
    get transfer() { return transfer; },
    tool: (i) => tools[i]?.inst ?? null,
    select,
    update(ctx) {
      const cur = tools[selected]?.inst;
      if (ctx.wheel && !cur?.wantsWheel?.()) select(selected + Math.sign(ctx.wheel));
      tools[selected]?.inst.update(ctx);
      tools.forEach((t, i) => hotbar.setStatus(i, t?.inst.status?.() ?? ''));
    },
    setVisible(v) {
      hotbar.setVisible(v);
      if (!v) tools[selected]?.inst.deselect?.();
    },
    // The window moved over the world by (dx, 0, dz) cells (docs/scaling.md
    // D11): every tool, selected or not, moves the grid positions it keeps.
    windowShifted(dx, dz) { tools.forEach((t) => t?.inst.windowShifted?.(dx, dz)); },
    dispose() {
      removeEventListener('keydown', onKey, { capture: true });
      tools.forEach((t) => { t?.inst.deselect?.(); t?.inst.dispose?.(); });
      hotbar.dispose();
    },
  };
}

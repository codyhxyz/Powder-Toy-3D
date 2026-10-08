import { createHotbar, HOTBAR_SLOTS } from './hotbar.js';
import { sharedTransfer } from './transfer.js';

// The POV toolbelt: finds every ./*.tool.js, puts each in its hotbar slot, and
// drives the selected one. See docs/pov.md, "The tool contract".
//
// Tools get the shell's env plus:
//   env.transfer   the shared exact cell transfer (transfer.js)
//   env.feedback   { toast(text), shake() }: a toast, or a shake of the tool's slot

const modules = import.meta.glob('./*.tool.js', { eager: true });
const DEFAULT_SLOT = 0;   // slot 1 (the shovel) is selected first

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
    const feedback = {
      toast: (text) => env.hud?.toast?.(text),
      shake: () => hotbar.shake(i),
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
    dispose() {
      removeEventListener('keydown', onKey, { capture: true });
      tools.forEach((t) => { t?.inst.deselect?.(); t?.inst.dispose?.(); });
      hotbar.dispose();
    },
  };
}

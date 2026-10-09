import { createHotbar, HOTBAR_SLOTS } from './hotbar.js';
import { sharedTransfer, emptyLoads } from './transfer.js';
import { povEvents } from '../events.js';
import { createBallistics } from '../ballistics.js';

export { emptyLoads };

// The POV toolbelt: finds every ./*.tool.js, puts each in its hotbar slot, and
// drives the selected one. See docs/pov.md, "The tool contract".
//
// Tools get the shell's env plus:
//   env.transfer   the shared exact cell transfer (transfer.js)
//   env.ballistics the shared projectiles (ballistics.js: the gun's rounds, the bomb): the toolbelt
//                  flies them every frame whichever tool is held, and on its own clock while hidden
//   env.feedback   the shared "can't" responses, the same for every tool:
//                    toast(text)         a toast
//                    notice(text)        a toast, at most once per NOTICE_INTERVAL per tool
//                    shake()             a shake of the tool's slot
//                    refuse(text, extra) a notice, a shake and tool:action 'refuse' (extra: { id, point })

const modules = import.meta.glob('./*.tool.js', { eager: true });
// every tool's definition, with where it came from
const toolDefs = () => Object.entries(modules).map(([path, mod]) => ({ path, def: mod.default })).filter(({ def }) => def?.create);
const DEFAULT_SLOT = 0;   // slot 1 (the shovel) is selected first
const NOTICE_INTERVAL = 1.5;   // s between repeats of a tool's notice and refuse toasts
const MS_PER_S = 1000;

export function createToolbelt(env) {
  const hotbar = createHotbar();
  const transfer = sharedTransfer(env);
  const ballistics = createBallistics({ renderer: env.renderer });
  ballistics.prepare(env.getSim());
  // Hidden (out of POV, dead) the toolbelt isn't updated, but what's in the air
  // keeps flying until it lands, at the last frame's step rate.
  let shown = false, lastSteps = 0, raf = 0, rafAt = 0;
  function drive(now) {
    raf = 0;
    if (shown || !ballistics.count) return;
    const dt = rafAt ? (now - rafAt) / MS_PER_S : 0;
    rafAt = now;
    ballistics.update({ sim: env.getSim(), dt, stepsPerFrame: lastSteps });
    raf = requestAnimationFrame(drive);
  }
  const tools = Array(HOTBAR_SLOTS).fill(null);   // { def, inst } per slot

  for (const { path, def } of toolDefs()) {
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
    tools[i] = { def, inst: def.create({ ...env, transfer, ballistics, feedback }) };
    hotbar.setTool(i, def);
  }

  let selected = DEFAULT_SLOT;
  let readout = null;   // the selected tool's readout?.(ctx) from the last update
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
    get selectedKey() { return tools[selected]?.def.key ?? null; },   // the held tool's key ('GUN', ...)
    get transfer() { return transfer; },
    get ballistics() { return ballistics; },
    get readout() { return readout; },
    tool: (i) => tools[i]?.inst ?? null,
    select,
    update(ctx) {
      const cur = tools[selected]?.inst;
      if (ctx.wheel && !cur?.wantsWheel?.()) select(selected + Math.sign(ctx.wheel));
      tools[selected]?.inst.update(ctx);
      readout = tools[selected]?.inst.readout?.(ctx) ?? null;
      lastSteps = ctx.stepsPerFrame;
      ballistics.update(ctx);
      tools.forEach((t, i) => hotbar.setStatus(i, t?.inst.status?.() ?? ''));
    },
    setVisible(v) {
      hotbar.setVisible(v);
      shown = v;
      if (!v && ballistics.count && !raf) { rafAt = 0; raf = requestAnimationFrame(drive); }
      if (!v) { tools[selected]?.inst.deselect?.(); readout = null; }
    },
    dispose() {
      removeEventListener('keydown', onKey, { capture: true });
      if (raf) cancelAnimationFrame(raf);
      ballistics.dispose();
      tools.forEach((t) => { t?.inst.deselect?.(); t?.inst.dispose?.(); });
      hotbar.dispose();
    },
  };
}

// An NPC's tools (npc.js): every tool the player has, headless. The same tool
// code, so the same physics and rules; its own pack and bucket (env.owner); the
// shared projectiles (env.ballistics, the player's toolbelt's, which flies them);
// no hotbar and no toasts. Held models hang on env.viewmodel, a group nobody
// draws. A refusal (no room to throw, nothing to build with) is kept as
// lastRefusal, so the brain can tell a tool failed and try something else.
//
// Run tools inside povEvents.as(actor, ...) (npc.js does), so what they emit is
// the NPC's.
export function createKit(env) {
  const transfer = sharedTransfer(env);
  let lastRefusal = null;
  const feedback = {
    toast() {}, shake() {},
    notice() { return false; },
    refuse(text) { lastRefusal = { text, at: performance.now() / MS_PER_S }; },
  };
  const tools = new Map();
  for (const { path, def } of toolDefs()) {
    try {
      tools.set(def.key, def.create({ ...env, transfer, feedback, hud: null, isActive: () => false }));
    } catch (err) { console.error(`kit: ${path} failed to start`, err); }
  }
  let held = null;
  return {
    get keys() { return [...tools.keys()]; },
    tool: (key) => tools.get(key) ?? null,
    get held() { return held; },
    get lastRefusal() { return lastRefusal; },
    // run tool `key` this frame with ctx (the one held before is put away first)
    use(key, ctx) {
      if (held !== key) { tools.get(held)?.deselect?.(); held = key; }
      tools.get(key)?.update(ctx);
    },
    putAway() { tools.get(held)?.deselect?.(); held = null; },
    dispose() {
      tools.forEach((t) => { t.deselect?.(); t.dispose?.(); });
      tools.clear();
    },
  };
}

import { h } from '../ui/dom.js';
import { modelIcon, MODELS } from './models.js';
import { PERK } from './perks.js';
import { povEvents } from './events.js';
import { CLASSES, CLASS, STATS, RESPAWN_ROOM_S, applyClass, classStats, heldTool, keyName } from './classes.js';
import { renderPortraits } from './classPortraits.js';
import './classPicker.css';

// The class picker: Team Fortress 2's class-select screen, opened with its key
// (comma) in first person. A row of cards, one per class (classes.js): a posed
// portrait of the wizard in the class's colours (classPortraits.js), its name
// and line, its loadout (the hotbar's tool sprites, the perks' icons; what this
// build lacks is dimmed, "coming soon") and its bars. 1–7 pick, the arrows and
// Enter, the mouse; Esc or comma closes. The pointer is let go while it's open
// and taken back after.
//
// Picking takes effect at the next spawn, or at once within RESPAWN_ROOM_S of
// one (TF2's respawn room). The shell calls spawned(body) on every spawn.
//
// env: { isActive, getBody, getToolbelt, lock, unlock, isLocked, toast }

const STORE_KEY = 'tpt3d.pov.class';    // the last class picked, kept in this browser
const MS_PER_S = 1000;
const STAT_PIPS = 5;                    // segments in a bar
const TEAM_NAMES = { red: 'Red team', blue: 'Blue team', infected: 'Infected' };

// every *.tool.js this build has, by key (the toolbelt loads the same modules)
const toolDefs = new Map(Object.values(import.meta.glob('./tools/*.tool.js', { eager: true }))
  .map((m) => m.default).filter((d) => d?.key).map((d) => [d.key, d]));
// the inventory toolbelt (tools/inventory.js), where there is one: it selects tools by key
const inventoryMod = import.meta.glob('./tools/inventory.js', { eager: true })['./tools/inventory.js'];
export const hasTool = (key) => toolDefs.has(key);
export const hasPerk = (key) => !!PERK[key];

// Put tool `key` in the toolbelt's hand. true if it's held now.
export function holdTool(toolbelt, key) {
  if (!toolbelt || !key) return false;
  const inv = inventoryMod?.inventory;
  if (inv) {
    if (!inv.has(key)) inv.give(key);
    return !!toolbelt.select(key);
  }
  const def = toolDefs.get(key);
  if (!def?.slot) return false;
  toolbelt.select(def.slot - 1);
  return toolbelt.selectedKey === key;
}

// Apply class `key` to `body` and, with a toolbelt, put its tool in hand.
// classes.js applyClass's result plus held (the tool key in hand, or null).
export function applyClassTo(body, key, toolbelt = null) {
  const r = applyClass(body, key);
  if (!r) return null;
  const tool = heldTool(r.cls, hasTool);
  r.held = toolbelt && tool && holdTool(toolbelt, tool) ? tool : null;
  povEvents.emit('class:change', { key: r.cls?.key ?? null, body });
  return r;
}

const loadChosen = () => { try { const k = localStorage.getItem(STORE_KEY); return CLASS[k] ? k : null; } catch { return null; } };
const saveChosen = (k) => { try { localStorage.setItem(STORE_KEY, k); } catch { /* storage blocked: kept for this visit */ } };

function kitItem(kind, key, n = 1) {
  const known = kind === 'tool' ? hasTool(key) : hasPerk(key);
  const def = kind === 'tool' ? toolDefs.get(key) : PERK[key];
  const name = def?.name ?? keyName(key);
  let face;
  if (kind === 'tool' && def?.model && MODELS[def.model]) face = h('img', { src: modelIcon(def.model), alt: '', draggable: 'false' });
  else if (kind === 'perk' && def) face = h('i', { text: def.icon });
  else face = h('b', { text: key.replaceAll('_', '').slice(0, 4) });
  const el = h(`span.cp-item.cp-${kind}`, {
    title: known ? `${name}${def?.desc ? `: ${def.desc}` : ''}` : `${name}: coming soon`,
    style: kind === 'perk' && def ? `--pc:${def.color}` : '',
  }, face, n > 1 ? h('em', { text: `×${n}` }) : null);
  if (!known) el.classList.add('soon');
  return el;
}

export function createClassPicker(env) {
  let chosen = loadChosen();
  let open = false, focus = 0, relockOnClose = false, portraitsAsked = false, hinted = false;
  let spawnAt = -Infinity;

  // ---- the screen
  const word = h('div.cp-word', { 'aria-hidden': 'true' });
  const team = h('span.cp-team');
  const closeBtn = h('button.cp-close', { type: 'button', 'aria-label': 'Close' }, h('kbd', { text: 'Esc' }));
  const role = h('p.cp-role');
  const spawnLine = h('p.cp-spawn');
  const cards = CLASSES.map((cls, i) => {
    const stats = classStats(cls);
    const img = h('img.cp-portrait', { alt: '', draggable: 'false' });
    const card = h('button.cp-card', {
      type: 'button', role: 'option', 'data-key': cls.key, style: `--c:${cls.color}`,
      'aria-label': `${i + 1}: ${cls.name}. ${cls.tagline}`,
    },
    h('span.cp-num', { text: String(i + 1) }),
    h('span.cp-stage', {}, img),
    h('span.cp-name', { text: cls.name }),
    h('span.cp-tag', { text: cls.tagline }),
    h('span.cp-kit', {},
      cls.tools.map((t) => kitItem('tool', t)),
      Object.entries(cls.perks).map(([p, n]) => kitItem('perk', p, n))),
    h('span.cp-stats', {}, STATS.map(({ key, name }) => h('span.cp-stat', {},
      h('span', { text: name }),
      h('i', { style: `--v:${Math.max(1, Math.round(stats[key] * STAT_PIPS)) / STAT_PIPS}` })))));
    // focus follows the mouse once it moves (not when the cards slide in under a resting cursor)
    card.addEventListener('pointermove', () => { if (focus !== i) setFocus(i, false); });
    card.addEventListener('focus', () => setFocus(i, false));
    card.addEventListener('click', () => choose(cls.key, { close: true }));
    return { card, img, cls };
  });
  const row = h('div.cp-row', { role: 'listbox', 'aria-label': 'Classes' }, cards.map((c) => c.card));
  const root = h('div.cp', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose a class', hidden: '' },
    word,
    h('header.cp-head', {}, h('h2', { text: 'Choose a class' }), team, closeBtn),
    row, role,
    h('footer.cp-foot', {}, spawnLine,
      h('p.cp-keys', {},
        h('span', {}, h('kbd', { text: '1' }), '–', h('kbd', { text: String(CLASSES.length) }), ' pick'),
        h('span', {}, h('kbd', { text: '←' }), h('kbd', { text: '→' }), ' ', h('kbd', { text: 'Enter' }), ' choose'),
        h('span', {}, h('kbd', { text: ',' }), ' or ', h('kbd', { text: 'Esc' }), ' close'))));
  closeBtn.addEventListener('click', () => close());
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  document.body.append(root);

  function setFocus(i, move = true) {
    focus = (i + CLASSES.length) % CLASSES.length;
    const cls = CLASSES[focus];
    cards.forEach((c, j) => { c.card.classList.toggle('focus', j === focus); c.card.setAttribute('aria-selected', String(j === focus)); });
    if (move && document.activeElement !== cards[focus].card) cards[focus].card.focus({ preventScroll: true });
    root.style.setProperty('--c', cls.color);
    if (word.textContent !== cls.name) {
      word.textContent = cls.name;
      word.style.setProperty('--len', cls.name.length);
      word.classList.remove('swap');
      void word.offsetWidth;   // restart the swap
      word.classList.add('swap');
    }
    role.textContent = cls.role;
  }

  const inRoom = () => {
    const body = env.getBody();
    return env.isActive() && !!body && !body.dead && (performance.now() - spawnAt) / MS_PER_S < RESPAWN_ROOM_S;
  };

  function refresh() {
    const body = env.getBody();
    const t = body?.team ?? null;
    root.dataset.team = t ?? '';
    team.textContent = TEAM_NAMES[t] ?? '';
    team.hidden = !TEAM_NAMES[t];
    cards.forEach(({ card, cls }) => {
      card.classList.toggle('chosen', cls.key === chosen);
      card.classList.toggle('current', cls.key === body?.cls);
    });
    const name = chosen && CLASS[chosen].name;
    if (chosen) root.style.setProperty('--cc', CLASS[chosen].color); else root.style.removeProperty('--cc');
    spawnLine.replaceChildren(...(!chosen ? ['Pick a class. You become it when you next spawn.']
      : chosen === body?.cls ? ['You are playing ', h('b', { text: name }), '.']
        : inRoom() ? ['You just spawned: pick, and you change at once.']
          : ['You will spawn as ', h('b', { text: name }), '.']));
  }

  function askPortraits() {
    if (portraitsAsked) return;
    portraitsAsked = true;
    const byKey = new Map(cards.map((c) => [c.cls.key, c]));
    const entries = CLASSES.map((cls) => {
      const tool = heldTool(cls, hasTool);
      return { key: cls.key, color: cls.color, pose: cls.pose, model: tool ? toolDefs.get(tool).model : null };
    });
    renderPortraits(entries, (key, url) => {
      const c = byKey.get(key);
      c.img.onload = () => c.card.classList.add('drawn');
      c.img.src = url;
    });
  }

  function show() {
    if (open || !env.isActive()) return;
    open = true;
    relockOnClose = env.isLocked();
    env.unlock();
    root.hidden = false;
    refresh();
    setFocus(chosen ? CLASSES.findIndex((c) => c.key === chosen) : 0);
    void root.offsetWidth;
    root.classList.add('open');
    askPortraits();
  }

  // relock: take the pointer back (only from a key press or click: the browser wants a gesture)
  function close({ relock = true } = {}) {
    if (!open) return;
    open = false;
    root.classList.remove('open');
    root.hidden = true;
    if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
    if (relock && relockOnClose && env.isActive()) env.lock();
  }

  // Pick class `key`: now in the respawn room, else at the next spawn.
  function choose(key, { close: andClose = false } = {}) {
    if (!CLASS[key]) return null;
    chosen = key;
    saveChosen(key);
    const body = env.getBody();
    let r = null;
    if (inRoom() && body.cls !== key) {
      r = applyClassTo(body, key, env.getToolbelt());
      const got = [r.held && (toolDefs.get(r.held)?.name ?? keyName(r.held)), ...Object.keys(r.granted).map((k) => `${PERK[k].icon} ${PERK[k].name}`)].filter(Boolean);
      env.toast?.(`${r.cls.name}${got.length ? `: ${got.join(', ')}` : ''}`);
    } else if (body?.cls !== key) env.toast?.(`You will spawn as ${CLASS[key].name}`);
    refresh();
    if (andClose) close();
    return r;
  }

  // the shell, on every spawn of the player's body
  function spawned(body) {
    spawnAt = performance.now();
    if (chosen) return applyClassTo(body, chosen, env.getToolbelt());
    if (!hinted) { hinted = true; env.toast?.('Press , to choose a class'); }
    return null;
  }

  // keys: before the toolbelt's digits (it listens in the capture phase too, and is made later)
  const OWN = new Set(['Escape', 'Enter', ' ', ',', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab']);
  const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyC', 'KeyV', 'F1']);
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!open) {
      if (e.key === ',' && !e.repeat && env.isActive()) { e.preventDefault(); e.stopImmediatePropagation(); show(); }
      return;
    }
    const digit = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
    if (!OWN.has(e.key) && digit < 0 && !MOVE.has(e.code)) return;   // the rest (F, P, T, ?) work as ever
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat && !e.key.startsWith('Arrow')) return;
    if (digit >= 0 && digit < CLASSES.length) choose(CLASSES[digit].key, { close: true });
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setFocus(focus - 1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setFocus(focus + 1);
    else if (e.key === 'Tab') setFocus(focus + (e.shiftKey ? -1 : 1));
    else if (e.key === 'Enter' || e.key === ' ') choose(CLASSES[focus].key, { close: true });
    else if (e.key === 'Escape' || e.key === ',') close();
  }, { capture: true });

  return {
    get isOpen() { return open; },
    get chosen() { return chosen; },
    get inRoom() { return inRoom(); },
    get el() { return root; },
    open: show,
    close,
    toggle() { if (open) close(); else show(); },
    choose,
    spawned,
  };
}

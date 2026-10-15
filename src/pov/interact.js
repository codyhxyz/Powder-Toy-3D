import * as THREE from 'three';
import { h } from '../ui/dom.js';
import { createActionButtons } from '../ui/actionButtons.js';
import { HAND_REACH } from './constants.js';
import { CELL_M } from '../scale.js';

// Look at a thing and press E: Noita's pick-up rule (wands, potions, a Holy
// Mountain's perks and shop) and Garry's Mod's +use key. Whatever is under the
// crosshair within reach shows its name and what it does, so you know what you
// take before you take it. Shrine perks use proximity instead of aim;
// walking nearby reveals the choice, but still requires E to take it.
//
// Things are offered by providers: interact.provide(() => [{ id, position
// (grid cells, Vector3), radius (cells), title, lines: [string], verb, use() }])
// returns a function that removes the provider. use() returns false when it
// refuses (too poor, full hands): the prompt stays up.

const REACH = HAND_REACH * 1.5;   // cells from the eye: a bit past the hands (Noita picks up from a step away)
const SHRINE_REACH = 1.2 / CELL_M; // Noita's altar choice: stand at the plinth, not within mining reach.
const MIN_RADIUS = 0.75;          // cells: the smallest target the crosshair has to land on

export function createInteract({ getMode = () => 'sandbox' } = {}) {
  const providers = new Set();
  const title = h('b.pov-use-title');
  const lines = h('span.pov-use-lines');
  const actions = createActionButtons('Interaction');
  const prompt = h('div.pov-use', { role: 'status', 'aria-live': 'polite' }, title, lines, actions.root);
  document.body.append(prompt);
  const to = new THREE.Vector3();
  let focus = null, shownKey = '';

  function show(t) {
    const sourceMode = getMode() === 'crueltySquad';
    const imported = !!t?.id?.startsWith('imported:');
    // Cruelty Squad's weapon.gd dispatches use directly, without a door card.
    // This small button is our click/touch + E adaptation, not original HUD art.
    // Refresh scope before the cache check: a live mode change can keep the target.
    prompt.classList.toggle('source-use', sourceMode);
    prompt.classList.toggle('imported-use', imported);
    prompt.classList.toggle('compact-use', imported && ['Open', 'Close', 'Auto-closes'].includes(t.verb));
    const verb = sourceMode && imported && t.verb === 'Auto-closes' ? 'Use' : t?.verb ?? 'Take';
    const key = t ? `${sourceMode}|${t.id}|${t.title}|${t.lines?.join('|')}|${verb}` : '';
    if (key === shownKey) return;
    shownKey = key;
    prompt.classList.toggle('show', !!t);
    prompt.classList.toggle('key-only', !!t?.proximity);
    actions.update(t ? [{ id: 'use', label: verb, key: 'E', run: use }] : []);
    if (!t) return;
    actions.root.querySelector('button').setAttribute('aria-label', `${verb} ${t.title}`);
    title.textContent = t.title;
    lines.replaceChildren(...(t.lines ?? []).map((l) => h('span', { text: l })));
  }
  function use() {
    if (!focus) return false;
    focus.use();
    shownKey = null;   // force the next update, including when the used target disappeared
    return true;
  }

  return {
    provide(fn) { providers.add(fn); return () => providers.delete(fn); },
    // every frame: the thing nearest along the look ray from `eye` (grid cells) in `dir`,
    // not past `blocked` (the distance to the matter under the crosshair)
    update(eye, dir, blocked, on) {
      focus = null;
      if (on) {
        let best = Infinity;
        for (const fn of providers) for (const t of fn()) {
          to.subVectors(t.position, eye);
          // Noita's shrine choice: stand by the desired perk, no precise aiming.
          if (t.proximity) {
            const distance = to.length();
            if (distance <= SHRINE_REACH && distance < best) { best = distance; focus = t; }
            continue;
          }
          const along = to.dot(dir);
          if (along <= 0 || along > REACH || along > blocked + t.radius) continue;
          const off = to.addScaledVector(dir, -along).length();
          if (off > Math.max(MIN_RADIUS, t.radius) || along >= best) continue;
          best = along; focus = t;
        }
      }
      show(focus);
    },
    get focus() { return focus; },
    // E: use the thing in focus; false when there is none (E does its other jobs)
    use,
    dispose() { providers.clear(); actions.dispose(); prompt.remove(); },
  };
}

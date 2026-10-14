import { h } from '../ui/dom.js';
import './mission.css';

export function createMissionHud({ retry, leave }) {
  const name = h('b'), objective = h('div'), targets = h('div');
  const tracker = h('section.mission-tracker.panel', { 'aria-label': 'Mission objectives' }, name, objective, targets);
  const title = h('h2'), detail = h('p');
  const result = h('section.mission-result.panel', { 'aria-live': 'polite' }, title, detail,
    h('button', { text: 'Retry', on: { click: retry } }),
    h('button', { text: 'Leave mission', on: { click: leave } }));
  const root = h('div.mission-hud', { hidden: true }, tracker, result);
  document.body.append(root);
  let previous = '';
  return {
    update(state, visible) {
      root.hidden = !state || !visible;
      document.body.classList.toggle('mission-on', !!state && visible);
      if (!state) { previous = ''; return; }
      const signature = JSON.stringify(state);
      if (signature === previous) return;
      previous = signature;
      name.textContent = state.name;
      objective.textContent = state.ready ? 'Targets eliminated — reach EXIT' : `Eliminate targets: ${state.eliminated}/${state.total}`;
      targets.replaceChildren(...state.targets.map((t) => h('div', { text: `${t.eliminated ? '✓' : '○'} ${t.name}` })));
      result.hidden = state.phase === 'active';
      title.textContent = state.phase === 'complete' ? 'Mission complete' : 'Mission failed';
      detail.textContent = state.phase === 'complete' ? 'All targets eliminated. Extraction reached.' : 'You died.';
    },
  };
}

import { h } from './dom.js';

// Extend the existing drawer's segments and action buttons, not a new panel.
export function weatherSection(weather, { enabled = () => true } = {}) {
  const syncers = [];
  const group = (label, options, selected, select, cols = null) => {
    const buttons = options.map(([value, text]) => h('button', {
      type: 'button', role: 'radio', text,
      on: { click: () => select(value) },
    }));
    const choices = h(cols ? 'div.seg.rows' : 'div.seg', {
      role: 'radiogroup', 'aria-label': label,
      style: cols ? { '--cols': cols } : null,
      on: { keydown: (event) => {
        const at = buttons.indexOf(document.activeElement);
        if (at < 0) return;
        let next;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % buttons.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (at + buttons.length - 1) % buttons.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else return;
        event.preventDefault();
        buttons[next].focus();
        if (enabled()) select(options[next][0]);
      } },
    }, buttons);
    syncers.push(() => buttons.forEach((button, i) => {
      const on = options[i][0] === selected();
      button.disabled = !enabled();
      button.classList.toggle('on', on);
      button.setAttribute('aria-checked', String(on));
      button.tabIndex = on ? 0 : -1;
    }));
    return h('div', {}, h('div.switch-row', {}, h('span', { text: label })), choices);
  };
  const preset = group('Sky and rain', [['clear', 'Clear'], ['overcast', 'Overcast'], ['rain', 'Rain'], ['storm', 'Thunderstorm']],
    () => weather.selection.preset, (value) => weather.setPreset(value), 2);
  const fog = group('Sea fog', [['off', 'Off'], ['light', 'Light'], ['thick', 'Thick']],
    () => weather.selection.fog, (value) => weather.setFog(value));
  const ocean = group('Ocean', [['calm', 'Calm'], ['choppy', 'Choppy'], ['rough', 'Rough']],
    () => weather.selection.ocean, (value) => weather.setOcean(value));
  const status = h('p', { role: 'status', 'aria-live': 'polite' });
  const trigger = h('button.btn.danger', {
    type: 'button', text: 'Trigger tsunami',
    title: 'Launch one wave. Cancel does not undo flooding or damage.',
    // Controller stores failures in the live status text.
    on: { click: () => { void weather.triggerTsunami().catch(() => {}); } },
  });
  const cancel = h('button.btn', { type: 'button', text: 'Cancel tsunami', on: { click: () => weather.cancelTsunami() } });
  const eventButtons = h('div.btn-row', {}, trigger, cancel);
  const reset = h('button.btn', { type: 'button', text: 'Stop weather sources', on: { click: () => weather.reset() } });
  const el = h('div', { on: { keydown: (event) => {
    // Space activates focused buttons instead of toggling simulation pause.
    if (event.target.tagName === 'BUTTON' && event.key !== 'Escape') event.stopPropagation();
  } } },
    h('p', { text: 'Real elements, manual sources. Clear stops emission; sky clouds and water keep reacting. Sea fog Off clears low clouds immediately, even when paused. Sources pause with the simulation. Weather is not synchronized in multiplayer.' }),
    preset, fog, ocean, eventButtons, status,
    h('div.btn-row', {}, reset),
  );
  const sync = () => {
    syncers.forEach((fn) => fn());
    const event = weather.tsunami;
    const busy = event.active || event.pending;
    trigger.disabled = reset.disabled = !enabled();
    fog.hidden = ocean.hidden = !event.eligible;
    // Do not offer an inert event button until the actual wave implementation is attached.
    eventButtons.style.display = event.eligible && event.available ? '' : 'none';
    trigger.hidden = busy;
    cancel.hidden = !busy;
    // .btn's display overrides the browser's [hidden] rule, so hide explicitly.
    trigger.style.display = busy ? 'none' : '';
    cancel.style.display = busy ? '' : 'none';
    status.textContent = !enabled() ? 'Weather sources are the host\'s, once the map has loaded.'
      : !event.eligible ? 'Sea effects are available on ocean maps.'
      : !event.available ? 'Tsunami unavailable in this build.'
      : event.pending ? 'Checking the active coastline…'
      : event.error ? event.error
      : event.active ? 'Water surge active. Cancel stops forcing, not flooding already caused.'
      : 'Local ocean surge ready. One at a time; no ground tremor.';
  };
  const unsubscribe = weather.subscribe(sync);
  sync();
  return { title: 'Weather', rows: [{ type: 'custom', el, sync }], dispose: unsubscribe };
}

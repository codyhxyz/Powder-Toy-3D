// Driving information stays at the edges, as in Halo: hull and speed are not
// player health. Only the short boarding lesson fades; exit stays findable.
const HELP_MS = 5000;
const controls = {
  boat: 'W/S drive · A/D steer',
  jeep: 'W/S drive · A/D steer · Space brake · Shift boost',
  hoverbike: 'W/S drive · A/D steer · Space hop · Shift boost',
};

export function createVehicleHud() {
  const el = document.createElement('div');
  el.className = 'veh-hud';
  el.innerHTML = `<div class="veh-prompt"><kbd>E</kbd> <span></span></div>
    <section class="veh-panel" aria-label="Vehicle">
      <b class="veh-name"></b><span class="veh-speed"></span>
      <div class="veh-meter veh-hull"><span>Hull</span><i role="meter" aria-label="Hull health" aria-valuemin="0" aria-valuemax="100"><s></s></i><span class="veh-health"></span></div>
      <div class="veh-meter veh-boost" hidden><span>Boost</span><i role="meter" aria-label="Boost" aria-valuemin="0" aria-valuemax="100"><s></s></i></div>
      <span class="veh-warning" role="status" hidden>Motor needs water</span>
      <span class="veh-exit"><kbd>E</kbd> Get out</span>
    </section>
    <div class="veh-help"><span class="veh-keys"></span><span class="veh-touch-help">Stick to drive & steer</span></div>`;
  document.body.append(el);
  const find = selector => el.querySelector(selector);
  const prompt = find('.veh-prompt'), promptText = find('.veh-prompt span');
  const panel = find('.veh-panel'), name = find('.veh-name'), speed = find('.veh-speed');
  const hull = find('.veh-hull i'), hullFill = find('.veh-hull s'), health = find('.veh-health');
  const boost = find('.veh-boost'), boostMeter = find('.veh-boost i'), boostFill = find('.veh-boost s');
  const warning = find('.veh-warning'), help = find('.veh-help'), keys = find('.veh-keys');
  let helpTimer = null;
  const stopHelp = () => { clearTimeout(helpTimer); helpTimer = null; help.classList.remove('on'); };
  const hud = {
    board(kind) {
      stopHelp();
      document.body.classList.add('pov-driving');
      keys.textContent = controls[kind];
      help.classList.add('on');
      helpTimer = setTimeout(stopHelp, HELP_MS);
    },
    leave() {
      stopHelp();
      document.body.classList.remove('pov-driving');
      hud.show(null);
    },
    show(s) {
      el.classList.toggle('on', !!(s?.prompt || s?.seated));
      prompt.classList.toggle('on', !!s?.prompt);
      panel.classList.toggle('on', !!s?.seated);
      if (s?.prompt) promptText.textContent = s.prompt;
      if (!s?.seated) return;
      const hp = Math.round(Math.min(1, Math.max(0, s.health)) * 100);
      const kmh = `${Math.round(s.kmh)} km/h`;
      if (name.textContent !== s.seated) name.textContent = s.seated;
      if (speed.textContent !== kmh) speed.textContent = kmh;
      if (health.textContent !== `${hp}%`) {
        health.textContent = `${hp}%`;
        hull.setAttribute('aria-valuenow', hp);
        hullFill.style.transform = `scaleX(${hp / 100})`;
        hullFill.classList.toggle('low', hp < 30);
      }
      boost.hidden = s.boost === undefined;
      if (!boost.hidden) {
        const value = Math.round(Math.min(1, Math.max(0, s.boost)) * 100);
        boostMeter.setAttribute('aria-valuenow', value);
        boostFill.style.transform = `scaleX(${value / 100})`;
      }
      warning.hidden = !s.needsWater;
    },
    dispose() { hud.leave(); el.remove(); },
  };
  return hud;
}

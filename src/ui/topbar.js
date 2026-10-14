import { h } from './dom.js';
import { ICON } from './icons.js';
import { logoMark } from './logo.js';

export function createBrand() {
  const el = h('div.brand', { html: `${logoMark(34)}<div class="word">Powder Toy 3D<small>Falling-sand physics on the GPU</small></div>` });
  document.body.append(el);
  return el;
}

export function createToolbar({ actions, available = {} }) {
  let cameraId = 'god';
  const btn = (icon, title, fn) => h('button.icon-btn', { type: 'button', title, 'aria-label': title, html: ICON[icon], on: { click: fn } });
  const camera = h('select.camera-select', {
    'aria-label': 'Camera mode', title: 'Camera mode (V / F5)',
    on: { change: () => { actions.setCamera(camera.value); camera.value = cameraId; }, keydown: e => e.stopPropagation() },
  }, [['god', 'God'], ['first', '1st person'], ['third', '3rd person']].map(([value, text]) =>
    h('option', { value, text, disabled: available.camera === false && value !== 'god' })));
  const build = h('button.industry-build', { type: 'button', title: 'Build factory machines',
    'aria-controls': 'industry-builder', 'aria-expanded': 'false', 'aria-pressed': 'false',
    on: { click: () => actions.toggleIndustryBuild?.(),
      keydown: e => { if (e.code === 'Space' || e.code === 'Enter') e.stopPropagation(); } } }, 'Build');
  build.hidden = true;
  const undo = btn('undo', 'Undo (⌘Z)', actions.undo);
  const shader = btn('shader', 'Change shader', () => actions.openShaders?.());
  shader.setAttribute('aria-haspopup', 'dialog');
  shader.setAttribute('aria-controls', 'shader-picker');
  shader.setAttribute('aria-expanded', 'false');
  shader.addEventListener('keydown', e => { if (e.code === 'Space' || e.code === 'Enter') e.stopPropagation(); });
  const gear = btn('gear', 'Settings (,)', actions.toggleSettings);
  const bar = h('div.toolbar.panel', { role: 'group', 'aria-label': 'Simulation controls' },
    camera, build, undo, shader, gear);
  document.body.append(bar);

  let industryVisible = false, industryOpen = false;
  return {
    shaderButton: shader,
    setCamera(id) { camera.value = cameraId = id; },
    setIndustry(visible, open) {
      if (industryVisible === visible && industryOpen === open) return;
      industryVisible = visible; industryOpen = open;
      build.hidden = !visible;
      build.classList.toggle('on', open);
      build.setAttribute('aria-pressed', String(open));
      build.setAttribute('aria-expanded', String(open));
    },
    focusIndustry: () => { if (!build.hidden) build.focus({ preventScroll: true }); },
    setSettingsOpen: (v) => {
      gear.classList.toggle('on', v);
      gear.setAttribute('aria-expanded', String(v));
    },
    setUndoEnabled: (v) => { undo.disabled = !v; undo.style.opacity = v ? 1 : 0.4; },
  };
}

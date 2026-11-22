import { h } from './dom.js';
import { ICON } from './icons.js';
import { logoMark } from './logo.js';
import { KEYS, label } from '../keys.js';

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
  const build = h('button.industry-build', { type: 'button', title: 'Build factory machines (Q)',
    'aria-controls': 'industry-builder', 'aria-expanded': 'false', 'aria-pressed': 'false',
    on: { click: () => actions.toggleIndustryBuild?.(),
      keydown: e => { if (e.code === 'Space' || e.code === 'Enter') e.stopPropagation(); } } }, 'Build');
  build.hidden = true;
  const undo = btn('undo', 'Undo (⌘Z)', actions.undo);
  const saveCheckpoint = btn('checkpoint', `Save checkpoint (${label(KEYS.checkpointSave)})`, actions.saveCheckpoint);
  const resetCheckpoint = btn('reset', `Reset to checkpoint (${label(KEYS.checkpointReset)})`, actions.resetCheckpoint);
  saveCheckpoint.disabled = available.saves === false;
  resetCheckpoint.disabled = true;
  const slice = btn('slice', `Cycle cutaway (${label(KEYS.slice)})`, actions.slice);
  slice.setAttribute('aria-pressed', 'false');
  const flip = btn('replace', `Flip hidden side (${label(KEYS.sliceFlip)})`, actions.sliceFlip);
  const depth = h('input', { type: 'range', min: '1', step: '1', 'aria-label': 'Slice depth',
    on: { input: e => actions.sliceDepth(e.currentTarget.valueAsNumber) } });
  const caption = h('span.slice-caption');
  const sliceControls = h('div.slice-controls', { hidden: true }, caption, depth, flip);
  for (const el of [slice, flip, depth, saveCheckpoint, resetCheckpoint]) {
    el.addEventListener('keydown', e => { if (['Space', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.stopPropagation(); });
  }
  const shader = btn('shader', 'Change shader', () => actions.openShaders?.());
  shader.setAttribute('aria-haspopup', 'dialog');
  shader.setAttribute('aria-controls', 'shader-picker');
  shader.setAttribute('aria-expanded', 'false');
  shader.addEventListener('keydown', e => { if (e.code === 'Space' || e.code === 'Enter') e.stopPropagation(); });
  const gear = btn('gear', 'Settings (,)', actions.toggleSettings);
  // the controls sheet, basics first (ui/hud.js createHelp)
  const help = btn('help', 'Controls (?)', actions.toggleHelp);
  help.classList.add('help-btn');
  help.setAttribute('aria-haspopup', 'dialog');
  const bar = h('div.toolbar.panel', { role: 'group', 'aria-label': 'Simulation controls' },
    camera, build, undo, saveCheckpoint, resetCheckpoint, slice, shader, gear, help, sliceControls);
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
    setCheckpoint({ ready, busy }) {
      saveCheckpoint.disabled = available.saves === false || !!busy;
      resetCheckpoint.disabled = !ready || !!busy;
      saveCheckpoint.classList.toggle('on', ready);
    },
    setSlice({ enabled, axis, coord, sign }, size = 1) {
      sliceControls.hidden = !enabled;
      slice.classList.toggle('on', enabled);
      slice.setAttribute('aria-pressed', String(enabled));
      if (!enabled) return;
      depth.max = String(size - 1);
      depth.value = String(coord);
      caption.textContent = `Slice: ${'XYZ'[axis]} = ${coord}`;
      flip.setAttribute('aria-label', `Flip hidden side (currently ${sign > 0 ? 'positive' : 'negative'} ${'XYZ'[axis]})`);
    },
    setUndoEnabled: (v) => { undo.disabled = !v; undo.style.opacity = v ? 1 : 0.4; },
  };
}

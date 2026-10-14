import * as THREE from 'three';
import { DEVICE_TYPES, FILTER_IDS, CASTING_TEMPERATURE } from './catalog.js';
import { machineIcon } from './icons.js';
import { ELEMENTS } from '../elements.js';
import { deviceHeight } from './validation.js';
import './industry.css';

const box = (parent, size, at, color) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial({ color }));
  mesh.position.set(...at); parent.add(mesh); return mesh;
};
function model(type) {
  const root = new THREE.Group(), color = DEVICE_TYPES[type].color;
  if (type === 'foundation') {
    // Minecraft-style structural block: static edging inside the physical deck.
    for (const x of [-1.94, 1.94]) box(root,[.08,.96,4],[x,.5,0],color);
    for (const z of [-1.94, 1.94]) box(root,[4,.96,.08],[0,.5,z],color);
    return root;
  }
  // Sandustry's open handling decks: hardware hugs the sides, not the stream.
  for (const x of [-1.85, 1.85]) box(root, [.24,.38,3.9], [x,1.1,0], color);
  for (const z of [-1.5,0,1.5]) box(root, [3.4,.13,.18], [0,1.06,z], '#424958');
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(.36,.7,3), new THREE.MeshBasicMaterial({ color }));
  arrow.rotation.x = Math.PI / 2; arrow.position.set(1.7,1.5,1.2); root.add(arrow);
  if (type === 'miner') {
    // Tracked drilling agent, not a person: two treads, motor and rotating bit.
    for (const x of [-1.45,1.45]) box(root,[.65,.75,2.9],[x,1.55,0],'#424958');
    box(root,[1.5,1,1.8],[0,2,0],color);
    const drill = new THREE.Mesh(new THREE.ConeGeometry(.7,1.5,6), new THREE.MeshBasicMaterial({color:'#c9ced6'}));
    drill.rotation.x = Math.PI / 2; drill.position.set(0,2,1.25); drill.name = 'drill'; root.add(drill);
    box(root,[.6,.25,.5],[0,2.7,-.5],'#edcf84');
  } else if (type === 'pump') {
    box(root,[.7,4.9,.7],[-1.5,3.2,0],color);
    box(root,[.5,.5,3],[-1.5,5.6,1.2],color);
    box(root,[3.2,.5,.5],[0,5.6,2.5],color);
    box(root,[3.2,.4,.4],[0,1.5,-2.5],'#424958');
  } else if (type === 'lift') {
    for (const x of [-1.6,1.6]) box(root,[.35,2.7,.35],[x,2.1,0],color);
    box(root,[2.8,.2,.6],[0,1.5,0],color);
  } else if (type === 'heater') {
    for (const x of [-1.7,1.7]) { box(root,[.55,1.4,3.6],[x,1.7,0],'#747b89'); box(root,[.15,.3,2.8],[x * .85,1.5,0],color); }
  } else if (type === 'ship') {
    for (const x of [-1.7,1.7]) box(root,[.4,2.3,.4],[x,2.05,1.5],color);
    box(root,[3.6,.45,.45],[0,3.15,1.5],color);
  } else if (type === 'separator') {
    box(root,[.3,1.6,.3],[-1.6,1.8,0],color); box(root,[1.1,.4,.5],[-1.1,2.6,0],color);
    box(root,[1.3,.15,.25],[1,1.3,0],color);
  }
  return root;
}

// Detailed physical guidance stays in titles, not repeated palette labels.
const MACHINE_HELP = {
  foundation: 'Stack blocks to catch loose grains and contain liquids.',
  belt: 'Connect decks edge to edge. Liquids and solid metal do not ride belts.',
  separator: 'Catch both streams: the selected material goes forward; everything else goes right.',
  ship: `Gold pays 1 credit per grain; metal pays 4 and must be ${CASTING_TEMPERATURE}°C or below.`,
  miner: 'Reaches four cells beyond the deck. Catch debris behind it; move when the face is empty.',
  lift: 'Build a catch above the lift. It launches grains, not liquids or solid blocks.',
  pump: 'Moves water or molten metal. Feed the low inlet and catch the high outlet.',
  heater: 'Cool the melt in a separate catch. Keep finished metal away from the hot bed.',
};
const UNLOCK_AT = { miner: 12, lift: 12, pump: 48, heater: 96 };
// Never rebuild the palette on simulation frames: keep focus and native controls.
const text = (node, value) => { value = String(value); if (node.textContent !== value) node.textContent = value; };
const attribute = (node, key, value) => { value = String(value); if (node.getAttribute(key) !== value) node.setAttribute(key, value); };

export function createIndustryView(app, actions) {
  const root = new THREE.Group(); root.name = 'Industry'; app.scene.add(root);
  const templates = Object.fromEntries(Object.keys(DEVICE_TYPES).map(type => [type, model(type)]));
  const ghost = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(4,4,4), new THREE.MeshBasicMaterial({color:'#dcbc74',wireframe:true}));
  frame.position.set(0,2,0); ghost.add(frame);
  const flow = new THREE.Mesh(new THREE.ConeGeometry(.6,1.2,3), new THREE.MeshBasicMaterial({color:'#dcbc74'}));
  flow.rotation.x = Math.PI / 2; flow.position.set(0,1.4,1); ghost.add(flow);
  const inlet = box(ghost,[2,.18,.25],[0,1.2,-2.15],'#7cbdd1');
  const outlet = box(ghost,[2,.18,.25],[0,1.2,2.15],'#dcbc74');
  const reject = new THREE.Mesh(new THREE.ConeGeometry(.4,.9,3), new THREE.MeshBasicMaterial({color:'#e4b45c'}));
  reject.rotation.z = -Math.PI / 2; reject.position.set(1.6,1.4,0); ghost.add(reject);
  const port = box(ghost,[.5,.5,.5],[-2.5,.5,-.5],'#7cbdd1');
  ghost.visible = false; root.add(ghost);
  let ready = false, disposed = false;
  Promise.all([...Object.values(templates),ghost].map(m => app.gpu.three.prepare(m))).then(() => { ready = true; app.requestRender(); }, err => app.hud.toast(`Industry graphics: ${err.message}`));
  const meshes = new Map();
  const node = (tag, className, parent, content) => {
    const el = document.createElement(tag); el.className = className;
    if (content !== undefined) el.textContent = content;
    parent?.append(el); return el;
  };
  const panel = node('section', 'industry panel'); panel.setAttribute('aria-label', 'Factory construction');
  panel.hidden = true;
  const button = (label, fn, parent, className = '') => {
    const b = node('button', className, parent, label); b.type = 'button'; b.onclick = fn; return b;
  };
  const hud = node('div', 'industry-hud', panel);
  const wallet = node('div', 'industry-wallet', hud);
  const balance = node('strong', 'industry-balance', wallet);
  const toggle = button('Build', actions.toggle, wallet, 'industry-toggle');
  toggle.setAttribute('data-action', 'toggle'); toggle.setAttribute('aria-controls', 'industry-builder');
  const goal = node('div', 'industry-goal', hud);
  const objective = node('p', 'industry-objective', goal);
  const tally = node('span', 'industry-tally', goal);
  const progress = node('progress', 'industry-progress', hud);

  const controls = node('div', 'industry-builder', panel); controls.id = 'industry-builder';
  const scroll = node('div', 'industry-scroll', controls);
  const types = node('div', 'industry-types', scroll);
  types.setAttribute('role', 'group'); types.setAttribute('aria-label', 'Choose a machine');
  const typeButtons = Object.fromEntries(Object.entries(DEVICE_TYPES).map(([key, d]) => {
    const b = button('', () => {
      if (actions.canBuild(key).ok) actions.select(key);
    }, types, 'industry-machine');
    b.setAttribute('data-machine', key); b.style.setProperty('--machine-color', d.color);
    b.append(machineIcon(key));
    node('span', 'industry-machine-name', b, d.name);
    const cost = node('span', 'industry-machine-cost', b);
    const availability = node('span', 'industry-machine-state', b);
    return [key, { b, cost, availability }];
  }));
  const selected = node('div', 'industry-selected', scroll);
  const tip = node('p', 'industry-tip', selected);
  const filterLabel = node('label', 'industry-filter', selected, 'Forward output');
  const filter = node('select', '', filterLabel); filter.setAttribute('aria-label', 'Separator output material');
  for (const id of FILTER_IDS) { const o = node('option', '', filter, ELEMENTS[id].name); o.value = id; }
  filter.onchange = () => actions.filter(Number(filter.value));

  const footer = node('div', 'industry-footer', controls);
  // Deliberately not a live region: cursor clearance checks change constantly.
  const status = node('p', 'industry-status', footer);
  status.setAttribute('aria-label', 'Construction feedback');
  const row = node('div', 'industry-actions', footer);
  const rotate = button('Rotate', actions.rotate, row); rotate.setAttribute('data-action', 'rotate');
  const remove = button('Dismantle', actions.remove, row); remove.setAttribute('data-action', 'remove');
  remove.title = 'Click a machine to dismantle it and refund its full price';
  const close = button('Done', actions.cancel, row, 'industry-done'); close.setAttribute('data-action', 'cancel');
  panel.addEventListener('pointerdown', e => e.stopPropagation());
  panel.addEventListener('keydown', e => {
    // Keep native activation/selection keys out of the global game shortcuts.
    // Do not preventDefault: Space still clicks a button and selects remain native.
    if (e.target.tagName === 'SELECT'
      || ['Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.code)) e.stopPropagation();
  });
  document.body.append(panel);
  let wasBuilding = false;
  return {
    update(state, candidate, result, time) {
      if (disposed) return;
      panel.hidden = !state.active || !state.factory; root.visible = state.active && ready;
      const dismantling = !!state.dismantling;
      attribute(panel, 'data-building', state.building);
      attribute(toggle, 'aria-expanded', state.building);
      attribute(toggle, 'aria-pressed', state.building);
      const restoreFocus = wasBuilding && !state.building && controls.contains(document.activeElement);
      controls.hidden = !state.building;
      // Escape / Done closure should not strand keyboard focus in hidden UI.
      if (restoreFocus && !panel.hidden) toggle.focus({ preventScroll: true });
      wasBuilding = state.building;
      const p = state.progression;
      text(balance, p ? `${p.credits} credits` : 'Loading quarry…');
      balance.title = state.assisted && p ? 'Sandbox-assisted run' : '';
      goal.hidden = progress.hidden = !p;
      text(objective, p?.goal.split(':')[0].split(' — ')[0] ?? '');
      objective.title = p?.hint ?? '';
      if (p) {
        const max = [12, 48, 96, 32, 32][p.stage];
        const value = Math.min(p.stage < 3 ? p.earned : p.delivered.metal, max);
        if (progress.max !== max) progress.max = max;
        if (progress.value !== value) progress.value = value;
        attribute(progress, 'aria-label', p.stage < 3 ? 'Lifetime credits toward next unlock' : 'Cooled metal delivered');
        attribute(progress, 'aria-valuetext', `${value} of ${max}${p.stage < 3 ? ' lifetime credits' : ' metal grains'}`);
        text(tally, `${value} / ${max}`);
      }
      for (const [key, { b, cost, availability }] of Object.entries(typeButtons)) {
        const d = DEVICE_TYPES[key], can = actions.canBuild(key);
        const locked = p && !p.unlocked.includes(key);
        const shortfall = p ? Math.max(0, d.cost - p.credits) : 0;
        const reason = locked ? `Unlock: ${UNLOCK_AT[key]} lifetime credits` : !can.ok ? shortfall ? `Need ${shortfall} more credits` : can.reason : '';
        text(cost, `${d.cost} cr`);
        text(availability, reason);
        availability.hidden = !reason;
        attribute(b, 'data-availability', locked ? 'locked' : !can.ok ? 'unavailable' : 'ready');
        // Keep locked equipment keyboard-discoverable, with an explicit reason.
        attribute(b, 'aria-disabled', !can.ok);
        attribute(b, 'aria-pressed', key === state.selected && !dismantling);
        attribute(b, 'aria-label', `${d.name}. ${d.cost} credits.${reason ? ` ${reason}.` : ''}`);
        b.title = `${d.description} ${MACHINE_HELP[key]}${reason ? ` ${reason}.` : ''}`;
      }
      selected.hidden = dismantling;
      text(tip, DEVICE_TYPES[state.selected].description);
      tip.title = MACHINE_HELP[state.selected];
      filterLabel.hidden = state.selected !== 'separator';
      if (String(filter.value) !== String(state.filter)) filter.value = state.filter;
      text(rotate, `Rotate · ${state.rotation * 90}°`);
      rotate.disabled = dismantling;
      attribute(remove, 'aria-pressed', dismantling);
      const checking = !dismantling && !!candidate && result?.reason === 'Checking clearance…';
      const valid = !!candidate && !!result?.ok && !state.pending;
      const placementState = state.pending || checking ? 'checking' : !candidate ? 'aim' : valid ? 'valid' : 'invalid';
      attribute(status, 'data-state', placementState);
      text(status, state.pending ? 'Finishing transfer…' : checking ? 'Checking clearance…'
        : result && !result.ok && result.reason ? result.reason
        : dismantling ? 'Click a piece to remove · full refund' : 'Click to place');
      for (const [id,m] of meshes) if (!state.devices.some(d => d.id === id)) { m.removeFromParent(); meshes.delete(id); }
      for (const d of state.devices) {
        let m = meshes.get(d.id);
        if (!m) { m = templates[d.type].clone(); root.add(m); meshes.set(d.id,m); }
        m.position.set(d.x+2,d.y,d.z+2); m.rotation.y = -d.rotation * Math.PI / 2;
        const drill = m.getObjectByName('drill'); if (drill) drill.rotation.y = time * 4;
      }
      root.scale.setScalar(app.scale); root.position.copy(app.volume.position);
      ghost.visible = state.factory && state.building && !!candidate;
      if (candidate) {
        const height = deviceHeight(candidate); frame.scale.y = height / 4; frame.position.y = height / 2;
        ghost.position.set(candidate.x+2,candidate.y,candidate.z+2); ghost.rotation.y = -candidate.rotation * Math.PI/2;
        inlet.position.z = candidate.type === 'pump' ? -2.5 : -2.15;
        outlet.position.set(0,candidate.type === 'pump' ? 5.6 : 1.2,candidate.type === 'pump' ? 2.5 : 2.15);
        const structural = candidate.type === 'foundation';
        flow.visible = inlet.visible = outlet.visible = !dismantling && !structural;
        reject.visible = !dismantling && candidate.type === 'separator';
        const color = dismantling ? '#e5536a' : placementState === 'checking' ? '#dcbc74' : valid ? '#b7d077' : '#e5536a';
        frame.material.color.set(color); flow.material.color.set(color);
        port.visible = !dismantling && candidate.powered && !structural;
      }
    },
    dispose() {
      disposed = true; root.removeFromParent(); panel.remove();
      for (const m of [...Object.values(templates),ghost]) m.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    },
  };
}

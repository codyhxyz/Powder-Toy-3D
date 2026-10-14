import * as THREE from 'three';
import { DEVICE_TYPES, FILTER_IDS, INDUSTRY_LIMIT, CASTING_TEMPERATURE } from './catalog.js';
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

// Copy describes actual physical streams; no item recipes or implied throughput.
const MACHINE_HELP = {
  foundation: { purpose: 'Walls & catch decks', input: 'Stackable tungsten', output: 'Platforms / chutes', tip: 'Stack blocks to catch loose grains and contain liquids.' },
  belt: { purpose: 'Move loose grains', input: 'Grains on deck', output: 'Forward →', tip: 'Connect decks edge to edge. Liquids and solid metal do not ride belts.' },
  separator: { purpose: 'Split a material', input: 'Mixed grains', output: 'Filter → / others right', tip: 'Catch both streams: the selected material goes forward; everything else goes right.' },
  ship: { purpose: 'Ship gold & metal', input: 'Gold / cooled metal', output: '1 / 4 credits per grain', tip: `Gold and metal must enter the mouth. Metal must be ${CASTING_TEMPERATURE}°C or below.` },
  miner: { purpose: 'Excavate the face', input: 'Breakable face ahead', output: 'Loose debris behind', tip: 'Reaches four cells beyond the deck. Catch debris behind it; move when the face is empty.' },
  lift: { purpose: 'Raise loose grains', input: 'Grains on deck', output: 'Upward ↑', tip: 'Build a catch above the lift. It launches grains, not liquids or solid blocks.' },
  pump: { purpose: 'Raise real liquid', input: 'Liquid at rear inlet', output: 'Elevated front outlet', tip: 'Moves water or molten metal. Feed the low inlet and catch the high outlet.' },
  heater: { purpose: 'Melt & pour scrap', input: 'Scrap on hot bed', output: 'Melt flows forward →', tip: 'Cool the melt in a separate catch. Keep finished metal away from the hot bed.' },
};
const UNLOCK_AT = { miner: 12, lift: 12, pump: 48, heater: 96 };
const NEXT_UNLOCK = ['Mining agent + lift', 'Pump', 'Furnace', 'Quarry complete', 'Freeplay'];
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
  const panel = node('section', 'industry panel'); panel.setAttribute('aria-label', 'Industry construction');
  const button = (label, fn, parent, className = '') => {
    const b = node('button', className, parent, label); b.type = 'button'; b.onclick = fn; return b;
  };
  const hud = node('div', 'industry-hud', panel);
  const top = node('div', 'industry-row', hud);
  const mode = node('span', 'industry-eyebrow', top);
  const toggle = button('Build', actions.toggle, top, 'industry-toggle');
  toggle.setAttribute('data-action', 'toggle'); toggle.setAttribute('aria-controls', 'industry-builder');
  const wallet = node('div', 'industry-wallet', hud);
  const balance = node('strong', 'industry-balance', wallet);
  const currency = node('span', 'industry-currency', wallet);
  const count = node('span', 'industry-count', wallet);
  const objective = node('p', 'industry-objective', hud);
  const progress = node('progress', 'industry-progress', hud);
  const milestone = node('div', 'industry-milestone', hud);
  const reward = node('span', '', milestone);
  const tally = node('span', '', milestone);
  const assisted = node('span', 'industry-assisted', hud, 'Sandbox-assisted run');
  const closedHelp = node('p', 'industry-closed-help', hud);

  const controls = node('div', 'industry-builder', panel); controls.id = 'industry-builder';
  const scroll = node('div', 'industry-scroll', controls);
  const selected = node('section', 'industry-selected', scroll);
  const catalogHeading = node('div', 'industry-row industry-catalog-heading', scroll);
  node('h2', 'industry-eyebrow', catalogHeading, 'Construction');
  const catalogNote = node('span', 'industry-caption', catalogHeading);
  const types = node('div', 'industry-types', scroll);
  types.setAttribute('role', 'group'); types.setAttribute('aria-label', 'Choose a machine');
  const typeButtons = Object.fromEntries(Object.entries(DEVICE_TYPES).map(([key, d]) => {
    const b = button('', event => {
      if (actions.canBuild(key).ok) {
        actions.select(key);
        if (event?.detail !== 0) scroll.scrollTop = 0;
      }
    }, types, 'industry-machine');
    b.setAttribute('data-machine', key); b.style.setProperty('--machine-color', d.color);
    b.append(machineIcon(key));
    node('span', 'industry-machine-name', b, d.name);
    const cost = node('span', 'industry-machine-cost', b);
    node('span', 'industry-machine-purpose', b, MACHINE_HELP[key].purpose);
    const availability = node('span', 'industry-machine-state', b);
    return [key, { b, cost, availability }];
  }));
  selected.setAttribute('aria-label', 'Selected machine instructions');
  const selectedTop = node('div', 'industry-row', selected);
  const selectedName = node('h3', '', selectedTop);
  button('Choose machine', () => {
    const target = Object.values(typeButtons).find(({ b }) => b.getAttribute('aria-pressed') === 'true')?.b;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, selectedTop, 'industry-choose');
  const facing = node('span', 'industry-facing', selectedTop);
  const flowInfo = node('div', 'industry-flow', selected);
  const input = node('div', '', flowInfo); node('span', 'industry-eyebrow', input, 'Input');
  const inputText = node('strong', '', input);
  const output = node('div', '', flowInfo); node('span', 'industry-eyebrow', output, 'Output');
  const outputText = node('strong', '', output);
  const tip = node('p', 'industry-tip', selected);
  const options = node('div', 'industry-options', selected);
  const filterLabel = node('label', 'industry-filter', options, 'Forward output');
  const filter = node('select', '', filterLabel); filter.setAttribute('aria-label', 'Separator output material');
  for (const id of FILTER_IDS) { const o = node('option', '', filter, ELEMENTS[id].name); o.value = id; }
  filter.onchange = () => actions.filter(Number(filter.value));
  const powerLabel = node('label', 'industry-power', options);
  const power = node('input', '', powerLabel); power.type = 'checkbox'; power.onchange = () => actions.power(power.checked);
  powerLabel.append(document.createTextNode(' Spark drive'));
  powerLabel.title = 'Spark a conductor beside the blue port: local cell (-1, 0, 1). Unchecked uses the built-in drive.';
  const powerHelp = node('p', 'industry-power-help', options);
  const guide = node('details', 'industry-guide', scroll); guide.open = true;
  node('summary', '', guide, 'Production guide');
  const nextStep = node('p', 'industry-help', guide);
  const refundHelp = node('p', 'industry-help', guide);

  const footer = node('div', 'industry-footer', controls);
  const placement = node('div', 'industry-placement', footer);
  // Deliberately not a live region: cursor clearance checks change constantly.
  placement.setAttribute('aria-label', 'Placement feedback');
  const statusTitle = node('strong', 'industry-status-title', placement);
  const status = node('p', 'industry-status', placement);
  const row = node('div', 'industry-actions', footer);
  const place = button('Place', actions.place, row, 'industry-place'); place.setAttribute('data-action', 'place');
  button('Rotate · R', actions.rotate, row);
  const remove = button('Dismantle', actions.remove, row); remove.title = 'Aim at a machine · Right-click also dismantles';
  const help = node('div', 'industry-shortcuts', footer);
  node('span', '', help, 'Click place · Right-click dismantle');
  const close = button('Esc close', actions.cancel, help); close.setAttribute('aria-label', 'Close construction · Escape');
  const cameraHelp = node('span', 'industry-camera-help', help, 'V walk / orbit');
  panel.addEventListener('pointerdown', e => e.stopPropagation());
  panel.addEventListener('keydown', e => {
    // Keep native activation/selection keys out of the global game shortcuts.
    // Do not preventDefault: Space still clicks a button or checks Spark drive.
    if (e.target.tagName === 'SELECT'
      || ['Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.code)) e.stopPropagation();
  });
  document.body.append(panel);
  let wasBuilding = false;
  return {
    update(state, candidate, result, time) {
      if (disposed) return;
      panel.hidden = !state.active; root.visible = state.active && ready;
      attribute(panel, 'data-building', state.building);
      attribute(toggle, 'aria-expanded', state.building);
      const restoreFocus = wasBuilding && !state.building && controls.contains(document.activeElement);
      controls.hidden = !state.building;
      const shortcut = state.factory || state.building ? 'B' : 'Shift+B';
      text(toggle, `${state.building ? 'Close' : 'Build'} · ${shortcut}`);
      toggle.title = `${shortcut}: ${state.building ? 'close' : 'open'} construction${state.factory ? '' : ' · B changes brush shape outside construction'}`;
      // Escape / shortcut closure should not strand keyboard focus in hidden UI.
      if (restoreFocus && state.active) toggle.focus({ preventScroll: true });
      wasBuilding = state.building;
      text(mode, state.factory ? 'Factory / Open-cut quarry' : 'Sandbox / Industry');
      closedHelp.hidden = state.building;
      text(closedHelp, state.factory ? 'B build · V walk / orbit' : 'Shift+B build · B brush · V walk / orbit');
      text(count, `${state.devices.length} / ${INDUSTRY_LIMIT} built`);
      const p = state.progression;
      text(balance, p ? p.credits : state.factory ? '—' : 'Free');
      text(currency, p ? 'credits available' : state.factory ? 'loading quarry' : 'construction');
      objective.hidden = progress.hidden = milestone.hidden = !p;
      assisted.hidden = !state.assisted || !p;
      text(objective, p?.goal ?? '');
      if (p) {
        const max = [12, 48, 96, 32, 32][p.stage];
        const value = Math.min(p.stage < 3 ? p.earned : p.delivered.metal, max);
        if (progress.max !== max) progress.max = max;
        if (progress.value !== value) progress.value = value;
        attribute(progress, 'aria-label', p.stage < 3 ? 'Lifetime credits toward next unlock' : 'Cooled metal delivered');
        attribute(progress, 'aria-valuetext', `${value} of ${max}${p.stage < 3 ? ' lifetime credits' : ' metal grains'}`);
        text(reward, p.complete ? 'All equipment unlocked' : `Next: ${NEXT_UNLOCK[p.stage]}`);
        text(tally, p.stage < 3 ? `${max - value} to unlock` : `${value} / ${max} metal`);
      }
      text(catalogNote, state.factory ? 'Paid from available credits' : 'All equipment free');
      for (const [key, { b, cost, availability }] of Object.entries(typeButtons)) {
        const d = DEVICE_TYPES[key], can = actions.canBuild(key);
        const locked = p && !p.unlocked.includes(key);
        const shortfall = p ? Math.max(0, d.cost - p.credits) : 0;
        const reason = locked ? `Unlock: ${UNLOCK_AT[key]} lifetime cr` : !can.ok ? shortfall ? `Need ${shortfall} more credits` : can.reason : key === state.selected ? 'Selected' : 'Ready to build';
        text(cost, state.factory ? `${d.cost} cr` : 'Free');
        text(availability, reason);
        attribute(b, 'data-availability', locked ? 'locked' : !can.ok ? 'unavailable' : 'ready');
        // Keep locked equipment keyboard-discoverable, with an explicit reason.
        attribute(b, 'aria-disabled', !can.ok);
        attribute(b, 'aria-pressed', key === state.selected);
        attribute(b, 'aria-label', `${d.name}. ${d.description} ${state.factory ? `${d.cost} credits.` : 'Free.'} ${reason}.`);
        b.title = `${d.description} ${reason}`;
      }
      const selectedHelp = MACHINE_HELP[state.selected];
      text(selectedName, DEVICE_TYPES[state.selected].name);
      text(facing, `${state.rotation * 90}° · 4 × 4`);
      text(inputText, selectedHelp.input);
      text(outputText, state.selected === 'separator' ? `${ELEMENTS[state.filter].name} → / others right`
        : state.selected === 'ship' && !state.factory ? 'Removed · no credits' : selectedHelp.output);
      text(tip, selectedHelp.tip);
      filterLabel.hidden = state.selected !== 'separator';
      if (String(filter.value) !== String(state.filter)) filter.value = state.filter;
      power.checked = state.powered;
      powerLabel.hidden = state.factory || state.selected === 'foundation'; power.disabled = state.factory;
      powerHelp.hidden = powerLabel.hidden;
      text(powerHelp, state.powered ? 'Blue port: battery, enabled switch or live spark. Local cell (−1, 0, 1), rotated with the machine.' : 'Built-in drive. Enable to control this machine at its blue port.');
      text(nextStep, p ? `Next: ${p.hint}` : 'Free machines, real matter. Blue marks the inlet; ochre marks the outlet. Arrows rotate with the machine.');
      text(refundHelp, p ? 'Dismantling purchased machines refunds the full price. Gold pays 1 credit; cooled metal pays 4.' : 'B changes brush shape outside construction. Terrain undo does not undo individual machine placements.');
      const checking = !!candidate && result?.reason === 'Checking clearance…';
      const valid = !!candidate && !!result?.ok && !state.pending;
      const placementState = state.pending || checking ? 'checking' : !candidate ? 'aim' : valid ? 'valid' : 'invalid';
      attribute(placement, 'data-state', placementState);
      text(statusTitle, state.pending ? 'Finishing transfer' : checking ? 'Checking clearance' : !candidate ? 'Aim at a surface' : valid ? 'Ready to place' : 'Cannot place here');
      text(status, state.pending ? 'Wait for the current machine transfer to finish.' : !candidate ? 'Point into the world. Keep the deck and outlets clear.' : result?.reason || 'Checking clearance…');
      place.disabled = !valid;
      text(place, state.factory ? `Place · ${DEVICE_TYPES[state.selected].cost} cr` : 'Place · Free');
      text(cameraHelp, app.pov?.active ? 'V orbit · Esc close / release pointer' : 'V walk / orbit');
      for (const [id,m] of meshes) if (!state.devices.some(d => d.id === id)) { m.removeFromParent(); meshes.delete(id); }
      for (const d of state.devices) {
        let m = meshes.get(d.id);
        if (!m) { m = templates[d.type].clone(); root.add(m); meshes.set(d.id,m); }
        m.position.set(d.x+2,d.y,d.z+2); m.rotation.y = -d.rotation * Math.PI / 2;
        const drill = m.getObjectByName('drill'); if (drill) drill.rotation.y = time * 4;
      }
      root.scale.setScalar(app.scale); root.position.copy(app.volume.position);
      ghost.visible = state.building && !!candidate;
      if (candidate) {
        const height = deviceHeight(candidate); frame.scale.y = height / 4; frame.position.y = height / 2;
        ghost.position.set(candidate.x+2,candidate.y,candidate.z+2); ghost.rotation.y = -candidate.rotation * Math.PI/2;
        inlet.position.z = candidate.type === 'pump' ? -2.5 : -2.15;
        outlet.position.set(0,candidate.type === 'pump' ? 5.6 : 1.2,candidate.type === 'pump' ? 2.5 : 2.15);
        const structural = candidate.type === 'foundation';
        flow.visible = inlet.visible = outlet.visible = !structural;
        reject.visible = candidate.type === 'separator';
        const color = placementState === 'checking' ? '#dcbc74' : valid ? '#b7d077' : '#e5536a'; frame.material.color.set(color); flow.material.color.set(color); port.visible = candidate.powered && !structural;
      }
    },
    dispose() {
      disposed = true; root.removeFromParent(); panel.remove();
      for (const m of [...Object.values(templates),ghost]) m.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    },
  };
}
